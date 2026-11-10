# 真实客户端检查页截图

`check-failed-fullscreen-confirm.png` 为真实客户端现场截图，尺寸与检查页区域保持原始像素，检查页以外的桌面内容已覆盖为纯灰色。

`windows-client-dialog.test.mjs` 使用这些现场像素作为采集输入，并通过自建 Win32 窗口验证 PID、窗口类、可见性、枚举与真实 `PostMessage` 消息后的窗口关闭。它不执行真实考试客户端，也不证明真实课程页面已成功注入。
