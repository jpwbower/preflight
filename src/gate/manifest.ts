import { createHash } from 'node:crypto';

/**
 * `preflight --gate` manifest model.
 *
 * The gate cadence renders a runner-supplied authoritative route set and
 * emits a DETERMINISTIC per-route manifest that an external gate (the CTR
 * cross-model-review runner) binds a verdict to. The trust property: the
 * manifest is produced by the runner-driven render, never by a model's
 * claimed evidence, so a reviewer cannot fabricate the surface.
 *
 * Two hash layers, by deliberate design:
 *
 *   - `domSha256` (per route) and the overall `manifestSha256` are the
 *     BINDING hash. They are computed over the post-hydration DOM + axe
 *     summary + render-health, with all order-sensitive arrays sorted so
 *     capture-order nondeterminism cannot flip the hash. For a static
 *     (deterministic) surface this hash is stable across renders and is
 *     what the checker recomputes. For an SSR surface it is an inspection
 *     aid, not a binding fingerprint (the surface is host/time-dependent).
 *
 *   - `screenshotSha256` (per route) is recorded for provenance + file
 *     integrity, but the screenshot BYTES are deliberately EXCLUDED from
 *     the binding `manifestSha256`. Screenshots are vision-review input,
 *     not the binding hash: full-page PNG bytes flake on Windows ClearType
 *     subpixel hinting regardless of any code change, so folding them into
 *     the binding hash would make it spuriously unstable (and would break the
 *     cross-render / cross-OS stability the DOM hash is designed to give).
 *
 *     Consequence, stated plainly so a reviewer can weigh it: a verdict bound
 *     to `manifestSha256` is bound to the post-hydration DOM (+ axe +
 *     render-health + policy envelope), NOT to the screenshot bytes — so the
 *     DOM hash, not the screenshot, is THE surface fingerprint a verdict rests
 *     on. The screenshot is an advisory aid for the (separate) vision layer.
 *     Both are written by the SAME runner-driven render, so altering the
 *     recorded `screenshotSha256`/`screenshotPath` after the fact (the only way
 *     to desync them from the DOM the hash binds) requires write access to the
 *     runner's own output dir — host control that exists independent of any
 *     diff, outside this gate's honest-author threat model. The customer-facing
 *     "evidence is first-class" surface (where the rendered image itself must
 *     be bound — so a pixel-only change that does not touch the DOM cannot pass)
 *     is a separate audience tier handled by a Phase-B checker that binds
 *     evidence on one canonical render environment — NOT this primitive. That
 *     pixel-binding is a deliberately-deferred, tracked design decision
 *     (preflight issue #3), not an oversight in this cadence.
 */

/** Current gate-manifest schema version. Bump on any breaking shape change. */
export const GATE_MANIFEST_SCHEMA_VERSION = '1';

export interface GateAxeViolation {
  id: string;
  impact: string | null;
  help: string;
  /** CSS-selector targets of the violating nodes (sorted for stable hashing). */
  nodeTargets: string[];
}

export interface GateAxeSummary {
  violationCount: number;
  violations: GateAxeViolation[];
}

/**
 * Render-health signal — the universal floor that gates EVERY audience
 * (a11y/axe gating is audience-toggled separately, render-health is not).
 * `ok` is true only when the route loaded 2xx, was not blank, threw no
 * uncaught page errors, logged no console problems (after the consumer
 * ignore-list), and made no failed network requests.
 */
export interface GateRenderHealth {
  ok: boolean;
  status: number | null;
  blank: boolean;
  /** Length of the body's rendered innerText — surfaces near-blank renders. */
  domTextLength: number;
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: string[];
}

export interface GateRouteRecord {
  /** Index into the runner's authoritative route set — the stable order key. */
  index: number;
  name: string;
  path: string;
  status: number | null;
  renderHealth: GateRenderHealth;
  /** sha256 of the post-hydration DOM (load-bearing — part of the binding hash). */
  domSha256: string;
  /** Path to the captured DOM snapshot, relative to the last-run dir. */
  domPath: string;
  /** sha256 of the full-page screenshot (provenance/integrity; NOT in binding hash). */
  screenshotSha256: string;
  /** Path to the captured screenshot, relative to the last-run dir. */
  screenshotPath: string;
  axe: GateAxeSummary;
}

export interface GateManifestMeta {
  preflightVersion: string;
  /** ISO timestamp — recorded but EXCLUDED from the binding hash. */
  finishedAt: string;
  /** Optional surface label forwarded by the runner (e.g. "cockpit"). */
  surface?: string;
  /** Resolved engine__viewport project the gate rendered on. */
  project: string;
  /** Audience-toggle echo: whether axe violations were gating this run. */
  a11yGating: boolean;
}

