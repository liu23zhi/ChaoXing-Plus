using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

// Own windows only. No exam client, input synthesis, Explorer or desktop capture is involved.
public static class ClientDialogFixture {
    private delegate IntPtr WindowProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WindowClass {
        public uint style; public WindowProc proc; public int classExtra, windowExtra;
        public IntPtr instance, icon, cursor, background;
        public string menuName, className;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Message {
        public IntPtr hwnd; public uint message; public IntPtr wParam, lParam;
        public uint time; public int x, y;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassW(ref WindowClass definition);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowExW(uint extended, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetMessageW(out Message message, IntPtr hwnd, uint first, uint last);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool PostThreadMessageW(uint thread, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    private static readonly WindowProc Procedure = HandleMessage;
    private static readonly List<IntPtr> Windows = new List<IntPtr>();
    private static readonly ManualResetEvent Ready = new ManualResetEvent(false);
    private static Thread thread;
    private static uint threadId;
    private static int expectedX, expectedY;
    private static Exception startupError;
    public static IntPtr Check, Dialog, Unknown;
    public static int Clicks, WrongClicks, LastX, LastY;

    private static void Foreground(IntPtr hwnd) {
        uint owner;
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out owner);
        uint currentThread = GetCurrentThreadId();
        bool attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); }
        finally { if (attached) AttachThreadInput(currentThread, foregroundThread, false); }
    }

    private static IntPtr HandleMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam) {
        if (message == 0x0202) {
            int x = (short)(lParam.ToInt64() & 0xffff);
            int y = (short)((lParam.ToInt64() >> 16) & 0xffff);
            LastX = x; LastY = y; Interlocked.Increment(ref Clicks);
            if (hwnd == Dialog && Math.Abs(x - expectedX) <= 12 && Math.Abs(y - expectedY) <= 12) {
                DestroyWindow(hwnd);
            } else Interlocked.Increment(ref WrongClicks);
            return IntPtr.Zero;
        }
        if (message == 0x0010) { DestroyWindow(hwnd); return IntPtr.Zero; }
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }

    private static IntPtr Create(string name, int x, int y, int width, int height, bool visible) {
        WindowClass definition = new WindowClass();
        definition.proc = Procedure; definition.className = name;
        RegisterClassW(ref definition);
        bool onScreen = Environment.GetEnvironmentVariable("CX_TEST_NATIVE_WINDOW") == "1";
        IntPtr hwnd = CreateWindowExW(0x00000080, name, "Client dialog regression fixture", 0x80000000u | (visible ? 0x10000000u : 0),
            onScreen ? x : x - 20000, onScreen ? y : y - 20000, width, height, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) throw new Exception("Unable to create fixture window " + name);
        Windows.Add(hwnd);
        return hwnd;
    }

    public static void Start(string scenario) {
        Ready.Reset(); Windows.Clear(); startupError = null;
        Check = Dialog = Unknown = IntPtr.Zero; Clicks = WrongClicks = LastX = LastY = 0;
        thread = new Thread(() => {
            try {
                threadId = GetCurrentThreadId();
                Check = Create("ExamCheckUI", 360, 166, 1200, 700, true);
                if (scenario == "small") {
                    Dialog = Create("WebHintUI", 397, 247, 405, 251, true);
                    expectedX = 271; expectedY = 201;
                } else if (scenario != "none") {
                    Dialog = Create("ExamCheckHintUI", 0, 0, 1920, 1080, true);
                    expectedX = 1030; expectedY = 616;
                    // Newer invisible/degenerate windows come first in EnumWindows and must not hide
                    // the real candidate of the same class farther down the enumeration.
                    Create("ExamCheckHintUI", 0, 0, 400, 250, false);
                    Create("ExamCheckHintUI", 0, 0, 0, 0, true);
                }
                Unknown = Create("ClientUnknownFixture", 20, 20, 300, 200, true);
                Foreground(scenario == "fullscreen-focus" ? Dialog : Unknown);
                Ready.Set();
                Message message;
                while (GetMessageW(out message, IntPtr.Zero, 0, 0) > 0) {
                    TranslateMessage(ref message); DispatchMessageW(ref message);
                }
            } catch (Exception error) { startupError = error; Ready.Set(); }
            finally { foreach (IntPtr hwnd in Windows) DestroyWindow(hwnd); }
        });
        thread.IsBackground = true; thread.Start();
        if (!Ready.WaitOne(10000)) throw new Exception("Fixture startup timed out");
        if (startupError != null) throw startupError;
    }

    public static void Stop() {
        if (thread == null) return;
        PostThreadMessageW(threadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
        if (!thread.Join(10000)) throw new Exception("Fixture window thread did not stop");
        thread = null;
    }
}
