> **已封存（2026-11-06）**：输入法伪装已冻结。本目录仅作归档，CI 与桌面准备脚本都不再调用它；
> 语言包 `langpack/` 已删除。原因、已证实结论与复活条件见 `docs/ime-spoofing-freeze.md`。
# 伪装输入法（stand-in IME）工具

用途：让 `CXExam.exe` 的「输入法检测」通过，而不安装任何真实第三方输入法。
原理见上一级目录的 `IMM-TSF-diagnostic-report.md`；这里只给可执行的步骤。

## 为什么需要它

客户端判定逻辑（v4.1.4.25389，`FUN_004a2780`）是：

1. `GetKeyboardLayoutList()` 取当前已加载的键盘布局；
2. 对每个 HKL 调 `ImmGetDescriptionW(hkl, buf, 0x400)`；
3. 只有返回非空字符串的布局才会被记录为「可用输入法」。

而 `imm32!ImmGetDescriptionW` 只对 **IME 标记的 HKL**（高 16 位最高半字节为 `0xE`，
即 KLID 形如 `E0xxxxxx`）返回描述，并且要 `ImmGetImeInfoEx` 成功——它会按注册表
`IME file` 去加载 IME 模块。所以：

- 纯 TSF 输入法（微软拼音、搜狗的 TSF 组件）永远拿不到描述；
- 只写注册表、没有可加载 IME 模块的「假布局」也拿不到描述；
- 需要「注册表布局 + 一个能正常 `ImeInquire` 的 `.ime` 模块」。

本目录提供的就是这个最小模块 `cxime.ime`（16 个 IME32 导出，全部惰性实现，
不合成任何文字），外加注册/验证/卸载脚本。

模块必须带 VERSIONINFO 资源（`cxime.rc`，由 `build-cxime.ps1` 编译进 DLL）：缺版本资源时
`LoadKeyboardLayoutW` 返回 `1813 ERROR_RESOURCE_TYPE_NOT_FOUND` —— 注册表看着完全正常，
布局却加载不进会话。KLID 也不再写死：默认按系统默认输入语言取末四位（`E0F0` + 语言），
zh-CN 机器得到 `E0F00804`，纯英文 runner 得到 `E0F00409`，这样同一套脚本在两种镜像上都能就绪。

## 文件

| 文件 | 说明 |
| --- | --- |
| `cxime.c` | 最小 IME32 模块源码（x86 / x64 通用） |
| `cxime.def` | 导出表，保证导出名不带 stdcall 修饰 |
| `build-cxime.ps1` | 用 MSVC 编译 `build\cxime32.dll`、`build\cxime64.dll`（仓库不携带预编译产物，CI 现场编译） |
| `cxime.rc` | VERSIONINFO 资源（缺它 `LoadKeyboardLayoutW` 会返回 1813） |
| `Install-FakeInputMethod.ps1` | 安装 / 验证 / 卸载 |
| `Probe-ImeLoad.ps1` | 只读 A/B 探针：分别尝试加载系统 `msctfime.ime` 与 `cxime.ime` 的临时布局，判断是子系统还是模块的问题 |
| `langpack/WinSrv2025-zhCN-LanguagePack.zip` | Windows Server 2025 zh-CN 语言包（Git LFS，~222 MB）：CI 用它装东亚语言支持；job 的 checkout 必须带 `lfs: true`，否则工作区只有 134 字节指针 |

## 使用

```powershell
# 1. 编译（任意 PowerShell，不需要管理员）
pwsh -File .\build-cxime.ps1

# 2. 只看当前状态（不需要管理员）
pwsh -File .\Install-FakeInputMethod.ps1 -Verify

# 3. 安装（管理员 PowerShell）
pwsh -File .\Install-FakeInputMethod.ps1 -DisplayName "ExamInput"

# 4. 重新验证（新开一个进程即可，布局是会话级共享的）
pwsh -File .\Install-FakeInputMethod.ps1 -Verify

# 5. 卸载（管理员）
pwsh -File .\Install-FakeInputMethod.ps1 -Uninstall
```

安装做的事：

1. 备份到 `%TEMP%\cx-fake-ime-<klid>.json`；
2. 复制 `cxime32.dll` → `%WINDIR%\SysWOW64\cxime.ime`，`cxime64.dll` → `%WINDIR%\System32\cxime.ime`；
3. 写 `HKLM\SYSTEM\CurrentControlSet\Control\Keyboard Layouts\E0F0<语言>`：
   `Layout File=kbdus.dll`、`Layout Text=<DisplayName>`、`IME file=cxime.ime`；
4. 在 `HKCU\Keyboard Layout\Preload` 追加一项（下次登录仍然在）；
5. `LoadKeyboardLayoutW(KLID, 0)`（失败再试 `KLF_SUBSTITUTE_OK`），把布局加载进当前会话；
6. 默认把该布局设为默认输入语言（`-NoDefault` 可跳过）；
7. 用 `GetKeyboardLayoutList` + `ImmGetDescriptionW` 复核，输出 `RESULT=IME_READY`。

