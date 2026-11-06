# 私有客户端注入夹具

此目录只用于私有仓库的 GitHub Actions 真实客户端注入测试。EXE 由 Git LFS 管理，不能复制到公共仓库、发布包或测试日志。CI 只把 `chaoxing-exam-*.exe` 纳入矩阵（同目录下的其它工具安装包会被忽略）。


| 文件名版本 | 注入通道 |
| --- | --- |
| `chaoxing-exam-v4.1.4.*.exe` | `cdp-port` |
| `chaoxing-exam-v4.3.*.exe` | `dll-proxy` |

## 输入法：仓库内伪装输入法

CI 不再下载或安装第三方输入法；`sogou-ime-v16.9.0.5523.exe`、`sogou-ime.json` 与
`scripts/ci/verify-sogou-resolver.ps1` 已删除。客户端按 `ImmGetDescriptionW` 是否为空筛选输入法
（IG5：`FUN_004a2780`；只有 `E0xxxxxx` 布局才可能有描述），纯 TSF 的微软拼音不满足。

- 替代方案是 `tests/fixtures/sogou-imm-vm/fake-ime/`：导出完整 IME32 接口的最小模块 `cxime.ime`，
  加上注册 `HKLM\...\Keyboard Layouts\E0F00804`、复制到 `SysWOW64`/`System32` 与
  `LoadKeyboardLayoutW` 的安装脚本；`-Verify` 只读，安装/卸载需要管理员。
- `scripts/ci/prepare-windows-real-client-environment.ps1` 会定位该夹具，必要时用 MSVC 编译，再调用
  `Install-FakeInputMethod.ps1 -DisplayName StandInInput`；就绪结果以 `ImmGetDescriptionW` 回读为准，
  写入 `cx-real-client-prep-summary.json` 的 `prepared` 与 `immPreparation`。
- 安装目录、卸载表项或 TSF profile 都不能代替就绪证据；`prepared=false` 时客户端显示「检测未通过」。

私有客户端测试在非 PR 事件（`push` / `workflow_dispatch`）自动运行，不再依赖额外的启用变量——缺少数据库变量时 discovery 会直接报错，而不是静默跳过。CI 会自动发现所有非空的 `Examination_Client_Database_*` GitHub Actions 变量，并与 `tests/private-clients/` 下每个客户端 EXE 组合。变量值必须是 `UserExamInfo.db` 的 Base64 文本（换行与空白会被忽略）；注入脚本解码后直接把字节写入解压出的 `CXExam.exe` 同目录，文件名固定为 `UserExamInfo.db`，不做任何解压。旧的 `enabled` 标记和 ZIP 载荷会在发现或注入阶段直接报错。测试结束时删除独立临时目录。新增版本需要在 `.github/workflows/ci.yml` 的版本规则中声明注入通道。

配置示例：

```powershell
# 生成变量值
[Convert]::ToBase64String([IO.File]::ReadAllBytes('UserExamInfo.db'))
# 本地验证（不启动客户端）：变量值必须以 UserExamInfo.db 的完整字节解码出来
```

GitHub 对单个配置变量有 48 KB 上限（base64 会把字节放大约 1/3），因此上述变量只适合体积较小的数据库夹具；当前夹具解码后为 12288 字节。变量总容量受组织与仓库变量合计上限约束；载荷更大时应改用 Git LFS 管理数据库夹具（工作流当前只读取 `vars`，不读取 Secret）。

发现日志只输出变量名；变量值在发现阶段登记为日志掩码，注入步骤再次登记掩码后才交给脚本。

进入考试需要自动点击：客户端启动后停在原生检查窗口（窗口类 `ExamCheckUI`，按钮「进入考试」），**在它被点击之前不会创建任何 CEF 页面**，宿主也就没有可注入的上下文（`pageSessions` 恒为 0）。客户端二进制里没有可用的自定义命令行开关（全量字符串里只有 `--StartFragment`/`--EndFragment`/`--PO` 三处 HTML 标记），所以注入脚本 `scripts/windows-real-client-injection.ps1` 会在宿主启动后调用 `scripts/windows-client-entry.ps1`，先置前检查窗口，再扫描可见按钮并用 `PostMessage` 点击。按钮兜底坐标按窗口 DPI 换算，不能按客户区尺寸缩放。该点击要求与客户端同完整性级别：GitHub Windows runner 与由它启动的宿主都是高完整性进程，本机手动运行时需用同一个提权上下文执行。

