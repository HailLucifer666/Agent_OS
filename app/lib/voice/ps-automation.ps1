# ps-automation.ps1 -- PC automation module for Jarvis voice pipeline
# Long-running JSON-over-stdin process. Reads one JSON command per line from stdin,
# executes it, writes exactly one JSON response per line to stdout.
#
# Commands:
#   { "cmd": "launch_app", "name": "notepad" }
#   { "cmd": "list_windows" }
#   { "cmd": "focus_window", "pid": 12345 }
#   { "cmd": "close_window", "pid": 12345 }
#   { "cmd": "media_key", "key": "play_pause" }
#   { "cmd": "screen_look", "query": "describe this" }
#   { "cmd": "ui_elements", "pid": 12345, "depth": 3 }
#   { "cmd": "ui_click", "pid": 12345, "elementPath": ["0","2","1"] }
#   { "cmd": "ui_type", "text": "hello world" }
#   { "cmd": "ui_type", "text": "hello world", "pid": 12345, "elementPath": ["0","2","1"] }
#   { "cmd": "write_note", "text": "remember this", "title": "My Note" }
#   { "cmd": "ping" }
#
# Response shape:
#   { "ok": true, "result": <any> }
#   { "ok": false, "error": "reason string" }

$ErrorActionPreference = 'Continue'

# ---- P/Invoke Setup ----
# Load UIA and define SendInput types once at startup
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NativeInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion u;
    }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT {
        public uint uMsg; public ushort wParamL; public ushort wParamH;
    }
    public const uint INPUT_KEYBOARD = 1;
    public const uint INPUT_MOUSE = 0;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern short VkKeyScan(char ch);

    public const int SW_RESTORE = 9;
}
'@ -Language CSharp

# ---- Helpers ----

