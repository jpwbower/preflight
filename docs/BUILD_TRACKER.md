<!-- preflight-build-tracker schema v1 -->
# preflight — build tracker

This file is the cross-thread handoff mechanism. Every chunk reads it on
entry to discover its work; every chunk updates it on close. Do not
delete prior chunk rows — append to "Chunks complete".

## Current state

- Version shipped: v0.1.0
- Tag pushed: _set after operator confirms_
- Branch: main
- HEAD SHA at last close: _set on chunk close (see `git log -1 --format=%H`)_
- Node version exercised: 24.14.0 (Node 22 LTS is the pinned floor; operator dev box on 24)
- npm version exercised: 11.9.0
- Playwright version exercised: see `npm ls @playwright/test` (locked to ^1.50.0 via package-lock.json)
- Guidepup setup script run? (Chunk 2+): N/A — Chunk 1 dropped @guidepup/virtual-screen-reader during validation; no native binary touched

## Chunks complete

| Chunk | Version | Scope | Commit range | HEAD SHA | Tag |
| ----- | ------- | ----- | ------------ | -------- | --- |
| 1 | v0.1.0 | Scaffold: package, types, defineConfig, Playwright matrix, smoke / a11y / keyboard / emulated-media / virtual-sr specs, CLI entry, init template, full README | root → v0.1.0 | _filled at tag time_ | v0.1.0 |

## Chunks remaining

| Chunk | Version target | Scope | Risk notes |
| ----- | -------------- | ----- | ---------- |
| 2 | v0.2.0 | Real NVDA via Guidepup, Lighthouse budgets, html-validate, lychee link checker, GHA workflow template, visual regression option | High install risk: `npx guidepup-setup` writes to HKCU and may trigger Defender Real-time scan / SmartScreen / UAC. Run the Commit 1 dependency-install commit FIRST, then attempt setup in Commit 2 with a documented rollback path. |

## Operator-decide carry-forwards

- None at end of Chunk 1.

## Known issues / deferred fixes

- **Validation against `https://example.com` is thin.** example.com has no
  forms, no SPA routing, and a minimal heading hierarchy. The Chunk 1
  validation proves "the framework launches end-to-end and emits the
  expected artefacts under `.preflight/last-run/`", **not** "the specs
  catch real bugs on real sites". A consumer running preflight against
  their own dev server is the first time the specs are stressed against
  a non-trivial DOM. The headed run of `--smoke` against example.com
  *does* trip the smoke spec on a real signal (favicon.ico 404) — so the
  capture loop is wired correctly.
- **`npx playwright install` size + network.** ~650 MB download from
  Playwright's CDN. Local Chunk 1 validation took 24s wallclock with
  some browsers already cached; a cold install on a clean Windows box
  with Defender Real-time Protection enabled will be longer. Documented
  in README; nothing preflight can do about it.
- **Symlink creation in `.preflight/last-run/`.** On non-elevated
  Windows without Developer Mode, the convenience `index.html → html-report/index.html`
  symlink fails. preflight falls back to writing a tiny HTML redirect
  so the path still resolves. Documented in runner.ts.
- **The five viewport projects multiply quickly.** 3 engines × 5
  viewports × 5 spec files = 75 base test contexts; routes multiply
  further. `--smoke` exists for this reason. Validated full-suite
  wallclock against example.com: 56s. `--release` for the heavier
  Lighthouse / html-validate / NVDA suite lands in v0.2.
- **`a11y` color-contrast soft-fail logic is heuristic.** We treat
  `bgColor: null` from axe's data payload as "background is an image",
  which is the documented signal but not always reliable across axe
  versions. Worth revisiting if axe-core releases a more explicit hint.
- **Firefox does not support mobile / touch emulation.** Playwright's
  Firefox rejects `isMobile`, `hasTouch`, `deviceScaleFactor` on
  `newContext`. preflight strips those for Firefox projects (viewport
  size still varies). Documented as a README gotcha. Real mobile-Firefox
  QA needs a real device.
- **virtual-sr is structural, not behavioural.** The spec was originally
  scoped to run `@guidepup/virtual-screen-reader`, but that library
  takes a DOM Node and runs in the browser context — not a Playwright
  handle. v0.1 pivoted to an in-page accessible-name sweep that walks
  visible interactive elements and asserts each has a name a screen
  reader could announce. The dep is dropped. Real NVDA / VoiceOver still
  arrives in v0.2 via the full Guidepup driver.

## Notes for the next chunk (v0.2)

When picking up Chunk 2:

1. Read this file's `Current state` to confirm v0.1.0 actually shipped
   (tag pushed, HEAD SHA matches GitHub).
2. Read the spec for Chunk 2 in the user's brief.
3. Risk discipline: install deps in Commit 1, attempt `guidepup-setup`
   in Commit 2. If setup blocks on UAC / SmartScreen / Defender that
   the agent cannot click through, record the block here under
   "Operator-decide carry-forwards", set the Guidepup registry-state
   flag to "needs operator action", and end the thread cleanly.
4. Run the same two purity grep tests at chunk close.
