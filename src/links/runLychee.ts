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

  if (verbose) {
    process.stderr.write(`[preflight] lychee: launching: lychee ${args.join(' ')}\n`);
  }

  // Pipe stdout/stderr straight to disk so a large-site sweep (lychee
  // can emit tens of MB on a thousand-link crawl) doesn't accumulate
  // in V8 heap and OOM the parent. The live tee to process.stdout
  // preserves the user's terminal feedback; the file is the artefact.
  const outputPath = path.join(lastRunDir, 'lychee-output.txt');
  const outputStream = createWriteStream(outputPath, { flags: 'w' });

  const exitCode = await new Promise<number>((resolve) => {
    let child;
    try {
      child = spawn('lychee', args, { cwd: consumerCwd });
    } catch (err) {
      process.stderr.write(
        `[preflight] lychee: failed to spawn — is the lychee CLI installed and on PATH?\n` +
          `  ${err instanceof Error ? err.message : String(err)}\n` +
          'Install: https://lychee.cli.rs/installation/\n'
      );
      outputStream.end();
      resolve(3);
      return;
    }
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
        process.stderr.write(
          '[preflight] lychee: command not found. Install the lychee CLI:\n' +
            '  https://lychee.cli.rs/installation/\n' +
            '  (e.g. `cargo install lychee`, `brew install lychee`, ' +
            '`scoop install lychee`)\n'
        );
        outputStream.end();
        resolve(3);
        return;
      }
      process.stderr.write(`[preflight] lychee: spawn error: ${err.message}\n`);
      outputStream.end();
      resolve(4);
    });
    child.on('exit', (code) => {
      outputStream.end(() => resolve(code ?? 1));
    });
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
