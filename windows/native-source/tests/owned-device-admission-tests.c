/* Windows x86, real configuration files, only an owned substitute for HTTP. */
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include "../adapter-account.h"
#include "../device-quota.h"
#include "../json.h"

#ifndef _M_IX86
#error The native host contract must exercise the x86 ABI.
#endif

#define CHECK(x) do { if (!(x)) { \
    fprintf(stderr, "native admission assertion failed (line %d): %s\n", __LINE__, #x); return 1; \
} } while (0)

static const WCHAR fixturePath[] = L"owned-device-config.json";
static const WCHAR resource[] = L"https://fixture.invalid";
static const WCHAR fixtureKey[] = L"fixture-key-only";
static const WCHAR oldID[] = L"exe:owned-confirmed";
static const char oldFile[] = "{\"version\":9,\"opaque\":[{\"keep\":true}],\"settings\":{"
    "\"unknown.interleaved\":{\"v\":[1,2]},\"common.settings.device-id\":\"exe:owned-confirmed\","
    "\"unknown.scalar\":17,\"common.settings.keep\":\"value\",\"common.work-results.results\":[3]},\"localOnly\":false,\"settings\\u00ad\":7}";
static const char neverAdmitted[] = "{\"settings\":{\"unknown.interleaved\":{\"v\":[1,2]},"
    "\"unknown.scalar\":17,\"common.settings.keep\":\"value\",\"common.work-results.results\":[3]},"
    "\"version\":9,\"opaque\":[{\"keep\":true}],\"localOnly\":false,\"settings\\u00ad\":7}";

enum SCENARIO { ACCEPT, CONFLICT_ONCE, CONFLICT_ALWAYS, CONFLICT_MALFORMED, GENERIC409, FORBIDDEN,
    ACCOUNT_DENIED, UNAUTHORIZED, BAD_GATEWAY, WRONG_ID, WRONG_STATUS, ABSENT, CORRUPT, ESCAPED_NUL,
    FALSE_ADMITTED, STRING_ADMITTED, DUPLICATE_ID, MALFORMED_UTF8, LOST_AFTER_ACCEPT, BLOCK_PROMOTION, REENTER };

static enum SCENARIO scenario;
static unsigned requests, committed;
static WCHAR devices[8][CX_DEVICE_ID_CAP], instances[8][CX_DEVICE_INSTANCE_CAP], remoteDevice[CX_DEVICE_ID_CAP];
static HANDLE writeBarrier = INVALID_HANDLE_VALUE;
static char fileBeforePromotion[8192], response[512];
static BOOL reentered;

