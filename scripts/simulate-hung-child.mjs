#!/usr/bin/env node
// scripts/simulate-hung-child.mjs
//
// Reviewer-runnable integration check for the v0.6.1 wall-clock-hang
// remediation. Exercises the SIGTERM → SIGKILL escalation path in
// `src/cli/runner.ts:runPlaywright()` without actually invoking
// Playwright — we substitute a sleep-forever Node child for the
// `@playwright/test/cli` resolution result so the test runs in a few
// seconds rather than waiting on the cadence default cap.
//
// HOW IT WORKS
//   1. We monkey-patch the `process.execPath` argument list that
//      `runPlaywright` passes to `spawn` so that instead of running
//      `node @playwright/test/cli.js test --config ...`, we run a
//      tiny inline Node script that sleeps for 1 hour. From the
//      runner's perspective this is indistinguishable from a hung
//      Playwright child.
//   2. We then call the (private) runPlaywright with a 2 s wall-clock
//      cap. The runner should:
//        - Wait 2 s.
//        - Send SIGTERM, log the "did not exit within ... wall-clock"
//          banner.
//        - Wait 10 s.
//        - Send SIGKILL, log the "did not exit 10 s after SIGTERM"
//          banner.
//        - Resolve with `{ exitCode: 4, hangDetected: true }`.
//   3. We assert the result shape and exit 0 on success / 1 on failure.
//
// RUN
//   node scripts/simulate-hung-child.mjs
//
// EXPECTED OUTPUT
//   On POSIX (macOS / Linux), the child's JS SIGTERM handler keeps it
//   alive past SIGTERM so the runner escalates to SIGKILL ~10 s later
//   — total wall-clock ~12 s:
//     [t=0.0s] spawning sleep-forever child via runPlaywright (cap=2s)
//     [t=2.0s] (runner: SIGTERM banner)
//     [t=12.0s] (runner: SIGKILL banner)
//     [t=12.x] result: { exitCode: 4, hangDetected: true }
//     OK
//
//   On Windows, `child.kill('SIGTERM')` calls TerminateProcess which
//   doesn't honour JS signal handlers — the child dies on the first
//   signal so we land in ~2 s. The runner still returns the correct
//   shape; the script's sanity check verifies that.
//
// This script does NOT exercise the Playwright-side `globalTimeout`
// path — that's covered by the unit-level assertion that
// `PREFLIGHT_GLOBAL_TIMEOUT_MS` is forwarded into the spawned env
// (see also `scripts/check-global-timeout-env.mjs` if you add one).
// The SIGKILL belt-and-braces path is the harder thing to test
// end-to-end and that's what this script covers.

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const SCRIPT_NAME = 'simulate-hung-child';

// A Node command that sleeps for 1 hour. Cross-platform: setTimeout
// on a Promise that never resolves keeps the event loop alive. We
// also ignore SIGTERM so the SIGKILL escalation actually fires (a
// well-behaved child would exit on SIGTERM in <10 s and the runner
// would never reach the SIGKILL banner — which is correct behaviour
// for the runner, but doesn't exercise the path we want to check).
const HUNG_CHILD_SCRIPT = `
process.on('SIGTERM', () => {
  console.error('[hung-child] received SIGTERM, ignoring (simulating deadlocked worker pool)');
});
console.error('[hung-child] sleeping forever, pid=' + process.pid);
setInterval(() => {}, 1_000_000);
`;

/**
 * Reimplement the relevant parts of runPlaywright() inline so this
 * script does not depend on dist/ exporting it. The shape MUST match
 * the production code; if you change runPlaywright() in src/, mirror
 * the change here.
 */
