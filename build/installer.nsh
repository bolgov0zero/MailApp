; Custom NSIS logic for MailApp: optional "update service".
;
; The "service" is implemented as a Windows Scheduled Task ("MailAppUpdater")
; that runs `MailApp.exe --run-update` as SYSTEM. Because it runs as SYSTEM it
; can install updates into Program Files WITHOUT a UAC prompt. The installer is
; already elevated (perMachine), so registering the task adds no extra dialog.
;
; - Interactive clean install: a Yes/No prompt offers to install the service.
; - Update: if the task already exists, it is refreshed automatically.
; - Silent install (auto-update): the service is only refreshed if already
;   present; it is never added without the user's choice (/SD IDNO).

!macro registerUpdateTask
  ; Runs every minute as SYSTEM (/ru SYSTEM /rl HIGHEST). The runner does nothing
  ; unless a flag file is present, so a standard user cannot (and need not) call
  ; "schtasks /run" — it just drops the flag and the SYSTEM task picks it up.
  ; This avoids both the UAC prompt and the "access denied" on /run.
  nsExec::Exec 'schtasks /create /tn "MailAppUpdater" /tr "\"$INSTDIR\MailApp.exe\" --run-update" /sc MINUTE /mo 1 /ru SYSTEM /rl HIGHEST /f'
!macroend

!macro customInstall
  nsExec::Exec 'schtasks /query /tn "MailAppUpdater"'
  Pop $0
  ${If} $0 == 0
    ; Task already present (update) — refresh its command/path.
    !insertmacro registerUpdateTask
  ${Else}
    ; /SD IDYES: silent installs (auto-updates) also create the task, so a
    ; machine that updated silently still ends up with the SYSTEM updater and
    ; future updates need no UAC. Interactive installs still show the choice.
    MessageBox MB_YESNO|MB_ICONQUESTION "Установить службу обновления MailApp?$\n$\nОна позволяет обновлять приложение без запроса прав администратора." /SD IDYES IDYES mailapp_install_svc IDNO mailapp_skip_svc
    mailapp_install_svc:
      !insertmacro registerUpdateTask
      Goto mailapp_svc_done
    mailapp_skip_svc:
    mailapp_svc_done:
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::Exec 'schtasks /delete /tn "MailAppUpdater" /f'
!macroend
