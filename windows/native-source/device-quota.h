#ifndef CX_NATIVE_DEVICE_QUOTA_H
#define CX_NATIVE_DEVICE_QUOTA_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

/*
   设备槽位（141 号文档 §5 / §8、R5-R8）。

   槽位口径（服务端）：used = Σ max(1, session_count)
     - 浏览器 profile（session_count=0）        -> 占 1
     - exe 宿主启动但没开会话（session_count=0） -> 占 1（R5）
     - exe 开 N 个临时会话                      -> 占 N（R6）
     - exe 全关（session_count=0）              -> 回落到 1（R7）

   本模块只做三件事：生成/沿用 device_id、查询配额、上报会话数。
   **不参与任何拦截判定** —— R8 要求「槽位占满仍允许新建浏览器，只提醒」，
   是否弹提醒由 home.c 的界面层决定，本模块只如实给出 over_limit 事实。
*/

#define CX_DEVICE_ID_CAP 64
#define CX_DEVICE_INSTANCE_CAP 64
#define CX_DEVICE_LIMIT_SOURCE_CAP 32
/* 与 home.c 的 HOME_MAX_SESSIONS 及 141 §6.2 的 count 上界一致。 */
#define CX_DEVICE_MAX_SESSIONS 8

/*
   chrome.storage.local 的键名。必须与扩展侧（src/runtime/device-identity.ts）
   完全一致，否则注入到 chrome.storage 的值扩展读不到。
   两者都以字面量写在这里/测试里，改名字会让 scripts/device-quota.test.mjs 立刻变红。
*/
#define CX_DEVICE_ID_KEY "common.settings.device-id"
#define CX_DEVICE_INSTANCE_KEY "common.settings.device-instance"

typedef struct CX_DEVICE_QUOTA {
    BOOL known;                 /* FALSE = 还没取到过配额（fail-open，不得据此拦截） */
    int limit;                  /* 生效上限，0 = 不限 */
    int used;                   /* Σ max(1, session_count) */
    int available;              /* max(0, limit - used)；limit=0 时为 -1（不限） */
    WCHAR limitSource[CX_DEVICE_LIMIT_SOURCE_CAP];
    WCHAR error[256];           /* 最近一次失败原因；成功时清空 */
} CX_DEVICE_QUOTA;

/* RFC 4122 version 4，小写带连字符（36 字符 + NUL）。 */
BOOL cx_device_uuid_v4(WCHAR *out, DWORD cap);

/* 读取宿主共享配置里的 device_id；缺失则生成并写回。
   noDiskWrite 为 TRUE 时只在内存里给一个 id，绝不落盘（与 --no-disk-write 约定一致）。
   落盘走 cx_config_patch_file（config-store.c），即宿主既有的唯一配置写入路径。 */
BOOL cx_device_id_ensure(const WCHAR *configPath, BOOL noDiskWrite,
    WCHAR *out, DWORD cap, WCHAR *error, DWORD errorCap);

/* 每个浏览器会话一个新的实例标识（141 §4.3：不持久化，用于区分「同 id 不同实例」）。 */
BOOL cx_device_instance_new(WCHAR *out, DWORD cap);

/* device_id 落在哪个配置文件（141 §5.1 指定的就是 windows/data/config.json）：
     1) --config 显式路径（用户明确指定，最高优先）
     2) 当前目录下的 windows\data\config.json —— 标准仓库布局。
        start-windows.cmd 会先 cd 到仓库根，所以正常启动走这一支。
        （必须排在 dataDir 之前：dataDir 默认是 ".data"，那是宿主的数据目录，
         不是 141 要求的配置位置。）
     3) <dataDir>\config.json —— 非标准布局时的兜底
   三者都拿不到时返回 FALSE —— 调用方仍可用内存里的 id，只是不持久化（fail-open）。 */
BOOL cx_device_config_path(const WCHAR *configPath, const WCHAR *dataDir,
    WCHAR *out, DWORD cap);

/* count 上界 CX_DEVICE_MAX_SESSIONS，下界 0；越界按边界收敛。 */
int cx_device_sessions_clamp(int count);

/* 解析 GET /api/user/device-quota 的响应体。成功时 quota->known = TRUE。 */
BOOL cx_device_quota_parse(const char *body, DWORD length, CX_DEVICE_QUOTA *quota);

/* GET /api/user/device-quota（Bearer <adapter key>）。
   FALSE 时 quota->error 给出可显示的原因；调用方必须 fail-open。 */
BOOL cx_device_quota_fetch(const WCHAR *baseUrl, const WCHAR *apiKey,
    DWORD timeoutMs, CX_DEVICE_QUOTA *quota);

/* POST /api/user/device-sessions { deviceId, count }。失败不阻断本地操作。 */
BOOL cx_device_sessions_report(const WCHAR *baseUrl, const WCHAR *apiKey,
    const WCHAR *deviceId, int count, DWORD timeoutMs, WCHAR *error, DWORD errorCap);

/* R8 的唯一判据：已取到配额、上限有限、且已用满。
   只表示「该提醒」，绝不表示「要拦截」。 */
BOOL cx_device_over_limit(const CX_DEVICE_QUOTA *quota);

/* 首页状态栏文案（141 §8.1）：
   可用设备：X / Y　本 exe 占用：Z 个（N 个浏览器会话） */
BOOL cx_device_status_text(const CX_DEVICE_QUOTA *quota, int openSessions,
    WCHAR *out, DWORD cap);

#endif