export interface GateManifest extends Omit<GateManifestMeta, 'surface'> {
  schemaVersion: string;
  routeCount: number;
  /** False if any authoritative route produced no capture (worker crash, etc.). */
  coverageComplete: boolean;
  /** Indices of authoritative routes that produced no record. */
  missingRoutes: number[];
  /**
   * Surface label, or null when none. ALWAYS present (never omitted) so a
   * checker recomputing manifestSha256 from the emitted manifest round-trips —
   * the binding hash folds in exactly this value (null when absent), and an
   * omitted key would canonicalise differently from a bound `null`.
   */
  surface: string | null;
  /** The binding hash — sha256 over the ordered, normalized binding view. */
  manifestSha256: string;
  routes: GateRouteRecord[];
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic JSON serialization: object keys are emitted in sorted
 * order recursively, so two structurally-equal values always serialize
 * to byte-identical strings regardless of insertion order. Array order is
 * preserved — callers must pre-sort any array whose order is not itself
 * semantically meaningful (see `bindingRecord`).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The normalized, binding view of one route record. Excludes the
 * screenshot bytes-hash + file paths + everything non-semantic, and sorts
 * the order-insensitive arrays (console/page/network problems, axe
 * violations, node targets) so a different capture order cannot change the
 * binding hash while a genuine content change still does.
 *
 * `status` is carried inside `renderHealth.status` only — not duplicated at
 * the top level — so the two can never disagree inside the hash.
 */
function bindingRecord(r: GateRouteRecord): unknown {
  return {
    index: r.index,
    name: r.name,
    path: r.path,
    renderHealth: {
      ok: r.renderHealth.ok,
      status: r.renderHealth.status,
      blank: r.renderHealth.blank,
      domTextLength: r.renderHealth.domTextLength,
      pageErrors: [...r.renderHealth.pageErrors].sort(),
      consoleErrors: [...r.renderHealth.consoleErrors].sort(),
      failedRequests: [...r.renderHealth.failedRequests].sort(),
    },
    domSha256: r.domSha256,
    axe: {
      violationCount: r.axe.violationCount,
      violations: [...r.axe.violations]
        .map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodeTargets: [...v.nodeTargets].sort(),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
  };
}

/** The non-record fields folded into the binding hash (policy + coverage). */
export interface ManifestBindingMeta {
  schemaVersion: string;
  project: string;
  surface: string | null;
  a11yGating: boolean;
  routeCount: number;
  coverageComplete: boolean;
  missingRoutes: number[];
}

/**
 * Compute the binding manifest hash. It binds the ordered route records AND
 * the full policy/coverage envelope — `project` (engine__viewport),
 * `routeCount`, `coverageComplete`, `missingRoutes`, `schemaVersion`,
 * `surface`, and `a11yGating` — so two manifests cannot collide on a matching
 * hash while differing in the authoritative route SET or the gating policy
 * (e.g. a narrowed route set, a different audience, or a11y on vs off). Records
 * are ordered by their authoritative `index` (NOT capture order) and reduced to
 * the normalized binding view before hashing; `missingRoutes` is sorted.
 *
 * A Phase-B checker recomputes this as:
 *   sha256(canonicalJson({ schemaVersion, project, surface, a11yGating,
 *     routeCount, coverageComplete, missingRoutes, routes: [bindingRecord,...] }))
 * where `surface` is the emitted manifest's `surface` (always present — null
 * when absent). `meta.surface` is coalesced to null here so a checker that
 * passes an absent/undefined surface still matches the bound hash.
 */
export function computeManifestSha256(
  records: GateRouteRecord[],
  meta: ManifestBindingMeta
): string {
  const ordered = [...records].sort((a, b) => a.index - b.index).map(bindingRecord);
  return sha256Hex(
    canonicalJson({
      schemaVersion: meta.schemaVersion,
      project: meta.project,
      surface: meta.surface ?? null,
      a11yGating: meta.a11yGating,
      routeCount: meta.routeCount,
      coverageComplete: meta.coverageComplete,
      missingRoutes: [...meta.missingRoutes].sort((a, b) => a - b),
      routes: ordered,
    })
  );
}

/**
 * Assemble the full gate manifest from the per-route records the spec
 * captured. `routeCount` is the authoritative route count (from the
 * runner's config); any index in 0..routeCount-1 with no record is
 * reported in `missingRoutes` and flips `coverageComplete` to false —
 * fail-closed against a surface that silently failed to render.
 */
export function assembleManifest(
  meta: GateManifestMeta,
  records: GateRouteRecord[],
  routeCount: number
): GateManifest {
  const ordered = [...records].sort((a, b) => a.index - b.index);
  const present = new Set(ordered.map((r) => r.index));
  const missingRoutes: number[] = [];
  for (let i = 0; i < routeCount; i++) {
    if (!present.has(i)) missingRoutes.push(i);
  }
  const coverageComplete = missingRoutes.length === 0;
  // Normalise surface ONCE, use the SAME value for the hash AND the emitted
  // manifest, and ALWAYS emit it (as null when absent). `|| null` collapses
  // undefined/null/"" to null. Emitting it UNCONDITIONALLY is load-bearing: if
  // the hash binds a value (e.g. null) while the manifest omits the key, a
  // checker recomputing manifestSha256 from the emitted manifest reads the
  // absent key as `undefined`, which canonicalises differently from the bound
  // `null` — so a correct surface would fail recompute. Always-present makes the
  // round-trip exact.
  const surface = meta.surface || null;
  const manifestSha256 = computeManifestSha256(ordered, {
    schemaVersion: GATE_MANIFEST_SCHEMA_VERSION,
    project: meta.project,
    surface,
    a11yGating: meta.a11yGating,
    routeCount,
    coverageComplete,
    missingRoutes,
  });
  return {
    schemaVersion: GATE_MANIFEST_SCHEMA_VERSION,
    preflightVersion: meta.preflightVersion,
    finishedAt: meta.finishedAt,
    surface,
    project: meta.project,
    a11yGating: meta.a11yGating,
    routeCount,
    coverageComplete,
    missingRoutes,
    manifestSha256,
    routes: ordered,
  };
}
