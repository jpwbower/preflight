#!/usr/bin/env node
// preflight CLI entry. Plain JS so it runs without a TypeScript loader.
// All non-trivial logic lives in dist/cli/*.js (compiled from src/cli/*.ts).

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require_ = createRequire(import.meta.url);

const EXIT = {
  OK: 0,
  TEST_FAILURE: 1,
  CONFIG_ERROR: 2,
  ENV_ERROR: 3,
  RUNTIME_ERROR: 4,
};

function readSelfVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function dynamicImportPreferringConsumer(specifier, consumerCwd) {
  // Try the consumer's copy first (lets them pin tsx if they want), then
  // fall back to preflight's bundled copy. Nested `node_modules/preflight/
  // node_modules/tsx` won't be found by walking up from the consumer dir,
  // so the fallback is what real installs actually use.
  try {
    const consumerRequire = createRequire(path.join(consumerCwd, 'package.json'));
    const resolved = consumerRequire.resolve(specifier);
    return await import(pathToFileURL(resolved).href);
  } catch {
    const selfRequire = createRequire(path.join(__dirname, '..', 'package.json'));
    const resolved = selfRequire.resolve(specifier);
    return await import(pathToFileURL(resolved).href);
  }
}

/**
 * Locate preflight.config.{ts,mts,js,mjs} in the consumer directory or any
 * ancestor. Mirrors how Playwright / Vitest discover their config files.
 */
