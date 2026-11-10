# 超星学习助手

[![持续集成](https://github.com/liu23zhi/chaoxing_plus/actions/workflows/ci.yml/badge.svg)](https://github.com/liu23zhi/chaoxing_plus/actions/workflows/ci.yml)
[![虚拟机自毁环境验证](https://github.com/liu23zhi/chaoxing_plus/actions/workflows/ci-vm.yml/badge.svg)](https://github.com/liu23zhi/chaoxing_plus/actions/workflows/ci-vm.yml)

超星学习通辅助工具。浏览器扩展与 Windows 桌面程序共用同一份业务代码。

## 安装

```bash
npm ci
npm run build          # 产物在 dist/
```

打开 `chrome://extensions`（或 `edge://extensions`）→ 开启「开发者模式」→
「加载已解压的扩展程序」→ 选 `dist/` 目录。

## Windows 桌面程序

```powershell
npm run build:windows
npm run build:native
```

构建脚本见 `windows/native-source/build-windows.sh`；
`windows/node-source/build-windows-node.sh` 是历史兼容的备用入口，不再开发新能力。

## 开发

```bash
npm run typecheck
npm run dev
```

详细说明见项目内部文档。
