import { defineConfig } from 'preflight';

/**
 * preflight.config.ts
 *
 * Edit the values below for your project. Required: baseURL, routes,
 * webServer. Run `npx preflight --smoke` after editing for a fast sanity
 * check (chromium-only, single mobile viewport).
 *
 * Full surface: `npx preflight --help`
 */
export default defineConfig({
  // Base URL the routes are appended to. Use 127.0.0.1 over `localhost` if
  // your stack has IPv6 quirks (WebKit on Windows sometimes fails on `localhost`).
  baseURL: 'http://127.0.0.1:3000',

  routes: [
    { name: 'home', path: '/' },
    { name: 'about', path: '/about' },
    { name: 'contact', path: '/contact' },
  ],

  // Either `false` (you start your server yourself / are testing a remote URL)
  // or a config object. preflight passes this straight through to Playwright's
  // webServer config.
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3000',
    timeout: 120_000,
  },

  // Optional: marker selector that signals "page is fully hydrated and ready".
  // Recommended pattern: emit <div data-test-ready hidden /> from your app
  // when initial fetches + hydration are done. Replaces flaky `networkidle`.
  // readyMarker: '[data-test-ready]',

  // Optional: extra console-ignore patterns. Concatenated with preflight's
  // built-in defaults (analytics adblock noise, framework deprecation
  // warnings, extension chatter). Never replaces.
  // consoleIgnore: [
  //   /MyAnalyticsSDK: beacon failed/,
  // ],

  // Optional: disabled axe rules. Each entry MUST include a `reason` —
  // preflight surfaces disabled rules in a loud banner on every report.
  // axeDisabled: [
  //   {
  //     rule: 'color-contrast',
  //     reason: 'Brand guideline overrides; manual audit covers contrast on /landing',
  //   },
  // ],

  // Optional: locale / timezone. Defaults to en-GB / Europe/London.
  // locale: 'en-US',
  // timezoneId: 'America/New_York',
});
