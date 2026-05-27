import type { PlaywrightTestConfig } from '@playwright/test';

export type EngineName = 'chromium' | 'firefox' | 'webkit';

export type ViewportName = 'mobile-320' | 'mobile-375' | 'tablet-768' | 'desktop-1280' | 'desktop-1920';

/**
 * One route under test. `name` is used in test titles + report grouping.
 * `path` is appended to the consumer's baseURL.
 *
 * `lighthouseThresholds`, if set, overrides the suite-wide thresholds for
 * this route only — merged per-category so omitted fields fall back to
 * the suite-wide value (and then to the defaults). Use this to relax
 * perf on a heavy dashboard route without lowering the floor for the
 * whole site, or to tighten a11y on a landing page where the budget
 * justifies a higher bar.
 */
export interface PreflightRoute {
  name: string;
  path: string;
  lighthouseThresholds?: PreflightLighthouseThresholds;
}

/**
 * Web server launched by Playwright before tests run. Set to `false` to
 * skip server launch (e.g. when running against a public URL or an
 * externally-managed server).
 */
export interface PreflightWebServer {
  command: string;
  url?: string;
  port?: number;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

/**
 * axe rules a consumer wants suppressed. Logged loudly in the report header
 * so disabled rules can never silently hide.
 */
export interface PreflightAxeDisabled {
  rule: string;
  reason: string;
}

/**
 * Lighthouse score thresholds for the `--release` cadence. Each value is
 * the MINIMUM acceptable score (0–100). Categories above the threshold
 * pass; below fails. Defaults: perf 75, a11y 95, best-practices 85, seo 90.
 *
 * `pwa` is accepted for backwards compatibility with older Lighthouse
 * configurations, but the PWA category is deprecated in Lighthouse 12+
 * (and may produce no score in Lighthouse 13+, in which case the
 * threshold is silently a no-op). Avoid relying on it for new configs.
 */
export interface PreflightLighthouseThresholds {
  performance?: number;
  accessibility?: number;
  'best-practices'?: number;
  seo?: number;
  /** @deprecated PWA category is gated behind experimental presets in Lighthouse 12+. */
  pwa?: number;
}

/**
 * Network throttling preset applied to smoke.spec.ts and a11y.spec.ts.
 *
 * Implemented via Chromium DevTools Protocol (`Network.emulateNetworkConditions`)
 * — so it ONLY takes effect on chromium projects. On firefox / webkit the
 * helper emits a one-time console.warn and the test runs at full bandwidth.
 *
 * Named presets resolve as:
 *   `3g-slow`: 400 down / 400 up kbps, 400 ms latency (Lighthouse "Slow 3G")
 *   `3g-fast`: 1638 down / 768 up kbps, 150 ms latency (Lighthouse "Fast 3G")
 *   `4g`:      9000 down / 9000 up kbps, 170 ms latency
 *   `wifi`:    30000 down / 15000 up kbps, 2 ms latency
 *
 * `--release` Lighthouse audits IGNORE this setting — Lighthouse runs its
 * own simulated throttling for accurate perf budgets and we don't want
 * the two to compete.
 */
export type PreflightNetworkPresetName = '3g-slow' | '3g-fast' | '4g' | 'wifi';
export interface PreflightNetworkPresetCustom {
  downloadKbps: number;
  uploadKbps: number;
  latencyMs: number;
}
export type PreflightNetworkPreset = PreflightNetworkPresetName | PreflightNetworkPresetCustom;

/**
 * Auth lifecycle hooks. `setup` is the path (relative to the consumer's
 * project root, or absolute) of a JS/TS module that returns a Playwright
 * storageState object — preflight imports it, calls its default export,
 * caches the returned state, and wires it into every project's
 * `use.storageState`. `teardown`, if set, runs after the suite finishes
 * and on the explicit `preflight teardown` subcommand.
 *
 * `storageStatePath` is where the captured state is persisted between
 * runs; default `.preflight/auth/storageState.json` under the consumer's
 * cwd. `expirySeconds`, if set, forces a re-run of `setup` when the
 * cached state is older than that age — useful for short-lived session
 * tokens.
 */
export interface PreflightAuth {
  setup: string;
  teardown?: string;
  storageStatePath?: string;
  expirySeconds?: number;
}

/**
 * Consumer-facing configuration. Authored as preflight.config.ts in the
 * consuming project root.
 */
export interface PreflightConfig {
  /** Base URL of the site under test (e.g. http://127.0.0.1:3000). */
  baseURL: string;

  /** Routes to test against `baseURL`. At least one required. */
  routes: PreflightRoute[];

  /**
   * Web server to launch. Must be set explicitly to either a config object
   * (preflight starts the server) or `false` (consumer manages the server
   * themselves, e.g. running against a remote URL).
   */
  webServer: PreflightWebServer | false;

