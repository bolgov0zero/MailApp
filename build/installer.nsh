; Custom NSIS logic for MailApp: optional "update service".
;
; The update service is a real Windows service (LocalSystem) registered via the
; bundled WinSW wrapper (resources\service\MailAppService.exe + .xml). It runs
; MailApp.exe in Node mode (update-service.js), stays resident, and watches a
; flag file the unprivileged client drops to request an update. Being SYSTEM it
; installs into Program Files WITHOUT a UAC prompt, and the client needs no
; permission to "start" anything — it just writes the flag.
;
; - Interactive clean install: a Yes/No prompt offers to install the service.
; - Update / silent: refreshed if already present (silent defaults to Yes).

!define SVC_EXE "$INSTDIR\resources\service\MailAppService.exe"

!macro installService
  ; Remove the legacy scheduled task from older versions, if present.
  nsExec::Exec 'schtasks /delete /tn "MailAppUpdater" /f'
  ; (Re)install the service. stop/uninstall first so paths refresh cleanly.
  nsExec::Exec '"${SVC_EXE}" stop'
  nsExec::Exec '"${SVC_EXE}" uninstall'
  nsExec::Exec '"${SVC_EXE}" install'
  nsExec::Exec '"${SVC_EXE}" start'
!macroend

!macro customInstall
  ; If the service already exists (update), refresh it; otherwise ask on a clean
  ; interactive install (silent installs default to Yes so the service persists).
  nsExec::Exec 'sc query MailAppUpdater'
  Pop $0
  ${If} $0 == 0
    !insertmacro installService
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION "Установить службу обновления MailApp?$\n$\nОна позволяет обновлять приложение без запроса прав администратора." /SD IDYES IDYES mailapp_install_svc IDNO mailapp_skip_svc
    mailapp_install_svc:
      !insertmacro installService
      Goto mailapp_svc_done
    mailapp_skip_svc:
    mailapp_svc_done:
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::Exec '"${SVC_EXE}" stop'
  nsExec::Exec '"${SVC_EXE}" uninstall'
  nsExec::Exec 'schtasks /delete /tn "MailAppUpdater" /f'
!macroend