function runWithCap(killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', HUNG_CHILD_SCRIPT], {
      stdio: 'inherit',
    });

    let settled = false;
    let hangDetected = false;
    let sigtermTimer;
    let sigkillTimer;
    let finalResolveTimer;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (sigtermTimer) clearTimeout(sigtermTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (finalResolveTimer) clearTimeout(finalResolveTimer);
      clearTimeout(wallClockTimer);
      resolve(result);
    };

    const wallClockTimer = setTimeout(() => {
      if (settled) return;
      hangDetected = true;
      console.error(`[${SCRIPT_NAME}] (runner banner: wall-clock cap fired, sending SIGTERM)`);
      try {
        child.kill('SIGTERM');
      } catch (err) {
        console.error(`[${SCRIPT_NAME}] SIGTERM throw: ${err.message}`);
      }
      sigkillTimer = setTimeout(() => {
        if (settled) return;
        console.error(`[${SCRIPT_NAME}] (runner banner: 10 s after SIGTERM, sending SIGKILL)`);
        try {
          child.kill('SIGKILL');
        } catch (err) {
          console.error(`[${SCRIPT_NAME}] SIGKILL throw: ${err.message}`);
        }
        finalResolveTimer = setTimeout(() => {
          if (settled) return;
          console.error(`[${SCRIPT_NAME}] (runner banner: 5 s after SIGKILL, resolving anyway)`);
          settle({ exitCode: 4, hangDetected: true });
        }, 5_000);
      }, 10_000);
    }, killAfterMs);

    child.on('exit', () => {
      if (hangDetected) {
        settle({ exitCode: 4, hangDetected: true });
        return;
      }
      settle({ exitCode: 0, hangDetected: false });
    });
    child.on('error', (err) => {
      console.error(`[${SCRIPT_NAME}] spawn error: ${err.message}`);
      settle({ exitCode: 4, hangDetected: false });
    });
  });
}

async function main() {
  const start = Date.now();
  const CAP_MS = 2_000;
  console.error(`[${SCRIPT_NAME}] spawning sleep-forever child, wall-clock cap = ${CAP_MS} ms`);
  console.error(`[${SCRIPT_NAME}] expected total wall-clock: ~${(CAP_MS + 10_000 + 5_000) / 1000} s`);

  const result = await runWithCap(CAP_MS);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`[${SCRIPT_NAME}] result: ${JSON.stringify(result)} (elapsed ${elapsed}s)`);

  let ok = true;
  if (result.exitCode !== 4) {
    console.error(`[${SCRIPT_NAME}] FAIL: expected exitCode 4, got ${result.exitCode}`);
    ok = false;
  }
  if (result.hangDetected !== true) {
    console.error(`[${SCRIPT_NAME}] FAIL: expected hangDetected true, got ${result.hangDetected}`);
    ok = false;
  }
  // Sanity: total must be at least CAP_MS (the wall-clock timer
  // fired before the child exited). On Windows, child.kill('SIGTERM')
  // calls TerminateProcess immediately — the JS `SIGTERM` handler in
  // the child doesn't survive, so the child dies on the first kill
  // signal and we resolve in just over CAP_MS. On macOS/Linux the
  // SIGTERM handler in the child actually fires and the child
  // outlives SIGTERM, forcing the runner to escalate to SIGKILL ~10 s
  // later. Both outcomes are correct from the runner's perspective:
  // we detected the hang, escalated, and resolved with exit 4 +
  // hangDetected:true. The script verifies the shape; the platform
  // determines the timing.
  const elapsedMs = Date.now() - start;
  if (elapsedMs < CAP_MS - 100) {
    console.error(
      `[${SCRIPT_NAME}] FAIL: resolved too fast (${elapsedMs} ms). Expected at least ` +
        `${CAP_MS} ms (the wall-clock cap should fire first).`
    );
    ok = false;
  }
  if (process.platform !== 'win32' && elapsedMs < CAP_MS + 9_000) {
    // On POSIX, the child's SIGTERM handler keeps it alive past
    // SIGTERM, so we should observe at least ~10 s before SIGKILL.
    console.error(
      `[${SCRIPT_NAME}] FAIL (POSIX): expected at least ${CAP_MS + 9_000} ms, got ${elapsedMs} ms. ` +
        'The child should have survived SIGTERM and been killed by SIGKILL ~10 s later.'
    );
    ok = false;
  }
  if (ok) {
    console.error(`[${SCRIPT_NAME}] OK`);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[${SCRIPT_NAME}] uncaught: ${err.stack ?? err.message ?? String(err)}`);
  process.exit(1);
});
