import type {
  VantageConfig,
  ResolvedVantageConfig,
  EngineName,
  ViewportName,
} from './types.js';
import { ALL_VIEWPORTS } from './viewports.js';

const ALL_ENGINES: EngineName[] = ['chromium', 'firefox', 'webkit'];

/**
 * Recognised top-level config keys. Any unknown key is flagged loudly
 * because typos here silently produce surprising test runs.
 */
const KNOWN_KEYS = new Set<keyof VantageConfig>([
  'baseURL',
  'routes',
  'webServer',
  'engines',
  'viewports',
  'consoleIgnore',
  'axeDisabled',
  'readyMarker',
  'locale',
  'timezoneId',
  'lighthouseThresholds',
  'visualProject',
  'visualThreshold',
  'gateA11yGating',
  'auth',
  'networkPreset',
  'releaseOnlyPatterns',
  'htmlValidateRaw',
  'playwrightOverrides',
  'runnerTimeoutMs',
]);

/**
 * Gate mode is a trusted capture cadence, so JSON config is deliberately a
 * strict inert subset of the normal consumer config surface. Anything that can
 * import modules, spawn commands, register specs, suppress findings, or tune
 * a non-gate cadence is rejected before the config reaches Playwright.
 */
const GATE_CONFIG_ALLOWED_KEYS = new Set<string>([
  'baseURL',
  'routes',
  'webServer',
  'engines',
  'viewports',
  'readyMarker',
  'locale',
  'timezoneId',
  'gateA11yGating',
  'networkPreset',
  'runnerTimeoutMs',
]);
const GATE_CONFIG_REJECT_REASONS = new Map<string, string>([
  [
    'auth',
    'it imports auth.setup/auth.teardown modules; --gate never runs the auth lifecycle.',
  ],
  [
    'playwrightOverrides',
    'it can inject Playwright setup, reporters, webServer, specs, projects, or context options; --gate pins that contract.',
  ],
  [
    'releaseOnlyPatterns',
    'it registers extra spec globs; --gate runs only the bundled gate-manifest spec.',
  ],
  [
    'consoleIgnore',
    'it can suppress render-health failures; --gate keeps the gate health floor runner-owned.',
  ],
  [
    'axeDisabled',
    'it can suppress axe findings; --gate records the unmodified axe signal.',
  ],
]);
const GATE_ROUTE_KEYS = new Set(['name', 'path']);
const KNOWN_NETWORK_PRESET_NAMES = new Set(['3g-slow', '3g-fast', '4g', 'wifi']);
const KNOWN_NETWORK_PRESET_CUSTOM_KEYS = new Set(['downloadKbps', 'uploadKbps', 'latencyMs']);

const KNOWN_ROUTE_KEYS = new Set(['name', 'path', 'lighthouseThresholds']);
const KNOWN_AUTH_KEYS = new Set(['setup', 'teardown', 'storageStatePath', 'expirySeconds']);

const LIGHTHOUSE_CATEGORIES = new Set([
  'performance',
  'accessibility',
  'best-practices',
  'seo',
  'pwa',
]);

export class VantageConfigError extends Error {
  constructor(message: string) {
    super(`vantage config error: ${message}`);
    this.name = 'VantageConfigError';
  }
}

/**
 * Typed helper for consumer-authored vantage.config.ts. Performs runtime
 * schema validation — typos are reported with the offending key, not
 * silently ignored.
 */
export function defineConfig(config: VantageConfig): ResolvedVantageConfig {
  return validateAndResolve(config);
}

export function validateGateConfig(input: unknown): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new VantageConfigError(
      '--gate config must be a JSON object with only inert capture keys.'
    );
  }
  const cfg = input as Record<string, unknown>;

  for (const key of Object.keys(cfg)) {
    const reason = GATE_CONFIG_REJECT_REASONS.get(key);
    if (reason) {
      throw new VantageConfigError(
        `--gate config cannot include "${key}": ${reason}`
      );
    }
    if (!GATE_CONFIG_ALLOWED_KEYS.has(key)) {
      throw new VantageConfigError(
        `--gate config has non-allowlisted key "${key}". Allowed keys: ${formatSet(GATE_CONFIG_ALLOWED_KEYS)}.`
      );
    }
  }

  validateGateRoutes(cfg.routes);
  validateGateWebServer(cfg.webServer);
}

