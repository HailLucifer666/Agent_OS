# Phase C0 — PC Control Spike Results

**Date:** 2026-07-07
**Verdict: GO** — All three capability pillars validated.

## Spike 1: UIA Tree Walking (`spike-uia.ps1`)

| Check | Result |
|-------|--------|
| `UIAutomationClient` assembly loads | OK |
| RootElement acquired | OK (ClassName: #32769) |
| Enumerate top-level windows | OK (8 found, PID + process name + class) |
| Descend into window children | OK (Task Manager: 1 child) |
| BoundingRectangle | WARN: returns `Infinity` for minimized/offscreen windows — must guard in real module |

**Implementation note:** Use `[double]` cast instead of `[int]` for rect coordinates, and treat `Infinity`/NaN as offscreen.

## Spike 2: SendInput P/Invoke (`spike-sendinput.ps1`)

| Check | Result |
|-------|--------|
| C# Add-Type compiles | OK |
| Keyboard SendInput (Scroll Lock) | OK (returned 2) |
| Mouse SendInput (move) | OK (returned 1) |

**Implementation note:** Scroll Lock is a safe test key (no side effects for most apps). The P/Invoke signatures are stable and work on Windows 10 26200.

## Spike 3: Screenshot Capture (`spike-screenshot.ps1`)

| Check | Result |
|-------|--------|
| System.Drawing screen capture | OK (1920x1080, 122.6 KB PNG) |
| Region cropping | OK (center 400x300, 9.6 KB) |
| PNG → Base64 | OK (163.4 KB) |
| Window bounds enumeration | OK (mix of visible + offscreen windows) |

**Implementation note:** Full-screen PNG is ~123KB, base64 ~163KB — feasible for vision pipeline. Window capture needs to skip offscreen windows (rect.Width/Height <= 0 or Infinity).

## Architecture Decision

- UIA + SendInput + System.Drawing all work on this Windows 11 build
- Vision fallback (screenshot → VLM → coordinates → click) is feasible at ~163KB per frame
- PowerShell module will handle: UIA tree, SendInput, screenshots, window management
- Node.js bridge (`pc-child.js`) will spawn the PS module as a long-running child process, accepting JSON commands over stdin
