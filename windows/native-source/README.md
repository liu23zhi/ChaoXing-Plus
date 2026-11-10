# 原生宿主

内部资料，模块分组、注入通道与启动器差异见内部文档。

## 构建与只读检查

```bash
npm run build:windows -- --release
npm run build:native
```

## 自毁兜底

自毁兜底由 [purge.c](purge.c) 提供，单文件与多文件共用：关机/注销（含强制结束会话）在隐藏顶层窗口的 `WM_QUERYENDSESSION`/`WM_ENDSESSION` 里同步收尾；删除前先把清单写进 `%TEMP%` 的续删脚本并登记 `HKCU` RunOnce，删净后自行撤销；同时尽力登记 `MOVEFILE_DELAY_UNTIL_REBOOT` 以覆盖断电与强制结束进程。

`purge-tests.exe` 有两套入口。直接运行为单元套件，续删登记重定向到测试专用子键，不写真实自启动项。设置环境变量后进入分阶段驱动，供 [scripts/vm/run-shutdown-destruct.ps1](../../scripts/vm/run-shutdown-destruct.ps1) 在一次性虚拟机里验证生产登记链路（**刻意不重定向**，会真的写 `HKCU` RunOnce）：

```powershell
$env:CX_PURGE_TEST_TARGET = '<待删文件绝对路径>'
$env:CX_PURGE_TEST_STAGE  = 'shutdown'   # 建目标 + 登记真实 RunOnce + 扣留，不删除
$env:CX_PURGE_TEST_STAGE  = 'resume'     # 断言目标已删、RunOnce 登记已撤销
```

`purge-tests.exe` 与宿主同源编译为 GUI 子系统，PowerShell 里必须用 `Start-Process -Wait -PassThru` 取退出码，`& $exe` 不会等待也拿不到 `$LASTEXITCODE`。
