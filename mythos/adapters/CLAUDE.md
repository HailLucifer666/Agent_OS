# mythos/adapters/ — repo rules for AI sessions

Scope: this file covers the adapters directory, and specifically the
PowerShell/WinRT `pc-child` adapter (`pc-child/index.js` +
`pc-child/ps-automation.ps1`), which is the one with the most hard-won,
easy-to-relearn-the-hard-way gotchas in this repo. Root `CLAUDE.md` still
applies here (open-source portability, testing discipline, the ACTIVE BUILD
pointer) — this file adds what's specific to this directory.

## Hard-won platform gotchas (do not re-learn these)

- **While a MYTHOS confirmation dialog is open, no synthetic input is sent (B3b,
  2026-09-29 audit).** `adapters/input-inhibit.js` holds one flag, set by
  server/index.js when Electron is about to show a key/settings confirmation and
  cleared when it is answered. pc-child refuses every input command while it is
  set, checked when the command is SENT (processQueue) so one queued before the
  dialog opened is refused too, and the server acks only once none is in flight; and cua-driver's `invoke()` refuses every tool but
  its reads. A new input command must join pc-child's `INHIBITED_WHILE_CONFIRMING`
  (`test/electron-settings-confirm.test.js` lists them).

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
- **`MainWindowHandle == 0` does NOT mean "this process owns no window".** It has two
  causes needing opposite targets, and conflating them was BUG-280 (fixed 2026-08-20).
  (a) The pid really owns nothing - a browser renderer/utility child, or a launcher
  stub - and the right target is a *sibling process of the same executable*
  (`Resolve-WindowedProcessByName`, BUG-103). (b) The pid owns a real, visible
  top-level window that .NET simply does not classify as "main". **Every
  rundll32-hosted Control Panel dialog is (b)**: `launch_app main.cpl` opens Mouse
  Properties under rundll32, `list_windows` reports it (className `#32770`, a real
  hwnd, `visible:true`), and `MainWindowHandle` is still 0. For (b) the sibling search
  is guaranteed to miss - rundll32 IS the host - so `close_window` answered "no window
  to close" about a dialog sitting on screen.
  - **Resolve a window by PID the way `Handle-ListWindows` does** (enumerate the UIA
    desktop's children and match `ProcessId`, take `NativeWindowHandle`), *then* fall
    back to the name-based sibling search. Two commands in this file disagreeing about
    whether a window exists is the smell; sharing one enumeration is the cure.
  - **`Process.CloseMainWindow()` cannot serve case (b)** - it posts WM_CLOSE to
    `MainWindowHandle`, the exact handle that is zero. Send `WM_CLOSE` (0x0010) to the
    enumerated hwnd with `SendMessageTimeout` + `SMTO_ABORTIFHUNG`. Not `SendMessage`
    (one modal dialog wedges this single-threaded adapter until it is answered), not
    `PostMessage` (no delivery signal, so a dropped message reads like a refused close).
  - **`IsWindow` is the oracle, never the send call's return** - a dialog can acknowledge
    WM_CLOSE and stay open on a confirmation prompt. Same wrong-oracle class as BUG-103's
    `WaitForExit` on a multi-window browser.
  - 0x0010 already appears in `NativeInput` as `MOUSEEVENTF_RIGHTUP` and `SWP_NOACTIVATE`.
    Unrelated constants that share a number - do not reuse either name for a window
    message.
- **`verify-desktop-automation.js`'s charmap type/click cells go red if anyone types
  during the run.** Seen 2026-08-20: two runs failed and read as a regression from an
  unrelated `close_window` change; the **unmodified** script failed identically on its
  next run, reading back the operator's own keystrokes instead of the probe text. Charmap's
  typing route follows the caret (see the caret-vs-foreground entry above), so an idle
  desktop is part of the instrument. Before believing a red cell, re-run it quiet and pair
  it against the pre-change file.
- **DPI awareness**: `ps-automation.ps1` has a DPI-awareness block that must
  stay intact — screen coordinates are wrong without it on any non-100%-scale
  display.
- **Some control-panel controls APPLY THE MOMENT YOU DRIVE THEM — and the
  registry is not the oracle for that. Learned the hard way 2026-08-20.**
  A live probe of `ui_click`'s pattern ladder toggled Mouse Properties'
  "Switch primary and secondary buttons" checkbox via `TogglePattern.Toggle()`.
  **The operator's mouse buttons swapped immediately**, with no Apply and no OK.
  The assumption that "a property sheet commits nothing until Apply/OK" is
  FALSE for at least that checkbox; the double-click **Speed** slider on the
  same tab behaved the other way (`RangeValuePattern.SetValue` moved the dialog
  control and `GetDoubleClickTime()` never changed). So it is per-control, and
  it cannot be predicted from the dialog.
  Worse, the verification was wrong in a way that read as reassuring:
  `HKCU\Control Panel\Mouse\SwapMouseButtons` still said `0` **while the buttons
  were physically swapped**, because Mouse Properties writes that value on Apply
  while the live state is set through `SystemParametersInfo`. The registry is the
  *persisted* value, not the live one.
  - **Live oracles for mouse state**: `GetSystemMetrics(SM_SWAPBUTTON=23)` and
    `GetDoubleClickTime()`. Never the registry.
  - **Restore** with `SystemParametersInfo(SPI_SETMOUSEBUTTONSWAP=0x0021, 0,
    IntPtr.Zero, SPIF_UPDATEINIFILE|SPIF_SENDCHANGE=3)`.
  - **Rule for any live desktop probe**: read the live oracle before AND after,
    restore in a `finally`, and never target a control that changes an input
    device. Prefer `charmap` — its controls are app-local. A settings dialog is
    not a safe test fixture just because you never press OK.
