<#
.SYNOPSIS
    Launches Chrome or Edge with remote debugging enabled for MYTHOS browser automation.

.DESCRIPTION
    Finds an installed Chrome or Edge executable, creates a persistent debug profile
    directory, and launches the browser with --remote-debugging-port=9222 so that
    the MYTHOS browser-agent adapter can connect via CDP (Chrome DevTools Protocol).

.EXAMPLE
    .\setup-chrome-debug.ps1
#>

param(
    [int]$Port = 9222
)

$ErrorActionPreference = 'Stop'

# Profile directory - persistent so cookies/extensions survive across launches
$profileDir = Join-Path $env:LOCALAPPDATA 'MYTHOS\chrome-debug-profile'

if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Write-Host "Created debug profile directory: $profileDir"
}

# Find Chrome first, then Edge
$exe = $null

$chromePaths = @(
    "$env:PROGRAMFILES\Google\Chrome\Application\chrome.exe",
    "${env:PROGRAMFILES(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

foreach ($candidate in $chromePaths) {
    if (Test-Path $candidate) {
        $exe = $candidate
        break
    }
}

if (-not $exe) {
    $edgePaths = @(
        "$env:PROGRAMFILES\Microsoft\Edge\Application\msedge.exe",
        "${env:PROGRAMFILES(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($candidate in $edgePaths) {
        if (Test-Path $candidate) {
            $exe = $candidate
            break
        }
    }
}

if (-not $exe) {
    Write-Error "No Chrome or Edge installation found. Please install Google Chrome or Microsoft Edge."
    exit 1
}

$browserName = if ($exe -match 'chrome\.exe$') { 'Chrome' } else { 'Edge' }
Write-Host "Launching $browserName with remote debugging on port $Port ..."
Write-Host "  Executable : $exe"
Write-Host "  Profile    : $profileDir"
Write-Host "  Debug URL  : http://127.0.0.1:$Port"

Start-Process -FilePath $exe -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=`"$profileDir`""
)

Write-Host ""
Write-Host "SUCCESS: $browserName launched. MYTHOS browser-agent will connect to http://127.0.0.1:$Port"
