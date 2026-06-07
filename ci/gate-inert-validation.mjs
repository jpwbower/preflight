#!/usr/bin/env node
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ciDir = path.dirname(__filename);
const repoRoot = path.dirname(ciDir);
const binPath = path.join(repoRoot, 'bin', 'preflight.mjs');
const manifestPath = path.join(ciDir, '.preflight', 'last-run', 'gate-manifest.json');

if (process.argv.includes('--serve')) {
  serveFixture();
} else {
  await runValidation();
}

function serveFixture() {
  const rootArg = readArg('--root');
  const portArg = readArg('--port');
  if (!rootArg || !portArg) {
    process.stderr.write('usage: gate-inert-validation.mjs --serve --root <dir> --port <port>\n');
    process.exit(2);
  }
  const root = path.resolve(rootArg);
  const port = Number(portArg);
  if (!Number.isInteger(port) || port <= 0) {
    process.stderr.write(`invalid --port ${String(portArg)}\n`);
    process.exit(2);
  }

  const server = createFixtureServer(root);
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.listen(port, '127.0.0.1');
}

async function runValidation() {
  if (!existsSync(path.join(repoRoot, 'dist', 'defineConfig.js'))) {
    fail('dist/ is missing. Run `npm run build` before ci/gate-inert-validation.mjs.');
  }
  const { validateAndResolve } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'defineConfig.js')).href);
  const { run } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'cli', 'runner.js')).href);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'preflight-gate-inert-'));
  try {
    const authSideEffect = path.join(tmp, 'auth-ran.txt');
    const authSetup = path.join(tmp, 'auth-setup.mjs');
    const globalSetupSideEffect = path.join(tmp, 'global-setup-ran.txt');
    const globalSetup = path.join(tmp, 'global-setup.mjs');
    writeFileSync(
      authSetup,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(authSideEffect)}, 'imported');\nexport default function setup() { return { cookies: [], origins: [] }; }\n`,
      'utf8'
    );
    writeFileSync(
      globalSetup,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(globalSetupSideEffect)}, 'imported');\nexport default async function globalSetup() {}\n`,
      'utf8'
    );

    const base = await gateConfig();

    expectConfigError(
      'relative --config',
      runPreflight(['--gate', '--config', 'gate-relative.json']),
      'ABSOLUTE path'
    );

    const insideConfig = path.join(repoRoot, 'gate-inside-project.json');
    writeFileSync(insideConfig, JSON.stringify(base, null, 2), 'utf8');
    try {
      expectConfigError(
        'absolute --config inside checkout from nested cwd',
        runPreflight(['--gate', '--config', insideConfig]),
        'outside the current project checkout'
      );
    } finally {
      rmSync(insideConfig, { force: true });
    }

    expectConfigError(
      'auth.setup',
      runPreflight(['--gate', '--config', writeConfig(tmp, 'auth.json', { ...base, auth: { setup: authSetup } })]),
      'cannot include "auth"'
    );
    if (existsSync(authSideEffect)) {
      fail('auth.setup side effect file was created; gate mode executed auth setup');
    }

    expectConfigError(
      'playwrightOverrides.globalSetup',
      runPreflight([
        '--gate',
        '--config',
        writeConfig(tmp, 'playwright-overrides.json', {
          ...base,
          playwrightOverrides: { globalSetup },
        }),
      ]),
      'cannot include "playwrightOverrides"'
    );
    if (existsSync(globalSetupSideEffect)) {
      fail('playwrightOverrides.globalSetup side effect file was created during CLI validation');
    }

    expectConfigError(
      'webServer.command',
      runPreflight([
        '--gate',
        '--config',
        writeConfig(tmp, 'webserver-command.json', {
          ...base,
          webServer: { command: 'node -e "process.exit(0)"', url: base.baseURL },
        }),
      ]),
      'webServer must be false'
    );

    expectConfigError(
      'non-allowlisted key',
      runPreflight(['--gate', '--config', writeConfig(tmp, 'non-allowlisted.json', { ...base, htmlValidateRaw: true })]),
      'non-allowlisted key "htmlValidateRaw"'
    );

    expectConfigError(
      'render-health suppression',
      runPreflight(['--gate', '--config', writeConfig(tmp, 'console-ignore.json', { ...base, consoleIgnore: ['.*'] })]),
      'cannot include "consoleIgnore"'
    );

    await expectRunnerBackstop('runner auth backstop', run, validateAndResolve, {
      ...base,
      auth: { setup: authSetup },
    });
    if (existsSync(authSideEffect)) {
      fail('auth.setup side effect file was created; runner backstop imported auth setup');
    }

    await expectRunnerBackstop('runner playwrightOverrides backstop', run, validateAndResolve, {
      ...base,
      playwrightOverrides: { globalSetup },
    });
    if (existsSync(globalSetupSideEffect)) {
      fail('playwrightOverrides.globalSetup side effect file was created during runner backstop');
    }

    await expectPlaywrightConfigBackstop(tmp, base, validateAndResolve, globalSetup, globalSetupSideEffect);

    const goodConfig = writeConfig(tmp, 'good.json', base);
    const server = await startFixtureServer(path.join(ciDir, 'fixture'), Number(new URL(base.baseURL).port));
    let manifest1;
    let manifest2;
    try {
      const first = runPreflight(['--gate', '--config', goodConfig, '--reporter=line']);
      expectSuccess('positive gate run 1', first);
      manifest1 = readManifest();
      const second = runPreflight(['--gate', '--config', goodConfig, '--reporter=line']);
      expectSuccess('positive gate run 2', second);
      manifest2 = readManifest();
    } finally {
      await closeServer(server);
    }

    if (!manifest1.coverageComplete || !manifest2.coverageComplete) {
      fail('positive gate run did not report coverageComplete:true');
    }
    if (manifest1.manifestSha256 !== manifest2.manifestSha256) {
      fail(
        `manifestSha256 changed across deterministic renders: ${manifest1.manifestSha256} != ${manifest2.manifestSha256}`
      );
    }

    process.stdout.write(`gate inert validation: PASS (${manifest1.manifestSha256})\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function gateConfig() {
  const port = await getFreePort();
  return {
    baseURL: `http://127.0.0.1:${port}`,
    routes: [{ name: 'home', path: '/' }],
    webServer: false,
    engines: ['chromium'],
    viewports: ['desktop-1280'],
    runnerTimeoutMs: 180_000,
  };
}

