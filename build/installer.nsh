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
  ; Silent install = server/service-driven app update → never touch the service.
  IfSilent mailapp_ci_end
    nsExec::Exec 'sc query MailAppUpdater'
    Pop $0
    StrCmp $0 "0" mailapp_ci_do 0
    MessageBox MB_YESNO|MB_ICONQUESTION "Установить службу обновления MailApp?$\n$\nОна позволяет обновлять приложение без запроса прав администратора." IDNO mailapp_ci_end
    mailapp_ci_do:
      !insertmacro installService
  mailapp_ci_end:
!macroend

!macro customUnInstall
  ; During an update electron-builder runs the OLD uninstaller silently first.
  ; We must NOT remove the service then (it is what runs the installer!). Only
  ; tear it down on a real, interactive uninstall.
  IfSilent mailapp_cu_end
    nsExec::Exec 'sc stop MailAppUpdater'
    nsExec::Exec '"${SVC_DIR}\MailAppService.exe" uninstall'
    nsExec::Exec 'sc delete MailAppUpdater'
    nsExec::Exec 'schtasks /delete /tn "MailAppApply" /f'
    nsExec::Exec 'schtasks /delete /tn "MailAppLaunch" /f'
    RMDir /r "${SVC_DIR}"
  mailapp_cu_end:
!macroend
