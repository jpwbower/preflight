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
}

function loadConfigFromEnv(): ResolvedPreflightConfig {
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
      if (supportsMobileEmulation) {
        if (profile.deviceScaleFactor !== undefined) useBlock.deviceScaleFactor = profile.deviceScaleFactor;
        if (profile.isMobile !== undefined) useBlock.isMobile = profile.isMobile;
        if (profile.hasTouch !== undefined) useBlock.hasTouch = profile.hasTouch;
        if (profile.userAgent) useBlock.userAgent = profile.userAgent;
      }
      // Firefox keeps its own desktop UA + DPR — mobile/touch emulation is
      // a no-op there, but the viewport size still exercises responsive CSS.
      projects.push({
        name: `${engine}__${vpName}`,
        use: useBlock,
        metadata: {
          engine,
          viewport: vpName,
        },
      });
    }
  }
  return projects;
}

const config: PlaywrightTestConfig = defineConfig({
  testDir: path.join(__dirname, 'specs'),
  // We compile .ts → .js, so the published surface matches .spec.js
  testMatch: ['**/*.spec.js'],

  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  workers: isCi ? 2 : undefined,
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

  projects: buildProjects(),

  webServer:
    cfg.webServer === false
      ? undefined
      : {
          command: cfg.webServer.command,
          url: cfg.webServer.url,
          port: cfg.webServer.port,
          cwd: cfg.webServer.cwd,
          timeout: cfg.webServer.timeout ?? 120_000,
          env: cfg.webServer.env,
          reuseExistingServer: !isCi && process.env.PREFLIGHT_NO_REUSE !== '1',
          stdout: 'pipe',
          stderr: 'pipe',
        },

  ...(cfg.playwrightOverrides ?? {}),
});

export default config;
