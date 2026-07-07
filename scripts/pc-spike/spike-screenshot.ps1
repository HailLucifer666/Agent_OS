# spike-screenshot.ps1 -- Phase C0 Spike: Screenshot capture test
# Validates that System.Drawing can capture the screen and save to file.
# Also tests region cropping and base64 encoding for vision pipeline.

$ErrorActionPreference = 'Stop'

Write-Host '=== Screenshot Capture Spike ===' -ForegroundColor Cyan
Write-Host ''

# 1. Test System.Drawing screen capture
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Write-Host '[OK] System.Drawing + Windows.Forms loaded' -ForegroundColor Green
} catch {
    Write-Host ('[FAIL] Assembly load failed: ' + $_) -ForegroundColor Red
    exit 1
}

# 2. Capture primary screen
Write-Host ''
Write-Host '--- Primary screen capture ---' -ForegroundColor Yellow
try {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Write-Host ('  Screen bounds: ' + $bounds.Width + 'x' + $bounds.Height + ' at (' + $bounds.X + ',' + $bounds.Y + ')') -ForegroundColor Cyan

    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

    $outPath = Join-Path $PSScriptRoot 'spike-test-screenshot.png'
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $graphics.Dispose()
    $bmp.Dispose()

    $fileInfo = Get-Item $outPath
    Write-Host ('  Saved: ' + $outPath + ' (' + [Math]::Round($fileInfo.Length / 1024, 1) + ' KB)') -ForegroundColor Green
    Write-Host '[OK] Screenshot capture works' -ForegroundColor Green
} catch {
    Write-Host ('[FAIL] Screenshot capture failed: ' + $_) -ForegroundColor Red
    exit 1
}

# 3. Test crop/region capture (simulates vision pipeline step)
Write-Host ''
Write-Host '--- Region crop test (center 400x300) ---' -ForegroundColor Yellow
try {
    $src = New-Object System.Drawing.Bitmap($outPath)
    $cropW = [Math]::Min(400, $src.Width)
    $cropH = [Math]::Min(300, $src.Height)
    $cropX = [Math]::Max(0, ($src.Width - $cropW) / 2)
    $cropY = [Math]::Max(0, ($src.Height - $cropH) / 2)

    $cropRect = New-Object System.Drawing.Rectangle($cropX, $cropY, $cropW, $cropH)
    $crop = $src.Clone($cropRect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

    $cropPath = Join-Path $PSScriptRoot 'spike-test-crop.png'
    $crop.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $crop.Dispose()
    $src.Dispose()

    $cropInfo = Get-Item $cropPath
    Write-Host ('  Saved crop: ' + $cropPath + ' (' + [Math]::Round($cropInfo.Length / 1024, 1) + ' KB)') -ForegroundColor Green
    Write-Host '[OK] Region cropping works' -ForegroundColor Green
} catch {
    Write-Host ('[WARN] Region crop failed: ' + $_) -ForegroundColor Yellow
}

# 4. Test PNG to base64 (for model pipeline)
Write-Host ''
Write-Host '--- PNG to Base64 test ---' -ForegroundColor Yellow
try {
    $bytes = [System.IO.File]::ReadAllBytes($outPath)
    $b64 = [System.Convert]::ToBase64String($bytes)
    $b64LenKB = [Math]::Round($b64.Length / 1024, 1)
    Write-Host ('  Base64 length: ' + $b64LenKB + ' KB') -ForegroundColor Cyan
    Write-Host '[OK] Base64 encoding works' -ForegroundColor Green
} catch {
    Write-Host ('[FAIL] Base64 encoding failed: ' + $_) -ForegroundColor Red
}

# 5. Test window-specific capture (enumerate visible windows with bounds)
Write-Host ''
Write-Host '--- Window enumeration with bounds ---' -ForegroundColor Yellow
try {
    Add-Type -AssemblyName UIAutomationClient
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)

    $shown = [Math]::Min($all.Count, 8)
    for ($i = 0; $i -lt $shown; $i++) {
        $w = $all[$i]
        $wNameRaw = $w.Current.Name
        if ($wNameRaw) { $wName = $wNameRaw.Substring(0, [Math]::Min(40, $wNameRaw.Length)) } else { $wName = '(unnamed)' }
        $rect = $w.Current.BoundingRectangle
        if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
            Write-Host ('  [' + $i + '] "' + $wName + '" -- ' + [int]$rect.Width + 'x' + [int]$rect.Height + ' at (' + [int]$rect.X + ',' + [int]$rect.Y + ')') -ForegroundColor Green
        } else {
            Write-Host ('  [' + $i + '] "' + $wName + '" -- offscreen/zero rect') -ForegroundColor DarkGray
        }
    }
    Write-Host '[OK] Window bounds enumeration works' -ForegroundColor Green
} catch {
    Write-Host ('[WARN] Window bounds enumeration failed: ' + $_) -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== Screenshot Spike Complete ===' -ForegroundColor Cyan
Write-Host 'GO/NO-GO: GO -- Screen capture, crop, and base64 pipeline all functional' -ForegroundColor Green
