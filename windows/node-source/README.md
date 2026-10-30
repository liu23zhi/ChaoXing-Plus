# Node 宿主导航

本目录的 Node 宿主在本次单 EXE 封装与共享图标接入后冻结，不再更新宿主、启动器或打包能力；现有文件仅用于历史兼容、对照与排障。Windows 总目录说明见 [共享目录导航](../share-file/README.md)，当前运行边界见 [Windows 使用文档](../../docs/windows.md)。

## 模块分组

| 分组 | 文件 |
| --- | --- |
| 主流程与配置 | [main.mjs](main.mjs)、[options.mjs](options.mjs)、[config.mjs](config.mjs) |
| CDP 与注入 | [cdp.mjs](cdp.mjs)、[inject.mjs](inject.mjs)、[memory-diagnostics.mjs](memory-diagnostics.mjs) |
| 客户端启动与归属 | [launch.mjs](launch.mjs)、[launch-client.ps1](launch-client.ps1)、[listener-owner.mjs](listener-owner.mjs)、[client-process.mjs](client-process.mjs) |
| 扫描与选择 | [client-discovery.mjs](client-discovery.mjs)、[client-selection.mjs](client-selection.mjs)、[selection-window.mjs](selection-window.mjs)、[selection-window.ps1](selection-window.ps1) |
| 扫描进度 | [scan-progress-window.mjs](scan-progress-window.mjs)、[scan-progress-window.ps1](scan-progress-window.ps1) |
| 渲染诊断 | [diagnostics.mjs](diagnostics.mjs)、[system-probe.ps1](system-probe.ps1) |
| 程序文件与生命周期 | [owned-files.mjs](owned-files.mjs)、[wipe.mjs](wipe.mjs)、[program-cleanup.mjs](program-cleanup.mjs)、[self-destruct-control.mjs](self-destruct-control.mjs)、[self-destruct.mjs](self-destruct.mjs) |
| 启动辅助 | [silent-launch.vbs](silent-launch.vbs)：隐藏普通 Node 控制台；[silent-memory-launch.vbs](silent-memory-launch.vbs) / [silent-memory-bootstrap.mjs](silent-memory-bootstrap.mjs)：静默场景内存引导 |

## 构建与只读检查

开发时需要 Node.js 22+。以下命令从仓库根执行；版本和自检不会启动考试客户端、申请 UAC 或建立 CDP 会话。

```powershell
npm run build:windows -- --release
node windows/node-source/main.mjs --version
node windows/node-source/main.mjs --self-check --no-disk-write
```

[build-windows-node.cmd](build-windows-node.cmd) 与 [build-windows-node.sh](build-windows-node.sh) 同时生成备用目录包和 `windows/node-build/release/chaoxing_plus_node.exe`。已有 release 注入资源时，可单独执行 `npm run build:node:exe`。

单 EXE 使用 Node SEA，内嵌当前构建所用 Node 运行时、宿主模块、注入资源、配置模板及 PowerShell 脚本，目标机器无需安装 Node，也无需复制源码或 `dist-windows`。模块与注入资源从内存加载，不解包到磁盘；原有 GUI 全盘扫描仍使用系统临时状态文件。Windows PowerShell 5.1/WinForms 依赖保留，系统与架构要求由构建所用 Node 决定（本机 Node 24 x64），不能据此宣称支持旧版 Windows。EXE 普通运行保留控制台，隐藏可显式传 `--hide-console`。

`windows/node-build/build/` 存放 SEA 中间文件，原备用目录包继续保留在 `windows/node-build/chaoxing-plus-<version>-windows/` 用于调试。两种宿主共用 [app-icon.ico](../share-file/assets/app-icon.ico)，PNG 源图保存在同目录。共享资源和打包实现位于 [share-file](../share-file/README.md)，测试继续位于根 `scripts/`。

## 启动器区别

| 入口 | 行为 |
| --- | --- |
| [start-windows-node.cmd](start-windows-node.cmd) | 普通运行，通过 `silent-launch.vbs` 隐藏 Node 控制台，客户端选择 GUI 正常显示 |
| [start-windows-node-debug.cmd](start-windows-node-debug.cmd) | 普通运行，显示控制台以便排障 |
| [start-windows-node-silent.cmd](start-windows-node-silent.cmd) | 固定静默内存场景，通过 `silent-memory-launch.vbs` 引导 |
| [start-windows-node-silent-debug.cmd](start-windows-node-silent-debug.cmd) | 静默场景的可见控制台调试入口 |
| [start-windows-node-silent-no-full-scan-debug.cmd](start-windows-node-silent-no-full-scan-debug.cmd) | 静默调试入口，限定常规扫描 |

这些启动器会进入实际运行，检查版本或静态环境时使用上面的 `--version` / `--self-check` 命令即可。发布包保留相同的 Node 启动器文件名并将它们放在包根，宿主闭包仍在 `windows/node-source/`。

本机 Node 配置、缓存与日志继续位于 `windows/data/`；`windows/local-features.json` 仍是被忽略的构建开关，两者不迁移、不随文档整理删除。插件共用源码与 `dist/` 输出保持原位。
