import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineName, ResolvedPreflightConfig } from './types.js';
import { buildViewportProfiles, type ViewportProfile } from './viewports.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * preflight forwards the consumer's resolved config as JSON via env. RegExp
 * objects don't survive JSON round-trips, so consoleIgnore is serialised as
 * { source, flags } pairs and reconstructed here.
 */
interface SerialisedRegExp {
  source: string;
  flags: string;
}
interface SerialisedConfig extends Omit<ResolvedPreflightConfig, 'consoleIgnore'> {
  consoleIgnore: SerialisedRegExp[];
  /** Resolved by runner.ts when cfg.auth is set and --no-auth wasn't passed. */
  storageStatePath?: string;
}

function loadConfigFromEnv(): ResolvedPreflightConfig & { storageStatePath?: string } {
  const raw = process.env.PREFLIGHT_CONFIG_JSON;
  if (!raw) {
    throw new Error(
      'preflight: PREFLIGHT_CONFIG_JSON is not set. This config file is intended ' +
        'to be loaded by `bin/preflight.mjs`, not by `npx playwright test` directly.'
    );
  }
  const parsed = JSON.parse(raw) as SerialisedConfig;
  return {
    ...parsed,
    consoleIgnore: parsed.consoleIgnore.map((r) => new RegExp(r.source, r.flags)),
  };
}

const cfg = loadConfigFromEnv();
const profiles = buildViewportProfiles();
const isCi = process.env.PREFLIGHT_CI === '1';
const isRelease = process.env.PREFLIGHT_RELEASE === '1';
const isVisual = process.env.PREFLIGHT_VISUAL === '1';

/**
 * Release-only spec files. These are gated to one supported project
 * (NVDA cannot tolerate parallel sessions; Lighthouse is Chromium-only;
 * html-validate runs against post-hydration DOM which is engine-agnostic).
 * We exclude the files at project level via `testIgnore` so non-supported
 * projects never even load them — that avoids spawning a worker per project
 * just to immediately skip from inside the test body, and (critical for
 * NVDA) prevents the per-test `nvda` fixture from being constructed in
 * parallel across projects, which would race on Windows kernel hooks.
 *
 * Consumer-registered patterns via cfg.releaseOnlyPatterns are appended
 * to this list — they get the same project-level testIgnore treatment.
 * Note: testIgnore is matched against files DISCOVERED by testDir; see
 * the field's JSDoc for the consumer-spec-out-of-testDir caveat.
 */
const BUILT_IN_RELEASE_ONLY_SPECS = [
  '**/nvda.spec.js',
  '**/lighthouse.spec.js',
  '**/html-validate.spec.js',
];
// Concat unconditional — the per-project testIgnore is applied regardless
// of isRelease (matches how the built-in three are gated). Outside the
// release cadence the matched specs simply don't exist under preflight's
// testDir for non-supported projects, so the ignore is a no-op.
const RELEASE_ONLY_SPECS = [
  ...BUILT_IN_RELEASE_ONLY_SPECS,
  ...(cfg.releaseOnlyPatterns ?? []),
];
const RELEASE_SUPPORTED_PROJECT = 'chromium__desktop-1280';

/**
 * Visual regression spec is gated differently from release: --visual is
 * FLAG-driven (run only visual.spec.js, hide everything else) whereas
 * --release is PROJECT-driven (release specs only load on the
 * Chromium desktop-1280 project, the rest of the suite still runs). We
 * can't merge them into one map — they need opposite testMatch shapes.
 */
const VISUAL_SPEC = '**/visual.spec.js';

const engineUseMap: Record<EngineName, ReturnType<typeof devices.valueOf> extends infer T ? T : never> = {
  chromium: devices['Desktop Chrome']!,
  firefox: devices['Desktop Firefox']!,
  webkit: devices['Desktop Safari']!,
};

