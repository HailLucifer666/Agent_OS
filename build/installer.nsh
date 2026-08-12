; build/installer.nsh — the installer's component-selection page.
;
; Wired in via package.json build.nsis.include. Two electron-builder hooks are
; used, both confirmed present in node_modules/app-builder-lib/templates/nsis:
;   customPageAfterChangeDir — a page shown AFTER the directory page and before
;                              MUI_PAGE_INSTFILES (assistedInstaller.nsh:42).
;                              Requires oneClick:false, which package.json sets.
;   customInstall            — runs inside the install section
;                              (installSection.nsh:81).
;
; WHAT THIS PAGE DOES AND DOES NOT DO — the honest part:
;
; None of the optional components live inside this .exe. build.files excludes
; mythos/models and mythos/ui/public/models; adb is a download; Hermes installs
; into WSL. They are runtime installs with their own scripts under
; mythos/scripts/ (setup-silero.js, setup-wakeword.js, setup-android.js,
; setup-hermes.js, setup-autostart.js).
;
; So this page does NOT copy component files, and it must not imply that it did.
; It records the operator's CHOICE into
;
;     $APPDATA\MYTHOS\install-selection.json
;
; and MYTHOS's first-run wizard reads that file, pre-checks exactly those boxes,
; and performs the installs where progress and failure can actually be shown.
; The alternative — NSIS shelling out to node after copying files — would run
; the downloads outside the app with no progress bar, no cancel, and a silent
; failure if the network is down, which is precisely the "looks installed, is
; not" state the whole setup path exists to end.
;
; $APPDATA (not $INSTDIR) is deliberate: it is where Electron's
; app.getPath('userData') resolves for productName MYTHOS, which is where the
; key store and the vault already live, and it survives an uninstall/reinstall.

; UNINSTALLER FILE REMOVAL — customRemoveFiles (uninstaller pass only).
;
; Consumed by app-builder-lib/templates/nsis/uninstaller.nsh (~line 144):
; when this macro is defined it REPLACES both the ${isUpdated} per-file rename
; dance (un.atomicRMDir, which renames every file one at a time into
; $PLUGINSDIR\old-install) and the plain `RMDir /r $INSTDIR` of a normal
; uninstall — there is no fallback delete after it, so this macro alone must
; remove $INSTDIR in both cases. The $APPDATA keep-user-data behaviour
; (deleteAppDataOnUninstall:false) lives in a separate, later block of
; uninstaller.nsh and is untouched.
;
; WHY IT EXISTS (operator, 2026-08-13): in-app updates 0.1.6 → 0.1.7 failed
; three times. The default un.atomicRMDir aborts the whole pass on a single
; locked file (AV scan, slow handle release), and the new installer's
; uninstallOldVersion retries the entire uninstaller only 5× at 1s before
; rolling the update back. This macro retries the removal itself, and on
; final failure defers the stragglers to reboot instead of failing the
; update. Deliberate behaviour change: a stubbornly locked file no longer
; aborts the update — it leaves a stale old file beside the new install
; until the next reboot, which beats a rolled-back update.
;
; Native NSIS only (no LogicLib) — include ordering of the sharedHeader vs
; multiUser.nsh makes ${If} unreliable here; same reason
; customPageAfterChangeDir below does its own local includes.
!ifdef BUILD_UNINSTALLER
!macro customRemoveFiles
  Var /GLOBAL removeFilesTries
  StrCpy $removeFilesTries 0

  removeFilesRetry:
    ClearErrors
    RMDir /r "$INSTDIR"
    IfErrors 0 removeFilesDone

    IntOp $removeFilesTries $removeFilesTries + 1
    IntCmp $removeFilesTries 5 removeFilesGiveUp removeFilesWait removeFilesGiveUp

    removeFilesWait:
      DetailPrint "MYTHOS uninstall: files in $INSTDIR still in use, retrying ($removeFilesTries/5)..."
      Sleep 1000
      Goto removeFilesRetry

  removeFilesGiveUp:
    DetailPrint "MYTHOS uninstall: some files still locked; scheduling removal on next reboot."
    ClearErrors
    RMDir /r /REBOOTOK "$INSTDIR"

  removeFilesDone:
!macroend
!endif ; BUILD_UNINSTALLER (customRemoveFiles)

