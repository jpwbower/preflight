# preflight :: setup-guidepup.ps1
#
# Wrapper around `npx guidepup-setup` for Windows hosts. Run once on each
# developer / CI machine before `preflight --release` can exercise the
# real NVDA spec. The underlying `@guidepup/setup` package:
#
#   1. Downloads the NVDA installer (current LTS).
#   2. Installs NVDA silently (UAC prompt — accept).
#   3. Writes a Guidepup-specific NVDA config under %APPDATA%\nvda\
#      and an HKCU registry shim so subsequent Guidepup runs can drive it.
#
# Cold-install surface area (what you'll see when you run this on a clean box):
#
#   - Microsoft Defender Real-time Protection scans the installer.
#     Expect ~30s of CPU on the AV process. No action needed.
#   - User Account Control prompts to elevate the NVDA installer.
#     CLICK YES. preflight cannot click this for you.
#   - SmartScreen MAY prompt if the installer signature is not yet
#     in the local reputation cache. Click "More info" -> "Run anyway".
#   - Corporate AV / SCCM endpoint policies may quarantine the binary
#     entirely. If you see no UAC prompt at all, check Defender history.
#
# Idempotency: re-running the script when NVDA is already installed is
# a no-op aside from a registry-state refresh. Safe to run repeatedly.
#
# To roll back: `Add-Remove Programs` -> NVDA -> Uninstall, then
# `Remove-Item HKCU:\Software\Guidepup -Recurse -Force` if you need a
# clean reset.

$ErrorActionPreference = 'Stop'

if ($IsLinux -or $IsMacOS) {
    Write-Host "preflight setup-guidepup: NVDA only exists on Windows; skipping on $($PSVersionTable.OS)." -ForegroundColor Yellow
    exit 0
}

Write-Host "preflight setup-guidepup: launching @guidepup/setup ..." -ForegroundColor Cyan
Write-Host "  expect: NVDA download, UAC elevation prompt, possible SmartScreen warning." -ForegroundColor DarkGray
Write-Host ""

# Defer to the installed @guidepup/setup binary. We don't shell to
# `npx guidepup-setup` here because Windows PowerShell's npx wrapper
# eats the exit code on some hosts; resolving the bin script directly
# preserves it.
& npx --no-install guidepup-setup @args
$exit = $LASTEXITCODE

if ($exit -ne 0) {
    Write-Host ""
    Write-Host "preflight setup-guidepup: @guidepup/setup exited $exit." -ForegroundColor Red
    Write-Host "Common causes:" -ForegroundColor Yellow
    Write-Host "  - UAC prompt denied or auto-rejected by policy" -ForegroundColor Yellow
    Write-Host "  - SmartScreen blocked the NVDA installer" -ForegroundColor Yellow
    Write-Host "  - Corporate AV quarantined the download" -ForegroundColor Yellow
    Write-Host "  - No network access to NVDA's download CDN" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Re-run after addressing the cause. preflight --release will" -ForegroundColor Yellow
    Write-Host "skip the NVDA spec gracefully until setup completes." -ForegroundColor Yellow
    exit $exit
}

Write-Host ""
Write-Host "preflight setup-guidepup: OK. `preflight --release` can now run the NVDA spec." -ForegroundColor Green
exit 0
