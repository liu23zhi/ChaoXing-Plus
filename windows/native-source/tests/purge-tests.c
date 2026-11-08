/* 自毁兜底单元测试：关机关联、开机续删登记与待删清单（不关机、不碰发布包）。
 * 续删登记使用测试专用 RunOnce 子键，不写真实自启动项。 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "purge.h"

#define P_TEST_SUBKEY L"Software\\cxplus-native-purge-tests"

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

static void count_shutdown(void) { ++shutdownHits; }

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
