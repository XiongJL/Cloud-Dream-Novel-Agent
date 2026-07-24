!ifdef BUILD_UNINSTALLER
  !include "LogicLib.nsh"
  !include "nsDialogs.nsh"
  !include "MUI2.nsh"

  Var unDeleteUserDataRequested
  Var unDeleteUserDataCheckbox

  !macro customUnWelcomePage
    UninstPage custom un.UninstallOptionsPageCreate un.UninstallOptionsPageLeave
  !macroend

  Function un.UninstallOptionsPageCreate
    StrCpy $unDeleteUserDataRequested "0"

    !insertmacro MUI_HEADER_TEXT "卸载云梦小说智能体" "选择卸载方式"

    nsDialogs::Create 1018
    Pop $0

    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "安装向导将从此电脑卸载云梦小说智能体。"
    Pop $0

    ${NSD_CreateLabel} 0 28u 100% 34u "如勾选下方选项，还会删除本机数据库、AI 配置、备份和图片资源。此操作不可恢复。"
    Pop $0

    ${NSD_CreateCheckbox} 0 70u 100% 12u "同时删除本机用户数据"
    Pop $unDeleteUserDataCheckbox
    ${NSD_Uncheck} $unDeleteUserDataCheckbox

    nsDialogs::Show
  FunctionEnd

  Function un.UninstallOptionsPageLeave
    StrCpy $unDeleteUserDataRequested "0"
    ${NSD_GetState} $unDeleteUserDataCheckbox $0

    ${If} $0 == 1
      StrCpy $unDeleteUserDataRequested "1"
    ${EndIf}
  FunctionEnd

  !macro customUnInstall
    ${If} $unDeleteUserDataRequested == "1"
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}

      RMDir /r "$APPDATA\${APP_FILENAME}"
      !ifdef APP_PRODUCT_FILENAME
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
      !endif
      !ifdef APP_PACKAGE_NAME
        RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
      !endif

      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    ${EndIf}
  !macroend
!endif
