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
#   { "cmd": "screen_read_text" }                 # whole desktop
#   { "cmd": "screen_read_text", "pid": 12345 }   # only that window (BUG-108)
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

# BUG-139: resolve the SMTC session-manager WinRT type ONCE here instead of on every
# media_status / SMTC-control call. Send-SmtcControl and Handle-MediaStatus
# both re-ran Add-Type + this same [Type]::GetType(...) string on every
# invocation, and media.js polls media_status every 5s for the life of the
# media widget -- unbounded repeated assembly-scan + type-string resolution.
# $null here (older/N-edition Windows without the media stack) is preserved
# and handled by both callers exactly as before (honest "API not available").
$script:SmtcManagerType = [Type]::GetType('Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, Version=255.255.255.255, Culture=neutral, PublicKeyToken=null, ContentType=WindowsRuntime')

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

    // WAVE 9 (BUG-060): a window can be the foreground window while MINIMIZED.
    // On 2026-07-31 Notepad sat at -32000,-32000 (the minimized parking
    // coordinate) for 80+ seconds after focus_window reported focused:true, so
    // GetForegroundWindow alone is not proof the operator can see anything.
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    // WAVE 9 (BUG-071): WM_CHAR delivers TEXT to React editors but not editing keys.
    // Measured 2026-08-01 against WhatsApp: WM_CHAR backspace (0x08) left the text
    // untouched, because React listens for keydown, not char, for Backspace/Enter.
    // WM_KEYDOWN/WM_KEYUP carry those.
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const int VK_BACK = 0x08;
    public const int VK_DELETE = 0x2E;
    public const int VK_A = 0x41;
    public const int VK_CONTROL = 0x11;

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

    // WAVE 2 — an alternative injection route for diagnose_type. SendInput is a
    // whole-desktop, foreground-dependent mechanism; posting WM_CHAR addresses one
    // specific control and so survives some cases where SendInput is dropped
    // (and fails in others, e.g. controls that only read real key events). Which
    // one actually works per app class is a question to be MEASURED, not guessed:
    // on 2026-07-31 SendInput reported a full 23-character injection into a
    // confirmed-foreground Notepad that a screenshot showed empty.
    //
    // GetFocus is thread-local — it reports the focused control of the CALLING
    // thread's input queue, so it is only meaningful between AttachThreadInput
    // calls (already declared above for exactly that reason).
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetFocus();

    public const uint WM_CHAR = 0x0102;

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
        # BUG-139: use the script-scope type resolved once at startup (see line ~70)
        # instead of re-resolving it on every call.
        $type = $script:SmtcManagerType
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
# process that may not exist yet when Start-Process returns. Never throws:
# StartTime is access-denied on protected processes, so ordering is by pid (newer
# processes get higher pids) rather than by start time.
#
# WAVE 1, and this is the whole point of the function now: matching on WINDOW
# TITLE is not resolution. It used to be the third fallback and it returned a
# bare pid indistinguishable from a real process-name match, which produced the
# 2026-07-31 11:25:57 failure: launch_app("notepad") matched the operator's IDE
# because its title read "Agent_OS-main - Antigravity IDE - Fix notepad
# typing...". Two ui_type calls then put 23 characters each into the IDE, and
# from-pc.js's honesty cross-check PASSED because the landed pid and the target
# pid were the same wrong pid (16800). A Ctrl+N intended to give Notepad a fresh
# document went to the IDE too.
#
# So: a process-name match is a RESOLUTION; a title match is at most a CANDIDATE
# for a human (or the model) to disambiguate out loud. Returns
#   @{ pid = <id>; matchedBy = 'process' }                     -- usable
#   @{ pid = <id>; matchedBy = 'title'; title = <window text> } -- NOT usable as the target
#   $null
# A title hit deliberately does NOT short-circuit the poll: we keep waiting for a
# real process to appear and only fall back to the candidate at the deadline,
# because "the app is still starting" is far more common than "the app is named
# after someone else's window title".
function Resolve-WindowedProcessByName($Name, $TimeoutMs) {
    if (-not $Name) { return $null }
    if (-not $TimeoutMs) { $TimeoutMs = 6000 }
    $needle = ([string]$Name).Trim()
    if ($needle.ToLowerInvariant().EndsWith('.exe')) { $needle = $needle.Substring(0, $needle.Length - 4) }
    $needle = $needle -replace '\s', ''
    if (-not $needle) { return $null }

    $candidate = $null
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $windowed = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
            # Exact process-name match wins, then a partial one. Both are real
            # resolutions and return immediately.
            $hit = $windowed | Where-Object { ($_.ProcessName -replace '\s', '') -ieq $needle } |
                Sort-Object Id -Descending | Select-Object -First 1
            if (-not $hit) {
                $hit = $windowed | Where-Object { ($_.ProcessName -replace '\s', '') -like ('*' + $needle + '*') } |
                    Sort-Object Id -Descending | Select-Object -First 1
            }
            if ($hit) { return @{ pid = $hit.Id; matchedBy = 'process' } }

            # Title-only hit: remember it, keep polling for a real process.
            if (-not $candidate) {
                $titleHit = $windowed | Where-Object { $_.MainWindowTitle -and (($_.MainWindowTitle -replace '\s', '') -like ('*' + $needle + '*')) } |
                    Sort-Object Id -Descending | Select-Object -First 1
                if ($titleHit) {
                    $candidate = @{ pid = $titleHit.Id; matchedBy = 'title'; title = $titleHit.MainWindowTitle }
                }
            }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    if ($candidate) { return $candidate }
    return $null
}

# Build a launch_app response without ever presenting a title match as the
# launched app. Shared by all three launch paths (registry App Paths,
# shell:AppsFolder, bare Start-Process) so the rule cannot hold in one and leak
# in another.
#
# A resolved launch carries `pid` + resolved:$true. An unresolved one carries NO
# `pid` at all — deliberately, because from-pc.js keys lastLaunchedPid and the
# fresh-document Ctrl+N off its presence, and a pid it cannot trust is worse than
# no pid: no pid degrades to "I could not confirm which window", while a wrong
# pid types into a stranger's window and reports success.
function New-LaunchResult($Name, $ResolvedPid, $Resolution, $Via) {
    $r = @{ name = $Name; launched = $true }
    if ($Via) { $r.resolvedVia = $Via }

    if ($ResolvedPid) {
        $r.pid = $ResolvedPid; $r.resolved = $true; $r.matchedBy = 'process'
        return $r
    }
    if ($Resolution -and $Resolution.matchedBy -eq 'process') {
        $r.pid = $Resolution.pid; $r.resolved = $true; $r.matchedBy = 'process'
        return $r
    }

    $r.resolved = $false
    if ($Resolution -and $Resolution.matchedBy -eq 'title') {
        $r.matchedBy = 'title'
        $r.candidatePid = $Resolution.pid
        $r.candidateTitle = $Resolution.title
        $r.note = ('No process named like "' + $Name + '" owns a window. One unrelated window''s TITLE mentions it (' +
                   $Resolution.title + '), which is not the same thing and is NOT being targeted. Ask which window is meant, or launch the app again.')
    } else {
        $r.note = 'launched but no windowed process matching the name could be confirmed; a later focus_window/ui_type has no trustworthy target.'
    }
    return $r
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
                $resolution = $null
                if (-not $realPid) { $resolution = Resolve-WindowedProcessByName $name 6000 }
                return (New-LaunchResult $name $realPid $resolution 'registry-app-paths')
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
                $resolution = Resolve-WindowedProcessByName $name 8000
                return (New-LaunchResult $name $null $resolution 'start-apps')
            } catch { $attempted += ('shell:AppsFolder ' + $appId + ': ' + $_.Exception.Message) }
        } else { $attempted += 'Get-StartApps: no match' }
    }

    # Try Start-Process with the name
    try {
        $proc = Start-Process -FilePath $name -PassThru -ErrorAction Stop
        Start-Sleep -Milliseconds 500
        $realPid = Resolve-RealProcessAfterLaunch $proc $name
        $resolution = $null
        if (-not $realPid) { $resolution = Resolve-WindowedProcessByName $name 6000 }
        return (New-LaunchResult $name $realPid $resolution $null)
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
            # BUG-122 instrumentation (2026-08-06). Closing a Brave window was
            # unreliable, and list_windows appeared to report two windowed Brave
            # processes for one visible window — appeared, because nothing in the
            # reply could tell two DISTINCT top-level windows apart from two rows
            # describing the SAME one. The native handle is what distinguishes
            # them: two rows sharing one hwnd is a duplicate to be deduped here,
            # two rows with different hwnds is a real second window (a Chromium
            # helper, say) and close_window's target choice is the thing at fault.
            # Additive field, reported honestly as '0' when UIA has no handle.
            $hwnd = $child.Current.NativeWindowHandle
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
            hwnd = ([string]$hwnd)   # BUG-122 instrumentation — see above
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

        # WAVE 9 (BUG-060) — foreground is not the same as visible. Windows will
        # happily name a MINIMIZED window as foreground, and on 2026-07-31 that is
        # exactly what happened: focus_window returned focused:true while Notepad
        # sat at -32000,-32000, so the operator watched an empty desktop while
        # MYTHOS reported success. One more restore, then an honest failure.
        if ([NativeInput]::IsIconic($hwnd)) {
            [NativeInput]::ShowWindow($hwnd, [NativeInput]::SW_RESTORE) | Out-Null
            Start-Sleep -Milliseconds 200
            if ([NativeInput]::IsIconic($hwnd)) {
                return ('PID ' + $TargetPid + ' is the foreground window but is still MINIMIZED after a restore, so nothing is visible on screen and typing into it cannot be trusted.')
            }
            $method = $method + '+restore-iconic'
        }
        return @{ pid = $TargetPid; focused = $true; visible = $true; method = $method }
    } catch {
        return ('Cannot focus PID ' + $TargetPid + ': ' + $_.Exception.Message)
    }
}

function Handle-CloseWindow($TargetPid) {
    # BUG-103 (2026-08-05 incident): this handler failed both ways on browsers.
    #   1. Chrome: the pid held upstream was a non-windowed child (or the process
    #      had already exited), so Get-Process/CloseMainWindow could not act and
    #      the operator heard "the process couldn't be found".
    #   2. Brave: WaitForExit(3000) is the WRONG ORACLE for a multi-window,
    #      multi-process browser — closing one window never exits the process, so
    #      a successful close looked like a timeout.
    #   3. Worse, the timeout branch returned a HASHTABLE (`closed=$false`), and
    #      the dispatcher reads any hashtable as ok:true — a window that was still
    #      open was audited as a successful close. Returning a STRING is how this
    #      file reports an honest failure (see Handle-FocusWindow's FIX 2).
    # The oracle is now the window handle itself, and a pid with no main window is
    # re-resolved to the windowed process of the same executable.
    if (-not $TargetPid) { return 'PID is required.' }
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction Stop
    } catch {
        return ('Cannot close PID ' + $TargetPid + ': ' + $_.Exception.Message)
    }

    $resolvedPid = $TargetPid
    $resolvedBy = 'pid'
    if ($proc.MainWindowHandle -eq [IntPtr]::Zero) {
        # A non-windowed process of a multi-process app (browser renderer/utility,
        # or a launcher stub). Same class as launch_app's MSIX fix: resolve the
        # process that actually OWNS a window before acting.
        $windowed = Resolve-WindowedProcessByName $proc.ProcessName 1500
        if ($null -eq $windowed -or -not $windowed.pid) {
            return ('PID ' + $TargetPid + ' (' + $proc.ProcessName + ') has no window to close, and no windowed ' +
                    $proc.ProcessName + ' process was found. Nothing was closed.')
        }
        try {
            $proc = Get-Process -Id $windowed.pid -ErrorAction Stop
        } catch {
            return ('Could not open the windowed ' + $proc.ProcessName + ' process (PID ' + $windowed.pid + '): ' + $_.Exception.Message)
        }
        $resolvedPid = $windowed.pid
        $resolvedBy = 'windowed-sibling'
    }

    # BUG-122 instrumentation: record WHICH window handle this handler actually
    # acted on, before acting. The reported symptom is an unreliable Brave close
    # with two Brave PIDs in play, and the open question is whether the failing
    # close targeted a different window than the one the operator meant. Without
    # the handle in the reply, a failure names only a pid — and a pid is exactly
    # the thing that is ambiguous for a multi-window, multi-process browser.
    $targetHwnd = ([string]$proc.MainWindowHandle)
    $targetName = $proc.ProcessName

    $proc.CloseMainWindow() | Out-Null

    # Oracle: the main window is gone (or the whole process exited). Poll rather
    # than WaitForExit — a browser with other windows open stays alive on purpose.
    $deadline = [DateTime]::UtcNow.AddMilliseconds(3000)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $proc.Refresh()
            if ($proc.HasExited -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
                return @{ pid = $resolvedPid; requestedPid = $TargetPid; closed = $true; graceful = $true;
                          resolvedBy = $resolvedBy; hwnd = $targetHwnd; processName = $targetName }
            }
        } catch {
            # Refresh throws once the process is gone — that IS the close.
            return @{ pid = $resolvedPid; requestedPid = $TargetPid; closed = $true; graceful = $true;
                      resolvedBy = $resolvedBy; hwnd = $targetHwnd; processName = $targetName }
        }
        Start-Sleep -Milliseconds 150
    }

    # Honest failure as a STRING so the dispatcher reports ok:false. Never a
    # force-kill: closing a browser out from under unsaved state is the
    # operator's call, not this handler's.
    return ('Window for PID ' + $resolvedPid + ' (' + $targetName + ', window handle ' + $targetHwnd +
            ', resolved by ' + $resolvedBy + ') did not close within 3s and is still open. Nothing was closed. ' +
            'It may be showing a confirmation prompt — check the screen, or ask me to force it.')
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
        # BUG-126: `stale` distinguishes "that process is gone" from every other
        # refusal below (minimized, no main window, off-screen). Those are
        # deliberate — reading them anyway would OCR whatever content happens to
        # occupy the rectangle and report it as the target's. A dead PID is the
        # only one where widening the read is honest, and only a caller that says
        # so in its reply may act on this flag.
        return @{ ok = $false; stale = $true; error = ('Cannot find PID ' + $TargetPid + ': ' + $_.Exception.Message) }
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

