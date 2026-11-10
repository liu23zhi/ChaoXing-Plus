# IMM 诊断夹具

自包含的只读诊断工具，原用于检查考试客户端的输入法相关行为。把整个目录复制到 Windows 机器（虚拟机快照亦可）运行即可，不安装也不修改系统。

文件夹名称为历史遗留。客户端侧的输入法伪装方案已封存，不再安装任何替身输入法。

## 运行

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\run-sogou-imm-diagnostic.ps1              # 30 秒窗口，3 秒采样
.\run-sogou-imm-diagnostic.ps1 -TimeoutSeconds 5
```

每次运行在本目录下写入 `results/<timestamp>/events.jsonl` 与 `summary.json`。它只在自身 `results/` 目录内写文件。

## 文件

| 文件 | 用途 |
| --- | --- |
| `run-sogou-imm-diagnostic.ps1` | 只读探针 |