function Write-Response($ok, $resultOrError) {
    if ($ok) {
        $json = ConvertTo-Json -Depth 8 -Compress @{ ok = $true; result = $resultOrError }
    } else {
        $json = ConvertTo-Json -Depth 8 -Compress @{ ok = $false; error = $resultOrError }
    }
    # Ensure single line output (no newlines from ConvertTo-Json)
    $json = $json -replace "`r`n", ' ' -replace "`n", ' '
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Get-RectBounds($rect) {
    $x = if ([double]::IsInfinity($rect.X)) { -1 } else { [int]$rect.X }
    $y = if ([double]::IsInfinity($rect.Y)) { -1 } else { [int]$rect.Y }
    $w = if ([double]::IsInfinity($rect.Width) -or $rect.Width -lt 0) { 0 } else { [int]$rect.Width }
    $h = if ([double]::IsInfinity($rect.Height) -or $rect.Height -lt 0) { 0 } else { [int]$rect.Height }
    return @{ x = $x; y = $y; width = $w; height = $h }
}

function Send-VkKey($vk) {
    $inputs = @(
        (New-Object 'NativeInput+INPUT'),
        (New-Object 'NativeInput+INPUT')
    )
    $inputs[0].type = [NativeInput]::INPUT_KEYBOARD
    $inputs[0].u.ki.wVk = $vk
    $inputs[0].u.ki.dwFlags = 0
    $inputs[1].type = [NativeInput]::INPUT_KEYBOARD
    $inputs[1].u.ki.wVk = $vk
    $inputs[1].u.ki.dwFlags = [NativeInput]::KEYEVENTF_KEYUP
    [void][NativeInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
}

# Media key VK codes
$MEDIA_KEYS = @{
    play_pause = 0xB3
    next_track = 0xB0
    prev_track = 0xB1
    volume_up  = 0xAF
    volume_down = 0xAE
    volume_mute = 0xAD
}

function Send-MediaKey($keyName) {
    $vk = $MEDIA_KEYS[$keyName]
    if (-not $vk) {
        return @("Unknown media key: $keyName. Valid: $($MEDIA_KEYS.Keys -join ', ')")
    }
    Send-VkKey $vk
    return $null
}

function Send-UnicodeText($text) {
    # Send each character as a Unicode key event pair (down + up)
    foreach ($ch in $text.ToCharArray()) {
        $inputs = @(
            (New-Object 'NativeInput+INPUT'),
            (New-Object 'NativeInput+INPUT')
        )
        $inputs[0].type = [NativeInput]::INPUT_KEYBOARD
        $inputs[0].u.ki.wScan = [int]$ch
        $inputs[0].u.ki.dwFlags = [NativeInput]::KEYEVENTF_UNICODE
        $inputs[1].type = [NativeInput]::INPUT_KEYBOARD
        $inputs[1].u.ki.wScan = [int]$ch
        $inputs[1].u.ki.dwFlags = [NativeInput]::KEYEVENTF_UNICODE -bor [NativeInput]::KEYEVENTF_KEYUP
        [void][NativeInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
        # Small delay between characters to avoid overwhelming the target
        Start-Sleep -Milliseconds 5
    }
}

# ---- Command Handlers ----

function Handle-LaunchApp($name) {
    if (-not $name) { return 'App name is required.' }
    # Try Start-Process with the name
    try {
        $proc = Start-Process -FilePath $name -PassThru -ErrorAction Stop
        Start-Sleep -Milliseconds 500
        # Return basic info
        $info = @{ pid = $proc.Id; name = $name }
        return $info
    } catch {
        # If direct launch fails, try explorer/Open-With
        try {
            Start-Process -FilePath "explorer.exe" -ArgumentList $name -ErrorAction Stop
            Start-Sleep -Milliseconds 500
            return @{ name = $name; launched = $true; note = 'opened via explorer' }
        } catch {
            return ('Failed to launch "' + $name + '": ' + $_.Exception.Message)
        }
    }
}

function Handle-ListWindows {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    $windows = @()
    foreach ($child in $all) {
        $procId = $child.Current.ProcessId
        $name = $child.Current.Name
        $cls = $child.Current.ClassName
        $rect = Get-RectBounds $child.Current.BoundingRectangle
        try {
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
            $procName = if ($proc) { $proc.ProcessName } else { 'unknown' }
        } catch { $procName = 'unknown' }
        $windows += @{
            pid = $procId
            processName = $procName
            title = $name
            className = $cls
            rect = $rect
            visible = ($rect.width -gt 0 -and $rect.height -gt 0)
        }
    }
    return @{ windows = $windows; total = $all.Count }
}

function Handle-FocusWindow($pid) {
    if (-not $pid) { return 'PID is required.' }
    try {
        $proc = Get-Process -Id $pid -ErrorAction Stop
        $hwnd = $proc.MainWindowHandle
        if ($hwnd -eq [IntPtr]::Zero) {
            return ('Process ' + $pid + ' has no main window.')
        }
        # Restore if minimized, then bring to foreground
        [NativeInput]::ShowWindow($hwnd, [NativeInput]::SW_RESTORE) | Out-Null
        Start-Sleep -Milliseconds 100
        [NativeInput]::SetForegroundWindow($hwnd) | Out-Null
        return @{ pid = $pid; focused = $true }
    } catch {
        return ('Cannot focus PID ' + $pid + ': ' + $_.Exception.Message)
    }
}

function Handle-CloseWindow($pid) {
    if (-not $pid) { return 'PID is required.' }
    try {
        $proc = Get-Process -Id $pid -ErrorAction Stop
        $proc.CloseMainWindow() | Out-Null
        # Wait briefly for graceful close
        $closed = $proc.WaitForExit(3000)
        if ($closed) {
            return @{ pid = $pid; closed = $true; graceful = $true }
        } else {
            return @{ pid = $pid; closed = $false; note = 'Window did not close gracefully in 3s' }
        }
    } catch {
        return ('Cannot close PID ' + $pid + ': ' + $_.Exception.Message)
    }
}

function Handle-MediaKey($key) {
    if (-not $key) { return 'Key name is required.' }
    $err = Send-MediaKey $key
    if ($err) { return $err }
    return @{ key = $key; sent = $true }
}

function Handle-ScreenLook($query) {
    # Capture full screen screenshot as base64
    # The Node.js bridge (pc-child.js) will handle the VLM vision call.
    # This command only returns the raw base64 image data.
    try {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $gfx.Dispose()
        $bmp.Dispose()
        $b64 = [System.Convert]::ToBase64String($ms.ToArray())
        $ms.Dispose()
        return @{ base64 = $b64; width = $bounds.Width; height = $bounds.Height; format = 'png' }
    } catch {
        return ('Screenshot failed: ' + $_.Exception.Message)
    }
}

function Handle-UiElements($pid, $depth) {
    if (-not $depth) { $depth = 2 }
    try {
        $proc = Get-Process -Id $pid -ErrorAction Stop
        $hwnd = $proc.MainWindowHandle
        if ($hwnd -eq [IntPtr]::Zero) {
            return ('Process ' + $pid + ' has no main window.')
        }
        # Get the window element from UIA
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $pid
        )
        $windowEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
        if (-not $windowEl) {
            return ('No UIA window found for PID ' + $pid)
        }
        $elements = @()
        Walk-UIA -Element $windowEl -Depth 0 -MaxDepth $depth -Elements ([ref]$elements) -Path @()
        return @{ elements = $elements; pid = $pid }
    } catch {
        return ('UIA tree walk failed for PID ' + $pid + ': ' + $_.Exception.Message)
    }
}

function Walk-UIA($Element, $Depth, $MaxDepth, [ref]$Elements, $Path) {
    if ($Depth -ge $MaxDepth) { return }
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $children = $Element.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    for ($i = 0; $i -lt $children.Count; $i++) {
        $c = $children[$i]
        $cName = if ($c.Current.Name) { $c.Current.Name } else { $null }
        $cType = $c.Current.ControlType.ProgrammaticName
        $cCls = $c.Current.ClassName
        $cRect = Get-RectBounds $c.Current.BoundingRectangle
        $cId = $c.Current.AutomationId
        $cVal = try { $c.Current.Value.Value } catch { $null }
        $cEnabled = $c.Current.IsEnabled
        $childPath = $Path + @([string]$i)

        $elInfo = @{
            index = $i
            type = $cType
            name = $cName
            className = $cCls
            automationId = $cId
            value = $cVal
            enabled = $cEnabled
            rect = $cRect
            path = $childPath
        }
        $Elements.Value += $elInfo

        Walk-UIA -Element $c -Depth ($Depth + 1) -MaxDepth $MaxDepth -Elements $Elements -Path $childPath
    }
}

function Handle-UiClick($pid, $elementPath) {
    if (-not $elementPath) { return 'elementPath is required.' }
    try {
        $element = Resolve-UIAElement -Pid $pid -ElementPath $elementPath
        if ($element.error) { return $element.error }
        $el = $element.element

        # Get Invoke pattern if available, otherwise use SetFocus + click rect
        $invoked = $false
        try {
            $invokePattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) -as [System.Windows.Automation.InvokePattern]
            if ($invokePattern) {
                $invokePattern.Invoke()
                $invoked = $true
            }
        } catch { /* no invoke pattern */ }

        if (-not $invoked) {
            # Fall back to clicking the center of the element's bounding rect
            $rect = $el.Current.BoundingRectangle
            $cx = [int]($rect.X + $rect.Width / 2)
            $cy = [int]($rect.Y + $rect.Height / 2)
            Click-AtScreenCoords $cx $cy
        }

        return @{ clicked = $true; invoked = $invoked; path = $elementPath }
    } catch {
        return ('Click failed: ' + $_.Exception.Message)
    }
}

function Handle-UiType($text, $pid, $elementPath) {
    if (-not $text) { return 'Text is required.' }
    try {
        # If a target element is specified, try to set focus there first
        if ($pid -and $elementPath) {
            $element = Resolve-UIAElement -Pid $pid -ElementPath $elementPath
            if (-not $element.error) {
                $element.element.SetFocus()
                Start-Sleep -Milliseconds 50
            }
        }
        Send-UnicodeText $text
        return @{ typed = $true; length = $text.Length }
    } catch {
        return ('Type failed: ' + $_.Exception.Message)
    }
}

function Resolve-UIAElement($pid, $elementPath) {
    try {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $pid
        )
        $windowEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
        if (-not $windowEl) {
            return @{ error = ('No UIA window found for PID ' + $pid) }
        }
        $current = $windowEl
        $treeCondition = [System.Windows.Automation.Condition]::TrueCondition
        foreach ($idx in $elementPath) {
            $children = $current.FindAll([System.Windows.Automation.TreeScope]::Children, $treeCondition)
            $i = [int]$idx
            if ($i -ge 0 -and $i -lt $children.Count) {
                $current = $children[$i]
            } else {
                return @{ error = ('Element path index ' + $idx + ' out of range (parent has ' + $children.Count + ' children)') }
            }
        }
        return @{ element = $current }
    } catch {
        return @{ error = ('Element resolution failed: ' + $_.Exception.Message) }
    }
}

