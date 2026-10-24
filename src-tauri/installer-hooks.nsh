; Folder Explorer — NSIS installer hooks (see tauri.conf.json > bundle.windows.nsis.installerHooks)
;
; Core rule (docs/ARCHITECTURE.md): the installer, like the app, does not touch Windows' desktop,
; Explorer or the registry beyond the installer's own uninstall entry. The one shell entry the app
; writes itself (Yeni ▸ Folder Explorer grubu, setting "behavior.newMenuEntry") is removed on uninstall.
;
; The app hides the Windows desktop icons while it runs. If an installer simply killed it,
; the icons could stay hidden, so every hook first asks a running copy to close gracefully
; (`--quit`), which brings the icons back.

!macro NSIS_HOOK_PREINSTALL
  ; Upgrading over a running copy.
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 +2
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
!macroend

!macro NSIS_HOOK_POSTINSTALL
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
!macroend
