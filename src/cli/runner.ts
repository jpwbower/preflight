import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, symlink, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { ParsedArgs } from './parseArgs.js';
import type {
  ResolvedPreflightConfig,
  EngineName,
  ViewportName,
  PreflightAuth,
} from '../types.js';
import { ALL_VIEWPORTS } from '../viewports.js';
import { DEFAULT_CONSOLE_IGNORE } from '../console-ignore-defaults.js';
import { writeDisabledRulesArtefact } from '../report/disabled-rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require_ = createRequire(import.meta.url);

/**
 * Resolve the Playwright CLI entry. We resolve from the consumer's CWD so
 * that the consumer's installed @playwright/test (declared as a peerDep) is
 * used, not preflight's own copy.
 */
function resolvePlaywrightCli(consumerCwd: string): string {
  const fromConsumer = createRequire(path.join(consumerCwd, 'package.json'));
  try {
    return fromConsumer.resolve('@playwright/test/cli');
  } catch {
    // Fall back to preflight's bundled dev dep so smoke-runs in CI of the
    // preflight repo itself still work.
    try {
      return require_.resolve('@playwright/test/cli');
    } catch {
      throw new EnvError(
        '@playwright/test is not installed. Run `npm i -D @playwright/test` in your project, ' +
          'then `npx playwright install` to fetch browser binaries.'
      );
    }
  }
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

export interface RunOptions {
  args: ParsedArgs;
  rawConfig: ResolvedPreflightConfig;
  consumerCwd: string;
  preflightVersion: string;
}

export interface RunResult {
  exitCode: number;
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const { args, rawConfig, consumerCwd } = opts;

  const cfg = applyRunFlagsToConfig(rawConfig, args);

  const lastRunDir = path.join(consumerCwd, '.preflight', 'last-run');
  await rm(lastRunDir, { recursive: true, force: true });
  await mkdir(lastRunDir, { recursive: true });

  // Auth lifecycle: if cfg.auth is set and --no-auth was not passed, run
  // the consumer's setup module (or reuse a cached storageState that is
  // still within its expiry window). The resolved path is forwarded to
  // playwright.config.ts via PREFLIGHT_CONFIG_JSON so every project's
  // use.storageState picks it up.
  let storageStatePath: string | undefined;
  if (cfg.auth && !args.noAuth) {
    try {
      storageStatePath = await ensureAuthStorageState(cfg.auth, consumerCwd, args.verbose);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[preflight] auth setup failed: ${msg}\n`);
      return { exitCode: 4 };
    }
  }

  const htmlReportDir = path.join(lastRunDir, 'html-report');
  const junitFile = path.join(lastRunDir, 'junit.xml');
  const jsonFile = path.join(lastRunDir, 'results.json');
  const testResultsDir = path.join(lastRunDir, 'test-results');

  await writeDisabledRulesArtefact(lastRunDir, cfg.axeDisabled);

  // Merge consumer consoleIgnore with built-in defaults (concat, not replace).
  const consoleIgnoreCombined = [...DEFAULT_CONSOLE_IGNORE, ...cfg.consoleIgnore];

  // Pre-resolve webServer.cwd so playwright.config.ts never depends on
  // process.cwd() semantics — the dist directory of preflight is the
  // wrong cwd for any webServer.command with a relative path, and the
  // bug only surfaces with consumer-managed servers (v0.1/v0.2 hid it
  // by using webServer:false). Resolve once, in the parent runner.
  const resolvedWebServer =
    cfg.webServer === false
      ? cfg.webServer
      : {
          ...cfg.webServer,
          cwd: cfg.webServer.cwd
            ? path.isAbsolute(cfg.webServer.cwd)
              ? cfg.webServer.cwd
              : path.join(consumerCwd, cfg.webServer.cwd)
            : consumerCwd,
        };

  const serialised = {
    ...cfg,
    webServer: resolvedWebServer,
    consoleIgnore: consoleIgnoreCombined.map((r) => ({ source: r.source, flags: r.flags })),
    storageStatePath,
  };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PREFLIGHT_CONFIG_JSON: JSON.stringify(serialised),
    PREFLIGHT_HTML_REPORT_DIR: htmlReportDir,
    PREFLIGHT_JUNIT_FILE: junitFile,
    PREFLIGHT_JSON_FILE: jsonFile,
    PREFLIGHT_TEST_RESULTS_DIR: testResultsDir,
    PREFLIGHT_CI: args.ci ? '1' : '0',
    PREFLIGHT_NO_REUSE: args.noReuse ? '1' : '0',
    PREFLIGHT_VERBOSE: args.verbose ? '1' : '0',
    PREFLIGHT_SMOKE: args.smoke ? '1' : '0',
    PREFLIGHT_RELEASE: args.release ? '1' : '0',
    PREFLIGHT_VISUAL: args.visual ? '1' : '0',
    // PREFLIGHT_VERSION is intentionally NOT forwarded — writeSummary in the
    // parent process takes the version directly, so the child does not need it.
  };
  if (args.debug) env.PWDEBUG = '1';
  if (args.reporter) env.PREFLIGHT_REPORTER = args.reporter;

  const playwrightCli = resolvePlaywrightCli(consumerCwd);
  const pwConfigPath = path.join(__dirname, '..', 'playwright.config.js');

  const cliArgs: string[] = [playwrightCli, 'test', '--config', pwConfigPath];
  if (args.headed) cliArgs.push('--headed');
  if (args.updateSnapshots) cliArgs.push('--update-snapshots');

  if (args.verbose) {
    process.stderr.write(`[preflight] launching: node ${cliArgs.map((a) => quote(a)).join(' ')}\n`);
  }

  const exitCode = await runPlaywright(cliArgs, env, consumerCwd);

  const totals = await tallyResults(jsonFile);
  const cadence: SummaryJson['cadence'] = args.visual
    ? 'visual'
    : args.smoke
      ? 'smoke'
      : args.release
        ? 'release'
        : 'full';
  await writeSummary(lastRunDir, cfg, exitCode, opts.preflightVersion, totals, cadence);

  // Convenience symlink: .preflight/last-run/index.html → html-report/index.html.
  // Symlink creation on Windows requires elevation or Developer Mode; if it
  // fails we fall back to a tiny redirect HTML so the path still resolves.
  await linkOrRedirect(lastRunDir, htmlReportDir);

  return { exitCode };
}

function applyRunFlagsToConfig(
  cfg: ResolvedPreflightConfig,
  args: ParsedArgs
): ResolvedPreflightConfig {
  let engines: EngineName[] = cfg.engines;
  let viewports: ViewportName[] = cfg.viewports;

  if (args.smoke) {
    engines = ['chromium'];
    viewports = ['mobile-375'];
  }
  if (args.visual) {
    // Visual regression runs on exactly one project — derive it from
    // cfg.visualProject (default chromium__desktop-1280). Restricting
    // engines+viewports here avoids spawning workers for projects that
    // would only skip from inside the spec body.
    const projectName = cfg.visualProject ?? 'chromium__desktop-1280';
    const parsed = parseProjectName(projectName);
    if (!parsed) {
      throw new EnvError(
        `--visual: visualProject "${projectName}" is not a recognised engine__viewport project. ` +
          'Use a value matching one of the generated project names, e.g. "chromium__desktop-1280".'
      );
    }
    engines = [parsed.engine];
    viewports = [parsed.viewport];
  }
  if (args.engine) {
    engines = [args.engine];
  }

  return { ...cfg, engines, viewports };
}

const VALID_ENGINES: ReadonlySet<EngineName> = new Set(['chromium', 'firefox', 'webkit']);

function parseProjectName(name: string): { engine: EngineName; viewport: ViewportName } | null {
  const idx = name.indexOf('__');
  if (idx === -1) return null;
  const engine = name.slice(0, idx);
  const viewport = name.slice(idx + 2);
  if (!VALID_ENGINES.has(engine as EngineName)) return null;
  if (!ALL_VIEWPORTS.includes(viewport as ViewportName)) return null;
  return { engine: engine as EngineName, viewport: viewport as ViewportName };
}

function runPlaywright(
  cliArgs: string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cliArgs, {
      stdio: 'inherit',
      env,
      cwd,
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        process.stderr.write(`[preflight] Playwright terminated by signal ${signal}\n`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
    child.on('error', (err) => {
      process.stderr.write(`[preflight] failed to spawn Playwright: ${err.message}\n`);
      resolve(4);
    });
  });
}

interface SummaryJson {
  version: string;
  finishedAt: string;
  // Discriminator shared with the lychee cadence's summary.json so a
  // single CI consumer can switch on it instead of inferring shape.
  cadence: 'smoke' | 'full' | 'release' | 'links' | 'visual';
  exitCode: number;
  totals: {
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    expected: number;
  } | null;
  config: {
    baseURL: string;
    routesCount: number;
    engines: EngineName[] | null;
    viewports: ViewportName[] | null;
    locale: string;
    timezoneId: string;
  };
  disabledAxeRules: { rule: string; reason: string }[] | null;
}

async function tallyResults(jsonFile: string): Promise<NonNullable<SummaryJson['totals']>> {
  const empty = { passed: 0, failed: 0, skipped: 0, flaky: 0, expected: 0 };
  try {
    const raw = await readFile(jsonFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number };
    };
    const stats = parsed.stats ?? {};
    return {
      passed: stats.expected ?? 0,
      failed: stats.unexpected ?? 0,
      skipped: stats.skipped ?? 0,
      flaky: stats.flaky ?? 0,
      expected: stats.expected ?? 0,
    };
  } catch {
    return empty;
  }
}

async function writeSummary(
  outDir: string,
  cfg: ResolvedPreflightConfig,
  exitCode: number,
  preflightVersion: string,
  totals: NonNullable<SummaryJson['totals']>,
  cadence: SummaryJson['cadence']
): Promise<void> {
  const summary: SummaryJson = {
    version: preflightVersion,
    finishedAt: new Date().toISOString(),
    cadence,
    exitCode,
    totals,
    config: {
      baseURL: cfg.baseURL,
      routesCount: cfg.routes.length,
      engines: cfg.engines,
      viewports: cfg.viewports,
      locale: cfg.locale,
      timezoneId: cfg.timezoneId,
    },
    disabledAxeRules: cfg.axeDisabled,
  };
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
}

async function linkOrRedirect(lastRunDir: string, htmlReportDir: string): Promise<void> {
  const target = path.join(lastRunDir, 'index.html');
  const reportIndex = path.join(htmlReportDir, 'index.html');
  if (!existsSync(reportIndex)) return;
  const rel = path.relative(lastRunDir, reportIndex).split(path.sep).join('/');
  try {
    if (existsSync(target)) await rm(target);
    // Use the relative path as the symlink target so the link survives if
    // the user copies or moves .preflight/last-run/ wholesale.
    await symlink(rel, target, 'file');
  } catch {
    // Windows non-elevated case: write a redirect stub.
    const redirect = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${rel}"><title>preflight last-run report</title><p>Opening <a href="${rel}">${rel}</a> &hellip;</p>`;
    await writeFile(target, redirect, 'utf8');
  }
}

export interface TeardownOptions {
  rawConfig: ResolvedPreflightConfig;
  consumerCwd: string;
  verbose: boolean;
}

/**
 * `preflight teardown` subcommand: invokes cfg.auth.teardown if set,
 * then deletes the cached storageState. Idempotent — missing
 * storageState file is not an error. Useful as a safety net after a
 * test run leaves stale session cookies behind, or as a manual step
 * before a fresh dev session.
 */
export async function runTeardown(opts: TeardownOptions): Promise<number> {
  const { rawConfig: cfg, consumerCwd, verbose } = opts;
  if (!cfg.auth) {
    process.stderr.write(
      'preflight teardown: no `auth` block configured. Nothing to tear down.\n'
    );
    return 0;
  }
  const storageStatePath = resolveStorageStatePath(cfg.auth, consumerCwd);
  if (cfg.auth.teardown) {
    const teardownPath = path.isAbsolute(cfg.auth.teardown)
      ? cfg.auth.teardown
      : path.join(consumerCwd, cfg.auth.teardown);
    if (!existsSync(teardownPath)) {
      process.stderr.write(
        `preflight teardown: auth.teardown module not found at ${teardownPath}\n`
      );
      return 2;
    }
    if (verbose) {
      process.stderr.write(`[preflight] invoking auth teardown ${teardownPath}\n`);
    }
    try {
      const fn = await importDefaultFn(teardownPath, consumerCwd);
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[preflight] auth teardown threw: ${msg}\n`);
      return 4;
    }
  }
  if (existsSync(storageStatePath)) {
    await unlink(storageStatePath);
    if (verbose) {
      process.stderr.write(`[preflight] removed cached storageState ${storageStatePath}\n`);
    }
  }
  return 0;
}

function resolveStorageStatePath(auth: PreflightAuth, consumerCwd: string): string {
  const rel = auth.storageStatePath ?? path.join('.preflight', 'auth', 'storageState.json');
  return path.isAbsolute(rel) ? rel : path.join(consumerCwd, rel);
}

async function ensureAuthStorageState(
  auth: PreflightAuth,
  consumerCwd: string,
  verbose: boolean
): Promise<string> {
  const storageStatePath = resolveStorageStatePath(auth, consumerCwd);

  let needRefresh = !existsSync(storageStatePath);
  if (!needRefresh && auth.expirySeconds !== undefined) {
    try {
      const stats = await stat(storageStatePath);
      const ageSec = (Date.now() - stats.mtimeMs) / 1000;
      if (ageSec > auth.expirySeconds) {
        needRefresh = true;
        if (verbose) {
          process.stderr.write(
            `[preflight] cached storageState is ${Math.round(ageSec)}s old (> ${auth.expirySeconds}s expiry); refreshing\n`
          );
        }
      }
    } catch {
      needRefresh = true;
    }
  }

  if (!needRefresh) {
    if (verbose) {
      process.stderr.write(`[preflight] reusing cached storageState ${storageStatePath}\n`);
    }
    return storageStatePath;
  }

  const setupPath = path.isAbsolute(auth.setup)
    ? auth.setup
    : path.join(consumerCwd, auth.setup);
  if (!existsSync(setupPath)) {
    throw new EnvError(
      `auth.setup module not found at ${setupPath}. ` +
        'Set cfg.auth.setup to a path relative to your project root, or an absolute path.'
    );
  }
  if (verbose) {
    process.stderr.write(`[preflight] running auth setup ${setupPath}\n`);
  }
  const setupFn = await importDefaultFn(setupPath, consumerCwd);
  const state = await setupFn();
  if (state === null || typeof state !== 'object') {
    throw new EnvError(
      `auth.setup at ${setupPath} returned ${typeof state} — expected a Playwright storageState object ` +
        '(see https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state).'
    );
  }
  await mkdir(path.dirname(storageStatePath), { recursive: true });
  let serialised: string;
  try {
    serialised = JSON.stringify(state, null, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new EnvError(
      `auth.setup at ${setupPath} returned a value that is not JSON-serialisable: ${msg}. ` +
        'Ensure cookies/localStorage entries are plain strings/numbers (no BigInt, no circular refs).'
    );
  }
  // Write to a sibling .tmp file then atomic rename so concurrent
  // preflight runs in the same checkout cannot interleave a
  // half-written JSON that a Playwright worker would later fail to
  // parse when constructing a context with storageState.
  const tmpPath = `${storageStatePath}.tmp`;
  await writeFile(tmpPath, serialised, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmpPath, storageStatePath);
  return storageStatePath;
}

/**
 * Import the default export of `modPath` and require it to be a
 * function. Supports .ts/.mts via tsx and .js/.mjs natively.
 */
async function importDefaultFn(modPath: string, consumerCwd: string): Promise<() => unknown> {
  const ext = path.extname(modPath).toLowerCase();
  let mod: { default?: unknown } & Record<string, unknown>;
  if (ext === '.ts' || ext === '.mts') {
    const tsx = (await dynamicImportPreferringConsumer('tsx/esm/api', consumerCwd)) as {
      tsImport: (specifier: string, parentURL: string) => Promise<unknown>;
    };
    const url = pathToFileURL(modPath).href;
    mod = (await tsx.tsImport(url, import.meta.url)) as typeof mod;
  } else {
    mod = (await import(pathToFileURL(modPath).href)) as typeof mod;
  }
  if (typeof mod.default === 'function') {
    return mod.default as () => unknown;
  }
  // Common consumer mistake: named export only, no default. The
  // namespace object isn't callable; flagging this with a targeted
  // message saves a round of "but I exported it" debugging.
  if (mod.default === undefined) {
    const namedKeys = Object.keys(mod).filter((k) => k !== 'default');
    if (namedKeys.length > 0) {
      throw new EnvError(
        `${modPath} has no default export, only named export(s): ${namedKeys.join(', ')}. ` +
          'Change `export async function setupAuth() {...}` to `export default async function setupAuth() {...}`.'
      );
    }
    throw new EnvError(
      `${modPath} has no default export. ` +
        'Use `export default async function() { ... }` returning a Playwright storageState.'
    );
  }
  throw new EnvError(
    `${modPath} default export must be a function returning a storageState. Got: ${typeof mod.default}.`
  );
}

async function dynamicImportPreferringConsumer(
  specifier: string,
  consumerCwd: string
): Promise<unknown> {
  try {
    const consumerRequire = createRequire(path.join(consumerCwd, 'package.json'));
    const resolved = consumerRequire.resolve(specifier);
    return await import(pathToFileURL(resolved).href);
  } catch {
    const selfRequire = createRequire(import.meta.url);
    const resolved = selfRequire.resolve(specifier);
    return await import(pathToFileURL(resolved).href);
  }
}

export interface ListOptions {
  rawConfig: ResolvedPreflightConfig;
  args: ParsedArgs;
}

/**
 * Render the engine x viewport x spec matrix without running it.
 */
export function renderMatrix(opts: ListOptions): string {
  const cfg = applyRunFlagsToConfig(opts.rawConfig, opts.args);
  const baseSpecs = ['smoke', 'a11y', 'keyboard', 'emulated-media', 'virtual-sr'];
  const releaseSpecs = ['nvda', 'lighthouse', 'html-validate'];
  const specs = opts.args.visual
    ? ['visual']
    : opts.args.release
      ? [...baseSpecs, ...releaseSpecs]
      : baseSpecs;
  const rows: string[] = [];
  rows.push('preflight matrix:');
  rows.push(`  baseURL:    ${cfg.baseURL}`);
  rows.push(`  routes:     ${cfg.routes.map((r) => r.name).join(', ')}`);
  rows.push(`  engines:    ${cfg.engines.join(', ')}`);
  rows.push(`  viewports:  ${cfg.viewports.join(', ')}`);
  rows.push(`  specs:      ${specs.join(', ')}`);
  rows.push('');
  rows.push('  projects (engine__viewport):');
  for (const e of cfg.engines) {
    for (const v of cfg.viewports) {
      rows.push(`    - ${e}__${v}`);
    }
  }
  rows.push('');
  rows.push(`  total tests ~ engines(${cfg.engines.length}) x viewports(${cfg.viewports.length}) x specs(${specs.length}) x routes(${cfg.routes.length})`);
  return rows.join('\n');
}

function quote(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}
