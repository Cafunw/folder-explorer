; Folder Explorer — NSIS installer hooks (see tauri.conf.json > bundle.windows.nsis.installerHooks)
;
; Core rule (docs/ARCHITECTURE.md): the installer, like the app, does not touch Windows' desktop,
; Explorer or the registry beyond the installer's own uninstall entry. The one shell entry the app
; writes itself (Yeni ▸ Folder Explorer grubu, setting "behavior.newMenuEntry") is removed on uninstall.
;
; The app hides the Windows desktop icons while it runs. If an installer simply killed it,
; the icons could stay hidden, so every hook first asks a running copy to close gracefully
; (`--quit`), which brings the icons back.

; Language dialog (displayLanguageSelector): the stock MUI macro preselects Windows' own language,
; but English is the default here, whatever Windows speaks; a language stored by an earlier install
; is kept. Same steps as MUI's macro otherwise. This file is included after MUI2.nsh and before
; .onInit, where the template inserts the macro.
Var FeStoredLanguage
!macroundef MUI_LANGDLL_DISPLAY
!macro MUI_LANGDLL_DISPLAY
  StrCpy $LANGUAGE 1033
  ReadRegStr $FeStoredLanguage HKCU "${MANUPRODUCTKEY}" "Installer Language"
  StrCmp $FeStoredLanguage "" +2
    StrCpy $LANGUAGE $FeStoredLanguage
  IfSilent fe_langdll_done
  LangDLL::LangDialog "Installer Language" "Please select a language." AC ${MUI_LANGDLL_LANGUAGES_CP} ""
  Pop $LANGUAGE
  StrCmp $LANGUAGE "cancel" 0 +2
    Abort
  fe_langdll_done:
!macroend

; "Start with Windows" checkbox on the welcome page: this file is included before the template's
; pages, so these two defines go to its first page (the welcome page). After installing, the choice
; is handed to the app (`--start-with-windows on|off`, with the installer's language as
; `--language en|tr`), which stores it like Settings ▸ Behavior does and creates or removes the
; Startup shortcut. Skipped pages (silent / passive update) change nothing.
Var StartWithWindowsBox
Var StartWithWindows

!define MUI_PAGE_CUSTOMFUNCTION_SHOW StartWithWindowsShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE StartWithWindowsLeave

Function StartWithWindowsShow
  ; picked at run time: a LangString would need the languages, which come after this file
  ${If} $LANGUAGE == 1055
    StrCpy $0 "Bilgisayar açılınca Folder Explorer'ı da başlat"
  ${Else}
    StrCpy $0 "Start Folder Explorer when Windows starts"
  ${EndIf}
  ${NSD_CreateCheckbox} 120u 178u 195u 12u $0
  Pop $StartWithWindowsBox
  SetCtlColors $StartWithWindowsBox "" "FFFFFF" ; the welcome page's white (MUI_BGCOLOR is not defined yet here)
  ; checked when it already starts with Windows, or for someone who never ran the app
  ${If} ${FileExists} "$SMSTARTUP\Folder Explorer.lnk"
  ${OrIfNot} ${FileExists} "$APPDATA\Folder Explorer\state.json"
    ${NSD_Check} $StartWithWindowsBox
  ${EndIf}
FunctionEnd

Function StartWithWindowsLeave
  ${NSD_GetState} $StartWithWindowsBox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $StartWithWindows "on"
  ${Else}
    StrCpy $StartWithWindows "off"
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; Upgrading over a running copy.
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +2
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $StartWithWindows != ""
    ; the language picked for the installer becomes the app's
    ${If} $LANGUAGE == 1055
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --start-with-windows $StartWithWindows --language tr'
    ${Else}
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --start-with-windows $StartWithWindows --language en'
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +3
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --show-icons'
  ; An update (/UPDATE, as the app's updater runs it) keeps what the new version would recreate anyway.
  ${If} $UpdateMode <> 1
    ; "Start with Windows" shortcut made by the app (Startup folder).
    Delete "$SMSTARTUP\Folder Explorer.lnk"
    ; The New ▸ menu entry: remove exactly what was added.
    DeleteRegKey HKCU "Software\Classes\.fegroup"
    DeleteRegKey HKCU "Software\Classes\FolderExplorer.Group"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; "Uygulama verilerini sil" only clears the bundle-id folders (WebView2 data); the app keeps
  ; layout, settings, backups and media here (store.rs). Same guard as Tauri's: never on an update.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RmDir /r "$APPDATA\Folder Explorer"
  ${EndIf}
!macroend
