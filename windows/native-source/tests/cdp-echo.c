/* 假 CDP 对端（管道版）：循环读帧并按方法名回最小可用响应，记录收到的方法。 */
#include "../net.c"

static BOOL has_text_a(const char *haystack, const char *needle) {
    int i, k;
    if (!haystack || !needle) return FALSE;
    for (i = 0; haystack[i]; ++i) {
        for (k = 0; needle[k] && haystack[i + k] == needle[k]; ++k) { }
        if (!needle[k]) return TRUE;
    }
    return FALSE;
}

static int request_id(const char *json) {
    int i = 0;
    while (json[i]) {
        if (json[i] == '"' && json[i + 1] == 'i' && json[i + 2] == 'd' && json[i + 3] == '"') {
            int j = i + 4, id = 0;
            while (json[j] == ':' || json[j] == ' ') ++j;
            while (json[j] >= '0' && json[j] <= '9') { id = id * 10 + (json[j] - '0'); ++j; }
            return id;
        }
        ++i;
    }
    return 1;
}

static void record(const char *json) {
    static const char *names[] = { "Browser.getVersion", "Target.getTargets", "Target.attachToTarget", "Target.setDiscoverTargets", "Page.enable", "Runtime.enable", "Runtime.evaluate" };
    char path[MAX_PATH];
    HANDLE file;
    DWORD written = 0;
    int i;
    for (i = 0; i < (int)(sizeof(names) / sizeof(names[0])); ++i) {
        if (has_text_a(json, names[i])) {
            if (!GetTempPathA(MAX_PATH, path)) return;
            lstrcatA(path, "cx-pipe-methods.txt");
            file = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (file != INVALID_HANDLE_VALUE) {
                lstrcatA(path, "");
                WriteFile(file, names[i], (DWORD)lstrlenA(names[i]), &written, NULL);
                WriteFile(file, "\r\n", 2, &written, NULL);
                CloseHandle(file);
            }
            return;
        }
    }
}

void __stdcall CdpEchoMain(void) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    char *payload = NULL;
    DWORD length = 0;
    char reply[512];
    DWORD started = GetTickCount();
    while (GetTickCount() - started < 30000) {
        int id;
        if (net_pipe_recv_frame(input, &payload, &length, 2000) != 1) {
            if (!payload) { Sleep(10); }
            continue;
        }
        id = request_id(payload);
        record(payload);
        if (has_text_a(payload, "Target.getTargets")) {
            wsprintfA(reply, "{\"id\":%d,\"result\":{\"targetInfos\":[{\"targetId\":\"CXFIXTURE\",\"type\":\"page\",\"title\":\"fixture\",\"url\":\"https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/fixture\",\"attached\":true}]}}", id);
        } else if (has_text_a(payload, "Target.attachToTarget")) {
            wsprintfA(reply, "{\"id\":%d,\"result\":{\"sessionId\":\"CXSESSION\"}}", id);
        } else if (has_text_a(payload, "Browser.getVersion")) {
            wsprintfA(reply, "{\"id\":%d,\"result\":{\"product\":\"Chrome/75.0.3770.100\",\"protocolVersion\":\"1.2\"}}", id);
        } else {
            wsprintfA(reply, "{\"id\":%d,\"result\":{\"result\":{\"type\":\"boolean\",\"value\":true},\"identifier\":\"1\"}}", id);
        }
        net_free(payload);
        payload = NULL;
        if (!net_pipe_send_frame(output, reply, (DWORD)lstrlenA(reply))) break;
    }
    ExitProcess(0);
}

