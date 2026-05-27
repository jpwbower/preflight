# preflight

Local-only web-assurance scaffolding for any web project.

`preflight` wires together [Playwright](https://playwright.dev/) and [axe-core](https://github.com/dequelabs/axe-core) into a single CLI you can drop into any web project. It runs against your own dev server (or any URL), produces inspection-ready artefacts under `.preflight/last-run/`, and asks for no SaaS account, no cloud credit, and no telemetry. The audience is any developer building a website who wants a base-level local browser-assurance harness without paying for a SaaS audit tool.

This is **scaffolding**, not magic. preflight catches a floor of common regressions (HTTP failures, console errors, axe violations, missing focus indicators, broken accessibility names, broken media emulations). It does not replace real-device QA, paid accessibility audits, or human review.

---

## Install

Pin to a tag, not floating `main`:

```sh
npm i -D github:<your-org>/preflight#v0.2.0
npx playwright install
```

The `npx playwright install` step downloads Chromium, Firefox, and WebKit (~650 MB total) from Playwright's CDN. On Windows 11, Defender Real-time Protection may scan during download; a corporate firewall may block CDN access. Run it once on a network that allows the download.

`tsx` is pulled in automatically so your `preflight.config.ts` is loaded without a separate build step.

### Optional v0.2 extras

The heavier `--release` and `--links` cadences need additional installs. They're devDeps in preflight itself but not auto-bundled — install whichever you actually run:

```sh
# For `preflight --release` (NVDA + Lighthouse + html-validate):
npm i -D @guidepup/guidepup @guidepup/playwright @guidepup/setup \
         lighthouse playwright-lighthouse html-validate

# For NVDA specifically (Windows only): also run setup ONCE per machine.
node node_modules/@guidepup/setup/bin/setup

# For `preflight --links` (lychee CLI — NOT an npm package):
#   macOS:    brew install lychee
#   Windows:  scoop install lychee   (or `cargo install lychee`)
#   Linux:    cargo install lychee   (or download from GitHub releases)
```

Each spec degrades gracefully — if its dep is missing or NVDA isn't set up, the spec skips with a clear message instead of crashing.

---

## Quick start

```sh
npx preflight init           # drops preflight.config.ts in your CWD
npx preflight init --ci      # additionally drops .github/workflows/preflight.yml
# edit baseURL, routes, webServer
npx preflight --smoke        # chromium-only mobile-375 smoke + a11y smoke
npx preflight                # full default suite (3 engines x 5 viewports x 5 specs)
npx preflight --release      # full + nvda (Windows) + lighthouse + html-validate
npx preflight --links        # lychee link checker (standalone)
npx preflight --visual       # visual regression on one project (opt-in cadence)
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
| NVDA screen reader                     | yes — on `--release`, Windows only (Guidepup) |
| Lighthouse perf/a11y/seo budgets       | yes — on `--release`, Chromium only |
| `html-validate` strict markup linting  | yes — on `--release` |
| Link checking (lychee)                 | yes — on `--links`, separate cadence |
| Visual regression (toHaveScreenshot)   | yes — on `--visual`, baselines consumer-managed |
| JAWS screen reader                     | NO — manual / paid audit |
| Authenticated routes                   | yes — `cfg.auth` storageState lifecycle (v0.3) |
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
| 3    | Environment error (preflight's `dist/` missing, or `@playwright/test` peer dep not installed) |
| 4    | Runtime error (uncaught throw in the preflight runner) |

`--ci` flips: console **warnings** escalate to failures alongside errors.

---

## CLI

```
preflight                       full default suite
preflight --smoke               chromium-only, mobile-375 viewport, smoke + a11y smoke
preflight --release             full + nvda + lighthouse + html-validate
preflight --links               lychee link check only (skips Playwright)
preflight --visual              visual regression on one project (skips other specs)
preflight init [--force]        drop a starter preflight.config.ts
preflight init --ci             additionally drop .github/workflows/preflight.yml
preflight list                  print the engine x viewport x spec matrix; do not run
preflight teardown              run cfg.auth.teardown + delete cached storageState
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
preflight --no-auth             skip cfg.auth.setup even if configured
```

### Cadence

The four cadences exist so each test pays its wallclock cost at the right moment:

| Flag           | When to run            | Wallclock target | Covers |
| -------------- | ---------------------- | ---------------- | ------ |
| `--smoke`      | every push             | < 60 s           | smoke + a11y smoke, chromium + mobile-375 only |
| (default)      | PR open / push to main | 1–5 min          | full engine x viewport matrix of v0.1 specs |
| `--release`    | pre-tag, before publish | 5–20 min         | full + NVDA (Windows) + Lighthouse (Chromium) + html-validate |
| `--links`      | nightly cron           | depends on site  | lychee against the configured routes; no browser launch |
| `--visual`     | opt-in (consumer choice) | depends on site | toHaveScreenshot per route on one project; baselines consumer-managed |

---

## Gotchas

These are the rough edges to know about before you wire preflight into CI.

### v0.3 additions

- **Authenticated routes via `cfg.auth`.** Set `cfg.auth.setup` to a path
  pointing at a JS/TS module that returns a Playwright `storageState`
  object (cookies + localStorage). preflight imports it, calls its
  default export, persists the result to
  `.preflight/auth/storageState.json` (override via
  `cfg.auth.storageStatePath`), and wires the cached state into every
  Playwright project's `use.storageState`. The setup module is invoked
  ONCE per run unless the cached file is older than
  `cfg.auth.expirySeconds`.

  ```ts
  // preflight.config.ts
  export default defineConfig({
    baseURL: 'http://127.0.0.1:3000',
    routes: [{ name: 'dashboard', path: '/dashboard' }],
    webServer: { command: 'npm run dev', url: 'http://127.0.0.1:3000' },
    auth: {
      setup: './preflight.auth.ts',
      teardown: './preflight.auth.teardown.ts',  // optional
      storageStatePath: '.preflight/auth/storageState.json',  // default
      expirySeconds: 3600,  // re-run setup after one hour
    },
  });
  ```

  ```ts
  // preflight.auth.ts — consumer-authored
  import { chromium } from '@playwright/test';
  export default async function setupAuth() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:3000/login');
    await page.fill('#email', process.env.TEST_USER!);
    await page.fill('#password', process.env.TEST_PASS!);
    await page.click('button[type=submit]');
    await page.waitForURL('**/dashboard');
    const state = await page.context().storageState();
    await browser.close();
    return state;
  }
  ```

  Run `npx preflight teardown` to invoke `cfg.auth.teardown` (if set) and
  delete the cached state — useful after a test run leaves session
  cookies behind. `--no-auth` bypasses the setup for one run (useful for
  smoke-testing your unauthenticated landing route).

- **Visual regression baselines drift across Windows minor updates.** ClearType
  subpixel font hinting is recomputed when Windows updates the system font cache,
  which lands silently — a baseline captured on Windows 11 build 22631 will mismatch
  on 22635 even though no application code changed. preflight ships NO baselines and
  ships no opinion on where you store them, but it surfaces two Playwright escape
  hatches you should pick BEFORE running `--visual --update-snapshots` the first time:

  ```ts
  // preflight.config.ts
  import { defineConfig } from 'preflight';
  import os from 'node:os';

  // Encode the Windows build number into the snapshot path so each build
  // gets its own baseline tree. `os.release()` on Windows returns
  // "10.0.22631", which keys the snapshots to the kernel version.
  const osBuild = process.platform === 'win32' ? os.release() : process.platform;

  export default defineConfig({
    baseURL: 'http://127.0.0.1:3000',
    routes: [{ name: 'home', path: '/' }],
    webServer: { command: 'npm run dev', url: 'http://127.0.0.1:3000' },

    visualThreshold: 0.01, // tolerate 1% pixel drift per snapshot

    playwrightOverrides: {
      // Each Windows build (and each non-Windows platform) gets its own
      // baseline tree. The `{arg}` token is Playwright's snapshot name.
      snapshotPathTemplate: `__screenshots__/${osBuild}/{arg}{ext}`,
    },
  });
  ```

  Pick the level of tolerance you need: `visualThreshold` (a single 0..1 number
  passed to Playwright's `maxDiffPixelRatio`) is the cheap mass-tolerance knob;
  `snapshotPathTemplate` segregates baselines so a Windows update doesn't break
  every snapshot at once. Use both. Floor for `visualThreshold` is 0.01 — exact
  matching (0.0) WILL flake even between two consecutive runs on the same machine.

- **`--visual` runs ONLY the visual spec.** Other specs are excluded at config
  level, not skipped at runtime. This is intentional: visual regression is a
  separate cadence, not a default add-on, because baselines are a maintenance
  cost the consumer opts into. To capture or update baselines:

  ```sh
  npx preflight --visual --update-snapshots    # capture / overwrite baselines
  npx preflight --visual                       # compare against existing
  ```

  By default the visual spec runs on `chromium__desktop-1280` only. Override via
  `visualProject: 'firefox__tablet-768'` (must match a generated project name).

### v0.2 additions

- **`node node_modules/@guidepup/setup/bin/setup` is the first-run install for NVDA.** It downloads a custom NVDA build (~30 MB) from GitHub, writes `HKCU\Software\Guidepup\Nvda`, modifies `HKCU\Control Panel\Desktop\ForegroundLockTimeout`, and **kills + restarts `explorer.exe`** — your open File Explorer windows will close and the taskbar will blink. It does NOT trigger UAC, an MSI installer, or SmartScreen, but Windows Defender Real-time Protection will scan the download (expect a few seconds of AV CPU). On corporate machines, endpoint policy may quarantine the download silently — check Defender history if setup hangs or completes without registering the key. The downloaded binary lives in `%TEMP%\guidepup_nvda_*`; periodic Storage Sense cleanup can wipe it, leaving a stale registry path. Re-run setup if `preflight --release` complains that NVDA cannot launch.

- **`--release` runs the BUILT artefact, not the dev server.** Lighthouse perf scores against a `next dev` / `vite dev` server are meaningless (dev-mode bundling, HMR overhead, source maps inline). Configure your `webServer.command` to `npm run build && npm run start` (or equivalent) when running `--release`; wallclock will be longer but the budgets will reflect production. Consider a separate `preflight.release.config.ts` if your dev + prod commands diverge significantly — point `preflight --release --config=preflight.release.config.ts` at it.

- **ClearType subpixel font hinting on Windows still moves between minor updates.** v0.2 does NOT yet wire visual regression — that's deferred to v0.3 — but the warning stands for any consumer running their OWN `toHaveScreenshot()` baselines: a Windows Update can shift baselines by 1–2 pixels per glyph and break every snapshot. If you add visual regression today, set Playwright's `_ctx.snapshotPathTemplate` to encode the Windows build number, or accept tolerance via `maxDiffPixelRatio`.

- **Cadence discipline.** The four cadences shipped in v0.2 are deliberate — running `--release` on every push trains people to ignore failures. `--smoke` exists to give the per-push signal latency budget (< 60 s); the default suite belongs on PR open; `--release` belongs on the pre-tag job (so failures gate a publish, not a feature branch); `--links` is nightly because link-rot is a slow problem and lychee against a large site costs minutes. Don't merge them into a single mega-job.

- **`.preflight/last-run/` is the canonical artefact surface for CI consumption.** Wire your CI's "upload-artifact" step at `.preflight/last-run/` — every cadence writes there:
  - `summary.json` — pass/fail counts + config snapshot, machine-readable. This is what a CI dashboard should read.
  - `disabled-axe-rules.md` — loud list of every axe rule the consumer suppressed, with their justification. **This is the canonical "what got disabled and why" artefact, NOT the HTML report header.** A CI check that fails when this file's contents change is the cheapest way to catch silent rule additions.
  - `html-report/index.html` — Playwright's HTML report (full traces, screenshots, videos on failure).
  - `lychee-output.txt` — present only after `--links`; the raw lychee output for triage.

### v0.1 baseline

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

- **Disabled axe rules are written to `.preflight/last-run/disabled-axe-rules.md` on every run, with the consumer-supplied reason.** preflight refuses to load a config that disables an axe rule without a `reason` string — anti-compliance-theatre by design. Treat that file as a review artefact: a CI check that fails when its contents change is a cheap way to catch silent rule additions.

- **Firefox does not support mobile / touch emulation.** Playwright's Firefox build does not honour `isMobile`, `hasTouch`, or `deviceScaleFactor` on `newContext`. preflight still runs the Firefox engine at every viewport _size_ (so responsive CSS is exercised), but `firefox__mobile-*` projects use a desktop UA and no touch flag. For real mobile-Firefox QA, use a real device.

---

## What's coming in v0.4+

- macOS VoiceOver (Guidepup exposes the API; preflight has not wired the path yet — needs a Mac dev box in the validation loop)
- Real network throttling (Chromium CDP, exposed as a config knob)
- Consumer-registered release-only specs via project-level gating refactor

---

## What preflight does NOT cover

Honest list, not optimistic:

- Real iOS Safari behaviour (only Playwright WebKit, which is engine-close but not behaviour-identical).
- Real network throttling (synthetic Chromium CDP only, and not exposed via the config surface yet).
- Real Android Chrome with real GPU and real touch.
- Embedded webviews (Facebook in-app browser, Twitter card, etc.).
- JavaScript bundle-size budgets.
- Server-side rendering correctness beyond first paint.
- JAWS and VoiceOver (NVDA only — Guidepup supports VoiceOver but preflight has not wired the macOS path yet).

---

## Contributing / versioning

preflight follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). **Pin to a tag** (`#v0.1.0`) rather than floating `main`. Breaking changes happen at minor-version bumps pre-1.0.

Issues and PRs welcome at the repo. Run `npm install` then `npm run prepare` in a checkout to build `dist/`.

---

## License

[MIT](./LICENSE). Copyright © preflight contributors.
