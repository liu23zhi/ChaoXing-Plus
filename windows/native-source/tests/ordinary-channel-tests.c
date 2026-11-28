/* Uses a real owned x86 process/job and named pipe, never browser registry or network. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include "../ordinary-channel.inc"

#define CHECK(expr) do { if (!(expr)) { \
    fprintf(stderr, "line %d: %s (win32=%lu)\n", __LINE__, #expr, GetLastError()); return 1; \
} } while (0)
#define ALLOWED "{\"allowed\":true}"
#define DENIED "{\"allowed\":false}"

static const WCHAR extension[] = L"abcdefghijklmnopabcdefghijklmnop";
static const WCHAR validOrigin[] = L"chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
static const WCHAR wrongOrigin[] = L"chrome-extension://pppppppppppppppppppppppppppppppp/";

typedef struct FIXTURE {
    volatile LONG calls;
    volatile LONG allowed;
} FIXTURE;

static BOOL evaluate(void *opaque) {
    FIXTURE *fixture = (FIXTURE *)opaque;
    InterlockedIncrement(&fixture->calls);
    return InterlockedCompareExchange(&fixture->allowed, 0, 0) != 0;
}

static BOOL native_message(HANDLE job, const WCHAR *origin, const WCHAR *windowArg, const char *request,
                           DWORD announcedLength, const char *expected) {
    SECURITY_ATTRIBUTES inherit = {sizeof(inherit), NULL, TRUE};
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION child = {0};
    HANDLE inReader = NULL, inWriter = NULL, outReader = NULL, outWriter = NULL;
    WCHAR exe[MAX_PATH], command[MAX_PATH + 160];
    DWORD code, size, copied, actual = (DWORD)strlen(request);
    char reply[64] = {0};
    BOOL ok = FALSE;
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    if (!GetModuleFileNameW(NULL, exe, ARRAYSIZE(exe)) ||
        swprintf_s(command, ARRAYSIZE(command), L"\"%s\" %s %s", exe, origin, windowArg) < 0 ||
        !CreatePipe(&inReader, &inWriter, &inherit, 0) || !CreatePipe(&outReader, &outWriter, &inherit, 0) ||
        !SetHandleInformation(inWriter, HANDLE_FLAG_INHERIT, 0) ||
        !SetHandleInformation(outReader, HANDLE_FLAG_INHERIT, 0)) goto done;
    startup.hStdInput = inReader;
    startup.hStdOutput = outWriter;
    startup.hStdError = outWriter;
    if (!CreateProcessW(exe, command, NULL, NULL, TRUE, CREATE_SUSPENDED, NULL, NULL, &startup, &child)) goto done;
    CloseHandle(inReader); inReader = NULL;
    CloseHandle(outWriter); outWriter = NULL;
    if ((job && !AssignProcessToJobObject(job, child.hProcess)) ||
        !WriteFile(inWriter, &announcedLength, sizeof(announcedLength), &copied, NULL) ||
        copied != sizeof(announcedLength) ||
        !WriteFile(inWriter, request, actual, &copied, NULL) || copied != actual) goto done;
    CloseHandle(inWriter); inWriter = NULL;
    if (ResumeThread(child.hThread) == (DWORD)-1 ||
        WaitForSingleObject(child.hProcess, 18000) != WAIT_OBJECT_0 ||
        !GetExitCodeProcess(child.hProcess, &code) || code ||
        !ReadFile(outReader, &size, sizeof(size), &copied, NULL) || copied != sizeof(size) ||
        size != strlen(expected) || !ReadFile(outReader, reply, size, &copied, NULL) ||
        copied != size || strcmp(reply, expected) ||
        ReadFile(outReader, reply, 1, &copied, NULL) || GetLastError() != ERROR_BROKEN_PIPE) goto done;
    ok = TRUE;
done:
    if (child.hProcess) {
        if (WaitForSingleObject(child.hProcess, 0) == WAIT_TIMEOUT) TerminateProcess(child.hProcess, 2);
        CloseHandle(child.hProcess);
    }
    if (child.hThread) CloseHandle(child.hThread);
    if (inReader) CloseHandle(inReader);
    if (inWriter) CloseHandle(inWriter);
    if (outReader) CloseHandle(outReader);
    if (outWriter) CloseHandle(outWriter);
    return ok;
}

int wmain(void) {
    int brokerExit = 2;
    FIXTURE fixture = {0, 1};
    CX_ORDINARY_CHANNEL *channel;
    HANDLE job, otherJob, nonJob;
    ULONGLONG closing;
    WCHAR instance[37];
    char valid[160], whitespace[160], extra[160], duplicate[160], wrongScope[160];
    if (cx_ordinary_channel_broker(&brokerExit)) return brokerExit;

    CHECK(sizeof(void *) == 4);
    CHECK(swprintf_s(instance, ARRAYSIZE(instance), L"13572468-2468-4123-8abc-%08lx%04lx",
                     GetCurrentProcessId(), GetTickCount() & 0xffffUL) == 36);
    CHECK(sprintf_s(valid, sizeof(valid), "{\"op\":\"authorize\",\"instance\":\"%ls\"}", instance) > 0);
    CHECK(sprintf_s(whitespace, sizeof(whitespace), " { \"instance\" : \"%ls\", \r\n \"op\" : \"authorize\" }\n", instance) > 0);
    CHECK(sprintf_s(extra, sizeof(extra), "{\"op\":\"authorize\",\"instance\":\"%ls\",\"credential\":\"fixture\"}", instance) > 0);
    CHECK(sprintf_s(duplicate, sizeof(duplicate), "{\"op\":\"authorize\",\"instance\":\"%ls\",\"op\":\"authorize\"}", instance) > 0);
    CHECK(sprintf_s(wrongScope, sizeof(wrongScope), "{\"op\":\"authorize\",\"instance\":\"13572468-2468-4123-8abc-000000000000\"}") > 0);
    job = CreateJobObjectW(NULL, NULL);
    otherJob = CreateJobObjectW(NULL, NULL);
    nonJob = CreateEventW(NULL, TRUE, FALSE, NULL);
    CHECK(job && otherJob && nonJob);
    CHECK(!cx_oc_start(L"../../../outside", extension, evaluate, &fixture));
    CHECK(!cx_oc_start(instance, L"abc", evaluate, &fixture));
    channel = cx_oc_start(instance, extension, evaluate, &fixture);
    CHECK(channel != NULL);
    CHECK(wcsncmp(cx_ordinary_channel_name(channel), L"org.cxplus.ordinary_", 20) == 0);
    CHECK(!cx_oc_start(instance, extension, evaluate, &fixture));

    CHECK(native_message(job, validOrigin, L"--parent-window=0", valid, (DWORD)strlen(valid), DENIED));
    CHECK(fixture.calls == 0);
    CHECK(!cx_ordinary_channel_attach_job(channel, nonJob));
    CloseHandle(nonJob);
    CHECK(cx_ordinary_channel_attach_job(channel, job));
    CHECK(!cx_ordinary_channel_attach_job(channel, otherJob));
    CHECK(native_message(NULL, validOrigin, L"--parent-window=0", valid, (DWORD)strlen(valid), DENIED));
    CHECK(native_message(otherJob, validOrigin, L"--parent-window=0", valid, (DWORD)strlen(valid), DENIED));
    CHECK(native_message(job, wrongOrigin, L"--parent-window=0", valid, (DWORD)strlen(valid), DENIED));
    CHECK(native_message(job, validOrigin, L"--parent-window=invalid", valid, (DWORD)strlen(valid), DENIED));
    CHECK(native_message(job, validOrigin, L"--parent-window=0", extra, (DWORD)strlen(extra), DENIED));
    CHECK(native_message(job, validOrigin, L"--parent-window=0", duplicate, (DWORD)strlen(duplicate), DENIED));
    CHECK(native_message(job, validOrigin, L"--parent-window=0", wrongScope, (DWORD)strlen(wrongScope), DENIED));
    CHECK(native_message(job, validOrigin, L"--parent-window=0", valid, (DWORD)strlen(valid) + 4, DENIED));
    CHECK(native_message(job, validOrigin, L"--parent-window=0", valid, 300, DENIED));
    CHECK(fixture.calls == 0);

    CHECK(native_message(job, validOrigin, L"--parent-window=0", valid, (DWORD)strlen(valid), ALLOWED));
    CHECK(fixture.calls == 1);
    CHECK(native_message(job, validOrigin, L"--parent-window=0", whitespace, (DWORD)strlen(whitespace), ALLOWED));
    CHECK(fixture.calls == 2);
    InterlockedExchange(&fixture.allowed, 0);
    CHECK(native_message(job, validOrigin, L"--parent-window=0", valid, (DWORD)strlen(valid), DENIED));
    CHECK(fixture.calls == 3);

    closing = GetTickCount64();
    cx_ordinary_channel_close(channel);
    CHECK(GetTickCount64() - closing < 2000);
    CHECK(native_message(job, validOrigin, L"--parent-window=0", valid, (DWORD)strlen(valid), DENIED));
    CHECK(fixture.calls == 3);
    CloseHandle(otherJob);
    CloseHandle(job);
    puts("PASS ordinary result channel: trusted x86 process/job, strict allow/deny, wrong job/origin/frame rejected, scoped close");
    return 0;
}