export function validateAndResolve(input: unknown): ResolvedVantageConfig {
  if (input === null || typeof input !== 'object') {
    throw new VantageConfigError(
      'config must be an object — did you forget to `export default defineConfig({ ... })`?'
    );
  }
  const cfg = input as Record<string, unknown>;

  for (const key of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(key as keyof VantageConfig)) {
      throw new VantageConfigError(
        `unknown key "${key}". Known keys: ${Array.from(KNOWN_KEYS).join(', ')}.`
      );
    }
  }

  if (typeof cfg.baseURL !== 'string' || cfg.baseURL.length === 0) {
    throw new VantageConfigError('baseURL must be a non-empty string.');
  }
  try {
    // eslint-disable-next-line no-new
    new URL(cfg.baseURL);
  } catch {
    throw new VantageConfigError(`baseURL "${String(cfg.baseURL)}" is not a valid URL.`);
  }

  if (!Array.isArray(cfg.routes) || cfg.routes.length === 0) {
    throw new VantageConfigError('routes must be a non-empty array.');
  }
  const seenRouteNames = new Set<string>();
  const routes = cfg.routes.map((r, i) => {
    if (r === null || typeof r !== 'object') {
      throw new VantageConfigError(`routes[${i}] must be an object with { name, path }.`);
    }
    const rr = r as Record<string, unknown>;
    for (const k of Object.keys(rr)) {
      if (!KNOWN_ROUTE_KEYS.has(k)) {
        throw new VantageConfigError(
          `routes[${i}] has unknown key "${k}". Known: ${Array.from(KNOWN_ROUTE_KEYS).join(', ')}.`
        );
      }
    }
    if (typeof rr.name !== 'string' || rr.name.length === 0) {
      throw new VantageConfigError(`routes[${i}].name must be a non-empty string.`);
    }
    if (seenRouteNames.has(rr.name)) {
      throw new VantageConfigError(
        `routes[${i}].name "${rr.name}" is already used by another route. ` +
          'Route names must be unique — they are used for test titles, report grouping, and visual snapshot filenames.'
      );
    }
    seenRouteNames.add(rr.name);
    if (typeof rr.path !== 'string' || !rr.path.startsWith('/')) {
      throw new VantageConfigError(`routes[${i}].path must start with "/".`);
    }
    const route: { name: string; path: string; lighthouseThresholds?: Record<string, number> } = {
      name: rr.name,
      path: rr.path,
    };
    if (rr.lighthouseThresholds !== undefined) {
      route.lighthouseThresholds = validateLighthouseThresholds(
        rr.lighthouseThresholds,
        `routes[${i}].lighthouseThresholds`
      );
    }
    return route;
  });

  if (!('webServer' in cfg)) {
    throw new VantageConfigError(
      'webServer is required. Set it to a config object, or `false` if you manage your server externally (e.g. testing a public URL).'
    );
  }
  let webServer: ResolvedVantageConfig['webServer'];
  if (cfg.webServer === false) {
    webServer = false;
  } else if (cfg.webServer && typeof cfg.webServer === 'object') {
    const ws = cfg.webServer as Record<string, unknown>;
    if (typeof ws.command !== 'string' || ws.command.length === 0) {
      throw new VantageConfigError('webServer.command must be a non-empty string.');
    }
    webServer = {
      command: ws.command,
      url: typeof ws.url === 'string' ? ws.url : undefined,
      port: typeof ws.port === 'number' ? ws.port : undefined,
      cwd: typeof ws.cwd === 'string' ? ws.cwd : undefined,
      timeout: typeof ws.timeout === 'number' ? ws.timeout : undefined,
      env: ws.env && typeof ws.env === 'object' ? (ws.env as Record<string, string>) : undefined,
    };
  } else {
    throw new VantageConfigError(
      'webServer must be a config object or the literal `false`.'
    );
  }

  let engines: EngineName[];
  if (cfg.engines === undefined) {
    engines = [...ALL_ENGINES];
  } else if (Array.isArray(cfg.engines) && cfg.engines.every((e) => ALL_ENGINES.includes(e as EngineName))) {
    engines = cfg.engines as EngineName[];
    if (engines.length === 0) {
      throw new VantageConfigError('engines must be a non-empty array if set.');
    }
  } else {
    throw new VantageConfigError(
      `engines must be an array of: ${ALL_ENGINES.join(', ')}.`
    );
  }

  let viewports: ViewportName[];
  if (cfg.viewports === undefined) {
    viewports = [...ALL_VIEWPORTS];
  } else if (Array.isArray(cfg.viewports) && cfg.viewports.every((v) => ALL_VIEWPORTS.includes(v as ViewportName))) {
    viewports = cfg.viewports as ViewportName[];
    if (viewports.length === 0) {
      throw new VantageConfigError('viewports must be a non-empty array if set.');
    }
  } else {
    throw new VantageConfigError(
      `viewports must be an array of: ${ALL_VIEWPORTS.join(', ')}.`
    );
  }

  let consoleIgnore: RegExp[];
  if (cfg.consoleIgnore === undefined) {
    consoleIgnore = [];
  } else if (Array.isArray(cfg.consoleIgnore) && cfg.consoleIgnore.every((r) => r instanceof RegExp)) {
    consoleIgnore = cfg.consoleIgnore as RegExp[];
  } else {
    throw new VantageConfigError('consoleIgnore must be an array of RegExp.');
  }

  let axeDisabled: ResolvedVantageConfig['axeDisabled'];
  if (cfg.axeDisabled === undefined) {
    axeDisabled = [];
  } else if (Array.isArray(cfg.axeDisabled)) {
    axeDisabled = cfg.axeDisabled.map((entry, i) => {
      if (entry === null || typeof entry !== 'object') {
        throw new VantageConfigError(
          `axeDisabled[${i}] must be an object with { rule, reason }.`
        );
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.rule !== 'string' || e.rule.length === 0) {
        throw new VantageConfigError(`axeDisabled[${i}].rule must be a non-empty string.`);
      }
      if (typeof e.reason !== 'string' || e.reason.length === 0) {
        throw new VantageConfigError(
          `axeDisabled[${i}].reason must be a non-empty string. ` +
            'Disabled axe rules require a justification — they are written to .vantage/last-run/disabled-axe-rules.md on every run.'
        );
      }
      return { rule: e.rule, reason: e.reason };
    });
  } else {
    throw new VantageConfigError('axeDisabled must be an array.');
  }

  if (cfg.readyMarker !== undefined && (typeof cfg.readyMarker !== 'string' || cfg.readyMarker.length === 0)) {
    throw new VantageConfigError('readyMarker, if set, must be a non-empty selector string.');
  }
  let lighthouseThresholds: ResolvedVantageConfig['lighthouseThresholds'];
  if (cfg.lighthouseThresholds !== undefined) {
    lighthouseThresholds = validateLighthouseThresholds(
      cfg.lighthouseThresholds,
      'lighthouseThresholds'
    );
  }

  let visualProject: string | undefined;
  if (cfg.visualProject !== undefined) {
    if (typeof cfg.visualProject !== 'string' || cfg.visualProject.length === 0) {
      throw new VantageConfigError(
        'visualProject, if set, must be a non-empty string (an engine__viewport project name).'
      );
    }
    visualProject = cfg.visualProject;
  }
  let visualThreshold: number | undefined;
  if (cfg.visualThreshold !== undefined) {
    if (
      typeof cfg.visualThreshold !== 'number' ||
      !Number.isFinite(cfg.visualThreshold) ||
      cfg.visualThreshold < 0 ||
      cfg.visualThreshold > 1
    ) {
      throw new VantageConfigError(
        'visualThreshold, if set, must be a number between 0 and 1 (maxDiffPixelRatio passthrough).'
      );
    }
    visualThreshold = cfg.visualThreshold;
  }

  let gateA11yGating: boolean | undefined;
  if (cfg.gateA11yGating !== undefined) {
    if (typeof cfg.gateA11yGating !== 'boolean') {
      throw new VantageConfigError(
        'gateA11yGating, if set, must be a boolean. When true, axe violations fail the ' +
          '--gate cadence (customer-facing surfaces); when false (default) axe is recorded ' +
          'in the manifest but non-gating (internal surfaces). Render-health always gates.'
      );
    }
    gateA11yGating = cfg.gateA11yGating;
  }

  let auth: ResolvedVantageConfig['auth'];
  if (cfg.auth !== undefined) {
    if (cfg.auth === null || typeof cfg.auth !== 'object') {
      throw new VantageConfigError(
        'auth must be an object with at least { setup: <path> } if set.'
      );
    }
    const a = cfg.auth as Record<string, unknown>;
    for (const k of Object.keys(a)) {
      if (!KNOWN_AUTH_KEYS.has(k)) {
        throw new VantageConfigError(
          `auth has unknown key "${k}". Known: ${Array.from(KNOWN_AUTH_KEYS).join(', ')}.`
        );
      }
    }
    if (typeof a.setup !== 'string' || a.setup.length === 0) {
      throw new VantageConfigError(
        'auth.setup must be a non-empty string — the path to a module that returns a Playwright storageState.'
      );
    }
    if (a.teardown !== undefined && (typeof a.teardown !== 'string' || a.teardown.length === 0)) {
      throw new VantageConfigError(
        'auth.teardown, if set, must be a non-empty string path to a teardown module.'
      );
    }
    if (
      a.storageStatePath !== undefined &&
      (typeof a.storageStatePath !== 'string' || a.storageStatePath.length === 0)
    ) {
      throw new VantageConfigError(
        'auth.storageStatePath, if set, must be a non-empty path string.'
      );
    }
    if (
      a.expirySeconds !== undefined &&
      (typeof a.expirySeconds !== 'number' ||
        !Number.isFinite(a.expirySeconds) ||
        a.expirySeconds < 0)
    ) {
      throw new VantageConfigError(
        'auth.expirySeconds, if set, must be a non-negative number of seconds.'
      );
    }
    auth = {
      setup: a.setup,
      teardown: a.teardown as string | undefined,
      storageStatePath: a.storageStatePath as string | undefined,
      expirySeconds: a.expirySeconds as number | undefined,
    };
  }
  if (cfg.locale !== undefined && (typeof cfg.locale !== 'string' || cfg.locale.length === 0)) {
    throw new VantageConfigError('locale, if set, must be a non-empty BCP-47 string.');
  }
  if (cfg.timezoneId !== undefined && (typeof cfg.timezoneId !== 'string' || cfg.timezoneId.length === 0)) {
    throw new VantageConfigError('timezoneId, if set, must be a non-empty IANA timezone string.');
  }

  let networkPreset: ResolvedVantageConfig['networkPreset'];
  if (cfg.networkPreset !== undefined) {
    networkPreset = validateNetworkPreset(cfg.networkPreset);
  }

  let htmlValidateRaw: boolean | undefined;
  if (cfg.htmlValidateRaw !== undefined) {
    if (typeof cfg.htmlValidateRaw !== 'boolean') {
      throw new VantageConfigError(
        'htmlValidateRaw, if set, must be a boolean. ' +
          'When true, html-validate fetches each route via Node fetch and validates the raw response body ' +
          'in addition to the post-hydration DOM pass.'
      );
    }
    htmlValidateRaw = cfg.htmlValidateRaw;
  }

  let runnerTimeoutMs: number | undefined;
  if (cfg.runnerTimeoutMs !== undefined) {
    if (
      typeof cfg.runnerTimeoutMs !== 'number' ||
      !Number.isFinite(cfg.runnerTimeoutMs) ||
      cfg.runnerTimeoutMs <= 0
    ) {
      throw new VantageConfigError(
        'runnerTimeoutMs, if set, must be a positive finite number of milliseconds ' +
          '(the wall-clock cap on the whole Playwright run). vantage applies this as ' +
          "Playwright's globalTimeout and SIGKILLs the child after a 90 s grace window."
      );
    }
    runnerTimeoutMs = cfg.runnerTimeoutMs;
  }

  let releaseOnlyPatterns: ResolvedVantageConfig['releaseOnlyPatterns'];
  if (cfg.releaseOnlyPatterns !== undefined) {
    if (
      !Array.isArray(cfg.releaseOnlyPatterns) ||
      !cfg.releaseOnlyPatterns.every((p) => typeof p === 'string' && p.length > 0)
    ) {
      throw new VantageConfigError(
        'releaseOnlyPatterns, if set, must be an array of non-empty glob strings ' +
          '(e.g. ["**/my-perf.spec.js"]).'
      );
    }
    releaseOnlyPatterns = cfg.releaseOnlyPatterns as string[];
  }

  return {
    baseURL: cfg.baseURL,
    routes,
    webServer,
    engines,
    viewports,
    consoleIgnore,
    axeDisabled,
    readyMarker: cfg.readyMarker as string | undefined,
    locale: (cfg.locale as string | undefined) ?? 'en-GB',
    timezoneId: (cfg.timezoneId as string | undefined) ?? 'Europe/London',
    lighthouseThresholds,
    visualProject,
    visualThreshold,
    gateA11yGating,
    auth,
    networkPreset,
    releaseOnlyPatterns,
    htmlValidateRaw,
    playwrightOverrides: cfg.playwrightOverrides as ResolvedVantageConfig['playwrightOverrides'],
    runnerTimeoutMs,
  };
}

