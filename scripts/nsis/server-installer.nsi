; 班级小助手服务端 + Web 管理端 Windows 安装程序
; 由 scripts/dist-server.mjs 生成（占位符在打包时替换）
;
; 设计要点：
; - 当前用户级安装（$LOCALAPPDATA\Programs），无需管理员权限即可完成安装
; - 内置 Node 运行时，目标机无需安装 Node.js
; - 快捷方式：启动/停止/重启服务、打开管理端、卸载
; - 默认加入当前用户开机自启（注册表 HKCU\...\Run），随时可用
; - 卸载时保留 data 目录（数据库）以避免误删数据

Unicode true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT "@PRODUCT@"
!define VERSION "@VERSION@"
!define STAGING "@STAGING@"
!define OUT_FILE "@OUTFILE@"
!define ICON_FILE "@ICON@"
!define APP_PORT "@PORT@"

Name "${PRODUCT} ${VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\ClassHelperServer"
InstallDirRegKey HKCU "Software\ClassHelperServer" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "班级小助手服务端已安装完成。$\r$\n$\r$\n安装程序已将服务加入当前用户的开机自启项，浏览器打开 http://127.0.0.1:${APP_PORT}/ 即可使用管理端。$\r$\n$\r$\n默认账号：admin / admin123（首次登录后请立即修改密码）"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "立即启动服务并打开管理端"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchService
!define MUI_LICENSEPAGE_TEXT_TOP "请阅读以下说明后继续安装。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGING}\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Function LaunchService
  ExecShell "open" "$INSTDIR\start.cmd" "" SW_SHOWMINIMIZED
  Sleep 3000
  ExecShell "open" "http://127.0.0.1:${APP_PORT}/"
FunctionEnd

; ------------------------------------------------------------------ 安装

Section "主程序" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; 若目标目录已有旧版本，先停止正在运行的服务，避免文件占用
  IfFileExists "$INSTDIR\data\server.pid" 0 +3
    nsExec::ExecToLog '"$INSTDIR\stop.cmd"'
    Sleep 1500

  ; 升级安装时保留原有配置（含 JWT 密钥与端口设置），避免用户被强制重新登录
  IfFileExists "$INSTDIR\.env" 0 +2
    Rename "$INSTDIR\.env" "$INSTDIR\.env.previous"

  File /r "${STAGING}\*.*"

  IfFileExists "$INSTDIR\.env.previous" 0 +3
    Delete "$INSTDIR\.env"
    Rename "$INSTDIR\.env.previous" "$INSTDIR\.env"

  WriteRegStr HKCU "Software\ClassHelperServer" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\ClassHelperServer" "Version" "${VERSION}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 开始菜单
  CreateDirectory "$SMPROGRAMS\${PRODUCT}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\启动服务.lnk" "$INSTDIR\start.cmd" "" "$INSTDIR\node.exe" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\停止服务.lnk" "$INSTDIR\stop.cmd" "" "$INSTDIR\node.exe" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\重启服务.lnk" "$INSTDIR\restart.cmd" "" "$INSTDIR\node.exe" 0 SW_SHOWMINIMIZED
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\打开管理端.lnk" "http://127.0.0.1:${APP_PORT}/"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\使用说明.lnk" "$INSTDIR\README.txt"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\卸载.lnk" "$INSTDIR\uninstall.exe"

  ; 桌面快捷方式（管理端进浏览器）
  CreateShortCut "$DESKTOP\${PRODUCT}.lnk" "http://127.0.0.1:${APP_PORT}/"

  ; 开机自启（当前用户）
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ClassHelperServer" '"$INSTDIR\start.cmd"'

  ; 注册到"应用和功能"列表，便于通过系统设置卸载
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassHelperServer" "DisplayName" "${PRODUCT} ${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassHelperServer" "DisplayIcon" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassHelperServer" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassHelperServer" "Publisher" "Class Helper"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassHelperServer" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassHelperServer" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassHelperServer" "EstimatedSize" "$0"

  ; 首次启动即初始化数据库并开始提供服务
  ExecShell "open" "$INSTDIR\start.cmd" "" SW_SHOWMINIMIZED
SectionEnd

; ------------------------------------------------------------------ 卸载

Section "Uninstall"
  ; 停止服务
  IfFileExists "$INSTDIR\data\server.pid" 0 +3
    nsExec::ExecToLog '"$INSTDIR\stop.cmd"'
    Sleep 1200

  ; 兜底：按命令行特征结束残留进程
  nsExec::ExecToLog 'taskkill /F /FI "WINDOWTITLE eq ClassHelperServer*"'

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ClassHelperServer"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClassHelperServer"
  DeleteRegKey HKCU "Software\ClassHelperServer"

  Delete "$DESKTOP\${PRODUCT}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT}"

  ; 保留数据目录，避免误删数据库：重命名为 data.backup
  IfFileExists "$INSTDIR\data\classhelper.db" 0 +3
    RMDir /r "$INSTDIR\data.backup"
    Rename "$INSTDIR\data" "$INSTDIR\data.backup"

  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\web"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\logs"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\start.cmd"
  Delete "$INSTDIR\stop.cmd"
  Delete "$INSTDIR\restart.cmd"
  Delete "$INSTDIR\status.cmd"
  Delete "$INSTDIR\install-service.cmd"
  Delete "$INSTDIR\uninstall-service.cmd"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\uninstall.exe"

  ; 若用户未保留 .env，则一并清理目录
  Delete "$INSTDIR\.env"
  RMDir "$INSTDIR"
SectionEnd