报告校验要求 `success`、`ownershipVerified`、`totals.pageSessions/bootstraps/bundles ≥ 1`；`stopReason` 允许 `duration`（跑满时长）或 `client-exit`（客户端先被关闭或杀掉，宿主仍会写出完整报告）。没有出现 CEF 页面时脚本会提前关闭客户端再取报告，不会把它挂到时长结束。

注入脚本默认带 `-PanelAllPages`（宿主参数 `--panel-all-pages`，CI 显式传入），非考试页（登录、课程、跳转页）也挂载悬浮面板。原因是**考试窗口自己做了防截屏**：`CXExam.exe` 在考试窗口初始化时调用 `SetWindowDisplayAffinity(hwnd, WDA_MONITOR)`（IG5 静态证据：`0x44d510` 为 `push 1` → `user32!SetWindowDisplayAffinity`，调用者 `0x4d1120` 与该窗口的 `HWND` 登记同一函数；`0x44d550` 用 `push 0` 恢复），此后任何 GDI 屏幕拷屏在该窗口区域只能读到纯黑（`cx-real-client-<case>-4-after-confirm.png` 曾 100% 为 0x000000）。所以"进入考试之后"的现场截图无法用于人工确认，确认点必须放在受保护之前的页面上；需要恢复"仅考试页显示面板"时用 `-PanelAllPages:$false`。

现场会落盘到 `RUNNER_TEMP` 并由 CI 以 `compression-level: 0` 原样打包上传（artifact 名 `real-client-<客户端>-<数据库>`，成功与失败都上传；PNG 不再被二次压缩，下载后可用 `cx-real-client-<case>-sha256.txt` 里的 SHA256 逐字节校验）：`cx-real-client-<case>-environment.json`（会话 ID、窗口站/桌面名、是否远程会话、系统 DPI、虚拟屏幕与各显示器、是否提权）、`-start.png`（启动画面）、`-attempt-<n>.png`（每次点击尝试后的画面，50% 缩放）、`-desktop.png`（失败时的最终桌面）、`report.json`、宿主 stdout/stderr 与客户端 `debug.log` / `input.txt`。进入考试日志同时打印客户端窗口类列表（`windows=...`）：`ExamCheckHintUI` 表示出现了检查提示；`Chrome_WidgetWin_0` 也可能只是未加载页面的隐藏窗口，不能代替 `/json/list` 与报告中的页面会话证据。

截图有两套，必须同时保留：桌面截图（`Save-EntryFrame` / `Save-DesktopScreenshot`，`Graphics.CopyFromScreen`）记录桌面真实像素，考试窗口被 `WDA_MONITOR` 保护后它就是纯黑——这正是"窗口受保护"的证据，不能因为黑就删掉；页内截图走客户端自己的 DevTools 端点（`/json/list` → `Page.captureScreenshot`，实现见 `scripts/windows-client-cdp.ps1`），由渲染进程出图，不受显示亲和性影响，因此可读，且包含注入后的面板。落盘名字：`-<帧名>-cdp.png`（与 `3-confirm-dialog` / `4-after-confirm` 等桌面帧一一对应）、`-cdp-page.png`（进入考试后立即抓）、`-cdp-final.png`（关闭客户端前抓，含注入结果）。页内截图是 best-effort：没有页面目标、CDP 报错或返回非 PNG 时只打印 `cdp ... unavailable` 并保留桌面截图，不影响报告校验。

