import { test, expect } from '@playwright/test';
import { loadPreflightConfig } from './_helpers.js';

const cfg = loadPreflightConfig();
const isRelease = process.env.PREFLIGHT_RELEASE === '1';

/**
 * Strict HTML validation via html-validate.
 *
 * Why --release-gated:
 *   html-validate is strict — modern frameworks ship a non-trivial
 *   number of "harmless" violations (e.g. `<div role="button">`
 *   without tabindex, `<a>` wrapping interactive content). Running it
 *   on every push would block work; running it pre-release once is
 *   the right cadence to catch genuine markup bugs.
 *
 * Why this captures `page.content()` instead of the raw response body:
 *   `page.content()` returns the post-hydration outerHTML, which is
 *   what users (and assistive tech) actually see. The raw response
 *   body is the SSR / static markup, which misses client-rendered
 *   problems entirely.
 *
 * Why a single project (not the engine x viewport matrix):
 *   The validated HTML is the post-hydration DOM, which is largely
 *   engine-agnostic and viewport-irrelevant for markup correctness.
 *   Running across the full matrix multiplies wallclock with zero
 *   new signal.
 *
 * Consumer config: drop an `.htmlvalidate.json` in your project root
 * to override rule defaults — html-validate auto-discovers it from
 * the consumer CWD.
 */

const SUPPORTED_PROJECT = 'chromium__desktop-1280';

if (!isRelease) {
  test.describe('html-validate', () => {
    test.skip(true, '--release not set; skipping html-validate spec.');
    test('release-gated', () => {});
  });
} else {
  test.describe('html-validate', () => {
    for (const route of cfg.routes) {
      test(`markup on ${route.name} (${route.path})`, async ({ page }, testInfo) => {
        test.skip(
          testInfo.project.name !== SUPPORTED_PROJECT,
          `html-validate spec only runs on project "${SUPPORTED_PROJECT}" (HTML is engine-agnostic).`
        );
        testInfo.setTimeout(60_000);

        type ValidateMessage = {
          ruleId: string;
          severity: number;
          message: string;
          line: number;
          column: number;
        };
        type ValidateReport = {
          valid: boolean;
          errorCount: number;
          warningCount: number;
          results: { messages: ValidateMessage[] }[];
        };

        let HtmlValidate:
          | (new (config?: unknown) => {
              validateString: (s: string) => Promise<ValidateReport>;
            })
          | undefined;
        try {
          const mod = await import('html-validate');
          HtmlValidate = mod.HtmlValidate as typeof HtmlValidate;
        } catch (err) {
          test.skip(
            true,
            `html-validate is not installed: ${
              err instanceof Error ? err.message : String(err)
            }. Run \`npm i -D html-validate\` in your project.`
          );
          return;
        }

        await page.goto(route.path, { waitUntil: 'domcontentloaded' });
        if (cfg.readyMarker) {
          await page.waitForSelector(cfg.readyMarker, {
            state: 'attached',
            timeout: 30_000,
          });
        }
        const html = await page.content();

        // No `config` argument — let html-validate auto-discover the
        // consumer's `.htmlvalidate.json` from their project root,
        // falling back to its own `recommended` preset.
        const validator = new HtmlValidate!();
        const report = await validator.validateString(html);

        if (!report.valid) {
          const errors = report.results
            .flatMap((r) => r.messages)
            .filter((m) => m.severity === 2)
            .map((m) => `  [${m.ruleId}] ${m.line}:${m.column} ${m.message}`)
            .join('\n');
          expect(
            report.errorCount,
            `html-validate found ${report.errorCount} error(s) on ${route.path}:\n${errors}\n` +
              'See https://html-validate.org/rules/ for rule docs. ' +
              'Drop an .htmlvalidate.json in your project root to tune rule severity.'
          ).toBe(0);
        }
      });
    }
  });
}
