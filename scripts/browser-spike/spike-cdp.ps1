# setup-chrome-debug.ps1 -- Spike: Launch Chrome with remote debugging port
# Tests that Chrome can be started with --remote-debugging-port and that
# the CDP WebSocket endpoint is reachable.

$ErrorActionPreference = 'Stop'

$DEBUG_PORT = 9222
$CHROME_EXE = $null

# Find Chrome
$chromePaths = @(
    "${env:PROGRAMFILES}\Google\Chrome\Application\chrome.exe",
    "${env:PROGRAMFILES(X86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
)

foreach ($path in $chromePaths) {
    if (Test-Path $path) {
        $CHROME_EXE = $path
        break
    }
}

if (-not $CHROME_EXE) {
    Write-Host '[FAIL] Chrome not found in standard locations.' -ForegroundColor Red
    Write-Host 'Checked:' -ForegroundColor Yellow
    foreach ($path in $chromePaths) { Write-Host "  $path" }
    exit 1
}

Write-Host ('[OK] Chrome found: ' + $CHROME_EXE) -ForegroundColor Green

# Check if something is already on the debug port
$portInUse = Get-NetTCPConnection -LocalPort $DEBUG_PORT -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Host ('[WARN] Port ' + $DEBUG_PORT + ' already in use by PID ' + $portInUse.OwningProcess) -ForegroundColor Yellow
    Write-Host 'Attempting to use existing Chrome instance...' -ForegroundColor Yellow
} else {
    # Launch Chrome with debugging
    Write-Host ('Launching Chrome with --remote-debugging-port=' + $DEBUG_PORT) -ForegroundColor Cyan

    $proc = Start-Process -FilePath $CHROME_EXE -ArgumentList @(
        '--remote-debugging-port=' + $DEBUG_PORT,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
    ) -PassThru

    Write-Host ('[OK] Chrome launched (PID ' + $proc.Id + ')') -ForegroundColor Green
    Start-Sleep -Seconds 3
}

# Test CDP HTTP endpoint
try {
    $response = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $DEBUG_PORT + '/json/version') -ErrorAction Stop
    Write-Host '[OK] CDP version endpoint reachable' -ForegroundColor Green
    Write-Host ('  Browser: ' + $response.Browser) -ForegroundColor Cyan
    Write-Host ('  WebSocket URL: ' + $response.webSocketDebuggerUrl) -ForegroundColor Cyan
    Write-Host ('  User-Agent: ' + $response['User-Agent']) -ForegroundColor DarkGray

    # List available pages
    $pages = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $DEBUG_PORT + '/json') -ErrorAction Stop
    Write-Host ('[OK] ' + $pages.Count + ' pages available') -ForegroundColor Green
    foreach ($page in $pages) {
        $title = if ($page.title) { $page.title.Substring(0, [Math]::Min(50, $page.title.Length)) } else { '(no title)' }
        $url = if ($page.url) { $page.url.Substring(0, [Math]::Min(60, $page.url.Length)) } else { '(no url)' }
        Write-Host ('  - [' + $page.type + '] "' + $title + '" ' + $url) -ForegroundColor Cyan
    }
} catch {
    Write-Host ('[FAIL] CDP endpoint not reachable: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '=== Chrome CDP Spike Complete ===' -ForegroundColor Cyan
Write-Host 'GO/NO-GO: GO -- Chrome CDP is accessible' -ForegroundColor Green