# BUG-127 — per-application volume. "Lower Spotify" used to move the SYSTEM
# master volume (Handle-SetVolume above), i.e. it turned down the whole machine
# including MYTHOS's own voice. Core Audio models each app's playback as a
# SESSION on the endpoint, and ISimpleAudioVolume sets that session alone —
# exactly what the Windows Volume Mixer shows per app.
#
# Separate interface declarations from Get-AudioEndpointVolumeType's on purpose:
# that block's IMMDevice.Activate is typed to IAudioEndpointVolume, and this path
# needs IAudioSessionManager2 out of the same call. Names are Mythos-prefixed so
# both type blocks can coexist in one AppDomain.
$script:AppVolumeType = $null
function Get-AppVolumeType {
    if ($script:AppVolumeType) { return $script:AppVolumeType }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMythosDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMythosDevice endpoint);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMythosDevice {
    int Activate(ref Guid id, int clsCtx, IntPtr activationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

// IAudioSessionManager2 : IAudioSessionManager — the two inherited slots
// (GetAudioSessionControl, GetSimpleAudioVolume) must be declared to keep the
// vtable offsets right, even though neither is called here.
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMythosSessionManager2 {
    int NotImpl1();
    int NotImpl2();
    int GetSessionEnumerator(out IMythosSessionEnumerator sessionEnum);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMythosSessionEnumerator {
    int GetCount(out int sessionCount);
    int GetSession(int sessionIndex, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}

// IAudioSessionControl2 : IAudioSessionControl — same rule, the nine inherited
// slots come first.
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMythosSessionControl2 {
    int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4(); int NotImpl5();
    int NotImpl6(); int NotImpl7(); int NotImpl8(); int NotImpl9();
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
    int GetProcessId(out uint retVal);
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMythosSimpleAudioVolume {
    int SetMasterVolume(float level, ref Guid eventContext);
    int GetMasterVolume(out float level);
    int SetMute(bool mute, ref Guid eventContext);
    int GetMute(out bool mute);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MythosAppVolEnumeratorComObject { }

public static class MythosAppVolume {
    private static IMythosSessionEnumerator GetSessions() {
        var enumerator = (IMythosDeviceEnumerator)(new MythosAppVolEnumeratorComObject());
        IMythosDevice dev;
        // eRender = 0 (playback), eMultimedia = 1
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
        Guid iid = typeof(IMythosSessionManager2).GUID;
        object raw;
        // CLSCTX_ALL = 23
        Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out raw));
        IMythosSessionEnumerator sessions;
        Marshal.ThrowExceptionForHR(((IMythosSessionManager2)raw).GetSessionEnumerator(out sessions));
        return sessions;
    }

    private static string NameForPid(uint processId) {
        if (processId == 0) return "system-sounds";
        try { return System.Diagnostics.Process.GetProcessById((int)processId).ProcessName; }
        catch { return ""; }   // process exited between enumeration and lookup
    }

    // "name|pid" per live session — the honest failure message names what was
    // actually there, instead of claiming the app does not exist.
    public static string[] ListSessions() {
        var found = new List<string>();
        var sessions = GetSessions();
        int count;
        Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
        for (int i = 0; i < count; i++) {
            object ctl;
            if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
            var ctl2 = ctl as IMythosSessionControl2;
            if (ctl2 == null) continue;
            uint processId;
            if (ctl2.GetProcessId(out processId) != 0) continue;
            string listName = NameForPid(processId);
            if (string.IsNullOrEmpty(listName)) listName = "(unknown)";
            found.Add(listName + "|" + processId);
        }
        return found.ToArray();
    }

    // "name|pid|readBackLevel" per session actually changed. Empty array means
    // nothing matched — the caller must NOT fall back to master volume.
    public static string[] SetVolume(string name, int targetProcessId, float level) {
        var changed = new List<string>();
        var sessions = GetSessions();
        int count;
        Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
        for (int i = 0; i < count; i++) {
            object ctl;
            if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
            var ctl2 = ctl as IMythosSessionControl2;
            if (ctl2 == null) continue;
            uint processId;
            if (ctl2.GetProcessId(out processId) != 0) continue;
            string processName = NameForPid(processId);
            bool match = targetProcessId > 0
                ? ((int)processId == targetProcessId)
                : (!string.IsNullOrEmpty(name) &&
                   string.Equals(processName, name, StringComparison.OrdinalIgnoreCase));
            if (!match) continue;
            var vol = ctl as IMythosSimpleAudioVolume;
            if (vol == null) continue;
            Guid ctx = Guid.Empty;
            Marshal.ThrowExceptionForHR(vol.SetMasterVolume(level, ref ctx));
            float actual;
            Marshal.ThrowExceptionForHR(vol.GetMasterVolume(out actual));
            changed.Add(processName + "|" + processId + "|" + ((int)Math.Round(actual * 100)));
        }
        return changed.ToArray();
    }

    // BUG-161: "name|pid|level|muted" per matching session, read-only. Exists so
    // a relative step ("turn Spotify down") can read the CURRENT level first and
    // go through SetVolume's read-back oracle, instead of firing global volume
    // VK keys that move the master volume (or nothing) while reporting success.
    public static string[] GetVolume(string name, int targetProcessId) {
        var found = new List<string>();
        var sessions = GetSessions();
        int count;
        Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
        for (int i = 0; i < count; i++) {
            object ctl;
            if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
            var ctl2 = ctl as IMythosSessionControl2;
            if (ctl2 == null) continue;
            uint processId;
            if (ctl2.GetProcessId(out processId) != 0) continue;
            string processName = NameForPid(processId);
            bool match = targetProcessId > 0
                ? ((int)processId == targetProcessId)
                : (!string.IsNullOrEmpty(name) &&
                   string.Equals(processName, name, StringComparison.OrdinalIgnoreCase));
            if (!match) continue;
            var vol = ctl as IMythosSimpleAudioVolume;
            if (vol == null) continue;
            float level;
            Marshal.ThrowExceptionForHR(vol.GetMasterVolume(out level));
            bool muted;
            Marshal.ThrowExceptionForHR(vol.GetMute(out muted));
            found.Add(processName + "|" + processId + "|" + ((int)Math.Round(level * 100)) + "|" + (muted ? "1" : "0"));
        }
        return found.ToArray();
    }

    // BUG-161: set the mute flag on matching sessions; "name|pid|muted" read
    // back per session actually changed. Same no-match contract as SetVolume:
    // an empty array means the caller must fail, never widen to the master.
    public static string[] SetMute(string name, int targetProcessId, bool mute) {
        var changed = new List<string>();
        var sessions = GetSessions();
        int count;
        Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
        for (int i = 0; i < count; i++) {
            object ctl;
            if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
            var ctl2 = ctl as IMythosSessionControl2;
            if (ctl2 == null) continue;
            uint processId;
            if (ctl2.GetProcessId(out processId) != 0) continue;
            string processName = NameForPid(processId);
            bool match = targetProcessId > 0
                ? ((int)processId == targetProcessId)
                : (!string.IsNullOrEmpty(name) &&
                   string.Equals(processName, name, StringComparison.OrdinalIgnoreCase));
            if (!match) continue;
            var vol = ctl as IMythosSimpleAudioVolume;
            if (vol == null) continue;
            Guid ctx = Guid.Empty;
            Marshal.ThrowExceptionForHR(vol.SetMute(mute, ref ctx));
            bool actual;
            Marshal.ThrowExceptionForHR(vol.GetMute(out actual));
            changed.Add(processName + "|" + processId + "|" + (actual ? "1" : "0"));
        }
        return changed.ToArray();
    }
}
'@ -ErrorAction Stop
    $script:AppVolumeType = [MythosAppVolume]
    return $script:AppVolumeType
}

# $TargetPid, never $pid — $pid is a read-only PowerShell automatic variable and
# a parameter of that name throws at binding time (see adapters/CLAUDE.md).
function Handle-SetAppVolume($name, $TargetPid, $level) {
    if ($null -eq $level -or $level -eq '') { return 'level (0-100) is required.' }
    $lvl = 0
    if (-not [int]::TryParse("$level", [ref]$lvl)) { return "level must be a number (got '$level')." }
    if ($lvl -lt 0 -or $lvl -gt 100) { return "level must be 0-100 (got $lvl)." }
    $wantPid = 0
    if ($null -ne $TargetPid -and "$TargetPid" -ne '') {
        if (-not [int]::TryParse("$TargetPid", [ref]$wantPid)) { return "pid must be a number (got '$TargetPid')." }
    }
    $wantName = ''
    if ($null -ne $name) { $wantName = ("$name" -replace '\.exe$', '') }
    if ($wantPid -le 0 -and $wantName -eq '') { return 'name or pid is required.' }
    try {
        $type = Get-AppVolumeType
        $changed = @($type::SetVolume($wantName, $wantPid, [float]($lvl / 100.0)))
        if ($changed.Count -eq 0) {
            # Honest failure: an app with no audio session simply has no volume
            # to set. Say what was searched for and what was there — never
            # silently move the master volume instead.
            $seen = @($type::ListSessions())
            $target = if ($wantPid -gt 0) { "pid $wantPid" } else { "process '$wantName'" }
            $names = if ($seen.Count -gt 0) { ($seen -join ', ') } else { '(none)' }
            # ASCII only inside the literal: PowerShell 5.1 reads this file in the
            # ANSI codepage, so a non-ASCII character in a STRING (comments are
            # fine) corrupts the token and fails to parse.
            return "No audio session for $target - its volume was NOT changed, and nothing else was changed either. Apps with a live audio session right now: $names. An app that is not currently playing audio has no session to set."
        }
        $applied = @()
        foreach ($entry in $changed) {
            $f = $entry -split '\|'
            $applied += @{ process = $f[0]; pid = [int]$f[1]; level = [int]$f[2] }
        }
        return @{ sessions = $applied; level = [int]$applied[0].level; count = $applied.Count }
    } catch {
        return ('set_app_volume failed: ' + $_.Exception.Message)
    }
}

# BUG-161: read-only twin of Handle-SetAppVolume. Exists so a relative volume
# step ("turn Spotify down") can read the CURRENT per-app level and then go
# through set_app_volume's read-back oracle, instead of firing global volume
# VK keys that move the master volume (or nothing) while reporting success.
function Handle-GetAppVolume($name, $TargetPid) {
    $wantPid = 0
    if ($null -ne $TargetPid -and "$TargetPid" -ne '') {
        if (-not [int]::TryParse("$TargetPid", [ref]$wantPid)) { return "pid must be a number (got '$TargetPid')." }
    }
    $wantName = ''
    if ($null -ne $name) { $wantName = ("$name" -replace '\.exe$', '') }
    if ($wantPid -le 0 -and $wantName -eq '') { return 'name or pid is required.' }
    try {
        $type = Get-AppVolumeType
        $found = @($type::GetVolume($wantName, $wantPid))
        if ($found.Count -eq 0) {
            $seen = @($type::ListSessions())
            $target = if ($wantPid -gt 0) { "pid $wantPid" } else { "process '$wantName'" }
            $names = if ($seen.Count -gt 0) { ($seen -join ', ') } else { '(none)' }
            # ASCII only inside the literal - see Handle-SetAppVolume's note.
            return "No audio session for $target - there is no per-app volume to read. Apps with a live audio session right now: $names."
        }
        $sessions = @()
        foreach ($entry in $found) {
            $f = $entry -split '\|'
            $sessions += @{ process = $f[0]; pid = [int]$f[1]; level = [int]$f[2]; muted = ($f[3] -eq '1') }
        }
        return @{ sessions = $sessions; level = [int]$sessions[0].level; muted = [bool]$sessions[0].muted; count = $sessions.Count }
    } catch {
        return ('get_app_volume failed: ' + $_.Exception.Message)
    }
}

# BUG-161: per-app mute via ISimpleAudioVolume.SetMute, with read-back. Same
# no-match contract as set_app_volume: fail naming what was searched, never
# widen to the master mute.
function Handle-SetAppMute($name, $TargetPid, $mute) {
    $wantMute = $true
    if ($null -ne $mute -and ("$mute" -eq 'false' -or "$mute" -eq '0')) { $wantMute = $false }
    $wantPid = 0
    if ($null -ne $TargetPid -and "$TargetPid" -ne '') {
        if (-not [int]::TryParse("$TargetPid", [ref]$wantPid)) { return "pid must be a number (got '$TargetPid')." }
    }
    $wantName = ''
    if ($null -ne $name) { $wantName = ("$name" -replace '\.exe$', '') }
    if ($wantPid -le 0 -and $wantName -eq '') { return 'name or pid is required.' }
    try {
        $type = Get-AppVolumeType
        $changed = @($type::SetMute($wantName, $wantPid, $wantMute))
        if ($changed.Count -eq 0) {
            $seen = @($type::ListSessions())
            $target = if ($wantPid -gt 0) { "pid $wantPid" } else { "process '$wantName'" }
            $names = if ($seen.Count -gt 0) { ($seen -join ', ') } else { '(none)' }
            return "No audio session for $target - its mute state was NOT changed, and nothing else was changed either. Apps with a live audio session right now: $names."
        }
        $applied = @()
        foreach ($entry in $changed) {
            $f = $entry -split '\|'
            $applied += @{ process = $f[0]; pid = [int]$f[1]; muted = ($f[2] -eq '1') }
        }
        return @{ sessions = $applied; muted = [bool]$applied[0].muted; count = $applied.Count }
    } catch {
        return ('set_app_mute failed: ' + $_.Exception.Message)
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
# BUG-108 — the rectangle a window-scoped OCR capture should cover.
#
# Deliberately a COMPOSITION of the two window resolvers this file already has,
# not a new one: Resolve-TargetWindow (pid -> a process with a real
# MainWindowHandle) and Get-RectBounds over the UIA BoundingRectangle, which is
# the exact normalizer Handle-ListWindows reports window rects with. So the
# rectangle captured here is the same rectangle list_windows already showed the
# model, and the two can never disagree.
#
# NOTE the parameter is $TargetPid, never $pid — $pid is a read-only PowerShell
# automatic variable and a parameter of that name throws at binding time.
function Get-TargetWindowRect($TargetPid) {
    $w = Resolve-TargetWindow $TargetPid
    # BUG-126: carry the stale flag through — the caller decides what to do with
    # it, this function only reports what it found.
    if (-not $w.ok) { return @{ ok = $false; stale = [bool]$w.stale; error = $w.error } }
    # A minimized window parks at -32000,-32000 with none of its content on
    # screen. OCRing that rectangle would read whatever is actually there and
    # report it as this window's content — the same trap BUG-060 hit in
    # focus_window. Refuse instead.
    if ([NativeInput]::IsIconic($w.hwnd)) {
        return @{ ok = $false; error = ('PID ' + $TargetPid + ' is minimized, so none of its content is on screen to read. ' +
            'Restore it first (snap_window with position restore), then read it.') }
    }
    $bounds = $null
    try {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($w.hwnd)
        $bounds = Get-RectBounds $el.Current.BoundingRectangle
    } catch {
        $bounds = $null
    }
    if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) {
        # UIA can refuse a handle it does not like. GetWindowRect is already
        # declared in NativeInput above for exactly this kind of second opinion.
        $native = New-Object 'NativeInput+RECT'
        if ([NativeInput]::GetWindowRect($w.hwnd, [ref]$native)) {
            $bounds = @{
                x = $native.Left
                y = $native.Top
                width = ($native.Right - $native.Left)
                height = ($native.Bottom - $native.Top)
            }
        }
    }
    if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) {
        return @{ ok = $false; error = ('Could not measure the window rectangle for PID ' + $TargetPid +
            ', so there is nothing safe to capture.') }
    }
    # Clip to the desktop: a window can be dragged partly (or entirely) off-screen,
    # and only the on-screen part can be captured — or clicked afterwards.
    $want = New-Object System.Drawing.Rectangle([int]$bounds.x, [int]$bounds.y, [int]$bounds.width, [int]$bounds.height)
    $clipped = [System.Drawing.Rectangle]::Intersect($want, [System.Windows.Forms.SystemInformation]::VirtualScreen)
    if ($clipped.Width -le 0 -or $clipped.Height -le 0) {
        return @{ ok = $false; error = ('The window for PID ' + $TargetPid + ' is entirely off-screen, so there is nothing to read.') }
    }
    return @{ ok = $true; x = $clipped.X; y = $clipped.Y; width = $clipped.Width; height = $clipped.Height }
}

function Handle-ScreenReadText($TargetPid) {
    # BUG-108: with no $TargetPid this captures the primary screen exactly as it
    # always did (existing callers: screen_look's OCR grounding, from-app-reply,
    # the Electron OCR hotkey). With one, it captures ONLY that window — the
    # incident was an OCR of MYTHOS's own HUD standing in for a YouTube page,
    # because there was no way to ask for one window.
    #
    # Windows.Media.Ocr reports word boxes relative to the BITMAP it was handed,
    # so a window capture yields WINDOW-relative coordinates. Rather than return
    # coordinates that silently mean different things depending on the arguments,
    # every reply carries `origin` — the top-left of the rectangle that was
    # captured, (0,0) for the full-desktop case — and from-pc.js's
    # toAbsoluteRegions() is the single place it is added back on before anything
    # is clicked.
    #
    # KNOWN LIMIT, stated rather than hidden: this narrows the SCREEN AREA the
    # window occupies, it does not render the window itself (no PrintWindow —
    # which returns black for the DirectComposition/Chromium windows this is most
    # needed for). A target sitting behind another window therefore reads
    # whatever is on top of it. Scoping is what stops a match in an unrelated
    # window; focus_window first is what makes the target the thing being read.
    #
    # BUG-126 (2026-08-05): a PID that no longer exists used to dead-end here —
    # the read returned 'Cannot find PID 1234' and there was nothing the model
    # could do next, because screen_read_text's only parameter IS the pid (a
    # name-based re-resolution needs a schema change, tracked separately). A
    # stale PID is almost always a window that was closed or relaunched between
    # list_windows and the read, and the full-desktop read the caller would have
    # got by passing nothing at all is still useful. So widen — and SAY SO in
    # the reply, naming the dead PID, so neither the model nor the operator can
    # mistake a whole-screen read for a read of the window they asked about.
    #
    # Only the stale case widens. Minimized / no-main-window / entirely
    # off-screen stay hard refusals: the window exists, so a full-screen read
    # would be answering a different question than the one asked.
    $note = $null
    if ($TargetPid) {
        $wr = Get-TargetWindowRect $TargetPid
        if (-not $wr.ok -and -not $wr.stale) { return $wr.error }
        if (-not $wr.ok) {
            $screenBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $capX = [int]$screenBounds.X; $capY = [int]$screenBounds.Y
            $capW = [int]$screenBounds.Width; $capH = [int]$screenBounds.Height
            $scope = 'screen'
            $note = ('PID ' + $TargetPid + ' no longer exists, so I could not read that window. ' +
                'This is a read of the WHOLE SCREEN instead, not of the window you asked for. ' +
                'Call list_windows to get a current PID if you need that specific window.')
        } else {
            $capX = [int]$wr.x; $capY = [int]$wr.y; $capW = [int]$wr.width; $capH = [int]$wr.height
            $scope = 'window'
        }
    } else {
        $screenBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $capX = [int]$screenBounds.X; $capY = [int]$screenBounds.Y
        $capW = [int]$screenBounds.Width; $capH = [int]$screenBounds.Height
        $scope = 'screen'
    }
    try {
        $bmp = New-Object System.Drawing.Bitmap($capW, $capH)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($capX, $capY, 0, 0, (New-Object System.Drawing.Size($capW, $capH)))
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

        # 2026-08-02: this used to be `$ocr.Lines | ForEach-Object { $_.Text }` — it read
        # the screen and then threw away WHERE everything was. Every OcrWord carries a
        # BoundingRect in the pixel space of the captured bitmap (this process is
        # DPI-aware per the block at the top of this file), so the coordinates needed to
        # click a piece of text were being computed by Windows and discarded here.
        # Since BUG-108 that space is "relative to `origin`" rather than always
        # screen-absolute — identical for a full-desktop capture, offset by the window's
        # top-left for a scoped one. Do NOT add the offset here as well; from-pc.js owns
        # that translation and doing it twice sends every click to the wrong place.
        #
        # Line-level boxes, unioned from the words: a click target is a label, not a
        # word, and per-word boxes would make "Type a message" three targets.
        # ADDITIVE ONLY — text/lineCount keep their exact previous shape because
        # screen_read_text has existing callers.
        $lines = @()
        $regions = @()
        foreach ($line in $ocr.Lines) {
            $lines += $line.Text
            $minX = $null; $minY = $null; $maxX = $null; $maxY = $null
            foreach ($word in $line.Words) {
                $r = $word.BoundingRect
                if ($null -eq $r) { continue }
                $x2 = $r.X + $r.Width
                $y2 = $r.Y + $r.Height
                if ($null -eq $minX -or $r.X -lt $minX) { $minX = $r.X }
                if ($null -eq $minY -or $r.Y -lt $minY) { $minY = $r.Y }
                if ($null -eq $maxX -or $x2  -gt $maxX) { $maxX = $x2 }
                if ($null -eq $maxY -or $y2  -gt $maxY) { $maxY = $y2 }
            }
            # A line whose words carry no geometry is still real text — it belongs in
            # `text` (appended above) but must NOT become an un-clickable region with a
            # zero box, which a caller would happily click at 0,0.
            if ($null -eq $minX) { continue }
            $regions += @{
                text   = $line.Text
                x      = [int][Math]::Round($minX)
                y      = [int][Math]::Round($minY)
                width  = [int][Math]::Round($maxX - $minX)
                height = [int][Math]::Round($maxY - $minY)
            }
        }
        # BUG-126: `note` is present ONLY when the read widened off a dead PID.
        # Absent on every other path, so the existing reply shape is unchanged
        # for every existing caller.
        $reply = @{
            text = ($lines -join "`n")
            lineCount = $lines.Count
            regions = $regions
            # The rectangle these regions are relative to. (0,0) for a full-desktop
            # capture, so that reply is byte-identical to the pre-BUG-108 shape apart
            # from these two additive fields.
            origin = @{ x = $capX; y = $capY }
            scope = $scope
        }
        if ($note) { $reply.note = $note }
        return $reply
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

# WAVE 2 — the read-back oracle. Nothing in this file could previously READ text
# back out of a control, which is why "SendInput accepted 46 events" was the
# strongest evidence ui_type had, and why an empty Notepad could be reported as
# holding 23 typed characters.
#
# Reads the text of the currently FOCUSED element (whatever actually received the
# keystrokes, which is the honest thing to inspect — not the element we hoped for).
# Two patterns, in order of directness:
#   ValuePattern  — edit boxes, most Win32/WinForms/WPF single-line controls.
#   TextPattern   — documents; Notepad, Word, and most rich editors expose this.
# Returns @{ text; via } or $null when the element exposes neither. $null is a
# legitimate, common answer (games, canvas-drawn Electron surfaces) and MUST be
# reported as "cannot confirm" rather than as failure.
#
# TextPattern is READ-ONLY in UI Automation — it has no insertion API, so it can
# serve as an oracle but never as a typing mechanism.
# Chromium/Electron builds its accessibility tree LAZILY, on first UIA query — the
# gotcha this repo already documents for Spotify. Measured live 2026-07-31 against
# an Electron editor: the first Read-FocusedElementText returned $null, and every
# call in a later process returned via=ValuePattern immediately, because the first
# query is what triggered the tree to build.
#
# Without a retry, the FIRST type into a freshly-started Slack/Discord/Electron app
# would report unverified even though the text landed — honest, but needlessly so,
# and it would also deny that type its Enter under Wave 2's messaging guard. One
# retry converts that into a real confirmation.
function Read-FocusedElementText() {
    $r = Read-FocusedElementTextOnce
    if ($null -ne $r) { return $r }
    Start-Sleep -Milliseconds 250
    return Read-FocusedElementTextOnce
}

function Read-FocusedElementTextOnce() {
    try {
        $el = [System.Windows.Automation.AutomationElement]::FocusedElement
        if (-not $el) { return $null }

        try {
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) -as [System.Windows.Automation.ValuePattern]
            if ($vp) { return @{ text = [string]$vp.Current.Value; via = 'ValuePattern' } }
        } catch { }

        try {
            $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) -as [System.Windows.Automation.TextPattern]
            if ($tp) { return @{ text = [string]$tp.DocumentRange.GetText(-1); via = 'TextPattern' } }
        } catch { }

        return $null
    } catch {
        return $null
    }
}

# Whitespace-insensitive containment. Typing normalises newlines and some controls
# report a trailing NUL or \r\n the caller never sent, so an exact compare would
# report false mismatches on text that genuinely landed.
function Test-TextLanded($Haystack, $Needle) {
    if ($null -eq $Haystack) { return $false }
    $h = ([string]$Haystack) -replace '\s', ''
    $n = ([string]$Needle) -replace '\s', ''
    if (-not $n) { return $false }
    return $h.Contains($n)
}

# Wave 3 (2026-08-13) — ctrl+s's UIA equivalent, scoped deliberately narrow (see
# Handle-SendKey's combo branch: this is the ONE combo that gets an escalation
# path, not a general mechanism). Finds the first on-screen, invokable element
# literally named 'Save' or 'Save As' anywhere in $Root's tree — a menu item or
# button, whichever the app exposes. Same "bounded by UIA itself" scan as
# Find-EditableDescendants below; a window's control tree is small enough that
# TrueCondition over Descendants is not slow in practice.
function Find-InvokableSaveDescendant($Root) {
    if (-not $Root) { return $null }
    $all = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
        try {
            if ($el.Current.IsOffscreen) { continue }
            $name = ([string]$el.Current.Name).Trim().TrimEnd('.', "`u{2026}")
            if ($name -ne 'Save' -and $name -ne 'Save As') { continue }
            $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) -as [System.Windows.Automation.InvokePattern]
            if ($ip) { return @{ element = $el; invoke = $ip; name = $name } }
        } catch { }
    }
    return $null
}

# Every editable, keyboard-focusable, on-screen descendant of $Root, as candidate
# records. Extracted from Handle-FocusMessageBox (Wave 7) so Handle-UiType can use
# the same live-proven search — measured 2026-07-31 against a real Electron window:
# 7 candidates found, SetFocus via TextPattern.
#
# Callers rank the results themselves, because "the place text goes" differs by
# intent: a chat app's compose box is the LOWEST box on screen, while a text
# editor's document is the LARGEST. One shared search, two honest pick strategies.
function Find-EditableDescendants($Root) {
    $candidates = @()
    if (-not $Root) { return $candidates }
    # Bounded by UIA itself; a window's tree is small enough that this is not slow.
    $all = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
        try {
            if (-not $el.Current.IsKeyboardFocusable) { continue }
            if ($el.Current.IsOffscreen) { continue }
            $editable = $false
            $via = $null
            try {
                $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) -as [System.Windows.Automation.ValuePattern]
                if ($vp -and -not $vp.Current.IsReadOnly) { $editable = $true; $via = 'ValuePattern' }
            } catch { }
            if (-not $editable) {
                try {
                    $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) -as [System.Windows.Automation.TextPattern]
                    if ($tp) { $editable = $true; $via = 'TextPattern' }
                } catch { }
            }
            if (-not $editable) { continue }
            $r = $el.Current.BoundingRectangle
            if ($r.Width -le 0 -or $r.Height -le 0) { continue }
            # ControlType matters for the editor case: a read-only document also
            # exposes TextPattern, so Edit/Document is the signal that this is
            # where typing belongs rather than merely somewhere text can be read.
            $ctName = 'unknown'
            try { $ctName = [string]$el.Current.ControlType.ProgrammaticName } catch { }
            $candidates += @{
                element = $el
                name = [string]$el.Current.Name
                via = $via
                controlType = $ctName
                isTextEntry = ($ctName -match 'ControlType\.(Edit|Document)$')
                area = [double]($r.Width * $r.Height)
                bottom = [double]($r.Y + $r.Height)
                cx = [int]($r.X + $r.Width / 2)
                cy = [int]($r.Y + $r.Height / 2)
            }
        } catch { }
    }
    return $candidates
}

