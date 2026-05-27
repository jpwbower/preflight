# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0]

Adds the install-risk-surface features deferred from v0.1: real NVDA,
Lighthouse budgets, html-validate, lychee link-check, and a CI workflow
template. Two new cadences (`--release`, `--links`) keep the heavier
work off the per-push hot path.

### Added

- `--release` flag: runs the default suite PLUS real-NVDA (via Guidepup,
  Windows-only), Lighthouse perf/a11y/best-practices/seo budgets
  (Chromium-only), and html-validate strict markup linting. Each new
  spec gates itself on platform / engine / project so a single-shot
  `--release` does not multiply across the full engine x viewport matrix.
- `--links` flag: shells out to the lychee CLI for link checking,
  standalone (does not run Playwright at all). Respects a
  `lychee.toml` in the consumer project root.
- `preflight init --ci`: additionally drops a starter
  `.github/workflows/preflight.yml` covering all four cadences
  (smoke per-push, full on PR, release on tag, links nightly).
- `lighthouseThresholds` config field with documented defaults
  (perf 75, a11y 95, best-practices 85, seo 90). Per-category override.
- `scripts/setup-guidepup.ps1`: wrapper around `@guidepup/setup` for
  Windows hosts, with documented cold-install caveats and a fallback
  to the consumer's installed copy.
- Five new README gotchas: Guidepup cold-install surface area, dev vs.
  built-artefact for `--release`, ClearType subpixel hinting, cadence
  discipline, `.preflight/last-run/` as the canonical CI artefact path.

### Changed

- README: optional v0.2 extras install section; CLI table now
  includes `--release` / `--links` / `init --ci`; coverage matrix
  now lists NVDA / Lighthouse / html-validate / lychee as shipping;
  roadmap moved to v0.3.

### Known limitations

- Guidepup's downloaded NVDA build lives in `%TEMP%` — Storage Sense
  can wipe it, leaving a stale HKCU pointer. Re-run setup.
- Lighthouse spec launches its own browser (CDP requirement). It does
  not honour `playwrightOverrides` for browser launch args.
- html-validate runs against post-hydration HTML only; SSR-specific
  markup bugs that only appear on the raw response body are missed.
- lychee CLI is a separate install (not an npm package); preflight
  shells to it from PATH.

## [0.1.0]

Initial release. Local-only web-assurance scaffolding for any web project.

### Added

- `preflight` CLI (`bin/preflight.mjs`) with documented exit codes
  (0 OK, 1 test failure, 2 config error, 3 environment error, 4 runtime).
- `defineConfig({ ... })` helper with runtime schema validation:
  unknown top-level keys are rejected loudly so typos do not silently
  alter test runs.
- Playwright project matrix across three engines (Chromium, Firefox,
  WebKit) and five viewport profiles (mobile-320, mobile-375 = iPhone 13,
  tablet-768 = iPad gen 7, desktop-1280, desktop-1920).
- Default locale `en-GB` and timezone `Europe/London`, both overridable
  in consumer config.
- Spec suite: `smoke` (HTTP 2xx, console errors, page errors, failed
  requests), `a11y` (axe-core WCAG 2.0/2.1/2.2 A+AA),
  `keyboard` (Tab walk + focus-indicator), `emulated-media` (reduced
  motion, dark / light, prefers-contrast, forced-colors, print),
  `virtual-sr` (in-page accessible-name sweep — flags interactive
  elements with no name a screen reader could announce).
- Default console-error ignore-list: adblocker-blocked analytics,
  framework deprecation warnings, browser-extension noise. Consumer
  `consoleIgnore` is concatenated, never replaces.
- axe rule disable mechanism that requires a `reason` per rule; disabled
  rules render in a loud banner at the top of every HTML report and in
  `.preflight/last-run/disabled-axe-rules.md`.
- `.preflight/last-run/` stable output directory: HTML report, JSON,
  JUnit (`--ci`), `summary.json`, and a convenience `index.html` (symlink
  or redirect fallback on Windows).
- CLI flags: `--smoke`, `--list`, `--only`, `--engine`, `--headed`,
  `--debug`, `--verbose`, `--update-snapshots`, `--reporter`, `--config`,
  `--ci`, `--no-reuse`.
- `preflight init [--force]` drops a starter `preflight.config.ts`;
  refuses to clobber without `--force`.
- Loads consumer `preflight.config.ts` via `tsx` (declared as a regular
  dep so consumers do not need their own TS loader).
- README sections: install, quick start, coverage table, iOS manual
  smoke checklist, exit codes, CLI surface, 10 documented gotchas, v0.2
  roadmap, honest "what preflight does NOT cover" list.

### Known limitations

- Playwright WebKit is engine-close, not behaviour-identical to iOS
  Safari. Manual real-device QA still required.
- No authenticated route helpers in v0.1.
- No real network throttling.
- Virtual screen reader only; real NVDA arrives in v0.2.
- `npx playwright install` downloads ~650 MB of browser binaries.

[Unreleased]: https://example.com/CHANGELOG
[0.2.0]: https://example.com/CHANGELOG#0-2-0
[0.1.0]: https://example.com/CHANGELOG#0-1-0
