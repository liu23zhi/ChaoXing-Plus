# Sogou IMM VM Diagnostic

This folder is self-contained. Copy the whole folder to a Windows VM, then run the script there. It includes the exact Sogou installer used by the desktop-prep job and verifies its SHA256 and Authenticode signer before launching it.

## Run

Use an elevated Windows PowerShell 5.1 window in a disposable VM snapshot:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\run-sogou-imm-diagnostic.ps1
```

The script launches `sogou-ime-v16.9.0.5523.exe /S`, samples every 3 seconds for up to 180 seconds, and does not terminate the installer or any child process. It deliberately continues sampling after the launcher exits so the evidence shows whether an installer child continues, whether a Sogou layout appears in the registry, and when `ImmGetDescriptionW` first returns a non-empty description.

To observe an already-installed VM without launching the installer:

```powershell
.\run-sogou-imm-diagnostic.ps1 -ProbeOnly -TimeoutSeconds 30
```

Each run writes `results/<timestamp>/events.jsonl` and `summary.json` under this folder. `events.jsonl` contains the initial machine/installer facts, installer exit event, 3-second samples, process tree, registered IME layout keys, layout-load handles, IMM descriptions, and install-registration signals. The final `RESULT=` value distinguishes Sogou IMM readiness, another ready IMM layout, a launcher exit with a still-running child, and an exited installer with IMM still unavailable.

The script does not change the default input language or registry. It calls the same `LoadKeyboardLayoutW` and `ImmGetDescriptionW` APIs used by desktop-prep, in its own PowerShell process. Run it on a VM snapshot because the installer itself changes the VM. Do not share the full event log publicly without checking it for machine-specific paths and process details.
