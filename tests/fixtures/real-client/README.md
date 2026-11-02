# 真实客户端检查页截图

`check-failed-fullscreen-confirm.png` 来自 [Actions 41442569719](https://github.com/liu23zhi/chaoxing_plus/actions/runs/41442569719) 的 `real-client-v4.3.0.4-I` 现场，原文件为 `cx-real-client-v4.3.0.4-I-3-confirm-dialog.png`。保留原始 1920×1080 尺寸及 `(360,166,1200,700)` 检查页区域的像素，检查页外桌面和终端内容已覆盖为纯灰色。

全屏确认层包含遮罩后的蓝色入口。宽范围扫描会错误命中 `(971,244)`；只扫描中央确认区域应命中真正「确定」按钮 `(1030,616)`。`windows-client-dialog.test.mjs` 使用这些现场像素作为采集输入，并通过自建 Win32 窗口验证 PID、窗口类、可见性、枚举与真实 `PostMessage` 消息后的窗口关闭。它不执行真实考试客户端，也不证明真实课程页面已成功注入。