function writeConfig(tmp, name, config) {
  const p = path.join(tmp, name);
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
  return p;
}

function runPreflight(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: ciDir,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    timeout: 240_000,
  });
}

function expectConfigError(name, result, expected) {
  if (result.status !== 2) {
    failResult(name, result, `expected CONFIG_ERROR exit 2, got ${String(result.status)}`);
  }
  if (!result.stderr.includes(expected)) {
    failResult(name, result, `expected stderr to include ${JSON.stringify(expected)}`);
  }
  process.stdout.write(`gate inert validation: ${name} rejected\n`);
}

function expectSuccess(name, result) {
  if (result.status !== 0) {
    failResult(name, result, `expected success exit 0, got ${String(result.status)}`);
  }
}

async function expectRunnerBackstop(name, run, validateAndResolve, rawConfig) {
  const { value: result, stderr } = await captureProcessStderr(() =>
    run({
      args: gateArgs(),
      rawConfig: validateAndResolve(rawConfig),
      consumerCwd: ciDir,
      preflightVersion: 'gate-inert-validation',
    })
  );
  if (result.exitCode !== 2) {
    fail(
      `${name}: expected CONFIG_ERROR exit 2 from run(), got ${String(result.exitCode)}\n` +
        `captured stderr:\n${stderr || '(empty)'}`
    );
  }
  process.stdout.write(`gate inert validation: ${name} rejected\n`);
}