/**
 * Build the reporter array.
 *
 * preflight always emits an HTML report + a JSON report into
 * .preflight/last-run/ so reviewers have stable artefacts regardless of
 * console reporter choice. Under --ci we additionally emit a JUnit XML.
 * The console reporter is `list` by default; PREFLIGHT_REPERATER can
 * override to line/list/html/json/junit.
 *
 * We dedupe: if the user requests `--reporter=html` we DO NOT add a second
 * HTML reporter, since Playwright doesn't tolerate two writing to the
 * same outputFolder.
 */
function buildReporters(): NonNullable<PlaywrightTestConfig['reporter']> {
  const requested = (process.env.PREFLIGHT_REPORTER ?? 'list').toLowerCase();
  const reporters: NonNullable<PlaywrightTestConfig['reporter']> = [];

  // Console reporter (skip if user requested one of the artefact reporters
  // we add unconditionally — let those run alone, no console duplication).
  if (requested === 'line' || requested === 'list') {
    reporters.push([requested]);
  } else if (requested === 'html' || requested === 'json' || requested === 'junit') {
    // The user wants only the artefact reporter; we still add it below, just
    // skip a console one to keep stdout clean.
  } else {
    reporters.push(['list']);
  }

  reporters.push([
    'html',
    { open: 'never', outputFolder: process.env.PREFLIGHT_HTML_REPORT_DIR },
  ]);
  reporters.push(['json', { outputFile: process.env.PREFLIGHT_JSON_FILE }]);
  if (isCi) {
    reporters.push(['junit', { outputFile: process.env.PREFLIGHT_JUNIT_FILE }]);
  }
  return reporters;
}

function buildProjects(): PlaywrightTestConfig['projects'] {
  const projects: NonNullable<PlaywrightTestConfig['projects']> = [];
  for (const engine of cfg.engines) {
    const engineUse = engineUseMap[engine];
    // Firefox does not support isMobile/hasTouch/deviceScaleFactor on
    // newContext. We still vary the viewport size so responsive
    // breakpoints get exercised; touch/UA emulation is a no-op there.
    const supportsMobileEmulation = engine !== 'firefox';
    for (const vpName of cfg.viewports) {
      const profile: ViewportProfile = profiles[vpName];
      const useBlock: NonNullable<PlaywrightTestConfig['projects']>[number]['use'] = {
        ...engineUse,
        baseURL: cfg.baseURL,
        locale: cfg.locale,
        timezoneId: cfg.timezoneId,
        viewport: profile.viewport,
      };
      if (cfg.storageStatePath) {
        useBlock.storageState = cfg.storageStatePath;
      }
      if (supportsMobileEmulation) {
        if (profile.deviceScaleFactor !== undefined) useBlock.deviceScaleFactor = profile.deviceScaleFactor;
        if (profile.isMobile !== undefined) useBlock.isMobile = profile.isMobile;
        if (profile.hasTouch !== undefined) useBlock.hasTouch = profile.hasTouch;
        if (profile.userAgent) useBlock.userAgent = profile.userAgent;
      }
      const projectName = `${engine}__${vpName}`;
      // Project-level gating for the release-only specs. Non-supported
      // projects ignore the files entirely, which means: (a) they
      // don't spawn a worker just to skip from inside the test body,
      // and (b) the NVDA fixture is never constructed across multiple
      // projects in parallel, which would race on Windows kernel
      // hooks. Per-spec gating in the spec body is kept as a
      // defence-in-depth (covers consumer-added playwrightOverrides).
      const testIgnore =
        projectName === RELEASE_SUPPORTED_PROJECT ? undefined : RELEASE_ONLY_SPECS;
      // Firefox keeps its own desktop UA + DPR — mobile/touch emulation is
      // a no-op there, but the viewport size still exercises responsive CSS.
      projects.push({
        name: projectName,
        use: useBlock,
        testIgnore,
        metadata: {
          engine,
          viewport: vpName,
        },
      });
    }
  }
  return projects;
}

