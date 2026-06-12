import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { AxeResults, Result, NodeResult } from 'axe-core';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyNetworkPreset, loadVantageConfig, isCi } from './_helpers.js';
import { DEFAULT_CONSOLE_IGNORE } from '../console-ignore-defaults.js';
import {
  sha256Hex,
  type GateAxeViolation,
  type GateRenderHealth,
  type GateRouteRecord,
} from '../gate/manifest.js';

/**
 * `--gate` capture spec.
 *
 * Flag-driven (VANTAGE_GATE=1 → testMatch routes only this spec; every
 * other cadence excludes it). The runner collapses the matrix to a SINGLE
 * project so each route is captured exactly once. For each route this spec:
 *
 *   1. Loads the route, recording HTTP status, console problems, uncaught
 *      page errors, and failed network requests (the render-health signal).
 *   2. Captures the post-hydration DOM (`page.content()`) + a full-page
 *      screenshot, and hashes each (DOM hash is load-bearing; the
 *      screenshot hash is provenance only — see gate/manifest.ts).
 *   3. Runs axe and records its full violation summary.
 *   4. Writes a per-route sidecar + artefact files into VANTAGE_GATE_DIR.
 *      The PARENT runner then assembles the ordered, deterministic
 *      gate-manifest.json from these sidecars.
 *
 * Gating policy (executed AFTER the sidecar is written, so an unhealthy
 * route is still recorded in the manifest):
 *   - Render-health ALWAYS gates: non-2xx, blank render, uncaught page
 *     error, console problem, or failed request fails the run.
 *   - axe (a11y) gates ONLY when cfg.gateA11yGating is true (customer
 *     surfaces). Internal surfaces record axe findings but do not fail.
 */

const cfg = loadVantageConfig();
const isGate = process.env.VANTAGE_GATE === '1';
const gateDir = process.env.VANTAGE_GATE_DIR;

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

