# 原生宿主导航

本目录存放 Windows 原生宿主、C 测试、MSVC 编译脚本及原生构建/启动入口。运行时为 x86 Win32、无 CRT；单文件 GUI 内嵌资源，多文件 GUI 使用同目录外置资源。Windows 总目录说明见 [共享目录导航](../share-file/README.md)，配置与验收范围见 [Windows 使用文档](../../docs/windows.md)。

## 模块分组

| 分组 | 文件 |
| --- | --- |
| 主流程与参数 | [host.c](host.c)、[options.c](options.c)、[options.h](options.h) |
| 会话与注入 | [host-session.inc](host-session.inc)、[session.c](session.c)、[session.h](session.h)、[net.c](net.c)、[net.h](net.h) |
| 资源与平台基础 | [assets.c](assets.c)、[assets.h](assets.h)、[assets.rc.in](assets.rc.in)、[resource.h](resource.h)、[memory.c](memory.c)、[host.manifest](host.manifest) |
| 配置与自检 | [host-config.inc](host-config.inc)、[config-store.c](config-store.c)、[config-store.h](config-store.h)、[json.c](json.c)、[json.h](json.h)、[host-self-check.inc](host-self-check.inc) |
| 客户端扫描与选择 | [discovery.c](discovery.c)、[discovery.h](discovery.h)、[discovery-cache.inc](discovery-cache.inc)、[selection.c](selection.c)、[selection.h](selection.h) |
| 进程、提权与 DPI | [process.c](process.c)、[process.h](process.h)、[elevation.c](elevation.c)、[elevation.h](elevation.h)、[dpi.c](dpi.c)、[dpi.h](dpi.h) |
| 审计与诊断 | [audit.c](audit.c)、[audit.h](audit.h)、[diagnostics.c](diagnostics.c)、[diagnostics.h](diagnostics.h) |
| 静默生命周期 | [silent.c](silent.c)、[silent.h](silent.h)、[purge.c](purge.c)、[purge.h](purge.h) |
| 测试与驱动 | [tests/](tests/)、[discovery-testdriver.c](discovery-testdriver.c) |

## 构建与只读检查

从仓库根执行。构建需要 Node.js 22+、MSVC x86 工具链与 Windows SDK；生成后的原生 EXE 运行时不依赖 Node 或 PowerShell。

```powershell
npm run build:windows -- --release
npm run build:native
```

[build-windows.ps1](build-windows.ps1) 只负责编译。`BuildConsole` 默认 `true`，生成内嵌资源 GUI `release/single-file/chaoxing_plus.exe`，以及 `release/multi-file/` 下的外置资源 GUI `chaoxing_plus.exe`、Console helper `chaoxing_plus.com` 和普通临时释放包 `package-to-single/chaoxing_plus.exe`；`-BuildConsole:$false` 仅生成单文件 GUI。`-BuildTests` 同时生成 C 测试，`bin/` 保留宿主与调试/测试 EXE，多文件编译输入位于 `bin/multi-file/`。共享 [app-icon.ico](../share-file/assets/app-icon.ico) 仍内嵌到各程序。单文件以 RCDATA 保存四项页面资源和 winmm 代理；多文件不含这些 RCDATA，只按 EXE 目录加载 `assets/windows-bootstrap.js`、`assets/chaoxing-plus.windows.js`、`assets/trampoline.js`、`assets/vendor/sweetalert2.min.css` 与根目录 `winmm-proxy.dll`，首次校验/加载后缓存到内存，缺失或为空明确失败，不回退工作目录、源码或其他构建目录。

显式 `.exe` 在 PowerShell 中不保证等待；多文件命令行可使用扩展省略的 `chaoxing_plus`（默认 `.com`）或显式 `.com`，helper 等待 GUI 并传回退出码。以下 `Start-Process -Wait` 命令等待单文件 GUI 并检查真实退出码；直接宿主的版本和自检不会扫描客户端、申请 UAC、启动考试客户端、连接 CDP 或写入宿主数据。普通临时释放包则每次写入自建临时目录，等待 GUI 后只清理该目录，不删除发布原件，不能称为零落盘入口。

