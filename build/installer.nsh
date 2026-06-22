; Custom NSIS logic for MailApp: independent "update service".
;
; The service is hosted by WinSW but RUNS powershell.exe (System32) with
; update-service.ps1, and all service files live in C:\ProgramData\MailApp\
; service — OUTSIDE the app folder. So an app update never locks the service:
; it keeps running and orchestrates the install without restarting itself.
;
; - Interactive (manual exe) install: (re)install/refresh the service.
; - Silent install (server/service-driven app update, run with /S): DO NOT touch
;   the service at all — only the app files are replaced.

!define SVC_DIR "C:\ProgramData\MailApp\service"

!macro installService
  ; Drop any previous registration (old in-app-dir service or current) + legacy task.
  nsExec::Exec 'sc stop MailAppUpdater'
  nsExec::Exec 'sc delete MailAppUpdater'
  nsExec::Exec 'schtasks /delete /tn "MailAppUpdater" /f'
  ; Copy service files to the stable ProgramData location.
  CreateDirectory "${SVC_DIR}"
  CopyFiles /SILENT "$INSTDIR\resources\service\MailAppService.exe" "${SVC_DIR}\MailAppService.exe"
  CopyFiles /SILENT "$INSTDIR\resources\service\MailAppService.xml" "${SVC_DIR}\MailAppService.xml"
  CopyFiles /SILENT "$INSTDIR\resources\service\update-service.ps1" "${SVC_DIR}\update-service.ps1"
  ; Record the app exe path so the service can read the version / relaunch it.
  FileOpen $9 "${SVC_DIR}\app.txt" w
  FileWrite $9 "$INSTDIR\MailApp.exe"
  FileClose $9
  ; Register + start.
  nsExec::Exec '"${SVC_DIR}\MailAppService.exe" install'
  nsExec::Exec '"${SVC_DIR}\MailAppService.exe" start'
!macroend

!macro customInstall
  nsExec::Exec 'schtasks /delete /tn "MailAppUpdater" /f'   ; remove legacy scheduled task
  ${IfNot} ${Silent}
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
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::Exec 'sc stop MailAppUpdater'
  nsExec::Exec '"${SVC_DIR}\MailAppService.exe" uninstall'
  nsExec::Exec 'sc delete MailAppUpdater'
  nsExec::Exec 'schtasks /delete /tn "MailAppApply" /f'
  nsExec::Exec 'schtasks /delete /tn "MailAppLaunch" /f'
  RMDir /r "${SVC_DIR}"
!macroend
