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
        run: |
          # Required so the NVDA spec can actually attach to a real
          # screen reader. Idempotent — re-running on a host with
          # Guidepup-NVDA already installed is a no-op.
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
        run: |
          # Pinned to a known-good tag — bump deliberately, not on
          # every CI run.
          curl -L -o lychee.tar.gz \
            https://github.com/lycheeverse/lychee/releases/download/lychee-v0.20.1/lychee-x86_64-unknown-linux-gnu.tar.gz
          tar -xzf lychee.tar.gz
          chmod +x lychee
          sudo mv lychee /usr/local/bin/
      - run: npx preflight --links
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: preflight-links
          path: .preflight/last-run/
          retention-days: 14