static BOOL writeFixture(const char *json) {
    DWORD written = 0, len = (DWORD)strlen(json);
    HANDLE file = CreateFileW(fixturePath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    BOOL ok = file != INVALID_HANDLE_VALUE && WriteFile(file, json, len, &written, NULL) && written == len;
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    return ok;
}
static BOOL readFixture(char *out, DWORD cap) {
    DWORD read = 0;
    HANDLE file = CreateFileW(fixturePath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    BOOL ok = file != INVALID_HANDLE_VALUE && ReadFile(file, out, cap - 1, &read, NULL) && read < cap - 1;
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    out[ok ? read : 0] = 0;
    return ok;
}

static BOOL admit(const WCHAR *url, const WCHAR *key, BOOL diskless, BOOL script, WCHAR *out) {
    WCHAR err[128];
#ifdef CX_DEVICE_ADMISSION_PENDING_KEY
    return cx_device_host_admit(fixturePath, url, key, script ? CX_DEVICE_HOST_SCRIPT : CX_DEVICE_HOST_ORDINARY,
        diskless, 4000, out, CX_DEVICE_ID_CAP, err, ARRAYSIZE(err));
#else
    /* Exact baseline had no explicit admission; compare its real native identity
       entry, not a simulation of the desired state machine. */
    (void)url; (void)key; (void)script;
    return cx_device_id_ensure(fixturePath, diskless, out, CX_DEVICE_ID_CAP, err, ARRAYSIZE(err));
#endif
}

static int field(const char *json, JT *tokens, int object, const char *key) {
    return jkey(json, tokens, object, key);
}
static BOOL checkConfig(const WCHAR *id, BOOL pending) {
    char json[8192];
    JT t[256]; int settings, key, value;
    WCHAR stored[CX_DEVICE_ID_CAP];
    if (!readFixture(json, sizeof(json)) || jparse(json, (int)strlen(json), t, ARRAYSIZE(t)) < 1) return FALSE;
    settings = field(json, t, 0, "settings");
    key = field(json, t, settings, CX_DEVICE_ID_KEY);
    if (id ? (key < 0 || !jwstr(json, t, key, stored, ARRAYSIZE(stored)) || lstrcmpW(id, stored)) : key >= 0) return FALSE;
    if (field(json, t, settings, "nativeDeviceAdmissionPending") >= 0 || strstr(json, "fixture-key-only")) return FALSE;
    value = field(json, t, 0, "nativeDeviceAdmissionPending");
    if (pending ? (value < 0 || t[value].type != '{') : (value >= 0 && !jeq(json, t, value, "null"))) return FALSE;
    return jeq(json, t, field(json, t, 0, "version"), "9")
        && jeq(json, t, field(json, t, 0, "opaque"), "[{\"keep\":true}]")
        && jeq(json, t, field(json, t, 0, "localOnly"), "false")
        && jeq(json, t, field(json, t, 0, "settings\xc2\xad"), "7")
        && jeq(json, t, field(json, t, settings, "unknown.interleaved"), "{\"v\":[1,2]}")
        && jeq(json, t, field(json, t, settings, "unknown.scalar"), "17")
        && jeq(json, t, field(json, t, settings, "common.settings.keep"), "value")
        && jeq(json, t, field(json, t, settings, "common.work-results.results"), "[3]");
}

static void replyWith(CX_ADAPTER_REPLY *reply, DWORD status, const char *body) {
    reply->status = status; reply->body = (char *)body; reply->length = body ? (DWORD)strlen(body) : 0;
}
BOOL cx_adapter_request(const WCHAR *base, const WCHAR *method, const WCHAR *path,
    const WCHAR *auth, const char *json, DWORD timeout, DWORD limit,
    CX_ADAPTER_REPLY *reply, WCHAR *error, DWORD errorCap) {
    unsigned index = requests++;
    JT t[16]; char id[CX_DEVICE_ID_CAP]; int d, i;
    (void)error; (void)errorCap;
    if (index >= ARRAYSIZE(devices) || lstrcmpW(base, resource) || lstrcmpW(method, L"POST")
        || lstrcmpW(path, L"/api/user/device-admission") || lstrcmpW(auth, L"Bearer fixture-key-only")
        || !timeout || limit > 4096 || !reply || !json ||
        jparse(json, lstrlenA(json), t, ARRAYSIZE(t)) < 1 || t[0].type != '{' || t[0].count != 4)
        return FALSE;
    d = jkey(json, t, 0, "deviceId"); i = jkey(json, t, 0, "clientInstance");
    if (!jstr(json, t, d, id, sizeof(id)) || !id[0] ||
        !jwstr(json, t, d, devices[index], ARRAYSIZE(devices[index])) ||
        !jwstr(json, t, i, instances[index], ARRAYSIZE(instances[index])) || !instances[index][0]) return FALSE;
    if (scenario == CONFLICT_ALWAYS || (scenario == CONFLICT_ONCE && index == 0)) {
        replyWith(reply, 409, "{\"code\":\"DEVICE_ID_CONFLICT\",\"message\":\"owned\"}"); return TRUE;
    }
    if (scenario == CONFLICT_MALFORMED) {
        replyWith(reply, 409, "{\"code\":\"DEVICE_ID_CONFLICT\",\"code\":\"BAD\"}"); return TRUE;
    }
    if (scenario == GENERIC409) { replyWith(reply, 409, "{\"code\":\"OTHER\"}"); return TRUE; }
    if (scenario == FORBIDDEN) { replyWith(reply, 403, "{\"code\":\"DEVICE_LIMIT_EXCEEDED\"}"); return TRUE; }
    if (scenario == ACCOUNT_DENIED) { replyWith(reply, 403, "{\"code\":\"DEVICE_ID_CONFLICT\"}"); return TRUE; }
    if (scenario == UNAUTHORIZED) { replyWith(reply, 401, NULL); return TRUE; }
    if (scenario == BAD_GATEWAY) { replyWith(reply, 503, NULL); return TRUE; }
    if (scenario == ABSENT) { replyWith(reply, 200, NULL); return TRUE; }
    if (scenario == CORRUPT) { replyWith(reply, 200, "{\"admitted\":true"); return TRUE; }
    if (scenario == WRONG_ID) { replyWith(reply, 200, "{\"admitted\":true,\"deviceId\":\"wrong\"}"); return TRUE; }
    if (scenario == ESCAPED_NUL) {
        sprintf_s(response, sizeof(response), "{\"admitted\":true,\"deviceId\":\"%s\\u0000extra\"}", id);
        replyWith(reply, 200, response); return TRUE;
    }
    if (scenario == DUPLICATE_ID) {
        sprintf_s(response, sizeof(response), "{\"admitted\":true,\"deviceId\":\"%s\",\"deviceId\":\"wrong\"}", id);
        replyWith(reply, 200, response); return TRUE;
    }
    if (scenario == MALFORMED_UTF8) {
        replyWith(reply, 200, "{\"admitted\":true,\"deviceId\":\"\xff\"}"); return TRUE;
    }
    if (scenario == FALSE_ADMITTED || scenario == STRING_ADMITTED) {
        sprintf_s(response, sizeof(response), "{\"admitted\":%s,\"deviceId\":\"%s\"}",
            scenario == FALSE_ADMITTED ? "false" : "\"true\"", id);
        replyWith(reply, 200, response); return TRUE;
    }
    if (scenario == REENTER && index == 0) {
        WCHAR out[CX_DEVICE_ID_CAP];
        reentered = admit(resource, fixtureKey, FALSE, FALSE, out);
    }
    if (lstrcmpW(remoteDevice, devices[index])) { ++committed; lstrcpyW(remoteDevice, devices[index]); }
    if (scenario == LOST_AFTER_ACCEPT) return FALSE;
    if (scenario == BLOCK_PROMOTION) {
        if (!readFixture(fileBeforePromotion, sizeof(fileBeforePromotion))) return FALSE;
        writeBarrier = CreateFileW(fixturePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (writeBarrier == INVALID_HANDLE_VALUE) return FALSE;
    }
    sprintf_s(response, sizeof(response), "{\"admitted\":true,\"deviceId\":\"%s\"}", id);
    replyWith(reply, scenario == WRONG_STATUS ? 201 : 200, response); return TRUE;
}
void cx_adapter_reply_free(CX_ADAPTER_REPLY *reply) { ZeroMemory(reply, sizeof(*reply)); }

static void phase(enum SCENARIO next) {
    requests = committed = 0; remoteDevice[0] = 0; scenario = next; reentered = FALSE;
}

static int splitProcess(BOOL reopen) {
    const WCHAR *stateFile = L"owned-modeled-remote.bin";
    WCHAR out[CX_DEVICE_ID_CAP], previous[CX_DEVICE_ID_CAP], priorInstance[CX_DEVICE_INSTANCE_CAP];
    HANDLE file;
    DWORD got;
    if (!reopen) {
        phase(LOST_AFTER_ACCEPT);
        CHECK(writeFixture(neverAdmitted)); lstrcpyW(out, L"unchanged");
        CHECK(!admit(resource, fixtureKey, FALSE, FALSE, out));
        CHECK(requests == 1 && committed == 1 && checkConfig(NULL, TRUE) && !lstrcmpW(out, L"unchanged"));
        file = CreateFileW(stateFile, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        CHECK(file != INVALID_HANDLE_VALUE);
        CHECK(WriteFile(file, devices[0], sizeof(previous), &got, NULL) && got == sizeof(previous));
        CHECK(WriteFile(file, instances[0], sizeof(priorInstance), &got, NULL) && got == sizeof(priorInstance));
        CHECK(CloseHandle(file));
        puts("first native process: one modeled commit, publication unchanged, pending durable");
        return 0;
    }
    file = CreateFileW(stateFile, GENERIC_READ, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    CHECK(file != INVALID_HANDLE_VALUE);
    CHECK(ReadFile(file, previous, sizeof(previous), &got, NULL) && got == sizeof(previous));
    CHECK(ReadFile(file, priorInstance, sizeof(priorInstance), &got, NULL) && got == sizeof(priorInstance));
    CHECK(CloseHandle(file));
    phase(ACCEPT); committed = 1; lstrcpyW(remoteDevice, previous);
    CHECK(admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(requests == 1 && committed == 1 && !lstrcmpW(previous, devices[0]) &&
        !lstrcmpW(priorInstance, instances[0]) && !lstrcmpW(previous, out) && checkConfig(out, FALSE));
    CHECK(DeleteFileW(stateFile) && DeleteFileW(fixturePath));
    puts("second native process: same id and instance; modeled binding still one");
    return 0;
}

int main(int argc, char **argv) {
    WCHAR out[CX_DEVICE_ID_CAP], chosen[CX_DEVICE_ID_CAP], instance[CX_DEVICE_INSTANCE_CAP];
    char before[8192], after[8192];
    unsigned i;
    const enum SCENARIO refused[] = {CONFLICT_MALFORMED, GENERIC409, FORBIDDEN, ACCOUNT_DENIED, UNAUTHORIZED,
        BAD_GATEWAY, WRONG_ID, WRONG_STATUS, ABSENT, CORRUPT, ESCAPED_NUL, FALSE_ADMITTED, STRING_ADMITTED,
        DUPLICATE_ID, MALFORMED_UTF8};

    if (argc == 2 && !strcmp(argv[1], "--stage-exit")) return splitProcess(FALSE);
    if (argc == 2 && !strcmp(argv[1], "--reopen")) return splitProcess(TRUE);
    CHECK(argc == 1);
    CHECK(writeFixture(neverAdmitted));
    phase(ACCEPT);
    CHECK(admit(resource, fixtureKey, FALSE, FALSE, out));
    printf("positive transport_requests=%u admitted=%d\n", requests, (int)(requests == 1));
    CHECK(requests == 1 && committed == 1 && !lstrcmpW(out, devices[0]) && checkConfig(out, FALSE));

    phase(CONFLICT_ONCE);
    CHECK(writeFixture(oldFile));
    CHECK(admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(requests == 2 && committed == 1 && !lstrcmpW(devices[0], oldID) &&
        lstrcmpW(devices[0], devices[1]) && lstrcmpW(instances[0], instances[1]) &&
        !lstrcmpW(out, devices[1]) && checkConfig(out, FALSE));
    puts("conflict: exactly one distinct attempt; only confirmed final id persisted");

    phase(CONFLICT_ALWAYS);
    CHECK(writeFixture(oldFile)); lstrcpyW(out, oldID);
    CHECK(!admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(requests == 2 && committed == 0 && !lstrcmpW(out, oldID) && checkConfig(oldID, TRUE));
    lstrcpyW(chosen, devices[1]); lstrcpyW(instance, instances[1]);
    CHECK(!admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(requests == 3 && !lstrcmpW(chosen, devices[2]) && !lstrcmpW(instance, instances[2]) && checkConfig(oldID, TRUE));

    for (i = 0; i < ARRAYSIZE(refused); ++i) {
        phase(refused[i]); CHECK(writeFixture(oldFile)); lstrcpyW(out, oldID);
        CHECK(!admit(resource, fixtureKey, FALSE, FALSE, out));
        CHECK(requests == 1 && !lstrcmpW(out, oldID) && checkConfig(oldID, TRUE));
    }
    printf("fail-closed variants=%u\n", (unsigned)ARRAYSIZE(refused));

    phase(LOST_AFTER_ACCEPT);
    CHECK(writeFixture(neverAdmitted)); lstrcpyW(out, L"preexisting-publication");
    CHECK(!admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(requests == 1 && committed == 1 && checkConfig(NULL, TRUE) && !lstrcmpW(out, L"preexisting-publication"));
    CHECK(!admit(L"https://different.invalid", fixtureKey, FALSE, FALSE, out));
    CHECK(!admit(resource, L"other-key", FALSE, FALSE, out));
    CHECK(requests == 1 && checkConfig(NULL, TRUE));
    scenario = ACCEPT;
    CHECK(admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(requests == 2 && committed == 1 && !lstrcmpW(devices[0], devices[1]) &&
        !lstrcmpW(instances[0], instances[1]) && !lstrcmpW(out, devices[0]) && checkConfig(out, FALSE));
    puts("lost acknowledgement: persisted pending retry reused id and instance; one modeled binding");

    phase(BLOCK_PROMOTION);
    CHECK(writeFixture(oldFile)); lstrcpyW(out, oldID);
    CHECK(!admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(writeBarrier != INVALID_HANDLE_VALUE && CloseHandle(writeBarrier));
    writeBarrier = INVALID_HANDLE_VALUE;
    CHECK(requests == 1 && committed == 1 && !lstrcmpW(out, oldID) &&
        readFixture(after, sizeof(after)) && !strcmp(after, fileBeforePromotion) && checkConfig(oldID, TRUE));
    scenario = ACCEPT;
    CHECK(admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(requests == 2 && committed == 1 && !lstrcmpW(devices[0], devices[1]) && checkConfig(out, FALSE));
    puts("blocked atomic promotion: prior bytes and publication retained, same pending state reused");

    phase(ACCEPT);
    CHECK(writeFixture(oldFile)); CHECK(readFixture(before, sizeof(before))); lstrcpyW(out, oldID);
    CHECK(!admit(resource, fixtureKey, TRUE, FALSE, out));
    CHECK(!admit(resource, fixtureKey, FALSE, TRUE, out));
    CHECK(!admit(resource, L"", FALSE, FALSE, out));
    CHECK(!admit(resource, L"key\r\nInjected", FALSE, FALSE, out));
    CHECK(requests == 0 && !lstrcmpW(out, oldID) && readFixture(after, sizeof(after)) && !strcmp(before, after));
    CHECK(GetFileAttributesW(L"owned-device-config.json.device-admission.lock") == INVALID_FILE_ATTRIBUTES);
    writeBarrier = CreateFileW(fixturePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    CHECK(writeBarrier != INVALID_HANDLE_VALUE);
    CHECK(!admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(CloseHandle(writeBarrier)); writeBarrier = INVALID_HANDLE_VALUE;
    CHECK(requests == 0 && !lstrcmpW(out, oldID) && readFixture(after, sizeof(after)) && !strcmp(before, after));
    CHECK(writeFixture("{\"settings\":{\"common.settings.device-id\":\"first\",\"common.settings.device-id\":\"second\"}}"));
    CHECK(readFixture(before, sizeof(before)));
    CHECK(!admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(requests == 0 && readFixture(after, sizeof(after)) && !strcmp(before, after));
    puts("no-disk, script, invalid credential, ambiguous file: no transport or writes");

    phase(REENTER);
    CHECK(writeFixture(oldFile));
    CHECK(admit(resource, fixtureKey, FALSE, FALSE, out));
    CHECK(requests == 1 && !reentered && checkConfig(out, FALSE));
    CHECK(DeleteFileW(fixturePath));
    puts("concurrent entry against the same config did not create another binding");
    return 0;
}