# WAVE 9 (BUG-070) — "is this the same application?" by process ancestry.
#
# A WebView2 app spans two processes: the shell owns the window the caller knows
# about, the renderer child owns the text boxes AND takes the foreground once
# anything inside it is focused. So a guard written as `foregroundPid -ne callerPid`
# rejects the app's own renderer. That already bit the Enter guard (BUG-066) and then
# bit clear_focused_box and focus_message_box the same way.
#
# Ancestry in EITHER direction counts: the caller may hold the shell pid while the
# renderer is foreground, or the reverse.
function Test-SameApp($PidA, $PidB) {
    if (-not $PidA -or -not $PidB) { return $false }
    $a = [int]$PidA; $b = [int]$PidB
    if ($a -eq $b) { return $true }
    $parentOf = @{}
    try {
        foreach ($proc in (Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
            $parentOf[[int]$proc.ProcessId] = [int]$proc.ParentProcessId
        }
    } catch { return $false }
    foreach ($pair in @(@($a, $b), @($b, $a))) {
        $cur = $pair[0]
        for ($h = 0; $h -lt 8; $h++) {
            if (-not $parentOf.ContainsKey($cur)) { break }
            $cur = $parentOf[$cur]
            if ($cur -eq 0) { break }
            if ($cur -eq $pair[1]) { return $true }
        }
    }
    return $false
}

# WAVE 9 (BUG-065) — find the surface that actually holds the text boxes.
#
# A window's own UIA tree is not always where its UI lives. WhatsApp Desktop's
# foreground window is a WinUI shell (~8 elements) while the whole interface is a
# msedgewebview2 CHILD PROCESS registered as a SEPARATE desktop child, so walking
# down from the foreground hwnd finds nothing editable at all. Teams and other
# WebView2 apps share this shape.
#
# The link is PROCESS PARENTAGE. Geometry was tried first and was wrong: "the
# window whose centre lies inside the foreground window" matched a Notepad that
# merely overlapped WhatsApp and offered ITS document as the message box — BUG-052
# (right-looking target, wrong app) with a human on the other end. Titles are no
# better; they break on localisation and on the unread prefix ("(194) WhatsApp").
#
# Returns @{ root; candidates; embeddedPid } or $null. embeddedPid is non-null only
# when the surface was found in a descendant process rather than the window itself.
function Resolve-EditableSurface($Hwnd) {
    if ($Hwnd -eq [IntPtr]::Zero) { return $null }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
    if (-not $root) { return $null }

    $candidates = Find-EditableDescendants $root
    if ($candidates.Count -eq 0) {
        # Chromium builds its accessibility tree lazily, on first query.
        Start-Sleep -Milliseconds 300
        $candidates = Find-EditableDescendants $root
    }
    if ($candidates.Count -gt 0) {
        return @{ root = $root; candidates = $candidates; embeddedPid = $null }
    }

    $fgPid = 0
    [void][NativeInput]::GetWindowThreadProcessId($Hwnd, [ref]$fgPid)

    $parentOf = @{}
    try {
        foreach ($proc in (Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
            $parentOf[[int]$proc.ProcessId] = [int]$proc.ParentProcessId
        }
    } catch { }
    $isDescendant = {
        param($CandidatePid)
        if ($CandidatePid -eq $fgPid) { return $true }
        $cur = $CandidatePid
        for ($hops = 0; $hops -lt 8; $hops++) {
            if (-not $parentOf.ContainsKey($cur)) { return $false }
            $cur = $parentOf[$cur]
            if ($cur -eq 0) { return $false }
            if ($cur -eq $fgPid) { return $true }
        }
        return $false
    }

    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $siblings = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($s in $siblings) {
        try {
            if ($s.Current.IsOffscreen) { continue }
            $spid = [int]$s.Current.ProcessId
            if ($spid -eq $fgPid) { continue }              # already searched above
            if (-not (& $isDescendant $spid)) { continue }
            $found = Find-EditableDescendants $s
            if ($found.Count -gt 0) {
                return @{ root = $s; candidates = $found; embeddedPid = $spid }
            }
        } catch { }
    }
    return $null
}

# WAVE 9 (BUG-059) — put the caret in a real edit control before injecting.
#
# 2026-07-31 20:03: focus_window reported focused:true, ui_type's foreground
# pre-check passed, typedIntoTitle read "Untitled - Notepad", SendInput injected 7
# events — and the document stayed empty, with the read-back finding a focused
# element exposing NEITHER ValuePattern NOR TextPattern. That combination only
# happens when the focused element is the window frame, not its editor: a
# SYNTHETIC foreground grant (AttachThreadInput / lock-timeout / minimize-restore)
# activates a window without giving any child keyboard focus, so the keystrokes
# had no editable target at all.
#
# So the read-back's $null was never only a verification gap — it was the symptom
# of the typing failure itself. Finding an editable descendant and focusing it
# fixes both halves: the keystrokes get a target, and the oracle gets a patterned
# element to read.
function Focus-EditableDescendant($Hwnd) {
    try {
        if ($Hwnd -eq [IntPtr]::Zero) { return @{ focused = $false; reason = 'no foreground window' } }
        # Resolve-EditableSurface, not FromHandle alone: a WebView2 app (WhatsApp,
        # Teams) keeps its text boxes in a child process's separate desktop window,
        # so searching only the foreground window's own tree finds nothing and the
        # caret is never placed — measured against WhatsApp on 2026-07-31.
        $surface = Resolve-EditableSurface $Hwnd
        if (-not $surface) {
            return @{ focused = $false; reason = 'neither the foreground window nor any surface it embeds contains an editable, keyboard-focusable element' }
        }
        $candidates = $surface.candidates

        # A text editor's document is the biggest editable surface in its window;
        # Edit/Document control types outrank anything else that merely exposes a
        # text pattern (toolbars, read-only panes).
        $pick = $candidates | Sort-Object -Property @{ Expression = 'isTextEntry'; Descending = $true },
                                                    @{ Expression = 'area'; Descending = $true } |
                Select-Object -First 1

        $method = $null
        try { $pick.element.SetFocus(); $method = 'uia-setfocus'; Start-Sleep -Milliseconds 120 } catch { }

        $read = Read-FocusedElementText
        if ($null -eq $read) {
            # SetFocus is advisory — some controls ignore it. A click on the
            # element's centre is what a human would do.
            try {
                Click-AtScreenCoords $pick.cx $pick.cy
                $method = 'click-center'
                Start-Sleep -Milliseconds 180
                $read = Read-FocusedElementText
            } catch { }
        }

        if ($null -eq $read) {
            return @{
                focused = $false
                reason = ('found ' + $candidates.Count + ' editable element(s) in the foreground window but could not put the caret in one (tried UIA SetFocus and a click)')
                candidateCount = $candidates.Count
            }
        }

        return @{
            focused = $true
            method = $method
            via = $pick.via
            controlType = $pick.controlType
            name = $pick.name
            candidateCount = $candidates.Count
        }
    } catch {
        return @{ focused = $false; reason = ('could not search the foreground window for an edit control: ' + $_.Exception.Message) }
    }
}

# The caret's owner, as UIA sees it. This is where a keystroke actually goes, and it
# is NOT the same thing as the foreground window: on 2026-08-02 WhatsApp (pid 2132)
# held the foreground while Brave (pid 7972) held the caret, so SendInput typed into
# Brave's address bar while every foreground-based guard passed. Defined next to its
# two callers (Handle-UiType, Handle-SendKey) rather than beside the other pid helpers
# so the guard and the thing it measures stay readable together.
#
# Returns 0 when UIA cannot answer. 0 means UNKNOWN, never "no owner" — callers must
# not treat it as a mismatch.
function Get-CaretOwnerPid() {
    try {
        $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($fe) { return [int]$fe.Current.ProcessId }
    } catch { }
    return 0
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
            # Same-APP, not same-pid (BUG-070). A WebView2 app's renderer child owns
            # the foreground window once one of its text boxes has focus, so strict
            # equality aborted a legitimate type into WhatsApp. Typing into a
            # DIFFERENT application is still refused, which is the property that matters.
            if (-not (Test-SameApp $fgPid $TargetPid)) {
                return ('Type aborted: foreground window belongs to PID ' + $fgPid +
                    ', which is not part of target PID ' + $TargetPid + "'s application.")
            }

            # CARET-OWNER GUARD (2026-08-02). The check above is necessary and was never
            # sufficient. Measured live: WhatsApp (pid 2132) held the FOREGROUND and
            # passed this guard, while Brave (pid 7972) held the CARET — so SendInput,
            # which follows the caret and not the window, typed "mom" into Brave's
            # address bar, and the read-back then read Brave's address bar and called it
            # confirmed. Foreground is where the window is; the caret is where the
            # keystrokes go. Both have to belong to the target.
            #
            # A caret owner of 0 means UIA could not tell us — an honest unknown, and the
            # Focus-EditableDescendant path below exists precisely to fix "nothing is
            # focused", so that case must NOT abort here.
            $caretPid = Get-CaretOwnerPid
            if ($caretPid -and -not (Test-SameApp $caretPid $TargetPid)) {
                $caretLabel = ''
                try { $caretLabel = ' (' + (Get-Process -Id $caretPid -ErrorAction Stop).ProcessName + ')' } catch { }
                return ('Type aborted: the keyboard caret belongs to PID ' + $caretPid + $caretLabel +
                    ', which is not part of target PID ' + $TargetPid + "'s application. The " +
                    'foreground window is the target but the caret is not, so the keystrokes would ' +
                    'have gone into the wrong app. Nothing was typed.')
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

        # WAVE 2 — snapshot the target's text BEFORE injecting. Comparing only the
        # AFTER state is not enough: Notepad hands back the whole document, so text
        # left over from an earlier run would read as a successful type. Requiring
        # the content to have CHANGED as well is what makes this a real oracle.
        $beforeRead = Read-FocusedElementText

        # WAVE 9 (BUG-059) — no editable control has the caret. Foreground is not
        # focus: a synthetic activation puts the window in front without focusing
        # anything inside it, and SendInput then injects into nothing. Place the
        # caret first, then read the BEFORE state again from the element we chose.
        $caretPlacement = $null
        if ($null -eq $beforeRead) {
            $curFg = [NativeInput]::GetForegroundWindow()
            $caretPlacement = Focus-EditableDescendant $curFg
            if ($caretPlacement.focused) {
                $beforeRead = Read-FocusedElementText
            }
        }

        # WAVE 9 (BUG-061) — TRY, VERIFY, ESCALATE. The real root cause of BUG-051.
        #
        # Measured 2026-07-31 against Win11 Notepad, with diagnose_type fixed so its
        # inter-route clear no longer rides the mechanism under test:
        #
        #   uia-valuepattern-setvalue     LANDED
        #   uia-setfocus-then-sendinput   did NOT land  (48 events "injected")
        #   sendinput-unicode             did NOT land  (48 events "injected")
        #   wm-char-post                  LANDED
        #
        # SendInput is documented to fail silently when blocked by UIPI: "neither
        # GetLastError nor the return value will indicate the failure". Win11's
        # packaged Notepad is such a target, so the production path reported a full
        # injection into a document that never received a character. No amount of
        # focus or window work fixes that — the MECHANISM is blocked.
        #
        # SendInput stays FIRST: it is the only route that honours the caret's
        # position, and the only one proven against Chromium/Electron (BUG-053's
        # stray Enter reached a real Slack DM). The Wave 2 read-back then decides
        # whether to escalate, which turns verification into recovery instead of
        # just reporting.
        $mechanism = 'sendinput-unicode'
        $mechanismsTried = @('sendinput-unicode')
        $script:LastVkSent = $null
        Send-UnicodeText $text
        # BUG-042-class honest failure: SendInput injected zero events (UIPI /
        # a higher-integrity foreground app blocked it) — report failure instead
        # of the silent typed:$true that shipped before this fix.
        if ($null -ne $script:LastVkSent -and $script:LastVkSent -lt 1) {
            return "Type failed: SendInput injected 0 events (input may be blocked by a higher-integrity foreground app)."
        }

        # Escalate ONLY on proof that nothing landed: the oracle answered, the text
        # is absent, AND the content is byte-identical to the before-state. An
        # unreadable or partially-changed control is ambiguous, and retrying there
        # would type the text twice — a duplicated message is worse than an honest
        # "I could not confirm this".
        Start-Sleep -Milliseconds 120
        $probe = Read-FocusedElementText
        $provablyAbsent = ($null -ne $probe) -and ($null -ne $beforeRead) -and
                          (-not (Test-TextLanded $probe.text $text)) -and
                          ([string]$probe.text -eq [string]$beforeRead.text)

        if ($provablyAbsent) {
            # Route 2 — UIA ValuePattern.SetValue, which does not travel through the
            # input stack at all, so UIPI cannot block it. SetValue REPLACES the
            # whole value, so the existing content is re-supplied explicitly and the
            # new text appended; passing $text alone would silently wipe the
            # operator's document. Caret position is lost (append-at-end), which is
            # why this is the fallback and not the default.
            $mechanismsTried += 'uia-setvalue'
            try {
                $el = [System.Windows.Automation.AutomationElement]::FocusedElement
                $vp = $null
                if ($el) { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) -as [System.Windows.Automation.ValuePattern] }
                if ($vp -and -not $vp.Current.IsReadOnly) {
                    $vp.SetValue(([string]$beforeRead.text) + $text)
                    Start-Sleep -Milliseconds 120
                    $probe = Read-FocusedElementText
                    if ($null -ne $probe -and (Test-TextLanded $probe.text $text)) { $mechanism = 'uia-setvalue' }
                }
            } catch { }

            if ($mechanism -eq 'sendinput-unicode') {
                # Route 3 — WM_CHAR posted straight to the focused child control.
                # GetFocus is thread-local, so our input queue must be attached to
                # the foreground thread's first, or it reports our own (windowless)
                # focus and the characters go nowhere.
                $mechanismsTried += 'wm-char-post'
                try {
                    $fgH2 = [NativeInput]::GetForegroundWindow()
                    $fgP2 = 0
                    $fgThread = [NativeInput]::GetWindowThreadProcessId($fgH2, [ref]$fgP2)
                    $ourThread = [NativeInput]::GetCurrentThreadId()
                    $attached2 = [NativeInput]::AttachThreadInput($ourThread, $fgThread, $true)
                    $target = [IntPtr]::Zero
                    try { if ($attached2) { $target = [NativeInput]::GetFocus() } }
                    finally { if ($attached2) { [void][NativeInput]::AttachThreadInput($ourThread, $fgThread, $false) } }
                    if ($target -eq [IntPtr]::Zero) { $target = $fgH2 }
                    foreach ($ch in $text.ToCharArray()) {
                        [void][NativeInput]::PostMessage($target, [NativeInput]::WM_CHAR, [IntPtr][int][char]$ch, [IntPtr]0)
                        Start-Sleep -Milliseconds 3
                    }
                    Start-Sleep -Milliseconds 150
                    $probe = Read-FocusedElementText
                    if ($null -ne $probe -and (Test-TextLanded $probe.text $text)) { $mechanism = 'wm-char-post' }
                } catch { }
            }
        }

        $result = @{ typed = $true; length = $text.Length; typedIntoPid = [int]$typedIntoPid; typedIntoTitle = $typedIntoTitle }
        $result.mechanism = $mechanism
        # 2026-08-10 (BUG-066, second half). caretSameApp below fixed the CARET
        # comparison for WebView2 apps; the FOREGROUND comparison in from-pc.js was
        # left doing strict pid equality and fails the same way. Measured live in
        # vault/Audit/2026-08-09.jsonl: two whatsapp_send attempts refused with
        # 'the text went to "Chrome Legacy Window" (pid 15956), not the target
        # (pid 15928)' — 15956 is WhatsApp.Root's own msedgewebview2 child, i.e.
        # the same application, and the message really was typed in the right
        # place. Same rule as caretSameApp: Test-SameApp is the only thing that
        # knows a shell and its renderer child are one app, so that knowledge
        # stays here and JS reads the verdict. Reported, not enforced.
        if ($TargetPid -and $typedIntoPid) {
            $result.typedIntoSameApp = [bool](Test-SameApp $typedIntoPid $TargetPid)
        }
        if ($mechanismsTried.Count -gt 1) { $result.mechanismsTried = $mechanismsTried }

        # Whether the caret had to be placed, and how. This is the diagnostic that
        # was missing on 2026-07-31: "unavailable" alone could not distinguish
        # "this surface has no readable pattern" from "nothing was focused at all".
        if ($null -ne $caretPlacement) {
            $result.caretPlaced = [bool]$caretPlacement.focused
            if ($caretPlacement.focused) {
                $result.caretPlacedVia = [string]$caretPlacement.method
                $result.caretControlType = [string]$caretPlacement.controlType
            } else {
                $result.caretPlacementReason = [string]$caretPlacement.reason
            }
        }

        # WAVE 9 (BUG-066) — which process actually owns the caret.
        #
        # typedIntoPid is the FOREGROUND window's pid, and for a WebView2 app that is
        # the shell (WhatsApp.Root), while the caret sits in its renderer child
        # (msedgewebview2). Enter goes to the caret, not to the shell, so a guard
        # comparing Enter's target against typedIntoPid refuses a legitimate send —
        # measured against WhatsApp on 2026-07-31. Report the caret's real owner so
        # the Enter guard can tell "a child of the same app" from "a different app".
        try {
            $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
            if ($fe) {
                $result.focusedPid = [int]$fe.Current.ProcessId
                # 2026-08-02: focusedPid alone could not be turned into a sentence. The
                # cross-check in from-pc.js has to tell the operator WHICH app the
                # keystrokes went to ("they went to Brave, not WhatsApp"), and a bare
                # number cannot do that. Best-effort — a name lookup must never break a
                # type that otherwise worked.
                try { $result.focusedProcess = [string](Get-Process -Id $result.focusedPid -ErrorAction Stop).ProcessName } catch { }
                # Whether the caret STILL belongs to the target, evaluated here — after
                # injection and immediately before the read-back. The pre-injection guard
                # cannot cover this moment: the caret can drift mid-type, and
                # Focus-EditableDescendant can legitimately move it. This is the flag
                # from-pc.js needs in order to know whether the read-back it is about to
                # receive describes the target's control or some other app's.
                #
                # Reported, not enforced, and only when a target was named. Test-SameApp
                # is the one place that knows a WebView2 shell and its renderer child are
                # the same application, so that knowledge is not duplicated in JS.
                if ($TargetPid) {
                    $result.caretSameApp = [bool](Test-SameApp $result.focusedPid $TargetPid)
                }
            }
        } catch { }

        # Read back. A brief settle first: SendInput is asynchronous, so the control
        # has usually not processed the last character when SendInput returns.
        Start-Sleep -Milliseconds 120
        $afterRead = Read-FocusedElementText

        if ($null -eq $afterRead) {
            # No readable pattern. Genuinely unknown — not a failure.
            $result.readBack = 'unavailable'
            if ($null -ne $caretPlacement -and -not $caretPlacement.focused) {
                # The stronger statement, and the one that was true tonight: nothing
                # editable held the caret, so the keystrokes most likely went nowhere.
                $result.readBackReason = 'nothing editable had the keyboard caret and one could not be focused (' +
                    [string]$caretPlacement.reason + '), so the keystrokes probably went nowhere'
            } else {
                $result.readBackReason = 'the focused control exposes neither ValuePattern nor TextPattern, so its text cannot be read back'
            }
        } elseif (Test-TextLanded $afterRead.text $text) {
            $changed = ($null -eq $beforeRead) -or ($beforeRead.text -ne $afterRead.text)
            if ($changed) {
                $result.readBack = 'confirmed'
                $result.readBackVia = $afterRead.via
                # Bounded: a whole document could be megabytes, and this value is
                # spoken aloud and written to episodic memory.
                $t = [string]$afterRead.text
                if ($t.Length -gt 400) { $t = $t.Substring($t.Length - 400) }
                $result.readBackText = $t
            } else {
                # The text is present but nothing changed: it was already there, so
                # this injection cannot be shown to have done anything.
                $result.readBack = 'unchanged'
                $result.readBackVia = $afterRead.via
                $result.readBackReason = 'the control already contained this text and its contents did not change, so the keystrokes cannot be confirmed to have landed'
            }
        } else {
            # The oracle spoke and contradicted us. This is the empty-Notepad case.
            $result.readBack = 'mismatch'
            $result.readBackVia = $afterRead.via
            $a = [string]$afterRead.text
            if ($a.Length -gt 400) { $a = $a.Substring(0, 400) }
            $result.readBackText = $a
            $result.readBackReason = 'the control does not contain the text after injection'
        }

        return $result
    } catch {
        return ('Type failed: ' + $_.Exception.Message)
    }
}

# WAVE 7 — find and focus a real message box inside a window, then PROVE the
# caret is in it.
#
# app_reply needs to type into the compose box of whatever chat app is already
# open. Guessing a coordinate is how you type into a search field, a channel name,
# or someone's message history. So the box is located through UIA: an element that
# is genuinely editable (ValuePattern that is not read-only, or TextPattern) AND
# keyboard-focusable, preferring the one lowest on screen — in every chat client
# the compose box sits at the bottom, while search sits at the top.
#
# SetFocus first (reliable, no pointer involved), falling back to a click at the
# element's centre for surfaces that ignore programmatic focus — the same
# escalation philosophy as Handle-UiClick. Either way it then re-reads
# FocusedElement and confirms the thing now holding the caret is editable. No
# editable element, or focus that will not take, is an honest stop: "I can see the
# app, I cannot find its message box" beats typing into the wrong field.
# WAVE 9 (BUG-068): $Role selects WHICH box. Measured 2026-08-01 — typing into a
# chat app's search field cannot go through ui_type alone, because ui_type places the
# caret in the LARGEST text entry when nothing readable holds it, and a composer
# (612x34 in WhatsApp) always beats a search field (367x31). A search term therefore
# landed in the operator's message composer. The box has to be chosen deliberately.
#
#   'compose' (default) — lowest on screen, unchanged behaviour for app_reply.
#   'search'            — an editable element whose Name says search, else the
#                         HIGHEST on screen. Both chat clients tested put search at
#                         the top; the name match is preferred because position is a
#                         weaker signal than the app's own label.
function Handle-FocusMessageBox($TargetPid, $Role) {
    if (-not $TargetPid) { return 'PID is required.' }
    try {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$TargetPid)
        $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if (-not $win) { return ('No window found for PID ' + $TargetPid + '.') }

        # A WebView2 app (WhatsApp, Teams) keeps its text boxes in a child process's
        # own desktop window, so searching this window's tree alone finds nothing.
        $candidates = Find-EditableDescendants $win
        if ($candidates.Count -eq 0) {
            # Try the pid's own main window first, then whatever is actually in front
            # — once a WebView2 app's box has been focused its RENDERER owns the
            # foreground window, and that is the tree holding the text boxes.
            $proc = $null
            try { $proc = Get-Process -Id $TargetPid -ErrorAction Stop } catch { }
            if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
                $surface = Resolve-EditableSurface $proc.MainWindowHandle
                if ($surface) { $candidates = $surface.candidates }
            }
            if ($candidates.Count -eq 0) {
                $fgH = [NativeInput]::GetForegroundWindow()
                $fgP = 0
                [void][NativeInput]::GetWindowThreadProcessId($fgH, [ref]$fgP)
                if (Test-SameApp $fgP $TargetPid) {
                    $surface2 = Resolve-EditableSurface $fgH
                    if ($surface2) { $candidates = $surface2.candidates }
                }
            }
        }

        if ($candidates.Count -eq 0) {
            return ('Found the window for PID ' + $TargetPid + ' but no editable, keyboard-focusable element in it — cannot locate a message box.')
        }

        $wantSearch = ([string]$Role -eq 'search')
        if ($wantSearch) {
            $named = @($candidates | Where-Object { [string]$_.name -match 'search' })
            if ($named.Count -gt 0) {
                $pick = $named | Sort-Object -Property bottom | Select-Object -First 1
            } else {
                # Highest on screen — search sits above the conversation.
                $pick = $candidates | Sort-Object -Property bottom | Select-Object -First 1
            }
        } else {
            # Lowest on screen: the compose box, not the search field.
            $pick = $candidates | Sort-Object -Property bottom -Descending | Select-Object -First 1
        }

        $method = $null
        try { $pick.element.SetFocus(); $method = 'uia-setfocus'; Start-Sleep -Milliseconds 120 } catch { }

        $focused = Read-FocusedElementText
        if ($null -eq $focused) {
            # SetFocus did not take (or the focused element is unreadable) — click it.
            try {
                Click-AtScreenCoords $pick.cx $pick.cy
                $method = 'click-center'
                Start-Sleep -Milliseconds 180
                $focused = Read-FocusedElementText
            } catch { }
        }

        if ($null -eq $focused) {
            return ('Located a message box in PID ' + $TargetPid + ' but could not put the caret in it (tried UIA SetFocus and a click), so typing there cannot be trusted.')
        }

        return @{
            focused = $true
            method = $method
            via = $pick.via
            name = $pick.name
            x = $pick.cx
            y = $pick.cy
            candidateCount = $candidates.Count
            # What is already sitting in the box. app_reply reports this so a draft
            # someone else was writing is never silently appended to.
            existingText = [string]$focused.text
        }
    } catch {
        return ('Could not find a message box: ' + $_.Exception.Message)
    }
}

