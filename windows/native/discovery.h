#ifndef CX_DISCOVERY_H
#define CX_DISCOVERY_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#define CX_DISCOVERY_MAX_CANDIDATES 1024
#define CX_DISCOVERY_MAX_PATH 32768
#define CX_DISCOVERY_VERSION_CAP 64

#define CX_DISCOVERY_MACHINE_X86 0x014c
#define CX_DISCOVERY_MACHINE_X64 0x8664

typedef enum CX_DISCOVERY_SCAN_MODE {
    CX_DISCOVERY_SCAN_COMMON = 0,
    CX_DISCOVERY_SCAN_FALLBACK_ALL = 1,
    CX_DISCOVERY_SCAN_ALL = 2
} CX_DISCOVERY_SCAN_MODE;

/* The caller owns the strings and keeps them alive for the duration of a scan. */
typedef struct CX_DISCOVERY_ROOTS {
    const WCHAR *const *commonRoots;
    DWORD commonRootCount;
    const WCHAR *const *fixedRoots;
    DWORD fixedRootCount;
} CX_DISCOVERY_ROOTS;

typedef struct CX_CLIENT_CANDIDATE {
    WCHAR *path;                 /* HeapAlloc'd; released by cx_discovery_free. */
    WORD machine;                /* CX_DISCOVERY_MACHINE_X86 or _X64. */
    WCHAR version[CX_DISCOVERY_VERSION_CAP];
} CX_CLIENT_CANDIDATE;

typedef struct CX_DISCOVERY_RESULT {
    CX_CLIENT_CANDIDATE *items;
    DWORD count;
    DWORD capacity;
    DWORD recommendedIndex;
    BOOL commonScanned;
    BOOL fallbackScanned;
    BOOL stoppedOnX86;
    BOOL truncated;
} CX_DISCOVERY_RESULT;

typedef struct CX_DISCOVERY_OPTIONS {
    CX_DISCOVERY_SCAN_MODE mode;
    const WCHAR *clientPath;     /* Optional explicit file or directory target. */
    const CX_DISCOVERY_ROOTS *roots; /* NULL uses the Windows default roots. */
    /* TRUE means the host is constrained to a 32-bit OS.  A 32-bit host
       process running under WOW64 must leave this FALSE: x64 CXExam clients
       are still valid because CDP is not limited by host process bitness. */
    BOOL hostIs32Bit;
    /* Keep collecting candidates instead of selecting the first x86 during
       fallback traversal.  This is required by --list-clients and GUI
       selection.  Scan-all always enumerates completely regardless of this. */
    BOOL enumerateAll;
} CX_DISCOVERY_OPTIONS;

void cx_discovery_init(CX_DISCOVERY_RESULT *result);
void cx_discovery_free(CX_DISCOVERY_RESULT *result);

/*
 * Scans an explicit target or the configured roots.  TRUE means the scan ran;
 * no candidates is represented by result->count == 0.  A full result may be
 * truncated at CX_DISCOVERY_MAX_CANDIDATES; callers should surface the error
 * text while still using the candidates already collected.
 */
BOOL cx_discovery_scan(const CX_DISCOVERY_OPTIONS *options,
                       CX_DISCOVERY_RESULT *result,
                       WCHAR *error,
                       DWORD errorCap);

/* Resolves --client when it names a CXExam.exe or an installation directory. */
BOOL cx_discovery_resolve_client(const WCHAR *clientPath,
                                 BOOL hostIs32Bit,
                                 CX_DISCOVERY_RESULT *result,
                                 WCHAR *error,
                                 DWORD errorCap);

#endif
