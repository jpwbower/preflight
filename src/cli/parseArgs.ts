export type ReporterName = 'line' | 'list' | 'html' | 'json' | 'junit';
export type EngineFlag = 'chromium' | 'firefox' | 'webkit';

export interface ParsedArgs {
  command: 'run' | 'init' | 'list' | 'help' | 'version';
  // run-mode flags
  smoke: boolean;
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
  // Subcommand: `preflight init [...]`, `preflight list`
  if (argv[i] === 'init') {
    args.command = 'init';
    i++;
  } else if (argv[i] === 'list') {
    args.command = 'list';
    i++;
  }

  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      args.command = 'help';
    } else if (a === '--version' || a === '-V') {
      args.command = 'version';
    } else if (a === '--smoke') {
      args.smoke = true;
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
      args.engine = a.slice('--engine='.length) as EngineFlag;
    } else if (a === '--engine') {
      args.engine = argv[++i] as EngineFlag;
    } else if (a.startsWith('--reporter=')) {
      args.reporter = a.slice('--reporter='.length) as ReporterName;
    } else if (a === '--reporter') {
      args.reporter = argv[++i] as ReporterName;
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

export function helpText(): string {
  return [
    'preflight — local-only web-assurance scaffolding',
    '',
    'USAGE',
    '  preflight                    full default suite',
    '  preflight init [--force]     drop starter preflight.config.ts',
    '  preflight list               print engine x viewport x spec matrix; do not run',
    '',
    'FLAGS',
    '  --smoke                      chromium-only, mobile-375 viewport, smoke + a11y smoke',
    '  --list                       alias for the `list` subcommand',
    '  --only=<route>               scope to one configured route (matches route.name)',
    '  --engine=<name>              chromium | firefox | webkit',
    '  --headed                     non-headless browsers (debugging)',
    '  --debug                      set PWDEBUG=1 (Playwright Inspector)',
    '  --verbose                    verbose progress logs',
    '  --update-snapshots, -u       Playwright snapshot update passthrough',
    '  --reporter=<name>            line | list | html | json | junit',
    '  --config=<path>              override config discovery',
    '  --ci                         strict defaults: html + junit reporters, fail on warnings, no reuseExistingServer',
    '  --no-reuse                   force a fresh webServer launch',
    '  --force, -f                  (init) overwrite an existing preflight.config.ts',
    '  --help, -h                   show this message',
    '  --version, -V                print preflight version',
    '',
    'EXIT CODES',
    '  0  all checks passed',
    '  1  test failure',
    '  2  config error',
    '  3  environment error (e.g. Playwright browsers missing)',
    '  4  runtime error',
    '',
  ].join('\n');
}
