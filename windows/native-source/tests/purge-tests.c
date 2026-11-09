/* 自毁兜底单元测试：关机关联、开机续删登记与待删清单（不关机、不碰发布包）。
 * 单元套件把续删登记重定向到测试专用 RunOnce 子键，不写真实自启动项；
 * 分阶段驱动（CX_PURGE_TEST_STAGE=shutdown/resume，由 scripts/vm/run-shutdown-destruct.ps1
 * 写入）刻意不重定向：CI 虚拟机要验证的就是真实 HKCU RunOnce 的登记与撤销链路。
 * 分阶段驱动的用法见 windows/native-source/README.md 的「自毁兜底」一节。 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "purge.h"

#define P_TEST_SUBKEY L"Software\\cxplus-native-purge-tests"
/* 真实登记位置：与 purge.c 的默认 run key 一致，分阶段驱动不得改写。 */
#define P_RUN_ONCE_KEY L"Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce"
#define P_PURGE_VALUE_PREFIX L"cxplus-purge-"
#define P_TEST_STAGE_ENV L"CX_PURGE_TEST_STAGE"
#define P_TEST_TARGET_ENV L"CX_PURGE_TEST_TARGET"

static DWORD failures;
static DWORD shutdownHits;

static void output(const char *text) {
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}

/* 续删脚本正文回显为 UTF-8，便于在自动化输出里核对生成结果。 */
static void wide_output(const WCHAR *text) {
    static char buffer[128 * 1024];
    int bytes;
    DWORD written = 0;
    if (!text) return;
    bytes = WideCharToMultiByte(CP_UTF8, 0, text, -1, buffer, sizeof(buffer), NULL, NULL);
    if (bytes <= 1) return;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), buffer, (DWORD)bytes - 1, &written, NULL);
}

static void check(BOOL condition, const char *message) {
    if (!condition) ++failures;
    output(condition ? "ok - " : "FAIL - ");
    output(message);
    output("\n");
}

static BOOL make_directory(const WCHAR *path) {
    return CreateDirectoryW(path, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

static BOOL write_file(const WCHAR *path, const char *text) {
    HANDLE handle;
    DWORD written = 0;
    handle = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle == INVALID_HANDLE_VALUE) return FALSE;
    WriteFile(handle, text, (DWORD)lstrlenA(text), &written, NULL);
    CloseHandle(handle);
    return TRUE;
}

static BOOL file_exists(const WCHAR *path) {
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static DWORD file_size(const WCHAR *path) {
    WIN32_FILE_ATTRIBUTE_DATA data;
    if (!GetFileAttributesExW(path, GetFileExInfoStandard, &data)) return 0;
    return data.nFileSizeLow;
}

static BOOL value_exists(const WCHAR *subKey, const WCHAR *name) {
    HKEY key = NULL;
    BOOL found;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, subKey, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) return FALSE;
    found = RegQueryValueExW(key, name, NULL, NULL, NULL, NULL) == ERROR_SUCCESS;
    RegCloseKey(key);
    return found;
}

static void clear_test_key(void) {
    HKEY key = NULL;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, P_TEST_SUBKEY, 0, KEY_ALL_ACCESS, &key) != ERROR_SUCCESS) return;
    for (;;) {
        WCHAR name[256];
        DWORD got = 256;
        if (RegEnumValueW(key, 0, name, &got, NULL, NULL, NULL, NULL) != ERROR_SUCCESS) break;
        RegDeleteValueW(key, name);
    }
    RegCloseKey(key);
    RegDeleteKeyW(HKEY_CURRENT_USER, P_TEST_SUBKEY);
}

static BOOL contains(const WCHAR *text, const WCHAR *fragment) {
    DWORD i = 0, j;
    if (!text || !fragment) return FALSE;
    while (text[i]) {
        j = 0;
        while (fragment[j] && text[i + j] == fragment[j]) ++j;
        if (!fragment[j]) return TRUE;
        ++i;
    }
    return FALSE;
}

static BOOL ascii_only(const WCHAR *text) {
    DWORD i = 0;
    while (text[i]) { if (text[i] > 126) return FALSE; ++i; }
    return TRUE;
}

static BOOL starts_with(const WCHAR *text, const WCHAR *prefix) {
    DWORD i = 0;
    if (!text || !prefix) return FALSE;
    while (prefix[i]) { if (text[i] != prefix[i]) return FALSE; ++i; }
    return TRUE;
}