function Click-AtScreenCoords($x, $y) {
    # SendInput absolute move + left click
    # Normalize to 0-65535 range for MOUSEEVENTF_ABSOLUTE
    $screenW = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $screenH = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
    $normX = [int]($x * 65535 / $screenW)
    $normY = [int]($y * 65535 / $screenH)

    $inputs = @(
        (New-Object 'NativeInput+INPUT'),   # move
        (New-Object 'NativeInput+INPUT'),   # left down
        (New-Object 'NativeInput+INPUT')    # left up
    )

    $inputs[0].type = [NativeInput]::INPUT_MOUSE
    $inputs[0].u.mi.dx = $normX
    $inputs[0].u.mi.dy = $normY
    $inputs[0].u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_MOVE -bor [NativeInput]::MOUSEEVENTF_ABSOLUTE

    $inputs[1].type = [NativeInput]::INPUT_MOUSE
    $inputs[1].u.mi.dx = 0
    $inputs[1].u.mi.dy = 0
    $inputs[1].u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_LEFTDOWN

    $inputs[2].type = [NativeInput]::INPUT_MOUSE
    $inputs[2].u.mi.dx = 0
    $inputs[2].u.mi.dy = 0
    $inputs[2].u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_LEFTUP

    [void][NativeInput]::SendInput(3, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
}

function Handle-WriteNote($text, $title) {
    if (-not $text) { return 'Note text is required.' }
    try {
        # Use sticky notes or simple file-based approach
        # Write to user's Notes folder as a .txt file
        $notesDir = Join-Path $env:USERPROFILE 'NOVA-Notes'
        if (-not (Test-Path $notesDir)) {
            New-Item -ItemType Directory -Path $notesDir -Force | Out-Null
        }
        $safeTitle = if ($title) { ($title -replace '[<>:"/\\|?*]', '_') } else { ('note_' + (Get-Date -Format 'yyyyMMdd_HHmmss')) }
        $fileName = $safeTitle + '.txt'
        $filePath = Join-Path $notesDir $fileName
        Set-Content -Path $filePath -Value $text -Encoding UTF8
        return @{ saved = $true; path = $filePath; title = $safeTitle }
    } catch {
        return ('Write note failed: ' + $_.Exception.Message)
    }
}

# ---- Main Loop ----
# Read JSON lines from stdin, process, write JSON lines to stdout
$reader = [Console]::In

while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }  # EOF / stdin closed

    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }

    $cmd = $null
    try {
        $cmd = ConvertFrom-Json -InputObject $line -ErrorAction Stop
    } catch {
        Write-Response $false ('Invalid JSON: ' + $_.Exception.Message)
        continue
    }

    $command = $cmd.cmd
    if (-not $command) {
        Write-Response $false 'Missing "cmd" field.'
        continue
    }

    $result = $null
    $err = $null

    switch ($command) {
        'ping' {
            $result = @{ pong = $true; pid = $PID; timestamp = (Get-Date -Format 'o') }
        }
        'launch_app' {
            $result = Handle-LaunchApp $cmd.name
        }
        'list_windows' {
            $result = Handle-ListWindows
        }
        'focus_window' {
            $result = Handle-FocusWindow $cmd.pid
        }
        'close_window' {
            $result = Handle-CloseWindow $cmd.pid
        }
        'media_key' {
            $result = Handle-MediaKey $cmd.key
        }
        'screen_look' {
            $result = Handle-ScreenLook $cmd.query
        }
        'ui_elements' {
            $result = Handle-UiElements $cmd.pid $cmd.depth
        }
        'ui_click' {
            $result = Handle-UiClick $cmd.pid $cmd.elementPath
        }
        'ui_type' {
            $result = Handle-UiType $cmd.text $cmd.pid $cmd.elementPath
        }
        'write_note' {
            $result = Handle-WriteNote $cmd.text $cmd.title
        }
        default {
            $err = ('Unknown command: ' + $command)
        }
    }

    if ($err) {
        Write-Response $false $err
    } else {
        Write-Response $true $result
    }
}
