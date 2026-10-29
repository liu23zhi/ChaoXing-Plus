/* 原生静默场景：程序文件清理 + 自毁状态机。
 *
 * 与 Node 宿主同语义，但不依赖 Node：
 *  - 启动后删除程序本体（每文件最多 5 次，失败不阻塞，运行期继续重试）；
 *  - CXExam 与 runtime 运行时永不出现在删除计划里；
 *  - Ctrl+Alt+Shift+E / F8 或 CXExam 退出全屏 / 进程结束触发自毁；
 *  - 客户端从未启动、或从未进入全屏时，不因"全屏退出"误触发。
 */
#ifndef CX_SILENT_H
#define CX_SILENT_H

#include <windows.h>

#define CX_SILENT_MAX_KEYS 4
#define CX_SILENT_KEY_CAP 64
#define CX_SILENT_REASON_CAP 32
#define CX_CLEANUP_MAX_ITEMS 512
#define CX_CLEANUP_PATH_CAP 512
#define CX_CLEANUP_MAX_DEPTH 16

typedef enum {
    CX_SILENT_IDLE = 0,
    CX_SILENT_WATCHING,
    CX_SILENT_FULLSCREEN_SEEN,
    CX_SILENT_DESTRUCT_REQUESTED,
    CX_SILENT_FINISHED
} CX_SILENT_STATE;

typedef struct {
    CX_SILENT_STATE state;
    DWORD clientPid;
    BOOL fullscreenSeen;
    BOOL fullscreenExit;
    /** 已请求自毁（宿主不得重复执行清理流程）。 */
    BOOL requested;
    WCHAR reason[CX_SILENT_REASON_CAP];
    WCHAR keys[CX_SILENT_MAX_KEYS][CX_SILENT_KEY_CAP];
    int keyCount;
} CX_SILENT;

typedef struct {
    WCHAR path[CX_CLEANUP_PATH_CAP];
    BOOL directory;
} CX_CLEANUP_ITEM;

typedef struct {
    WCHAR root[CX_CLEANUP_PATH_CAP];
    CX_CLEANUP_ITEM items[CX_CLEANUP_MAX_ITEMS];
    int count;
    int truncated;
    int protectedCount;
} CX_CLEANUP_PLAN;

/** 固定两组自毁快捷键（与 Node 静默场景一致）。 */
void cx_silent_init(CX_SILENT *silent, BOOL fullscreenExit);
/** 记录本次启动的客户端 PID；无效 PID 被忽略。 */
BOOL cx_silent_client_started(CX_SILENT *silent, DWORD pid);
/** 快捷键事件；只有客户端已启动且命中配置快捷键时才返回 TRUE。 */
BOOL cx_silent_hotkey(CX_SILENT *silent, const WCHAR *shortcut);
/** 全屏状态事件；退出全屏只在此前进入过全屏时触发。 */
BOOL cx_silent_fullscreen(CX_SILENT *silent, BOOL fullscreen, DWORD pid);
/** 客户端进程结束；只有此前已启动过客户端时才触发。 */
BOOL cx_silent_client_exited(CX_SILENT *silent, DWORD pid);
/** 进入收尾阶段，返回是否为第一次收尾（避免重复删除）。 */
BOOL cx_silent_finish(CX_SILENT *silent, WCHAR *reason, DWORD reasonCap);

/** 是否为可信发布布局：EXE 同级存在 SHA256SUMS.txt。源码/构建目录必须拒绝真实删除。 */
BOOL cx_cleanup_is_release_layout(const WCHAR *root);
/** 收集程序痕迹：递归枚举 root 下的文件与空目录，跳过 cxexam*、runtime 子树
 *  和 root 自身。truncated 表示超出 CX_CLEANUP_MAX_ITEMS。 */
BOOL cx_cleanup_collect(const WCHAR *root, CX_CLEANUP_PLAN *plan);
/** 执行一次删除：每个文件最多 attempts 次；返回删除成功的文件数，失败数量写入
 *  failed（可为 NULL）。simulate=TRUE 时只统计、不删除。 */
int cx_cleanup_apply(CX_CLEANUP_PLAN *plan, BOOL simulate, int attempts, int *failed);
/** 把正在运行的 EXE 改名（原路径立即消失），返回改名后的路径；失败返回 FALSE。 */
BOOL cx_cleanup_detach_self(const WCHAR *exePath, WCHAR *parked, DWORD parkedCap);
/** 删除改名后的自身：进程运行期间删除会失败，这里只登记"重启后删除"并尽力尝试。 */
void cx_cleanup_release_self(const WCHAR *parked);

#endif /* CX_SILENT_H */