; BUILD_UNINSTALLER GUARD — the whole body below is installer-only.
;
; electron-builder compiles this same include twice: once for the installer and
; once with BUILD_UNINSTALLER defined to produce the uninstaller. That second
; pass has no MUI2 pages, so MUI_HEADER_TEXT is undefined and the build aborts
; ("macro named MUI_HEADER_TEXT not found"). Nothing here belongs to the
; uninstaller anyway — it draws a page and writes a manifest.
!ifndef BUILD_UNINSTALLER

Var ComponentsDialog
Var CbSilero
Var CbWakeword
Var CbHermes
Var CbAdb
Var CbAutostart
Var SelSilero
Var SelWakeword
Var SelPiper
Var SelHermes
Var SelAdb
Var SelAutostart
Var WslPresent

; ---- already-installed detection (operator, 2026-08-12) ----------------------
;
; "When updating, it's asking me for the same things — the phone install, the
; Hermes install. Those are already installed."
;
; They were, and this page asked anyway: every checkbox above was hardcoded
; checked or unchecked and nothing ever looked at the disk. On an update that is
; not merely noise — accepting the pre-checked boxes re-downloads assets that are
; already present.
;
; WHERE TO LOOK. These are exactly the paths electron/main.js injects as
; MYTHOS_MODELS_DIR and MYTHOS_TOOLS_DIR (<userData>/models, <userData>/tools),
; and $APPDATA\MYTHOS is what app.getPath('userData') resolves to for
; productName MYTHOS — the same reasoning the install-selection.json write at the
; bottom of this file already documents. If those move, this moves with them.
;
; Hermes is checked in three places because it has three legitimate homes: the
; userData one setup-hermes.js writes to now, the HERMES_HOME the operator may
; have set (this machine has it as a user env var), and the in-tree location
; every install before 2026-08-12 used.
;
; DETECTED MEANS UNCHECKED AND DISABLED, not hidden: "Silero VAD — already
; installed" is information; a silently missing row reads as a downgrade.

Var FoundSilero
Var FoundWakeword
Var FoundHermes
Var FoundAdb

!macro DetectComponents
  StrCpy $FoundSilero "0"
  StrCpy $FoundWakeword "0"
  StrCpy $FoundHermes "0"
  StrCpy $FoundAdb "0"

  ${If} ${FileExists} "$APPDATA\MYTHOS\models\silero\silero_vad.onnx"
    StrCpy $FoundSilero "1"
  ${EndIf}

  ; All three assets or nothing — WAKEWORD_ENABLED cannot arm on a partial set,
  ; so a half-downloaded directory must still offer the download (doctor.js's
  ; wakeword row applies the same all-or-nothing rule).
  ${If} ${FileExists} "$APPDATA\MYTHOS\models\wakeword\melspectrogram.onnx"
  ${AndIf} ${FileExists} "$APPDATA\MYTHOS\models\wakeword\embedding_model.onnx"
  ${AndIf} ${FileExists} "$APPDATA\MYTHOS\models\wakeword\hey_jarvis_v0.1.onnx"
    StrCpy $FoundWakeword "1"
  ${EndIf}

  ${If} ${FileExists} "$APPDATA\MYTHOS\tools\Hermes Agent\hermes-agent\venv\Scripts\hermes.exe"
    StrCpy $FoundHermes "1"
  ${ElseIf} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\Hermes Agent\hermes-agent\venv\Scripts\hermes.exe"
    StrCpy $FoundHermes "1"
  ${Else}
    ReadEnvStr $0 "HERMES_HOME"
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\hermes-agent\venv\Scripts\hermes.exe"
      StrCpy $FoundHermes "1"
    ${EndIf}
  ${EndIf}

  ${If} ${FileExists} "$APPDATA\MYTHOS\tools\Android Platform Tools\platform-tools\adb.exe"
    StrCpy $FoundAdb "1"
  ${EndIf}
!macroend

; DetectComponents is defined ABOVE this macro, not inside it. NSIS cannot
; define a macro inside a macro ("can't define a macro inside a macro!"), and
; when it was nested here the whole installer build aborted — producing a 222 KB
; stub .exe instead of a real installer, with the failure only visible in the
; NSIS output. That is why the 2026-08-12 21:08 build never yielded an
; installer at all. Nothing else about the page changed.
!macro customPageAfterChangeDir
  !include LogicLib.nsh
  !include nsDialogs.nsh

  Page custom mythosComponentsPage mythosComponentsLeave

