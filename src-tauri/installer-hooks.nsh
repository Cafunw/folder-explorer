; Folder Explorer — NSIS installer hooks (see tauri.conf.json > bundle.windows.nsis.installerHooks)
;
; Core rule (docs/ARCHITECTURE.md): the installer, like the app, does not touch Windows' desktop,
; Explorer or the registry beyond the installer's own uninstall entry. The one shell entry the app
; writes itself (Yeni ▸ Folder Explorer grubu, setting "behavior.newMenuEntry") is removed on uninstall.
;
; The app hides the Windows desktop icons while it runs. If an installer simply killed it,
; the icons could stay hidden, so every hook first asks a running copy to close gracefully
; (`--quit`), which brings the icons back.

; "Start with Windows" checkbox on the welcome page: this file is included before the template's
; pages, so these two defines go to its first page (the welcome page). After installing, the choice
; is handed to the app (`--start-with-windows on|off`), which stores it like Ayarlar ▸ Davranış does
; and creates or removes the Startup shortcut. Skipped pages (silent / passive update) change nothing.
Var StartWithWindowsBox
Var StartWithWindows

!define MUI_PAGE_CUSTOMFUNCTION_SHOW StartWithWindowsShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE StartWithWindowsLeave

Function StartWithWindowsShow
  ${NSD_CreateCheckbox} 120u 178u 195u 12u "Bilgisayar açılınca Folder Explorer'ı da başlat"
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
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --start-with-windows $StartWithWindows'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +3
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --show-icons'
  ; "Start with Windows" shortcut made by the app (Startup folder).
  Delete "$SMSTARTUP\Folder Explorer.lnk"
  ; Run value of older versions and the Yeni ▸ menu entry: remove exactly what was added.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  DeleteRegKey HKCU "Software\Classes\.fegroup"
  DeleteRegKey HKCU "Software\Classes\FolderExplorer.Group"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; "Uygulama verilerini sil" only clears the bundle-id folders (WebView2 data); the app keeps
  ; layout, settings, backups and media here (store.rs). Same guard as Tauri's: never on an update.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RmDir /r "$APPDATA\Folder Explorer"
  ${EndIf}
!macroend
