import { test, expect } from '@playwright/test';
import { virtual } from '@guidepup/virtual-screen-reader';
import { loadPreflightConfig } from './_helpers.js';

const cfg = loadPreflightConfig();
const route = cfg.routes[0]!;

/**
 * Virtual screen reader sanity sweep.
 *
 * @guidepup/virtual-screen-reader does NOT drive a real assistive
 * technology — it walks Playwright's accessibility tree using the same
 * traversal rules as a real SR. That makes it useful for catching
 * structural a11y bugs (a button with no name, a region with no label,
 * an image with no alt) without the OS/native-binary setup cost of
 * NVDA/JAWS/VoiceOver. Real NVDA arrives in v0.2 via Guidepup proper.
 *
 * We capture the first ~30 stops of the SR walk. The assertion floor is
 * intentionally low: every announcement must be non-empty. If a stop
 * comes back as `""`, an interactive element is being read as silent —
 * which is what we want to catch.
 */
test.describe('virtual screen reader', () => {
  test(`SR walk on ${route.name}`, async ({ page }) => {
    await page.goto(route.path, { waitUntil: 'domcontentloaded' });
    if (cfg.readyMarker) await page.waitForSelector(cfg.readyMarker, { state: 'attached', timeout: 30_000 });

    await virtual.start({ container: await page.locator('body').elementHandle() as never });

    const announcements: string[] = [];
    try {
      for (let i = 0; i < 30; i++) {
        await virtual.next();
        const text = await virtual.lastSpokenPhrase();
        announcements.push(text);
        // Stop if we've cycled (last few stops are identical).
        if (
          announcements.length >= 4 &&
          announcements[announcements.length - 1] === announcements[announcements.length - 2] &&
          announcements[announcements.length - 2] === announcements[announcements.length - 3]
        ) {
          break;
        }
      }
    } finally {
      await virtual.stop();
    }

    expect(
      announcements.length,
      'virtual SR produced no announcements — accessibility tree may be empty'
    ).toBeGreaterThan(0);

    const silentStops = announcements
      .map((text, i) => ({ text, i }))
      .filter(({ text }) => text.trim() === '');

    expect(
      silentStops,
      `${silentStops.length} silent SR stop(s) on ${route.path}. ` +
        'A silent stop means an interactive element is being read with no name — ' +
        'add an accessible name (aria-label, aria-labelledby, or visible text).'
    ).toEqual([]);
  });
});
