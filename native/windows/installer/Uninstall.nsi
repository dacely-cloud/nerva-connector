; SPDX-FileCopyrightText: 2026 Dacely <business@dacely.com>
; SPDX-License-Identifier: LicenseRef-Proprietary

Unicode true
Name "Nerva Connector"
OutFile "${CONTAINER}"
RequestExecutionLevel user
SetCompressor zlib
CRCCheck force
Icon "${ICON}"
UninstallIcon "${ICON}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Nerva Connector"
VIAddVersionKey /LANG=1033 "FileDescription" "Nerva Connector Uninstaller"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Dacely"

!include "LogicLib.nsh"
!uninstfinalize "${FINALIZE}" = 0

UninstPage uninstConfirm
UninstPage instfiles
UninstallText "Remove Nerva Connector's program files and shortcuts. Your account link and settings are kept. To unlink this computer, open Nerva Connector and run /logout before uninstalling."

Section
    WriteUninstaller "$INSTDIR\Uninstall Nerva Connector.exe"
SectionEnd

Function un.onInit
    SetShellVarContext current
    SetRegView 64
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NervaConnector" "InstallLocation"
    ${If} $0 != $INSTDIR
        MessageBox MB_OK|MB_ICONSTOP "This uninstaller is not in the registered Nerva Connector folder. Use Settings, Apps to remove the current installation." /SD IDOK
        SetErrorLevel 1
        Abort
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
    IntOp $1 $0 & 0x400
    ${If} $0 == -1
    ${OrIf} $1 != 0
        MessageBox MB_OK|MB_ICONSTOP "The installation folder is unavailable or has been replaced by a link." /SD IDOK
        SetErrorLevel 1
        Abort
    ${EndIf}
FunctionEnd

Function un.StopConnector
    System::Call 'kernel32::OpenEventW(i 2, i 0, w "Local\NervaConnector.Quit") p.r0'
    ${If} $0 != 0
        System::Call 'kernel32::SetEvent(p r0)'
        System::Call 'kernel32::CloseHandle(p r0)'
    ${EndIf}
    System::Call 'kernel32::OpenMutexW(i 0x100001, i 0, w "Local\NervaConnector.Supervisor") p.r0 ?e'
    Pop $1
    ${If} $0 == 0
        ${If} $1 == 2
            Return
        ${EndIf}
        Goto failed
    ${EndIf}
    System::Call 'kernel32::WaitForSingleObject(p r0, i 30000) i.r1'
    ${If} $1 == 0
    ${OrIf} $1 == 128
        System::Call 'kernel32::ReleaseMutex(p r0)'
        System::Call 'kernel32::CloseHandle(p r0)'
        Return
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
failed:
    MessageBox MB_OK|MB_ICONSTOP "Nerva Connector is still running. Quit it from the notification area and try again." /SD IDOK
    SetErrorLevel 1
    Abort
FunctionEnd

Section "Uninstall"
    Call un.StopConnector
    ClearErrors
    !include "${FILES}"
    Delete "$INSTDIR\.nerva-connector-installation"
    IfErrors failed
    Delete "$INSTDIR\Uninstall Nerva Connector.exe"
    IfErrors failed
    Delete "$SMPROGRAMS\Nerva Connector.lnk"
    Delete "$DESKTOP\Nerva Connector.lnk"
    Delete "$SMSTARTUP\Nerva Connector.lnk"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Nerva Connector"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NervaConnector"
    RMDir "$INSTDIR"
    SetErrorLevel 0
    Goto done
failed:
    MessageBox MB_OK|MB_ICONSTOP "Some program files could not be removed. Close Nerva Connector and check that this folder is writable, then try again." /SD IDOK
    SetErrorLevel 1
done:
SectionEnd
