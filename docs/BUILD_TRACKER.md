<!-- preflight-build-tracker schema v1 -->
# preflight — build tracker

This file is the cross-thread handoff mechanism. Every chunk reads it on
entry to discover its work; every chunk updates it on close. Do not
delete prior chunk rows — append to "Chunks complete".

## Current state

- Version shipped: v0.2.0
- Tag pushed: yes
- Branch: main
- HEAD SHA at last close: ea0d438eb2685b309118e4bd94596b6ffd336dea (pre-tag; tag commit is the next SHA)
- Node version exercised: 24.14.0 (Node 22 LTS is the pinned floor; operator dev box on 24)
- npm version exercised: 11.9.0
- Playwright version exercised: 1.60.0 (peerDep pinned to ^1.50.0)
- Lighthouse version exercised: 13.3.0 (via playwright-lighthouse 4.0.0)
- Guidepup versions exercised: @guidepup/guidepup 0.24.1, @guidepup/playwright 0.15.0, @guidepup/setup 0.21.0
- html-validate version exercised: 11.4.0
- lychee version exercised: 0.24.2 (binary install from GitHub release)
- Guidepup setup script run? (Chunk 2): YES — `node node_modules/@guidepup/setup/bin/setup` succeeded on the operator dev box (Windows 11 Pro). HKCU\Software\Guidepup\Nvda registered; Guidepup-NVDA build 0.1.3-2021.3.1 unpacked into a `%TEMP%\guidepup_nvda_*\nvda-0.1.3-2021.3.1\nvda` directory. No UAC, no SmartScreen, no Defender block — `@guidepup/setup` does NOT run an MSI installer (zip download + HKCU writes + explorer.exe restart only).

## Chunks complete

| Chunk | Version | Scope | Commit range | HEAD SHA | Tag |
| ----- | ------- | ----- | ------------ | -------- | --- |
| 1 | v0.1.0 | Scaffold: package, types, defineConfig, Playwright matrix, smoke / a11y / keyboard / emulated-media / virtual-sr specs, CLI entry, init template, full README, R5 remediation of Opus review findings | root..v0.1.0 | e61f49e (+ tag commit) | v0.1.0 |
| 2 | v0.2.0 | --release cadence (nvda, lighthouse, html-validate); --links cadence (lychee shellout); preflight init --ci (GHA workflow template); lighthouseThresholds config field; unified summary.json schema across cadences with `cadence` discriminator; project-level testIgnore for release-only specs + workers:1 on release for NVDA foreground-app safety; R5 remediation (version bump, lychee streaming, NVDA lazy import, GHA template lychee-action@v2, defensive guidepup-setup check) | v0.1.0..v0.2.0 | ea0d438 (+ tag commit) | v0.2.0 |

## Chunks remaining

