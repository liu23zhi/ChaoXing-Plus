/* 自毁兜底：关机前置自毁、开机续删登记与强制关机保障。
 *
 * 三层保护，按"先落盘意图、再破坏痕迹"的顺序执行：
 *  1. 关机/注销：隐藏顶层窗口接收 WM_QUERYENDSESSION / WM_ENDSESSION
 *     （含 ENDSESSION_CRITICAL 强制结束），在关机流程内同步完成自毁；
 *  2. 开机续删：自毁前把待删清单写进 %TEMP% 的续删脚本，并登记到
 *     HKCU\...\RunOnce，下次登录若仍有残留就继续删除，删干净后自行撤销登记；
 *  3. 强制关机：对每个待删路径登记 MOVEFILE_DELAY_UNTIL_REBOOT，
 *     断电或强制结束进程后由系统在下次启动时删除（需要管理员权限，尽力而为）。
 *
 * 本模块只处理调用方明确登记的路径；CXExam/runtime 的排除在 silent 层完成。
 */
#ifndef CX_PURGE_H
#define CX_PURGE_H

#include <windows.h>

#define CX_PURGE_MAX_ITEMS 512
#define CX_PURGE_PATH_CAP 512
#define CX_PURGE_NAME_CAP 64
#define CX_PURGE_RUNKEY_CAP 256
#define CX_PURGE_MAX_ATTEMPTS 16
/** 单次删除的墙钟预算：关机流程必须在这个时间内返回，剩余项交给开机续删。 */
#define CX_PURGE_RUN_BUDGET_MS 5000

typedef struct CX_PURGE_ITEM {
    WCHAR path[CX_PURGE_PATH_CAP];
    BOOL directory;
} CX_PURGE_ITEM;

typedef struct CX_PURGE {
    CRITICAL_SECTION lock;
    BOOL lockReady;
    WCHAR root[CX_PURGE_PATH_CAP];
    WCHAR exe[CX_PURGE_PATH_CAP];
    WCHAR runKey[CX_PURGE_RUNKEY_CAP];
    WCHAR valueName[CX_PURGE_NAME_CAP];
    WCHAR journalDir[CX_PURGE_PATH_CAP];
    WCHAR script[CX_PURGE_PATH_CAP];
    WCHAR state[CX_PURGE_PATH_CAP];
    WCHAR powershell[CX_PURGE_PATH_CAP];
    CX_PURGE_ITEM items[CX_PURGE_MAX_ITEMS];
    int count;
    int truncated;
    /** root 本身已排队（非递归删除，留到最后）。 */
    BOOL rootQueued;
    /** 上次写入续删脚本时的条目数；0 表示尚未登记成功。 */
    int journalCount;
    BOOL journaled;
    /** 本次运行已经校验过残留并尝试撤销登记。 */
    BOOL settled;
    int removed;
    int remaining;
    int pendingCount;
    int pendingFailed;
    HANDLE thread;
    DWORD threadId;
    HWND window;
    volatile LONG stop;
    /** onShutdown 正在执行，避免 QUERY 与 ENDSESSION 重入。 */
    volatile LONG dispatching;
    void (*onShutdown)(void);
} CX_PURGE;

/** 初始化：记录痕迹根目录与自身镜像路径，生成随机登记名与临时目录。 */
BOOL cx_purge_init(CX_PURGE *purge, const WCHAR *root, const WCHAR *exe);
/** 停止关机监视线程并释放临界区。 */
void cx_purge_close(CX_PURGE *purge);
/** 清空待删清单（保留 root/exe 与已登记的续删信息）。 */
void cx_purge_reset(CX_PURGE *purge);
/** 追加一个待删路径；重复路径被忽略。 */
BOOL cx_purge_add(CX_PURGE *purge, const WCHAR *path, BOOL directory);
/** 追加 root 本身（最后删除，非递归：非空时失败是预期结果）。 */
BOOL cx_purge_add_root(CX_PURGE *purge);
int cx_purge_count(const CX_PURGE *purge);

/** 登记开机续删：写脚本 + RunOnce，并为每条路径登记重启后删除。
 *  条目数变化时会重写脚本；重复调用幂等。 */
BOOL cx_purge_journal(CX_PURGE *purge, WCHAR *error, DWORD errorCap);
/** 已登记则撤销：删除 RunOnce 值、脚本与临时目录。 */
BOOL cx_purge_journal_clear(CX_PURGE *purge);
/** 执行一次删除：先登记（若尚未登记），再按"最深先删"删除文件与目录。
 *  返回成功删除的条目数，失败数写入 failed（可为 NULL）。 */
int cx_purge_run(CX_PURGE *purge, int attempts, int *failed);
/** 校验残留：全部消失时撤销登记，否则保留续删脚本等待下次登录。 */
void cx_purge_settle(CX_PURGE *purge);
/** 退出前派生一次续删：脚本自带重试，可在本进程结束后清掉仍被占用的痕迹，
 *  删净后自行撤销 RunOnce 登记。仍有残留时脚本会保留到下次登录继续。 */
BOOL cx_purge_after_exit(CX_PURGE *purge);

/** 创建隐藏顶层窗口接收关机/注销通知；onShutdown 在窗口线程同步执行。 */
BOOL cx_purge_watch_shutdown(CX_PURGE *purge, void (*onShutdown)(void));
void cx_purge_watch_stop(CX_PURGE *purge);
/** 测试/自检：向隐藏窗口投递一次关机通知（critical 模拟强制结束）。 */
BOOL cx_purge_simulate_shutdown(CX_PURGE *purge, BOOL critical);
BOOL cx_purge_watch_ready(const CX_PURGE *purge);

/** 登记"重启后删除"；只在当前进程有管理员权限时成功。 */
BOOL cx_purge_pending_delete(const WCHAR *path);

/** 供测试与审计使用的只读视图。 */
const WCHAR *cx_purge_script_path(const CX_PURGE *purge);
const WCHAR *cx_purge_journal_dir(const CX_PURGE *purge);
const WCHAR *cx_purge_value_name(const CX_PURGE *purge);
const WCHAR *cx_purge_run_key(const CX_PURGE *purge);
/** 生成续删脚本正文（UTF-16，含尾部 NUL）；容量不足返回 FALSE。 */
BOOL cx_purge_script_text(const CX_PURGE *purge, WCHAR *out, DWORD cap, DWORD *length);
/** 测试专用：替换 RunOnce 子键，避免污染真实自启动项。 */
BOOL cx_purge_set_run_key(CX_PURGE *purge, const WCHAR *subKey);
/** 测试专用：替换续删脚本目录，避免与其他实例互相覆盖。 */
BOOL cx_purge_set_journal_dir(CX_PURGE *purge, const WCHAR *directory);

#endif /* CX_PURGE_H */
