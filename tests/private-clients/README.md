# 私有客户端注入夹具

此目录只用于私有仓库的 GitHub Actions 真实客户端注入测试。EXE 由 Git LFS 管理，不能复制到公共仓库、发布包或测试日志。CI 会递归查找此目录下的所有 `.exe`，并按文件名版本自动生成客户端矩阵。

| 文件名版本 | 注入通道 |
| --- | --- |
| `chaoxing-exam-v4.1.4.*.exe` | `cdp-port` |
| `chaoxing-exam-v4.3.*.exe` | `dll-proxy` |

私有客户端测试在非 PR 事件（`push` / `workflow_dispatch`）自动运行，不再依赖额外的启用变量——缺少数据库变量时 discovery 会直接报错，而不是静默跳过。CI 会自动发现所有非空的 `Examination_Client_Database_*` GitHub Actions 变量，并与 `tests/private-clients/` 下每个客户端 EXE 组合。变量值必须是 `UserExamInfo.db` 的 Base64 文本（换行与空白会被忽略）；注入脚本解码后直接把字节写入解压出的 `CXExam.exe` 同目录，文件名固定为 `UserExamInfo.db`，不做任何解压。旧的 `enabled` 标记和 ZIP 载荷会在发现或注入阶段直接报错。测试结束时删除独立临时目录。新增版本需要在 `.github/workflows/ci.yml` 的版本规则中声明注入通道。

配置示例：

```powershell
# 生成变量值
[Convert]::ToBase64String([IO.File]::ReadAllBytes('UserExamInfo.db'))
# 本地验证（不启动客户端）：变量值必须以 UserExamInfo.db 的完整字节解码出来
```

GitHub 对单个配置变量有 48 KB 上限（base64 会把字节放大约 1/3），因此上述变量只适合体积较小的数据库夹具；当前夹具解码后为 12288 字节。变量总容量受组织与仓库变量合计上限约束；载荷更大时应改用 Git LFS 管理数据库夹具（工作流当前只读取 `vars`，不读取 Secret）。

发现日志只输出变量名；变量值在发现阶段登记为日志掩码，注入步骤再次登记掩码后才交给脚本。

进入考试需要自动点击：客户端启动后停在原生检查窗口（窗口类 `ExamCheckUI`，按钮「进入考试」），**在它被点击之前不会创建任何 CEF 页面**，宿主也就没有可注入的上下文（`pageSessions` 恒为 0）。客户端二进制里没有可用的自定义命令行开关（全量字符串里只有 `--StartFragment`/`--EndFragment`/`--PO` 三处 HTML 标记），所以注入脚本 `scripts/windows-real-client-injection.ps1` 会在宿主启动后调用 `scripts/windows-client-entry.ps1`，按客户区尺寸换算按钮位置并 `PostMessage` 点击。该点击要求与客户端同完整性级别：GitHub Windows runner 与由它启动的宿主都是高完整性进程，本机手动运行时需用同一个提权上下文执行。

报告校验要求 `success`、`ownershipVerified`、`totals.pageSessions/bootstraps/bundles ≥ 1`；`stopReason` 允许 `duration`（跑满时长）或 `client-exit`（客户端先被关闭或杀掉，宿主仍会写出完整报告）。没有出现 CEF 页面时脚本会提前关闭客户端再取报告，不会把它挂到时长结束。

失败现场会落盘到 `RUNNER_TEMP` 并由 CI 作为 artifact 上传（`real-client-failure-<客户端>-<数据库>`）：`cx-real-client-<case>-environment.json`（会话 ID、窗口站/桌面名、是否远程会话、系统 DPI、虚拟屏幕与各显示器、是否提权）、`-start.png`（启动画面）、`-attempt-<n>.png`（每次点击尝试后的画面，50% 缩放）、`-desktop.png`（失败时的最终桌面）、`report.json`、宿主 stdout/stderr 与客户端 `debug.log`。进入考试日志同时打印客户端窗口类列表（`windows=...`）：出现 `ExamCheckHintUI` 说明被客户端自检拦截，出现 `Chrome_WidgetWin_0` 说明 CEF 页面已就绪。

清理阶段除了关掉客户端与残留宿主，还会调用 `scripts/windows-client-shell.ps1` 检查资源管理器：客户端退出后任务栏（`Shell_TrayWnd`）可能不再出现，此时脚本会重启 Explorer；没有交互式桌面（CI runner 的服务会话）时直接跳过，日志会打印 `shell repair action=...`。
