export type ReporterName = 'line' | 'list' | 'html' | 'json' | 'junit';
export type EngineFlag = 'chromium' | 'firefox' | 'webkit';

const VALID_ENGINES: ReadonlySet<EngineFlag> = new Set<EngineFlag>(['chromium', 'firefox', 'webkit']);
const VALID_REPORTERS: ReadonlySet<ReporterName> = new Set<ReporterName>([
  'line',
  'list',
  'html',
  'json',
  'junit',
]);

export interface ParsedArgs {
  command: 'run' | 'init' | 'list' | 'help' | 'version' | 'links' | 'teardown';
  // run-mode flags
  smoke: boolean;
  release: boolean;
  links: boolean;
  visual: boolean;
  noAuth: boolean;
  ci: boolean;
  headed: boolean;
  debug: boolean;
  verbose: boolean;
  noReuse: boolean;
  updateSnapshots: boolean;
  only?: string;
  engine?: EngineFlag;
  reporter?: ReporterName;
  configPath?: string;
  // init-mode flags
  force: boolean;
  // diagnostic
  unknown: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'run',
    smoke: false,
    release: false,
    links: false,
    visual: false,
    noAuth: false,
    ci: false,
    headed: false,
    debug: false,
    verbose: false,
    noReuse: false,
    updateSnapshots: false,
    force: false,
    unknown: [],
  };

  let i = 0;
  // Subcommand: `preflight init [...]`, `preflight list`, `preflight teardown`
  if (argv[i] === 'init') {
    args.command = 'init';
    i++;
  } else if (argv[i] === 'list') {
    args.command = 'list';
    i++;
  } else if (argv[i] === 'teardown') {
    args.command = 'teardown';
    i++;
  }

  const assignEngine = (raw: string | undefined): void => {
    if (raw && !VALID_ENGINES.has(raw as EngineFlag)) {
      args.unknown.push(`--engine=${raw}`);
      return;
    }
    args.engine = raw as EngineFlag | undefined;
  };
  const assignReporter = (raw: string | undefined): void => {
    if (raw && !VALID_REPORTERS.has(raw as ReporterName)) {
      args.unknown.push(`--reporter=${raw}`);
      return;
    }
    args.reporter = raw as ReporterName | undefined;
  };

  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      args.command = 'help';
    } else if (a === '--version' || a === '-V') {
      args.command = 'version';
    } else if (a === '--smoke') {
      args.smoke = true;
    } else if (a === '--release') {
      args.release = true;
    } else if (a === '--links') {
      args.links = true;
      // --links promotes the run to the dedicated links command — it
      // bypasses Playwright entirely and shells out to lychee.
      if (args.command === 'run') args.command = 'links';
    } else if (a === '--visual') {
      args.visual = true;
    } else if (a === '--no-auth') {
      args.noAuth = true;
    } else if (a === '--ci') {
      args.ci = true;
    } else if (a === '--headed') {
      args.headed = true;
    } else if (a === '--debug') {
      args.debug = true;
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '--no-reuse') {
      args.noReuse = true;
    } else if (a === '--update-snapshots' || a === '-u') {
      args.updateSnapshots = true;
    } else if (a === '--list') {
      // `--list` is an alias for the `list` subcommand
      args.command = 'list';
    } else if (a === '--force' || a === '-f') {
      args.force = true;
    } else if (a.startsWith('--only=')) {
      args.only = a.slice('--only='.length);
    } else if (a === '--only') {
      args.only = argv[++i];
    } else if (a.startsWith('--engine=')) {
      assignEngine(a.slice('--engine='.length));
    } else if (a === '--engine') {
      assignEngine(argv[++i]);
    } else if (a.startsWith('--reporter=')) {
      assignReporter(a.slice('--reporter='.length));
    } else if (a === '--reporter') {
      assignReporter(argv[++i]);
    } else if (a.startsWith('--config=')) {
      args.configPath = a.slice('--config='.length);
    } else if (a === '--config') {
      args.configPath = argv[++i];
    } else {
      args.unknown.push(a);
    }
  }

  return args;
}

