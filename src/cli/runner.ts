import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ParsedArgs } from './parseArgs.js';
import type { ResolvedPreflightConfig, EngineName, ViewportName } from '../types.js';
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

  const htmlReportDir = path.join(lastRunDir, 'html-report');
  const junitFile = path.join(lastRunDir, 'junit.xml');
  const jsonFile = path.join(lastRunDir, 'results.json');
  const testResultsDir = path.join(lastRunDir, 'test-results');

  await writeDisabledRulesArtefact(lastRunDir, cfg.axeDisabled);

  // Merge consumer consoleIgnore with built-in defaults (concat, not replace).
  const consoleIgnoreCombined = [...DEFAULT_CONSOLE_IGNORE, ...cfg.consoleIgnore];

  const serialised = {
    ...cfg,
    consoleIgnore: consoleIgnoreCombined.map((r) => ({ source: r.source, flags: r.flags })),
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
    PREFLIGHT_ONLY: args.only ?? '',
    PREFLIGHT_VERSION: opts.preflightVersion,
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

  await writeSummary(lastRunDir, cfg, exitCode);

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
  if (args.engine) {
    engines = [args.engine];
  }

  return { ...cfg, engines, viewports };
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
  exitCode: number;
  config: {
    baseURL: string;
    routesCount: number;
    engines: EngineName[];
    viewports: ViewportName[];
    locale: string;
    timezoneId: string;
  };
  disabledAxeRules: { rule: string; reason: string }[];
}

async function writeSummary(
  outDir: string,
  cfg: ResolvedPreflightConfig,
  exitCode: number
): Promise<void> {
  const summary: SummaryJson = {
    version: process.env.PREFLIGHT_VERSION ?? '0.0.0',
    finishedAt: new Date().toISOString(),
    exitCode,
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
  try {
    if (existsSync(target)) await rm(target);
    await symlink(reportIndex, target, 'file');
  } catch {
    // Windows non-elevated case: write a redirect stub.
    const rel = path.relative(lastRunDir, reportIndex).split(path.sep).join('/');
    const redirect = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${rel}"><title>preflight last-run report</title><p>Opening <a href="${rel}">${rel}</a> &hellip;</p>`;
    await writeFile(target, redirect, 'utf8');
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
  const specs = ['smoke', 'a11y', 'keyboard', 'emulated-media', 'virtual-sr'];
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