function discoverConfigPath(consumerCwd) {
  const candidates = [
    'preflight.config.ts',
    'preflight.config.mts',
    'preflight.config.js',
    'preflight.config.mjs',
  ];
  let dir = consumerCwd;
  while (true) {
    for (const name of candidates) {
      const p = path.join(dir, name);
      if (existsSync(p)) return p;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function loadConsumerConfig(configPath, consumerCwd) {
  const ext = path.extname(configPath).toLowerCase();
  if (ext === '.ts' || ext === '.mts') {
    // Use the consumer's installed `tsx` (preflight declares it as a regular
    // dep so it is always available).
    try {
      const tsx = await dynamicImportPreferringConsumer('tsx/esm/api', consumerCwd);
      // tsImport accepts a specifier + parent URL. On Windows an absolute
      // path like `D:\...` is mis-parsed as a URL with scheme `d:`, so we
      // convert to a file:// URL first.
      const configUrl = pathToFileURL(configPath).href;
      const loaded = await tsx.tsImport(configUrl, import.meta.url);
      return loaded.default ?? loaded;
    } catch (err) {
      throw new ConfigError(
        `failed to load TypeScript config ${configPath}: ${err && err.message ? err.message : err}\n` +
          'Make sure tsx is installed (preflight pulls it in automatically — try `npm i`).'
      );
    }
  }
  // Plain JS / ESM
  const mod = await import(pathToFileURL(configPath).href);
  return mod.default ?? mod;
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function printHelpAndExit() {
  // Lazy-load to avoid forcing dist/ presence for `--help`.
  try {
    const { helpText } = require_('../dist/cli/parseArgs.js');
    process.stdout.write(helpText());
  } catch {
    process.stdout.write(
      'preflight CLI — dist/ not built. Run `npm install` in this package, then `npm run prepare`.\n'
    );
  }
  process.exit(EXIT.OK);
}

async function cmdInit(parsed, consumerCwd) {
  const tplSrc = path.join(__dirname, '..', 'templates', 'preflight.config.ts.tpl');
  const dest = path.join(consumerCwd, 'preflight.config.ts');
  if (existsSync(dest) && !parsed.force) {
    process.stderr.write(
      `preflight init: ${dest} already exists. Re-run with --force to overwrite.\n`
    );
    return EXIT.CONFIG_ERROR;
  }
  if (!existsSync(tplSrc)) {
    process.stderr.write(
      `preflight init: template missing at ${tplSrc}. Reinstall preflight.\n`
    );
    return EXIT.RUNTIME_ERROR;
  }
  await copyFile(tplSrc, dest);
  process.stdout.write(`preflight init: wrote ${dest}\n`);
  process.stdout.write('Edit baseURL, routes, and webServer for your project, then run `npx preflight --smoke`.\n');
  return EXIT.OK;
}

async function main() {
  const consumerCwd = process.cwd();
  const version = readSelfVersion();

  const distAvailable = existsSync(path.join(__dirname, '..', 'dist', 'cli', 'parseArgs.js'));
  if (!distAvailable) {
    process.stderr.write(
      'preflight: dist/ is missing. If you installed from git, run `npm install` in the preflight checkout, ' +
        'or reinstall the dependency so the prepare script runs.\n'
    );
    return EXIT.ENV_ERROR;
  }

  const { parseArgs } = require_('../dist/cli/parseArgs.js');
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === 'help') {
    printHelpAndExit();
    return EXIT.OK;
  }
  if (parsed.command === 'version') {
    process.stdout.write(`preflight ${version}\n`);
    return EXIT.OK;
  }
  if (parsed.unknown.length > 0) {
    process.stderr.write(
      `preflight: unknown argument(s): ${parsed.unknown.join(' ')}\n` +
        'Run `preflight --help` for usage.\n'
    );
    return EXIT.CONFIG_ERROR;
  }

  if (parsed.command === 'init') {
    return await cmdInit(parsed, consumerCwd);
  }

  // run | list — both need a resolved config.
  let configPath = parsed.configPath;
  if (configPath) {
    if (!path.isAbsolute(configPath)) configPath = path.resolve(consumerCwd, configPath);
    if (!existsSync(configPath)) {
      process.stderr.write(`preflight: config file not found at ${configPath}\n`);
      return EXIT.CONFIG_ERROR;
    }
  } else {
    configPath = discoverConfigPath(consumerCwd);
    if (!configPath) {
      process.stderr.write(
        'preflight: no preflight.config.{ts,mts,js,mjs} found in this directory or any ancestor.\n' +
          'Run `npx preflight init` to create a starter config.\n'
      );
      return EXIT.CONFIG_ERROR;
    }
  }

  let rawConfig;
  try {
    rawConfig = await loadConsumerConfig(configPath, consumerCwd);
  } catch (err) {
    process.stderr.write(`preflight: ${err && err.message ? err.message : String(err)}\n`);
    return EXIT.CONFIG_ERROR;
  }

  if (rawConfig === undefined || rawConfig === null) {
    process.stderr.write(
      `preflight: ${configPath} did not export a config. ` +
        'Use `export default defineConfig({ ... })`.\n'
    );
    return EXIT.CONFIG_ERROR;
  }

  // Validate via defineConfig — accepts either a raw config object OR an
  // already-resolved one (idempotent). This is what catches typos.
  const { validateAndResolve, PreflightConfigError } = require_('../dist/defineConfig.js');
  let resolved;
  try {
    resolved = validateAndResolve(rawConfig);
  } catch (err) {
    if (err instanceof PreflightConfigError || (err && err.name === 'PreflightConfigError')) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.CONFIG_ERROR;
    }
    process.stderr.write(`preflight: invalid config: ${err && err.message ? err.message : String(err)}\n`);
    return EXIT.CONFIG_ERROR;
  }

  // Restrict to a single route if --only was passed.
  if (parsed.only) {
    const match = resolved.routes.find((r) => r.name === parsed.only);
    if (!match) {
      process.stderr.write(
        `preflight: --only="${parsed.only}" did not match any route name. ` +
          `Known routes: ${resolved.routes.map((r) => r.name).join(', ')}\n`
      );
      return EXIT.CONFIG_ERROR;
    }
    resolved.routes = [match];
  }

  if (parsed.command === 'list') {
    const { renderMatrix } = require_('../dist/cli/runner.js');
    process.stdout.write(renderMatrix({ rawConfig: resolved, args: parsed }) + '\n');
    return EXIT.OK;
  }

  // command === 'run'
  try {
    const { run, EnvError } = require_('../dist/cli/runner.js');
    const result = await run({
      args: parsed,
      rawConfig: resolved,
      consumerCwd,
      preflightVersion: version,
    });
    return result.exitCode;
  } catch (err) {
    if (err && (err.name === 'EnvError' || err.code === 'ENV_ERROR')) {
      process.stderr.write(`preflight: ${err.message}\n`);
      return EXIT.ENV_ERROR;
    }
    process.stderr.write(
      `preflight: unexpected runtime error: ${err && err.stack ? err.stack : String(err)}\n`
    );
    return EXIT.RUNTIME_ERROR;
  }
}

main()
  .then((code) => process.exit(code ?? EXIT.RUNTIME_ERROR))
  .catch((err) => {
    process.stderr.write(`preflight: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(EXIT.RUNTIME_ERROR);
  });
