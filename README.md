# preflight

Local-only web-assurance scaffolding for any web project.

`preflight` wires together [Playwright](https://playwright.dev/), [axe-core](https://github.com/dequelabs/axe-core), and [@guidepup/virtual-screen-reader](https://github.com/guidepup/virtual-screen-reader) into a single CLI you can drop into any web project. It runs against your own dev server (or any URL), produces inspection-ready artefacts under `.preflight/last-run/`, and asks for no SaaS account, no cloud credit, and no telemetry. The audience is any developer building a website who wants a base-level local browser-assurance harness without paying for a SaaS audit tool.

This is **scaffolding**, not magic. preflight catches a floor of common regressions (HTTP failures, console errors, axe violations, missing focus indicators, broken accessibility names, broken media emulations). It does not replace real-device QA, paid accessibility audits, or human review.

---

## Install

Pin to a tag, not floating `main`:

```sh
npm i -D github:<your-org>/preflight#v0.1.0
npx playwright install
```

The `npx playwright install` step downloads Chromium, Firefox, and WebKit (~650 MB total) from Playwright's CDN. On Windows 11, Defender Real-time Protection may scan during download; a corporate firewall may block CDN access. Run it once on a network that allows the download.

`tsx` is pulled in automatically so your `preflight.config.ts` is loaded without a separate build step.

---

## Quick start

```sh
npx preflight init        # drops preflight.config.ts in your CWD
# edit baseURL, routes, webServer
npx preflight --smoke     # chromium-only mobile-375 smoke + a11y smoke
npx preflight             # full default suite (3 engines x 5 viewports x 5 specs)
```

Every run writes to `.preflight/last-run/`:

```
.preflight/last-run/
├── html-report/index.html      # Playwright HTML report
├── results.json                # full Playwright JSON
├── junit.xml                   # (--ci) JUnit reporter
├── disabled-axe-rules.md       # loud list of any disabled axe rules
├── summary.json                # pass/fail counts + config snapshot
└── index.html                  # convenience redirect to the report
```

Add `.preflight/` to your `.gitignore`.

---

## Coverage

| Engine / behaviour                     | preflight covers? |
| -------------------------------------- | ----------------- |
| Chromium (Blink) latest                | yes — Playwright bundles it |
| Firefox (Gecko) latest                 | yes — Playwright bundles it |
| WebKit (Apple's engine)                | engine, not Safari behaviour — see below |
| iOS Safari real device                 | NO — manual checklist below |
| macOS Safari real device               | NO — manual smoke recommended |
| Android Chrome real GPU                | NO — Chromium engine only |
| Older browser versions                 | NO |
| NVDA screen reader                     | v0.2 |
| JAWS screen reader                     | NO — manual / paid audit |
| Authenticated routes                   | NO — v0.1 ships no auth helpers |
| Real network throttling                | NO — synthetic Chromium CDP only |
| Print stylesheets                      | yes |
| Reduced motion / dark mode             | yes (all engines) |
| Forced colours                         | yes (Chromium only) |
| Increased contrast                     | yes (Chromium + Firefox where supported) |

---

## iOS smoke checklist (manual, pre-launch)

preflight's WebKit project is engine-close, not behaviour-identical to iOS Safari. Run this on a real iPhone before launch:

1. Rotate device portrait↔landscape; layout does not break.
2. Open the on-screen keyboard on a form input; `100vh` does not get clipped behind it.
3. Scroll past the bottom (rubber-band); fixed-position elements do not drift.
4. Tap a button without `cursor: pointer`; verify tap feedback (`touch-action`, `-webkit-tap-highlight-color`).
5. Toggle Dark Mode in Settings; the site reacts within 1 s.
6. Open in Safari Private mode; no broken storage assumptions (no silent `localStorage` errors).
7. Print-preview a page (Share → Print); the print stylesheet is honoured.
8. Enable VoiceOver; focus order matches visual order; every interactive element announces a name.
9. Pinch-zoom in and out; text and tap targets remain usable.
10. Toggle Settings → Accessibility → Motion → Reduce Motion; animations are suppressed.

---

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0    | All checks passed |
| 1    | Test failure (assertion / smoke / a11y violation at fail-threshold) |
| 2    | Config error (your `preflight.config.ts` is invalid) |
| 3    | Environment error (Playwright browsers missing — run `npx playwright install`) |
| 4    | Runtime error (uncaught throw in the preflight runner) |

`--ci` flips: console **warnings** escalate to failures alongside errors.

---

## CLI

```
preflight                       full default suite
preflight init [--force]        drop a starter preflight.config.ts
preflight list                  print the engine x viewport x spec matrix; do not run
preflight --smoke               chromium-only, mobile-375 viewport, smoke + a11y smoke
preflight --list                alias for the `list` subcommand
preflight --only=<route>        scope to one configured route (matches route.name)
preflight --engine=<name>       chromium | firefox | webkit
preflight --headed              non-headless browsers (debugging)
preflight --debug               PWDEBUG=1 passthrough (Playwright Inspector)
preflight --verbose             verbose progress logs
preflight --update-snapshots    Playwright snapshot update passthrough
preflight --reporter=<name>     line | list | html | json | junit
preflight --config=<path>       override config discovery
preflight --ci                  strict defaults: html + junit reporters, fail on warnings, no reuseExistingServer
preflight --no-reuse            force a fresh webServer launch (debug stuck server)
```

---

## Gotchas (v0.1)

These are the rough edges to know about before you wire preflight into CI.

- **`storageState` reuse will break tests if you add authenticated routes later.** preflight ships clean-by-default config; if you add auth via a `globalSetup`, also add a `globalTeardown` that deletes any `storageState.json` before the next run. v0.1 does not ship auth helpers.

- **Gitignore `test-results/`, `playwright-report/`, and `.preflight/` in your consuming project.** Playwright traces are 5–50 MB per failure; they will bloat your repo otherwise. The starter `.gitignore` snippet:

  ```
  node_modules/
  test-results/
  playwright-report/
  .preflight/
  ```

- **ClearType subpixel font hinting on Windows** can drift between minor Windows updates. If you enable visual regression in v0.2, expect baseline flake — set `fontHinting: 'none'` or accept tolerance.

- **`webServer` port conflicts.** preflight launches your dev server via Playwright's webServer config. If a previous run left a dead server bound to the port, pass `--no-reuse` to force a fresh launch.

- **Console-error capture is noisy out of the box.** preflight ships a default ignore-list (analytics beacons blocked by adblockers, framework deprecation warnings, browser-extension chatter). Extend it via `consoleIgnore: [...]` in your config. The consumer list is **concatenated** with the defaults, never replaces them.

- **`networkidle` is unreliable** on modern sites — analytics and websockets keep the network busy forever. preflight uses `domcontentloaded` by default and supports an opt-in `[data-test-ready]` convention. If your app emits this selector when truly ready, set `readyMarker: '[data-test-ready]'` in your config.

- **axe `color-contrast` false positives on backgrounds with `background-image`.** axe cannot sample the actual pixel under the text on top of an image. preflight logs these as warnings at `--smoke` level rather than failing — manual review needed.

- **WebKit locale + timezone differ from your machine defaults.** preflight sets `en-GB` / `Europe/London` by default. Override `locale` and `timezoneId` in config if your audience is elsewhere.

- **Playwright WebKit on Windows + localhost IPv6.** Some Windows 11 configurations do not route WebKit's `localhost` to IPv4. If WebKit tests cannot connect but Chromium/Firefox work, force IPv4: `baseURL: 'http://127.0.0.1:<port>'`.

- **Disabled axe rules are logged loudly at the top of every report.** This is intentional anti-compliance-theatre. Do not silence the warning by editing the report — silence it by removing the suppression from your config.

---

## What's coming in v0.2

- Real NVDA via Guidepup
- Lighthouse perf + a11y + SEO budgets on `--release`
- `html-validate` on `--release`
- `lychee` link checker on `--links`
- GitHub Actions workflow template via `preflight init --ci`
- Optional visual regression via Playwright's `toHaveScreenshot()`
- Five more gotchas (NVDA + Windows Defender / UAC, font flake details, `--release` runs the built artefact, cadence discipline, `.preflight/last-run/` usage patterns)

---

## What preflight does NOT cover

Honest list, not optimistic:

- Real iOS Safari behaviour (only Playwright WebKit, which is engine-close but not behaviour-identical).
- Authenticated routes (no `storageState` helpers in v0.1).
- Real network throttling (synthetic Chromium CDP only, and not exposed in v0.1).
- Real Android Chrome with real GPU and real touch.
- Embedded webviews (Facebook in-app browser, Twitter card, etc.).
- JavaScript bundle-size budgets.
- Server-side rendering correctness beyond first paint.
- Visual regression (coming in v0.2).
- Real NVDA, JAWS, or VoiceOver (virtual SR only in v0.1; real NVDA in v0.2).

---

## Contributing / versioning

preflight follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). **Pin to a tag** (`#v0.1.0`) rather than floating `main`. Breaking changes happen at minor-version bumps pre-1.0.

Issues and PRs welcome at the repo. Run `npm install` then `npm run prepare` in a checkout to build `dist/`.

---

## License

[MIT](./LICENSE). Copyright © preflight contributors.
