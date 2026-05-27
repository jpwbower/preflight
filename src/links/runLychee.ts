import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedPreflightConfig } from '../types.js';

export interface RunLycheeOptions {
  consumerCwd: string;
  config: ResolvedPreflightConfig;
  verbose: boolean;
  preflightVersion: string;
}

export interface RunLycheeResult {
  exitCode: number;
}

/**
 * Shell out to the lychee CLI for link-checking.
 *
 * Why we shell to a binary rather than vendor a JS link-checker:
 *   lychee is the de-facto standard, written in Rust, fast, and
 *   actively maintained. Every JS-native alternative we evaluated
 *   either bit-rots quickly or trips on async-rendered links. The
 *   trade-off — consumers need lychee installed separately — is
 *   worth the reliability win, especially for nightly cadence.
 *
 * Why this respects `lychee.toml` in the consumer CWD:
 *   Consumers will inevitably need to allowlist false-positive
 *   domains (LinkedIn returns 999, X.com requires auth, etc.).
 *   lychee's own config is the canonical place for that, and we'd
 *   only add friction by inventing a parallel allowlist surface.
 */
export async function runLychee(opts: RunLycheeOptions): Promise<RunLycheeResult> {
  const { consumerCwd, config, verbose } = opts;

  const lastRunDir = path.join(consumerCwd, '.preflight', 'last-run');
  await mkdir(lastRunDir, { recursive: true });

  // The seed URLs: baseURL + each configured route. lychee will follow
  // links transitively up to its default recursion depth (1).
  const seeds = config.routes.map((r) => joinUrl(config.baseURL, r.path));

  const args: string[] = [];
  const consumerToml = path.join(consumerCwd, 'lychee.toml');
  if (existsSync(consumerToml)) {
    args.push('--config', consumerToml);
    if (verbose) {
      process.stderr.write(`[preflight] lychee: using consumer config ${consumerToml}\n`);
    }
  }

  // Default flags suitable for a website link sweep. The consumer
  // lychee.toml overrides any of these.
  args.push('--no-progress'); // CI-friendly stdout
  args.push('--max-concurrency', '8');
  args.push('--timeout', '20'); // seconds per URL
  args.push(...seeds);

  // Version diagnostic BEFORE the verbose launch log so any compatibility
  // warning precedes the visible launch line — reviewer-flagged R5.
  await checkLycheeVersion();

  if (verbose) {
    process.stderr.write(`[preflight] lychee: launching: lychee ${args.join(' ')}\n`);
  }

  // Pipe stdout/stderr straight to disk so a large-site sweep (lychee
  // can emit tens of MB on a thousand-link crawl) doesn't accumulate
  // in V8 heap and OOM the parent. The live tee to process.stdout
  // preserves the user's terminal feedback; the file is the artefact.
  const outputPath = path.join(lastRunDir, 'lychee-output.txt');
  const outputStream = createWriteStream(outputPath, { flags: 'w' });

  let mainResult = await spawnLycheeMain('lychee', args, consumerCwd, outputStream, false);
  // Windows scoop/npm shims register lychee as `lychee.cmd`. Node's
  // `spawn` without `shell: true` won't resolve PATHEXT, AND modern
  // Node (22.4+, post CVE-2024-27980) refuses to launch a .cmd file
  // even when named explicitly without `shell: true` — it surfaces
  // as EINVAL. So on Windows we retry through the shell, which lets
  // cmd.exe resolve `lychee` to `lychee.cmd` via PATHEXT.
  //
  // Trade-off: shell:true with an args array trips Node's DEP0190
  // deprecation warning ("arguments are not escaped, only
  // concatenated") and exposes the args list to cmd.exe parsing
  // (& | < > ^ etc. would be interpreted). preflight's args are
  // config-derived: route.path is validated to start with `/`, and
  // baseURL is validated as a URL — neither rejects all cmd
  // metacharacters, so the surface is non-zero. The threat model is
  // "consumer attacks their own machine via their own config", which
  // is acceptable for the .cmd-shim fallback only. The .exe primary
  // path (default for cargo / brew installs and any consumer
  // manually placing the binary) never goes through the shell.
  if (mainResult.notFound && process.platform === 'win32') {
    mainResult = await spawnLycheeMain('lychee', args, consumerCwd, outputStream, true);
  }
  if (mainResult.notFound) {
    process.stderr.write(
      '[preflight] lychee: command not found. Install the lychee CLI:\n' +
        '  https://lychee.cli.rs/installation/\n' +
        '  (e.g. `cargo install lychee`, `brew install lychee`, ' +
        '`scoop install lychee`)\n'
    );
  }
  const exitCode = await new Promise<number>((resolve) => {
    outputStream.end(() => resolve(mainResult.notFound ? 3 : mainResult.exitCode));
  });

  // Unified summary schema across cadences. The discriminator is
  // `cadence`; consumers branching on shape MUST switch on it. Fields
  // that only apply to one cadence are written as `null` rather than
  // omitted so the JSON keyspace is stable and downstream tooling
  // doesn't need to handle two different shapes for one path.
  const summary = {
    version: opts.preflightVersion,
    finishedAt: new Date().toISOString(),
    cadence: 'links' as const,
    exitCode,
    totals: null, // not applicable to the links cadence — no test-runner
    config: {
      baseURL: config.baseURL,
      routesSeeded: config.routes.length,
      routesCount: config.routes.length,
      engines: null,
      viewports: null,
      locale: config.locale,
      timezoneId: config.timezoneId,
    },
    disabledAxeRules: null,
    lycheeConfigUsed: existsSync(consumerToml) ? consumerToml : null,
  };
  await writeFile(
    path.join(lastRunDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8'
  );

  return { exitCode };
}

function joinUrl(base: string, p: string): string {
  if (/^https?:\/\//i.test(p)) return p;
  const baseTrimmed = base.replace(/\/+$/, '');
  const pathTrimmed = p.replace(/^\/+/, '');
  return `${baseTrimmed}/${pathTrimmed}`;
}

const LYCHEE_MIN_MAJOR = 0;
const LYCHEE_MIN_MINOR = 13;

/**
 * Pre-flight `lychee --version` round-trip. Closes the v0.2 carry-forward
 * "lychee version skew is silent until the CLI rejects an argument".
 *
 * Warns (does not block) if the installed lychee is older than 0.13.0 —
 * preflight uses --no-progress / --max-concurrency / --timeout, which
 * older lychee builds may not support. On parse failure we emit a
 * softer warning and proceed; link checking is best-effort and a
 * version check failing should never punish a consumer who pinned an
 * older lychee for unrelated reasons.
 *
 * The spawn itself can fail (ENOENT) — that's not our concern here; the
 * main run path below has dedicated handling for the missing-binary
 * case with install-instruction output. We swallow errors from this
 * probe to avoid double-reporting.
 */
async function checkLycheeVersion(): Promise<void> {
  // Capture BOTH streams — some pre-0.10 lychee builds wrote --version
  // output to stderr. Reviewer-flagged R5.
  let captured = await probeLycheeVersion('lychee', false);
  // Same Windows .cmd-shim retry as the main spawn path. The version
  // probe must use the same launch shape as the main spawn would —
  // otherwise the version warning silently no-ops on machines where
  // the main spawn succeeds via the .cmd retry. The `--version`
  // invocation passes no consumer-derived args, so shell:true here
  // has zero injection surface.
  if (!captured && process.platform === 'win32') {
    captured = await probeLycheeVersion('lychee', true);
  }
  if (!captured) return;
  const m = /^lychee\s+(\d+)\.(\d+)\.(\d+)/m.exec(captured);
  if (!m) {
    process.stderr.write(
      `[preflight] lychee: could not parse version from "${captured.trim().split(/\r?\n/)[0] ?? ''}"; proceeding without compatibility check.\n`
    );
    return;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const tooOld =
    major < LYCHEE_MIN_MAJOR ||
    (major === LYCHEE_MIN_MAJOR && minor < LYCHEE_MIN_MINOR);
  if (tooOld) {
    process.stderr.write(
      `[preflight] lychee ${major}.${minor}.${patch} detected. preflight uses --no-progress / --max-concurrency / --timeout which may not be supported. Upgrade via brew/scoop/cargo install lychee@latest.\n`
    );
  }
}

/**
 * One-shot lychee version probe. Returns the captured stdout+stderr,
 * or empty string on any failure (ENOENT / spawn error / no output).
 * The caller decides whether to retry through the shell on Windows
 * (needed for .cmd-shim installs).
 */
async function probeLycheeVersion(command: string, useShell: boolean): Promise<string> {
  let captured = '';
  await new Promise<void>((resolve) => {
    let child;
    try {
      child = spawn(command, ['--version'], { shell: useShell });
    } catch {
      resolve();
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      captured += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      captured += chunk.toString('utf8');
    });
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
  return captured;
}

interface SpawnLycheeMainResult {
  exitCode: number;
  /** True when the spawn failed with ENOENT — caller decides whether to retry. */
  notFound: boolean;
}

/**
 * Run lychee for real, piping stdout/stderr to both the output file
 * and the parent's tty. Returns `notFound: true` on ENOENT without
 * writing the install-instruction message; the caller handles that
 * (after a possible Windows .cmd-shim retry).
 */
async function spawnLycheeMain(
  command: string,
  args: string[],
  cwd: string,
  outputStream: NodeJS.WritableStream,
  useShell: boolean
): Promise<SpawnLycheeMainResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell: useShell });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        resolve({ exitCode: 3, notFound: true });
        return;
      }
      process.stderr.write(
        `[preflight] lychee: failed to spawn — ${err instanceof Error ? err.message : String(err)}\n` +
          'Install: https://lychee.cli.rs/installation/\n'
      );
      resolve({ exitCode: 3, notFound: false });
      return;
    }
    let settled = false;
    const settle = (val: SpawnLycheeMainResult) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputStream.write(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputStream.write(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        settle({ exitCode: 3, notFound: true });
        return;
      }
      process.stderr.write(`[preflight] lychee: spawn error: ${err.message}\n`);
      settle({ exitCode: 4, notFound: false });
    });
    child.on('exit', (code) => {
      settle({ exitCode: code ?? 1, notFound: false });
    });
  });
}