# WAVE 9 (BUG-064) — WHO is this message addressed to?
#
# whatsapp_send verified the WINDOW it typed into and never the RECIPIENT. The
# window title is "(194) WhatsApp" whether the open conversation is your mother or
# your employer, so if the deep link failed to switch conversations the message
# would be typed into whichever chat happened to be open and Enter pressed on it.
# That is BUG-052's mistake (right pid, wrong target) pointed at a human instead of
# a text editor, and it is not a recoverable error.
#
# Measured against WhatsApp Desktop 2026-07-31: its compose box is
# ControlType.Edit with Name "Type a message to <recipient>" and a WRITABLE
# ValuePattern. The Name is the oracle — the app itself telling us who it will send
# to. A second, independent one exists as the conversation-header Button
# ("<recipient> ... Message yourself"), returned as headerName.
#
# The compose box is the LOWEST writable Edit in the window (y~898 versus the
# search box's y~254), which is Wave 7's message-box heuristic reused.
function Handle-ReadComposeBox($TargetPid) {
    try {
        $hwnd = [NativeInput]::GetForegroundWindow()
        if ($TargetPid) {
            $fgP = 0
            [void][NativeInput]::GetWindowThreadProcessId($hwnd, [ref]$fgP)
            # Same-APP, not same-pid — see Test-SameApp (BUG-070).
            if (-not (Test-SameApp $fgP $TargetPid)) {
                return ('The foreground window belongs to PID ' + $fgP + ', which is not part of PID ' + $TargetPid + "'s application.")
            }
        }
        # The text boxes are not always in the foreground window’s own tree: a
        # WebView2 app (WhatsApp, Teams) keeps them in a child process registered
        # as a separate desktop window. Resolve-EditableSurface handles that, by
        # process parentage rather than geometry — see its header for why geometry
        # offered up an overlapping Notepad as the message box.
        $surface = Resolve-EditableSurface $hwnd
        if (-not $surface) {
            return 'No editable element found in the foreground window (or any surface embedded in it), so its message box cannot be identified.'
        }
        $candidates = $surface.candidates
        $root = $surface.root
        $readFromPid = $surface.embeddedPid

        $pick = $candidates | Sort-Object -Property bottom -Descending | Select-Object -First 1

        # The conversation header: an independent second opinion on who is open.
        $headerName = $null
        try {
            $btns = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                (New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::Button)))
            $best = $null
            foreach ($b in $btns) {
                try {
                    $rb = $b.Current.BoundingRectangle
                    # Header row: above the message area, right of the chat list.
                    if ($rb.Y -gt 260 -or $rb.Y -lt 60) { continue }
                    if ($rb.Width -lt 200) { continue }
                    if ($null -eq $best -or $rb.Width -gt $best.Current.BoundingRectangle.Width) { $best = $b }
                } catch { }
            }
            if ($best) { $headerName = [string]$best.Current.Name }
        } catch { }

        return @{
            name = [string]$pick.name
            controlType = [string]$pick.controlType
            currentText = [string](& {
                try {
                    $vp = $pick.element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) -as [System.Windows.Automation.ValuePattern]
                    if ($vp) { return [string]$vp.Current.Value }
                } catch { }
                return ''
            })
            headerName = $headerName
            candidateCount = $candidates.Count
            # Non-null when the compose box was found in a surface EMBEDDED in the
            # foreground window rather than in the window's own tree.
            readFromPid = $readFromPid
        }
    } catch {
        return ('Could not read the message box: ' + $_.Exception.Message)
    }
}

