import { test, chromium } from '@playwright/test';
import { loadPreflightConfig } from './_helpers.js';

const cfg = loadPreflightConfig();
const isRelease = process.env.PREFLIGHT_RELEASE === '1';

/**
 * Lighthouse perf / a11y / best-practices / seo budgets.
 *
 * Why this spec launches its OWN browser instead of using the
 * Playwright `page` fixture:
 *   playwright-lighthouse needs Chromium with `--remote-debugging-port`
 *   open so the Lighthouse runner can connect via CDP. Playwright's
 *   default browser launch does not expose that port. Spawning a
 *   dedicated browser per audit is cheaper than reconfiguring the
 *   shared fixture and keeps the audit hermetic.
 *
 * Why a single project rather than the engine x viewport matrix:
 *   Lighthouse only supports Chromium-family browsers. Running it
 *   across every project would produce identical scores at most
 *   viewports (Lighthouse uses its own emulation) or hard errors on
 *   firefox/webkit. Pin to one project.
 *
 * Why thresholds default to 75/95/85/90 and not 100:
 *   Real-world apps rarely hit 100 on perf without aggressive
 *   optimisation; treating 75 as the floor catches regressions
 *   without breaking the build on day one. Consumers can override
 *   via `lighthouseThresholds` in preflight.config.ts.
 */

const SUPPORTED_PROJECT = 'chromium__desktop-1280';

const defaultThresholds = {
  performance: 75,
  accessibility: 95,
  'best-practices': 85,
  seo: 90,
};

// Merge per-category so the consumer can override one threshold without
// having to restate the others.
const thresholds = { ...defaultThresholds, ...(cfg.lighthouseThresholds ?? {}) };

async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('failed to allocate free port'));
      }
    });
  });
}

if (!isRelease) {
  test.describe('lighthouse', () => {
    test.skip(true, '--release not set; skipping Lighthouse spec.');
    test('release-gated', () => {});
  });
} else {
  test.describe.configure({ mode: 'serial', retries: 0 });

  test.describe('lighthouse', () => {
    for (const route of cfg.routes) {
      test(`budgets on ${route.name} (${route.path})`, async (_args, testInfo) => {
        test.skip(
          testInfo.project.name !== SUPPORTED_PROJECT,
          `Lighthouse spec only runs on project "${SUPPORTED_PROJECT}" (Chromium-only).`
        );
        testInfo.setTimeout(180_000);

        let playAudit: typeof import('playwright-lighthouse').playAudit | undefined;
        try {
          const mod = await import('playwright-lighthouse');
          playAudit = mod.playAudit;
        } catch (err) {
          test.skip(
            true,
            `playwright-lighthouse is not installed: ${
              err instanceof Error ? err.message : String(err)
            }. Run \`npm i -D playwright-lighthouse lighthouse\` in your project.`
          );
          return;
        }

        const port = await findFreePort();
        const browser = await chromium.launch({
          args: [`--remote-debugging-port=${port}`],
        });
        try {
          const page = await browser.newPage({
            baseURL: cfg.baseURL,
            locale: cfg.locale,
            timezoneId: cfg.timezoneId,
          });
          await page.goto(route.path, { waitUntil: 'domcontentloaded' });
          if (cfg.readyMarker) {
            await page.waitForSelector(cfg.readyMarker, {
              state: 'attached',
              timeout: 30_000,
            });
          }

          await playAudit!({
            page,
            port,
            thresholds,
            // Suppress chalk-coloured noise in Playwright's reporter output
            // — failures are still surfaced via the playAudit throw.
            disableLogs: true,
          });
        } finally {
          await browser.close();
        }
      });
    }
  });
}
