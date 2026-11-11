; FreePower 的 NSIS 钩子（electron-builder `nsis.include`）。
;
; 解决的问题：卸载器找不到自己的安装目录。
;
; electron-builder 生成的卸载器在 un.onInit 里按下面的顺序决定 $INSTDIR：
;   1) HKCU\Software\<APP_GUID> 的 InstallLocation
;   2) 默认目录 $LOCALAPPDATA\Programs\FreePower
;   3) /D= 参数
; 而卸载器运行时会把自己拷到 %TEMP%\~nsu.tmp\Un_A.exe 再执行（实测 $EXEDIR 是
; 那个临时目录、命令行只有 /S，不带原路径），所以一旦 InstallLocation 键丢了
; ——清理软件删键、手工删键、或安装时注册表写入被系统拒绝——它就去删默认目录，
; 表现为「退出码 0、一个文件都没删」，用户完全看不出失败。
; 实测本包：装到自定义路径后注册表 9 个值里**没有 InstallLocation**，
; 所以下面这条兜底不是预防性代码，是每次卸载都要走的必经路径。
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
; 卸载后留下空目录的根因：卸载器的当前目录压在 $INSTDIR 上。
;
; electron-builder 的 un.onInit 第一句就是 SetOutPath $INSTDIR，而 Windows 不允许
; 删除任何进程的当前目录。所以主流程那条 `RMDir /r $INSTDIR` 会把文件删干净、
; 目录本身删不掉，表现就是「卸载成功、目录还在、里面是空的」。
;
; 实测否掉的两条路，别再走一遍：
;   · 在 un.onUninstSuccess 里补一次非递归 RMDir —— 这个回调在本包卸载器里
;     **一次都没被调用**（函数里写了日志文件，全程没有该文件）。卸载器打印的
;     证据只到 customUnInstall 这一层。
;   · 指望卸载器自己被删掉来腾空目录 —— 它运行时已经把自己拷到
;     %TEMP%\~nsu.tmp，$EXEDIR 不在 $INSTDIR 里，本来就不占这个目录。
;
; 做法：在主流程 RMDir /r 之前（customUnInstall 就是插在这个位置）把当前目录
; 挪到 $TEMP%，让后面那条 RMDir /r 连目录一起删掉。
; ---------------------------------------------------------------------------
!macro customUnInstall
  SetOutPath "$TEMP"
!macroend
