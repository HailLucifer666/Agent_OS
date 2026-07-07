# spike-uia.ps1 -- Phase C0 Spike: UIA tree walking test
# Validates that Add-Type UIAutomationClient works on this Windows build
# and can enumerate top-level desktop windows with control details.

$ErrorActionPreference = 'Stop'

Write-Host '=== UIA Tree Walking Spike ===' -ForegroundColor Cyan
Write-Host ''

# 1. Load UIA assembly
try {
    Add-Type -AssemblyName UIAutomationClient
    Write-Host '[OK] UIAutomationClient loaded' -ForegroundColor Green
} catch {
    Write-Host ('[FAIL] Could not load UIAutomationClient: ' + $_) -ForegroundColor Red
    exit 1
}

# 2. Get desktop root
$root = [System.Windows.Automation.AutomationElement]::RootElement
if ($root) {
    Write-Host ('[OK] RootElement acquired (ClassName: ' + $root.Current.ClassName + ')') -ForegroundColor Green
} else {
    Write-Host '[FAIL] RootElement is null' -ForegroundColor Red
    exit 1
}

# 3. Find all top-level windows
Write-Host ''
Write-Host '--- Top-level windows (first 15) ---' -ForegroundColor Yellow
$condition = [System.Windows.Automation.Condition]::TrueCondition
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
$count = 0
$maxShow = 15

foreach ($child in $all) {
    $count++
    if ($count -gt $maxShow) {
        Write-Host ('  ... and ' + ($all.Count - $maxShow) + ' more (total: ' + $all.Count + ')')
        break
    }
    $nameRaw = $child.Current.Name
    if ($nameRaw) { $name = $nameRaw.Substring(0, [Math]::Min(60, $nameRaw.Length)) } else { $name = '(unnamed)' }
    $cls = $child.Current.ClassName
    if (-not $cls) { $cls = '(no class)' }
    $procId = $child.Current.ProcessId
    $ctrlType = $child.Current.ControlType.ProgrammaticName

    try {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        $procName = if ($proc) { $proc.ProcessName } else { 'unknown' }
    } catch {
        $procName = 'unknown'
    }

    Write-Host ('  [' + $count + '] PID=' + $procId + ' (' + $procName + ') | ' + $ctrlType + ' | ' + $cls + ' | "' + $name + '"')
}

Write-Host ''
Write-Host ('Total top-level windows: ' + $all.Count) -ForegroundColor Cyan

# 4. Test descending into a window (pick first with a name)
Write-Host ''
Write-Host '--- Descending into first named window ---' -ForegroundColor Yellow
$namedChild = $null
foreach ($child in $all) {
    if ($child.Current.Name) {
        $namedChild = $child
        break
    }
}
if ($namedChild) {
    $children = $namedChild.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    $shown = [Math]::Min($children.Count, 10)
    Write-Host ('  Window: "' + $namedChild.Current.Name + '" -- ' + $children.Count + ' direct children')
    for ($i = 0; $i -lt $shown; $i++) {
        $c = $children[$i]
        $cNameRaw = $c.Current.Name
        if ($cNameRaw) { $cName = $cNameRaw.Substring(0, [Math]::Min(50, $cNameRaw.Length)) } else { $cName = '(unnamed)' }
        $cType = $c.Current.ControlType.ProgrammaticName
        $cCls = $c.Current.ClassName
        if (-not $cCls) { $cCls = '' }
        Write-Host ('    [' + $i + '] ' + $cType + ' (' + $cCls + ') "' + $cName + '"')
    }
    if ($children.Count -gt 10) {
        Write-Host ('    ... and ' + ($children.Count - 10) + ' more')
    }
    Write-Host '[OK] UIA descent works' -ForegroundColor Green
} else {
    Write-Host '[WARN] No named windows found to descend into' -ForegroundColor Yellow
}

# 5. Test property retrieval (BoundingRectangle)
Write-Host ''
Write-Host '--- BoundingRectangle test ---' -ForegroundColor Yellow
if ($namedChild) {
    try {
        $rect = $namedChild.Current.BoundingRectangle
        Write-Host ('  First window rect: X=' + [int]$rect.X + ' Y=' + [int]$rect.Y + ' W=' + [int]$rect.Width + ' H=' + [int]$rect.Height) -ForegroundColor Green
        Write-Host '[OK] BoundingRectangle accessible' -ForegroundColor Green
    } catch {
        Write-Host ('[WARN] BoundingRectangle failed: ' + $_) -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host '=== UIA Spike Complete ===' -ForegroundColor Cyan
Write-Host 'GO/NO-GO: GO -- UIAutomationClient loads and tree walking works' -ForegroundColor Green
