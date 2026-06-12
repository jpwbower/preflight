/**
 * Public consumer surface for vantage.
 *
 * Consumers write:
 *   import { defineConfig } from 'vantage';
 *   export default defineConfig({ ... });
 *
 * Everything else (CLI, runner, spec internals) is loaded via `bin/vantage.mjs`
 * and not part of the documented import surface.
 */
export { defineConfig, VantageConfigError } from './defineConfig.js';
export type {
  VantageConfig,
  VantageRoute,
  VantageWebServer,
  VantageAxeDisabled,
  VantageLighthouseThresholds,
  VantageAuth,
  EngineName,
  ViewportName,
  ResolvedVantageConfig,
} from './types.js';
