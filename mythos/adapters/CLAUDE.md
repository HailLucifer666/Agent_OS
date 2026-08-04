# mythos/adapters/ — repo rules for AI sessions

Scope: this file covers the adapters directory, and specifically the
PowerShell/WinRT `pc-child` adapter (`pc-child/index.js` +
`pc-child/ps-automation.ps1`), which is the one with the most hard-won,
easy-to-relearn-the-hard-way gotchas in this repo. Root `CLAUDE.md` still
applies here (open-source portability, testing discipline, the ACTIVE BUILD
pointer) — this file adds what's specific to this directory.

## Hard-won platform gotchas (do not re-learn these)

- **PowerShell 5.1 + pipes**: stdout defaults to the OEM codepage, which
  best-fits curly quotes (U+201C/D) into ASCII `"`, corrupting JSON in
  transit. `ps-automation.ps1` sets UTF-8 console encoding AND escapes
  non-ASCII as `\uXXXX` in `Write-Response`. Keep both.
- **`$pid`, `$PID` are reserved** in PowerShell — never use as a parameter or
  variable name. A `$pid`-named parameter throws at binding time and the
  handler returns null; use `$TargetPid` or similar instead.
- **WinRT COM objects** (`System.__ComObject`) cannot be reflected —
  `.GetType().GetInterfaces()` returns empty. Pass expected result types
  explicitly (see `Await-WinRTOperation`'s explicit `[type]$ResultType`
  param).
- **Chromium/Electron apps (Spotify)**: accessibility tree builds lazily on
  first UIA query; background/posted clicks are silently dropped (cua-driver
  reports `verified:false`) — escalate to `delivery_mode:'foreground'`.
- **pc-child protocol**: every command carries an `id`, echoed in the
  response; node drops mismatched ids as stale. Do not remove.
- **MSIX-packaged apps** (Win11 Notepad, WhatsApp, and similarly-packaged
  apps) silently discard `SendInput` while still reporting the injected
  event as successful — UIA `SetValue`/`WM_CHAR` work where `SendInput`
  doesn't. Never let a diagnostic clear using the same keystroke path it's
  meant to be testing, and note that PowerShell-tool probes are themselves
  UIPI-blocked — only a real node → pc-child round trip measures truthfully.
- **Keystrokes follow the caret, not the foreground window**: injected keys
  go to whichever window currently owns the UIA caret, not necessarily the
  window that has focus. A foreground-pid guard can pass while the text
  actually lands in a different app — verifying "it worked" means reading
  back from the window the caret was actually in, not the one you asked to
  focus.
- **Windows foreground-lock**: `focus_window` can be reproducibly denied by
  Windows' foreground-lock in headless/no-app-focused conditions, even with
  the `AttachThreadInput` workaround already in place. Unconfirmed whether
  this reproduces when some app is already focused (the normal voice-driven
  case) — if typing into a launched app silently fails, re-test starting
  from a real app (not the bare desktop) having focus first.
- **DPI awareness**: `ps-automation.ps1` has a DPI-awareness block that must
  stay intact — screen coordinates are wrong without it on any non-100%-scale
  display.