function validateNetworkPreset(input: unknown): NonNullable<ResolvedVantageConfig['networkPreset']> {
  if (typeof input === 'string') {
    if (!KNOWN_NETWORK_PRESET_NAMES.has(input)) {
      throw new VantageConfigError(
        `networkPreset "${input}" is not a recognised preset. Known: ${Array.from(KNOWN_NETWORK_PRESET_NAMES).join(', ')}, ` +
          'or supply a custom object { downloadKbps, uploadKbps, latencyMs }.'
      );
    }
    return input as '3g-slow' | '3g-fast' | '4g' | 'wifi';
  }
  if (input === null || typeof input !== 'object') {
    throw new VantageConfigError(
      'networkPreset must be a preset name (3g-slow / 3g-fast / 4g / wifi) ' +
        'or an object { downloadKbps, uploadKbps, latencyMs }.'
    );
  }
  const np = input as Record<string, unknown>;
  for (const k of Object.keys(np)) {
    if (!KNOWN_NETWORK_PRESET_CUSTOM_KEYS.has(k)) {
      throw new VantageConfigError(
        `networkPreset has unknown key "${k}". Known: ${Array.from(KNOWN_NETWORK_PRESET_CUSTOM_KEYS).join(', ')}.`
      );
    }
  }
  for (const k of KNOWN_NETWORK_PRESET_CUSTOM_KEYS) {
    const v = np[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new VantageConfigError(
        `networkPreset.${k} must be a non-negative finite number.`
      );
    }
  }
  return {
    downloadKbps: np.downloadKbps as number,
    uploadKbps: np.uploadKbps as number,
    latencyMs: np.latencyMs as number,
  };
}

