# 私有客户端注入夹具

此目录只用于私有仓库的 GitHub Actions 真实客户端注入测试。EXE 由 Git LFS 管理，不能复制到公共仓库、发布包或测试日志。CI 会递归查找此目录下的所有 `.exe`，并按文件名版本自动生成客户端矩阵。

| 文件名版本 | 注入通道 |
| --- | --- |
| `chaoxing-exam-v4.1.4.*.exe` | `cdp-port` |
| `chaoxing-exam-v4.3.*.exe` | `dll-proxy` |

CI 会自动读取所有非空的 `Examination_Client_Database_*` GitHub Actions 变量，与发现的每个客户端组合。它会把选中的 EXE 复制到独立临时目录，并在同一目录写入 `UserExamInfo.db`。数据库 ZIP 由变量提供；CI 会要求解压后恰好得到一个非空的 `UserExamInfo.db`，并在测试结束时删除临时目录。新增版本需要在 `.github/workflows/ci.yml` 的版本规则中声明注入通道。