  /**
   * Engines under test. Default: all three.
   */
  engines?: EngineName[];

  /**
   * Viewport profiles under test. Default: all five.
   */
  viewports?: ViewportName[];

  /**
   * Extra regex patterns appended to the default console-ignore list.
   * Anything matching is ignored when smoke.spec asserts no console errors.
   * Concatenated with defaults, not replaced.
   */
  consoleIgnore?: RegExp[];

  /**
   * axe rules disabled in a11y.spec. Each entry MUST include a `reason`;
   * disabled rules render in a loud header at the top of every report.
   */
  axeDisabled?: PreflightAxeDisabled[];

  /**
   * If set, smoke.spec waits for this selector to appear before asserting
   * page readiness. Recommended pattern: emit `<div data-test-ready>` from
   * your app when it has finished hydrating / fetching. Default unset:
   * preflight waits for `domcontentloaded` only.
   */
  readyMarker?: string;

  /**
   * Locale forwarded to Playwright contextOptions. Default 'en-GB'.
   */
  locale?: string;

  /**
   * timezoneId forwarded to Playwright contextOptions. Default 'Europe/London'.
   */
  timezoneId?: string;

  /**
   * Lighthouse score thresholds. Only consulted on `--release`. If unset,
   * preflight uses perf 75, a11y 95, best-practices 85, seo 90. Per-route
   * overrides via `PreflightRoute.lighthouseThresholds` take precedence
   * over this suite-wide value (merged per-category).
   */
  lighthouseThresholds?: PreflightLighthouseThresholds;

  /**
   * Visual regression settings. Only consulted on `--visual`. The visual
   * spec runs `expect(page).toHaveScreenshot()` for each route on a
   * single project (default `chromium__desktop-1280`). Baselines are
   * managed by the consumer — preflight ships none. See README for the
   * Windows ClearType escape hatch (`snapshotPathTemplate`).
   *
   * `visualProject` selects which engine__viewport project the visual
   * spec runs on; defaults to `chromium__desktop-1280`. Any value that
   * does not match one of the generated project names skips the spec
   * loudly.
   *
   * `visualThreshold` is the maxDiffPixelRatio passthrough — 0.0 means
   * exact match, 1.0 means tolerate any change. Default 0.01.
   */
  visualProject?: string;
  visualThreshold?: number;

  /**
   * Authenticated-route lifecycle. Set to wire a setup hook that
   * produces a storageState (cookies + localStorage), which preflight
   * caches and passes to every Playwright project.
   */
  auth?: PreflightAuth;

  /**
   * Apply CDP-based network throttling to smoke.spec and a11y.spec. See
   * {@link PreflightNetworkPreset}. Chromium-only — preflight warns
   * once and proceeds at full bandwidth on firefox / webkit.
   *
   * NOT wired into keyboard / emulated-media / virtual-sr (bandwidth
   * does not affect their signal) or lighthouse.spec (Lighthouse runs
   * its own simulated throttling).
   */
  networkPreset?: PreflightNetworkPreset;

  /**
   * Additional spec globs to treat as release-only — appended to
   * preflight's built-in release-only spec list (nvda, lighthouse,
   * html-validate) and applied via project-level `testIgnore`. Matched
   * files are excluded from every project EXCEPT
   * `chromium__desktop-1280` (the release-supported project).
   *
   * NOTE: Playwright matches `testIgnore` globs against files
   * discovered under the active `testDir`. preflight's `testDir` is its
   * own bundled specs dir, so these patterns only do anything if the
   * consumer's spec files are ALSO discoverable there (typically via
   * `playwrightOverrides.testDir` or `testMatch`). For consumer specs
   * that live in a separate root, gate them yourself using
   * `process.env.PREFLIGHT_RELEASE === '1'` inside your own
   * `playwrightOverrides`.
   */
  releaseOnlyPatterns?: string[];

  /**
   * Escape hatch for advanced consumers — extra Playwright config merged
   * into the generated config last. Use sparingly; preflight may override.
   */
  playwrightOverrides?: Partial<PlaywrightTestConfig>;
}

/**
 * Defaults-applied, validated form of `PreflightConfig`. Internal.
 */
export interface ResolvedPreflightConfig {
  baseURL: string;
  routes: PreflightRoute[];
  webServer: PreflightWebServer | false;
  engines: EngineName[];
  viewports: ViewportName[];
  consoleIgnore: RegExp[];
  axeDisabled: PreflightAxeDisabled[];
  readyMarker?: string;
  locale: string;
  timezoneId: string;
  lighthouseThresholds?: PreflightLighthouseThresholds;
  visualProject?: string;
  visualThreshold?: number;
  auth?: PreflightAuth;
  networkPreset?: PreflightNetworkPreset;
  releaseOnlyPatterns?: string[];
  playwrightOverrides?: Partial<PlaywrightTestConfig>;
}