Function mythosComponentsPage
  ; NEVER show this page on an update (operator, 2026-08-13). The template
  ; guards its OWN pages this way — assistedInstaller.nsh puts
  ; `!insertmacro skipPageIfUpdated` before the licence page and
  ; MUI_PAGE_DIRECTORY — but that macro works by defining
  ; MUI_PAGE_CUSTOMFUNCTION_PRE, which a raw `Page custom` ignores. So the
  ; guard has to live here, in the page's own function, where an Abort is what
  ; skips the page.
  ;
  ; Without it, this page was the reason a non-silent update looked like a
  ; fresh install, which is why the update path was made silent — and a silent
  ; 8-minute install is what showed the operator nothing at all and read as a
  ; dead update. Guarded, a non-silent update shows only the progress bar.
  ;
  ; Skipping changes no install behaviour: customInstall below already handles
  ; empty $Sel* variables by DETECTING what is on disk first, which is exactly
  ; the path a silent update has always taken.
  ${If} ${isUpdated}
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Choose components" \
    "Pick what MYTHOS should set up on first launch. Anything already on this machine is shown as installed and left alone."

  nsDialogs::Create 1018
  Pop $ComponentsDialog
  ${If} $ComponentsDialog == error
    Abort
  ${EndIf}

  !insertmacro DetectComponents

  ; Defaults: the two small voice assets are checked because the voice loop
  ; degrades noticeably without them; the large or environment-dependent ones
  ; are not, so nobody gets a surprise 60 MB download or a WSL install. Anything
  ; already on disk overrides that and is left unchecked + disabled.
  ${If} $FoundSilero == "1"
    ${NSD_CreateCheckbox} 0 0u 100% 12u "Silero VAD — already installed"
    Pop $CbSilero
    EnableWindow $CbSilero 0
  ${Else}
    ${NSD_CreateCheckbox} 0 0u 100% 12u "Silero VAD  (~2 MB) — voice turn-taking"
    Pop $CbSilero
    ${NSD_Check} $CbSilero
  ${EndIf}

  ${If} $FoundWakeword == "1"
    ${NSD_CreateCheckbox} 0 15u 100% 12u 'Wake word "hey jarvis" — already installed'
    Pop $CbWakeword
    EnableWindow $CbWakeword 0
  ${Else}
    ${NSD_CreateCheckbox} 0 15u 100% 12u 'Wake word "hey jarvis"  (~4 MB)'
    Pop $CbWakeword
    ${NSD_Check} $CbWakeword
  ${EndIf}

  ; No Piper checkbox on purpose: scripts/setup-piper.js does not exist in this
  ; repo (doctor.js's piper row says so explicitly). A checkbox that cannot act
  ; is the same lie as a fake progress bar, so it stays a manual step and the
  ; app's gap list reports it.
  StrCpy $SelPiper "false"

  ; Hermes needs WSL. Probing here rather than offering a box that fails later:
  ; "wsl.exe --status" exits non-zero when WSL is absent or not provisioned.
  nsExec::ExecToStack '"$SYSDIR\wsl.exe" --status'
  Pop $0
  Pop $1
  ${If} $0 == 0
    StrCpy $WslPresent "1"
  ${Else}
    StrCpy $WslPresent "0"
  ${EndIf}

  ${If} $FoundHermes == "1"
    ${NSD_CreateCheckbox} 0 30u 100% 12u "Hermes build agent — already installed"
    Pop $CbHermes
    EnableWindow $CbHermes 0
  ${ElseIf} $WslPresent == "1"
    ${NSD_CreateCheckbox} 0 30u 100% 12u "Hermes build agent (installs into WSL)"
    Pop $CbHermes
  ${Else}
    ${NSD_CreateCheckbox} 0 30u 100% 12u "Hermes build agent — needs WSL (run: wsl --install)"
    Pop $CbHermes
    EnableWindow $CbHermes 0
  ${EndIf}

  ${If} $FoundAdb == "1"
    ${NSD_CreateCheckbox} 0 45u 100% 12u "Phone control via adb — already installed"
    Pop $CbAdb
    EnableWindow $CbAdb 0
  ${Else}
    ${NSD_CreateCheckbox} 0 45u 100% 12u "Phone control via adb  (~15 MB)"
    Pop $CbAdb
  ${EndIf}

  ${NSD_CreateCheckbox} 0 60u 100% 12u "Start MYTHOS when I sign in"
  Pop $CbAutostart

  ${NSD_CreateLabel} 0 80u 100% 24u "These are downloaded and configured by MYTHOS on first launch, where you can watch the progress and retry a failure. Your selection is saved to $APPDATA\MYTHOS."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function mythosComponentsLeave
  ${NSD_GetState} $CbSilero $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelSilero "true"
  ${Else}
    StrCpy $SelSilero "false"
  ${EndIf}

  ${NSD_GetState} $CbWakeword $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelWakeword "true"
  ${Else}
    StrCpy $SelWakeword "false"
  ${EndIf}

  ; A disabled checkbox cannot be checked, so this also encodes "WSL missing".
  ${NSD_GetState} $CbHermes $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelHermes "true"
  ${Else}
    StrCpy $SelHermes "false"
  ${EndIf}

  ${NSD_GetState} $CbAdb $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelAdb "true"
  ${Else}
    StrCpy $SelAdb "false"
  ${EndIf}

  ${NSD_GetState} $CbAutostart $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelAutostart "true"
  ${Else}
    StrCpy $SelAutostart "false"
  ${EndIf}
FunctionEnd
!macroend

!macro customInstall
  ; Written in the install section so it lands after the app itself: a manifest
  ; without an app would be a file nothing ever reads.
  ;
  ; Hand-written JSON rather than a generated one — six booleans and a version
  ; do not justify a plugin, and the reader (mythos/src/core/setup/
  ; install-selection.js) treats an unparseable file as "no selection" rather
  ; than as an empty selection, so a malformed write here degrades to the
  ; wizard's own defaults instead of silently installing nothing.
  ; An update run reaches the install section with the page's variables still
  ; empty (the page can be skipped by the updater path). Empty strings would
  ; produce invalid JSON, so fall back to the page's own defaults rather than
  ; writing a file that reads as "install nothing".
  ;
  ; THE UPDATE PATH IS THE ONE THAT BIT (operator, 2026-08-12). This is where an
  ; update actually decides what the wizard will offer, and the fallback wrote
  ; silero:true / wakeword:true unconditionally — so every silent update queued a
  ; re-download of assets already on disk, no page shown, nothing asked. Detect
  ; first, then default: anything found stays false because it does not need
  ; installing, not because it is unwanted.
  ${If} $SelSilero == ""
    !insertmacro DetectComponents
    ${If} $FoundSilero == "1"
      StrCpy $SelSilero "false"
    ${Else}
      StrCpy $SelSilero "true"
    ${EndIf}
    ${If} $FoundWakeword == "1"
      StrCpy $SelWakeword "false"
    ${Else}
      StrCpy $SelWakeword "true"
    ${EndIf}
    StrCpy $SelPiper "false"
    StrCpy $SelHermes "false"
    StrCpy $SelAdb "false"
    StrCpy $SelAutostart "false"
  ${EndIf}
  ${If} $WslPresent == ""
    StrCpy $WslPresent "0"
  ${EndIf}

  CreateDirectory "$APPDATA\MYTHOS"
  FileOpen $0 "$APPDATA\MYTHOS\install-selection.json" w
  FileWrite $0 '{$\r$\n'
  FileWrite $0 '  "version": 1,$\r$\n'
  FileWrite $0 '  "source": "nsis",$\r$\n'
  FileWrite $0 '  "wslPresent": $WslPresent,$\r$\n'
  FileWrite $0 '  "selected": {$\r$\n'
  FileWrite $0 '    "silero": $SelSilero,$\r$\n'
  FileWrite $0 '    "wakeword": $SelWakeword,$\r$\n'
  FileWrite $0 '    "piper": $SelPiper,$\r$\n'
  FileWrite $0 '    "hermes": $SelHermes,$\r$\n'
  FileWrite $0 '    "adb": $SelAdb,$\r$\n'
  FileWrite $0 '    "autostart": $SelAutostart$\r$\n'
  FileWrite $0 '  }$\r$\n'
  FileWrite $0 '}$\r$\n'
  FileClose $0
!macroend

!endif ; BUILD_UNINSTALLER
