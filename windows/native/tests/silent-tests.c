/* 原生静默场景单元测试：自毁状态机 + 程序痕迹清理（不启动客户端、不碰发布包）。 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "silent.h"

static DWORD failures;

static void output(const char *text) {
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
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

static BOOL plan_contains(const CX_CLEANUP_PLAN *plan, const WCHAR *fragment) {
    int index;
    for (index = 0; index < plan->count; ++index) {
        const WCHAR *path = plan->items[index].path;
        DWORD i = 0, j = 0;
        /* 大小写不敏感的子串匹配（避免 CRT）。 */
        while (path[i]) {
            j = 0;
            while (fragment[j]) {
                WCHAR a = path[i + j], b = fragment[j];
                if (a >= L'A' && a <= L'Z') a = (WCHAR)(a - L'A' + L'a');
                if (b >= L'A' && b <= L'Z') b = (WCHAR)(b - L'A' + L'a');
                if (a != b) break;
                ++j;
            }
            if (!fragment[j]) return TRUE;
            ++i;
        }
    }
    return FALSE;
}

static void test_state_machine(void) {
    CX_SILENT silent;
    WCHAR reason[CX_SILENT_REASON_CAP];

    cx_silent_init(&silent, TRUE);
    check(silent.state == CX_SILENT_IDLE && silent.keyCount == 2, "silent state starts idle with two keys");
    check(!cx_silent_hotkey(&silent, L"F8"), "hotkey is ignored before a client starts");
    check(!cx_silent_fullscreen(&silent, TRUE, 4242), "fullscreen is ignored before a client starts");
    check(!cx_silent_client_exited(&silent, 4242), "process exit is ignored before a client starts");

    check(cx_silent_client_started(&silent, 4242), "owned client attaches");
    check(!cx_silent_client_started(&silent, 4343), "a second attach is refused");
    check(!cx_silent_fullscreen(&silent, FALSE, 4242), "fullscreen exit without entering fullscreen does nothing");
    check(silent.state == CX_SILENT_WATCHING, "state stays watching after a stray exit event");
    check(cx_silent_fullscreen(&silent, TRUE, 4242), "entering fullscreen is recorded");
    check(silent.state == CX_SILENT_FULLSCREEN_SEEN, "state becomes fullscreen-seen");
    check(cx_silent_fullscreen(&silent, FALSE, 4242), "leaving fullscreen requests destruction");
    check(silent.state == CX_SILENT_DESTRUCT_REQUESTED, "state becomes destruct-requested");
    check(cx_silent_finish(&silent, reason, CX_SILENT_REASON_CAP) && !lstrcmpW(reason, L"fullscreen-exit"),
        "destruction reports the fullscreen-exit reason once");
    check(!cx_silent_finish(&silent, reason, CX_SILENT_REASON_CAP), "destruction cannot be finished twice");

    cx_silent_init(&silent, TRUE);
    cx_silent_client_started(&silent, 7);
    check(cx_silent_hotkey(&silent, L"ctrl+alt+shift+e") && silent.requested, "ctrl+alt+shift+e triggers destruction");
    check(cx_silent_finish(&silent, reason, CX_SILENT_REASON_CAP) && !lstrcmpW(reason, L"shortcut"),
        "hotkey destruction reports the shortcut reason");

    cx_silent_init(&silent, TRUE);
    cx_silent_client_started(&silent, 9);
    check(cx_silent_hotkey(&silent, L"f8"), "F8 triggers destruction");
    cx_silent_finish(&silent, reason, CX_SILENT_REASON_CAP);

    cx_silent_init(&silent, TRUE);
    cx_silent_client_started(&silent, 11);
    check(!cx_silent_hotkey(&silent, L"ctrl+alt+shift+s"), "the manual answer key never destroys");
    check(cx_silent_client_exited(&silent, 11) && silent.requested, "client exit without fullscreen still destroys");

    cx_silent_init(&silent, FALSE);
    cx_silent_client_started(&silent, 12);
    cx_silent_fullscreen(&silent, TRUE, 12);
    check(!cx_silent_fullscreen(&silent, FALSE, 12), "fullscreen exit is ignored when the rule is disabled");
}

