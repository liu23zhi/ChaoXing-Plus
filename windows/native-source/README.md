# 原生宿主导航

本目录存放 Windows 原生宿主、C 测试、MSVC 编译脚本及原生构建/启动入口。运行时为 x86 Win32、无 CRT，页面注入资源以 RCDATA 内嵌。Windows 总目录说明见 [共享目录导航](../share-file/README.md)，配置与验收范围见 [Windows 使用文档](../../docs/windows.md)。

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
| 静默生命周期 | [silent.c](silent.c)、[silent.h](silent.h) |
| 测试与驱动 | [tests/](tests/)、[discovery-testdriver.c](discovery-testdriver.c) |

## 构建与只读检查

从仓库根执行。构建需要 Node.js 22+、MSVC x86 工具链与 Windows SDK；生成后的原生 EXE 运行时不依赖 Node 或 PowerShell。

```powershell
npm run build:windows -- --release
npm run build:native
```

[build-windows.ps1](build-windows.ps1) 只负责编译，默认生成 GUI 与 Console 两种 EXE；`-BuildTests` 同时生成 C 测试，`bin/` 保留宿主与调试/测试 EXE。编译后将 GUI EXE 放到 `windows/native-build/release/single-file/chaoxing_plus.exe`，Console EXE 放到 `windows/native-build/release/multi-file/chaoxing_plus_console.exe`。显式传 `-BuildConsole:$false` 时只编译 GUI，并清理 `bin/` 与 `release/multi-file/` 中的旧 Console EXE。资源和共享 [app-icon.ico](../share-file/assets/app-icon.ico) 均已内嵌。以下 PowerShell 命令等待 GUI 子系统进程退出，并检查真实退出码；版本和自检均不会扫描客户端、申请 UAC、启动考试客户端、连接 CDP 或写入宿主数据。

```powershell
$hostExe = Join-Path (Get-Location) 'windows/native-build/bin/chaoxing_plus.exe'
$version = Start-Process -FilePath $hostExe -ArgumentList '--version' -NoNewWindow -Wait -PassThru
if ($version.ExitCode -ne 0) { throw "Version check failed: $($version.ExitCode)" }
$check = Start-Process -FilePath $hostExe -ArgumentList '--self-check','--no-disk-write' -NoNewWindow -Wait -PassThru
if ($check.ExitCode -ne 0) { throw "Self-check failed: $($check.ExitCode)" }
```

[build-windows.cmd](build-windows.cmd) 与 [build-windows.sh](build-windows.sh) 执行资源构建、双变体编译、完整发布打包和校验。原生最终目录直接为 `windows/native-build/release/`，不追加版本目录：`single-file/` 只含 GUI EXE，`multi-file/` 包含 Console EXE、五个原生启动器、配置、文档及独立清单/校验器；发布根目录另有清单与校验器，不放兼容 EXE 或启动器。ZIP 位于 `windows/native-build/chaoxing-plus-6.2.0-windows.zip`。单独编译后可运行 `npm run release:windows` 补齐发布内容，原生模式 `--out <dir>` 指定最终目录。共享构建与打包实现见 [share-file](../share-file/README.md)。

## 启动器区别

| 入口 | 行为 |
| --- | --- |
| [start-windows.cmd](../native-scripts/start-windows.cmd) | 原生普通运行入口 |
| [start-windows-debug.cmd](../native-scripts/start-windows-debug.cmd) | 原生调试入口 |
| [start-windows-silent.cmd](../native-scripts/start-windows-silent.cmd) | 原生固定静默场景入口 |
| [start-windows-silent-debug.cmd](../native-scripts/start-windows-silent-debug.cmd) | 静默场景调试入口 |
| [start-windows-silent-no-full-scan-debug.cmd](../native-scripts/start-windows-silent-no-full-scan-debug.cmd) | 静默调试入口，限定常规扫描 |

这些启动器会进入实际运行；只读检查使用上面的版本与自检命令。源码启动器定位仓库根的构建产物，原生打包时五个启动器复制到 `multi-file/` 并定位同级 Console EXE；`single-file/` 直接运行 GUI EXE。Node 备用启动器另以 `start-windows-node*.cmd` 命名，保留历史包根布局。

原生默认运行数据位于进程工作目录下 `.data/`，与 Node 的 `windows/data/` 不同。共享模板和本机 `windows/local-features.json` 保持原位；插件共用源码、插件 `dist/` 与 Windows 构建输出目录也不随文档整理迁移。
