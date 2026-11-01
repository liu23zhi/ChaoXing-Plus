# 私有客户端注入夹具

此目录只用于私有仓库的 GitHub Actions 真实客户端注入测试。EXE 由 Git LFS 管理，不能复制到公共仓库、发布包或测试日志。CI 会递归查找此目录下的所有 `.exe`，并按文件名版本自动生成客户端矩阵。

| 文件名版本 | 注入通道 |
| --- | --- |
| `chaoxing-exam-v4.1.4.*.exe` | `cdp-port` |
| `chaoxing-exam-v4.3.*.exe` | `dll-proxy` |

私有客户端测试默认关闭。完成安全迁移后，将仓库变量 `CI_PRIVATE_CLIENTS_ENABLED=true` 启用；该测试只在非 PR 事件运行。CI 会自动发现值为 `enabled` 的 `Examination_Client_Database_*` GitHub Actions 变量，并与每个客户端组合。变量只用于发现名称，数据库载荷必须放入**同名 Repository Secret**，内容为 ZIP 文件的 Base64 文本。ZIP 必须包含且只包含一个非空的 `UserExamInfo.db`。CI 会把选中的 EXE 复制到独立临时目录，在解压前验证 ZIP 签名，再将数据库写入客户端目录；测试结束时删除临时目录。新增版本需要在 `.github/workflows/ci.yml` 的版本规则中声明注入通道。

配置示例：变量 `Examination_Client_Database_I=enabled`，Secret `Examination_Client_Database_I=<ZIP 的 Base64>`。发现日志只包含变量名，不输出 Secret 内容；注入步骤会在处理前注册载荷掩码。
