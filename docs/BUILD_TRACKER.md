<!-- preflight-build-tracker schema v1 -->
# preflight — build tracker

This file is the cross-thread handoff mechanism. Every chunk reads it on
entry to discover its work; every chunk updates it on close. Do not
delete prior chunk rows — append to "Chunks complete".

## Current state

- Version shipped: v0.3.0
- Tag pushed: yes (after final commit; SHA below is the R5 commit, tag commit is the next SHA)
- Branch: main
- HEAD SHA at last close: 70b8b525cdcbe570a963b0c1e8c8341b0e2844ff (R5 commit; tag commit is the next SHA)
- Node version exercised: 24.14.0 (Node 22 LTS is the pinned floor; operator dev box on 24)
- npm version exercised: 11.9.0
- Playwright version exercised: 1.60.0 (peerDep `>=1.50.0`, open lower bound)
- Lighthouse version exercised: 13.3.0 (via playwright-lighthouse 4.0.0)
- Guidepup versions exercised: @guidepup/guidepup 0.24.1, @guidepup/playwright 0.15.0, @guidepup/setup 0.21.0
- html-validate version exercised: 11.4.0
- lychee version exercised: 0.24.2 (binary install from GitHub release)
- http-server version exercised (visual fixture only): 14.1.1 (scratch dir only — NOT a preflight dep)
- Guidepup setup script: re-run during Chunk 3 validation? NO — already registered from Chunk 2.

## Chunks complete

| Chunk | Version | Scope | Commit range | HEAD SHA | Tag |
| ----- | ------- | ----- | ------------ | -------- | --- |
| 1 | v0.1.0 | Scaffold: package, types, defineConfig, Playwright matrix, smoke / a11y / keyboard / emulated-media / virtual-sr specs, CLI entry, init template, full README, R5 remediation of Opus review findings | root..v0.1.0 | e61f49e (+ tag commit) | v0.1.0 |
| 2 | v0.2.0 | --release cadence (nvda, lighthouse, html-validate); --links cadence (lychee shellout); preflight init --ci (GHA workflow template); lighthouseThresholds config field; unified summary.json schema across cadences with `cadence` discriminator; project-level testIgnore for release-only specs + workers:1 on release for NVDA foreground-app safety; R5 remediation (version bump, lychee streaming, NVDA lazy import, GHA template lychee-action@v2, defensive guidepup-setup check) | v0.1.0..v0.2.0 | ea0d438 (+ tag commit) | v0.2.0 |
| 3 | v0.3.0 | --visual cadence (Playwright `toHaveScreenshot()` on one project, gated flag-driven via top-level testMatch flip; cfg.visualProject + cfg.visualThreshold); cfg.auth lifecycle (setup module producing storageState, cache + expiry, --no-auth bypass, `preflight teardown` subcommand); per-route lighthouseThresholds override; webServer.cwd default-bug fix (was defaulting to preflight/dist, now resolves to consumer project root in the runner); R5 remediation (lighthouse storageState honour, --visual playwrightOverrides clobber-proofing, --visual flag-conflict rejection, route-name uniqueness, atomic storageState write, named-export error UX, JSON.stringify wrap, parseArgs engine/reporter validation) | v0.2.0..v0.3.0 | 70b8b52 (+ tag commit) | v0.3.0 |

## Chunks remaining

| Chunk | Version target | Scope | Risk notes |
| ----- | -------------- | ----- | ---------- |
| 4 | v0.4.0 (or later) | macOS VoiceOver (template-port of nvda.spec.ts — Guidepup exposes `voiceOverTest`); real network throttling (Chromium CDP, exposed as a config knob); consumer-registered release-only specs via project-level gating refactor; lychee minimum-version diagnostic; SSR raw-response html-validate pass behind a config flag | macOS support needs a Mac dev box; operator does not currently have one wired into the validation loop. Real network throttling on chromium CDP only — firefox/webkit will need to warn loudly. |

## Operator-decide carry-forwards

- None at end of Chunk 3. (Guidepup setup still registered from Chunk 2.)

## Known issues / deferred fixes

Carried forward from Chunk 1 (still applicable):

- **Validation against `https://example.com` is thin.** example.com has no
  forms, no SPA routing, and a minimal heading hierarchy. Chunks 1+2+3
  validation proves "the framework launches end-to-end and emits the
  expected artefacts under `.preflight/last-run/`", NOT "the specs
  catch real bugs on real sites". A consumer running preflight against
  their own dev server is the first time the specs are stressed
  against a non-trivial DOM. Chunk 3 added a local static fixture
  (`scratch-fixture/index.html` served via http-server) for the
  `--visual` validation only — example.com cannot be a deterministic
  baseline target.
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
  on --release; VoiceOver still pending v0.4+).

