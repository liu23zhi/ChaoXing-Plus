# 超星学习助手 — 单平台超星脚本工程

> 基于 [ocsjs](https://github.com/ocsjs/ocsjs/) 的超星模块思路重构，只保留超星学习通相关能力，产出单脚本构建结果。

---

## 当前状态

这个仓库已经不再以浏览器扩展（Manifest V3）为核心，而是一个面向超星页面注入场景的脚本型工程。

当前重点能力包括：
- 课程任务点学习主链路
- 视频、音频、PPT、长时阅读、链接任务处理
- 作业、考试、章节测试答题链路
- 倍速限制绕过、复制限制解除、人脸识别等待
- 超星加密字体识别

---

## 开发命令

```bash
npm install
npm run typecheck
npm run build
npm run dev
# 扩展（浏览器）完整构建：依赖安装 + 类型检查 + 构建 + dist 校验
bash build-browser.sh
```

Windows 端（超星考试客户端 / CEF 75）额外命令：

```bash
npm run build:windows      # 注入资源（dist-windows）
npm run build:native       # 原生 x86 EXE（需要本机 MSVC x86 工具链）
npm run windows:self-check # 检查已构建的原生 EXE（windows/native-build/bin）
npm run windows            # 启动原生宿主（需要管理员权限时自动申请 UAC）
npm run windows:silent     # 原生静默场景入口
# 已弃用的 Node 宿主（仅兼容/对照）：npm run windows:node
```

构建产物输出到：

```text
dist/chaoxing-plus.js        # 扩展注入脚本
dist-windows/                # Windows 端宿主注入资源（gitignore）
```

---

## Windows 端（CEF 75 客户端注入）

Windows 端以 CEF 官方 `--remote-debugging-port` 参数启动超星考试客户端，通过本地 CDP 把业务 bundle 注入网页主世界，并用 `windows/share-file/windows-bootstrap.js` 提供配置水合、资源注入和 Chrome75 API 补丁。原生宿主源码与入口位于 `windows/native-source/`；已弃用的 Node 宿主及其备用入口位于 `windows/node-source/`，两者共用的 Windows 文件位于 `windows/share-file/`。与插件共用的 `src/`、插件构建脚本 `build.mjs` 与输出目录 `dist/` 保留原位；各子目录说明见 windows/native-source/README.md、windows/node-source/README.md 与 windows/share-file/README.md。

```powershell
npm run build:windows      # 注入资源（dist-windows）
npm run build:native       # 原生单文件/多文件 GUI、Console helper 与临时释放包（需 MSVC x86）
# 构建 Windows 原生双变体发布包（CMD 入口，不依赖 Git Bash）
.\windows\native-source\build-windows.cmd
# 备用（封装完成后冻结）：Node 单 EXE 与调试目录包，不含原生 EXE
.\windows\node-source\build-windows-node.cmd
# Git Bash 等价入口：bash windows/native-source/build-windows.sh
# Node 备用包：bash windows/node-source/build-windows-node.sh
.\windows\native-scripts\start-windows.cmd
# 需要可见控制台日志时使用调试入口（控制台 + GUI）
.\windows\native-scripts\start-windows-debug.cmd
```

原生宿主启动诊断默认位于工作目录下的 `.data/`；Node 宿主继续使用 `windows/data/`。排查系统缩放导致的模糊时，可用 `.\windows\native-scripts\start-windows.cmd --dpi-aware` 普通启动。Windows 悬浮面板只服务考试答题场景，默认折叠为标题条；Chrome 扩展保持完整面板与默认展开。详细配置、验证步骤与故障排查见 AGENTS.md 的 Windows 端章节。

可独立分发的原生 GUI 为 `windows/native-build/release/single-file/chaoxing_plus.exe`，内嵌四项页面资源与 winmm 代理。`multi-file/chaoxing_plus.exe` 仍为 GUI 主程序，使用四项 `assets/` 资源和根目录 `winmm-proxy.dll`，不含这些 RCDATA；同级 `chaoxing_plus.com` 是等待 GUI 并保留输出/退出码的 Console helper。PowerShell 显式调用 `.exe` 不保证等待；命令行需要等待时使用省略扩展名的 `chaoxing_plus`、显式 `.com` 或 `Start-Process -Wait`。`BuildConsole` 默认 `true`，包含多文件变体与 `multi-file/package-to-single/chaoxing_plus.exe` 普通临时释放包；`-BuildConsole:$false` 仅生成单文件 GUI。释放包每次释放到自建临时目录，等待 GUI 退出后仅清理该目录，发布原件不删除。原生 `bin/` 中的宿主与调试/测试 EXE 保留。Node 备用 EXE 仍为 `windows/node-build/release/chaoxing_plus_node.exe`，其运行时、资源与冻结行为不变。

Windows 完整发布包（默认使用原生宿主）：

```powershell
npm run build:windows -- --release # dist-windows 注入资源
npm run build:native    # 原生 EXE（需要本机 MSVC x86 工具链）
npm run release:windows # windows/native-build/release/，不生成 ZIP 或复制文档
```

原生最终目录直接使用 `windows/native-build/release/`，不追加版本目录，不生成 ZIP，也不复制 README 或 docs：`single-file/` 只含内嵌资源 GUI；`multi-file/` 包含外置资源 GUI、`.com` helper、普通临时释放包、配置和独立校验清单。多文件仅发布普通 `start-windows.cmd`（GUI `.exe`）和调试 `start-windows-debug.cmd`（`.com` helper）两个启动器，不发布三个 `start-windows-silent*.cmd`；多文件删除挂起、自毁和 `--stage-boot` 本轮不支持并明确拒绝。原生发布根目录提供 `release-info.json`、`SHA256SUMS.txt` 与 `verify-release.mjs`，不再放兼容 EXE 或启动器。原生模式 `--out <dir>` 指定最终目录，`--multi-dir <dir>` 指定多文件编译输入。CMD/Bash 入口完成资源构建、编译、打包与校验，PowerShell 入口只编译。在发布目录分别运行 `node verify-release.mjs` 与 `node multi-file/verify-release.mjs` 校验完整性。

显式传 `npm run release:windows -- --with-node` 生成包含 Node 的历史兼容包，`--skip-native` 则生成纯 Node 备用包；两者保留原有 `<out>/<name>/` 布局、默认仓库根 `release/` 输出及 ZIP/文档行为，不改变冻结的 Node 打包行为。CI 上传原生 `windows/native-build/release/` 目录，工作流见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。

---

## 项目结构

```text
chaoxing_plus/
├── src/
│   ├── index.ts                 # 单入口启动文件
│   ├── projects/
│   │   ├── cx.ts                # 超星项目主实现
│   │   ├── common.ts            # 通用设置/答题结果/缓存能力
│   │   └── background.ts        # 最小日志与提示桥接
│   ├── runtime/                 # 本地最小 runtime
│   ├── core/                    # 本地化迁入的答题核心与请求/字符串工具
│   ├── utils/                   # 学习与答题辅助工具
│   └── elements/                # 自定义元素
├── windows/
│   ├── node-source/             # Node 宿主、备用构建和启动器（已弃用）
│   ├── native-source/           # 原生源码、编译脚本、构建和启动器
│   ├── share-file/              # Windows 共用页面资源、构建/打包脚本、配置与生成器
│   └── data/                    # 本地配置/日志（gitignore）
├── build.mjs                    # 扩展注入脚本构建
├── build-browser.sh             # 扩展完整构建入口
├── scripts/                     # 扩展和 Windows 回归测试
├── package.json
└── tsconfig.json
```

---

## 说明

- 当前目标是尽量贴近 `ocsjs/packages/scripts` 的超星模块行为。
- 已移除对旧 MV3 扩展结构的依赖，不再以 popup/background/content 三段式作为主架构。
- `public/manifest.json` 等旧扩展资源已不再是项目主体的一部分。

---

## License

MIT



