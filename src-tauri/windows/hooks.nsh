; Icon Sheet Studio - NSIS Installer Hooks
; Ensures that lingering background processes (Next.js node.exe server and main app)
; are cleanly terminated before files are overwritten during installation or update.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing any running instances of Icon Sheet Studio..."
  nsExec::Exec 'taskkill /F /IM "icon-sheet-studio.exe"'
  nsExec::Exec 'taskkill /F /IM "node.exe"'
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing any running instances before uninstallation..."
  nsExec::Exec 'taskkill /F /IM "icon-sheet-studio.exe"'
  nsExec::Exec 'taskkill /F /IM "node.exe"'
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
