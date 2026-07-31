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
#   { "cmd": "send_key", "key": "enter" }
#   { "cmd": "click_at", "x": 500, "y": 300 }
#   { "cmd": "show_desktop" }
#
# Response shape:
#   { "ok": true, "result": <any> }
#   { "ok": false, "error": "reason string" }

$ErrorActionPreference = 'Continue'

# ---- Console I/O encoding ----
# BUG-038 (real root cause, confirmed byte-exact 2026-07-17): PowerShell 5.1 writes
# stdout in the OEM codepage by default. That codepage "best-fits" curly Unicode
# quotes (U+201C/U+201D -- common in Spotify/browser metadata) down to the ASCII
# double-quote (0x22) in transit. ConvertTo-Json legally leaves curly quotes
# unescaped, so a VALID JSON line leaves this process but arrives at the Node parent
# as INVALID JSON (unescaped " inside a string value). Node drops the line as
# diagnostic noise, the command burns its full 15s timeout, and -- because this child
# processes one command at a time -- the media widget's 5s polling permanently jams
# the queue and starves every other PC tool. This was previously misdiagnosed as a
# thumbnail-extraction "hang" (BUG-038). Fix layer 1: emit UTF-8 so nothing is
# best-fitted. (Layer 2 is ASCII-safe escaping in Write-Response below.)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ---- DPI awareness ----
# BUG-026 (4th attempt, part A): PowerShell 5.1 is not DPI-aware by default. On any display scaled
# above 100%, that leaves UIA's BoundingRectangle (queried against DPI-aware target
# apps, which report true physical-pixel coordinates) out of sync with this process's
# own unaware/virtualized view of the screen -- Click-AtScreenCoords and Screen.Bounds
# below then normalize against the wrong scale and clicks land in the wrong spot. Must
# run before any UIA/Screen/SendInput usage, so it's the very first thing after startup.
#
# RESTORED (2026-07-16): this block, click_at, and the WinRT fix below were dropped by
# a concurrent session's commit that branched from an older snapshot of this file and
# didn't carry them forward. Re-applied after confirming via diff exactly what was lost.
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class DpiHelper {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(int dpiFlag);
}
'@
[void][DpiHelper]::SetProcessDpiAwarenessContext(-4) # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2

# ---- P/Invoke Setup ----
# Load UIA and define SendInput types once at startup
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# ---- WinRT async bridging ----
# BUG-004: IAsyncOperation<T> (WinRT) does NOT implement .Wait()/.Result the way a
# real System.Threading.Tasks.Task does. Calling .Wait() directly on a raw WinRT
# operation throws at runtime. Reflectively invoke the generic AsTask<TResult>
# extension from System.WindowsRuntimeSystemExtensions to bridge to a real Task first,
# then .Wait()/.Result on THAT.
#
# BUG-004 (regression, 3rd pass -- root cause confirmed live, not theorized): the
# object returned by a WinRT static async method obtained via [Type]::GetType(...)
# comes back as a raw late-bound System.__ComObject, not a strongly-typed managed
# proxy. .GetType().GetInterfaces() on a System.__ComObject returns an EMPTY array --
# .NET reflection cannot discover COM-interop objects' implemented interfaces this way.
# So an approach that tries to derive $resultType via
# `$WinRtOp.GetType().GetInterface('IAsyncOperation``1')` always returns $null, and
# .GetGenericArguments() on that null throws "You cannot call a method on a
# null-valued expression." -- confirmed by direct reproduction in a live PowerShell
# session against this machine's real SMTC session before writing this fix, and the
# fix itself was confirmed live too (GET /api/media returned real title/artist/album
# while a track was playing). RESTORED (2026-07-16) after a concurrent session's
# commit replaced this with an unverified polling rewrite of its own (its own commit
# message called it "diagnosed, not yet fixed") -- keeping the proven version.
# Fix: the caller always statically knows the expected result type already (it's
# resolved the exact same way $type is above, via [Type]::GetType(...,
# ContentType=WindowsRuntime)) -- so require it explicitly instead of trying to
# infer it from an object that can't be reflected.
$AsTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await-WinRTOperation($WinRtOp, [type]$ResultType) {
    $task = $AsTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtOp))
    $task.Wait()
    return $task.Result
}

# BUG-004 (2nd latent bug, found live): a WinRT IRandomAccessStream (e.g. the album-art
# thumbnail from GlobalSystemMediaTransportControlsSessionMediaProperties.Thumbnail)
# comes back as the same unreflectable System.__ComObject -- it has no .GetBuffer()
# method (that only exists on IBuffer, a different type). Confirmed live: a track with
# no thumbnail never hit this path, so it went unnoticed until a track WITH album art
# was tested -- likely the actual cause of "widget goes blank after the song changes"
# (first track had no art, next one did, and the whole media_status call threw).
# Fix: bridge the WinRT stream to a real .NET System.IO.Stream via the
# AsStreamForRead(IInputStream) extension (System.IO.WindowsRuntimeStreamExtensions,
# same assembly as AsTask above), then read it with ordinary .NET Stream.Read().
$AsStreamForRead = ([System.WindowsRuntimeSystemExtensions].Assembly.GetTypes() |
    Where-Object { $_.FullName -eq 'System.IO.WindowsRuntimeStreamExtensions' }
).GetMethods() | Where-Object {
    $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
} | Select-Object -First 1

function Read-WinRTStreamBytes($WinRtStream) {
    $netStream = $AsStreamForRead.Invoke($null, @($WinRtStream))
    # Use the converted .NET stream's Length, not the WinRT COM object's .Size --
    # property access on the raw System.__ComObject is unreliable the same way
    # method/interface reflection on it is (confirmed live: .Size read back empty).
    $bytes = New-Object byte[] $netStream.Length
    $total = 0
    while ($total -lt $bytes.Length) {
        $n = $netStream.Read($bytes, $total, $bytes.Length - $total)
        if ($n -le 0) { break }
        $total += $n
    }
    return $bytes
}

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
    public const uint MOUSEEVENTF_WHEEL = 0x0800;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern short VkKeyScan(char ch);

    // Phase 3: window move/resize/snap. SetWindowPos is the lower-level call
    // (flags control what changes); MoveWindow is a convenience wrapper. Both
    // repaint after the move.
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, [MarshalAs(UnmanagedType.Bool)] bool bRepaint);

    // GetWindowRect fills a RECT with the window's screen coordinates. Used by
    // snap_window to compute half-rect targets and by the test oracle.
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    // V8 (Phase 4): active-window sensor. GetForegroundWindow returns the HWND
    // of the window the user is currently interacting with; GetWindowText reads
    // its title; GetWindowThreadProcessId gives us the PID so we can resolve
    // the process name via Get-Process.
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    // FIX 2: Windows' foreground-lock silently denies SetForegroundWindow from
    // a process that isn't attached to the current foreground thread's input
    // queue. AttachThreadInput bridges that gap for the duration of the call;
    // GetCurrentThreadId identifies this (the pc-child) thread as the attach
    // target.
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool fAttach);

    public const int SW_RESTORE = 9;
    public const int SW_MINIMIZE = 6;
    public const int SW_MAXIMIZE = 3;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;

    // §7.7 (step 5, desktop gaps) — wallpaper engine. SPI_SETDESKWALLPAPER
    // (0x0014) with SPIF_UPDATEINIFILE|SPIF_SENDCHANGE (0x03) persists the
    // change across reboots and broadcasts WM_SETTINGCHANGE so other apps
    // (Explorer) pick it up immediately.
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, string pvParam, uint fWinIni);
    public const uint SPI_SETDESKWALLPAPER = 0x0014;
    public const uint SPIF_UPDATEINIFILE = 0x01;
    public const uint SPIF_SENDCHANGE = 0x02;

    // Same export, integer pvParam. Needed for the foreground-lock timeout,
    // whose pvParam is a value, not a string — the declaration above marshals
    // pvParam as a string and cannot express it.
    [DllImport("user32.dll", SetLastError = true, EntryPoint = "SystemParametersInfoW", CharSet = CharSet.Unicode)]
    public static extern bool SystemParametersInfoValue(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
    public const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
    public const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
}
'@ -Language CSharp

# ---- Helpers ----

