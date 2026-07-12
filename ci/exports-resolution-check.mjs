#!/usr/bin/env node
// Packaging regression guard: the package must resolve under BOTH module
// systems, because a consumer's `import { defineConfig } from 'vantage'`
// reaches us through two paths:
//   - ESM consumer ("type": "module")  -> "import" condition.
//   - CJS-default consumer (npm init sets no "type"), where tsx transpiles
//     vantage.config.ts to CommonJS and the import becomes
//     require('vantage')               -> "require" condition.
// v0.7.0 shipped exports["."] with only types/import, so the require path
// died before browser launch with ERR_PACKAGE_PATH_NOT_EXPORTED
// ('No "exports" main defined in .../vantage/package.json').
//
// Self-reference (Node resolves the bare name 'vantage' against this repo's
// own exports map) exercises exactly the resolution consumers see.
// Requires dist/ to be built first.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const failures = [];
const firstLine = (err) =>
  `${err && err.code ? `${err.code}: ` : ''}${String(err && err.message ? err.message : err).split('\n')[0]}`;

// "require" condition must RESOLVE — this is the exact v0.7.0 regression.
try {
  require.resolve('vantage');
} catch (err) {
  failures.push(`require-condition resolution failed: ${firstLine(err)}`);
}

// "import" condition must resolve AND expose the documented surface.
try {
  const mod = await import('vantage');
  if (typeof mod.defineConfig !== 'function') {
    failures.push('import condition resolved but defineConfig is not exported');
  }
} catch (err) {
  failures.push(`import-condition load failed: ${firstLine(err)}`);
}

// Full require() of the ESM entry needs require(esm) support (Node >= 22.12);
// tsx provides the same interop on older 22.x, so only assert it where plain
// node supports it.
if (process.features.require_module) {
  try {
    const mod = require('vantage');
    if (typeof mod.defineConfig !== 'function') {
      failures.push('require() loaded but defineConfig is not exported');
    }
  } catch (err) {
    failures.push(`require() load failed: ${firstLine(err)}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`exports-resolution-check: FAIL\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}
process.stdout.write('exports-resolution-check: OK (import + require conditions both resolve)\n');