# WAVE 9 (BUG-069) — empty a text box, provably.
#
# Needed because ctrl+a and Delete both ride SendInput, which MSIX/WebView2 apps
# silently discard (BUG-061), and UIA SetValue('') is ignored by React-controlled
# inputs like WhatsApp's composer. WM_CHAR is the one mechanism measured to reach
# them, so this deletes character by character with WM_CHAR backspace and then reads
# the box to confirm it is actually empty.
#
# Used to clear a stale draft before typing, and to put a box back as it was found
# after a probe. Returns honestly if the box will not empty rather than assuming it did.
function Handle-ClearFocusedBox($TargetPid, $Count) {
    try {
        $hwnd = [NativeInput]::GetForegroundWindow()
        if ($TargetPid) {
            $fgP = 0
            [void][NativeInput]::GetWindowThreadProcessId($hwnd, [ref]$fgP)
            # Same-APP, not same-pid: focusing a WebView2 app's text box makes its
            # renderer child the foreground window (BUG-070).
            if (-not (Test-SameApp $fgP $TargetPid)) {
                return ('The foreground window belongs to PID ' + $fgP + ', which is not part of PID ' + $TargetPid + "'s application.")
            }
        }

        $before = Read-FocusedElementText
        if ($null -eq $before) { return 'Nothing readable holds the caret, so there is no box to clear.' }

        $beforeText = [string]$before.text
        if (-not $beforeText.Trim()) {
            return @{ cleared = $true; wasEmpty = $true; removed = 0 }
        }

        # A generous bound: the caret may sit mid-text, so delete forwards as well.
        # Explicit count wins when the caller knows the length.
        $n = 0
        if ($Count) { $n = [int]$Count } else { $n = $beforeText.Length + 4 }
        if ($n -gt 4000) { $n = 4000 }

        $fgP2 = 0
        $fgThread = [NativeInput]::GetWindowThreadProcessId($hwnd, [ref]$fgP2)
        $ourThread = [NativeInput]::GetCurrentThreadId()
        $attached = [NativeInput]::AttachThreadInput($ourThread, $fgThread, $true)
        $target = [IntPtr]::Zero
        try { if ($attached) { $target = [NativeInput]::GetFocus() } }
        finally { if ($attached) { [void][NativeInput]::AttachThreadInput($ourThread, $fgThread, $false) } }
        if ($target -eq [IntPtr]::Zero) { $target = $hwnd }

        # WM_KEYDOWN/WM_KEYUP first: React editors handle Backspace and Delete as KEY
        # events, and WM_CHAR 0x08 is silently ignored by them (measured against
        # WhatsApp — the text was completely untouched). WM_CHAR is kept as a fallback
        # for plain Win32 edit controls, which do honour it.
        $via = $null
        for ($i = 0; $i -lt $n; $i++) {
            [void][NativeInput]::PostMessage($target, [NativeInput]::WM_KEYDOWN, [IntPtr][NativeInput]::VK_BACK, [IntPtr]0)
            [void][NativeInput]::PostMessage($target, [NativeInput]::WM_KEYUP, [IntPtr][NativeInput]::VK_BACK, [IntPtr]0)
            Start-Sleep -Milliseconds 2
        }
        for ($i = 0; $i -lt 8; $i++) {
            [void][NativeInput]::PostMessage($target, [NativeInput]::WM_KEYDOWN, [IntPtr][NativeInput]::VK_DELETE, [IntPtr]0)
            [void][NativeInput]::PostMessage($target, [NativeInput]::WM_KEYUP, [IntPtr][NativeInput]::VK_DELETE, [IntPtr]0)
            Start-Sleep -Milliseconds 2
        }
        Start-Sleep -Milliseconds 300
        $after = Read-FocusedElementText
        if ($null -ne $after -and -not ([string]$after.text).Trim()) { $via = 'wm-keydown-backspace' }

        if (-not $via) {
            for ($i = 0; $i -lt $n; $i++) {
                [void][NativeInput]::PostMessage($target, [NativeInput]::WM_CHAR, [IntPtr]8, [IntPtr]0)
                Start-Sleep -Milliseconds 2
            }
            Start-Sleep -Milliseconds 250
            $after = Read-FocusedElementText
            if ($null -ne $after -and -not ([string]$after.text).Trim()) { $via = 'wm-char-backspace' }
        }

        $afterText = if ($null -eq $after) { $null } else { [string]$after.text }
        if ($null -eq $afterText) {
            return 'The box cannot be read after clearing, so it cannot be confirmed empty.'
        }
        if (-not $via) {
            $left = $afterText
            if ($left.Length -gt 120) { $left = $left.Substring(0, 120) }
            return ('Tried ' + $n + ' backspaces as key events and as characters, and the box still contains "' +
                $left.Trim() + '", so it was NOT cleared.')
        }
        return @{ cleared = $true; wasEmpty = $false; removed = $beforeText.Length; via = $via }
    } catch {
        return ('Could not clear the box: ' + $_.Exception.Message)
    }
}

