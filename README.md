# 超星学习助手

[![持续集成](https://github.com/liu23zhi/ChaoXing-Plus/actions/workflows/ci.yml/badge.svg)](https://github.com/liu23zhi/ChaoXing-Plus/actions/workflows/ci.yml)

内部项目，不接受外部贡献。

## 扩展诊断日志

扩展自动向已配置的 TiKuHelper 服务回传结构化诊断日志，管理员可在 WebUI 查看或关闭。弹窗仅显示服务地址与管理状态，没有个人开关。未配置服务地址、密钥或尚无扩展设备身份时不会上传；正式服务使用 HTTPS，本机调试可用回环 HTTP。

日志沿用现有扩展设备 ID；每次浏览器启动或扩展重新加载会开始新的日志文件，打开页面或后台 worker 被唤醒不会换文件。事件仅包含版本、类型、时间、耗时、次数；不记录网页地址、题目、答案或控制台原文。网络暂时离线时只有限重试，不阻塞正常使用。

纯扩展仅沿用设备标识；使用自有 EXE 打开的独立浏览器复用同一宿主设备标识，并区分宿主为该浏览器分配的会话标识。Node 宿主只回传自身已授权脚本会话的启动和配置事件，普通访问密钥不能作为考试会话凭据。日志接口本身不登记设备、不创建或续期脚本会话，也不采集外部考试客户端内部事件。

项目文档和开发清单见 [TikuDoc](https://github.com/liu23zhi/TikuDoc)，本地入口 `../TikuDoc/ChaoXing-Plus/TASKLIST.md`。

## 构建

```bash
npm ci
npm run build
```

`windows/node-source/build-windows-node.sh` 为已弃用的历史入口，不在此维护。
