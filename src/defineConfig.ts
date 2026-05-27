import type {
  PreflightConfig,
  ResolvedPreflightConfig,
  EngineName,
  ViewportName,
} from './types.js';
import { ALL_VIEWPORTS } from './viewports.js';

const ALL_ENGINES: EngineName[] = ['chromium', 'firefox', 'webkit'];

/**
 * Recognised top-level config keys. Any unknown key is flagged loudly
 * because typos here silently produce surprising test runs.
 */
const KNOWN_KEYS = new Set<keyof PreflightConfig>([
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
  'auth',
  'networkPreset',
  'releaseOnlyPatterns',
  'htmlValidateRaw',
  'playwrightOverrides',
  'runnerTimeoutMs',
]);

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

export class PreflightConfigError extends Error {
  constructor(message: string) {
    super(`preflight config error: ${message}`);
    this.name = 'PreflightConfigError';
  }
}

/**
 * Typed helper for consumer-authored preflight.config.ts. Performs runtime
 * schema validation — typos are reported with the offending key, not
 * silently ignored.
 */
export function defineConfig(config: PreflightConfig): ResolvedPreflightConfig {
  return validateAndResolve(config);
}

export function validateAndResolve(input: unknown): ResolvedPreflightConfig {
  if (input === null || typeof input !== 'object') {
    throw new PreflightConfigError(
      'config must be an object — did you forget to `export default defineConfig({ ... })`?'
    );
  }
  const cfg = input as Record<string, unknown>;

  for (const key of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(key as keyof PreflightConfig)) {
      throw new PreflightConfigError(
        `unknown key "${key}". Known keys: ${Array.from(KNOWN_KEYS).join(', ')}.`
      );
    }
  }

  if (typeof cfg.baseURL !== 'string' || cfg.baseURL.length === 0) {
    throw new PreflightConfigError('baseURL must be a non-empty string.');
  }
  try {
    // eslint-disable-next-line no-new
    new URL(cfg.baseURL);
  } catch {
    throw new PreflightConfigError(`baseURL "${String(cfg.baseURL)}" is not a valid URL.`);
  }

  if (!Array.isArray(cfg.routes) || cfg.routes.length === 0) {
    throw new PreflightConfigError('routes must be a non-empty array.');
  }
  const seenRouteNames = new Set<string>();
  const routes = cfg.routes.map((r, i) => {
    if (r === null || typeof r !== 'object') {
      throw new PreflightConfigError(`routes[${i}] must be an object with { name, path }.`);
    }
    const rr = r as Record<string, unknown>;
    for (const k of Object.keys(rr)) {
      if (!KNOWN_ROUTE_KEYS.has(k)) {
        throw new PreflightConfigError(
          `routes[${i}] has unknown key "${k}". Known: ${Array.from(KNOWN_ROUTE_KEYS).join(', ')}.`
        );
      }
    }
    if (typeof rr.name !== 'string' || rr.name.length === 0) {
      throw new PreflightConfigError(`routes[${i}].name must be a non-empty string.`);
    }
    if (seenRouteNames.has(rr.name)) {
      throw new PreflightConfigError(
        `routes[${i}].name "${rr.name}" is already used by another route. ` +
          'Route names must be unique — they are used for test titles, report grouping, and visual snapshot filenames.'
      );
    }
    seenRouteNames.add(rr.name);
    if (typeof rr.path !== 'string' || !rr.path.startsWith('/')) {
      throw new PreflightConfigError(`routes[${i}].path must start with "/".`);
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
    throw new PreflightConfigError(
      'webServer is required. Set it to a config object, or `false` if you manage your server externally (e.g. testing a public URL).'
    );
  }
  let webServer: ResolvedPreflightConfig['webServer'];
  if (cfg.webServer === false) {
    webServer = false;
  } else if (cfg.webServer && typeof cfg.webServer === 'object') {
    const ws = cfg.webServer as Record<string, unknown>;
    if (typeof ws.command !== 'string' || ws.command.length === 0) {
      throw new PreflightConfigError('webServer.command must be a non-empty string.');
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
    throw new PreflightConfigError(
      'webServer must be a config object or the literal `false`.'
    );
  }

  let engines: EngineName[];
  if (cfg.engines === undefined) {
    engines = [...ALL_ENGINES];
  } else if (Array.isArray(cfg.engines) && cfg.engines.every((e) => ALL_ENGINES.includes(e as EngineName))) {
    engines = cfg.engines as EngineName[];
    if (engines.length === 0) {
      throw new PreflightConfigError('engines must be a non-empty array if set.');
    }
  } else {
    throw new PreflightConfigError(
      `engines must be an array of: ${ALL_ENGINES.join(', ')}.`
    );
  }

  let viewports: ViewportName[];
  if (cfg.viewports === undefined) {
    viewports = [...ALL_VIEWPORTS];
  } else if (Array.isArray(cfg.viewports) && cfg.viewports.every((v) => ALL_VIEWPORTS.includes(v as ViewportName))) {
    viewports = cfg.viewports as ViewportName[];
    if (viewports.length === 0) {
      throw new PreflightConfigError('viewports must be a non-empty array if set.');
    }
  } else {
    throw new PreflightConfigError(
      `viewports must be an array of: ${ALL_VIEWPORTS.join(', ')}.`
    );
  }

  let consoleIgnore: RegExp[];
  if (cfg.consoleIgnore === undefined) {
    consoleIgnore = [];
  } else if (Array.isArray(cfg.consoleIgnore) && cfg.consoleIgnore.every((r) => r instanceof RegExp)) {
    consoleIgnore = cfg.consoleIgnore as RegExp[];
  } else {
    throw new PreflightConfigError('consoleIgnore must be an array of RegExp.');
  }

  let axeDisabled: ResolvedPreflightConfig['axeDisabled'];
  if (cfg.axeDisabled === undefined) {
    axeDisabled = [];
  } else if (Array.isArray(cfg.axeDisabled)) {
    axeDisabled = cfg.axeDisabled.map((entry, i) => {
      if (entry === null || typeof entry !== 'object') {
        throw new PreflightConfigError(
          `axeDisabled[${i}] must be an object with { rule, reason }.`
        );
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.rule !== 'string' || e.rule.length === 0) {
        throw new PreflightConfigError(`axeDisabled[${i}].rule must be a non-empty string.`);
      }
      if (typeof e.reason !== 'string' || e.reason.length === 0) {
        throw new PreflightConfigError(
          `axeDisabled[${i}].reason must be a non-empty string. ` +
            'Disabled axe rules require a justification — they are written to .preflight/last-run/disabled-axe-rules.md on every run.'
        );
      }
      return { rule: e.rule, reason: e.reason };
    });
  } else {
    throw new PreflightConfigError('axeDisabled must be an array.');
  }

  if (cfg.readyMarker !== undefined && (typeof cfg.readyMarker !== 'string' || cfg.readyMarker.length === 0)) {
    throw new PreflightConfigError('readyMarker, if set, must be a non-empty selector string.');
  }
  let lighthouseThresholds: ResolvedPreflightConfig['lighthouseThresholds'];
  if (cfg.lighthouseThresholds !== undefined) {
    lighthouseThresholds = validateLighthouseThresholds(
      cfg.lighthouseThresholds,
      'lighthouseThresholds'
    );
  }

  let visualProject: string | undefined;
  if (cfg.visualProject !== undefined) {
    if (typeof cfg.visualProject !== 'string' || cfg.visualProject.length === 0) {
      throw new PreflightConfigError(
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
      throw new PreflightConfigError(
        'visualThreshold, if set, must be a number between 0 and 1 (maxDiffPixelRatio passthrough).'
      );
    }
    visualThreshold = cfg.visualThreshold;
  }

  let auth: ResolvedPreflightConfig['auth'];
  if (cfg.auth !== undefined) {
    if (cfg.auth === null || typeof cfg.auth !== 'object') {
      throw new PreflightConfigError(
        'auth must be an object with at least { setup: <path> } if set.'
      );
    }
    const a = cfg.auth as Record<string, unknown>;
    for (const k of Object.keys(a)) {
      if (!KNOWN_AUTH_KEYS.has(k)) {
        throw new PreflightConfigError(
          `auth has unknown key "${k}". Known: ${Array.from(KNOWN_AUTH_KEYS).join(', ')}.`
        );
      }
    }
    if (typeof a.setup !== 'string' || a.setup.length === 0) {
      throw new PreflightConfigError(
        'auth.setup must be a non-empty string — the path to a module that returns a Playwright storageState.'
      );
    }
    if (a.teardown !== undefined && (typeof a.teardown !== 'string' || a.teardown.length === 0)) {
      throw new PreflightConfigError(
        'auth.teardown, if set, must be a non-empty string path to a teardown module.'
      );
    }
    if (
      a.storageStatePath !== undefined &&
      (typeof a.storageStatePath !== 'string' || a.storageStatePath.length === 0)
    ) {
      throw new PreflightConfigError(
        'auth.storageStatePath, if set, must be a non-empty path string.'
      );
    }
    if (
      a.expirySeconds !== undefined &&
      (typeof a.expirySeconds !== 'number' ||
        !Number.isFinite(a.expirySeconds) ||
        a.expirySeconds < 0)
    ) {
      throw new PreflightConfigError(
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
    throw new PreflightConfigError('locale, if set, must be a non-empty BCP-47 string.');
  }
  if (cfg.timezoneId !== undefined && (typeof cfg.timezoneId !== 'string' || cfg.timezoneId.length === 0)) {
    throw new PreflightConfigError('timezoneId, if set, must be a non-empty IANA timezone string.');
  }

  let networkPreset: ResolvedPreflightConfig['networkPreset'];
  if (cfg.networkPreset !== undefined) {
    networkPreset = validateNetworkPreset(cfg.networkPreset);
  }

  let htmlValidateRaw: boolean | undefined;
  if (cfg.htmlValidateRaw !== undefined) {
    if (typeof cfg.htmlValidateRaw !== 'boolean') {
      throw new PreflightConfigError(
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
      throw new PreflightConfigError(
        'runnerTimeoutMs, if set, must be a positive finite number of milliseconds ' +
          '(the wall-clock cap on the whole Playwright run). preflight applies this as ' +
          "Playwright's globalTimeout and SIGKILLs the child after a 90 s grace window."
      );
    }
    runnerTimeoutMs = cfg.runnerTimeoutMs;
  }

  let releaseOnlyPatterns: ResolvedPreflightConfig['releaseOnlyPatterns'];
  if (cfg.releaseOnlyPatterns !== undefined) {
    if (
      !Array.isArray(cfg.releaseOnlyPatterns) ||
      !cfg.releaseOnlyPatterns.every((p) => typeof p === 'string' && p.length > 0)
    ) {
      throw new PreflightConfigError(
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
    auth,
    networkPreset,
    releaseOnlyPatterns,
    htmlValidateRaw,
    playwrightOverrides: cfg.playwrightOverrides as ResolvedPreflightConfig['playwrightOverrides'],
    runnerTimeoutMs,
  };
}

function validateNetworkPreset(input: unknown): NonNullable<ResolvedPreflightConfig['networkPreset']> {
  if (typeof input === 'string') {
    if (!KNOWN_NETWORK_PRESET_NAMES.has(input)) {
      throw new PreflightConfigError(
        `networkPreset "${input}" is not a recognised preset. Known: ${Array.from(KNOWN_NETWORK_PRESET_NAMES).join(', ')}, ` +
          'or supply a custom object { downloadKbps, uploadKbps, latencyMs }.'
      );
    }
    return input as '3g-slow' | '3g-fast' | '4g' | 'wifi';
  }
  if (input === null || typeof input !== 'object') {
    throw new PreflightConfigError(
      'networkPreset must be a preset name (3g-slow / 3g-fast / 4g / wifi) ' +
        'or an object { downloadKbps, uploadKbps, latencyMs }.'
    );
  }
  const np = input as Record<string, unknown>;
  for (const k of Object.keys(np)) {
    if (!KNOWN_NETWORK_PRESET_CUSTOM_KEYS.has(k)) {
      throw new PreflightConfigError(
        `networkPreset has unknown key "${k}". Known: ${Array.from(KNOWN_NETWORK_PRESET_CUSTOM_KEYS).join(', ')}.`
      );
    }
  }
  for (const k of KNOWN_NETWORK_PRESET_CUSTOM_KEYS) {
    const v = np[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new PreflightConfigError(
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

/**
 * Shared validator for the lighthouseThresholds shape (suite-wide AND
 * per-route). Returns the validated value so callers can assign directly.
 */
function validateLighthouseThresholds(input: unknown, label: string): Record<string, number> {
  if (input === null || typeof input !== 'object') {
    throw new PreflightConfigError(`${label} must be an object of category → score.`);
  }
  const lt = input as Record<string, unknown>;
  for (const [k, v] of Object.entries(lt)) {
    if (!LIGHTHOUSE_CATEGORIES.has(k)) {
      throw new PreflightConfigError(
        `${label}["${k}"] is not a recognised category. Known: ${Array.from(LIGHTHOUSE_CATEGORIES).join(', ')}.`
      );
    }
    if (typeof v !== 'number' || v < 0 || v > 100 || !Number.isFinite(v)) {
      throw new PreflightConfigError(`${label}["${k}"] must be a number between 0 and 100.`);
    }
  }
  return lt as Record<string, number>;
}
