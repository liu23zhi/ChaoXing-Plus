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
```

Windows 端（超星考试客户端 / CEF 75）额外命令：

```bash
npm run build:windows
npm run windows:self-check
npm run windows        # 需要管理员权限时宿主会自动申请 UAC
```

构建产物输出到：

```text
dist/chaoxing-plus.js        # 扩展注入脚本
dist-windows/                # Windows 端宿主注入资源（gitignore）
```

---

## Windows 端（CEF 75 客户端注入）

仓库新增 `windows/host` 宿主：以 CEF 官方 `--remote-debugging-port` 参数启动超星考试客户端，通过本地 CDP 把业务 bundle 注入网页主世界，并用 `windows/bootstrap/windows-bootstrap.js` 替代扩展平台能力（配置水合、资源注入、Chrome75 API 补丁）。

```powershell
npm run build:windows
# 首次运行会创建 windows/data/config.json，把 clientPath 指向 CXExam.exe
.\start-windows.cmd
```

启动模式会自动采集渲染诊断到 `windows/data/diagnostics/<时间戳>/`（DPI/窗口 DPI 感知/面板样式/页面与窗口截图），用于排查“悬浮窗模糊”；若系统缩放为 125%/150% 且客户端 DPI-unaware，可用 `.\start-windows.cmd --dpi-aware` 重试。Windows 端只服务考试/答题场景：悬浮面板仅在考试相关页面出现、**默认折叠为标题条**（点击标题条展开/折叠），并只保留考试答题相关功能（答题结果、题库配置、考试设置）；Chrome 扩展保持完整面板与默认展开。详细设计、配置、验证步骤与故障排查见 [docs/windows.md](docs/windows.md)。

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
│   ├── bootstrap/               # 页面侧平台层（CEF 75，无 chrome.*）
│   ├── host/                    # Node 宿主：启动客户端 + CDP 注入
│   ├── config.example.json      # 配置模板
│   └── data/                    # 本地配置/日志（gitignore）
├── build.mjs                    # 扩展注入脚本构建
├── build.windows.mjs            # Windows 端构建（target chrome75 + 语法闸门）
├── start-windows.cmd            # Windows 端入口
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