/**
 * Cadence-flag conflict checker. Returns a human-readable conflict
 * message, or null if the flag combination is coherent.
 *
 * --visual restricts the matrix to ONE project (cfg.visualProject),
 * so combining it with --smoke (which also forces engines/viewports)
 * or --engine (which overrides the engine) silently masks one of the
 * two. Reject the combination loudly so the user knows which intent
 * to keep.
 *
 * Similarly --release + --visual is incoherent: --release adds heavy
 * specs gated to the release-supported project, --visual restricts to
 * only the visual spec on one project. They can't both be true.
 */
export function detectFlagConflict(args: ParsedArgs): string | null {
  if (args.visual) {
    if (args.smoke) return '--visual cannot be combined with --smoke (they choose different project subsets).';
    if (args.release) return '--visual cannot be combined with --release (different cadences).';
    if (args.engine) return '--visual cannot be combined with --engine (use cfg.visualProject to pick the visual project).';
  }
  if (args.release && args.smoke) return '--release cannot be combined with --smoke.';
  return null;
}

export function helpText(): string {
  return [
    'preflight — local-only web-assurance scaffolding',
    '',
    'USAGE',
    '  preflight                    full default suite',
    '  preflight --smoke            single-engine smoke (chromium + mobile-375)',
    '  preflight --release          full + nvda + lighthouse + html-validate',
    '  preflight --links            lychee link check (standalone, no Playwright)',
    '  preflight --visual           visual regression on one project (toHaveScreenshot)',
    '  preflight init [--force]     drop starter preflight.config.ts',
    '  preflight init --ci          additionally drop .github/workflows/preflight.yml',
    '  preflight list               print engine x viewport x spec matrix; do not run',
    '  preflight teardown           run cfg.auth.teardown + delete cached storageState',
    '',
    'CADENCE',
    '  --smoke       per-commit (fast, chromium-only)',
    '  (default)     PR-open (full engine x viewport matrix)',
    '  --release     pre-tag (adds nvda Windows-only, lighthouse chromium-only, html-validate)',
    '  --links       nightly (lychee against the consumer-built site / config)',
    '  --visual      opt-in (visual regression on one project; baselines consumer-managed)',
    '',
    'FLAGS',
    '  --smoke                      chromium-only, mobile-375 viewport, smoke + a11y smoke',
    '  --release                    add nvda + lighthouse + html-validate to the default suite',
    '  --links                      run lychee link checker only (skips Playwright)',
    '  --visual                     run only the visual regression spec (toHaveScreenshot)',
    '  --no-auth                    skip cfg.auth.setup even if configured',
    '  --list                       alias for the `list` subcommand',
    '  --only=<route>               scope to one configured route (matches route.name)',
    '  --engine=<name>              chromium | firefox | webkit',
    '  --headed                     non-headless browsers (debugging)',
    '  --debug                      set PWDEBUG=1 (Playwright Inspector)',
    '  --verbose                    verbose progress logs',
    '  --update-snapshots, -u       Playwright snapshot update passthrough',
    '  --reporter=<name>            line | list | html | json | junit',
    '  --config=<path>              override config discovery',
    '  --ci                         (run) strict reporters + fail-on-warning + no reuseExistingServer',
    '  --ci                         (init) additionally drop .github/workflows/preflight.yml',
    '  --no-reuse                   force a fresh webServer launch',
    '  --force, -f                  (init) overwrite existing files',
    '  --help, -h                   show this message',
    '  --version, -V                print preflight version',
    '',
    'EXIT CODES',
    '  0  all checks passed',
    '  1  test failure',
    '  2  config error',
    '  3  environment error (preflight dist/ missing or @playwright/test peer dep not installed)',
    '  4  runtime error',
    '',
  ].join('\n');
}
