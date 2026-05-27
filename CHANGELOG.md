# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
[0.1.0]: https://example.com/CHANGELOG#0-1-0