function Write-Response($ok, $resultOrError) {
    # Echo the current command's id (set by the main loop) so the Node parent can
    # correlate responses to commands — a late response from a timed-out command
    # must never be matched to the next command in flight.
    if ($ok) {
        $payload = @{ ok = $true; result = $resultOrError }
    } else {
        $payload = @{ ok = $false; error = $resultOrError }
    }
    if ($null -ne $script:CurrentCmdId) { $payload.id = $script:CurrentCmdId }
    $json = ConvertTo-Json -Depth 8 -Compress $payload
    # Ensure single line output (no newlines from ConvertTo-Json)
    $json = $json -replace "`r`n", ' ' -replace "`n", ' '
    # BUG-038 fix layer 2: escape every non-ASCII char as \uXXXX so the emitted line
    # is pure ASCII and survives ANY console/pipe encoding intact. \uXXXX inside JSON
    # strings is always valid, and non-ASCII never appears in JSON structural syntax,
    # so a blanket replace on the serialized text is safe.
    $json = [System.Text.RegularExpressions.Regex]::Replace($json, '[^\x20-\x7E]', {
        param($m) '\u{0:x4}' -f [int][char]$m.Value
    })
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
    # Capture SendInput's return (count of events actually injected) into a
    # script-scope var instead of [void]-discarding it, so callers can tell a
    # silent no-op (0 = blocked by UIPI/higher-integrity foreground) from a
    # real keypress. Assigned (not emitted) so void callers stay unaffected.
    $script:LastVkSent = [NativeInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
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

# Drive transport (play/pause, next, previous) via the SAME SMTC session the
# media_status read path uses. This controls the active media app directly and
# does NOT depend on SendInput / foreground focus / integrity level — the
# fragile path the global media keys were silently failing on. Returns $true on
# success or an error string on failure (caller can then fall back to VK keys).
function Send-SmtcControl($action) {
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
        $type = [Type]::GetType('Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
        if (-not $type) { return 'SMTC API not available' }
        $mgrOp = $type::RequestAsync()
        $mgr = Await-WinRTOperation $mgrOp $type
        if (-not $mgr) { return 'Failed to get SMTC session manager' }
        $session = $mgr.GetCurrentSession()
        if (-not $session) { return 'No active media session' }
        $op = $null
        switch ($action) {
            'toggle' { $op = $session.TryTogglePlayPauseAsync() }
            'next'   { $op = $session.TrySkipNextAsync() }
            'prev'   { $op = $session.TrySkipPreviousAsync() }
            default  { return "Unknown SMTC action: $action" }
        }
        # Try*Async() return IAsyncOperation<bool>; await the boolean result.
        $result = Await-WinRTOperation $op ([bool])
        if ($result) { return $true }
        return 'SMTC control returned false (session rejected the command)'
    } catch {
        return ('SMTC control failed: ' + $_.Exception.Message)
    }
}

function Send-UnicodeText($text) {
    # Accumulates SendInput's actual injected-event count into $script:LastVkSent
    # (same honest-failure pattern as Send-VkKey/BUG-042) so callers can tell a
    # silently-blocked type (UIPI/higher-integrity foreground) from a real one.
    $script:LastVkSent = 0
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
        $script:LastVkSent += [NativeInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
        # Small delay between characters to avoid overwhelming the target
        Start-Sleep -Milliseconds 5
    }
}

# ---- Command Handlers ----

# FIX 7: env-derived, portable app-path resolution chain. KnownApps' per-user
# paths go stale the moment an app is reinstalled via a different channel —
# e.g. Slack installed as a Microsoft Store package is registered under
# HKCU:\...\App Paths\slack.exe, not %LOCALAPPDATA%. No machine-specific path
# is ever hardcoded here (portability rule).
function Resolve-AppPathFromRegistry($name) {
    $exeName = if ($name -match '\.exe$') { $name } else { $name + '.exe' }
    $roots = @(
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
    )
    foreach ($root in $roots) {
        try {
            $key = Get-Item -Path (Join-Path $root $exeName) -ErrorAction Stop
            $resolved = $key.GetValue('')
            if ($resolved -and (Test-Path -LiteralPath $resolved)) { return $resolved }
        } catch { }
    }
    return $null
}

function Resolve-AppViaStartApps($name) {
    try {
        $match = Get-StartApps -ErrorAction Stop | Where-Object { $_.Name -like "*$name*" } | Select-Object -First 1
        if ($match) { return $match.AppID }
    } catch { }
    return $null
}

# FIX 6: known desktop-app resolver. Several common apps install to per-user
# AppData paths with no PATH entry and no registered "App Path" — Start-Process
# -FilePath "<name>" can't resolve them, so they fell through to the generic
# attempt below and failed (or, before FIX 4, silently opened File Explorer /
# a browser search instead). Env-derived only (portability rule — no hardcoded
# user paths), so this resolves correctly for any installed user's account.
# Keep this list short; easy to extend.
$script:KnownApps = @{
    'slack'   = @{ path = (Join-Path $env:LOCALAPPDATA 'slack\slack.exe') }
    'discord' = @{ path = (Join-Path $env:LOCALAPPDATA 'Discord\Update.exe'); args = @('--processStart', 'Discord.exe'); procName = 'Discord' }
    'teams'   = @{ path = (Join-Path $env:LOCALAPPDATA 'Microsoft\Teams\current\Teams.exe') }
}

# BUG-notepad-typing: MSIX/UWP-packaged apps (confirmed live: Windows 11's
# Microsoft.WindowsNotepad package) resolve through a thin registry-App-Paths
# or generic Start-Process launcher that hands activation off via COM and
# exits within about a second — Start-Process's own -PassThru handle then
# refers to a pid that is already gone by the time any subsequent
# focus_window/ui_type call tries to use it, so those calls fail (or worse,
# silently act on whatever unrelated window happens to have OS focus). This
# is the same class of bug the AUDIT FIX below already solved for Squirrel-
# style bootstrappers (Discord/Slack/Teams) by re-resolving the real process
# by name after launch — generalized here for any launch path that can hit
# it, not just the KnownApps table.
function Resolve-RealProcessAfterLaunch($StartedProc, $Name) {
    # A bare "does the pid still exist" check is not enough: some single-
    # instance packaged apps (confirmed live: Windows 11's Notepad) spawn a
    # genuinely new, persistently-running process on a second launch that
    # NEVER acquires its own top-level window at all -- activation is instead
    # handed to whichever same-named process already owns a window. Poll
    # briefly for the started pid to gain a real window (covers the normal
    # case, including packaged apps that are just slow to create one), then
    # fall back to any same-named process that already has one.
    for ($i = 0; $i -lt 6; $i++) {
        try {
            $p = Get-Process -Id $StartedProc.Id -ErrorAction Stop
            if ($p.MainWindowHandle -ne 0) { return $p.Id }
        } catch {
            break
        }
        Start-Sleep -Milliseconds 300
    }
    $named = Get-Process -Name $Name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($named) { return $named.Id }
    return $null
}

# Resolve a windowed process for an app by NAME ALONE, with no started process to
# start from. Needed for the shell:AppsFolder launch path (Store/MSIX apps such as
# Windows 11 Notepad and WhatsApp), which used to return no pid at all -- and a
# missing pid is not cosmetic: from-pc.js then cannot foreground the target, so
# ui_type falls back to "type into whatever has focus", which after a human clicks
# Approve in the dashboard is MYTHOS's own window. That is the reproduced
# wrong-window typing bug.
#
# Polls because packaged-app activation is asynchronous: the window belongs to a
# process that may not exist yet when Start-Process returns. Matches on process
# name first, then window title, so "whatsapp" finds the WhatsApp process and
# "notepad" finds Notepad. Never throws: StartTime is access-denied on protected
# processes, so ordering is by pid (newer processes get higher pids) rather than
# by start time.
function Resolve-WindowedProcessByName($Name, $TimeoutMs) {
    if (-not $Name) { return $null }
    if (-not $TimeoutMs) { $TimeoutMs = 6000 }
    $needle = ([string]$Name).Trim()
    if ($needle.ToLowerInvariant().EndsWith('.exe')) { $needle = $needle.Substring(0, $needle.Length - 4) }
    $needle = $needle -replace '\s', ''
    if (-not $needle) { return $null }

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $windowed = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
            # Exact process-name match wins, then a partial one, then window title.
            $hit = $windowed | Where-Object { ($_.ProcessName -replace '\s', '') -ieq $needle } |
                Sort-Object Id -Descending | Select-Object -First 1
            if (-not $hit) {
                $hit = $windowed | Where-Object { ($_.ProcessName -replace '\s', '') -like ('*' + $needle + '*') } |
                    Sort-Object Id -Descending | Select-Object -First 1
            }
            if (-not $hit) {
                $hit = $windowed | Where-Object { $_.MainWindowTitle -and (($_.MainWindowTitle -replace '\s', '') -like ('*' + $needle + '*')) } |
                    Sort-Object Id -Descending | Select-Object -First 1
            }
            if ($hit) { return $hit.Id }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    return $null
}

function Handle-LaunchApp($name) {
    if (-not $name) { return 'App name is required.' }
    # A bare non-string JSON value (e.g. a number) reaches here as-is; coerce
    # before .ToLowerInvariant() below, which only exists on [string] and would
    # otherwise throw a MethodInvocationException that crashes this dispatch
    # loop (transient DoS — pc-child auto-restarts, but every in-flight command
    # is lost until it does).
    $name = [string]$name

    # Special handling for Spotify - use URI scheme (works for both desktop and Windows Store/UWP apps)
    if ($name -eq 'spotify' -or $name -like 'spotify:*') {
        # Use Spotify URI scheme - works for both desktop and Windows Store versions
        # Supports spotify: (launch app), spotify:track:<id>, spotify:search:<query>
        try {
            Start-Process $name -ErrorAction Stop
            Start-Sleep -Milliseconds 1500
            # Try to get the PID after launch
            $proc = Get-Process -Name 'Spotify' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($proc) {
                return @{ pid = $proc.Id; name = $name; launched = $true }
            }
            return @{ name = $name; launched = $true; note = 'launched via URI scheme' }
        } catch {
            return ('Failed to launch Spotify via URI: ' + $_.Exception.Message)
        }
    }

    # FIX 6: known installed desktop app — resolve before the generic
    # Start-Process attempt below, which can't find apps with no PATH entry.
    $attempted = @()
    $known = $script:KnownApps[$name.ToLowerInvariant()]
    if ($known -and (Test-Path $known.path)) {
        try {
            $procArgs = @{ FilePath = $known.path; PassThru = $true; ErrorAction = 'Stop' }
            if ($known.args) { $procArgs.ArgumentList = $known.args }
            $proc = Start-Process @procArgs
            Start-Sleep -Milliseconds 500
            # AUDIT FIX: launcher-style entries (Discord's Squirrel Update.exe)
            # spawn the real app and exit — $proc.Id would be the bootstrapper's
            # transient PID, poisoning lastLaunchedPid upstream. Resolve the
            # real process by name, same pattern as the Spotify branch above.
            if ($known.procName) {
                Start-Sleep -Milliseconds 1000
                $real = Get-Process -Name $known.procName -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($real) { return @{ pid = $real.Id; name = $name; launched = $true } }
                return @{ name = $name; launched = $true; note = 'launched via bootstrapper; app process not yet visible' }
            }
            return @{ pid = $proc.Id; name = $name; launched = $true }
        } catch {
            return ('Failed to launch "' + $name + '": ' + $_.Exception.Message)
        }
    } else {
        # FIX 7: KnownApps only knows a literal per-user Win32 exe path. Apps
        # reinstalled via a different channel — e.g. Slack as a Microsoft Store
        # package — register under HKCU App Paths instead, or need the
        # shell:AppsFolder\<AppID> launch form entirely. Both steps are
        # best-effort and additive: any failure just falls through to the
        # generic Start-Process attempt below, preserving the honest-failure
        # contract.
        if ($known) { $attempted += ('KnownApps path missing on disk: ' + $known.path) }

        $regPath = Resolve-AppPathFromRegistry $name
        if ($regPath) {
            try {
                $proc = Start-Process -FilePath $regPath -PassThru -ErrorAction Stop
                Start-Sleep -Milliseconds 500
                $realPid = Resolve-RealProcessAfterLaunch $proc $name
                if (-not $realPid) { $realPid = Resolve-WindowedProcessByName $name 6000 }
                if ($realPid) { return @{ pid = $realPid; name = $name; launched = $true; resolvedVia = 'registry-app-paths' } }
                return @{ launched = $true; name = $name; resolvedVia = 'registry-app-paths'; note = 'launched but process pid could not be confirmed (packaged-app activation likely exited its launcher stub)' }
            } catch { $attempted += ('registry path ' + $regPath + ': ' + $_.Exception.Message) }
        } else { $attempted += 'registry App Paths: no match' }

        $appId = Resolve-AppViaStartApps $name
        if ($appId) {
            try {
                Start-Process "shell:AppsFolder\$appId" -ErrorAction Stop
                Start-Sleep -Milliseconds 800
                # A Store/UWP activation has no launcher process to follow, but the
                # app it activates does own a real windowed process — find it by
                # name. Returning no pid here is what left ui_type with nothing to
                # foreground (see Resolve-WindowedProcessByName's comment).
                $realPid = Resolve-WindowedProcessByName $name 8000
                if ($realPid) { return @{ pid = $realPid; name = $name; launched = $true; resolvedVia = 'start-apps' } }
                return @{ launched = $true; name = $name; resolvedVia = 'start-apps'; note = 'Store/UWP app activated, but no windowed process matching the name was found; a later focus_window/ui_type cannot target it.' }
            } catch { $attempted += ('shell:AppsFolder ' + $appId + ': ' + $_.Exception.Message) }
        } else { $attempted += 'Get-StartApps: no match' }
    }

    # Try Start-Process with the name
    try {
        $proc = Start-Process -FilePath $name -PassThru -ErrorAction Stop
        Start-Sleep -Milliseconds 500
        $realPid = Resolve-RealProcessAfterLaunch $proc $name
        if (-not $realPid) { $realPid = Resolve-WindowedProcessByName $name 6000 }
        if ($realPid) { return @{ pid = $realPid; name = $name } }
        return @{ launched = $true; name = $name; note = 'launched but process pid could not be confirmed (packaged-app activation likely exited its launcher stub)' }
    } catch {
        # FIX 4: an unresolvable name must report an honest failure, not
        # silently fall back to opening File Explorer / triggering a browser
        # web-search while still claiming success — a mistyped or unknown app
        # name previously opened the wrong thing and reported launched:true.
        $attempted += ('Start-Process "' + $name + '": ' + $_.Exception.Message)
        return ('Failed to launch "' + $name + '". Tried: ' + ($attempted -join '; '))
    }
}

# FIX 5: "show desktop" previously had no dedicated tool, so the planner fell
# back to launch_app("explorer") — opening a File Explorer window instead of
# minimizing everything. Shell.Application's MinimizeAll performs the same
# minimize-all action as the taskbar's "Show desktop" corner button, but is
# one-directional (always minimizes; the real corner button toggles back to
# restore all on a second press) — arguably the better semantic for a voice
# command anyway, since "show desktop" said twice should not un-minimize
# everything. No P/Invoke needed.
function Handle-ShowDesktop {
    try {
        $shell = New-Object -ComObject Shell.Application
        $shell.MinimizeAll()
        return @{ shown = $true }
    } catch {
        return ('Show desktop failed: ' + $_.Exception.Message)
    }
}

function Handle-ListWindows {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    $windows = @()
    $skipped = 0
    foreach ($child in $all) {
        # A window can close between FindAll() enumerating it and this loop
        # reading its .Current properties — the AutomationElement COM handle
        # then throws ElementNotAvailableException on ANY property access.
        # Previously only the Get-Process lookup below was guarded; a throw
        # from ProcessId/Name/ClassName/BoundingRectangle itself aborted the
        # whole foreach, failing list_windows entirely for one stale handle
        # among possibly dozens. Skip just that window and keep going.
        try {
            $procId = $child.Current.ProcessId
            $name = $child.Current.Name
            $cls = $child.Current.ClassName
            $rect = Get-RectBounds $child.Current.BoundingRectangle
        } catch {
            $skipped++
            continue
        }
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
    return @{ windows = $windows; total = $windows.Count; skipped = $skipped }
}

# V8 (Phase 4): active-window sensor handler. Returns the foreground window's
# {pid, processName, title, hwnd}. Used by the window-sensor to emit
# perception.window events with structured app/title metadata (distinct from
# screen-sensor which produces free-text vision captions).
function Handle-ActiveWindow {
    $hwnd = [NativeInput]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) {
        return @{ app = ''; title = ''; pid = 0; hwnd = '0' }
    }
    # Title (max 512 chars — generous, the sensor slices to 120 anyway)
    $sb = New-Object System.Text.StringBuilder 512
    [void][NativeInput]::GetWindowText($hwnd, $sb, 512)
    $title = $sb.ToString()
    # PID → process name
    $pidVal = 0
    [void][NativeInput]::GetWindowThreadProcessId($hwnd, [ref]$pidVal)
    $procName = 'unknown'
    if ($pidVal -gt 0) {
        try {
            $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
            if ($proc) { $procName = $proc.ProcessName }
        } catch { }
    }
    return @{
        app = $procName
        title = $title
        pid = $pidVal
        hwnd = $hwnd.ToString()
    }
}

function Handle-FocusWindow($TargetPid) {
    if (-not $TargetPid) { return 'PID is required.' }
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction Stop
        $hwnd = $proc.MainWindowHandle
        if ($hwnd -eq [IntPtr]::Zero) {
            return ('Process ' + $TargetPid + ' has no main window.')
        }
        # Restore if minimized, then bring to foreground
        [NativeInput]::ShowWindow($hwnd, [NativeInput]::SW_RESTORE) | Out-Null
        Start-Sleep -Milliseconds 100

        # FIX 2: SetForegroundWindow's return was previously discarded, so this
        # handler always reported focused:true even when Windows' foreground-lock
        # silently denied the request (a background process may only steal
        # foreground if it's attached to the current foreground thread's input
        # queue). AttachThreadInput bridges that gap for the duration of the
        # call; detach again in finally regardless of outcome.
        $fgHwndBefore = [NativeInput]::GetForegroundWindow()
        $fgThreadId = 0
        [void][NativeInput]::GetWindowThreadProcessId($fgHwndBefore, [ref]$fgThreadId)
        $ourThreadId = [NativeInput]::GetCurrentThreadId()
        $attached = $false
        if ($fgThreadId -ne 0 -and $fgThreadId -ne $ourThreadId) {
            $attached = [NativeInput]::AttachThreadInput($ourThreadId, $fgThreadId, $true)
        }
        try {
            [NativeInput]::SetForegroundWindow($hwnd) | Out-Null
        } finally {
            if ($attached) { [void][NativeInput]::AttachThreadInput($ourThreadId, $fgThreadId, $false) }
        }
        Start-Sleep -Milliseconds 50

        # Verify it actually took instead of trusting the return value blind —
        # SetForegroundWindow can return true yet still be denied in edge cases.
        $method = 'attach-thread-input'

        # ESCALATION LADDER (2026-07-31). AttachThreadInput alone was denied 5/5 in
        # live testing, and a denied focus means ui_type has no target — which is
        # how keystrokes ended up in MYTHOS's own window. Two further attempts,
        # both self-contained (no cooperation needed from the foreground app):
        #
        #   2. Drop SPI_..._FOREGROUNDLOCKTIMEOUT to 0. That timeout is the whole
        #      reason the lock exists; it is restored in the finally below so this
        #      never leaks a system-wide setting change.
        #   3. Minimize then restore. A restore is an activation Windows performs
        #      itself, so it is allowed where a direct steal is not. Visibly
        #      flickers the window, hence last.
        $lockTimeoutChanged = $false
        $savedTimeout = [IntPtr]::Zero
        try {
            if ([NativeInput]::GetForegroundWindow() -ne $hwnd) {
                $method = 'foreground-lock-timeout'
                try {
                    $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)
                    try {
                        if ([NativeInput]::SystemParametersInfoValue([NativeInput]::SPI_GETFOREGROUNDLOCKTIMEOUT, 0, $buf, 0)) {
                            $savedTimeout = [IntPtr][System.Runtime.InteropServices.Marshal]::ReadInt32($buf)
                        }
                    } finally {
                        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
                    }
                    if ([NativeInput]::SystemParametersInfoValue([NativeInput]::SPI_SETFOREGROUNDLOCKTIMEOUT, 0, [IntPtr]::Zero, [NativeInput]::SPIF_SENDCHANGE)) {
                        $lockTimeoutChanged = $true
                    }
                } catch { }
                [NativeInput]::SetForegroundWindow($hwnd) | Out-Null
                Start-Sleep -Milliseconds 60
            }

            if ([NativeInput]::GetForegroundWindow() -ne $hwnd) {
                $method = 'minimize-restore'
                [NativeInput]::ShowWindow($hwnd, [NativeInput]::SW_MINIMIZE) | Out-Null
                Start-Sleep -Milliseconds 120
                [NativeInput]::ShowWindow($hwnd, [NativeInput]::SW_RESTORE) | Out-Null
                Start-Sleep -Milliseconds 180
                [NativeInput]::SetForegroundWindow($hwnd) | Out-Null
                Start-Sleep -Milliseconds 80
            }
        } finally {
            if ($lockTimeoutChanged) {
                try { [void][NativeInput]::SystemParametersInfoValue([NativeInput]::SPI_SETFOREGROUNDLOCKTIMEOUT, 0, $savedTimeout, [NativeInput]::SPIF_SENDCHANGE) } catch { }
            }
        }

        if ([NativeInput]::GetForegroundWindow() -ne $hwnd) {
            return ('Failed to bring PID ' + $TargetPid + ' to the foreground (blocked by the OS foreground-lock; tried thread-attach, lock-timeout override and minimize/restore).')
        }
        return @{ pid = $TargetPid; focused = $true; method = $method }
    } catch {
        return ('Cannot focus PID ' + $TargetPid + ': ' + $_.Exception.Message)
    }
}