```powershell
$hostExe = Join-Path (Get-Location) 'windows/native-build/bin/chaoxing_plus.exe'
$version = Start-Process -FilePath $hostExe -ArgumentList '--version' -NoNewWindow -Wait -PassThru
if ($version.ExitCode -ne 0) { throw "Version check failed: $($version.ExitCode)" }
$check = Start-Process -FilePath $hostExe -ArgumentList '--self-check','--no-disk-write' -NoNewWindow -Wait -PassThru
if ($check.ExitCode -ne 0) { throw "Self-check failed: $($check.ExitCode)" }
```

[build-windows.cmd](build-windows.cmd) 与 [build-windows.sh](build-windows.sh) 执行资源构建、双变体编译、完整发布打包和校验。原生最终目录直接为 `windows/native-build/release/`，不追加版本目录，不生成 ZIP，也不复制 README 或 docs：`single-file/` 只含内嵌资源 GUI，`multi-file/` 包含外置资源 GUI、`.com` helper、临时释放包、普通与调试两个原生启动器、配置及独立清单/校验器；发布根目录另有清单与校验器，不放兼容 EXE 或启动器。单独编译后可运行 `npm run release:windows` 补齐发布内容，原生模式 `--out <dir>` 指定最终目录，`--multi-dir <dir>` 指定完整多文件编译输入。CI 上传原生发布目录；Node 历史兼容包的 ZIP 和文档行为保持不变。共享构建与打包实现见 [share-file](../share-file/README.md)。

## 启动器区别

| 入口 | 行为 |
| --- | --- |
| [start-windows.cmd](../native-scripts/start-windows.cmd) | 普通入口；多文件发布包启动同级 GUI `.exe` |
| [start-windows-debug.cmd](../native-scripts/start-windows-debug.cmd) | 调试入口；使用 GUI 界面先进入原生首页，再由首页进入客户端选择；使用同级 `.com` helper |
| [start-windows-silent.cmd](../native-scripts/start-windows-silent.cmd) | 既有单文件静默入口，不随新的原生多文件包发布 |
| [start-windows-silent-debug.cmd](../native-scripts/start-windows-silent-debug.cmd) | 既有单文件静默调试入口，不随新的原生多文件包发布 |
| [start-windows-silent-no-full-scan-debug.cmd](../native-scripts/start-windows-silent-no-full-scan-debug.cmd) | 既有单文件静默常规扫描入口，不随新的原生多文件包发布 |

这些启动器会进入实际运行；只读检查使用上面的版本与自检命令。源码启动器定位仓库根的构建产物；新的原生多文件包仅发布普通和调试两个入口，`single-file/` 直接运行 GUI EXE。多文件删除挂起、自毁、发布目录清除与 `--stage-boot` 暂存启动本轮不支持并明确拒绝。Node 兼容包的历史原生启动器与 `start-windows-node*.cmd` 保持原样，仍使用历史包根布局。

单文件自毁兜底由 [purge.c](purge.c) 提供：关机/注销（含强制结束会话）在隐藏顶层窗口的 `WM_QUERYENDSESSION`/`WM_ENDSESSION` 里同步收尾；删除前先把清单写进 `%TEMP%` 的续删脚本并登记 `HKCU` RunOnce，删净后自行撤销；同时尽力登记 `MOVEFILE_DELAY_UNTIL_REBOOT`（需要管理员权限）以覆盖断电与强制结束进程。回归为 `scripts/windows-native-purge.test.mjs`（含 `purge-tests.exe` 与真实 PowerShell 续删执行）。

原生默认运行数据位于进程工作目录下 `.data/`，与 Node 的 `windows/data/` 不同。共享模板和本机 `windows/local-features.json` 保持原位；插件共用源码、插件 `dist/` 与 Windows 构建输出目录也不随文档整理迁移。