const VISUAL_TEST_MATCH = isVisual ? [VISUAL_SPEC] : ['**/*.spec.js'];
const VISUAL_TEST_IGNORE = isVisual ? undefined : [VISUAL_SPEC];

const config: PlaywrightTestConfig = defineConfig({
  testDir: path.join(__dirname, 'specs'),
  // We compile .ts → .js, so the published surface matches .spec.js.
  // NOTE: testMatch/testIgnore are set AFTER `playwrightOverrides`
  // below — the visual-cadence gate is load-bearing and must win
  // against any consumer override.

  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  // --release pins to one worker because NVDA owns the foreground app
  // — it captures keyboard via global Windows hooks and breaks if any
  // other process steals focus mid-test. The `testIgnore` gating
  // prevents the *fixture* from being constructed in parallel across
  // projects; this `workers: 1` is the second half of the same fix:
  // it prevents other-project workers from launching browsers and
  // stealing focus from NVDA. Both halves are required.
  workers: isRelease ? 1 : isCi ? 2 : undefined,
  reporter: buildReporters(),

  use: {
    baseURL: cfg.baseURL,
    locale: cfg.locale,
    timezoneId: cfg.timezoneId,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  outputDir: process.env.PREFLIGHT_TEST_RESULTS_DIR,

  // Default snapshot baseline location. Playwright's out-of-the-box
  // default is `{testDir}/{testFilePath}-snapshots/{arg}{ext}`, which
  // for preflight resolves under `node_modules/preflight/dist/specs/`
  // — destroyed on every `npm install`. We default to a directory
  // inside the consumer's project so baselines survive reinstalls and
  // can be checked in.
  //
  // process.cwd() === consumerCwd here: the runner spawns Playwright
  // with `cwd: consumerCwd` (see src/cli/runner.ts runPlaywright).
  //
  // Override semantics:
  //   - Consumer's `playwrightOverrides.snapshotPathTemplate` (top-level
  //     scalar) WINS via the spread below — later-key-wins on the
  //     same key.
  //   - Consumer's `playwrightOverrides.expect.toHaveScreenshot.pathTemplate`
  //     (a sibling key, NOT the same key) does NOT replace this default;
  //     both apply (Playwright merges expect-level templates over the
  //     top-level one per assertion).
  //   - A consumer who sets only other top-level keys (e.g. `expect`,
  //     `timeout`) leaves this default in place — intentional.
  snapshotPathTemplate: path.join(
    process.cwd(),
    '__preflight_screenshots__',
    '{arg}{ext}'
  ),

  projects: buildProjects(),

  webServer:
    cfg.webServer === false
      ? undefined
      : {
          command: cfg.webServer.command,
          url: cfg.webServer.url,
          port: cfg.webServer.port,
          // cwd is pre-resolved to an absolute path by the runner — see
          // resolvedWebServer in src/cli/runner.ts. Defaulting here would
          // break if anyone ever invoked this config file outside of
          // bin/preflight.mjs, but loadConfigFromEnv() above already
          // throws in that case.
          cwd: cfg.webServer.cwd,
          timeout: cfg.webServer.timeout ?? 120_000,
          env: cfg.webServer.env,
          reuseExistingServer: !isCi && process.env.PREFLIGHT_NO_REUSE !== '1',
          stdout: 'pipe',
          stderr: 'pipe',
        },

  ...(cfg.playwrightOverrides ?? {}),

  // The visual-cadence testMatch/testIgnore is load-bearing — a consumer
  // who sets `playwrightOverrides.testMatch` (e.g. to register an extra
  // custom spec) would otherwise silently break --visual gating. Re-apply
  // AFTER the spread so the gate always wins. Consumers who genuinely
  // want a different visual-cadence shape can set `cfg.visualProject`
  // (changes which project the spec runs on) — they don't need to
  // override testMatch.
  testMatch: VISUAL_TEST_MATCH,
  testIgnore: VISUAL_TEST_IGNORE,
});

export default config;