/* 环境变量读取：缓冲一律走 HeapAlloc（无 CRT 构建没有栈探针，大缓冲不能上栈）。 */
static WCHAR *env_value(const WCHAR *name) {
    DWORD cap = 512;
    for (;;) {
        WCHAR *buffer = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)cap * sizeof(WCHAR));
        DWORD got;
        if (!buffer) return NULL;
        SetLastError(0);
        got = GetEnvironmentVariableW(name, buffer, cap);
        if (got > 0 && got < cap) return buffer;
        HeapFree(GetProcessHeap(), 0, buffer);
        if (got == 0) return NULL;         /* 未定义或空值：都当作没传 */
        if (got > 64u * 1024u) return NULL; /* 异常长度，拒绝 */
        cap = got + 1;
    }
}

/* 列出真实 RunOnce 里的 cxplus-purge-* 残留并返回条数：resume 阶段的断言依据。 */
static int report_prefix_values(const WCHAR *subKey, const WCHAR *prefix) {
    HKEY key = NULL;
    int count = 0, index = 0;
    DWORD cap = 2048;
    WCHAR *name;

    if (RegOpenKeyExW(HKEY_CURRENT_USER, subKey, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) return 0;
    /* RunOnce 里可能有别人写的长值：名字缓冲走堆，不用固定小数组。 */
    name = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)cap * sizeof(WCHAR));
    if (!name) { RegCloseKey(key); return 0; }
    for (;;) {
        DWORD size = cap;
        DWORD status = RegEnumValueW(key, (DWORD)index, name, &size, NULL, NULL, NULL, NULL);
        if (status == ERROR_NO_MORE_ITEMS) break;
        ++index;
        if (status == ERROR_MORE_DATA) continue;
        if (status != ERROR_SUCCESS) break;
        if (!starts_with(name, prefix)) continue;
        ++count;
        wide_output(L"  residual: ");
        wide_output(name);
        output("\n");
    }
    HeapFree(GetProcessHeap(), 0, name);
    RegCloseKey(key);
    return count;
}

static void count_shutdown(void) { ++shutdownHits; }

/* ---------- 分阶段驱动（scripts/vm/run-shutdown-destruct.ps1） ----------
 * shutdown：建目标文件 -> 登记真实 HKCU RunOnce 续删项 -> 扣留不删，等真关机。
 * resume：  重启后断言目标已删、真实 RunOnce 登记已自行撤销。
 * 这两个阶段刻意不做 run key 重定向：CI 虚拟机验证的就是生产登记链路。 */

static int stage_shutdown(const WCHAR *target) {
    CX_PURGE *purge;
    WCHAR error[256];
    int code;

    failures = 0;
    if (!target || !target[0]) {
        output("FAIL - CX_PURGE_TEST_TARGET is required for the shutdown stage\n");
        return 1;
    }
    purge = (CX_PURGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_PURGE));
    if (!purge) { output("FAIL - purge state allocation failed\n"); return 1; }

    /* root 留空：只处理显式登记的待删文件，绝不删任何目录。 */
    check(cx_purge_init(purge, L"", NULL), "purge state initialises for the staged run");
    if (!file_exists(target)) check(write_file(target, "shutdown-destruct-target"), "the pending target is created");
    check(file_exists(target), "the pending target exists before registration");
    check(cx_purge_add(purge, target, FALSE), "the pending target is queued");

    error[0] = 0;
    check(cx_purge_journal(purge, error, 256), "the boot-resume journal is registered");
    if (error[0]) { wide_output(L"  journal error: "); wide_output(error); output("\n"); }
    check(lstrcmpiW(cx_purge_run_key(purge), P_RUN_ONCE_KEY) == 0,
        "the staged run registers the real HKCU RunOnce key (no test redirection)");
    check(value_exists(cx_purge_run_key(purge), cx_purge_value_name(purge)),
        "the run-once value points at the resume script");

    wide_output(L"registered=");
    wide_output(cx_purge_value_name(purge));
    output("\n");
    wide_output(L"runKey=");
    wide_output(cx_purge_run_key(purge));
    output("\n");
    wide_output(L"journal=");
    wide_output(cx_purge_script_path(purge));
    output("\n");
    wide_output(L"target=");
    wide_output(target);
    output("\n");
    output("stage=shutdown\n");

    /* 扣留：这里不调用 cx_purge_run / cx_purge_settle，登记与删除必须分开验证。 */
    code = failures ? 1 : 0;
    cx_purge_close(purge);
    HeapFree(GetProcessHeap(), 0, purge);
    output(code ? "NATIVE PURGE STAGE FAIL\n" : "NATIVE PURGE STAGE PASS\n");
    return code;
}

