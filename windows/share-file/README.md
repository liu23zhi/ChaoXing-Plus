# Windows 目录导航

Windows 考试客户端代码保持三类目录；本页是总入口。各目录内部按下方导航查找模块，源码文件不再移动。

| 目录 | 职责 |
| --- | --- |
| [原生宿主](../native-source/README.md) | C 源码、C 测试、MSVC 编译脚本、原生构建与 `start-windows*.cmd` |
| [Node 宿主](../node-source/README.md) | 已弃用的 Node 实现、PowerShell/VBS、备用构建与 `start-windows-node*.cmd` |
| [Windows 共享文件](./) | 页面平台层、Chrome75 闸门、资源构建、打包/校验、配置模板与参数生成器 |

插件共用的 `src/`、`public/`、`build.mjs`、`build-browser.sh`、`package.json` 与插件输出 `dist/` 保留原位。Windows 输出为 `dist-windows/`、`windows/native-build/` 与 `windows/node-build/`；原生完整包直接位于 `windows/native-build/release/`，GUI/Console EXE 分别位于其中的 `single-file/` 与 `multi-file/`，ZIP 位于 `windows/native-build/chaoxing-plus-6.2.0-windows.zip`。Node 备用 EXE 位于其构建目录的 `release/`，Node 兼容目录包保留历史输出规则。原生 `bin/` 保留宿主与调试/测试 EXE；回归测试仍在根 `scripts/`。本机 `windows/data/` 与 `windows/local-features.json` 均已忽略，继续留在原位，不作为源码清理对象。

## 共享模块

| 分组 | 文件与用途 |
| --- | --- |
| 页面平台层 | [windows-bootstrap.js](windows-bootstrap.js)：配置水合、面板壳与 Chrome75 补丁；[trampoline.js](trampoline.js)：新文档探针 |
| 构建 | [build.windows.mjs](build.windows.mjs)：生成 Windows 页面 bundle；[chrome75-syntax.mjs](chrome75-syntax.mjs)：语法闸门；[windows-build-features.mjs](windows-build-features.mjs)：本机构建开关 |
| 发布 | [package-windows.mjs](package-windows.mjs)：打包与清单；[verify-release.mjs](verify-release.mjs)：无 npm 依赖的完整性校验 |
| 图标 | [assets/app-icon.ico](assets/app-icon.ico)：两种 EXE 共用图标；[assets/app-icon.png](assets/app-icon.png)：原始 PNG |
| 配置工具 | [config.example.json](config.example.json)：两种宿主可只读解析的模板；[parameter-generator.html](parameter-generator.html)：离线参数生成器 |

参数生成器默认选择原生宿主，EXE 路径需要手动选择或填写实际绝对路径；仓库构建的 GUI EXE 位于 `windows/native-build/release/single-file/chaoxing_plus.exe`，页面不会自动填写该路径。预设与重置会保留已选原生路径。Node 选项仅作冻结的兼容入口，未完成的原生注入方式会明确标为不可用。页面不联网、不执行命令、不保存输入。

## 构建入口

以下命令从仓库根执行。构建会更新相应产物，自检与版本命令见各宿主目录说明。

| 入口 | 作用 |
| --- | --- |
| [原生 CMD 构建](../native-source/build-windows.cmd) / [Git Bash 构建](../native-source/build-windows.sh) | Windows 资源、原生 x86 EXE、默认发布包与校验 |
| [Node CMD 构建](../node-source/build-windows-node.cmd) / [Git Bash 构建](../node-source/build-windows-node.sh) | 冻结的 Node 备用目录包及 SEA 单 EXE |
| [原生编译脚本](../native-source/build-windows.ps1) | 只编译，默认生成 GUI/Console EXE；`-BuildConsole:$false` 仅 GUI，`-BuildTests` 同时生成 C 测试 |
| [扩展构建](../../build-browser.sh) | 仅构建插件的 `dist/` |
| `npm run build:windows` | 调用共享构建入口，生成 `dist-windows/` |
| `npm run release:windows` | 原生完整包直接生成到 `windows/native-build/release/`，ZIP 位于 `windows/native-build/` |
| `npm run build:node:exe` | 使用已有 release 注入资源，生成 `windows/node-build/release/chaoxing_plus_node.exe` |

## 发布包布局

默认原生最终目录直接为 `windows/native-build/release/`，不追加版本目录；原生模式的 `--out <dir>` 指定最终目录。`single-file/` 只含 GUI EXE；`multi-file/` 包含 Console EXE、五个改写后的原生启动器、配置、文档和独立校验清单。根与 `multi-file/` 各自包含 `verify-release.mjs`、`release-info.json` 和 `SHA256SUMS.txt`，根不放兼容 EXE 或启动器；配置模板位于 `multi-file/windows/share-file/config.example.json`。

显式 `--with-node` 生成包含 Node 运行闭包、启动器和运行时的历史兼容包，`--skip-native` 生成纯 Node 备用包；两者保留原有 `<out>/<name>/` 布局和默认仓库根 `release/` 输出。Node 闭包放在包内 `windows/node-source/`，配置模板放在 `windows/share-file/config.example.json`，不改变冻结的 Node 打包行为。

`start-windows.cmd` 是原生普通入口，原生包中位于 `multi-file/`；`start-windows-node.cmd` 是隐藏 Node 控制台的普通入口，保留客户端选择 GUI；`start-windows-node-silent.cmd` 是固定静默内存场景，使用独立的 `silent-memory-launch.vbs` 和 `silent-memory-bootstrap.mjs`。源码启动器定位仓库根或构建产物，复制后的原生启动器定位 `multi-file/`，Node 启动器定位历史发布包根；各自使用同级入口。

`.cmd`、`.ps1` 与 `.vbs` 保持纯 ASCII。中文文案放在原生程序、传入的 UTF-8 数据或文档中，避免 Windows PowerShell 5.1 与 cmd 的脚本解码问题。

## 进一步阅读

- [Windows 使用与设计](../../docs/windows.md)：配置、诊断、验证命令与真实客户端验收边界。
- [仓库约定](../../AGENTS.md)：目录边界及完整回归要求。
