; Uninstall hook: offer to remove the Claude Office hooks from Claude Code's
; settings. Skipped during auto-updates (electron-builder runs the previous
; uninstaller silently on every update; hooks must survive that).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Also remove the Claude Office hooks from your Claude Code settings?$\r$\n$\r$\n(Hooks inside WSL distributions are removed with Disconnect in the app.)" /SD IDYES IDNO skip_hooks
      nsExec::Exec '"$INSTDIR\resources\hook\claude-office-hook.exe" uninstall'
    skip_hooks:
  ${endIf}
!macroend