| Chunk | Version target | Scope | Risk notes |
| ----- | -------------- | ----- | ---------- |
| 3 | v0.3.0 (or later) | Visual regression via Playwright `toHaveScreenshot()`; auth helpers (`storageState` lifecycle, expiry handling); real network throttling exposed via config; per-route `lighthouseThresholds`; broader project-level gating refactor (extend the v0.2 testIgnore pattern to allow consumers to register their own release-only specs); macOS VoiceOver support (Guidepup already exposes it; preflight has not wired the path yet) | Visual regression on Windows trips ClearType subpixel hinting flake across minor Windows updates — document the escape hatch (Playwright's `snapshotPathTemplate` encoding the Windows build, or `maxDiffPixelRatio`) BEFORE shipping baselines. macOS support needs a Mac dev box; operator does not currently have one wired into the validation loop. |

## Operator-decide carry-forwards

- None at end of Chunk 2. (Guidepup setup ran clean on the operator dev box; no operator action required.)

## Known issues / deferred fixes

Carried forward from Chunk 1 (still applicable):

- **Validation against `https://example.com` is thin.** example.com has no
  forms, no SPA routing, and a minimal heading hierarchy. The Chunk 1
  + Chunk 2 validation proves "the framework launches end-to-end and
  emits the expected artefacts under `.preflight/last-run/`", NOT
  "the specs catch real bugs on real sites". A consumer running
  preflight against their own dev server is the first time the specs
  are stressed against a non-trivial DOM.
- **`npx playwright install` size + network.** ~650 MB download from
  Playwright's CDN. Cold install on Windows with Defender Real-time
  Protection enabled is slow. Documented in README.
- **Symlink creation in `.preflight/last-run/`.** Non-elevated Windows
  without Developer Mode cannot symlink — preflight falls back to a
  tiny HTML redirect so the path still resolves.
- **The viewport projects multiply quickly.** 3 engines × 5 viewports
  × N specs × M routes. `--smoke` exists for this reason.
- **`a11y` color-contrast soft-fail logic is heuristic.** Treats
  `bgColor: null` from axe's payload as "background is an image".
- **Firefox does not support mobile / touch emulation.** preflight
  strips `isMobile`, `hasTouch`, `deviceScaleFactor` for Firefox
  projects; viewport size still varies.
- **virtual-sr is structural, not behavioural.** In-page
  accessible-name sweep, not a real screen reader (NVDA covers that
  on --release; VoiceOver still pending).

New in Chunk 2:

- **`--release` is single-threaded under `workers: 1`** because NVDA
  owns the foreground app and any parallel browser launch on the
  same Windows session breaks NVDA's keyboard-hook capture mid-test
  with `Cannot read properties of null (reading 'sendKeyCode')`.
  Wallclock against example.com is 3.7 min for 153 tests (138
  passed, 15 skipped); a larger consumer suite will scale linearly.
  An alternative would be running the release specs in a separate
  Playwright invocation from the rest of the suite, but that breaks
  the single-summary.json shape; deferred.
- **Lighthouse defaults are tuned for a "ship-gate" use case, not
  for arbitrary public URLs.** example.com fails performance/SEO/
  best-practices with the perf:75 a11y:95 best-practices:85 seo:90
  defaults because it has no meta description, no robots.txt, no JS
  to measure for performance signals. Consumers MUST tune
  `lighthouseThresholds` to their own site. The Chunk 2 validation
  passed only because the scratch config explicitly forgave the
  thresholds; the published defaults are unchanged.
- **NVDA's `spokenPhraseLog()` returns empty strings on the
  operator's dev box.** Guidepup's silent speech-synth driver
  doesn't capture phrase text on this host. The spec's "soft
  assertion" approach (capture phrases as artefact, don't assert on
  content) handles this — but it means the spec's *signal value* is
  "NVDA started + walked routes without throwing", not "NVDA
  produced meaningful announcements". Real consumer hosts with
  visible NVDA may capture real text; if so, the artefact at
  `.preflight/last-run/nvda-spoken-phrases.json` is informative.
- **Guidepup's NVDA build lives in `%TEMP%`.** Windows Storage Sense
  can wipe it, leaving a stale HKCU pointer. Re-run
  `node node_modules/@guidepup/setup/bin/setup` to recover. We
  considered moving it to `%LOCALAPPDATA%` but that's a Guidepup
  upstream decision, not preflight's.
- **lychee version skew is silent until the CLI rejects an
  argument.** preflight passes `--no-progress`, `--max-concurrency`,
  `--timeout`. These have been stable since lychee 0.13ish; older
  lychees may fail with "unknown argument". The README install
  pointer at https://lychee.cli.rs/installation/ implies a recent
  version. A minimum-version check at runtime is deferred to v0.3.
- **html-validate runs against `page.content()` (post-hydration DOM)
  only.** SSR-specific markup bugs that the client repairs at
  hydration are invisible to this spec. A second-pass raw-response
  validation behind a config flag is deferred to v0.3.
- **Reviewer-flagged free-port TOCTOU race in lighthouse.spec.ts.**
  Window between `server.close()` and `chromium.launch()` is tiny;
  release runs are serial under workers:1; if a consumer hits it
  repeatedly they can fix-pin via `PREFLIGHT_LIGHTHOUSE_PORT`.

## Notes for the next chunk (v0.3)

When picking up Chunk 3:

1. Read this file's `Current state` to confirm v0.2.0 actually shipped
   (tag pushed, HEAD SHA matches GitHub).
2. Read the spec for Chunk 3 in the user's brief.
3. Visual regression has the same Windows-flake risk as the
   ClearType subpixel hinting gotcha already documented — design the
   escape hatch FIRST before generating baselines, otherwise the
   first Windows Update after baselines land will turn every visual
   test red.
4. macOS VoiceOver path: Guidepup exposes `voiceOverTest` mirroring
   `nvdaTest`; the v0.2 nvda.spec.ts shape (lazy import behind
   platform gate + project-level testIgnore + soft assertion on
   phrase content) is the template.
5. Run the same two purity grep tests at chunk close.
