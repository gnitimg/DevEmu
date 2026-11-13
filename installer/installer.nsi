; DevEmu NSIS 安装器：
; - 首装展示目录选择页，用户可自选安装位置（默认 LocalAppData，无需管理员）
; - 应用内静默升级（/S）回读注册表里的既有安装目录，覆盖后自动重启应用
; - 卸载默认保留安装目录下的 .data 用户数据，询问后可选一并删除
!include MUI2.nsh
!include LogicLib.nsh

!define APP_NAME "DevEmu"
!define REG_ROOT HKCU
!define REG_KEY "Software\DevEmu"
!define UNREG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DevEmu"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
; NSIS 相对路径按 .nsi 脚本目录解析，引用仓库根 assets
Icon "..\assets\icon.ico"
UninstallIcon "..\assets\icon.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\DevEmu.exe"
!define MUI_FINISHPAGE_RUN_TEXT "安装完成后运行 DevEmu"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

; 首装默认落 LocalAppData；有既有安装时回读注册表目录（升级不换位置）
InstallDir "$LOCALAPPDATA\DevEmu"
InstallDirRegKey ${REG_ROOT} "${REG_KEY}" "InstallLocation"

; 固态压缩：安装包体积优先
SetCompressor /SOLID lzma

Section "Install"
  SetOutPath $INSTDIR
  ; 静默升级时旧实例在安装器启动 1.5s 后退出，先等它退出再覆盖文件
  ${If} ${Silent}
    Sleep 2000
  ${EndIf}
  File /r "${PKG_DIR}\*.*"

  CreateDirectory "$SMPROGRAMS\DevEmu"
  CreateShortCut "$SMPROGRAMS\DevEmu\DevEmu.lnk" "$INSTDIR\DevEmu.exe"
  CreateShortCut "$DESKTOP\DevEmu.lnk" "$INSTDIR\DevEmu.exe"

  WriteRegStr ${REG_ROOT} "${REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr ${REG_ROOT} "${UNREG_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr ${REG_ROOT} "${UNREG_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr ${REG_ROOT} "${UNREG_KEY}" "DisplayIcon" "$INSTDIR\DevEmu.exe"
  WriteRegStr ${REG_ROOT} "${UNREG_KEY}" "Publisher" "gnitimg"
  WriteRegStr ${REG_ROOT} "${UNREG_KEY}" "UninstallString" '"$INSTDIR\Uninstall DevEmu.exe"'
  WriteRegDWORD ${REG_ROOT} "${UNREG_KEY}" "NoModify" 1
  WriteRegDWORD ${REG_ROOT} "${UNREG_KEY}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall DevEmu.exe"

  ; 静默升级完成后自动重启应用，对齐此前 Squirrel 的更新后自启行为
  ${If} ${Silent}
    Exec '"$INSTDIR\DevEmu.exe"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除虚拟机与全部数据（安装目录下的 .data）？$\n$\n选“否”仅卸载应用并保留数据。" IDYES wipe IDNO keep
wipe:
  RMDir /r "$INSTDIR"
  Goto cleaned
keep:
  ; 逐项删除应用文件，保留 .data
  FindFirst $0 $1 "$INSTDIR\*"
scan:
  StrCmp $1 "" scanDone
  StrCmp $1 "." scanNext
  StrCmp $1 ".." scanNext
  StrCmp $1 ".data" scanNext
  RMDir /r "$INSTDIR\$1"
  Delete "$INSTDIR\$1"
scanNext:
  FindNext $0 $1
  Goto scan
scanDone:
  FindClose $0
  RMDir "$INSTDIR"
cleaned:
  Delete "$DESKTOP\DevEmu.lnk"
  Delete "$SMPROGRAMS\DevEmu\DevEmu.lnk"
  RMDir "$SMPROGRAMS\DevEmu"
  DeleteRegKey ${REG_ROOT} "${UNREG_KEY}"
  DeleteRegKey ${REG_ROOT} "${REG_KEY}"
SectionEnd