# WAVE 9 (BUG-067) — a send that can be PROVEN, because Enter cannot.
#
# 2026-08-01: whatsapp_send reported sent:true and the message was still sitting in
# the composer. Enter rides SendInput, which this MSIX app silently discards
# (BUG-061), so `send_key enter` was "accepted" and nothing was submitted — the
# exact shape of lie this whole plan exists to remove, one layer further out.
#
# from-pc.js's keyPressed() already predicted both the problem and the fix in a
# comment: "read the compose box back and treat 'it is now empty' as evidence the
# message went. That is a real oracle." That is what this does.
#
# Mechanisms, in order of provability, each verified by the same oracle:
#   1. Invoke the app's own Send button through UIA (measured present in WhatsApp as
#      Button name='Send', invokable) — no input stack involved at all.
#   2. WM_CHAR carriage return to the focused control (WM_CHAR is the mechanism that
#      succeeded for TYPING into this app, so it is the best keystroke bet).
#   3. SendInput Enter — the old path, kept last because it is the one measured to
#      fail here.
#
# The oracle is the composer emptying. A composer that was empty to begin with is
# reported as "nothing to send" rather than as a success.
function Handle-SubmitMessage($TargetPid) {
    try {
        $hwnd = [NativeInput]::GetForegroundWindow()
        if ($TargetPid) {
            $fgP = 0
            [void][NativeInput]::GetWindowThreadProcessId($hwnd, [ref]$fgP)
            # Same-APP, not same-pid (BUG-070). Submitting in a DIFFERENT application
            # is still refused — that is the property protecting the operator here.
            if (-not (Test-SameApp $fgP $TargetPid)) {
                return ('Refusing to submit: the foreground window belongs to PID ' + $fgP +
                    ', which is not part of PID ' + $TargetPid + "'s application.")
            }
        }

        $surface = Resolve-EditableSurface $hwnd
        if (-not $surface) { return 'No message box found in the foreground window, so there is nothing to submit.' }

        $box = $surface.candidates | Sort-Object -Property bottom -Descending | Select-Object -First 1
        $readBox = {
            try {
                $vp = $box.element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) -as [System.Windows.Automation.ValuePattern]
                if ($vp) { return [string]$vp.Current.Value }
            } catch { }
            try {
                $tp = $box.element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) -as [System.Windows.Automation.TextPattern]
                if ($tp) { return [string]$tp.DocumentRange.GetText(-1) }
            } catch { }
            return $null
        }

        $before = & $readBox
        if ($null -eq $before) {
            return 'The message box cannot be read, so a send could not be verified either way. Nothing was submitted.'
        }
        if (-not ([string]$before).Trim()) {
            return 'The message box is empty — there is nothing to send.'
        }

        $tried = @()
        $mechanism = $null

        # 1. The app's own Send button.
        $tried += 'uia-invoke-send'
        try {
            $btns = $surface.root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                (New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::Button)))
            foreach ($b in $btns) {
                try {
                    if ([string]$b.Current.Name -notmatch '^\s*send\s*$') { continue }
                    $ip = $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) -as [System.Windows.Automation.InvokePattern]
                    if ($ip) { $ip.Invoke(); Start-Sleep -Milliseconds 600; break }
                } catch { }
            }
        } catch { }
        $after = & $readBox
        if ($null -ne $after -and -not ([string]$after).Trim()) { $mechanism = 'uia-invoke-send' }

        # 2. WM_CHAR carriage return — the mechanism that works for typing here.
        if (-not $mechanism) {
            $tried += 'wm-char-return'
            try {
                $fgP2 = 0
                $fgThread = [NativeInput]::GetWindowThreadProcessId($hwnd, [ref]$fgP2)
                $ourThread = [NativeInput]::GetCurrentThreadId()
                $attached = [NativeInput]::AttachThreadInput($ourThread, $fgThread, $true)
                $target = [IntPtr]::Zero
                try { if ($attached) { $target = [NativeInput]::GetFocus() } }
                finally { if ($attached) { [void][NativeInput]::AttachThreadInput($ourThread, $fgThread, $false) } }
                if ($target -eq [IntPtr]::Zero) { $target = $hwnd }
                [void][NativeInput]::PostMessage($target, [NativeInput]::WM_CHAR, [IntPtr]13, [IntPtr]0)
                Start-Sleep -Milliseconds 600
            } catch { }
            $after = & $readBox
            if ($null -ne $after -and -not ([string]$after).Trim()) { $mechanism = 'wm-char-return' }
        }

        # 3. SendInput Enter, last because it is measured to fail for this app class.
        if (-not $mechanism) {
            $tried += 'sendinput-enter'
            try { Send-VkKey 0x0D; Start-Sleep -Milliseconds 600 } catch { }
            $after = & $readBox
            if ($null -ne $after -and -not ([string]$after).Trim()) { $mechanism = 'sendinput-enter' }
        }

        if (-not $mechanism) {
            $stillThere = [string]$after
            if ($stillThere.Length -gt 200) { $stillThere = $stillThere.Substring(0, 200) }
            return ('Tried ' + ($tried -join ', ') + ' and the message is STILL in the box ("' +
                $stillThere.Trim() + '"), so it was NOT sent.')
        }

        $sentText = [string]$before
        if ($sentText.Length -gt 400) { $sentText = $sentText.Substring(0, 400) }
        return @{
            submitted = $true
            mechanism = $mechanism
            mechanismsTried = $tried
            # The oracle, stated: this text was in the box and the box is now empty.
            clearedText = $sentText.Trim()
        }
    } catch {
        return ('Could not submit the message: ' + $_.Exception.Message)
    }
}

# WAVE 9 (BUG-062) — "open notepad" must mean a BLANK document, every time.
#
# Win11 Notepad is a single-instance, TAB-BASED app with session restore. On
# 2026-07-31 the operator asked for a fresh Notepad and got their own .env file
# reopened in a restored tab; the launch had reported freshDocument:true because
# it fired ctrl+n and only checked that send_key returned ok. Measured tonight:
# ctrl+n does NOT open a tab, because it rides SendInput, which this app silently
# discards (see BUG-061). The claim was unfalsifiable and false.
#
# So the new tab is opened the way UIA can prove: invoke the Add-New-Tab button
# (AutomationId 'AddButton', read off the live app rather than guessed — its Name
# is localised, its AutomationId is not) and require the TAB COUNT to rise and the
# active document to be EMPTY. Keystrokes are only a fallback, and they have to
# pass the same check.
function Handle-NewDocument($TargetPid) {
    if (-not $TargetPid) { return 'PID is required.' }
    try {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$TargetPid)
        $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if (-not $win) { return ('No window found for PID ' + $TargetPid + '.') }

        $tabCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::TabItem)
        $countTabs = { @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)).Count }

        # The active document is the one holding the caret; fall back to the first
        # Document element when nothing is focused yet.
        $activeText = {
            $r = Read-FocusedElementText
            if ($null -ne $r) { return [string]$r.text }
            $d = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
                (New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::Document)))
            if (-not $d) { return $null }
            try {
                $tp = $d.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern) -as [System.Windows.Automation.TextPattern]
                if ($tp) { return [string]$tp.DocumentRange.GetText(-1) }
            } catch { }
            return $null
        }

        $tabsBefore = & $countTabs
        $textBefore = & $activeText

        # Already blank: opening another empty tab would just litter the app.
        if ($null -ne $textBefore -and -not $textBefore.Trim()) {
            return @{ fresh = $true; created = $false; via = 'already-blank'; tabs = $tabsBefore }
        }

        $via = $null
        $add = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'AddButton')))
        if ($add) {
            try {
                $ip = $add.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) -as [System.Windows.Automation.InvokePattern]
                if ($ip) { $ip.Invoke(); $via = 'uia-invoke-addbutton'; Start-Sleep -Milliseconds 500 }
            } catch { }
        }

        $tabsAfter = & $countTabs
        $textAfter = & $activeText

        # Fallback: ctrl+n. Held to the SAME oracle — a keystroke that reports
        # "sent" proves nothing about whether a tab appeared.
        if (($tabsAfter -le $tabsBefore) -or ($null -eq $textAfter) -or $textAfter.Trim()) {
            try {
                Send-VkCombo @(0x11) 0x4E    # ctrl+n
                Start-Sleep -Milliseconds 600
                $via = if ($via) { $via + '+ctrl-n' } else { 'ctrl-n' }
            } catch { }
            $tabsAfter = & $countTabs
            $textAfter = & $activeText
        }

        if ($null -eq $textAfter) {
            return ('Asked PID ' + $TargetPid + ' for a new document but its text cannot be read, so a blank document cannot be confirmed.')
        }
        if ($textAfter.Trim()) {
            return ('Asked PID ' + $TargetPid + ' for a new document but the active document still contains text, so it is NOT a fresh one (tried ' + [string]$via + ').')
        }

        return @{
            fresh = $true
            created = $true
            via = $via
            tabsBefore = $tabsBefore
            tabsAfter = $tabsAfter
        }
    } catch {
        return ('Could not open a new document: ' + $_.Exception.Message)
    }
}