function Handle-CloseWindow($TargetPid) {
    if (-not $TargetPid) { return 'PID is required.' }
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction Stop
        $proc.CloseMainWindow() | Out-Null
        # Wait briefly for graceful close
        $closed = $proc.WaitForExit(3000)
        if ($closed) {
            return @{ pid = $TargetPid; closed = $true; graceful = $true }
        } else {
            return @{ pid = $TargetPid; closed = $false; note = 'Window did not close gracefully in 3s' }
        }
    } catch {
        return ('Cannot close PID ' + $TargetPid + ': ' + $_.Exception.Message)
    }
}

# ---- Phase 3: window move/resize/snap + scroll/right-click/drag ----
# NOTE: every handler takes the target PID as a parameter named $TargetPid (NOT
# $pid — $pid is the PowerShell automatic variable for THIS shell's process,
# a classic wrong-target bug). We resolve $proc from $TargetPid and act on
# $proc.MainWindowHandle. Click-style handlers take screen coords, not a PID.

function Resolve-TargetWindow($TargetPid) {
    # Shared guard: PID -> process with a non-zero MainWindowHandle.
    # Returns @{ ok=$true; proc=$proc; hwnd=$hwnd } or @{ ok=$false; error=$msg }.
    if (-not $TargetPid) { return @{ ok = $false; error = 'PID is required.' } }
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction Stop
    } catch {
        return @{ ok = $false; error = ('Cannot find PID ' + $TargetPid + ': ' + $_.Exception.Message) }
    }
    $hwnd = $proc.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) {
        return @{ ok = $false; error = ('Process ' + $TargetPid + ' has no main window.') }
    }
    return @{ ok = $true; proc = $proc; hwnd = $hwnd }
}

