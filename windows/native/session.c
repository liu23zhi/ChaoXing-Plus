#include "session.h"
#include "json.h"

#define SESSION_ID_CAP 128
#define SESSION_TOKEN_CAP 4096
#define SESSION_MESSAGE_CAP 16384

typedef struct SESSION_CONTEXT {
    BOOL used, bootstrapped, ready, disabled, bundled;
    BOOL bootstrapQueued, bundleQueued, configQueued, ensure;
    int id;
    DWORD generation, bootstrapToken, bundleToken, configToken;
    char frameId[SESSION_ID_CAP];
    char origin[CX_SESSION_URL_CAP];
} SESSION_CONTEXT;

typedef struct SESSION_FRAME {
    BOOL used;
    char id[SESSION_ID_CAP];
    char parentId[SESSION_ID_CAP];
    char url[CX_SESSION_URL_CAP];
} SESSION_FRAME;

struct CX_SESSION {
    CX_SESSION_STATS stats;
    BOOL injectBlankFrames, extensionEnabled;
    DWORD generation, token;
    char targetUrl[CX_SESSION_URL_CAP];
    char topFrameId[SESSION_ID_CAP];
    SESSION_CONTEXT contexts[CX_SESSION_MAX_CONTEXTS];
    SESSION_CONTEXT fallback;
    SESSION_FRAME frames[CX_SESSION_MAX_FRAMES];
    JT tokens[SESSION_TOKEN_CAP];
    char pageMessage[SESSION_MESSAGE_CAP];
};

