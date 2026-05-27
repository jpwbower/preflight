/**
 * Default console-error ignore-list.
 *
 * The browser console is noisy. Out of the box preflight ignores:
 *  - common analytics beacon failures (visitors block them with adblockers)
 *  - framework deprecation warnings (real but already-known signal)
 *  - browser extension noise injected into the page context
 *  - third-party iframe garbage (Google Maps, YouTube, social embeds)
 *  - DevTools / source-map noise during development
 *
 * Consumers EXTEND this list via `consoleIgnore: [...]` in
 * preflight.config.ts — the consumer's list is concatenated, not used as
 * a replacement. This is intentional: silencing the defaults wholesale
 * by accident is the bug we are trying to prevent.
 */
export const DEFAULT_CONSOLE_IGNORE: RegExp[] = [
  // Adblocker / network refusal — visitors with uBlock etc. trigger this constantly
  /Failed to load resource.*google-?analytics/i,
  /Failed to load resource.*googletagmanager/i,
  /Failed to load resource.*doubleclick/i,
  /Failed to load resource.*facebook\.(?:net|com)/i,
  /Failed to load resource.*hotjar/i,
  /Failed to load resource.*segment\.(?:io|com)/i,
  /ERR_BLOCKED_BY_CLIENT/,
  /net::ERR_FAILED.*\.(?:gif|png)/i,

  // Framework deprecation noise (real but already-known)
  /\bDeprecationWarning:/i,
  /componentWillMount has been renamed/i,
  /Legacy context API/,

  // Browser extension noise — injected into page context, not site code
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  /safari-extension:\/\//i,
  /Extension context invalidated/,

  // DevTools / sourcemap noise during local dev
  /Download the React DevTools/,
  /DevTools failed to load source map/,

  // Third-party iframe garbage we can't fix from the host page
  /\[GoogleMaps\]/i,
  /YouTube embedded player/i,
];
