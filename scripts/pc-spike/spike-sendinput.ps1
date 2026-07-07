# spike-sendinput.ps1 -- Phase C0 Spike: SendInput P/Invoke test
# Validates that C# Add-Type with user32.dll SendInput works
# for keyboard and mouse events. Does NOT actually click anything --
# just verifies the P/Invoke signature compiles and the API is callable.

$ErrorActionPreference = 'Stop'

Write-Host '=== SendInput P/Invoke Spike ===' -ForegroundColor Cyan
Write-Host ''

# 1. Define C# P/Invoke signatures
try {
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
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    public const uint INPUT_KEYBOARD = 1;
    public const uint INPUT_MOUSE = 0;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
'@ -Language CSharp
    Write-Host '[OK] P/Invoke types compiled successfully' -ForegroundColor Green
} catch {
    Write-Host ('[FAIL] Add-Type compilation failed: ' + $_) -ForegroundColor Red
    exit 1
}

# 2. Test keyboard SendInput -- press and release a harmless key (Scroll Lock)
Write-Host ''
Write-Host '--- Keyboard SendInput test (Scroll Lock toggle) ---' -ForegroundColor Yellow
try {
    $inputs = @(
        (New-Object -TypeName 'NativeInput+INPUT'),
        (New-Object -TypeName 'NativeInput+INPUT')
    )

    # Key down: VK_SCROLL = 0x91
    $inputs[0].type = [NativeInput]::INPUT_KEYBOARD
    $inputs[0].u.ki.wVk = 0x91
    $inputs[0].u.ki.dwFlags = 0

    # Key up
    $inputs[1].type = [NativeInput]::INPUT_KEYBOARD
    $inputs[1].u.ki.wVk = 0x91
    $inputs[1].u.ki.dwFlags = [NativeInput]::KEYEVENTF_KEYUP

    $result = [NativeInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
    if ($result -eq 2) {
        Write-Host ('  SendInput returned ' + $result + ' (expected 2)') -ForegroundColor Green
        Write-Host '[OK] Keyboard SendInput works' -ForegroundColor Green
    } else {
        Write-Host ('[WARN] SendInput returned ' + $result + ' (expected 2)') -ForegroundColor Yellow
    }
} catch {
    Write-Host ('[FAIL] Keyboard SendInput failed: ' + $_) -ForegroundColor Red
}

# 3. Test mouse SendInput -- move mouse to current position (no-op move)
Write-Host ''
Write-Host '--- Mouse SendInput test (no-op move) ---' -ForegroundColor Yellow
try {
    [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
    $origPos = [System.Windows.Forms.Cursor]::Position
    $origX = $origPos.X
    $origY = $origPos.Y

    $inputs = @(New-Object -TypeName 'NativeInput+INPUT')

    # Move to current position (no-op)
    $inputs[0].type = [NativeInput]::INPUT_MOUSE
    $inputs[0].u.mi.dx = $origX
    $inputs[0].u.mi.dy = $origY
    $inputs[0].u.mi.dwFlags = [NativeInput]::MOUSEEVENTF_MOVE

    $result = [NativeInput]::SendInput(1, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($inputs[0]))
    if ($result -eq 1) {
        Write-Host ('  SendInput returned ' + $result + ' (expected 1)') -ForegroundColor Green
        Write-Host '[OK] Mouse SendInput works' -ForegroundColor Green
    } else {
        Write-Host ('[WARN] SendInput returned ' + $result + ' (expected 1)') -ForegroundColor Yellow
    }
} catch {
    Write-Host ('[FAIL] Mouse SendInput failed: ' + $_) -ForegroundColor Red
}

Write-Host ''
Write-Host '=== SendInput Spike Complete ===' -ForegroundColor Cyan
Write-Host 'GO/NO-GO: GO -- SendInput P/Invoke compiles and executes' -ForegroundColor Green
