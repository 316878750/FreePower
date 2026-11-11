; FreePower 的 NSIS 钩子（electron-builder `nsis.include`）。
;
; 解决的问题：卸载器找不到自己的安装目录。
;
; electron-builder 生成的卸载器在 un.onInit 里按下面的顺序决定 $INSTDIR：
;   1) HKCU\Software\<APP_GUID> 的 InstallLocation
;   2) 默认目录 $LOCALAPPDATA\Programs\FreePower
;   3) /D= 参数
; 而卸载器运行时会把自己拷到 %TEMP%\~nsu.tmp\Un_A.exe 再执行（实测 $EXEDIR 是临时目录、
; 命令行只有 /S，不带原路径），所以一旦 InstallLocation 键丢了——清理软件删键、
; 手工删键、或安装时注册表写入被系统拒绝——它就去删默认目录，
; 表现为「退出码 0、一个文件都没删」，用户完全看不出失败。
;
; 做法：安装时把 $INSTDIR 另存一份到 %APPDATA%\FreePower\install-dir.ini；
; 卸载时注册表读不到就用这份标记，并且必须确认该目录里确实有 FreePower.exe 才认。
; 用 INI 而不是纯文本，是为了让取值不依赖换行符处理。
; 不碰 %APPDATA%\FreePower\data（那是 app 自己的数据目录）。

!macro customInstall
  CreateDirectory "$APPDATA\FreePower"
  WriteINIStr "$APPDATA\FreePower\install-dir.ini" "install" "dir" "$INSTDIR"
!macroend

!macro customUnInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" 0 fpUnDone
  ReadINIStr $1 "$APPDATA\FreePower\install-dir.ini" "install" "dir"
  StrCmp $1 "" fpUnDone
  IfFileExists "$1\${APP_EXECUTABLE_FILENAME}" 0 fpUnDone
    StrCpy $INSTDIR "$1"
  fpUnDone:
!macroend

; ---------------------------------------------------------------------------
; 卸载收尾：RMDir /r $INSTDIR 在两种情况下会「文件删了、目录还在」——
;   ① 安装路径含空格（本例实测）；
;   ② 有句柄还压在目录上（内核/资源管理器没完全放手）。
; 只在 un.onUninstSuccess 里补一次**非递归** RMDir：
; 目录非空就一定失败，所以这条永远不会误删文件，只收掉空壳。
; ---------------------------------------------------------------------------
Var fpUnDir

!macro customUnInstall
  ; 这一步在主流程 RMDir /r 之前插入，先把目标目录记下来
  StrCpy $fpUnDir "$INSTDIR"
!macroend

Function un.onUninstSuccess
  StrCmp $fpUnDir "" 0 fpUnRmdir
  ; customUnInit 没跑起来（极端情况）时退回 INI 里记的目录
  ReadINIStr $fpUnDir "$APPDATA\FreePower\install-dir.ini" "install" "dir"
  fpUnRmdir:
  StrCmp $fpUnDir "" fpUnEnd
  RMDir "$fpUnDir"
  fpUnEnd:
FunctionEnd