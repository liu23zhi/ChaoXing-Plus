# IMM diagnostic fixture

Self-contained, read-only diagnostic for the exam client's "input method" check. Copy the folder to a
Windows machine (a VM snapshot is fine) and run it; nothing is installed or changed.

The folder name is historical: it used to carry a Sogou installer. That installer is gone (CI no longer
installs third-party input methods); the client only ever looks at `ImmGetDescriptionW`, so the probe and
input-method spoofing has been frozen, so no stand-in IME is installed (`docs/ime-spoofing-freeze.md`).

## Run

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\run-sogou-imm-diagnostic.ps1              # 30 second window, 3 second samples
.\run-sogou-imm-diagnostic.ps1 -TimeoutSeconds 5
```

Each run writes `results/<timestamp>/events.jsonl` and `summary.json` under this folder. Every sample
contains:

- `ImmDescriptions` - `GetKeyboardLayoutList` + `ImmGetDescriptionW` for every loaded HKL, exactly the
  pair `CXExam.exe` uses (`FUN_004a2780`);
- `ReadyDescriptions` - the subset with a non-empty description, i.e. what the client would count;
- `RegisteredImeLayouts` - `HKLM\SYSTEM\CurrentControlSet\Control\Keyboard Layouts` entries that carry an
  `IME file` value (an `E0xxxxxx` KLID is the only way to get a description).

`RESULT=IMM_READY` means at least one loaded layout returned a description. `RESULT=PROBE_TIMEOUT_IMM_NOT_READY`
means the client's item will fail: either no IME-marked layout is registered, or none is loaded.

## Files

| File | Purpose |
| --- | --- |
| `run-sogou-imm-diagnostic.ps1` | Read-only probe (the client's own criterion) |
| `IMM-TSF-diagnostic-report.md` | Evidence: client binary, `imm32` rules, environment findings |
| `../../docs/ime-spoofing-freeze.md` | 输入法伪装冻结记录（原 `tools/fake-ime/` 与语言包已删除） |

Run the probe on a VM snapshot if you want a clean comparison; it never writes outside its own
`results/` folder.