# WAVE 2 — which window has the keyboard RIGHT NOW. The foreground-pid oracle.
# Needed because "is Enter about to send a Slack message" cannot be answered from
# anything remembered: focus moves without telling us (the operator alt-tabs, a
# confirm dialog closes), and on 2026-07-31 two Enters went into a real Slack DM
# before any text had verifiably reached it.
function Handle-GetForegroundWindow() {
    try {
        $hwnd = [NativeInput]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return 'No foreground window.' }
        $fgPid = 0
        [void][NativeInput]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
        $sb = New-Object System.Text.StringBuilder 512
        [void][NativeInput]::GetWindowText($hwnd, $sb, 512)
        $procName = $null
        try { $procName = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch { }
        return @{
            pid = [int]$fgPid
            title = $sb.ToString()
            process = $procName
        }
    } catch {
        return ('Could not read the foreground window: ' + $_.Exception.Message)
    }
}

# WAVE 2 STEP A — the mechanism experiment, not a guess.
#
# On 2026-07-31 11:28:09, against a foreground window confirmed as "Untitled -
# Notepad", SendInput reported a full 23-character injection and the screenshot 28
# seconds later showed an empty document. The plausible explanation is a Win11
# Notepad UIPI/injection quirk, but this codebase has had plausible theories be
# wrong at least three times, so the mechanism is MEASURED instead.
#
# Tries each route against the currently focused control and READS THE TEXT BACK
# after each, reporting which ones actually landed. Every attempt is preceded by a
# select-all + delete so the routes cannot contaminate one another, and the whole
# thing is a diagnostic: it types junk into whatever is focused and is never on a
# voice path.
#
# Deliberate deviation from the plan: "UIA TextPattern insertion" is not a
# mechanism. TextPattern is read-only in UI Automation — no insertion API exists.
# Route 2 is instead UIA SetFocus followed by SendInput, which is a genuinely
# different route (it fixes focus through UIA rather than trusting the OS
# foreground) and is the one most likely to explain the Notepad case.
function Handle-DiagnoseType($text, $TargetPid) {
    if (-not $text) { $text = 'MYTHOS diagnostic ' + [DateTime]::UtcNow.ToString('HHmmss') }
    $text = [string]$text

    $fgHwnd = [NativeInput]::GetForegroundWindow()
    $fgPid = 0
    [void][NativeInput]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
    $sb = New-Object System.Text.StringBuilder 512
    [void][NativeInput]::GetWindowText($fgHwnd, $sb, 512)

    $probe = Read-FocusedElementText
    $attempts = @()

    # Clear the field between mechanisms. This MUST NOT use keystrokes: ctrl+a +
    # delete ride SendInput, the very mechanism under test, so when SendInput is
    # blocked the clear silently does nothing and every later route reports
    # landed:$true on the FIRST route's leftover text. Measured 2026-07-31 against
    # Win11 Notepad: routes 2-4 all claimed success over text that UIA SetValue
    # (route 1) had put there. An instrument that rides the mechanism it measures
    # cannot falsify it — the screen_look/Wave 4 mistake in a different costume.
    #
    # UIA SetValue is independent of the input stack, so it clears honestly. It
    # returns whether the field was actually emptied, and each attempt records
    # that, so a route riding a dirty field is visible instead of invisible.
    $clear = {
        try {
            $el = [System.Windows.Automation.AutomationElement]::FocusedElement
            if ($el) {
                $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) -as [System.Windows.Automation.ValuePattern]
                if ($vp -and -not $vp.Current.IsReadOnly) { $vp.SetValue('') }
            }
            Start-Sleep -Milliseconds 80
            $chk = Read-FocusedElementText
            if ($null -eq $chk) { return $null }          # unknown
            return [bool](-not [string]$chk.text)          # $true when genuinely empty
        } catch { return $null }
    }

    $record = {
        param($Name, $Detail, $FieldWasEmpty)
        Start-Sleep -Milliseconds 150
        $after = Read-FocusedElementText
        $landed = $false
        $seen = $null
        if ($after) {
            $landed = Test-TextLanded $after.text $text
            $seen = [string]$after.text
            if ($seen.Length -gt 200) { $seen = $seen.Substring(0, 200) }
        }
        # A "landed" over a field that was never emptied proves nothing: the text
        # may be a previous route's. Downgrade it and say so.
        $trustworthy = ($FieldWasEmpty -eq $true)
        if ($landed -and -not $trustworthy) {
            $landed = $false
            $Detail = [string]$Detail + ' — INCONCLUSIVE: the field could not be cleared first, so matching text may be left over from an earlier route'
        }
        return @{
            mechanism = $Name
            landed = $landed
            readable = [bool]($null -ne $after)
            via = if ($after) { $after.via } else { $null }
            observed = $seen
            fieldClearedFirst = $FieldWasEmpty
            detail = $Detail
        }
    }

    # --- 1: UIA ValuePattern.SetValue — no keystrokes at all -----------------
    $wasEmpty = & $clear
    $d1 = 'not attempted'
    try {
        $el = [System.Windows.Automation.AutomationElement]::FocusedElement
        $vp = $null
        if ($el) { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) -as [System.Windows.Automation.ValuePattern] }
        if ($vp) {
            if ($vp.Current.IsReadOnly) { $d1 = 'ValuePattern present but read-only' }
            else { $vp.SetValue($text); $d1 = 'SetValue called' }
        } else { $d1 = 'no ValuePattern on the focused element' }
    } catch { $d1 = 'threw: ' + $_.Exception.Message }
    $attempts += (& $record 'uia-valuepattern-setvalue' $d1 $wasEmpty)

    # --- 2: UIA SetFocus, then SendInput ------------------------------------
    $wasEmpty = & $clear
    $d2 = 'not attempted'
    try {
        $el2 = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($el2) { $el2.SetFocus(); Start-Sleep -Milliseconds 80; $d2 = 'SetFocus + SendInput' }
        else { $d2 = 'no focused element; SendInput only' }
        $script:LastVkSent = $null
        Send-UnicodeText $text
        $d2 += ' (events=' + [string]$script:LastVkSent + ')'
    } catch { $d2 = 'threw: ' + $_.Exception.Message }
    $attempts += (& $record 'uia-setfocus-then-sendinput' $d2 $wasEmpty)

    # --- 3: SendInput unicode — the current production path ------------------
    $wasEmpty = & $clear
    $d3 = 'not attempted'
    try {
        $script:LastVkSent = $null
        Send-UnicodeText $text
        $d3 = 'events=' + [string]$script:LastVkSent
    } catch { $d3 = 'threw: ' + $_.Exception.Message }
    $attempts += (& $record 'sendinput-unicode' $d3 $wasEmpty)

    # --- 4: WM_CHAR posted to the focused CONTROL ---------------------------
    # GetFocus is thread-local, so the foreground thread's input queue has to be
    # attached to ours first, otherwise it reports our own (windowless) focus.
    $wasEmpty = & $clear
    $d4 = 'not attempted'
    try {
        $fgThread = [NativeInput]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
        $ourThread = [NativeInput]::GetCurrentThreadId()
        $attached = [NativeInput]::AttachThreadInput($ourThread, $fgThread, $true)
        $target = [IntPtr]::Zero
        try {
            if ($attached) { $target = [NativeInput]::GetFocus() }
        } finally {
            if ($attached) { [void][NativeInput]::AttachThreadInput($ourThread, $fgThread, $false) }
        }
        if ($target -eq [IntPtr]::Zero) { $target = $fgHwnd; $d4 = 'no focused child; posted to the top-level window' }
        else { $d4 = 'posted to the focused child control' }
        foreach ($ch in $text.ToCharArray()) {
            [void][NativeInput]::PostMessage($target, [NativeInput]::WM_CHAR, [IntPtr][int][char]$ch, [IntPtr]0)
        }
    } catch { $d4 = 'threw: ' + $_.Exception.Message }
    $attempts += (& $record 'wm-char-post' $d4 $wasEmpty)

    # Leave the field as we found it. $clear now RETURNS a verdict, so discard it
    # explicitly — an unassigned call would emit into this function's output and
    # turn the returned hashtable into an array.
    $null = & $clear

    $worked = @($attempts | Where-Object { $_.landed } | ForEach-Object { $_.mechanism })
    return @{
        text = $text
        foregroundPid = [int]$fgPid
        foregroundTitle = $sb.ToString()
        readableVia = if ($probe) { $probe.via } else { $null }
        readable = [bool]($null -ne $probe)
        attempts = $attempts
        worked = $worked
        # The honest headline: with no readable pattern this run proves nothing
        # about any mechanism, because the oracle itself was unavailable.
        conclusive = [bool]($null -ne $probe)
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
    # BUG-077: function keys — needed to express alt+f4 ("close Spotify"). VK_F1
    # is 0x70 and they're contiguous through VK_F12 (0x7B).
    f1 = 0x70; f2 = 0x71; f3 = 0x72; f4 = 0x73; f5 = 0x74; f6 = 0x75
    f7 = 0x76; f8 = 0x77; f9 = 0x78; f10 = 0x79; f11 = 0x7A; f12 = 0x7B
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

# Keys whose successful press MUST change the focused control's text, and are
# therefore the only ones the read-back oracle can grade. Enter either submits
# (composer empties) or inserts a newline; space/delete/letters edit in place.
#
# Everything else — tab, escape, home, end, the arrows, f1-f12 — moves the caret,
# changes selection, or talks to the app, all WITHOUT touching the text. For those,
# "the text did not change" is the expected outcome of a SUCCESSFUL press, so it is
# not evidence of anything and must never trigger an escalation.
#
# Backspace is deliberately absent: it has no entry in $VK_CODES, and clearing a box
# already has its own verified path (Clear-MessageBox, WM_KEYDOWN/WM_CHAR + read-back).
$KEYS_WITH_TEXT_ORACLE = @('enter', 'space', 'delete')

function Handle-SendKey($key, $TargetPid) {
    if (-not $key) { return 'Key name is required.' }
    $raw = ([string]$key).ToLower().Trim()

    # CARET-OWNER GUARD (2026-08-02). Handle-UiType's guard checks the FOREGROUND
    # window's pid, which is why the Brave incident sailed through it: foreground was
    # the target, the caret was not. A keystroke follows the caret, so the caret is
    # what has to be checked. Same-APP rather than same-pid, for the WebView2 reason
    # documented at Handle-UiType (a shell pid and its renderer child both mean
    # "this app").
    if ($TargetPid) {
        $caretPid = Get-CaretOwnerPid
        if ($caretPid -and -not (Test-SameApp $caretPid $TargetPid)) {
            # RUNG 0 — CARET RE-ACQUISITION (Wave 3, 2026-08-13). Before aborting,
            # try to put the caret back where it belongs, the same way Handle-UiType's
            # WAVE 9 fix does for typing (Focus-EditableDescendant: UIA SetFocus on the
            # target window's largest editable descendant, falling back to a click at
            # its center). Reuses that exact helper rather than a second detector —
            # the caret drifting to another app (a confirm-dialog round trip, a stray
            # click) is the same failure mode typing already recovers from; send_key
            # never got the same recovery and just gave up.
            try {
                $tProc = Get-Process -Id $TargetPid -ErrorAction Stop
                if ($tProc.MainWindowHandle -ne [IntPtr]::Zero) {
                    [void](Focus-EditableDescendant $tProc.MainWindowHandle)
                    Start-Sleep -Milliseconds 100
                    $caretPid = Get-CaretOwnerPid
                }
            } catch { }
        }
        if ($caretPid -and -not (Test-SameApp $caretPid $TargetPid)) {
            $caretLabel = ''
            try { $caretLabel = ' (' + (Get-Process -Id $caretPid -ErrorAction Stop).ProcessName + ')' } catch { }
            return ("Key '$raw' aborted: the keyboard caret belongs to PID $caretPid" + $caretLabel +
                ", which is not part of target PID $TargetPid's application (tried re-focusing an " +
                'editable element in the target window first). The keystroke would have gone to the ' +
                'wrong window, so nothing was sent.')
        }
    }

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
        # Wave 3-fix (live-verified 2026-08-13): the pre-send title is captured
        # ONLY for ctrl+s (gated below), needed to tell a real MSIX blackhole
        # apart from a real save — see the comment at $msixBlackhole below.
        $fgTitleBefore = $null
        if ($raw -eq 'ctrl+s') {
            $fgHwndBefore = [NativeInput]::GetForegroundWindow()
            $sbBefore = New-Object System.Text.StringBuilder 512
            [void][NativeInput]::GetWindowText($fgHwndBefore, $sbBefore, 512)
            $fgTitleBefore = $sbBefore.ToString()
        }
        $script:LastVkSent = $null
        Send-VkCombo $modVks $vk
        $comboSentZero = ($null -ne $script:LastVkSent -and $script:LastVkSent -lt 1)

        # Wave 3 (2026-08-13) — ctrl+s is the ONE explicit exception to "combos get
        # no escalation ladder" (comment below, unchanged for every other combo).
        # A save is common enough, and unambiguous enough (there is exactly one
        # verifiable equivalent action, not N possible base-key mismatches like
        # "ctrl+n"), to be worth the exception. Checked here, gated on the raw
        # string, not generalized to the branch above.
        if ($raw -eq 'ctrl+s') {
            Start-Sleep -Milliseconds 300
            $fgHwnd2 = [NativeInput]::GetForegroundWindow()
            $sb2 = New-Object System.Text.StringBuilder 512
            [void][NativeInput]::GetWindowText($fgHwnd2, $sb2, 512)
            $fgTitle2 = $sb2.ToString()
            # A Save-As dialog appearing is neither success nor failure of the save
            # itself — it's the app asking a question this call cannot answer.
            # Reported as its own distinct outcome; dismissing it is the caller's
            # next verifiable step (e.g. send_key('enter') or send_key('escape')).
            $saveAsOpened = ($fgTitle2 -match 'Save As')

            # LIVE-VERIFIED FIX (2026-08-13): $comboSentZero is driven purely by
            # SendInput()'s OS-level return value — the number of INPUT structs
            # the OS accepted into the input stream. On Win11's MSIX Notepad that
            # is (almost) never zero: the OS always accepts the events, then the
            # MSIX app's message loop silently discards them — the exact
            # blackhole adapters/CLAUDE.md documents ("silently discard SendInput
            # while reporting the injected event as successful"). Verified live:
            # comboSentZero was false, "sent:true" was returned, no Save-As
            # dialog ever opened, and the title never lost its "*" unsaved
            # marker — the save never happened, but the ONLY escalation gate
            # that existed (comboSentZero) never fires for this exact case,
            # making the whole fallback below dead code on the app it names in
            # its own header. A title that still starts with "*" (Notepad's own
            # unsaved-changes marker) and did not change at all is the same
            # class of proof-of-absence every other route in this file already
            # requires before falling through — not a guess, a re-check of the
            # oracle the file already trusts elsewhere.
            $msixBlackhole = (-not $saveAsOpened) -and $fgTitleBefore -and
                $fgTitleBefore.StartsWith('*') -and ($fgTitle2 -eq $fgTitleBefore)

            if (-not $comboSentZero -and -not $msixBlackhole) {
                $result = @{ key = $raw; sent = $true; combo = $true; mechanism = 'sendinput-vk' }
                if ($saveAsOpened) { $result.result = 'save-as-dialog-opened' }
                return $result
            }

            # SendInput delivered nothing (the MSIX blackhole every other route in
            # this file works around), OR it reported delivery but the title proves
            # the app never acted on it (the same blackhole, self-reported as a
            # false success instead of comboSentZero) — try the app's own Save UI
            # element via UIA, which does not travel through the input stack
            # SendInput uses.
            $saveEl = $null
            try {
                $root2 = [System.Windows.Automation.AutomationElement]::FromHandle($fgHwnd2)
                $saveEl = Find-InvokableSaveDescendant $root2
            } catch { }
            $blackholeReason = if ($comboSentZero) { 'SendInput injected 0 events' } else { "SendInput reported success but the window title ($fgTitle2) never changed" }
            if (-not $saveEl) {
                return ("Send key 'ctrl+s' failed: $blackholeReason, and no invokable " +
                    "'Save'/'Save As' element was found in the foreground window ($fgTitle2) to use instead.")
            }
            try { $saveEl.invoke.Invoke() } catch {
                return "Send key 'ctrl+s' failed: $blackholeReason, and invoking the UIA '$($saveEl.name)' element threw: $($_.Exception.Message)"
            }
            Start-Sleep -Milliseconds 300
            $fgHwnd3 = [NativeInput]::GetForegroundWindow()
            $sb3 = New-Object System.Text.StringBuilder 512
            [void][NativeInput]::GetWindowText($fgHwnd3, $sb3, 512)
            $result = @{ key = $raw; sent = $true; combo = $true; mechanism = 'uia-invoke-save' }
            if ($sb3.ToString() -match 'Save As') { $result.result = 'save-as-dialog-opened' }
            return $result
        }

        if ($comboSentZero) {
            return "Send key '$key' failed: SendInput injected 0 events (input may be blocked by a higher-integrity foreground app)."
        }
        # Combos deliberately get NO escalation ladder. WM_KEYDOWN carries a single
        # virtual key and no modifier state, so posting the base key of "ctrl+n" would
        # deliver a bare 'n' — a wrong action dressed up as a recovered one. A combo
        # that SendInput cannot deliver is reported honestly instead.
        return @{ key = $raw; sent = $true; combo = $true; mechanism = 'sendinput-vk' }
    }

    $vk = $VK_CODES[$raw]
    if (-not $vk) {
        return @("Unknown key: $key. Valid: $($VK_CODES.Keys -join ', ')")
    }

    # MECHANISM LADDER (2026-08-02) — the send_key analogue of Handle-UiType's.
    #
    # MSIX-packaged apps (Win11 Notepad, WhatsApp Desktop) silently discard SendInput
    # while reporting the events as injected: UIPI blocks it and, per Microsoft's own
    # documentation, "neither GetLastError nor the return value will indicate the
    # failure". So the old zero-events check could never fire for them, and send_key
    # returned sent:$true while WhatsApp received nothing at all. That is why Enter had
    # to be pressed by hand on 2026-08-02, and it is the same blackhole ui_type already
    # escalates around ('sendinput-unicode' -> 'uia-setvalue' -> 'wm-char-post').
    #
    # ESCALATION IS GATED ON PROOF OF ABSENCE, exactly as in Handle-UiType. A key that
    # DID land and is then re-sent through route 2 fires the action twice — for Enter in
    # a chat app that means sending the message twice, which is worse than an honest
    # "I could not confirm this". So a route only runs when the oracle positively shows
    # the control unchanged, and when no oracle is available nothing escalates.
    $beforeRead = $null
    $hasOracle = $KEYS_WITH_TEXT_ORACLE -contains $raw
    if ($hasOracle) { $beforeRead = Read-FocusedElementText }

    $mechanism = 'sendinput-vk'
    $mechanismsTried = @('sendinput-vk')
    $script:LastVkSent = $null
    Send-VkKey $vk
    # Same BUG-042-class honest failure as Handle-MediaKey/Handle-UiType.
    if ($null -ne $script:LastVkSent -and $script:LastVkSent -lt 1) {
        return "Send key '$key' failed: SendInput injected 0 events (input may be blocked by a higher-integrity foreground app)."
    }

    $landed = $null   # $true / $false / $null = unknown
    if ($hasOracle -and $null -ne $beforeRead) {
        Start-Sleep -Milliseconds 150
        $after = Read-FocusedElementText
        if ($null -ne $after) { $landed = ([string]$after.text -ne [string]$beforeRead.text) }
    }

    if ($landed -eq $false) {
        # Route 2 — WM_KEYDOWN/WM_KEYUP posted straight at the focused child control.
        # This bypasses the input stack UIPI guards, and unlike WM_CHAR it carries a
        # real virtual key, so editors that treat Enter/Delete as key events (React
        # composers, Chromium) see what they expect. GetFocus is thread-local, so our
        # queue must be attached to the foreground thread's first or it reports our own
        # windowless focus and the message goes nowhere.
        $mechanismsTried += 'wm-key-post'
        try {
            $fgH = [NativeInput]::GetForegroundWindow()
            $fgP = 0
            $fgThread = [NativeInput]::GetWindowThreadProcessId($fgH, [ref]$fgP)
            $ourThread = [NativeInput]::GetCurrentThreadId()
            $attached = [NativeInput]::AttachThreadInput($ourThread, $fgThread, $true)
            $target = [IntPtr]::Zero
            try { if ($attached) { $target = [NativeInput]::GetFocus() } }
            finally { if ($attached) { [void][NativeInput]::AttachThreadInput($ourThread, $fgThread, $false) } }
            if ($target -eq [IntPtr]::Zero) { $target = $fgH }
            [void][NativeInput]::PostMessage($target, [NativeInput]::WM_KEYDOWN, [IntPtr][int]$vk, [IntPtr]0)
            [void][NativeInput]::PostMessage($target, [NativeInput]::WM_KEYUP, [IntPtr][int]$vk, [IntPtr]0)
            Start-Sleep -Milliseconds 250
            $after = Read-FocusedElementText
            if ($null -ne $after -and [string]$after.text -ne [string]$beforeRead.text) {
                $mechanism = 'wm-key-post'
                $landed = $true
            }
        } catch { }
    }

    if ($landed -eq $false -and $raw -eq 'enter') {
        # Route 3 — ask the app to do the thing Enter means, through UIA. Only Enter has
        # a defensible UIA equivalent: invoke the default action of whatever holds the
        # caret. There is no UIA analogue of "press Delete", so the other oracle keys
        # stop at route 2 rather than invoking something arbitrary.
        $mechanismsTried += 'uia-invoke-focused'
        try {
            $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
            $ip = $null
            if ($fe) { $ip = $fe.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) -as [System.Windows.Automation.InvokePattern] }
            if ($ip) {
                $ip.Invoke()
                Start-Sleep -Milliseconds 300
                $after = Read-FocusedElementText
                if ($null -ne $after -and [string]$after.text -ne [string]$beforeRead.text) {
                    $mechanism = 'uia-invoke-focused'
                    $landed = $true
                }
            }
        } catch { }
    }

    if ($landed -eq $false -and $raw -eq 'enter') {
        # Route 4 — WM_CHAR posted with \r, same mechanism Handle-UiType's route 3
        # (wm-char-post) already uses for ordinary text, applied to Enter specifically.
        # Route 2 (wm-key-post) carries a real virtual key and is preferred when it
        # works; this exists for controls that only listen for the CHARACTER form of
        # Enter (some RichEdit/Chromium composers treat WM_KEYDOWN(VK_RETURN) and
        # WM_CHAR('\r') as distinct signals and only act on one of them). Gated on the
        # same proof-of-absence as every other route here, so a key that already
        # landed via route 2/3 never reaches this and cannot double-fire.
        $mechanismsTried += 'wm-char-post'
        try {
            $fgH3 = [NativeInput]::GetForegroundWindow()
            $fgP3 = 0
            $fgThread3 = [NativeInput]::GetWindowThreadProcessId($fgH3, [ref]$fgP3)
            $ourThread3 = [NativeInput]::GetCurrentThreadId()
            $attached3 = [NativeInput]::AttachThreadInput($ourThread3, $fgThread3, $true)
            $target3 = [IntPtr]::Zero
            try { if ($attached3) { $target3 = [NativeInput]::GetFocus() } }
            finally { if ($attached3) { [void][NativeInput]::AttachThreadInput($ourThread3, $fgThread3, $false) } }
            if ($target3 -eq [IntPtr]::Zero) { $target3 = $fgH3 }
            [void][NativeInput]::PostMessage($target3, [NativeInput]::WM_CHAR, [IntPtr][int][char]"`r", [IntPtr]0)
            Start-Sleep -Milliseconds 250
            $after = Read-FocusedElementText
            if ($null -ne $after -and [string]$after.text -ne [string]$beforeRead.text) {
                $mechanism = 'wm-char-post'
                $landed = $true
            }
        } catch { }
    }

    if ($landed -eq $false) {
        # Every route ran and the oracle still shows the control untouched. This is the
        # MSIX blackhole reported honestly instead of as sent:$true.
        return ("Send key '$raw' failed: tried " + ($mechanismsTried -join ', ') +
            ' and the focused control is unchanged, so the key did not reach the app.')
    }

    $result = @{ key = $raw; sent = $true; mechanism = $mechanism }
    if ($mechanismsTried.Count -gt 1) { $result.mechanismsTried = $mechanismsTried }
    # State the oracle's verdict rather than leaving the caller to infer it. A proven
    # failure already returned above, so the only two states left are PROVEN LANDED and
    # UNKNOWN — and they get different field names so no consumer can mistake the second
    # for the first, or for a failure.
    if ($landed -eq $true) {
        $result.keyLanded = $true
        $result.landedVia = 'focused-control-text-changed'
    } else {
        $result.keyLandedUnknown = $true
        $result.keyLandedReason = 'this key has no text-visible effect to read back (or the focused control exposes no readable text), so whether it reached the app cannot be confirmed'
    }
    $result.caretOwnerPid = Get-CaretOwnerPid
    return $result
}

