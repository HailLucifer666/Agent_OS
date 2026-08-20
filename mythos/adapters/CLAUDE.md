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
- **Windows foreground-lock — CONFIRMED LIVE 2026-08-17, question closed.**
  `focus_window` is reproducibly denied by Windows' foreground-lock, and it
  does NOT need headless/no-app-focused conditions: the 2026-08-17 voice
  session hit it on pid 17996 with a real app already focused, which is the
  normal voice-driven case this entry used to call unconfirmed (BUG-272 T3).
  **All three ladder rungs had already run** — thread-attach, lock-timeout
  override, minimize/restore — and the error string itself says so. The ladder
  is exhausted.
  **Do not add a speculative 4th rung.** Windows is refusing on purpose; the
  remaining options are either unreliable (synthetic input to steal focus) or
  user-hostile. Fail honestly and let the operator click. If typing into a
  launched app silently succeeds-but-lands-elsewhere, that is the SEPARATE
  caret-vs-foreground-window issue above, not this.
- **`MainWindowHandle == 0` does NOT mean "this process owns no window"**
  (BUG-280, measured live 2026-08-20). It is a Win32 notion and says nothing
  about whether the process owns a top-level window UIA/EnumWindows can see.
  A **hosted dialog** — `rundll32` running a `.cpl`, window class `#32770` —
  reports `0` while owning a visible window with a real hwnd that
  `list_windows` reports without difficulty. Two handlers read it as an
  ownership test. `close_window` is **fixed** (BUG-280): it needs a handle to
  act on, so it resolves one from the same UIA source `list_windows` reads, via
  `Get-OwnedTopLevelWindows`, before falling back to the name match.
  `Handle-UiElements` still carries the same guard at the time of writing —
  its `MainWindowHandle -eq Zero` early return fires on a hosted dialog even
  though its own lookup is already `FindFirst` by ProcessId and would have
  found the window, so there the guard can simply be **deleted**. A fix for it
  was reported to live on a separate branch (`fix/ui-elements-hosted-dialogs`),
  which is not present on `origin` or in this tree — verify before assuming it
  landed. **Never use MainWindowHandle as a "does this pid have a window"
  test.** Enumerate by ProcessId instead.
  Related: `Resolve-WindowedProcessByName` matches on the process NAME, so for
  a single hosted dialog it searches for a sibling that does not exist and
  reports "no window" about a window that is right there.
- **A PowerShell function returning a one-element array UNROLLS it, and
  `.Count` on the resulting hashtable counts its KEYS.** `return @($found)`
  inside the callee does not survive the return: the caller receives the bare
  hashtable, and `$x.Count` answers 3 for a 3-key hashtable. This shipped
  inside the BUG-280 fix itself and inverted it — the single-window case took
  the "more than one window, refusing to guess" branch and reported that
  rundll32 owned 3 visible windows when it owned exactly one. Wrap at the
  **call site**: `$owned = @(Get-OwnedTopLevelWindows $TargetPid)`. Any
  `.Count` on a value returned by a function in this file is suspect unless
  the call site wraps.
- **DPI awareness**: `ps-automation.ps1` has a DPI-awareness block that must
  stay intact — screen coordinates are wrong without it on any non-100%-scale
  display.