static int stage_resume(const WCHAR *target) {
    int residual;

    failures = 0;
    if (!target || !target[0]) {
        output("FAIL - CX_PURGE_TEST_TARGET is required for the resume stage\n");
        return 1;
    }
    check(!file_exists(target), "the pending target was deleted across the reboot");
    residual = report_prefix_values(P_RUN_ONCE_KEY, P_PURGE_VALUE_PREFIX);
    check(residual == 0, "the run-once entry was removed once the traces were gone");
    output("stage=resume\n");
    output(failures ? "NATIVE PURGE STAGE FAIL\n" : "NATIVE PURGE STAGE PASS\n");
    return failures ? 1 : 0;
}

static void test_init_and_script_text(CX_PURGE *purge, const WCHAR *root) {
    /* 无 CRT 构建关闭了栈探针（/Gs9999999）：大缓冲必须静态或堆分配。 */
    static WCHAR text[64 * 1024];
    WCHAR scriptPath[CX_PURGE_PATH_CAP], quotePath[CX_PURGE_PATH_CAP];
    DWORD length = 0;

    check(cx_purge_init(purge, root, L"C:\\fixture\\chaoxing_plus.exe"), "purge state initialises");
    check(contains(cx_purge_value_name(purge), L"cxplus-purge-"), "the run-once value uses a random purge name");
    check(contains(cx_purge_run_key(purge), L"RunOnce"), "the default run-once key is HKCU RunOnce");
    check(contains(cx_purge_script_path(purge), L"cx-purge.ps1"), "the resume script name is stable");
    check(contains(cx_purge_journal_dir(purge), L"cx-purge-"), "the resume script lives in a private temp folder");

    lstrcpyW(scriptPath, root); lstrcatW(scriptPath, L"\\a.txt");
    lstrcpyW(quotePath, root); lstrcatW(quotePath, L"\\o'neil.txt");
    check(cx_purge_add(purge, scriptPath, FALSE), "a file is queued");
    check(cx_purge_add(purge, scriptPath, FALSE), "the same file is only queued once");
    check(cx_purge_add(purge, quotePath, FALSE), "an apostrophe path is accepted");
    check(cx_purge_add_root(purge), "the program root is queued");
    check(cx_purge_count(purge) == 2, "the queue holds two distinct paths");

    check(cx_purge_script_text(purge, text, 64 * 1024, &length) && length > 0, "the resume script text is generated");
    check(contains(text, scriptPath), "the resume script lists the queued file");
    check(contains(text, L"o''neil.txt"), "an apostrophe is escaped for PowerShell");
    check(contains(text, L"$attemptMax=16"), "the resume script bounds its attempts");
    check(contains(text, L"Remove-ItemProperty"), "the resume script unregisters once clean");
    check(contains(text, L"New-ItemProperty"), "the resume script re-registers while traces remain");
    check(contains(text, L"*.cxdel"), "the resume script sweeps renamed copies of itself");
    check(contains(text, L"$markerDir,$false"), "the resume script removes its own folder");
    check(!contains(text, L"-Recurse"), "the resume script never deletes recursively");
    wide_output(text);
}

static void test_journal(CX_PURGE *purge, const WCHAR *root) {
    WCHAR error[256];
    WCHAR extra[CX_PURGE_PATH_CAP];
    DWORD before, after;

    error[0] = 0;
    check(cx_purge_journal(purge, error, 256), "the boot-resume journal is registered");
    check(file_exists(cx_purge_script_path(purge)), "the resume script exists on disk");
    check(file_exists(cx_purge_journal_dir(purge)), "the resume folder exists on disk");
    check(value_exists(cx_purge_run_key(purge), cx_purge_value_name(purge)), "the run-once value points at the script");
    before = file_size(cx_purge_script_path(purge));
    check(cx_purge_journal(purge, error, 256), "registering twice is idempotent");
    check(file_size(cx_purge_script_path(purge)) == before, "an unchanged queue does not rewrite the script");

    lstrcpyW(extra, root); lstrcatW(extra, L"\\extra.bin");
    check(cx_purge_add(purge, extra, FALSE), "a late path can be queued");
    check(cx_purge_journal(purge, error, 256), "the journal is refreshed for a new path");
    after = file_size(cx_purge_script_path(purge));
    check(after > before, "a changed queue rewrites the resume script");
}

