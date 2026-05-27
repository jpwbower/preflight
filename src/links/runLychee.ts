import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

  let stdoutCapture = '';
  let stderrCapture = '';

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
      resolve(3);
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutCapture += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrCapture += text;
      process.stderr.write(text);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        process.stderr.write(
          '[preflight] lychee: command not found. Install the lychee CLI:\n' +
            '  https://lychee.cli.rs/installation/\n' +
            '  (e.g. `cargo install lychee`, `brew install lychee`, ' +
            '`scoop install lychee`)\n'
        );
        resolve(3);
        return;
      }
      process.stderr.write(`[preflight] lychee: spawn error: ${err.message}\n`);
      resolve(4);
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });

  // Persist the captured output so a CI job can attach it without
  // re-running lychee. The summary.json mirrors what the standard
  // `run` path emits, so consumers see a uniform artefact shape
  // across cadences.
  await writeFile(
    path.join(lastRunDir, 'lychee-output.txt'),
    stdoutCapture + (stderrCapture ? `\n--- stderr ---\n${stderrCapture}` : ''),
    'utf8'
  );
  await writeFile(
    path.join(lastRunDir, 'summary.json'),
    JSON.stringify(
      {
        version: opts.preflightVersion,
        finishedAt: new Date().toISOString(),
        cadence: 'links',
        exitCode,
        config: {
          baseURL: config.baseURL,
          routesSeeded: config.routes.length,
        },
        lycheeConfigUsed: existsSync(consumerToml) ? consumerToml : null,
      },
      null,
      2
    ),
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
