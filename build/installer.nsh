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

!macro customPageAfterChangeDir
  !include LogicLib.nsh
  !include nsDialogs.nsh

  Page custom mythosComponentsPage mythosComponentsLeave

Function mythosComponentsPage
  !insertmacro MUI_HEADER_TEXT "Choose components" \
    "Pick what MYTHOS should set up on first launch. Everything here is optional and can be changed later from the app."

  nsDialogs::Create 1018
  Pop $ComponentsDialog
  ${If} $ComponentsDialog == error
    Abort
  ${EndIf}

  ; Defaults: the two small voice assets are checked because the voice loop
  ; degrades noticeably without them; the large or environment-dependent ones
  ; are not, so nobody gets a surprise 60 MB download or a WSL install.
  ${NSD_CreateCheckbox} 0 0u 100% 12u "Silero VAD  (~2 MB) — voice turn-taking"
  Pop $CbSilero
  ${NSD_Check} $CbSilero

  ${NSD_CreateCheckbox} 0 15u 100% 12u 'Wake word "hey jarvis"  (~4 MB)'
  Pop $CbWakeword
  ${NSD_Check} $CbWakeword

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

  ${If} $WslPresent == "1"
    ${NSD_CreateCheckbox} 0 30u 100% 12u "Hermes build agent (installs into WSL)"
    Pop $CbHermes
  ${Else}
    ${NSD_CreateCheckbox} 0 30u 100% 12u "Hermes build agent — needs WSL (run: wsl --install)"
    Pop $CbHermes
    EnableWindow $CbHermes 0
  ${EndIf}

  ${NSD_CreateCheckbox} 0 45u 100% 12u "Phone control via adb  (~15 MB)"
  Pop $CbAdb

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
  ${If} $SelSilero == ""
    StrCpy $SelSilero "true"
    StrCpy $SelWakeword "true"
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
