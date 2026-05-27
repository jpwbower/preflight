import type { ResolvedPreflightConfig } from '../types.js';

interface SerialisedRegExp {
  source: string;
  flags: string;
}
interface SerialisedConfig extends Omit<ResolvedPreflightConfig, 'consoleIgnore'> {
  consoleIgnore: SerialisedRegExp[];
}

/**
 * Shared loader for the env-injected resolved config. Specs import this
 * instead of re-parsing PREFLIGHT_CONFIG_JSON themselves.
 */
export function loadPreflightConfig(): ResolvedPreflightConfig {
  const raw = process.env.PREFLIGHT_CONFIG_JSON;
  if (!raw) {
    throw new Error(
      'preflight spec: PREFLIGHT_CONFIG_JSON is not set. Run via `npx preflight`, not `playwright test`.'
    );
  }
  const parsed = JSON.parse(raw) as SerialisedConfig;
  return {
    ...parsed,
    consoleIgnore: parsed.consoleIgnore.map((r) => new RegExp(r.source, r.flags)),
  };
}

export function isCi(): boolean {
  return process.env.PREFLIGHT_CI === '1';
}