**拍照窗口期隐藏面板**：客户端的取证抓屏（服务端 `GetScreenImage`）会先把自己的 `WDA_MONITOR` 关掉再 `GetDC(NULL)` 拷整屏上传（IG5：`FUN_0043a8b0` → `FUN_0043a340`），打开的面板会被一起拍进去。注入脚本因此在本进程 runspace 里跑一个守卫（`Watch-ClientCaptureGuard`，不新起进程）：每 200 ms 读客户端可见顶层窗口的 `GetWindowDisplayAffinity`，发现某窗口从 `1` 跳到 `0` 就用 CDP 调 `window.__CX_WIN_APPLY_CAPTURE_GUARD__()` 立刻隐藏面板壳（`html[data-cx-win-capture="hide"]`），跳回 `1` 再恢复；窗口消失时兜底恢复。日志里是 `capture guard on/off window=...` 与收尾的 `capture guard events=<n>`，可据此确认守卫真的抓到了拍照窗口期。

**托管 runner 的现实限制**：GitHub 的 Windows 镜像没有 zh-CN 语言载荷（`Language.Basic~~~zh-CN~0.0.1.0=NotPresent`，FOD ISO 只在 VLSC 提供），也通常没有摄像头，可能停在客户端检查提示。此时注入脚本会输出 `REAL_CLIENT_INJECTION_BLOCKED <case> reason=environment-check`（依据：窗口类含 `ExamCheckHintUI` 且 `totals.pageSessions=0`），作业不再误报成注入失败；真正的注入失败（有页面但没注入成功）仍然失败。要在 CI 上真正跑通注入，把仓库变量 `REAL_CLIENT_RUNNER` 设为满足条件的机器，例如 `["self-hosted","windows","cx-exam"]`，矩阵会自动改到那台 runner。

注入作业开始前会执行 `scripts/ci/prepare-windows-real-client-environment.ps1`：把桌面分辨率提到至少 1600x900（客户端设计面是 1200x700，默认 1024x768 会裁掉检查窗口），并用仓库内伪装输入法（`tests/fixtures/sogou-imm-vm/fake-ime/`，客户端只接受 `ImmGetDescriptionW` 非空的 `E0xxxxxx` 布局）准备输入法；不再下载或安装搜狗、不再登记微软拼音/五笔、不再安装 zh-CN 语言包。所有准备动作都带超时，并在缺失时用 OBS 虚拟摄像头补齐设备。缺少设备或有效输入法时，客户端可能显示「检测未通过」和「可能影响部分功能，是否仍进入考试」确认框。确认层既可能是小型 `WebHintUI`，也可能是覆盖整个桌面的 `ExamCheckHintUI`：小窗口扫描其按钮区域，全屏层只扫描中央确认区域，避免命中遮罩后的「进入考试」。只识别同进程、可见且有有效尺寸的已知窗口类，点击后须确认弹窗已消失并实际出现页面。准备日志写入 `RUNNER_TEMP/cx-real-client-prep.log` 并随 artifact 上传。

运行前后还会快照并恢复输入法：`HKCU\Keyboard Layout\Preload`、`Substitutes`、用户语言列表、当前激活布局；客户端（导入 `LoadKeyboardLayoutW` / `UnloadKeyboardLayout`）被杀后残留的自载布局会被卸载，快照与结果分别落盘为 `cx-real-client-<case>-input-before.json` / `-input-after.json`。

清理阶段除了关掉客户端与残留宿主，还会调用 `scripts/windows-client-shell.ps1` 检查资源管理器：客户端退出后任务栏（`Shell_TrayWnd`）可能不再出现，此时脚本会重启 Explorer；没有交互式桌面（CI runner 的服务会话）时直接跳过，日志会打印 `shell repair action=...`。

相关回归：`node --test --test-concurrency=4 scripts/windows-client-entry.test.mjs scripts/windows-client-dialog.test.mjs scripts/windows-client-input.test.mjs scripts/windows-client-ime-readiness.test.mjs scripts/windows-real-client-cleanup.test.mjs`。窗口夹具与现场图片扫描只验证自动化辅助流程，不代表真实客户端进入课程或考试页面验收。
