#!/usr/bin/env node
// vantage CLI entry. Plain JS so it runs without a TypeScript loader.
// All non-trivial logic lives in dist/cli/*.js (compiled from src/cli/*.ts).

import path from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
  // fall back to vantage's bundled copy. Nested `node_modules/vantage/
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
 * Locate vantage.config.{ts,mts,js,mjs} in the consumer directory or any
 * ancestor. Mirrors how Playwright / Vitest discover their config files.
 */
function discoverConfigPath(consumerCwd) {
  const candidates = [
    'vantage.config.ts',
    'vantage.config.mts',
    'vantage.config.js',
    'vantage.config.mjs',
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

function isPathInsideOrEqual(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function findProjectBoundary(startDir) {
  let dir = path.resolve(startDir);
  let nearestPackageJsonDir = null;
  while (true) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (nearestPackageJsonDir === null && existsSync(path.join(dir, 'package.json'))) {
      nearestPackageJsonDir = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return nearestPackageJsonDir ?? path.resolve(startDir);
    dir = parent;
  }
}

function realPath(p) {
  return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
}

// Walk up from startDir looking for a `.git` (a version-controlled checkout
// marker). Returns the enclosing repo root, or null if startDir is not inside
// any git checkout. Unlike findProjectBoundary this is anchored on the path
// itself (not on cwd), so it can tell whether a --config FILE sits inside a
// checkout regardless of where vantage was launched from.
function findEnclosingRepo(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function loadConsumerConfig(configPath, consumerCwd) {
  const ext = path.extname(configPath).toLowerCase();
  if (ext === '.ts' || ext === '.mts') {
    // Use the consumer's installed `tsx` (vantage declares it as a regular
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
      // Validation errors thrown FROM the consumer's config body (e.g. they
      // called defineConfig with a bad value) must reach the user verbatim.
      // Re-wrapping them as "failed to load TypeScript config ... Make sure
      // tsx is installed" is misleading — tsx is fine.
      const msg = err && err.message ? err.message : String(err);
      if (err && (err.name === 'VantageConfigError' || msg.startsWith('vantage config error:'))) {
        throw err;
      }
      throw new ConfigError(
        `failed to load TypeScript config ${configPath}: ${msg}\n` +
          'Make sure tsx is installed (vantage pulls it in automatically — try `npm i`).'
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
      'vantage CLI — dist/ not built. Run `npm install` in this package, then `npm run prepare`.\n'
    );
  }
  process.exit(EXIT.OK);
}

async function cmdInit(parsed, consumerCwd) {
  const tplSrc = path.join(__dirname, '..', 'templates', 'vantage.config.ts.tpl');
  const dest = path.join(consumerCwd, 'vantage.config.ts');
  if (existsSync(dest) && !parsed.force) {
    process.stderr.write(
      `vantage init: ${dest} already exists. Re-run with --force to overwrite.\n`
    );
    return EXIT.CONFIG_ERROR;
  }
  if (!existsSync(tplSrc)) {
    process.stderr.write(
      `vantage init: template missing at ${tplSrc}. Reinstall vantage.\n`
    );
    return EXIT.RUNTIME_ERROR;
  }
  await copyFile(tplSrc, dest);
  process.stdout.write(`vantage init: wrote ${dest}\n`);

  if (parsed.ci) {
    const ghaSrc = path.join(__dirname, '..', 'templates', 'vantage.gha.yml.tpl');
    const ghaDestDir = path.join(consumerCwd, '.github', 'workflows');
    const ghaDest = path.join(ghaDestDir, 'vantage.yml');
    if (existsSync(ghaDest) && !parsed.force) {
      process.stderr.write(
        `vantage init --ci: ${ghaDest} already exists. Re-run with --force to overwrite.\n`
      );
      return EXIT.CONFIG_ERROR;
    }
    if (!existsSync(ghaSrc)) {
      process.stderr.write(
        `vantage init --ci: GHA template missing at ${ghaSrc}. Reinstall vantage.\n`
      );
      return EXIT.RUNTIME_ERROR;
    }
    await mkdir(ghaDestDir, { recursive: true });
    await copyFile(ghaSrc, ghaDest);
    process.stdout.write(`vantage init: wrote ${ghaDest}\n`);
  }

  process.stdout.write('Edit baseURL, routes, and webServer for your project, then run `npx vantage --smoke`.\n');
  return EXIT.OK;
}

async function cmdLinks(parsed, consumerCwd, resolvedConfig, vantageVersion) {
  const mod = require_('../dist/links/runLychee.js');
  const result = await mod.runLychee({
    consumerCwd,
    config: resolvedConfig,
    verbose: parsed.verbose,
    vantageVersion,
  });
  return result.exitCode;
}

async function main() {
  const consumerCwd = process.cwd();
  const version = readSelfVersion();

  // --help and --version are answerable without dist/. Sniff for them before
  // checking dist so a broken install can still print its version.
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelpAndExit();
    return EXIT.OK;
  }
  if (rawArgs.includes('--version') || rawArgs.includes('-V')) {
    process.stdout.write(`vantage ${version}\n`);
    return EXIT.OK;
  }

  const distAvailable = existsSync(path.join(__dirname, '..', 'dist', 'cli', 'parseArgs.js'));
  if (!distAvailable) {
    process.stderr.write(
      'vantage: dist/ is missing. If you installed from git, run `npm install` in the vantage checkout, ' +
        'or reinstall the dependency so the prepare script runs.\n'
    );
    return EXIT.ENV_ERROR;
  }

  const { parseArgs, detectFlagConflict } = require_('../dist/cli/parseArgs.js');
  const parsed = parseArgs(rawArgs);
  if (parsed.unknown.length > 0) {
    process.stderr.write(
      `vantage: unknown argument(s): ${parsed.unknown.join(' ')}\n` +
        'Run `vantage --help` for usage.\n'
    );
    return EXIT.CONFIG_ERROR;
  }
  const conflict = detectFlagConflict(parsed);
  if (conflict) {
    process.stderr.write(`vantage: ${conflict}\n`);
    return EXIT.CONFIG_ERROR;
  }

  if (parsed.command === 'init') {
    return await cmdInit(parsed, consumerCwd);
  }

  // run | list | links | teardown — all need a resolved config.
  let configPath = parsed.configPath;

  // --gate is a TRUSTED cadence: it must NEVER execute a PR-controlled
  // vantage.config.ts. It requires an explicit --config pointing at an
  // INERT .json file (data, not code), parsed directly and then checked
  // against a gate-only allowlist before normal config resolution.
  //
  // CONTRACT: the trusted gate driver must stage this JSON outside the PR
  // checkout and pass that absolute path. vantage enforces the mechanical
  // footguns it can see (absolute .json, outside the realpathed project
  // boundary, inert-key allowlist, no config-provided server command). It
  // cannot prove who wrote a sibling temp file, so config provenance remains
  // a runner responsibility; see README "Gate cadence > Security".
  if (parsed.gate) {
    if (!configPath) {
      process.stderr.write(
        'vantage --gate: requires an explicit --config <file.json>. The gate cadence never\n' +
          'auto-discovers or executes a vantage.config.ts — it loads an inert JSON config so the\n' +
          'route set under test comes from the trusted gate driver, not from PR-controlled code.\n'
      );
      return EXIT.CONFIG_ERROR;
    }
    // ABSOLUTE path required (do NOT resolve a relative path against cwd): a
    // gate run launched from inside the PR checkout with `--config foo.json`
    // would otherwise load a PR-controlled file. Forcing the trusted driver to
    // pass the absolute path of the config it staged closes that honest-error
    // path — the relative form is exactly the footgun the contract warns about.
    if (!path.isAbsolute(configPath)) {
      process.stderr.write(
        `vantage --gate: --config must be an ABSOLUTE path (got "${configPath}"). The gate\n` +
          'cadence refuses to resolve a relative path against the current directory — a gate run\n' +
          'launched from inside the PR checkout would then load a PR-controlled config. The trusted\n' +
          'gate driver must pass the absolute path of the config it staged.\n'
      );
      return EXIT.CONFIG_ERROR;
    }
    if (path.extname(configPath).toLowerCase() !== '.json') {
      process.stderr.write(
        `vantage --gate: --config must be a .json file (got ${configPath}). The gate cadence\n` +
          'refuses to execute a TypeScript/JavaScript config — supply an inert JSON config instead.\n'
      );
      return EXIT.CONFIG_ERROR;
    }
    if (!existsSync(configPath)) {
      process.stderr.write(`vantage --gate: config file not found at ${configPath}\n`);
      return EXIT.CONFIG_ERROR;
    }
    const gateRepoRootLexical = findProjectBoundary(consumerCwd);
    const gateRepoRoot = realPath(gateRepoRootLexical);
    const gateConfigReal = realPath(configPath);
    // The config's OWN enclosing git checkout, anchored on the config path (NOT
    // on cwd). This is the load-bearing provenance check: it rejects a config
    // that lives inside ANY checkout regardless of where vantage was launched
    // from — closing the honest misconfig where the driver runs vantage from a
    // scratch/staging cwd but passes a --config path inside the real PR checkout
    // (the cwd-derived boundary below would compare against the scratch dir and
    // wrongly accept the PR-controlled JSON). The trusted gate driver must stage
    // the inert JSON in a non-versioned dir (e.g. a temp dir) outside any repo.
    const gateConfigEnclosingRepo = findEnclosingRepo(path.dirname(gateConfigReal));
    // Also reject if the config sits inside THIS project's checkout, EITHER
    // lexically (a PR could have created it there, incl. a symlink/junction) OR
    // after realpath. The union closes a symlink pointing OUTWARD from inside as
    // well as one pointing INWARD from outside.
    if (
      gateConfigEnclosingRepo !== null ||
      isPathInsideOrEqual(configPath, gateRepoRootLexical) ||
      isPathInsideOrEqual(gateConfigReal, gateRepoRoot)
    ) {
      process.stderr.write(
        `vantage --gate: --config must be staged outside the current project checkout (got "${configPath}").\n` +
          `Resolved project boundary: ${gateRepoRoot}\n` +
          (gateConfigEnclosingRepo !== null
            ? `Config is inside a git checkout: ${gateConfigEnclosingRepo}\n`
            : '') +
          'A config inside ANY checkout — or a symlink/junction whose real target is — can be\n' +
          'PR-controlled; the trusted gate driver must stage the inert JSON config in a\n' +
          'non-versioned directory (e.g. a temp dir) outside any repo and pass its absolute path.\n'
      );
      return EXIT.CONFIG_ERROR;
    }
  } else if (configPath) {
    if (!path.isAbsolute(configPath)) configPath = path.resolve(consumerCwd, configPath);
    if (!existsSync(configPath)) {
      process.stderr.write(`vantage: config file not found at ${configPath}\n`);
      return EXIT.CONFIG_ERROR;
    }
  } else {
    configPath = discoverConfigPath(consumerCwd);
    if (!configPath) {
      process.stderr.write(
        'vantage: no vantage.config.{ts,mts,js,mjs} found in this directory or any ancestor.\n' +
          'Run `npx vantage init` to create a starter config.\n'
      );
      return EXIT.CONFIG_ERROR;
    }
  }

  let rawConfig;
  try {
    // Gate mode parses the inert JSON directly (never imports executable
    // config code); every other cadence loads the .ts/.js config as usual.
    // Gate JSON is then checked against a gate-only allowlist before it
    // converges on validateAndResolve() for shared schema/default handling.
    rawConfig = parsed.gate
      ? JSON.parse(readFileSync(configPath, 'utf8'))
      : await loadConsumerConfig(configPath, consumerCwd);
  } catch (err) {
    const prefix = parsed.gate ? `vantage --gate: failed to parse ${configPath}: ` : 'vantage: ';
    process.stderr.write(`${prefix}${err && err.message ? err.message : String(err)}\n`);
    return EXIT.CONFIG_ERROR;
  }

  if (rawConfig === undefined || rawConfig === null) {
    process.stderr.write(
      `vantage: ${configPath} did not export a config. ` +
        'Use `export default defineConfig({ ... })`.\n'
    );
    return EXIT.CONFIG_ERROR;
  }

  // Validate via defineConfig — accepts either a raw config object OR an
  // already-resolved one (idempotent). This is what catches typos.
  const { validateAndResolve, validateGateConfig, VantageConfigError } = require_('../dist/defineConfig.js');
  let resolved;
  try {
    if (parsed.gate) validateGateConfig(rawConfig);
    resolved = validateAndResolve(rawConfig);
  } catch (err) {
    if (err instanceof VantageConfigError || (err && err.name === 'VantageConfigError')) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.CONFIG_ERROR;
    }
    process.stderr.write(`vantage: invalid config: ${err && err.message ? err.message : String(err)}\n`);
    return EXIT.CONFIG_ERROR;
  }

  // Restrict to a single route if --only was passed.
  if (parsed.only) {
    const match = resolved.routes.find((r) => r.name === parsed.only);
    if (!match) {
      process.stderr.write(
        `vantage: --only="${parsed.only}" did not match any route name. ` +
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

  if (parsed.command === 'teardown') {
    try {
      const { runTeardown } = require_('../dist/cli/runner.js');
      return await runTeardown({ rawConfig: resolved, consumerCwd, verbose: parsed.verbose });
    } catch (err) {
      process.stderr.write(
        `vantage teardown: ${err && err.stack ? err.stack : String(err)}\n`
      );
      return EXIT.RUNTIME_ERROR;
    }
  }

  if (parsed.command === 'links') {
    try {
      return await cmdLinks(parsed, consumerCwd, resolved, version);
    } catch (err) {
      if (err && (err.name === 'EnvError' || err.code === 'ENV_ERROR')) {
        process.stderr.write(`vantage: ${err.message}\n`);
        return EXIT.ENV_ERROR;
      }
      process.stderr.write(
        `vantage --links: ${err && err.stack ? err.stack : String(err)}\n`
      );
      return EXIT.RUNTIME_ERROR;
    }
  }

  // command === 'run'
  try {
    const { run, EnvError } = require_('../dist/cli/runner.js');
    const result = await run({
      args: parsed,
      rawConfig: resolved,
      consumerCwd,
      vantageVersion: version,
    });
    return result.exitCode;
  } catch (err) {
    if (err && (err.name === 'EnvError' || err.code === 'ENV_ERROR')) {
      process.stderr.write(`vantage: ${err.message}\n`);
      return EXIT.ENV_ERROR;
    }
    process.stderr.write(
      `vantage: unexpected runtime error: ${err && err.stack ? err.stack : String(err)}\n`
    );
    return EXIT.RUNTIME_ERROR;
  }
}

main()
  .then((code) => process.exit(code ?? EXIT.RUNTIME_ERROR))
  .catch((err) => {
    process.stderr.write(`vantage: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(EXIT.RUNTIME_ERROR);
  });
