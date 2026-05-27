/**
 * Public consumer surface for preflight.
 *
 * Consumers write:
 *   import { defineConfig } from 'preflight';
 *   export default defineConfig({ ... });
 *
 * Everything else (CLI, runner, spec internals) is loaded via `bin/preflight.mjs`
 * and not part of the documented import surface.
 */
export { defineConfig, PreflightConfigError } from './defineConfig.js';
export type {
  PreflightConfig,
  PreflightRoute,
  PreflightWebServer,
  PreflightAxeDisabled,
  PreflightLighthouseThresholds,
  PreflightAuth,
  EngineName,
  ViewportName,
  ResolvedPreflightConfig,
} from './types.js';
