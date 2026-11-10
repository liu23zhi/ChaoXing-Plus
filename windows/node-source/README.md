# Node 宿主

已冻结的 Node 宿主，仅用于历史兼容、对照与排障，不再更新宿主、启动器或打包能力。总目录说明见 [共享目录导航](../share-file/README.md)。

## 构建与只读检查

开发时需要 Node.js 22+。以下命令从仓库根执行；版本和自检不会启动任何客户端、申请 UAC 或建立调试会话。

```powershell
npm run build:windows -- --release
node windows/node-source/main.mjs --version
node windows/node-source/main.mjs --self-check --no-disk-write
```
