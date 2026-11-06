# 已封存（2026-11-06）

本目录保留作为**归档**：输入法伪装方案已冻结，任何 CI job、桌面准备脚本或测试都不得再调用这里的
`build-cxime.ps1`、`Install-FakeInputMethod.ps1` 或 `Probe-ImeLoad.ps1`。

- 冻结原因、已证实的结论与复活条件：`docs/ime-spoofing-freeze.md`
- 仓库不再携带 zh-CN 语言包（原 `langpack/` 已删除，约 222 MB）
- 桌面准备只保留只读 IMM 探针，状态固定为 `stand-in-frozen`

需要重新启用时，按 `docs/ime-spoofing-freeze.md` 第 6 节执行，并先取得明确授权。