async function expectPlaywrightConfigBackstop(tmp, base, validateAndResolve, globalSetup, globalSetupSideEffect) {
  const resolved = validateAndResolve({ ...base, webServer: false });
  const previousEnv = {
    PREFLIGHT_CONFIG_JSON: process.env.PREFLIGHT_CONFIG_JSON,
    PREFLIGHT_GATE: process.env.PREFLIGHT_GATE,
    PREFLIGHT_HTML_REPORT_DIR: process.env.PREFLIGHT_HTML_REPORT_DIR,
    PREFLIGHT_JSON_FILE: process.env.PREFLIGHT_JSON_FILE,
    PREFLIGHT_TEST_RESULTS_DIR: process.env.PREFLIGHT_TEST_RESULTS_DIR,
  };
  process.env.PREFLIGHT_GATE = '1';
  process.env.PREFLIGHT_HTML_REPORT_DIR = path.join(tmp, 'html-report');
  process.env.PREFLIGHT_JSON_FILE = path.join(tmp, 'results.json');
  process.env.PREFLIGHT_TEST_RESULTS_DIR = path.join(tmp, 'test-results');
  process.env.PREFLIGHT_CONFIG_JSON = JSON.stringify({
    ...resolved,
    consoleIgnore: resolved.consoleIgnore.map((r) => ({ source: r.source, flags: r.flags })),
    playwrightOverrides: {
      globalSetup,
      projects: [{ name: 'evil', use: {} }],
      testMatch: ['**/evil.spec.js'],
      webServer: { command: 'node -e "process.exit(0)"' },
    },
  });
  try {
    const mod = await import(
      `${pathToFileURL(path.join(repoRoot, 'dist', 'playwright.config.js')).href}?gateBackstop=${Date.now()}`
    );
    const config = mod.default;
    if (config.globalSetup !== undefined) fail('playwright config backstop left globalSetup enabled in gate mode');
    if (config.webServer !== undefined) fail('playwright config backstop left webServer enabled in gate mode');
    if (JSON.stringify(config.testMatch) !== JSON.stringify(['**/gate.spec.js'])) {
      fail(`playwright config backstop did not pin gate testMatch: ${JSON.stringify(config.testMatch)}`);
    }
    if (config.projects?.some((project) => project.name === 'evil')) {
      fail('playwright config backstop left override projects enabled in gate mode');
    }
    if (existsSync(globalSetupSideEffect)) {
      fail('playwrightOverrides.globalSetup side effect file was created during config backstop');
    }
    process.stdout.write('gate inert validation: playwright config backstop pinned\n');
  } finally {
    restoreEnv(previousEnv);
  }
}

function gateArgs() {
  return {
    command: 'run',
    smoke: false,
    release: false,
    links: false,
    visual: false,
    gate: true,
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
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    fail(`missing gate manifest at ${manifestPath}`);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function failResult(name, result, message) {
  fail(
    `${name}: ${message}\n` +
      `stdout:\n${result.stdout || '(empty)'}\n` +
      `stderr:\n${result.stderr || '(empty)'}\n`
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function isPathInsideOrEqual(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createFixtureServer(root) {
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const filePath = path.resolve(root, rel);
      if (!isPathInsideOrEqual(filePath, root)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(filePath) });
      res.end(readFileSync(filePath));
    } catch (err) {
      res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
}

async function startFixtureServer(root, port) {
  const child = spawn(
    process.execPath,
    [__filename, '--serve', '--root', path.resolve(root), '--port', String(port)],
    {
      cwd: ciDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    }
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await waitForHttp(`http://127.0.0.1:${port}/`, child, () => stderr);
  return child;
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (server.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (server.exitCode === null) server.kill('SIGKILL');
    }, 2_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    server.kill('SIGTERM');
  });
}

function restoreEnv(previousEnv) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function captureProcessStderr(fn) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, encoding, callback) => {
    captured += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    return { value: await fn(), stderr: captured };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

async function waitForHttp(url, child, readStderr) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) {
      fail(`fixture server exited before readiness (exit ${child.exitCode}):\n${readStderr() || '(empty stderr)'}`);
    }
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      // Keep polling until the child has bound the port.
    }
    await delay(100);
  }
  fail(`fixture server did not become ready at ${url}:\n${readStderr() || '(empty stderr)'}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error('failed to allocate a local port'));
      });
    });
    server.on('error', reject);
  });
}
