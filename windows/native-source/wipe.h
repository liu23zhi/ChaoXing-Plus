/* 启动清理：只删除宿主自己登记的数据文件（扫描缓存、日志、诊断产物）。
 * 绝不删除 CXExam、runtime 子树、外部 --config 或未登记文件。 */
#ifndef CX_WIPE_H
#define CX_WIPE_H

#include <windows.h>

#define CX_WIPE_MAX_FILES 512
#define CX_WIPE_PATH_CAP 512

typedef enum {
    CX_WIPE_RETRY = 0,
    CX_WIPE_BACKGROUND,
    CX_WIPE_IGNORE,
    CX_WIPE_ABORT
} CX_WIPE_POLICY;

typedef struct {
    WCHAR paths[CX_WIPE_MAX_FILES][CX_WIPE_PATH_CAP];
    BOOL pending[CX_WIPE_MAX_FILES];
    int count;
    int deleted;
    int failed;
    CX_WIPE_POLICY policy;
    int retries;
    int delayMs;
    BOOL runtimeRetry;
    DWORD runtimeIntervalMs;
    HANDLE thread;
    volatile LONG stop;
    CRITICAL_SECTION lock;
    BOOL lockReady;
} CX_WIPE;

void cx_wipe_init(CX_WIPE *wipe);
void cx_wipe_configure(CX_WIPE *wipe, CX_WIPE_POLICY policy, int retries, int delayMs,
                       BOOL runtimeRetry, DWORD runtimeIntervalMs);
/** 收集 <dataDir>\chaoxing 下登记的宿主数据文件；externalConfig 命中的文件跳过。 */
int cx_wipe_collect(CX_WIPE *wipe, const WCHAR *dataDir, const WCHAR *externalConfig);
/** 追加一个已确认属于宿主的文件；返回 1 表示加入计划。 */
int cx_wipe_add_file(CX_WIPE *wipe, const WCHAR *path, const WCHAR *externalConfig);
/** 删除文件；被占用时退化为清空内容，返回是否删除或清空成功。 */
BOOL cx_wipe_clear_file(const WCHAR *path);
/** 启动阶段执行一次清理；abort 策略失败返回 FALSE。 */
BOOL cx_wipe_start(CX_WIPE *wipe);
/** 停止运行期重试线程并等待退出。 */
void cx_wipe_stop(CX_WIPE *wipe);
BOOL cx_wipe_has_pending(const CX_WIPE *wipe);

#endif /* CX_WIPE_H */
