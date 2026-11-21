# 超星学习助手

[![持续集成](https://github.com/liu23zhi/ChaoXing-Plus/actions/workflows/ci.yml/badge.svg)](https://github.com/liu23zhi/ChaoXing-Plus/actions/workflows/ci.yml)

内部项目，不接受外部贡献。

## 扩展诊断日志

在扩展弹窗中开启**回传扩展诊断日志**。先确认弹窗显示的是自己的题库服务，并在扩展设置中配置其访问密钥；换账号或服务后需要重新同意。无需新增全站访问权限。管理员可在 TiKuHelper WebUI 查看收到的日志。

回传默认关闭，仅包含固定的扩展事件及时间、版本、耗时、次数。不会回传网址、题目、答案或原始控制台内容。网络中断时仅在内存中有限重试，不影响正常使用。正式服务使用 HTTPS；本机调试可用回环 HTTP 地址。

项目文档和开发清单见 [TikuDoc](https://github.com/liu23zhi/TikuDoc)，本地入口 `../TikuDoc/ChaoXing-Plus/TASKLIST.md`。

## 构建

```bash
npm ci
npm run build
```

`windows/node-source/build-windows-node.sh` 为已弃用的历史入口，不在此维护。