function Handle-MoveWindow($TargetPid, $x, $y, $width, $height) {
    $w = Resolve-TargetWindow $TargetPid
    if (-not $w.ok) { return $w.error }
    if ($null -eq $x -or $null -eq $y -or $null -eq $width -or $null -eq $height) {
        return 'move_window requires x, y, width, height.'
    }
    $ok = [NativeInput]::MoveWindow($w.hwnd, [int]$x, [int]$y, [int]$width, [int]$height, $true)
    if (-not $ok) { return ('MoveWindow failed for PID ' + $TargetPid) }
    return @{ pid = $TargetPid; moved = $true; x = [int]$x; y = [int]$y; width = [int]$width; height = [int]$height }
}

function Handle-SnapWindow($TargetPid, $position) {
    $w = Resolve-TargetWindow $TargetPid
    if (-not $w.ok) { return $w.error }
    $pos = "$position".ToLowerInvariant()
    # Work area = the screen minus the taskbar.
    $wa = [System.Windows.Forms.SystemInformation]::WorkingArea
    $halfW = [int]($wa.Width / 2)
    $fullW = [int]$wa.Width
    $fullH = [int]$wa.Height
    switch ($pos) {
        'left' {
            $ok = [NativeInput]::MoveWindow($w.hwnd, $wa.X, $wa.Y, $halfW, $fullH, $true)
        }
        'right' {
            $ok = [NativeInput]::MoveWindow($w.hwnd, $wa.X + $halfW, $wa.Y, $halfW, $fullH, $true)
        }
        'maximize' {
            [NativeInput]::ShowWindow($w.hwnd, [NativeInput]::SW_MAXIMIZE) | Out-Null
            $ok = $true
        }
        'minimize' {
            [NativeInput]::ShowWindow($w.hwnd, [NativeInput]::SW_MINIMIZE) | Out-Null
            $ok = $true
        }
        'restore' {
            [NativeInput]::ShowWindow($w.hwnd, [NativeInput]::SW_RESTORE) | Out-Null
            $ok = $true
        }
        default { return ('Unknown snap position: ' + $position + '. Use left, right, maximize, minimize, or restore.') }
    }
    if (-not $ok) { return ('snap_window (' + $pos + ') failed for PID ' + $TargetPid) }
    return @{ pid = $TargetPid; snapped = $true; position = $pos }
}