function Handle-MediaStatus {
    try {
        # Try to use Windows SMTC API (Windows 10 1903+)
        # This requires PowerShell 5.1+ with Windows Runtime support
        # BUG-139: use the script-scope type resolved once at startup (see line ~70)
        # instead of re-resolving it on every call.
        $type = $script:SmtcManagerType
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

# WAVE 9 (BUG-072) — Chromium/Electron builds its a11y tree LAZILY, on first UIA
# query (the same gotcha Read-FocusedElementText already retries once for,
# elsewhere in this file). A path resolved against an earlier turn's snapshot
# can go stale before a freshly-opened window's tree has settled, surfacing as
# "Element path index 0 out of range (parent has 0 children)" — a real example
# against WhatsApp at 20:10:36. One retry after a short settle, reusing that
# same precedent, before treating the path as genuinely gone.
function Resolve-UIAElement($TargetPid, $elementPath) {
    $result = Resolve-UIAElementOnce $TargetPid $elementPath
    if (-not $result.error) { return $result }
    if ($result.error -notmatch 'out of range') { return $result }
    Start-Sleep -Milliseconds 250
    return Resolve-UIAElementOnce $TargetPid $elementPath
}

function Resolve-UIAElementOnce($TargetPid, $elementPath) {
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
                # Report what the tree actually holds RIGHT NOW, so the model can
                # re-address the element instead of getting a bare index error.
                $labels = @()
                foreach ($c in $children) {
                    try {
                        $labels += ([string]$c.Current.ControlType.LocalizedControlType + ':' + [string]$c.Current.Name)
                    } catch { }
                }
                $labelText = if ($labels.Count -gt 0) { ' — current children: ' + ($labels -join ', ') } else { '' }
                return @{ error = ('Element path index ' + $idx + ' out of range (parent has ' + $children.Count + ' children)' + $labelText) }
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
        'set_app_volume' {
            $result = Handle-SetAppVolume $cmd.name $cmd.pid $cmd.level
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'get_app_volume' {
            $result = Handle-GetAppVolume $cmd.name $cmd.pid
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'set_app_mute' {
            $result = Handle-SetAppMute $cmd.name $cmd.pid $cmd.mute
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
            # pid is optional and new (2026-08-02): it enables the caret-owner guard, so
            # a keystroke aimed at one app can no longer land in another. Omitted pid
            # keeps the old "send to whatever has focus" contract.
            $result = Handle-SendKey $cmd.key $cmd.pid
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'diagnose_type' {
            $result = Handle-DiagnoseType $cmd.text $cmd.pid
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'get_foreground_window' {
            $result = Handle-GetForegroundWindow
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'focus_message_box' {
            $result = Handle-FocusMessageBox $cmd.pid $cmd.role
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'new_document' {
            $result = Handle-NewDocument $cmd.pid
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'read_compose_box' {
            $result = Handle-ReadComposeBox $cmd.pid
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'submit_message' {
            $result = Handle-SubmitMessage $cmd.pid
            if ($result -is [string]) { $err = $result; $result = $null }
        }
        'clear_focused_box' {
            $result = Handle-ClearFocusedBox $cmd.pid $cmd.count
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
            # BUG-108: pid is optional — absent means the whole desktop, as before.
            $result = Handle-ScreenReadText $cmd.pid
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
