# setup-chrome-debug.ps1 — launch Chrome with the DevTools remote-debugging port
# open so MYTHOS's browser-agent (playwright-core connectOverCDP) can attach.
#
# It uses a DEDICATED user-data-dir under LOCALAPPDATA — never your normal Chrome
# profile — so your everyday browsing, cookies, and logins stay isolated from
# anything MYTHOS drives. Chrome binds the debugging port to loopback only by
# default; do not expose it. When Chrome is up, this prints the BROWSER_CDP_URL
# to add to mythos/.env, then MYTHOS connects at boot ('browser-automation' step).

param(
  [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'

$candidates = @(
  "$Env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${Env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$Env:LocalAppData\Google\Chrome\Application\chrome.exe",
  "$Env:ProgramFiles\Google\Chrome Beta\Application\chrome.exe",
  "$Env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${Env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)

$chrome = $null
foreach ($c in $candidates) {
  if (Test-Path $c) { $chrome = $c; break }
}

if (-not $chrome) {
  Write-Error "Could not find chrome.exe (or msedge.exe) in the standard install locations. Install Chrome or pass the path manually."
  exit 1
}

$profileDir = Join-Path $Env:LocalAppData 'mythos-chrome-debug'
if (-not (Test-Path $profileDir)) {
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
}

Write-Host "Launching: $chrome"
Write-Host "  --remote-debugging-port=$Port"
Write-Host "  --user-data-dir=$profileDir  (dedicated profile — NOT your normal Chrome)"
Write-Host ""

Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$profileDir`"",
  "--no-first-run",
  "--no-default-browser-check"
)

Write-Host "Chrome is starting. Add this line to mythos/.env, then start MYTHOS:" -ForegroundColor Green
Write-Host ""
Write-Host "  BROWSER_CDP_URL=http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host ""
Write-Host "MYTHOS will connect at boot (the 'browser-automation' step). Leave this Chrome window open."