static void test_traces_only(CX_PURGE *purge, const WCHAR *root) {
    WCHAR path[CX_PURGE_PATH_CAP];
    int failed = 0;

    /* 多文件版语义：发布原件必须保留，根目录不得进入删除计划。 */
    cx_purge_set_traces_only(purge, TRUE);
    check(purge->tracesOnly, "trace-only mode is recorded");
    cx_purge_reset(purge);
    check(cx_purge_add_root(purge), "queuing the root is accepted in trace-only mode");
    check(!purge->rootQueued, "trace-only mode refuses to queue the program root");

    lstrcpyW(path, root); lstrcatW(path, L"\\winmm-proxy.dll");
    write_file(path, "release-file-must-survive");
    check(cx_purge_add(purge, path, FALSE), "an explicitly listed trace is still queued");
    cx_purge_run(purge, 1, &failed);
    check(!file_exists(path), "trace-only mode deletes what was explicitly listed");
    DeleteFileW(path);

    /* 复位回完整模式，避免影响后续用例。 */
    cx_purge_set_traces_only(purge, FALSE);
    check(!purge->tracesOnly, "trace-only mode can be cleared again");
}

static void test_delete_and_settle(CX_PURGE *purge, const WCHAR *root) {
    WCHAR path[CX_PURGE_PATH_CAP], parked[CX_PURGE_PATH_CAP];
    HANDLE locked = INVALID_HANDLE_VALUE;
    int failed = -1, removed;

    lstrcpyW(path, root); lstrcatW(path, L"\\winmm-proxy.dll");
    write_file(path, "dll");
    check(cx_purge_add(purge, path, FALSE), "a dll trace is queued");
    lstrcpyW(path, root); lstrcatW(path, L"\\cxdel-target.exe");
    write_file(path, "exe");
    check(cx_purge_add(purge, path, FALSE), "an executable trace is queued");
    locked = CreateFileW(path, GENERIC_READ, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    check(locked != INVALID_HANDLE_VALUE, "the second trace is opened exclusively");

    removed = cx_purge_run(purge, 2, &failed);
    check(removed > 0 && failed == 1, "a locked trace is counted as a failure");
    cx_purge_settle(purge);
    check(purge->remaining == 1, "the residual trace is detected");
    check(value_exists(cx_purge_run_key(purge), cx_purge_value_name(purge)),
        "an unresolved trace keeps the boot-resume registration");

    if (locked != INVALID_HANDLE_VALUE) CloseHandle(locked);
    removed = cx_purge_run(purge, 2, &failed);
    check(failed == 0 && !file_exists(path), "the retry removes the previously locked trace");
    (void)removed;

    /* 自身改名残留由续删脚本的 *.cxdel 通配收尾；仍在运行的 CXExam 必须保留。 */
    lstrcpyW(parked, root); lstrcatW(parked, L"\\chaoxing_plus.exe.cxdel");
    write_file(parked, "parked");
    check(file_exists(parked), "a renamed copy of the host is staged for the sweep test");
    lstrcpyW(path, root); lstrcatW(path, L"\\CXExam.exe");
    check(file_exists(path), "the exam client is still present before the final pass");

    cx_purge_settle(purge);
    check(purge->remaining == 0, "no tracked file remains after the retry");
    check(!value_exists(cx_purge_run_key(purge), cx_purge_value_name(purge)),
        "a clean purge unregisters the boot-resume entry");
    check(!file_exists(cx_purge_script_path(purge)), "a clean purge removes the resume script");
    check(file_exists(path), "a clean purge never deletes the exam client");
}

static BOOL wait_gone_file(const WCHAR *path, DWORD timeoutMs) {
    DWORD waited = 0;
    while (waited < timeoutMs) {
        if (!file_exists(path)) return TRUE;
        Sleep(100);
        waited += 100;
    }
    return !file_exists(path);
}

static void test_script_execution(CX_PURGE *purge, const WCHAR *root) {
    WCHAR path[CX_PURGE_PATH_CAP], parked[CX_PURGE_PATH_CAP];
    WCHAR error[256];

    lstrcpyW(path, root); lstrcatW(path, L"\\resume-listed.txt");
    write_file(path, "trace");
    check(cx_purge_add(purge, path, FALSE), "a trace for the resume run is queued");
    check(cx_purge_journal(purge, error, 256), "the resume journal is registered again");
    check(file_exists(cx_purge_script_path(purge)) && file_exists(path), "both the script and the trace exist");

    /* 与宿主退出路径一致：派生续删脚本，由它在进程结束后收尾。 */
    check(cx_purge_after_exit(purge), "the resume script is dispatched for the post-exit pass");
    check(wait_gone_file(path, 60000), "the dispatched resume script deletes the queued trace");
    check(wait_gone_file(cx_purge_script_path(purge), 60000), "the resume script deletes itself once clean");
    lstrcpyW(parked, root); lstrcatW(parked, L"\\chaoxing_plus.exe.cxdel");
    check(!file_exists(parked), "the resume script sweeps the renamed copy of the host");
    lstrcpyW(path, root); lstrcatW(path, L"\\CXExam.exe");
    check(file_exists(path), "the resume script keeps the exam client");
    check(!value_exists(cx_purge_run_key(purge), cx_purge_value_name(purge)),
        "the resume script drops its own run-once entry");
}

static void test_shutdown_watch(CX_PURGE *purge) {
    shutdownHits = 0;
    check(cx_purge_watch_shutdown(purge, count_shutdown), "the shutdown guard thread starts");
    check(cx_purge_simulate_shutdown(purge, FALSE), "a session-end query reaches the hidden window");
    check(shutdownHits == 1, "the operator session end triggers self-destruct once");
    check(cx_purge_simulate_shutdown(purge, TRUE), "a forced session end reaches the hidden window");
    check(shutdownHits == 2, "a forced session end also triggers self-destruct");
    cx_purge_watch_stop(purge);
    check(!cx_purge_watch_ready(purge), "stopping the guard drops its window");
}

static void test_pending_delete(const WCHAR *root) {
    WCHAR path[CX_PURGE_PATH_CAP];
    lstrcpyW(path, root); lstrcatW(path, L"\\pending-delete.txt");
    write_file(path, "trace");
    /* 需要管理员权限；这里只要求它是可调用的尽力接口，不改变断言结果。 */
    (void)cx_purge_pending_delete(path);
    check(!cx_purge_pending_delete(NULL), "an empty pending-delete path is refused");
}

void __stdcall PurgeTestMain(void) {
    WCHAR temp[CX_PURGE_PATH_CAP], root[CX_PURGE_PATH_CAP], path[CX_PURGE_PATH_CAP];
    CX_PURGE *purge;
    DWORD length;
    WCHAR *stage;
    WCHAR *target;
    int staged;

    /* 分阶段驱动优先：由 scripts/vm/run-shutdown-destruct.ps1 写环境变量调用。
       这两条路径不重定向 run key，也不跑单元套件。 */
    stage = env_value(P_TEST_STAGE_ENV);
    target = env_value(P_TEST_TARGET_ENV);
    staged = 1;
    if (stage && lstrcmpiW(stage, L"shutdown") == 0) {
        staged = stage_shutdown(target);
    } else if (stage && lstrcmpiW(stage, L"resume") == 0) {
        staged = stage_resume(target);
    } else {
        if (stage && stage[0]) {
            wide_output(L"FAIL - unknown CX_PURGE_TEST_STAGE: ");
            wide_output(stage);
            output("\n");
            staged = 1;
        } else {
            staged = -1;
        }
    }
    if (stage) HeapFree(GetProcessHeap(), 0, stage);
    if (target) HeapFree(GetProcessHeap(), 0, target);
    if (staged >= 0) ExitProcess((UINT)staged);

    clear_test_key();
    length = GetTempPathW(CX_PURGE_PATH_CAP - 32, temp);
    check(length > 0, "the temporary directory is available");
    lstrcpyW(root, temp);
    lstrcatW(root, L"cx-purge-tests-fixture");
    purge = (CX_PURGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_PURGE));
    if (!purge || !length) { output("NATIVE PURGE TESTS FAIL\n"); ExitProcess(1); return; }

    lstrcpyW(path, root); lstrcatW(path, L"\\windows");
    RemoveDirectoryW(path);
    RemoveDirectoryW(root);
    check(make_directory(root), "the fixture root is created");
    lstrcpyW(path, root); lstrcatW(path, L"\\CXExam.exe");
    write_file(path, "client-must-survive");

    test_init_and_script_text(purge, root);
    check(cx_purge_set_run_key(purge, P_TEST_SUBKEY), "the run-once key is redirected for tests");
    test_journal(purge, root);
    test_traces_only(purge, root);
    test_delete_and_settle(purge, root);
    test_shutdown_watch(purge);
    test_pending_delete(root);
    test_script_execution(purge, root);

    cx_purge_close(purge);
    HeapFree(GetProcessHeap(), 0, purge);
    clear_test_key();

    /* 清场：只剩 CXExam 时删除它再删目录。 */
    lstrcpyW(path, root); lstrcatW(path, L"\\CXExam.exe"); DeleteFileW(path);
    lstrcpyW(path, root); lstrcatW(path, L"\\pending-delete.txt"); DeleteFileW(path);
    lstrcpyW(path, root); lstrcatW(path, L"\\chaoxing_plus.exe.cxdel"); DeleteFileW(path);
    RemoveDirectoryW(root);
    output(failures ? "NATIVE PURGE TESTS FAIL\n" : "NATIVE PURGE TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
