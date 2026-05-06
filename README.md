# Chaoxing Plus — 单平台超星脚本工程

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

构建产物输出到：

```text
dist/chaoxing-plus.js
```

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
├── build.mjs                    # 单入口脚本构建
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
