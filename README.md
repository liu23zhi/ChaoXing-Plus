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
npm run windows:self-check # 检查已构建的原生 EXE（build-windows/bin）
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

Windows 端以 CEF 官方 `--remote-debugging-port` 参数启动超星考试客户端，通过本地 CDP 把业务 bundle 注入网页主世界，并用 `windows/share-file/windows-bootstrap.js` 提供配置水合、资源注入和 Chrome75 API 补丁。原生宿主源码与入口位于 `windows/native-source/`；已弃用的 Node 宿主及其备用入口位于 `windows/node-source/`，两者共用的 Windows 文件位于 `windows/share-file/`。与插件共用的 `src/`、插件构建脚本 `build.mjs` 与输出目录 `dist/` 保留原位；完整目录说明见 [Windows 文件说明](docs/windows.md#目录)。

```powershell
npm run build:windows      # 注入资源（dist-windows）
npm run build:native       # 原生 x86 EXE（需要本机 MSVC x86 工具链）
# 构建 Windows 单文件 x86 发布包（CMD 入口，不依赖 Git Bash）
.\windows\native-source\build-windows.cmd
# 备用（已弃用，仅兼容/对照）：只打 Node 包，不含原生 EXE
.\windows\node-source\build-windows-node.cmd
# Git Bash 等价入口：bash windows/native-source/build-windows.sh
# Node 备用包：bash windows/node-source/build-windows-node.sh
.\windows\native-source\start-windows.cmd
# 需要可见控制台日志时使用调试入口（控制台 + GUI）
.\windows\native-source\start-windows-debug.cmd
# 静默场景入口（零落盘内存模式、快速扫描失败才全盘、自动首选 x86、无面板/控制台）
.\windows\native-source\start-windows-silent.cmd
```

原生宿主启动诊断默认位于工作目录下的 `.data/`；Node 宿主继续使用 `windows/data/`。排查系统缩放导致的模糊时，可用 `.\windows\native-source\start-windows.cmd --dpi-aware` 普通启动。Windows 悬浮面板只服务考试答题场景，默认折叠为标题条；Chrome 扩展保持完整面板与默认展开。详细配置、验证步骤与故障排查见 [docs/windows.md](docs/windows.md)。

Windows 发布包（默认使用原生宿主）：

```powershell
npm run build:windows -- --release # dist-windows 注入资源
npm run build:native    # 原生 EXE（需要本机 MSVC x86 工具链）
npm run release:windows # release/chaoxing-plus-6.2.0-windows.zip
```

默认包提供资源内嵌的 `chaoxing_plus.exe`、五个原生 `start-windows*.cmd` 启动器、文档、`windows/share-file/config.example.json`、`release-info.json`、`SHA256SUMS.txt` 与包根 `verify-release.mjs`。显式传 `npm run release:windows -- --with-node` 才增加 Node 运行闭包、运行时和 `start-windows-node*.cmd` 启动器，`--skip-native` 则生成纯 Node 备用包。发布包启动器仍位于包根；解压后运行 `node verify-release.mjs` 校验完整性。CI 工作流见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。

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
├── docs/windows.md              # Windows 端使用与设计说明
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