static void session_zero(void *memory, SIZE_T size) {
    BYTE *bytes = (BYTE *)memory;
    while (size--) *bytes++ = 0;
}
static BOOL session_equal(const char *a, const char *b) {
    int i = 0;
    if (!a || !b) return FALSE;
    while (a[i] && b[i] && a[i] == b[i]) ++i;
    return a[i] == b[i];
}
static BOOL session_prefix(const char *text, const char *prefix) {
    int i = 0;
    if (!text || !prefix) return FALSE;
    while (prefix[i]) { if (text[i] != prefix[i]) return FALSE; ++i; }
    return TRUE;
}
static char session_lower(char value) { return value >= 'A' && value <= 'Z' ? (char)(value + 'a' - 'A') : value; }
static BOOL session_copy(char *out, DWORD cap, const char *text) {
    DWORD i = 0;
    if (!out || !cap) return FALSE;
    if (!text) text = "";
    while (text[i] && i + 1 < cap) { out[i] = text[i]; ++i; }
    out[i] = 0;
    return text[i] == 0;
}
static void session_read(const char *json, const JT *tokens, int object, const char *key, char *out, int cap) {
    int token = jkey(json, tokens, object, key);
    if (token < 0) out[0] = 0;
    else if (!jstr(json, tokens, token, out, cap)) session_copy(out, (DWORD)cap, "invalid:");
}
static DWORD session_serial(DWORD *value) { if (++*value == 0) ++*value; return *value; }
static BOOL session_blank(const char *url) {
    return !url[0] || session_equal(url, ":") || session_equal(url, "://")
        || session_equal(url, "null") || session_equal(url, "nullblank") || session_equal(url, "blank")
        || session_prefix(url, "about:") || session_prefix(url, "data:") || session_prefix(url, "blob:")
        || session_prefix(url, "chrome:") || session_prefix(url, "edge:") || session_prefix(url, "devtools:");
}
static BOOL session_chaoxing(const char *url) {
    static const char domain[] = "chaoxing.com";
    DWORD i, start, end, hostEnd, domainStart;
    const char *http = "http://", *https = "https://";
    for (i = 0; http[i] && session_lower(url[i]) == http[i]; ++i) { }
    if (!http[i]) start = i;
    else {
        for (i = 0; https[i] && session_lower(url[i]) == https[i]; ++i) { }
        if (https[i]) return FALSE;
        start = i;
    }
    end = start;
    while (url[end] && url[end] != '/' && url[end] != '?' && url[end] != '#') ++end;
    for (i = start; i < end; ++i) if (url[i] == '@') start = i + 1;
    hostEnd = start;
    while (hostEnd < end && url[hostEnd] != ':') ++hostEnd;
    if (hostEnd - start < sizeof(domain) - 1) return FALSE;
    domainStart = hostEnd - (sizeof(domain) - 1);
    if (domainStart != start && url[domainStart - 1] != '.') return FALSE;
    for (i = 0; domain[i]; ++i) if (session_lower(url[domainStart + i]) != domain[i]) return FALSE;
    return TRUE;
}
static SESSION_CONTEXT *session_context(CX_SESSION *session, int id) {
    DWORD i;
    if (id == 0) return session->fallback.used ? &session->fallback : NULL;
    for (i = 0; i < CX_SESSION_MAX_CONTEXTS; ++i)
        if (session->contexts[i].used && session->contexts[i].id == id) return &session->contexts[i];
    return NULL;
}
static const SESSION_FRAME *session_frame(const CX_SESSION *session, const char *id) {
    DWORD i;
    if (!id[0]) return NULL;
    for (i = 0; i < CX_SESSION_MAX_FRAMES; ++i)
        if (session->frames[i].used && session_equal(session->frames[i].id, id)) return &session->frames[i];
    return NULL;
}
static const char *session_url(const CX_SESSION *session, const SESSION_CONTEXT *context) {
    const SESSION_FRAME *frame = session_frame(session, context->frameId);
    return frame ? frame->url : context->origin;
}
static BOOL session_bundle_allowed(const CX_SESSION *session, const SESSION_CONTEXT *context) {
    const char *url = session_url(session, context);
    return session->extensionEnabled && !context->disabled
        && (session_chaoxing(url) || (session->injectBlankFrames && session_blank(url)));
}
static void session_reset_context(CX_SESSION *session, SESSION_CONTEXT *context) {
    context->generation = session_serial(&session->generation);
    context->bootstrapped = FALSE; context->bundled = FALSE; context->ready = FALSE; context->disabled = FALSE;
    context->bootstrapQueued = TRUE; context->bundleQueued = FALSE; context->configQueued = FALSE; context->ensure = FALSE;
    context->bootstrapToken = 0; context->bundleToken = 0; context->configToken = 0;
}
static BOOL session_set_frame(CX_SESSION *session, const char *id, const char *parent, const char *url) {
    DWORD i;
    SESSION_FRAME *freeSlot = NULL, *frame = NULL;
    if (!id[0]) return FALSE;
    for (i = 0; i < CX_SESSION_MAX_FRAMES; ++i) {
        if (!session->frames[i].used && !freeSlot) freeSlot = &session->frames[i];
        if (session->frames[i].used && session_equal(session->frames[i].id, id)) { frame = &session->frames[i]; break; }
    }
    if (!frame) frame = freeSlot;
    if (!frame) { ++session->stats.errors; return FALSE; }
    frame->used = TRUE;
    session_copy(frame->id, sizeof(frame->id), id);
    session_copy(frame->parentId, sizeof(frame->parentId), parent);
    session_copy(frame->url, sizeof(frame->url), url);
    return TRUE;
}
static void session_clear_contexts(CX_SESSION *session) {
    session_zero(session->contexts, sizeof(session->contexts));
    session_zero(&session->fallback, sizeof(session->fallback));
    session->stats.contexts = 0;
}
static void session_remove_frame(CX_SESSION *session, const char *frameId) {
    BOOL removed[CX_SESSION_MAX_FRAMES];
    DWORD i, j;
    BOOL changed;
    session_zero(removed, sizeof(removed));
    for (i = 0; i < CX_SESSION_MAX_FRAMES; ++i)
        if (session->frames[i].used && session_equal(session->frames[i].id, frameId)) removed[i] = TRUE;
    do {
        changed = FALSE;
        for (i = 0; i < CX_SESSION_MAX_FRAMES; ++i) {
            if (!session->frames[i].used || removed[i]) continue;
            for (j = 0; j < CX_SESSION_MAX_FRAMES; ++j) {
                if (removed[j] && session_equal(session->frames[i].parentId, session->frames[j].id)) {
                    removed[i] = TRUE; changed = TRUE; break;
                }
            }
        }
    } while (changed);
    for (i = 0; i < CX_SESSION_MAX_CONTEXTS; ++i) {
        SESSION_CONTEXT *context = &session->contexts[i];
        if (!context->used) continue;
        for (j = 0; j < CX_SESSION_MAX_FRAMES; ++j)
            if (removed[j] && session_equal(context->frameId, session->frames[j].id)) break;
        if (j < CX_SESSION_MAX_FRAMES || session_equal(context->frameId, frameId)) {
            session_zero(context, sizeof(*context)); --session->stats.contexts;
        }
    }
    for (i = 0; i < CX_SESSION_MAX_FRAMES; ++i) if (removed[i]) session_zero(&session->frames[i], sizeof(session->frames[i]));
    if (session_equal(session->topFrameId, frameId)) session_zero(&session->fallback, sizeof(session->fallback));
}
CX_SESSION *cx_session_create(const char *targetUrl, BOOL injectBlankFrames, BOOL extensionEnabled) {
    CX_SESSION *session = (CX_SESSION *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CX_SESSION));
    if (session) {
        session->injectBlankFrames = injectBlankFrames;
        session->extensionEnabled = extensionEnabled;
        if (!session_copy(session->targetUrl, sizeof(session->targetUrl), targetUrl)) session_copy(session->targetUrl, sizeof(session->targetUrl), "invalid:");
    }
    return session;
}
void cx_session_close(CX_SESSION *session) {
    if (session) { session->stats.closed = TRUE; session_clear_contexts(session); }
}
void cx_session_free(CX_SESSION *session) { if (session) HeapFree(GetProcessHeap(), 0, session); }
const CX_SESSION_STATS *cx_session_stats(const CX_SESSION *session) { return session ? &session->stats : NULL; }
void cx_session_update_config(CX_SESSION *session, BOOL extensionEnabled) {
    DWORD i;
    SESSION_CONTEXT *context;
    if (!session || session->stats.closed) return;
    session->extensionEnabled = extensionEnabled;
    for (i = 0; i <= CX_SESSION_MAX_CONTEXTS; ++i) {
        context = i < CX_SESSION_MAX_CONTEXTS ? &session->contexts[i] : &session->fallback;
        if (!context->used) continue;
        context->disabled = FALSE;
        /* A bootstrap already sent may still contain the previous snapshot. */
        if (context->bootstrapped || context->bootstrapToken) {
            context->configQueued = TRUE;
            context->configToken = 0;
        }
        if (extensionEnabled && context->ready && !context->bundled && !context->bundleToken)
            context->bundleQueued = TRUE;
    }
}
BOOL cx_session_can_sync_config(const CX_SESSION *session, int contextId) {
    const SESSION_CONTEXT *context = NULL;
    DWORD i;
    if (!session || session->stats.closed || contextId < 0) return FALSE;
    if (contextId == 0) context = &session->fallback;
    else for (i = 0; i < CX_SESSION_MAX_CONTEXTS; ++i)
        if (session->contexts[i].used && session->contexts[i].id == contextId) { context = &session->contexts[i]; break; }
    return context && context->used && context->bootstrapped;
}

