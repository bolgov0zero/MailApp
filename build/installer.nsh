; Custom NSIS logic for MailApp: optional "update service".
;
; The "service" is implemented as a Windows Scheduled Task ("MailAppUpdater")
; that runs `MailApp.exe --run-update` as SYSTEM. Because it runs as SYSTEM it
; can install updates into Program Files WITHOUT a UAC prompt. The installer
; itself is already elevated (perMachine), so registering the task adds no extra
; dialog.
;
; - Clean install: a checkbox lets the user choose whether to install it.
;   (Custom pages are skipped automatically during silent/auto-update installs.)
; - Update: if the task already exists, it is refreshed automatically.

!include nsDialogs.nsh
!include LogicLib.nsh

Var InstallServiceCheckbox
Var InstallServiceState   ; "1" = install the update service

!macro customPageAfterChangeDir
  Page custom mailappServicePage mailappServicePageLeave
!macroend

Function mailappServicePage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 40u "Служба обновления позволяет управлять обновлениями MailApp централизованно и устанавливать их без запроса прав администратора."
  Pop $0
  ${NSD_CreateCheckbox} 0 48u 100% 12u "Установить службу обновления"
  Pop $InstallServiceCheckbox
  ${NSD_SetState} $InstallServiceCheckbox ${BST_CHECKED}
  nsDialogs::Show
FunctionEnd

Function mailappServicePageLeave
  ${NSD_GetState} $InstallServiceCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $InstallServiceState "1"
  ${Else}
    StrCpy $InstallServiceState "0"
  ${EndIf}
FunctionEnd

!macro registerUpdateTask
  ; /rl HIGHEST + /ru SYSTEM => runs elevated as SYSTEM, no UAC at update time.
  nsExec::Exec 'schtasks /create /tn "MailAppUpdater" /tr "\"$INSTDIR\MailApp.exe\" --run-update" /sc ONCE /st 00:00 /ru SYSTEM /rl HIGHEST /f'
!macroend

!macro customInstall
  ; Refresh the task if it already exists (update scenario), otherwise create it
  ; only when the user ticked the checkbox on a clean install.
  nsExec::Exec 'schtasks /query /tn "MailAppUpdater"'
  Pop $0
  ${If} $0 == 0
    !insertmacro registerUpdateTask
  ${ElseIf} $InstallServiceState == "1"
    !insertmacro registerUpdateTask
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::Exec 'schtasks /delete /tn "MailAppUpdater" /f'
!macroend
