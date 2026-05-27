# preflight :: GitHub Actions workflow template
#
# Dropped by `preflight init --ci`. Edit freely — this is a starting
# point, not a managed file. The four jobs mirror the four cadences
# preflight ships:
#
#   smoke    every push on every branch (fast: ~1 min)
#   full     on PR open / push to main  (engine x viewport matrix)
#   release  pre-tag                    (adds NVDA/Lighthouse/html-validate)
#   links    nightly                    (lychee — needs the lychee CLI)
#
# What you'll want to change first:
#   - `runs-on`: keep `ubuntu-latest` for smoke/full; switch the
#     release job to `windows-latest` if you want the NVDA spec to
#     actually run (NVDA is Windows-only and will skip otherwise).
#   - The `branches:` filter on push — limit it to `main` if you have
#     active feature branches that don't need smoke on every push.
#   - Caching: cache the Playwright browsers if your build minutes
#     matter; uncomment the `cache: 'playwright'` block.

name: preflight

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    # Nightly link check at 03:00 UTC. Change to suit.
    - cron: '0 3 * * *'

jobs:
  smoke:
    if: github.event_name == 'push' || github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx preflight --smoke --ci
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: preflight-smoke
          path: .preflight/last-run/
          retention-days: 7

  full:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx preflight --ci
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: preflight-full
          path: .preflight/last-run/
          retention-days: 14

  release:
    # Triggered by pushing a tag matching v*. NVDA is Windows-only —
    # if you don't want a Windows runner in your minute budget, swap
    # `runs-on: windows-latest` for `ubuntu-latest`; the NVDA spec
    # will then skip itself gracefully.
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: windows-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install --with-deps
      - name: install NVDA via guidepup-setup
        shell: pwsh
        timeout-minutes: 5
        run: |
          # @guidepup/setup is a devDep of preflight, so it should be
          # under node_modules after `npm ci`. The defensive `npm ls`
          # surfaces a clear error if the consumer hasn't actually
          # installed the optional v0.2 extras; otherwise the setup
          # script is idempotent (re-running on a host with
          # Guidepup-NVDA already installed is a no-op).
          if (-not (Test-Path node_modules/@guidepup/setup/bin/setup)) {
            Write-Error "@guidepup/setup is not installed. Add it to your devDeps: npm i -D @guidepup/setup @guidepup/guidepup @guidepup/playwright"
            exit 1
          }
          node node_modules/@guidepup/setup/bin/setup
      - run: npx preflight --release --ci
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: preflight-release
          path: .preflight/last-run/
          retention-days: 30

  links:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - name: install lychee
        # Official action — version-pinned and handles asset-naming
        # changes across lychee releases. Pin a specific tag (`@v2`
        # rather than `@main`) so the install is reproducible.
        uses: lycheeverse/lychee-action@v2
        with:
          # `args: --version` is a no-op invocation that just downloads
          # and caches the binary onto PATH. The actual link check
          # runs in the next step via preflight, not via this action,
          # so we don't want to double-execute lychee here.
          args: --version
      - run: npx preflight --links
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: preflight-links
          path: .preflight/last-run/
          retention-days: 14