static void session_page_message(CX_SESSION *session, const char *json, const JT *tokens, int params) {
    SESSION_CONTEXT *context;
    JT pageTokens[64];
    int args, arg, value, kind, count;
    DWORD i;
    const char prefix[] = "__CX_WIN_MSG__";
    context = session_context(session, jint(json, tokens, jkey(json, tokens, params, "executionContextId"), -1));
    if (!context) return;
    args = jkey(json, tokens, params, "args");
    if (args < 0 || tokens[args].type != '[') return;
    for (arg = args + 1; arg < tokens[args].next; arg = tokens[arg].next) {
        if (!jeq(json, tokens, jkey(json, tokens, arg, "type"), "string")) continue;
        value = jkey(json, tokens, arg, "value");
        if (!jstr(json, tokens, value, session->pageMessage, sizeof(session->pageMessage)) || !session_prefix(session->pageMessage, prefix)) continue;
        for (i = 0; prefix[i]; ++i) { }
        count = jparse(session->pageMessage + i, lstrlenA(session->pageMessage + i), pageTokens, 64);
        if (count < 1 || pageTokens[0].type != '{') continue;
        kind = jkey(session->pageMessage + i, pageTokens, 0, "kind");
        if (jeq(session->pageMessage + i, pageTokens, kind, "ready")) {
            context->ready = TRUE;
            if (!context->bundled && !context->bundleToken) context->bundleQueued = TRUE;
        } else if (jeq(session->pageMessage + i, pageTokens, kind, "boot-request")) {
            if (!context->bootstrapped) context->bootstrapQueued = TRUE;
        } else if (jeq(session->pageMessage + i, pageTokens, kind, "disabled")) {
            context->disabled = TRUE; context->bundleQueued = FALSE;
        }
        return;
    }
}
BOOL cx_session_feed(CX_SESSION *session, const char *json, DWORD length) {
    JT *tokens;
    int count, method, params, item, aux, id;
    DWORD i;
    char frameId[SESSION_ID_CAP], origin[CX_SESSION_URL_CAP], parent[SESSION_ID_CAP];
    SESSION_CONTEXT *context;
    if (!session || session->stats.closed) return FALSE;
    tokens = session->tokens;
    count = json && length <= 0x7fffffffUL ? jparse(json, (int)length, tokens, SESSION_TOKEN_CAP) : -1;
    if (count < 1 || tokens[0].type != '{') { ++session->stats.errors; return FALSE; }
    method = jkey(json, tokens, 0, "method");
    if (method < 0) return TRUE;
    params = jkey(json, tokens, 0, "params");
    if (jeq(json, tokens, method, "Runtime.executionContextCreated")) {
        item = jkey(json, tokens, params, "context");
        aux = jkey(json, tokens, item, "auxData");
        id = jint(json, tokens, jkey(json, tokens, item, "id"), -1);
        i = (DWORD)jkey(json, tokens, aux, "isDefault");
        if (id < 1 || (int)i < 0 || tokens[i].type != 'p' || !jeq(json, tokens, (int)i, "true")) return TRUE;
        session_read(json, tokens, aux, "frameId", frameId, sizeof(frameId));
        session_read(json, tokens, item, "origin", origin, sizeof(origin));
        context = session_context(session, id);
        if (context && session_equal(context->frameId, frameId) && session_equal(context->origin, origin)) return TRUE;
        if (!context) {
            for (i = 0; i < CX_SESSION_MAX_CONTEXTS && session->contexts[i].used; ++i) { }
            if (i == CX_SESSION_MAX_CONTEXTS) { ++session->stats.errors; return FALSE; }
            context = &session->contexts[i]; context->used = TRUE; ++session->stats.contexts;
        }
        context->id = id;
        session_copy(context->frameId, sizeof(context->frameId), frameId);
        session_copy(context->origin, sizeof(context->origin), origin);
        session_reset_context(session, context);
        if (!session->topFrameId[0] || session_equal(frameId, session->topFrameId)) session_zero(&session->fallback, sizeof(session->fallback));
    } else if (jeq(json, tokens, method, "Runtime.executionContextDestroyed")) {
        id = jint(json, tokens, jkey(json, tokens, params, "executionContextId"), -1);
        context = session_context(session, id);
        if (context && id > 0) { session_zero(context, sizeof(*context)); --session->stats.contexts; }
    } else if (jeq(json, tokens, method, "Runtime.executionContextsCleared")) {
        session_clear_contexts(session);
    } else if (jeq(json, tokens, method, "Page.frameNavigated")) {
        item = jkey(json, tokens, params, "frame");
        session_read(json, tokens, item, "id", frameId, sizeof(frameId));
        session_read(json, tokens, item, "parentId", parent, sizeof(parent));
        session_read(json, tokens, item, "url", origin, sizeof(origin));
        if (!session_set_frame(session, frameId, parent, origin)) return FALSE;
        for (i = 0; i < CX_SESSION_MAX_CONTEXTS; ++i)
            if (session->contexts[i].used && session_equal(session->contexts[i].frameId, frameId)) session_reset_context(session, &session->contexts[i]);
        if (!parent[0]) {
            session_copy(session->topFrameId, sizeof(session->topFrameId), frameId);
            session_copy(session->targetUrl, sizeof(session->targetUrl), origin);
            session_zero(&session->fallback, sizeof(session->fallback));
        }
    } else if (jeq(json, tokens, method, "Page.frameDetached")) {
        session_read(json, tokens, params, "frameId", frameId, sizeof(frameId));
        session_remove_frame(session, frameId);
    } else if (jeq(json, tokens, method, "Runtime.consoleAPICalled")) {
        session_page_message(session, json, tokens, params);
    }
    return TRUE;
}
static BOOL session_visit_tree(CX_SESSION *session, const char *json, const JT *tokens, int tree, const char *parent, DWORD depth) {
    int frame, children, child;
    char id[SESSION_ID_CAP], url[CX_SESSION_URL_CAP];
    if (depth > 16 || tree < 0 || tokens[tree].type != '{') return FALSE;
    frame = jkey(json, tokens, tree, "frame");
    session_read(json, tokens, frame, "id", id, sizeof(id));
    session_read(json, tokens, frame, "url", url, sizeof(url));
    if (!session_set_frame(session, id, parent, url)) return FALSE;
    if (depth == 0) { session_copy(session->topFrameId, sizeof(session->topFrameId), id); session_copy(session->targetUrl, sizeof(session->targetUrl), url); }
    children = jkey(json, tokens, tree, "childFrames");
    if (children >= 0 && tokens[children].type == '[') {
        for (child = children + 1; child < tokens[children].next; child = tokens[child].next)
            if (!session_visit_tree(session, json, tokens, child, id, depth + 1)) return FALSE;
    }
    return TRUE;
}
BOOL cx_session_frame_tree(CX_SESSION *session, const char *json, DWORD length) {
    int count, result, tree;
    if (!session || session->stats.closed) return FALSE;
    count = json && length <= 0x7fffffffUL ? jparse(json, (int)length, session->tokens, SESSION_TOKEN_CAP) : -1;
    if (count < 1 || session->tokens[0].type != '{') { ++session->stats.errors; return FALSE; }
    result = jkey(json, session->tokens, 0, "result");
    tree = jkey(json, session->tokens, result >= 0 ? result : 0, "frameTree");
    if (!session_visit_tree(session, json, session->tokens, tree, "", 0)) { ++session->stats.errors; return FALSE; }
    return TRUE;
}
void cx_session_request_top_ensure(CX_SESSION *session) {
    DWORD i;
    SESSION_CONTEXT *top = NULL;
    if (!session || session->stats.closed) return;
    for (i = 0; i < CX_SESSION_MAX_CONTEXTS; ++i) {
        if (session->contexts[i].used && (!session->topFrameId[0] || session_equal(session->contexts[i].frameId, session->topFrameId))) top = &session->contexts[i];
    }
    if (!top) {
        top = &session->fallback;
        if (!top->used) {
            top->used = TRUE; top->id = 0;
            session_copy(top->frameId, sizeof(top->frameId), session->topFrameId);
            session_copy(top->origin, sizeof(top->origin), session->targetUrl);
            session_reset_context(session, top);
        }
    }
    top->bootstrapQueued = TRUE;
    top->bundleQueued = TRUE;
    top->ensure = TRUE;
    top->ready = TRUE;
}
BOOL cx_session_next(CX_SESSION *session, CX_SESSION_TASK *task) {
    DWORD i;
    SESSION_CONTEXT *context;
    if (!session || !task || session->stats.closed) return FALSE;
    for (i = 0; i <= CX_SESSION_MAX_CONTEXTS; ++i) {
        context = i < CX_SESSION_MAX_CONTEXTS ? &session->contexts[i] : &session->fallback;
        if (!context->used) continue;
        if (context->bootstrapQueued && !context->bootstrapToken && !context->bundleToken && !context->configToken) {
            task->type = CX_SESSION_TASK_BOOTSTRAP;
            context->bootstrapQueued = FALSE;
            context->bootstrapToken = session_serial(&session->token);
            task->token = context->bootstrapToken;
        } else if (context->configQueued && context->bootstrapped && !context->bootstrapToken && !context->bundleToken && !context->configToken) {
            task->type = CX_SESSION_TASK_CONFIG;
            context->configQueued = FALSE;
            context->configToken = session_serial(&session->token);
            task->token = context->configToken;
        } else if (context->bundleQueued && context->bootstrapped && context->ready && !context->bootstrapToken && !context->bundleToken && !context->configToken && !context->configQueued) {
            context->bundleQueued = FALSE;
            if (!session_bundle_allowed(session, context)) continue;
            task->type = CX_SESSION_TASK_BUNDLE;
            context->bundleToken = session_serial(&session->token);
            task->token = context->bundleToken;
        } else continue;
        task->contextId = context->id;
        task->generation = context->generation;
        task->top = context->id == 0 || !session->topFrameId[0] || session_equal(context->frameId, session->topFrameId);
        task->ensure = context->ensure;
        return TRUE;
    }
    return FALSE;
}
BOOL cx_session_task_active(const CX_SESSION *session, const CX_SESSION_TASK *task) {
    const SESSION_CONTEXT *context;
    DWORD i;
    if (!session || !task || session->stats.closed || !task->token) return FALSE;
    context = task->contextId == 0 ? &session->fallback : NULL;
    if (!context) for (i = 0; i < CX_SESSION_MAX_CONTEXTS; ++i)
        if (session->contexts[i].used && session->contexts[i].id == task->contextId) { context = &session->contexts[i]; break; }
    if (!context || !context->used || context->generation != task->generation) return FALSE;
    return task->type == CX_SESSION_TASK_BOOTSTRAP ? context->bootstrapToken == task->token
        : task->type == CX_SESSION_TASK_BUNDLE ? context->bundleToken == task->token
        : task->type == CX_SESSION_TASK_CONFIG && context->configToken == task->token;
}
BOOL cx_session_complete(CX_SESSION *session, const CX_SESSION_TASK *task, BOOL success) {
    SESSION_CONTEXT *context;
    if (!cx_session_task_active(session, task)) return FALSE;
    context = session_context(session, task->contextId);
    if (task->type == CX_SESSION_TASK_BOOTSTRAP) {
        context->bootstrapToken = 0;
        if (success) { context->bootstrapped = TRUE; ++session->stats.bootstraps; }
    } else if (task->type == CX_SESSION_TASK_BUNDLE) {
        context->bundleToken = 0;
        if (success) { context->bundled = TRUE; context->bundleQueued = FALSE; context->ensure = FALSE; ++session->stats.bundles; }
    } else {
        context->configToken = 0;
    }
    if (!success) ++session->stats.errors;
    return TRUE;
}
