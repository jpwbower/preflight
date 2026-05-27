import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadPreflightConfig } from './_helpers.js';

const cfg = loadPreflightConfig();

const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
];

const isSmoke = process.env.PREFLIGHT_SMOKE === '1';

test.describe('a11y (axe-core, WCAG 2.0/2.1/2.2 A+AA)', () => {
  for (const route of cfg.routes) {
    test(`axe ${route.name} (${route.path})`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      if (cfg.readyMarker) {
        await page.waitForSelector(cfg.readyMarker, { state: 'attached', timeout: 30_000 });
      }

      const disabledRuleNames = cfg.axeDisabled.map((d) => d.rule);

      let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
      if (disabledRuleNames.length > 0) {
        builder = builder.disableRules(disabledRuleNames);
      }

      const results = await builder.analyze();

      // Split known-noisy color-contrast hits on background-image elements
      // into a separate bucket. At smoke level we report-but-don't-fail —
      // axe routinely false-positives here because it can't sample the
      // actual pixel under the text.
      const colorContrastOverImage: typeof results.violations = [];
      const realViolations: typeof results.violations = [];

      for (const v of results.violations) {
        if (v.id !== 'color-contrast') {
          realViolations.push(v);
          continue;
        }
        const nodesOverImage = v.nodes.filter((n) =>
          n.any.some(
            (chk) =>
              chk.id === 'color-contrast' &&
              chk.data &&
              typeof chk.data === 'object' &&
              // axe surfaces `bgColor: null` (cannot determine) when the
              // background is an image or gradient.
              (chk.data as Record<string, unknown>).bgColor === null
          )
        );
        if (nodesOverImage.length > 0 && nodesOverImage.length === v.nodes.length && isSmoke) {
          colorContrastOverImage.push(v);
        } else {
          realViolations.push(v);
        }
      }

      if (colorContrastOverImage.length > 0) {
        const summary = colorContrastOverImage
          .flatMap((v) => v.nodes.map((n) => `  - ${n.target.join(' ')}`))
          .join('\n');
        // Use test.info().annotations so the report shows the soft-warning.
        test.info().annotations.push({
          type: 'preflight-warn',
          description: `color-contrast over background-image (logged, not failing):\n${summary}`,
        });
      }

      const message = realViolations
        .map(
          (v) =>
            `${v.id} (${v.impact ?? 'n/a'}): ${v.help}\n${v.nodes
              .map((n) => `    target: ${n.target.join(' ')}`)
              .join('\n')}`
        )
        .join('\n');

      expect(
        realViolations,
        `axe violations on ${route.path}:\n${message || '(none)'}`
      ).toEqual([]);
    });
  }
});
