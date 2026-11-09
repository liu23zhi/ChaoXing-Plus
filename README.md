# 超星学习助手

> 基于 [ocsjs](https://github.com/ocsjs/ocsjs/) 的超星模块思路重构，只保留超星学习通相关能力。

同一份业务代码，两种运行形态：**浏览器扩展**跑在 Chrome/Edge 里，**Windows 原生宿主**把同一份
bundle 注入超星考试客户端。两者的能力边界不同，下面分开写。

---

## 两条使用路径（先看这里）

| | A. 浏览器扩展 | B. Windows 考试客户端宿主 |
|---|---|---|
| 跑在哪 | Chrome / Edge（Manifest V3） | 超星考试客户端（CEF 75，独立 EXE） |
| 覆盖页面 | 学习通课程、作业、考试、章节测验 | **只有考试答题页** |
| 能做什么 | 任务点学习（视频/音频/PPT/阅读/链接）、作业与章节测验答题、倍速与复制限制解除、加密字体识别 | 考试答题辅助、自动交卷、AI 搜题 |
| 面板形态 | 完整面板，默认展开 | 裁剪为考试功能，默认折叠成标题条 |
| 怎么装 | 加载 `dist/` 为已解压扩展 | 构建原生 EXE，由宿主启动客户端 |

**装了扩展不等于有考试客户端的能力。** 考试客户端是独立进程，扩展注入不进它的 CEF 页面；
要覆盖考试客户端，必须走 B 路径的宿主程序。反过来，宿主只服务考试场景，不会替你做课程任务点。

---

## A. 浏览器扩展

### 三步跑起来

```bash
npm ci                 # 或 bash build-browser.sh 一步完成安装+类型检查+构建+校验
npm run build          # 产物在 dist/
```

打开 `chrome://extensions`（或 `edge://extensions`）→ 开启「开发者模式」→
「加载已解压的扩展程序」→ 选 `dist/` 目录。

`build-browser.sh` 会额外校验 `dist/chaoxing-plus.js` 与 `dist/manifest.json` 是否生成，
并打印产物大小与加载路径。

### 默认后端

构建时可用 `DEFAULT_TIKU_BASE_URL` 指定默认服务地址（缺省 `https://tiku.zelly.cn/`），
服务端即 `tikuAdapter`。地址与访问令牌都能在面板里改，不必重新构建。

### 开发

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run dev            # 构建并 watch（不是 dev server，改完需在扩展页刷新）
```

---

## B. Windows 考试客户端宿主

宿主用 CEF 官方的 `--remote-debugging-port`（或代理方式，见下）启动超星考试客户端，
再通过本地 CDP 把业务 bundle 注入网页主世界，由 `windows/share-file/windows-bootstrap.js`
提供配置水合、资源注入和 Chrome 75 API 补丁。

### 构建

```powershell
npm run build:windows   # 生成 dist-windows/（注入资源）
npm run build:native    # 编译原生 x86 EXE（需要本机 MSVC x86 工具链 + Windows SDK）
```

或者用成组入口一次完成资源构建、双变体编译、打包与校验：

```powershell
.\windows\native-source\build-windows.cmd     # CMD，不依赖 Git Bash
bash windows/native-source/build-windows.sh   # Git Bash 等价入口
```

发布包：

```powershell
npm run build:windows -- --release
npm run build:native
npm run release:windows    # 输出到 windows/native-build/release/
```

`single-file/chaoxing_plus.exe` 内嵌四项页面资源与 winmm 代理；
`multi-file/chaoxing_plus.exe` 使用 `assets/` 下的外置资源与根目录 `winmm-proxy.dll`，
同级 `chaoxing_plus.com` 是等待 GUI 并转交退出码的 Console helper。
在 PowerShell 里显式调用 `.exe` 不保证等待，需要等待时用省略扩展名的 `chaoxing_plus`、
显式 `.com`，或 `Start-Process -Wait`。

Node 宿主已弃用，只保留文件作兼容/对照与排障，不再开发新能力。需要复现历史包时才用备用入口：

```powershell
.\windows\node-source\build-windows-node.cmd
bash windows/node-source/build-windows-node.sh
```

### 启动

```powershell
.\windows\native-scripts\start-windows.cmd         # 普通入口
.\windows\native-scripts\start-windows-debug.cmd   # 带可见控制台日志
```

原生宿主的运行数据默认写在工作目录下的 `.data/`（Node 宿主用 `windows/data/`）。
系统缩放导致窗口模糊时，可用 `.\windows\native-scripts\start-windows.cmd --dpi-aware`。

### 注入方式与适用范围（实测结论）

注入方式由 `--inject-mode` 选择，`auto` 按三段式自动分派：目录里已有我们的代理 → 复用 `dll-proxy`；
客户端带 `.themida` 节（Themida 加壳）→ 临时安装 `dll-proxy`；其余 → `cdp-port`。

三代真实客户端（IG5 只读实测）的结论：

| 注入方式 | 4.1.4.25512 | 4.1.4.25389 | 4.3.0.4（Themida 加壳） |
|---|---|---|---|
| `cdp-port` | ✅ 可用 | ✅ 可用 | ⚠️ 不推荐：壳在入口就接管，命令行开关是否透传静态不可证 |
| `dll-proxy` | ⚠️ 可用，需显式安装（目录里没有 `winmm.dll`） | ⚠️ 可用，需显式安装 | ✅ 唯一可靠；该目录的代理已装且正在生效 |
| `cdp-pipe` | ❌ 不可用 | ❌ 不可用 | ❌ 不可用 |
| `input` | ❌ 未实现 | ❌ 未实现 | ❌ 未实现 |

`cdp-pipe` 虽然宿主侧已接线（NUL 帧管道 + attach + 注入），但三代客户端 EXE 内
`remote-debugging` **零命中**，非 Chromium 客户端必然失败，因此不作为可用通道。
`input` 显式选择会以退出码 4 失败。`auto` 永不退回这两者。

**这些结论有边界**：`cdp-port` 在 4.1.4 两代的可用性来自静态证据（`cef_initialize` 调用点可定位、
`remote-debugging-port` 未被硬编码），加壳客户端命令行是否真的透传、代理在运行时是否命中
`cef_initialize`，只能真机验证。本仓库不承诺"完整注入所有版本"。

先看这台客户端支持什么（需先跑过 `npm run build:native`，该 EXE 是构建产物）：

```powershell
.\windows\native-build\bin\chaoxing_plus.exe --probe-all --no-disk-write --quiet
```

输出会列出候选客户端、架构、版本、`libcef` 开关与代理状态，并给出建议通道。
`--probe-all` 与 `--probe-client <CXExam.exe>` 都是只读探测，不启动客户端。

### 注入成功的判据

**"启动成功"不等于"注入成功"，"看到面板"也不等于注入成功。** 运行报告里的 `injectEvidence`
有三个可观测信号，缺一不认：

| 字段 | 证明什么 |
|---|---|
| `endpointReady` | CDP 端点真的应答了 `/json/version`，端口通道成立 |
| `proxyHook` / `proxyHookRequired` | `dll-proxy` 模式下 `%TEMP%\cxhook-<pid>.log` 证明 `cef_initialize` 已被接管 |
| `bundleInPage` / `bundleSentinelRejected` | 页面主世界的哨兵（`__CX_WIN_HOST__` + `__CX_WIN_BUNDLE_LOADED__`）证明 bundle 真的落地 |

`verified = endpointReady && bundleInPage && (!proxyHookRequired || proxyHook)`。

哨兵有三态：确认 / 明确否定 / 无法判定。只有页面给出明确否定（`error` / `exceptionDetails`，
或返回值不是 `true`）才升级为 `inject-bundle-unconfirmed` 失败；超时与断连只记为未验证，
避免把一次抖动当成注入失败。代理日志缺失记为 unknown，只有日志里出现 `no injection port`
这类明确失败证据才判失败。

登录页不加载答题脚本、没有面板，不能单独判定注入失败 —— 完成登录后才会出现面板。

### 自检

```powershell
npm run windows:self-check    # 检查 windows/native-build/bin/chaoxing_plus.exe
```

直接宿主的版本与自检是只读的：不扫描客户端、不申请 UAC、不启动考试客户端、不连接 CDP、不写宿主数据。

---

## 项目结构

```text
chaoxing_plus/
├── src/                         # 业务代码，扩展与 Windows 宿主共用
│   ├── index.ts                 # 单入口启动文件
│   ├── extension-entry.js       # 扩展 content script 入口
│   ├── projects/                # cx.ts（超星主实现）、common.ts、background.ts
│   ├── runtime/                 # 本地最小 runtime（弹窗、store）
│   ├── core/                    # 答题核心与请求/字符串工具
│   ├── utils/                   # 学习与答题辅助工具
│   └── elements/                # 自定义元素
├── windows/
│   ├── native-source/           # 原生宿主 C 源码、C 测试、MSVC 编译脚本
│   ├── native-scripts/          # 原生启动脚本 start-windows*.cmd
│   ├── node-source/             # 已弃用的 Node 宿主（仅兼容/对照）
│   ├── node-scripts/            # Node 启动脚本与 PowerShell/VBS
│   ├── share-file/              # 两种宿主共用的页面资源、构建/打包/配置工具
│   └── data/                    # Node 宿主本机配置/日志（gitignore）
├── scripts/                     # 扩展与 Windows 回归测试
├── build.mjs                    # 扩展构建（生成 dist/manifest.json）
├── build-browser.sh             # 扩展完整构建入口
├── package.json
└── tsconfig.json
```

构建产物：`dist/`（扩展）、`dist-windows/`（宿主注入资源）、`windows/native-build/`
（原生 EXE 与发布包）。三者都已 gitignore，不要手工修改。

---

## 开发与验证

```bash
npm run typecheck                              # tsc --noEmit
npm run build                                  # 扩展构建
npm run build:windows                          # 宿主注入资源（含 Chrome 75 语法闸门）
node --test scripts/windows-host.test.mjs scripts/windows-bootstrap.test.mjs scripts/windows-chrome75.test.mjs scripts/windows-store-safety.test.mjs
```

全量测试为 `node --test scripts/*.test.mjs`。含 Chromium 与原生宿主用例的套件请加
`--test-concurrency=4` 限制并发，否则同时启动多个浏览器/宿主用例会出现偶发超时。

`npm run build:windows` 会拒绝 `?.` / `??` / 逻辑赋值 / 私有类成员 / 静态块等 Chrome 75 不支持的语法。
`windows/share-file/windows-bootstrap.js`、`trampoline.js` 必须手工保持 ES2019/ES5 可解析；
`src/projects/tiku-adapter-config.ts` 里运行期 `Function(...)` 求值的 handler 字符串不会经过构建转译，
新增时同样禁止 `?.` / `??`。

---

## 文档导航

设计文档与验收记录在 **TikuDoc** 仓库，不在本仓库（`docs/` 已迁出）。

> TikuDoc 是私有仓库，只有协作者能打开。没有访问权限时，仓库内的
> `windows/native-source/README.md`、`windows/share-file/README.md`、`AGENTS.md`
> 覆盖了同样的配置、注入判据与验收边界。

| 想了解 | 位置 |
|---|---|
| Windows 端使用与设计（配置、诊断、真实客户端验收边界） | [docs/windows.md](https://github.com/liu23zhi/TikuDoc/blob/main/chaoxing_plus/docs/windows.md) |
| Windows 注入操作手册（选通道 → 执行 → 症状排查） | [docs/windows-injection-guide.md](https://github.com/liu23zhi/TikuDoc/blob/main/chaoxing_plus/docs/windows-injection-guide.md) |
| 注入方案变更清单 | [docs/windows-injection-changelog.md](https://github.com/liu23zhi/TikuDoc/blob/main/chaoxing_plus/docs/windows-injection-changelog.md) |
| Themida 加壳客户端（4.3.0.4）脱壳方法 | [docs/themida-unpack.md](https://github.com/liu23zhi/TikuDoc/blob/main/chaoxing_plus/docs/themida-unpack.md) |
| 输入法伪装冻结记录 | [docs/ime-spoofing-freeze.md](https://github.com/liu23zhi/TikuDoc/blob/main/chaoxing_plus/docs/ime-spoofing-freeze.md) |
| 开发清单与进度 | [TASKLIST.md](https://github.com/liu23zhi/TikuDoc/blob/main/chaoxing_plus/TASKLIST.md) |

---

## License

MIT
