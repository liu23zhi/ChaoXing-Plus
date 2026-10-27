#include "../session.h"

static DWORD failures;
static void output(const char *text) {
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)lstrlenA(text), &written, NULL);
}
static void check(BOOL passed, const char *name) {
    output(passed ? "PASS " : "FAIL "); output(name); output("\n");
    if (!passed) ++failures;
}
static BOOL feed(CX_SESSION *session, const char *text) { return cx_session_feed(session, text, (DWORD)lstrlenA(text)); }
static void context(CX_SESSION *session) {
    feed(session, "{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":1,\"origin\":\"https://a.chaoxing.com\",\"auxData\":{\"isDefault\":true,\"frameId\":\"top\"}}}}");
}
static void ready(CX_SESSION *session) {
    feed(session, "{\"method\":\"Runtime.consoleAPICalled\",\"params\":{\"executionContextId\":1,\"args\":[{\"type\":\"string\",\"value\":\"__CX_WIN_MSG__{\\\"kind\\\":\\\"ready\\\"}\"}]}}");
}
static void frame_tree(CX_SESSION *session, const char *url) {
    char *json = (char *)HeapAlloc(GetProcessHeap(), 0, 4096);
    DWORD at = 0, i = 0;
    const char *pre = "{\"id\":1,\"result\":{\"frameTree\":{\"frame\":{\"id\":\"top\",\"url\":\"";
    const char *post = "\"}}}}";
    if (!json) { check(FALSE, "frame tree fixture allocates"); return; }
    while (pre[i]) json[at++] = pre[i++];
    i = 0; while (url[i]) json[at++] = url[i++];
    i = 0; while (post[i]) json[at++] = post[i++];
    json[at] = 0;
    check(cx_session_frame_tree(session, json, at), "frame tree parses");
    HeapFree(GetProcessHeap(), 0, json);
}
static void run_lifecycle(void) {
    CX_SESSION *session = cx_session_create("https://a.chaoxing.com/exam", TRUE, TRUE);
    CX_SESSION_TASK boot, bundle, replacement;
    frame_tree(session, "https://a.chaoxing.com/exam");
    context(session);
    check(cx_session_stats(session)->contexts == 1, "default execution context is tracked");
    check(cx_session_next(session, &boot) && boot.type == CX_SESSION_TASK_BOOTSTRAP && boot.contextId == 1 && boot.top, "new context schedules bootstrap");
    ready(session);
    check(!cx_session_next(session, &bundle), "ready during bootstrap acknowledgement does not reenter injection");
    check(cx_session_complete(session, &boot, TRUE), "bootstrap completion is accepted");
    check(cx_session_next(session, &bundle) && bundle.type == CX_SESSION_TASK_BUNDLE, "ready schedules bundle after bootstrap completes");
    ready(session);
    check(!cx_session_next(session, &replacement), "bundle in flight is deduplicated");
    check(cx_session_complete(session, &bundle, TRUE), "bundle completion is accepted");
    ready(session);
    context(session);
    check(!cx_session_next(session, &replacement), "replayed contexts and ready do not inject twice");
    check(cx_session_stats(session)->bootstraps == 1 && cx_session_stats(session)->bundles == 1, "successful injection statistics are cumulative");
    cx_session_request_top_ensure(session);
    check(cx_session_next(session, &replacement) && replacement.type == CX_SESSION_TASK_BOOTSTRAP && replacement.ensure, "top ensure schedules a guarded bootstrap check");
    feed(session, "{\"method\":\"Runtime.executionContextDestroyed\",\"params\":{\"executionContextId\":1}}");
    check(!cx_session_task_active(session, &replacement) && !cx_session_complete(session, &replacement, TRUE), "destroyed context rejects late task completion");
    context(session);
    check(cx_session_next(session, &replacement) && replacement.generation != boot.generation, "reused context ID receives a new generation");
    feed(session, "{\"method\":\"Runtime.executionContextsCleared\",\"params\":{}}");
    check(!cx_session_task_active(session, &replacement) && cx_session_stats(session)->contexts == 0, "contexts cleared cancels in-flight injection");
    cx_session_close(session);
    context(session);
    cx_session_request_top_ensure(session);
    check(!cx_session_next(session, &replacement) && cx_session_stats(session)->closed, "closed session ignores late events and fallback requests");
    cx_session_free(session);
}
static void run_filter(const char *url, BOOL blank, BOOL enabled, BOOL expected) {
    CX_SESSION *session = cx_session_create(url, blank, enabled);
    CX_SESSION_TASK task;
    frame_tree(session, url);
    context(session);
    check(cx_session_next(session, &task) && cx_session_complete(session, &task, TRUE), "bootstrap remains available before URL filtering");
    ready(session);
    check(cx_session_next(session, &task) == expected, expected ? "permitted frame schedules bundle" : "foreign or disabled frame skips bundle");
    cx_session_free(session);
}
static void run_fallback(void) {
    CX_SESSION *session = cx_session_create("https://a.chaoxing.com/exam", TRUE, TRUE);
    CX_SESSION_TASK boot, bundle;
    cx_session_request_top_ensure(session);
    check(cx_session_next(session, &boot) && boot.contextId == 0 && boot.ensure, "missing context events allow top document fallback");
    check(cx_session_complete(session, &boot, TRUE), "fallback bootstrap completes");
    check(cx_session_next(session, &bundle) && bundle.type == CX_SESSION_TASK_BUNDLE && bundle.contextId == 0, "fallback can schedule a guarded bundle without ready replay");
    feed(session, "{\"method\":\"Page.frameNavigated\",\"params\":{\"frame\":{\"id\":\"top\",\"url\":\"https://a.chaoxing.com/new\"}}}");
    check(!cx_session_task_active(session, &bundle), "navigation invalidates the old synthetic context");
    cx_session_free(session);
}
static void run_messages(void) {
    CX_SESSION *session = cx_session_create("https://a.chaoxing.com", TRUE, TRUE);
    CX_SESSION_TASK task;
    feed(session, "{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":2,\"origin\":\"https://a.chaoxing.com\",\"auxData\":{\"isDefault\":false}}}}");
    feed(session, "{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":3,\"origin\":\"https://a.chaoxing.com\"}}}");
    check(cx_session_stats(session)->contexts == 0 && !cx_session_next(session, &task), "isolated or unclassified worlds are ignored");
    context(session);
    check(cx_session_next(session, &task) && cx_session_complete(session, &task, TRUE), "message fixture bootstraps");
    feed(session, "{\"method\":\"Runtime.consoleAPICalled\",\"params\":{\"executionContextId\":1,\"args\":[{\"type\":\"string\",\"value\":\"{\\\"kind\\\":\\\"ready\\\"}\"}]}}");
    feed(session, "{\"method\":\"Runtime.consoleAPICalled\",\"params\":{\"executionContextId\":1,\"args\":[{\"type\":\"string\",\"value\":\"__CX_WIN_MSG__{bad}\"}]}}");
    check(!cx_session_next(session, &task), "unprefixed and malformed console messages cannot mark a frame ready");
    check(!feed(session, "{bad}"), "malformed CDP JSON is rejected safely");
    ready(session);
    check(cx_session_next(session, &task), "valid ready message survives earlier malformed traffic");
    cx_session_free(session);
}
static void run_navigation(void) {
    CX_SESSION *session = cx_session_create("https://a.chaoxing.com", TRUE, TRUE);
    CX_SESSION_TASK old, task;
    frame_tree(session, "https://a.chaoxing.com/exam");
    context(session);
    check(cx_session_next(session, &old), "navigation fixture has in-flight bootstrap");
    feed(session, "{\"method\":\"Page.frameNavigated\",\"params\":{\"frame\":{\"id\":\"top\",\"url\":\"https://outside.test/exam\"}}}");
    check(!cx_session_task_active(session, &old) && !cx_session_complete(session, &old, TRUE), "navigation cancels a real context generation");
    check(cx_session_next(session, &task) && task.generation != old.generation && cx_session_complete(session, &task, TRUE), "navigation queues the replacement document bootstrap");
    ready(session);
    check(!cx_session_next(session, &task), "frame URL overrides an otherwise permitted context origin");
    feed(session, "{\"method\":\"Page.frameNavigated\",\"params\":{\"frame\":{\"id\":\"top\",\"url\":\"https://a.chaoxing.com/exam\"}}}");
    check(cx_session_next(session, &task) && cx_session_complete(session, &task, TRUE), "later permitted navigation bootstraps again");
    ready(session);
    check(cx_session_next(session, &task) && task.type == CX_SESSION_TASK_BUNDLE, "permitted replacement document receives a bundle");
    cx_session_free(session);
}
static void run_detach(void) {
    const char *tree = "{\"result\":{\"frameTree\":{\"frame\":{\"id\":\"top\",\"url\":\"https://a.chaoxing.com\"},\"childFrames\":[{\"frame\":{\"id\":\"child\",\"url\":\"about:blank\"},\"childFrames\":[{\"frame\":{\"id\":\"nested\",\"url\":\"about:blank\"}}]}]}}}";
    CX_SESSION *session = cx_session_create("https://a.chaoxing.com", TRUE, TRUE);
    CX_SESSION_TASK task;
    check(cx_session_frame_tree(session, tree, (DWORD)lstrlenA(tree)), "nested frame tree parses");
    feed(session, "{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":2,\"origin\":\"null\",\"auxData\":{\"isDefault\":true,\"frameId\":\"child\"}}}}");
    feed(session, "{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":3,\"origin\":\"null\",\"auxData\":{\"isDefault\":true,\"frameId\":\"nested\"}}}}");
    check(cx_session_stats(session)->contexts == 2 && cx_session_next(session, &task), "nested iframe contexts are scheduled");
    feed(session, "{\"method\":\"Page.frameDetached\",\"params\":{\"frameId\":\"child\"}}");
    check(cx_session_stats(session)->contexts == 0 && !cx_session_task_active(session, &task) && !cx_session_next(session, &task), "detaching a frame cancels its complete context subtree");
    cx_session_free(session);
}
static void run_failures(void) {
    CX_SESSION *session = cx_session_create("https://a.chaoxing.com", TRUE, TRUE);
    CX_SESSION_TASK task;
    context(session);
    check(cx_session_next(session, &task) && cx_session_complete(session, &task, FALSE), "final bootstrap failure is recorded");
    ready(session);
    check(!cx_session_next(session, &task) && cx_session_stats(session)->errors == 1, "failed bootstrap does not spin or permit a premature bundle");
    feed(session, "{\"method\":\"Runtime.consoleAPICalled\",\"params\":{\"executionContextId\":1,\"args\":[{\"type\":\"string\",\"value\":\"__CX_WIN_MSG__{\\\"kind\\\":\\\"boot-request\\\"}\"}]}}");
    check(cx_session_next(session, &task) && task.type == CX_SESSION_TASK_BOOTSTRAP && cx_session_complete(session, &task, TRUE), "a later explicit boot request can retry the failed context");
    feed(session, "{\"method\":\"Runtime.consoleAPICalled\",\"params\":{\"executionContextId\":1,\"args\":[{\"type\":\"string\",\"value\":\"__CX_WIN_MSG__{\\\"kind\\\":\\\"disabled\\\"}\"}]}}");
    ready(session);
    check(!cx_session_next(session, &task), "disabled page messages prohibit business injection");
    cx_session_free(session);
}
static void run_capacity(void) {
    const char *prefix = "{\"method\":\"Runtime.executionContextCreated\",\"params\":{\"context\":{\"id\":";
    const char *suffix = ",\"origin\":\"https://a.chaoxing.com\",\"auxData\":{\"isDefault\":true,\"frameId\":\"top\"}}}}";
    CX_SESSION *session = cx_session_create("https://a.chaoxing.com", TRUE, TRUE);
    DWORD index, i, at, count, value;
    char json[512], digits[16];
    BOOL accepted = TRUE;
    for (index = 1; index <= CX_SESSION_MAX_CONTEXTS + 1; ++index) {
        at = 0; i = 0;
        while (prefix[i]) json[at++] = prefix[i++];
        value = index; count = 0;
        do { digits[count++] = (char)('0' + value % 10); value /= 10; } while (value);
        while (count) json[at++] = digits[--count];
        i = 0; while (suffix[i]) json[at++] = suffix[i++];
        json[at] = 0;
        if (cx_session_feed(session, json, at) != (index <= CX_SESSION_MAX_CONTEXTS)) accepted = FALSE;
    }
    check(accepted && cx_session_stats(session)->contexts == CX_SESSION_MAX_CONTEXTS && cx_session_stats(session)->errors == 1, "context capacity is bounded without overwriting live generations");
    cx_session_free(session);
}
void __stdcall SessionTestMain(void) {
    run_lifecycle();
    run_filter("https://chaoxing.com/exam", TRUE, TRUE, TRUE);
    run_filter("https://a.chaoxing.com:443/exam", TRUE, TRUE, TRUE);
    run_filter("https://evilchaoxing.com/exam", TRUE, TRUE, FALSE);
    run_filter("https://chaoxing.com.evil.test/exam", TRUE, TRUE, FALSE);
    run_filter("https://chaoxing.com@evil.test/exam", TRUE, TRUE, FALSE);
    run_filter("about:blank", TRUE, TRUE, TRUE);
    run_filter("about:blank", FALSE, TRUE, FALSE);
    run_filter("https://chaoxing.com/exam", TRUE, FALSE, FALSE);
    run_fallback();
    run_messages();
    run_navigation();
    run_detach();
    run_failures();
    run_capacity();
    output(failures ? "NATIVE SESSION TESTS FAIL\n" : "NATIVE SESSION TESTS PASS\n");
    ExitProcess(failures ? 1 : 0);
}
