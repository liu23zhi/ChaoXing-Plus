# 私有客户端注入夹具

此目录只用于私有仓库的 GitHub Actions 真实客户端注入测试。EXE 由 Git LFS 管理，不能复制到公共仓库、发布包或测试日志。CI 只把 `chaoxing-exam-*.exe` 纳入矩阵（同目录下的其它工具安装包会被忽略）。


| 文件名版本 | 注入通道 |
| --- | --- |
| `chaoxing-exam-v4.1.4.*.exe` | `cdp-port` |
| `chaoxing-exam-v4.3.*.exe` | `dll-proxy` |

## 客户端自定义窗口消息（IG5 静态证据）

`CXExam.exe` 4.1.4.25389（x86，sha256 `9d5f785e1bcc070517bbf31f5ad2b21458a9d3b3357f63f1a4808f2eaf8cf926`）的考试窗口用一张自定义消息分发表处理服务端指令，函数为 `FUN_004d0730(WindowImplBase*, msg, …)`。从表中直接读出的四条取证/生命周期指令（其余 `0x60x`/`0x61x` 分支是 UI 与登录流程）：

| 消息 | 指令名（二进制内字符串） | 含义 |
| --- | --- | --- |
| `0x5FA` | `CLIENT_FACE_RECOGNITION_BLINK` | 人脸识别（眨眼） |
| `0x5FB` | `CLIENT_FACE_COLLECTION` | 人脸采集 |
| `0x5FC` | `CLIENT_WEB_LIFECYCLE` | 网页生命周期 |
| `0x5FD` | `CLIENT_SNAP_SHOT` | **取证抓屏入口**（服务端 `GetScreenImage` → `screenImg` BMP） |

对照关系：`0x5FD` 对应的抓屏动作最终落在 `FUN_0043a8b0`（先 `SetWindowDisplayAffinity(hwnd,0)`）→ `FUN_0043a340`（`GetDC(NULL)` + `GetDIBits` 写 BMP）→ 恢复 `WDA_MONITOR`，这就是"客户端自己拍照时会临时关掉防截屏"的完整链路，也是悬浮面板在那几百毫秒里会被拍进去的原因（`scripts/windows-client-entry.ps1` 的 `Watch-ClientCaptureGuard` 因此按亲和力 `1 -> 0` 的跳变隐藏面板）。键盘钩子一侧的 `0x61C`（IME 类组合）落到 `FUN_004d10a0()`：`KillTimer(hwnd,0x7EA)` + `SetTimer(hwnd,0x7EA,500,NULL)`，500 ms 后重设输入法——这解释了为什么注入前后必须快照并恢复键盘布局。

版本适用性：4.1.4.25512 的字符串里同样存在 `ExamCheckUI` / `ExamCheckHintUI` / `WebHintUI` / `GetScreenImage`，属同一代构建；4.3.0.4 为 Themida 加壳（`.rsrc` 仅 53 KB，读不到这些字符串），只能靠运行期 `entry.json` 的 `windowAffinity` / `keyboardHookLog` 定论。以上均为静态分析结论，不代表已在真实考试会话中逐条触发验证。

## 输入法：已冻结（不再安装）

输入法伪装（legacy IMM 布局 + 自带 IME32 模块）已于 2026-11-06 冻结：仓库不再携带 zh-CN 语言包，
zh-CN 语言包已删除；伪装输入法整包 `tools/fake-ime/` **封存归档**、不再执行，CI 不安装、不验证任何输入法。
原因（客户端判据、`ImmGetDescriptionW` 的前置条件、`1813`/`1419`、语言包需重启才生效）与复活条件见
[`docs/ime-spoofing-freeze.md`](../../docs/ime-spoofing-freeze.md)。

- 桌面准备只保留**只读**探针（`Get-ImmInputMethodProbe`）：读取 `GetKeyboardLayoutList` 与
  `ImmGetDescriptionW` 写进日志与 `cx-real-client-prep-summary.json`，状态固定为 `stand-in-frozen`，
  不写注册表、不复制模块、不改变输入法配置。
- 客户端仍可能显示「未检测到支持的输入法」；注入脚本按既有的确认框流程（`WebHintUI` /
  `ExamCheckHintUI`）继续进入考试，`prepared=false` 不再被当成注入失败。
- 不要再引入第三方输入法安装包、zh-CN 语言包或自建 IME 模块；确需验证时请在满足条件的自托管 runner 上
  按冻结记录里的步骤单独进行。

**托管 runner 的现实限制**：GitHub 的 Windows 镜像没有 zh-CN 语言载荷（`Language.Basic~~~zh-CN~0.0.1.0=NotPresent`，FOD ISO 只在 VLSC 提供），也通常没有摄像头，可能停在客户端检查提示。此时注入脚本会输出 `REAL_CLIENT_INJECTION_BLOCKED <case> reason=environment-check`（依据：窗口类含 `ExamCheckHintUI` 且 `totals.pageSessions=0`），作业不再误报成注入失败；真正的注入失败（有页面但没注入成功）仍然失败。要在 CI 上真正跑通注入，把仓库变量 `REAL_CLIENT_RUNNER` 设为满足条件的机器，例如 `["self-hosted","windows","cx-exam"]`，矩阵会自动改到那台 runner。

注入作业开始前会执行 `scripts/ci/prepare-windows-real-client-environment.ps1`：把桌面分辨率提到至少 1600x900（客户端设计面是 1200x700，默认 1024x768 会裁掉检查窗口），并只做只读的 IMM 探针（不再安装任何输入法；输入法伪装已冻结，见 `docs/ime-spoofing-freeze.md`）；不下载搜狗、不登记微软拼音/五笔、不安装 zh-CN 语言包。所有准备动作都带超时，并在缺失时用 OBS 虚拟摄像头补齐设备。缺少设备或有效输入法时，客户端可能显示「检测未通过」和「可能影响部分功能，是否仍进入考试」确认框。确认层既可能是小型 `WebHintUI`，也可能是覆盖整个桌面的 `ExamCheckHintUI`：小窗口扫描其按钮区域，全屏层只扫描中央确认区域，避免命中遮罩后的「进入考试」。只识别同进程、可见且有有效尺寸的已知窗口类，点击后须确认弹窗已消失并实际出现页面。准备日志写入 `RUNNER_TEMP/cx-real-client-prep.log` 并随 artifact 上传。

运行前后还会快照并恢复输入法：`HKCU\Keyboard Layout\Preload`、`Substitutes`、用户语言列表、当前激活布局；客户端（导入 `LoadKeyboardLayoutW` / `UnloadKeyboardLayout`）被杀后残留的自载布局会被卸载，快照与结果分别落盘为 `cx-real-client-<case>-input-before.json` / `-input-after.json`。

清理阶段除了关掉客户端与残留宿主，还会调用 `scripts/windows-client-shell.ps1` 检查资源管理器：客户端退出后任务栏（`Shell_TrayWnd`）可能不再出现，此时脚本会重启 Explorer；没有交互式桌面（CI runner 的服务会话）时直接跳过，日志会打印 `shell repair action=...`。

相关回归：`node --test --test-concurrency=4 scripts/windows-client-entry.test.mjs scripts/windows-client-dialog.test.mjs scripts/windows-client-input.test.mjs scripts/windows-client-ime-readiness.test.mjs scripts/windows-real-client-cleanup.test.mjs`。窗口夹具与现场图片扫描只验证自动化辅助流程，不代表真实客户端进入课程或考试页面验收。