if (!isGate) {
  test.describe('gate', () => {
    test.skip(true, '--gate not set; skipping gate-manifest spec.');
    test('gate-gated', () => {});
  });
} else {
  test.describe('gate (manifest capture)', () => {
    for (const [index, route] of cfg.routes.entries()) {
      test(`capture ${route.name} (${route.path})`, async ({ page }) => {
        if (!gateDir) {
          throw new Error(
            'vantage gate spec: VANTAGE_GATE_DIR is not set. The --gate cadence must be ' +
              'driven by `npx vantage --gate`, which provisions the capture directory.'
          );
        }

        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const failedRequests: string[] = [];

        // Gate self-defends the "no suppression" invariant in the spec itself,
        // not just upstream. The CLI + runner reject consumer consoleIgnore in
        // --gate, but a DIRECT child-process invocation could still inject a
        // suppression list via VANTAGE_CONFIG_JSON. So the gate render-health
        // floor uses ONLY vantage's runner-owned DEFAULT_CONSOLE_IGNORE (the
        // built-in noise filter), never the cfg-provided list.
        //
        // Hash note: this does NOT change the binding hash. On the normal path
        // the runner serialises DEFAULT_CONSOLE_IGNORE into the config this spec
        // receives anyway — it PREPENDS the default to the resolved
        // cfg.consoleIgnore (which is [] for an inert gate config) when building
        // VANTAGE_CONFIG_JSON (see runner.ts consoleIgnoreCombined). That
        // merge happens AFTER the gate backstop, which sees the resolved
        // cfg.consoleIgnore = [] and therefore does NOT reject a clean config.
        // So reading the default directly here yields the same effective list.
        const ignoreList = DEFAULT_CONSOLE_IGNORE;
        const shouldIgnore = (text: string): boolean => ignoreList.some((rx) => rx.test(text));

        page.on('console', (msg) => {
          const type = msg.type();
          // --ci escalates warnings to problems; otherwise only errors count.
          const isProblem = type === 'error' || (isCi() && type === 'warning');
          if (!isProblem) return;
          const text = msg.text();
          if (shouldIgnore(text)) return;
          consoleErrors.push(`[${type}] ${text}`);
        });
        page.on('pageerror', (err) => {
          const text = err.message || String(err);
          if (shouldIgnore(text)) return;
          pageErrors.push(text);
        });
        page.on('requestfailed', (req) => {
          const failure = req.failure();
          const url = req.url();
          if (shouldIgnore(url) || (failure && shouldIgnore(failure.errorText))) return;
          failedRequests.push(`${req.method()} ${url} :: ${failure?.errorText ?? 'unknown'}`);
        });
        // `requestfailed` only fires for network-level failures (DNS, refused,
        // aborted). A subresource (script/style/image/XHR/fetch/iframe) that
        // returns HTTP 4xx/5xx COMPLETES with a status and never fires
        // requestfailed — so without this it would pass the render-health floor.
        // Fold those into failedRequests too. The top-level document's status is
        // already enforced via `statusOk`, so skip the main-frame document
        // response to avoid double-reporting.
        page.on('response', (resp) => {
          const respStatus = resp.status();
          if (respStatus < 400) return;
          const req = resp.request();
          if (req.frame() === page.mainFrame() && req.resourceType() === 'document') return;
          const url = resp.url();
          if (shouldIgnore(url)) return;
          failedRequests.push(`${req.method()} ${url} :: HTTP ${respStatus}`);
        });

        await applyNetworkPreset(page, cfg);

        const response = await page.goto(route.path, { waitUntil: 'domcontentloaded' });
        const status = response ? response.status() : null;

        if (cfg.readyMarker) {
          await page.waitForSelector(cfg.readyMarker, { state: 'attached', timeout: 30_000 });
        }
        // Settle a beat so async console errors from late-hydrating scripts
        // surface before we snapshot + assert (mirrors smoke.spec).
        await page.waitForTimeout(250);

        // --- Capture (everything before any assertion, so the manifest
        //     records this route even when the render-health floor fails). ---
        const dom = await page.content();
        const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
        const domTextLength = bodyText.trim().length;
        const blank = domTextLength === 0;

        // animations + caret disabled to reduce non-deterministic pixels; the
        // screenshot is vision-review input, not the binding hash, so residual
        // ClearType flake does not destabilise the manifest.
        const png = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });

        // Gate records the UNMODIFIED axe signal: cfg.axeDisabled (a finding
        // suppression) is rejected upstream in --gate, and the spec ignores it
        // regardless so a direct invocation cannot disable rules. On the normal
        // path this is already empty, so the binding hash is unchanged.
        const disabledRuleNames: string[] = [];
        let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
        if (disabledRuleNames.length > 0) builder = builder.disableRules(disabledRuleNames);
        const axeResults: AxeResults = await builder.analyze();
        const axeViolations: GateAxeViolation[] = axeResults.violations.map((v: Result) => ({
          id: v.id,
          impact: v.impact ?? null,
          help: v.help,
          nodeTargets: v.nodes.map((n: NodeResult) => n.target.join(' ')),
        }));

        const statusOk = status !== null && status >= 200 && status < 300;
        const renderHealth: GateRenderHealth = {
          ok:
            statusOk &&
            !blank &&
            pageErrors.length === 0 &&
            consoleErrors.length === 0 &&
            failedRequests.length === 0,
          status,
          blank,
          domTextLength,
          pageErrors,
          consoleErrors,
          failedRequests,
        };

        const domFile = `gate-route-${index}.dom.html`;
        const screenshotFile = `gate-route-${index}.png`;
        await writeFile(path.join(gateDir, domFile), dom, 'utf8');
        await writeFile(path.join(gateDir, screenshotFile), png);

        const record: GateRouteRecord = {
          index,
          name: route.name,
          path: route.path,
          status,
          renderHealth,
          domSha256: sha256Hex(dom),
          // Paths are recorded relative to the last-run dir (gate/ is its child).
          domPath: `gate/${domFile}`,
          screenshotSha256: sha256Hex(png),
          screenshotPath: `gate/${screenshotFile}`,
          axe: { violationCount: axeViolations.length, violations: axeViolations },
        };
        await writeFile(
          path.join(gateDir, `gate-route-${index}.json`),
          JSON.stringify(record, null, 2),
          'utf8'
        );

        // --- Gating (after capture). ---
        // Render-health floor — universal, gates every audience.
        expect(status, `${route.path} returned HTTP ${String(status)} (expected 2xx)`).not.toBeNull();
        expect(statusOk, `${route.path} returned HTTP ${String(status)} (expected 2xx)`).toBe(true);
        expect(blank, `${route.path} rendered blank (body innerText was empty)`).toBe(false);
        expect(pageErrors, `uncaught page errors on ${route.path}`).toEqual([]);
        expect(consoleErrors, `console problems on ${route.path}`).toEqual([]);
        expect(failedRequests, `failed network requests on ${route.path}`).toEqual([]);

        // a11y floor — audience-toggled. Internal surfaces record axe but do
        // not gate; customer surfaces (gateA11yGating) fail on any violation.
        if (cfg.gateA11yGating) {
          const message = axeViolations
            .map(
              (v) =>
                `${v.id} (${v.impact ?? 'n/a'}): ${v.help}\n` +
                v.nodeTargets.map((t) => `    target: ${t}`).join('\n')
            )
            .join('\n');
          expect(
            axeViolations,
            `axe violations on ${route.path} (gateA11yGating=true):\n${message || '(none)'}`
          ).toEqual([]);
        }
      });
    }
  });
}