Carried forward from Chunk 2 (still applicable):

- **`--release` is single-threaded under `workers: 1`** because NVDA
  owns the foreground app. v0.3 changes nothing here.
- **Lighthouse defaults assume ship-gate.** v0.3 added per-route
  thresholds (`PreflightRoute.lighthouseThresholds`) so consumers can
  relax a single dashboard route without dropping the suite-wide
  floor. The defaults themselves (perf 75, a11y 95, best-practices 85,
  seo 90) remain unchanged.
- **NVDA `spokenPhraseLog()` returns empty strings on the operator's
  dev box.** Soft-assertion shape unchanged in v0.3.
- **Guidepup's NVDA build lives in `%TEMP%`.** Storage Sense can wipe
  it. Re-run `node node_modules/@guidepup/setup/bin/setup` to recover.
- **lychee version skew is silent.** Minimum-version diagnostic
  deferred to v0.4.
- **html-validate runs against `page.content()` (post-hydration DOM)
  only.** Raw-response pass deferred to v0.4.
- **Reviewer-flagged free-port TOCTOU race in lighthouse.spec.ts.**
  Tiny window, release runs serial under workers:1; fix-pin via
  `PREFLIGHT_LIGHTHOUSE_PORT`. Unchanged in v0.3.

New in Chunk 3:

- **Visual baselines default to
  `node_modules/preflight/dist/specs/visual.spec.js-snapshots/`.**
  That's Playwright's sibling-of-spec default and the spec ships
  inside the consumer's node_modules — so the baseline is destroyed
  on every `npm install`. Consumers MUST set
  `playwrightOverrides.snapshotPathTemplate` to a path inside their
  own repo. README has a worked example encoding `os.release()` for
  Windows builds. If we shipped a default `snapshotPathTemplate`
  pointing at the consumer's root we'd be picking a directory for them
  — opinionated choice deferred until consumer feedback arrives.
- **The `--release` Lighthouse spec honours `cfg.auth.storageState`
  but the underlying chromium.launch() call still uses a fresh
  user-data-dir.** Caches / IndexedDB / other persistent state from
  the storageState file are loaded via `storageState` (cookies +
  localStorage), but anything stored outside of those two channels is
  not portable. For most auth flows this is fine.
- **`auth.setup` runs in the parent runner process** before Playwright
  spawns. If the setup module imports heavy dependencies (e.g. a full
  app server for a synthetic login flow), preflight startup latency
  grows. The cache-with-expiry pattern is the intended mitigation —
  set `expirySeconds` generously for long-lived sessions.
- **`auth.storageStatePath` and `auth.setup` are not path-sandboxed.**
  Consumer-authored config can read/write outside the project root.
  Documented; the config is the consumer's own code.
- **`preflight teardown` deletes the cached storageState even when
  `cfg.auth.teardown` is unset.** This matches the brief's "safety
  net" intent — running `teardown` always invalidates the cache. If a
  consumer wants to inspect the cache before deletion, they can read
  it from `.preflight/auth/storageState.json` directly.
- **`--visual` runs sequentially on one project** by design (one
  engine × one viewport × N routes). Wallclock is shorter than full
  default suite but the consumer is responsible for re-running it on
  every relevant change rather than every push.
- **`--update-snapshots` was a v0.1 passthrough flag with no
  snapshot-producing specs to operate on.** v0.3 made `visual.spec.ts`
  the first consumer; running `--update-snapshots` against any other
  cadence is now a no-op (there are still no other snapshots to
  update), but the flag is documented as a Playwright passthrough so
  this is consistent.

## Notes for the next chunk (v0.4+)

When picking up Chunk 4:

1. Read this file's `Current state` to confirm v0.3.0 actually shipped
   (tag pushed, HEAD SHA matches GitHub).
2. macOS VoiceOver path: Guidepup exposes `voiceOverTest` mirroring
   `nvdaTest`; the v0.2 `nvda.spec.ts` shape (lazy import behind
   platform gate + project-level testIgnore + soft assertion on
   phrase content) is the template. The operator does not currently
   have a Mac dev box; this work needs one wired into the validation
   loop.
3. Network throttling: chromium CDP supports `Network.emulateNetworkConditions`
   directly. Firefox and WebKit do not support equivalent CDP shapes
   — preflight should warn loudly when a consumer sets `networkPreset`
   on those engines rather than silently no-op.
4. Consumer-registered release-only specs: the v0.3 testIgnore pattern
   in `playwright.config.ts` hardcodes `RELEASE_ONLY_SPECS`. v0.4
   should expose `cfg.releaseOnlySpecs?: string[]` (glob patterns)
   so consumers can register their own.
5. Run the same two purity grep tests at chunk close.