function validateGateRoutes(input: unknown): void {
  if (!Array.isArray(input)) return;
  input.forEach((route, i) => {
    if (route === null || typeof route !== 'object' || Array.isArray(route)) return;
    for (const key of Object.keys(route as Record<string, unknown>)) {
      if (!GATE_ROUTE_KEYS.has(key)) {
        throw new VantageConfigError(
          `--gate config routes[${i}] has non-allowlisted key "${key}". Allowed route keys: ${formatSet(GATE_ROUTE_KEYS)}.`
        );
      }
    }
  });
}

function validateGateWebServer(input: unknown): void {
  if (input === undefined || input === false) return;
  throw new VantageConfigError(
    '--gate config webServer must be false. The trusted gate runner must start the surface out-of-band; gate JSON cannot carry a shell command.'
  );
}

function formatSet(values: Set<string>): string {
  return Array.from(values).join(', ');
}

/**
 * Shared validator for the lighthouseThresholds shape (suite-wide AND
 * per-route). Returns the validated value so callers can assign directly.
 */
function validateLighthouseThresholds(input: unknown, label: string): Record<string, number> {
  if (input === null || typeof input !== 'object') {
    throw new VantageConfigError(`${label} must be an object of category → score.`);
  }
  const lt = input as Record<string, unknown>;
  for (const [k, v] of Object.entries(lt)) {
    if (!LIGHTHOUSE_CATEGORIES.has(k)) {
      throw new VantageConfigError(
        `${label}["${k}"] is not a recognised category. Known: ${Array.from(LIGHTHOUSE_CATEGORIES).join(', ')}.`
      );
    }
    if (typeof v !== 'number' || v < 0 || v > 100 || !Number.isFinite(v)) {
      throw new VantageConfigError(`${label}["${k}"] must be a number between 0 and 100.`);
    }
  }
  return lt as Record<string, number>;
}