function Handle-ScrollAt($x, $y, $amount, $direction) {
    if ($null -eq $x -or $null -eq $y) { return 'scroll_at requires x and y coordinates.' }
    $amt = if ($amount) { [int]$amount } else { 3 }
    # direction defaults to 'down'; negative wheel delta = scroll down.
    $dir = if ($direction) { "$direction".ToLowerInvariant() } else { 'down' }
    if ($dir -eq 'down') { $delta = -[int]($amt * 120) }
    elseif ($dir -eq 'up') { $delta = [int]($amt * 120) }
    else { return ('Unknown scroll direction: ' + $direction + '. Use up or down.') }

    # Move to the point first, then send the wheel event there.
    $screenW = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $screenH = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
    $normX = [int]($x * 65535 / $screenW)
    $normY = [int]($y * 65535 / $screenH)

    $move = New-Object 'NativeInput+INPUT'
    $move.type = [NativeInput]::INPUT_MOUSE
    $move.u.mi.dx = $normX
    $move.u.mi.dy = $normY
    $move.u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_MOVE -bor [NativeInput]::MOUSEEVENTF_ABSOLUTE

    $wheel = New-Object 'NativeInput+INPUT'
    $wheel.type = [NativeInput]::INPUT_MOUSE
    $wheel.u.mi.dx = 0
    $wheel.u.mi.dy = 0
    $wheel.u.mi.mouseData = [uint32]$delta
    $wheel.u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_WHEEL

    $inputs = @($move, $wheel)
    [void][NativeInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
    return @{ scrolled = $true; x = [int]$x; y = [int]$y; amount = $amt; direction = $dir }
}

function Handle-RightClickAt($x, $y) {
    if ($null -eq $x -or $null -eq $y) { return 'right_click_at requires x and y coordinates.' }
    $screenW = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $screenH = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
    $normX = [int]($x * 65535 / $screenW)
    $normY = [int]($y * 65535 / $screenH)

    $inputs = @(
        (New-Object 'NativeInput+INPUT'),   # move
        (New-Object 'NativeInput+INPUT'),   # right down
        (New-Object 'NativeInput+INPUT')    # right up
    )
    $inputs[0].type = [NativeInput]::INPUT_MOUSE
    $inputs[0].u.mi.dx = $normX
    $inputs[0].u.mi.dy = $normY
    $inputs[0].u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_MOVE -bor [NativeInput]::MOUSEEVENTF_ABSOLUTE

    $inputs[1].type = [NativeInput]::INPUT_MOUSE
    $inputs[1].u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_RIGHTDOWN

    $inputs[2].type = [NativeInput]::INPUT_MOUSE
    $inputs[2].u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_RIGHTUP

    [void][NativeInput]::SendInput(3, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
    return @{ rightClicked = $true; x = [int]$x; y = [int]$y }
}

function Handle-Drag($x1, $y1, $x2, $y2) {
    if ($null -eq $x1 -or $null -eq $y1 -or $null -eq $x2 -or $null -eq $y2) {
        return 'drag requires x1, y1, x2, y2 coordinates.'
    }
    $screenW = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $screenH = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
    function NormXY($sx, $sy) {
        return @([int]($sx * 65535 / $screenW), [int]($sy * 65535 / $screenH))
    }
    $start = NormXY $x1 $y1
    $end = NormXY $x2 $y2

    # MOVE to start, LEFTDOWN, stepped MOVEs to end (so the OS registers a drag,
    # not a teleport), LEFTUP. 8 steps is enough for a smooth-enough drag.
    $steps = 8
    $inputs = @()
    $mv0 = New-Object 'NativeInput+INPUT'
    $mv0.type = [NativeInput]::INPUT_MOUSE
    $mv0.u.mi.dx = $start[0]
    $mv0.u.mi.dy = $start[1]
    $mv0.u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_MOVE -bor [NativeInput]::MOUSEEVENTF_ABSOLUTE
    $inputs += $mv0

    $down = New-Object 'NativeInput+INPUT'
    $down.type = [NativeInput]::INPUT_MOUSE
    $down.u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_LEFTDOWN
    $inputs += $down

    for ($i = 1; $i -le $steps; $i++) {
        $t = $i / $steps
        $ix = [int]($start[0] + ($end[0] - $start[0]) * $t)
        $iy = [int]($start[1] + ($end[1] - $start[1]) * $t)
        $step = New-Object 'NativeInput+INPUT'
        $step.type = [NativeInput]::INPUT_MOUSE
        $step.u.mi.dx = $ix
        $step.u.mi.dy = $iy
        $step.u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_MOVE -bor [NativeInput]::MOUSEEVENTF_ABSOLUTE
        $inputs += $step
    }

    $up = New-Object 'NativeInput+INPUT'
    $up.type = [NativeInput]::INPUT_MOUSE
    $up.u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_LEFTUP
    $inputs += $up

    [void][NativeInput]::SendInput($inputs.Count, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
    return @{ dragged = $true; from = @{ x = [int]$x1; y = [int]$y1 }; to = @{ x = [int]$x2; y = [int]$y2 }; steps = $steps }
}

function Handle-MediaKey($key) {
    if (-not $key) { return 'Key name is required.' }

    # Transport controls → SMTC session (robust). Fall back to VK media-key
    # injection if SMTC is unavailable or rejects the command.
    $transport = @{ play_pause = 'toggle'; next_track = 'next'; prev_track = 'prev' }
    if ($transport.ContainsKey($key)) {
        $smtc = Send-SmtcControl $transport[$key]
        if ($smtc -eq $true) { return @{ key = $key; sent = $true; via = 'smtc' } }
        # Fallback: global media-key injection.
        $script:LastVkSent = $null
        $err = Send-MediaKey $key
        if ($err) { return "media '$key' failed (smtc: $smtc; vkey: $err)" }
        if ($null -ne $script:LastVkSent -and $script:LastVkSent -lt 1) {
            return "media '$key' failed (smtc: $smtc; SendInput injected 0 events - input blocked)"
        }
        return @{ key = $key; sent = $true; via = 'vkey-fallback'; smtc = "$smtc" }
    }

    # Volume keys have no SMTC equivalent → VK injection, but report honestly
    # whether SendInput actually delivered anything.
    $script:LastVkSent = $null
    $err = Send-MediaKey $key
    if ($err) { return $err }
    if ($null -ne $script:LastVkSent -and $script:LastVkSent -lt 1) {
        return "volume key '$key' failed: SendInput injected 0 events (input may be blocked by a higher-integrity foreground app)"
    }
    return @{ key = $key; sent = $true; via = 'vkey' }
}

# ---- Master volume control (REMEDIATION P1-8) ----
# "Set the volume to 20%" is not expressible with media_key's fixed
# volume_up/down/mute VK steps (no target level, no read-back). This drives
# Windows Core Audio's IAudioEndpointVolume COM interface directly for an
# exact get/set, independent of SendInput/foreground focus. Lazy Add-Type
# (same pattern as Send-SmtcControl above) so the cost is only paid when a
# volume level command is actually used.
$script:AudioVolumeType = $null
function Get-AudioEndpointVolumeType {
    if ($script:AudioVolumeType) { return $script:AudioVolumeType }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int NotImpl1();
    int NotImpl2();
    int GetChannelCount(out uint channelCount);
    int SetMasterVolumeLevel(float level, Guid eventContext);
    int SetMasterVolumeLevelScalar(float level, Guid eventContext);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float level, Guid eventContext);
    int SetChannelVolumeLevelScalar(uint channel, float level, Guid eventContext);
    int GetChannelVolumeLevel(uint channel, out float level);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute(bool mute, Guid eventContext);
    int GetMute(out bool mute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume endpointVolume);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

public static class MythosAudioVolume {
    private static IAudioEndpointVolume GetEndpointVolume() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice dev;
        // eRender = 0 (playback devices), eMultimedia = 1 (default role for music/movies)
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
        Guid epvGuid = typeof(IAudioEndpointVolume).GUID;
        IAudioEndpointVolume epv;
        // CLSCTX_ALL = 23
        Marshal.ThrowExceptionForHR(dev.Activate(ref epvGuid, 23, IntPtr.Zero, out epv));
        return epv;
    }
    public static float GetVolumeScalar() {
        float level;
        Marshal.ThrowExceptionForHR(GetEndpointVolume().GetMasterVolumeLevelScalar(out level));
        return level;
    }
    public static void SetVolumeScalar(float level) {
        Marshal.ThrowExceptionForHR(GetEndpointVolume().SetMasterVolumeLevelScalar(level, Guid.Empty));
    }
    public static bool GetMuteState() {
        bool mute;
        Marshal.ThrowExceptionForHR(GetEndpointVolume().GetMute(out mute));
        return mute;
    }
}
'@ -ErrorAction Stop
    $script:AudioVolumeType = [MythosAudioVolume]
    return $script:AudioVolumeType
}

function Handle-GetVolume {
    try {
        $type = Get-AudioEndpointVolumeType
        $scalar = $type::GetVolumeScalar()
        $muted = $type::GetMuteState()
        return @{ level = [int][Math]::Round($scalar * 100); muted = [bool]$muted }
    } catch {
        return ('get_volume failed: ' + $_.Exception.Message)
    }
}

function Handle-SetVolume($level) {
    if ($null -eq $level -or $level -eq '') { return 'level (0-100) is required.' }
    $lvl = 0
    if (-not [int]::TryParse("$level", [ref]$lvl)) { return "level must be a number (got '$level')." }
    if ($lvl -lt 0 -or $lvl -gt 100) { return "level must be 0-100 (got $lvl)." }
    try {
        $type = Get-AudioEndpointVolumeType
        $type::SetVolumeScalar([float]($lvl / 100.0))
        $actual = $type::GetVolumeScalar()
        return @{ level = [int][Math]::Round($actual * 100) }
    } catch {
        return ('set_volume failed: ' + $_.Exception.Message)
    }
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

# §7.1 (step 5, desktop gaps) — real screen OCR via Windows.Media.Ocr, zero
# new dependencies (no tesseract.js — wasm+traineddata for something Windows
# already ships). Reuses the existing Await-WinRTOperation helper (line ~100)
# and this file's already-established WinRT-type-resolution convention
# ([Type]::GetType('...,ContentType=WindowsRuntime')), matching how the SMTC
# media session code above resolves Windows.Media.Control types — NOT the
# bare [Windows.Storage.StorageFile] bracket syntax the source plan doc
# sketches, which doesn't reliably resolve in this codebase's established
# pattern. Verified live before wiring in: a standalone script using this
# exact reflection chain against a bitmap with known drawn text ("MYTHOS OCR
# TEST 12345") round-tripped that exact string back through the real OCR
# engine on this machine.
function Handle-ScreenReadText {
    try {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $tmp = Join-Path $env:TEMP ('mythos-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
        $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        $gfx.Dispose(); $bmp.Dispose()
    } catch {
        return ('screen capture for OCR failed: ' + $_.Exception.Message)
    }
    try {
        $storageFileType = [Type]::GetType('Windows.Storage.StorageFile, Windows.Storage, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
        $streamType = [Type]::GetType('Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
        $decoderType = [Type]::GetType('Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
        $softwareBitmapType = [Type]::GetType('Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
        $ocrEngineType = [Type]::GetType('Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
        $ocrResultType = [Type]::GetType('Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
        $fileAccessModeType = [Type]::GetType('Windows.Storage.FileAccessMode, Windows.Storage, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')

        $file = Await-WinRTOperation ($storageFileType::GetFileFromPathAsync($tmp)) $storageFileType
        $readMode = [Enum]::ToObject($fileAccessModeType, 0)  # FileAccessMode.Read = 0
        $stream = Await-WinRTOperation ($file.OpenAsync($readMode)) $streamType
        $decoder = Await-WinRTOperation ($decoderType::CreateAsync($stream)) $decoderType
        $bitmap = Await-WinRTOperation ($decoder.GetSoftwareBitmapAsync()) $softwareBitmapType
        $engine = $ocrEngineType::TryCreateFromUserProfileLanguages()
        if ($null -eq $engine) { return 'no OCR language pack installed' }
        $ocr = Await-WinRTOperation ($engine.RecognizeAsync($bitmap)) $ocrResultType
        $lines = @($ocr.Lines | ForEach-Object { $_.Text })
        return @{ text = ($lines -join "`n"); lineCount = $lines.Count }
    } catch {
        return ('OCR failed: ' + $_.Exception.Message)
    } finally {
        if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    }
}

function Handle-UiElements($TargetPid, $depth) {
    if (-not $depth) { $depth = 2 }
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction Stop
        $hwnd = $proc.MainWindowHandle
        if ($hwnd -eq [IntPtr]::Zero) {
            return ('Process ' + $TargetPid + ' has no main window.')
        }
        # Get the window element from UIA
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid
        )
        $windowEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
        if (-not $windowEl) {
            return ('No UIA window found for PID ' + $TargetPid)
        }
        $elements = @()
        Walk-UIA -Element $windowEl -Depth 0 -MaxDepth $depth -Elements ([ref]$elements) -Path @()
        return @{ elements = $elements; pid = $TargetPid }
    } catch {
        return ('UIA tree walk failed for PID ' + $TargetPid + ': ' + $_.Exception.Message)
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

function Handle-UiClick($TargetPid, $elementPath) {
    if (-not $elementPath) { return 'elementPath is required.' }
    try {
        $element = Resolve-UIAElement -TargetPid $TargetPid -ElementPath $elementPath
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
        } catch {
            # No invoke pattern on this element — fall through to the coordinate
            # click below. PowerShell has NO C-style comments: a `/* ... */` here
            # parses as a command named '/*', so the catch itself threw
            # "The term '/*' is not recognized..." and killed every ui_click on
            # a non-invokable element (text fields included). Use '#' only.
        }

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

function Handle-UiType($text, $TargetPid, $elementPath) {
    if (-not $text) { return 'Text is required.' }
    try {
        # If a target element is specified, try to set focus there first
        if ($TargetPid -and $elementPath) {
            $element = Resolve-UIAElement -TargetPid $TargetPid -ElementPath $elementPath
            if (-not $element.error) {
                $element.element.SetFocus()
                Start-Sleep -Milliseconds 50
            }
        }

        # FIX 3 (belt-and-suspenders on top of FIX 2's honest focus_window):
        # SendInput types into whatever window the OS currently has foreground,
        # not whatever the caller intended. When a target pid is known, confirm
        # the foreground window is actually owned by that pid before injecting
        # a single keystroke — a stale/drifted foreground (e.g. a confirm-dialog
        # round trip that moved focus away) must surface as an honest failure
        # so the retry loop re-attempts instead of typing into the wrong window.
        if ($TargetPid) {
            $fgHwnd = [NativeInput]::GetForegroundWindow()
            $fgPid = 0
            [void][NativeInput]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
            if ($fgPid -ne [uint32]$TargetPid) {
                return ('Type aborted: foreground window belongs to PID ' + $fgPid + ', not target PID ' + $TargetPid + '.')
            }
        }

        # Audit honesty: capture what is ACTUALLY foreground at injection time,
        # TargetPid or not — when the caller omits pid (the "type into whatever
        # has focus" contract), typed:true previously gave zero visibility into
        # where the keystrokes landed. Best-effort: a lookup failure must never
        # block typing.
        $typedIntoPid = 0
        $typedIntoTitle = $null
        try {
            $curFgHwnd = [NativeInput]::GetForegroundWindow()
            [void][NativeInput]::GetWindowThreadProcessId($curFgHwnd, [ref]$typedIntoPid)
            $sb = New-Object System.Text.StringBuilder 512
            [void][NativeInput]::GetWindowText($curFgHwnd, $sb, 512)
            $typedIntoTitle = $sb.ToString()
        } catch { }

        $script:LastVkSent = $null
        Send-UnicodeText $text
        # BUG-042-class honest failure: SendInput injected zero events (UIPI /
        # a higher-integrity foreground app blocked it) — report failure instead
        # of the silent typed:$true that shipped before this fix.
        if ($null -ne $script:LastVkSent -and $script:LastVkSent -lt 1) {
            return "Type failed: SendInput injected 0 events (input may be blocked by a higher-integrity foreground app)."
        }
        return @{ typed = $true; length = $text.Length; typedIntoPid = [int]$typedIntoPid; typedIntoTitle = $typedIntoTitle }
    } catch {
        return ('Type failed: ' + $_.Exception.Message)
    }
}

# VK codes for send_key — real virtual keystrokes for keys that Chromium/Electron
# apps (Spotify, etc.) don't reliably accept as Unicode WM_CHAR events.
$VK_CODES = @{
    enter  = 0x0D
    tab    = 0x09
    escape = 0x1B
    space  = 0x20
    up     = 0x26
    down   = 0x28
    left   = 0x25
    right  = 0x27
    # Letters, so modifier combos like ctrl+n (new document) and ctrl+a (select
    # all) are expressible. Bare letters are intentionally NOT useful on their own
    # -- plain text goes through ui_type/SendInput Unicode, not virtual keys.
    a = 0x41; b = 0x42; c = 0x43; d = 0x44; e = 0x45; f = 0x46; g = 0x47
    h = 0x48; i = 0x49; j = 0x4A; k = 0x4B; l = 0x4C; m = 0x4D; n = 0x4E
    o = 0x4F; p = 0x50; q = 0x51; r = 0x52; s = 0x53; t = 0x54; u = 0x55
    v = 0x56; w = 0x57; x = 0x58; y = 0x59; z = 0x5A
    delete = 0x2E
    home   = 0x24
    end    = 0x23
}

$VK_MODIFIERS = @{
    ctrl    = 0x11
    control = 0x11
    shift   = 0x10
    alt     = 0x12
    win     = 0x5B
}

# Send a modifier combo ("ctrl+n", "ctrl+shift+t"): modifiers down in order, the
# base key down/up, then modifiers up in reverse. Without this, send_key could
# only press one virtual key at a time, so Ctrl+N -- the only reliable way to get
# a blank Notepad document on Windows 11, which restores previous tabs on launch
# -- was not expressible at all.
function Send-VkCombo($modifierVks, $vk) {
    $script:LastVkSent = 0
    $total = 0
    foreach ($m in $modifierVks) {
        Send-VkKeyDown $m
        $total += $script:LastVkSent
    }
    Send-VkKey $vk
    $total += $script:LastVkSent
    $reversed = @($modifierVks)
    [array]::Reverse($reversed)
    foreach ($m in $reversed) {
        Send-VkKeyUp $m
        $total += $script:LastVkSent
    }
    $script:LastVkSent = $total
}

# Single key-down / key-up events. SizeOf is taken from the INSTANCE, matching
# Send-VkKey above -- the [Type] overload is unreliable for a nested type name on
# PowerShell 5.1.
function Send-VkKeyDown($vk) {
    $inputs = @((New-Object 'NativeInput+INPUT'))
    $inputs[0].type = [NativeInput]::INPUT_KEYBOARD
    $inputs[0].u.ki.wVk = $vk
    $inputs[0].u.ki.dwFlags = 0
    $script:LastVkSent = [NativeInput]::SendInput(1, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
}

function Send-VkKeyUp($vk) {
    $inputs = @((New-Object 'NativeInput+INPUT'))
    $inputs[0].type = [NativeInput]::INPUT_KEYBOARD
    $inputs[0].u.ki.wVk = $vk
    $inputs[0].u.ki.dwFlags = [NativeInput]::KEYEVENTF_KEYUP
    $script:LastVkSent = [NativeInput]::SendInput(1, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
}

function Handle-SendKey($key) {
    if (-not $key) { return 'Key name is required.' }
    $raw = ([string]$key).ToLower().Trim()

    if ($raw.Contains('+')) {
        $parts = @($raw.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($parts.Count -lt 2) { return "Unknown key: $key." }
        $baseName = $parts[$parts.Count - 1]
        $modNames = @($parts[0..($parts.Count - 2)])
        $vk = $VK_CODES[$baseName]
        if (-not $vk) { return @("Unknown key: $baseName. Valid: $($VK_CODES.Keys -join ', ')") }
        $modVks = @()
        foreach ($m in $modNames) {
            $mv = $VK_MODIFIERS[$m]
            if (-not $mv) { return @("Unknown modifier: $m. Valid: $($VK_MODIFIERS.Keys -join ', ')") }
            $modVks += $mv
        }
        $script:LastVkSent = $null
        Send-VkCombo $modVks $vk
        if ($null -ne $script:LastVkSent -and $script:LastVkSent -lt 1) {
            return "Send key '$key' failed: SendInput injected 0 events (input may be blocked by a higher-integrity foreground app)."
        }
        return @{ key = $raw; sent = $true; combo = $true }
    }

    $vk = $VK_CODES[$raw]
    if (-not $vk) {
        return @("Unknown key: $key. Valid: $($VK_CODES.Keys -join ', ')")
    }
    $script:LastVkSent = $null
    Send-VkKey $vk
    # Same BUG-042-class honest failure as Handle-MediaKey/Handle-UiType.
    if ($null -ne $script:LastVkSent -and $script:LastVkSent -lt 1) {
        return "Send key '$key' failed: SendInput injected 0 events (input may be blocked by a higher-integrity foreground app)."
    }
    return @{ key = $raw; sent = $true }
}

function Handle-MediaStatus {
    try {
        # Try to use Windows SMTC API (Windows 10 1903+)
        # This requires PowerShell 5.1+ with Windows Runtime support
        Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue

        $type = [Type]::GetType('Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
        if (-not $type) {
            # Type not available - likely older PowerShell/Windows
            return @{ available = $false; error = 'SMTC API not available (requires Windows 10 1903+ and PowerShell 5.1+)' }
        }

        # Get the session manager
        $sessionManagerOp = $type::RequestAsync()
        $sessionManager = Await-WinRTOperation $sessionManagerOp $type
        if (-not $sessionManager) {
            return @{ available = $true; playing = $false; error = 'Failed to get session manager' }
        }

        # Get current session
        $currentSession = $sessionManager.GetCurrentSession()
        if (-not $currentSession) {
            return @{ available = $true; playing = $false; source = 'none' }
        }

        # Get playback info
        $playbackInfo = $currentSession.GetPlaybackInfo()
        $playbackStatus = $playbackInfo.PlaybackStatus

        # Map SMTC status to simple boolean
        $isPlaying = ($playbackStatus -eq 'Playing')

        # Get media properties (title, artist, album, thumbnail)
        $mediaPropsType = [Type]::GetType('Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
        $mediaPropsOp = $currentSession.TryGetMediaPropertiesAsync()
        $mediaProps = Await-WinRTOperation $mediaPropsOp $mediaPropsType

        $result = @{
            available = $true
            playing = $isPlaying
            source = $currentSession.SourceAppUserModelId -replace '^.*\.', ''
        }

        if ($mediaProps) {
            if ($mediaProps.Title) { $result.title = $mediaProps.Title }
            if ($mediaProps.Artist) { $result.artist = $mediaProps.Artist }
            if ($mediaProps.AlbumTitle) { $result.album = $mediaProps.AlbumTitle }

            # Thumbnail (album art). RE-ENABLED 2026-07-17: the earlier "indefinite
            # hang" (BUG-038) turned out not to be a hang at all -- the response line
            # was silently corrupted in transit by the OEM console codepage best-fitting
            # curly quotes in the title down to raw ASCII '"', producing invalid JSON
            # that the Node parent dropped, so the command just timed out. Fixed at the
            # top of this file (UTF-8 console encoding) and in Write-Response (ASCII-safe
            # \uXXXX escaping). Design change on top of that: the art bytes go to a temp
            # FILE and only the path travels over the pipe -- no ~240KB base64 JSON
            # lines through stdout, ever. Failure here is non-fatal: title/artist/album
            # above are already in $result.
            if ($mediaProps.Thumbnail) {
                try {
                    $streamType = [Type]::GetType('Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')
                    $streamOp = $mediaProps.Thumbnail.OpenReadAsync()
                    $artStream = Await-WinRTOperation $streamOp $streamType
                    if ($artStream) {
                        $bytes = Read-WinRTStreamBytes $artStream
                        if ($bytes -and $bytes.Length -gt 0) {
                            $artPath = Join-Path $env:TEMP 'mythos-media-art.bin'
                            [System.IO.File]::WriteAllBytes($artPath, $bytes)
                            $result.artPath = $artPath
                            $mime = [string]$artStream.ContentType
                            $result.artMime = if ($mime) { $mime } else { 'image/png' }
                        }
                    }
                } catch {
                    # Art is best-effort -- never fail the whole media_status over it.
                    $result.artError = $_.Exception.Message
                }
            }
        }

        # Timeline (position/duration) — synchronous properties; guard separately
        # so a timeline failure never degrades the rest of media_status.
        try {
            $timeline = $currentSession.GetTimelineProperties()
            if ($timeline) {
                $result.positionSec = [int]$timeline.Position.TotalSeconds
                $result.durationSec = [int]$timeline.EndTime.TotalSeconds
            }
        } catch { }

        return $result
    } catch {
        return @{ available = $true; playing = $false; error = $_.Exception.Message }
    }
}

function Resolve-UIAElement($TargetPid, $elementPath) {
    try {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid
        )
        $windowEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
        if (-not $windowEl) {
            return @{ error = ('No UIA window found for PID ' + $TargetPid) }
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

function Handle-ClickAt($x, $y) {
    if ($null -eq $x -or $null -eq $y) { return 'x and y coordinates are required.' }
    try {
        Click-AtScreenCoords ([int]$x) ([int]$y)
        return @{ clicked = $true; x = [int]$x; y = [int]$y }
    } catch {
        return ('Click failed: ' + $_.Exception.Message)
    }
}

# Task 3 (step 5, desktop gaps) — clipboard read/write. Same Handle-*
# convention as every other command here: return a hashtable on success, a
# bare string on failure (the dispatch loop below treats a string result as
# ok:false).
function Handle-GetClipboard {
    try {
        $text = Get-Clipboard -Raw -ErrorAction Stop
        if ($null -eq $text) { $text = '' }
        return @{ text = $text }
    } catch {
        return ('get_clipboard failed: ' + $_.Exception.Message)
    }
}

function Handle-SetClipboard($text) {
    if ($null -eq $text) { return 'text is required.' }
    try {
        Set-Clipboard -Value ([string]$text) -ErrorAction Stop
        return @{ set = $true }
    } catch {
        return ('set_clipboard failed: ' + $_.Exception.Message)
    }
}

# §7.7 (step 5, desktop gaps) — wallpaper engine via SystemParametersInfo
# P/Invoke (NativeInput class above). Path validation/sandboxing happens on
# the JS side (from-pc.js's resolveSandboxed, reused from from-computer.js)
# before this ever runs — this function only checks the resolved path
# actually exists, matching this file's own Handle-X convention.
function Handle-SetWallpaper($path) {
    if (-not $path) { return 'A wallpaper image path is required.' }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "Wallpaper image not found: $path" }
    try {
        $full = (Resolve-Path -LiteralPath $path).Path
        $ok = [NativeInput]::SystemParametersInfo([NativeInput]::SPI_SETDESKWALLPAPER, 0, $full,
            ([NativeInput]::SPIF_UPDATEINIFILE -bor [NativeInput]::SPIF_SENDCHANGE))
        if (-not $ok) {
            $errCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            return "SystemParametersInfo failed (Win32 error $errCode)."
        }
        return @{ set = $true; path = $full }
    } catch {
        return ('set_wallpaper failed: ' + $_.Exception.Message)
    }
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
    $script:CurrentCmdId = $null
    try {
        $cmd = ConvertFrom-Json -InputObject $line -ErrorAction Stop
    } catch {
        Write-Response $false ('Invalid JSON: ' + $_.Exception.Message)
        continue
    }

    # Correlation id from the Node parent (see Write-Response). Optional field.
    if ($null -ne $cmd.id) { $script:CurrentCmdId = $cmd.id }

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
            # FIX 4: this case was missing the string-result-is-failure guard
            # every other handler below already has — a genuine "Failed to
            # launch..." string (including FIX 4's new honest failure) shipped
            # as {ok:true, result:"<failure text>"} instead of ok:false.
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'show_desktop' {
            $result = Handle-ShowDesktop
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'list_windows' {
            $result = Handle-ListWindows
        }
        'active_window' {
            $result = Handle-ActiveWindow
        }
        'focus_window' {
            $result = Handle-FocusWindow $cmd.pid
            # Same P0-2-class dispatcher guard: Handle-FocusWindow now (FIX 2)
            # returns an honest failure string when the foreground-lock blocks
            # it, which must reach the caller as ok:false, not silently succeed.
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'close_window' {
            $result = Handle-CloseWindow $cmd.pid
        }
        'move_window' {
            $result = Handle-MoveWindow $cmd.pid $cmd.x $cmd.y $cmd.width $cmd.height
        }
        'snap_window' {
            $result = Handle-SnapWindow $cmd.pid $cmd.position
        }
        'scroll_at' {
            $result = Handle-ScrollAt $cmd.x $cmd.y $cmd.amount $cmd.direction
        }
        'right_click_at' {
            $result = Handle-RightClickAt $cmd.x $cmd.y
        }
        'drag' {
            $result = Handle-Drag $cmd.x1 $cmd.y1 $cmd.x2 $cmd.y2
        }
        'media_key' {
            $result = Handle-MediaKey $cmd.key
            # REMEDIATION P0-2: the dispatch loop's final gate below only sets
            # ok:false from $err (unknown-command) or a null $result — every
            # Handle-* function's own bare-string failure (this file's
            # established convention: string = failure, hashtable = success)
            # otherwise fell through as {ok:true, result:"<failure text>"}.
            # This silently defeated Handle-MediaKey's own honest zero-
            # SendInput failure (BUG-042). Route a string result to $err.
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'get_volume' {
            $result = Handle-GetVolume
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'set_volume' {
            $result = Handle-SetVolume $cmd.level
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'screen_look' {
            $result = Handle-ScreenLook $cmd.query
        }
        'ui_elements' {
            $result = Handle-UiElements $cmd.pid $cmd.depth
        }
        'ui_click' {
            $result = Handle-UiClick $cmd.pid $cmd.elementPath
            # Reliability audit: Handle-UiClick returns a bare 'Click failed: ...'
            # string on arg-validation/resolution failure. Without this guard it
            # shipped as ok:true (danger:true, physically acts on the desktop)
            # AND silently defeated delegateWithRetry's retry-on-failure loop.
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'ui_type' {
            $result = Handle-UiType $cmd.text $cmd.pid $cmd.elementPath
            # REMEDIATION P0-2: same dispatcher defect as media_key above —
            # without this, Handle-UiType's zero-SendInput honest failure (and
            # its plain arg-validation failures) always shipped as ok:true,
            # and from-pc.js's foregroundThenRetry (which only retries on
            # !ok) never actually engaged.
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'send_key' {
            $result = Handle-SendKey $cmd.key
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'click_at' {
            $result = Handle-ClickAt $cmd.x $cmd.y
            # Same guard as ui_click above — Handle-ClickAt's own 'Click failed: ...'
            # string must reach the caller as ok:false, not a false success.
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'media_status' {
            $result = Handle-MediaStatus
        }
        'write_note' {
            $result = Handle-WriteNote $cmd.text $cmd.title
        }
        'screen_read_text' {
            $result = Handle-ScreenReadText
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'get_clipboard' {
            $result = Handle-GetClipboard
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'set_clipboard' {
            $result = Handle-SetClipboard $cmd.text
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'set_wallpaper' {
            $result = Handle-SetWallpaper $cmd.path
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        default {
            $err = ('Unknown command: ' + $command)
        }
    }

    if ($err) {
        Write-Response $false $err
    } elseif ($null -eq $result) {
        Write-Response $false "Command '$command' returned no result (handler may have thrown)."
    } else {
        Write-Response $true $result
    }
}