static void test_cleanup(void) {
    WCHAR root[CX_CLEANUP_PATH_CAP], temp[CX_CLEANUP_PATH_CAP];
    CX_CLEANUP_PLAN *plan;
    WCHAR parked[CX_CLEANUP_PATH_CAP];
    DWORD length;
    int deleted, failed;
    HANDLE locked = INVALID_HANDLE_VALUE;

    length = GetTempPathW(CX_CLEANUP_PATH_CAP - 32, temp);
    if (!length) { check(FALSE, "temporary directory is available"); return; }
    lstrcpyW(root, temp);
    lstrcatW(root, L"cx-silent-tests-");
    lstrcatW(root, L"fixture");
    RemoveDirectoryW(root);
    check(make_directory(root), "fixture root created");

    lstrcpyW(temp, root); lstrcatW(temp, L"\\chaoxing_plus.exe");
    write_file(temp, "exe");
    lstrcpyW(temp, root); lstrcatW(temp, L"\\start-windows-silent.cmd");
    write_file(temp, "cmd");
    lstrcpyW(temp, root); lstrcatW(temp, L"\\CXExam.exe");
    write_file(temp, "client-must-survive");
    lstrcpyW(temp, root); lstrcatW(temp, L"\\runtime");
    make_directory(temp);
    lstrcpyW(temp, root); lstrcatW(temp, L"\\runtime\\node.exe");
    write_file(temp, "runtime-must-survive");
    lstrcpyW(temp, root); lstrcatW(temp, L"\\dist-windows");
    make_directory(temp);
    lstrcpyW(temp, root); lstrcatW(temp, L"\\dist-windows\\windows-bootstrap.js");
    write_file(temp, "asset");
    lstrcpyW(temp, root); lstrcatW(temp, L"\\windows");
    make_directory(temp);
    lstrcpyW(temp, root); lstrcatW(temp, L"\\windows\\host");
    make_directory(temp);
    lstrcpyW(temp, root); lstrcatW(temp, L"\\windows\\host\\main.mjs");
    write_file(temp, "host");
    lstrcpyW(temp, root); lstrcatW(temp, L"\\windows\\data");
    make_directory(temp);
    lstrcpyW(temp, root); lstrcatW(temp, L"\\windows\\data\\config.json");
    write_file(temp, "data");

    plan = (CX_CLEANUP_PLAN *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_CLEANUP_PLAN));
    if (!plan) { check(FALSE, "cleanup plan allocated"); return; }
    check(!cx_cleanup_is_release_layout(root), "a source/build tree is not a trusted release layout");
    lstrcpyW(temp, root); lstrcatW(temp, L"\\SHA256SUMS.txt"); write_file(temp, "hash *file\n");
    check(cx_cleanup_is_release_layout(root), "SHA256SUMS.txt marks a trusted release layout");
    DeleteFileW(temp);
    check(cx_cleanup_collect(root, plan), "cleanup plan collected");
    check(plan->truncated == 0, "cleanup plan is not truncated");
    check(plan->protectedCount == 1, "exactly one CXExam file is protected");
    check(!plan_contains(plan, L"CXExam.exe"), "CXExam never enters the deletion plan");
    check(!plan_contains(plan, L"runtime"), "runtime directory never enters the deletion plan");
    check(plan_contains(plan, L"windows\\host\\main.mjs"), "host modules are scheduled for deletion");
    check(plan_contains(plan, L"windows\\data\\config.json"), "host data files are scheduled for deletion");

    deleted = cx_cleanup_apply(plan, TRUE, 5, &failed);
    lstrcpyW(temp, root); lstrcatW(temp, L"\\chaoxing_plus.exe");
    check(deleted > 0 && failed == 0 && file_exists(temp), "simulated cleanup deletes nothing");

    /* 被独占打开的文件必须失败并计数，关闭后第二次调用才删除。 */
    lstrcpyW(temp, root); lstrcatW(temp, L"\\start-windows-silent.cmd");
    locked = CreateFileW(temp, GENERIC_READ, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    deleted = cx_cleanup_apply(plan, FALSE, 2, &failed);
    check(locked != INVALID_HANDLE_VALUE && failed == 1, "a locked file is reported as a failure");
    if (locked != INVALID_HANDLE_VALUE) CloseHandle(locked);
    deleted = cx_cleanup_apply(plan, FALSE, 2, &failed);
    check(failed == 0 && !file_exists(temp), "the retry pass removes the previously locked file");

    lstrcpyW(temp, root); lstrcatW(temp, L"\\CXExam.exe");
    check(file_exists(temp), "CXExam survives the cleanup");
    lstrcpyW(temp, root); lstrcatW(temp, L"\\runtime\\node.exe");
    check(file_exists(temp), "the bundled runtime survives the cleanup");
    lstrcpyW(temp, root); lstrcatW(temp, L"\\windows");
    check(!file_exists(temp), "emptied program directories are removed");

    /* 自身改名：原路径立即消失，改名文件仍存在，可交给看门狗。 */
    lstrcpyW(temp, root); lstrcatW(temp, L"\\self.exe");
    write_file(temp, "self");
    check(cx_cleanup_detach_self(temp, parked, CX_CLEANUP_PATH_CAP), "the running executable can be renamed");
    check(!file_exists(temp) && file_exists(parked), "the original executable path disappears");
    DeleteFileW(parked);

    lstrcpyW(temp, root); lstrcatW(temp, L"\\CXExam.exe"); DeleteFileW(temp);
    lstrcpyW(temp, root); lstrcatW(temp, L"\\runtime\\node.exe"); DeleteFileW(temp);
    lstrcpyW(temp, root); lstrcatW(temp, L"\\runtime"); RemoveDirectoryW(temp);
    cx_cleanup_collect(root, plan);
    cx_cleanup_apply(plan, FALSE, 1, &failed);
    HeapFree(GetProcessHeap(), 0, plan);
    RemoveDirectoryW(root);
}

void __stdcall SilentTestMain(void) {
    test_state_machine();
    test_cleanup();
    output(failures ? "NATIVE SILENT TESTS FAIL\n" : "NATIVE SILENT TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}

