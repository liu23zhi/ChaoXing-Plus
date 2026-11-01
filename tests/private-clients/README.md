# 私有客户端注入夹具

此目录只用于私有仓库的 GitHub Actions 真实客户端注入测试。三个 EXE 由 Git LFS 管理，不能复制到公共仓库、发布包或测试日志。

| 文件 | 注入通道 |
| --- | --- |
| `chaoxing-exam-v4.1.4.25512.exe` | `cdp-port` |
| `chaoxing-exam-v4.3.0.4.exe` | `dll-proxy` |
| `chaoxing-exam-v4.1.4.25389.exe` | `cdp-port` |

CI 会把选中的 EXE 复制到独立临时目录，并在同一目录写入 `UserExamInfo.db`。数据库 ZIP 由 GitHub Actions 变量提供；CI 会要求解压后恰好得到一个非空的 `UserExamInfo.db`，并在测试结束时删除临时目录。