## 参数

| 参数 | 作用 |
| --- | --- |
| `-Klid` | 布局 KLID，必须 `E0xxxxxx`；默认空 = 按系统默认输入语言推导（`E0F0` + 末四位，zh-CN 得 `E0F00804`，纯英文 runner 得 `E0F00409`） |
| `-DisplayName` | `Layout Text`，就是客户端读到的描述（默认 `ExamInput`） |
| `-ImeFile` | IME 模块名或已有模块（如 `SogouPY.ime`），默认 `cxime.ime` |
| `-Verify` | 只读探测，退出码 0=就绪，1=未就绪 |
| `-Uninstall` | 删除布局、Preload 项和本工具复制的模块 |
| `-NoPreload` / `-NoDefault` | 不写 Preload / 不设默认输入语言 |
| `-ClientPath` | 安装成功后顺带启动客户端 |

## 已验证 / 未验证

CI（`.github/workflows/ci.yml` 的 `windows-fake-ime` job）在管理员 runner 上执行完整链路：
编译 → **上传 `cx-fake-ime-modules` artifact** → 记录安装前基线 → 安装 → 64 位复核 →
**32 位 PowerShell 复核（与 `CXExam.exe` 同位数）** → 卸载 → 确认探针结果与安装前基线一致。
真实客户端 job 用 `actions/download-artifact` 把该 artifact 解到 `tools/fake-ime/build`，直接复用现成模块，
不再重复编译；artifact 缺失时才由准备脚本现场编译兜底。

### legacy IMM 需要东亚语言支持

MSDN 对 [`ImmInstallIMEW`](https://learn.microsoft.com/en-us/windows/win32/api/imm/nf-imm-imminstallimew)
的最低要求写的是 “Windows XP [desktop apps only], **East Asian language support installed**”。
hosted `windows-latest` 只有 en-US（`Language.Basic~~~zh-CN = NotPresent`）。job 会解压仓库内置的 `langpack/WinSrv2025-zhCN-LanguagePack.zip`，**直接运行包内 `Install-zhCN-Language.ps1 -NoReboot`**（它自己执行 `dism /Add-Package` → 各 `dism /Add-Capability ... /Source:<repo> /LimitAccess` → 区域设置），整段限时 1800 秒。该包只保证 **Windows Server 2025（10.0.26100）**，README 明确不建议用于其它版本；job 会先核对 build 号，不是 26100 只打告警、仍按要求尝试安装。仍然不可用时才降级，在没装成功的机器上：

- `ImmInstallIMEW` 返回 `NULL` 且 `GetLastError()=0`；
- 手写 `E0xx` 布局后 `LoadKeyboardLayoutW` 返回 `1419 ERROR_HOTKEY_NOT_REGISTERED`；
- 即使先用 `KLF_ACTIVATE` 载入 `00000804` 基础布局也无济于事（缺的是语言载荷，不是布局键）。

这不是脚本缺陷：装完语言包再查 `Language.Basic~~~zh-CN`，仍不是 `Installed` 就打 warning 并跳过安装/复核；
装上了却仍加载失败时，`Probe-ImeLoad.ps1` 的对照结果（系统 IME 与占位模块分别能否加载）会把原因定位到子系统还是模块
（`CX_FAKE_IME_HOST=0`）。想真验证也可以把仓库变量 `FAKE_IME_RUNNER` 指向带 zh-CN 的 self-hosted runner，
例如 `["self-hosted","windows","zh-cn"]`。桌面准备遇到同一限制时记录 `stand-in-host-unavailable`。

本机只读验证过：

- `GetKeyboardLayoutList` 返回的是**会话级共享**列表：一个进程 `LoadKeyboardLayoutW`
  之后，另一个进程也能看到该 HKL，且加载进程退出后仍然保留（实测 `0x04100410`）。
- 未注册的 KLID（`E0F00804`）调用 `LoadKeyboardLayoutW` 失败（`GetLastError=1419`），
  所以注册表项是必须的。
- 普通布局（`0x08040804` / `0x04090409`，以及实测加载的 `0x04100410`）
  `ImmGetDescriptionW` 恒为 0，符合 imm32 里 `(hkl>>16)&0xF000 == 0xE000` 的判断。

未在本机验证：

- 需要管理员写 `HKLM` 与 `System32`，本机当前会话无法完成；
  `-Verify` 现在返回 `IME_NOT_READY`（本机没有任何带 `IME file` 的布局）。
- `cxime.ime` 的加载路径（`ImmGetImeInfoEx` → `ImmLoadLayout` → `ImeInquire`）
  没有在真实提权环境跑过；失败时脚本会打印空描述并给出排查提示。

## 回滚

`-Uninstall` 会删除注册表项、Preload 项和 `SysWOW64\cxime.ime` / `System32\cxime.ime`。
默认输入语言若已被改成该布局，请在「设置 → 时间和语言 → 语言」里改回，或重新登录。
备份文件 `%TEMP%\cx-fake-ime-<klid>.json` 记录安装前的键值与 Preload 快照。
