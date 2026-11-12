# 轮询漏检率基准测试（t138）
#
# 问题：Watch-ClientCaptureGuard（windows-client-entry.ps1:538-595）按 200ms 轮询
#       GetWindowDisplayAffinity，检测 1→0 跳变。若客户端「关保护 → GetDC → 恢复」
#       的整个窗口期 W 短于一个采样间隔，可能一次都采不到 → 面板被拍进证据。
#
# 本脚本回答：在各类 W 下，单次抓屏事件被检测到的概率是多少。
#
# === 两次返工的教训（记录在此，避免以后重犯）===
#
# 第 1 版：让窗口高频切换（half=5ms → 1200ms 切 246 次），统计「1200ms 内有没有
#   检出任一跳变」。结果 W=5ms 也 100% 命中。错因：切换次数太多，累积检出掩盖了
#   单次漏检；且真实客户端的抓屏是**偶发**事件，不是高频切换。
#
# 第 2 版：改成单次事件，但**在设置 WDA_NONE 之后立刻采样**——采样点与事件起始
#   强耦合，必然采到，结果仍是 W=10ms 100% 命中（理论 5%）。
#
# 第 3 版（本版）：把**采样线程**与**事件插入**彻底分离到两个时间轴。
#   - 采样线程：独立后台线程，按固定节奏 T 采样，记录每次的 (t, affinity)
#   - 事件插入：主线程在随机相位把窗口切到 NONE，持续 W，再切回
#   - 判定：事件区间 [s, s+W) 内，采样线程有没有取到 affinity=0
#   这样采样相位与事件相位独立，命中率才等于 min(1, W/T)。

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;

public class WdaBench2 {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASS {
        public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
        public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
        public string lpszMenuName; public string lpszClassName;
    }

    public delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern ushort RegisterClassW(ref WNDCLASS c);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style,
        int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] public static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string n);

    public static WndProc keepProc;
    public static EnumWindowsProc keepEnum;

    public static IntPtr CreateFixture(string cls) {
        WNDCLASS wc = new WNDCLASS();
        keepProc = new WndProc(DefWindowProcW);
        wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(keepProc);
        wc.hInstance = GetModuleHandleW(null);
        wc.lpszClassName = cls;
        ushort atom = RegisterClassW(ref wc);
        if (atom == 0) {
            int e = Marshal.GetLastWin32Error();
            if (e != 1410) return IntPtr.Zero;
        }
        return CreateWindowExW(0, cls, "wda-bench", 0x10000000,
            0, 0, 10, 10, IntPtr.Zero, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
    }

    // 复刻 CXClientEntry.WindowAffinities：EnumWindows 过滤本进程可见窗口，取 affinity
    public static bool ReadAffinityOf(uint processId, IntPtr want, out int affinity) {
        int found = -999;
        IntPtr target = want;
        keepEnum = (handle, parameter) => {
            if (handle != target) return true;
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner != processId) return true;
            uint a;
            bool ok = GetWindowDisplayAffinity(handle, out a);
            found = ok ? (int)a : -1;
            return false;
        };
        EnumWindows(keepEnum, IntPtr.Zero);
        affinity = found;
        return found != -999;
    }

    // 独立采样线程：按 periodMs 采样，记录 (elapsedMs, affinity)
    public class Sampler {
        public volatile bool Stopped;
        public List<long> Times = new List<long>();
        public List<int> Values = new List<int>();
        public Thread Start(IntPtr hwndValue, uint pid, int periodMs) {
            var t = new Thread(() => {
                var sw = Stopwatch.StartNew();
                while (!Stopped) {
                    int a;
                    long now = sw.ElapsedMilliseconds;
                    if (ReadAffinityOf(pid, hwndValue, out a)) {
                        Times.Add(now);
                        Values.Add(a);
                    }
                    long next = now + periodMs;
                    while (sw.ElapsedMilliseconds < next && !Stopped) Thread.Sleep(1);
                }
                Sw = sw;
            });
            t.IsBackground = true;
            t.Start();
            return t;
        }
        public Stopwatch Sw;
    }
}
'@

$fixtureHandle = [WdaBench2]::CreateFixture("WdaBench2Cls$([guid]::NewGuid().ToString('N'))")
if ($fixtureHandle -eq [IntPtr]::Zero) { throw 'fixture window creation failed' }

$fixturePid = [uint32]$PID
$rows = @()

try {
    foreach ($windowMs in @(10, 20, 50, 100, 150, 200, 250, 300, 400)) {
        $trials = 24
        $hits = 0

        for ($i = 0; $i -lt $trials; $i++) {
            [void][WdaBench2]::SetWindowDisplayAffinity($fixtureHandle, 1)   # 稳定在保护态
            Start-Sleep -Milliseconds 30

            $sampler = New-Object WdaBench2+Sampler
            $thread = $sampler.Start($fixtureHandle, $fixturePid, 200)

            # 随机相位：让事件起始落在采样周期的任意位置
            Start-Sleep -Milliseconds (Get-Random -Minimum 20 -Maximum 190)

            $sw = [Diagnostics.Stopwatch]::StartNew()
            [void][WdaBench2]::SetWindowDisplayAffinity($fixtureHandle, 0)   # 事件：关保护
            $eventStart = $sw.ElapsedMilliseconds
            Start-Sleep -Milliseconds $windowMs
            $eventEnd = $sw.ElapsedMilliseconds
            [void][WdaBench2]::SetWindowDisplayAffinity($fixtureHandle, 1)   # 事件：恢复

            # 再等一个采样周期，确保采样线程有时间记录
            Start-Sleep -Milliseconds 260
            $sampler.Stopped = $true
            $thread.Join(2000)

            # 判定：采样时刻落在 [eventStart, eventEnd) 内且读到 0
            # 注意采样线程与事件用不同 stopwatch，用"采样点在事件前后的相对关系"近似：
            # 记录到的 0 值即为命中（窗口在事件外始终为 1）
            $hitEvent = $false
            for ($k = 0; $k -lt $sampler.Values.Count; $k++) {
                if ($sampler.Values[$k] -eq 0) { $hitEvent = $true; break }
            }
            if ($hitEvent) { $hits++ }
        }

        $rows += [pscustomobject]@{
            '窗口期 W(ms)' = $windowMs
            '试验次数'     = $trials
            '采到'         = $hits
            '漏检'         = ($trials - $hits)
            '实测命中率'   = ('{0:P0}' -f ($hits / $trials))
            '理论命中率'   = ('{0:P0}' -f ([Math]::Min(1.0, $windowMs / 200.0)))
        }
    }
} finally {
    [void][WdaBench2]::DestroyWindow($fixtureHandle)
}

Write-Host ''
Write-Host '===== 单次抓屏事件被 200ms 独立轮询采到的概率 ====='
$rows | Format-Table -AutoSize | Out-String -Width 140 | Write-Host
$rows | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $env:TEMP 'wda-bench-result.json') -Encoding UTF8
Write-Host "结果已写入 $env:TEMP\wda-bench-result.json"
