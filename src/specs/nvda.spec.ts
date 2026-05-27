import { test as plainTest } from '@playwright/test';
import { nvdaTest } from '@guidepup/playwright';
import { loadPreflightConfig } from './_helpers.js';

const cfg = loadPreflightConfig();
const isRelease = process.env.PREFLIGHT_RELEASE === '1';
const isWindows = process.platform === 'win32';

/**
 * Real NVDA smoke (Windows-only, --release-only).
 *
 * Why a single test that loops over routes instead of one test per route:
 *   NVDA is a foreground-app screen reader. Two NVDA processes cannot
 *   coexist on the same Windows session, and the Playwright/Guidepup
 *   fixture is per-test — so multiple `nvdaTest()` blocks would attempt
 *   to start a fresh NVDA per test and race each other on the kernel
 *   keyboard hooks. One long-lived session per file is the only safe
 *   shape. If you need broader NVDA coverage, add additional .spec
 *   files; do not split this one into multiple tests.
 *
 * Why a single project (chromium + first viewport) instead of the full
 * engine x viewport matrix:
 *   The whole matrix would try to run NVDA in parallel against three
 *   engines and five viewports — same kernel-hook race. We pin to
 *   chromium because Guidepup's NVDA bindings are stable there;
 *   firefox/webkit are not validated upstream.
 */

const SUPPORTED_PROJECT = 'chromium__desktop-1280';

if (!isRelease) {
  // We still need a test entry so Playwright doesn't error "no tests
  // discovered". A skipped placeholder makes the gating visible in
  // the report.
  plainTest.describe('nvda (real screen reader)', () => {
    plainTest.skip(true, '--release not set; skipping NVDA spec.');
    plainTest('release-gated', () => {});
  });
} else if (!isWindows) {
  plainTest.describe('nvda (real screen reader)', () => {
    plainTest.skip(true, `NVDA is Windows-only; current platform: ${process.platform}.`);
    plainTest('windows-only', () => {});
  });
} else {
  nvdaTest.describe.configure({ mode: 'serial', retries: 0 });

  nvdaTest.describe('nvda (real screen reader)', () => {
    nvdaTest(
      `accessible-name announcements across ${cfg.routes.length} route(s)`,
      async ({ page, nvda }, testInfo) => {
        // Skip non-supported projects from inside the test body —
        // `test.skip(callback)` does not receive `testInfo`, so we
        // can't gate at describe-level.
        nvdaTest.skip(
          testInfo.project.name !== SUPPORTED_PROJECT,
          `NVDA spec only runs on project "${SUPPORTED_PROJECT}" to avoid parallel-session races.`
        );

        // Generous wallclock: NVDA startup is ~5s, each navigation +
        // settle is ~2s, plus announcement capture. Tune via the
        // consumer's playwrightOverrides.timeout if needed.
        testInfo.setTimeout(120_000);

        const allAnnouncements: { route: string; phrases: string[] }[] = [];

        for (const route of cfg.routes) {
          await page.goto(route.path, { waitUntil: 'domcontentloaded' });
          if (cfg.readyMarker) {
            await page.waitForSelector(cfg.readyMarker, {
              state: 'attached',
              timeout: 30_000,
            });
          }

          // Reset NVDA's announcement log before walking this route so
          // we can attribute output cleanly.
          await nvda.navigateToWebContent();

          // Walk forward through the first ~25 stops. We don't assert
          // a specific tree shape because real-world DOMs vary wildly;
          // the value here is catching pages where NVDA produces NO
          // announcements at all (broken aria, hidden subtree, etc.).
          for (let i = 0; i < 25; i++) {
            await nvda.next();
          }

          const log = await nvda.spokenPhraseLog();
          allAnnouncements.push({ route: route.name, phrases: log });
        }

        // Assertion: every route produced at least one non-empty
        // announcement. A route with zero spoken phrases means either
        // the page has no accessible content or NVDA failed to attach.
        const empty = allAnnouncements.filter(
          (r) => r.phrases.filter((p) => p.trim().length > 0).length === 0
        );
        if (empty.length > 0) {
          const report = empty.map((r) => `  ${r.route}`).join('\n');
          throw new Error(
            `NVDA produced no spoken phrases for ${empty.length} route(s):\n${report}\n` +
              'This usually means the page has no announceable content, or NVDA failed to attach to the browser. ' +
              'Re-run with --verbose and check `.preflight/last-run/` for the full Playwright trace.'
          );
        }
      }
    );
  });
}
