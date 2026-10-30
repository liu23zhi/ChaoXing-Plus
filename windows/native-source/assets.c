#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "assets.h"
#include "resource.h"

#define CX_ASSET_PATH_CAP 32768

static const WCHAR *assetNames[] = {
    L"windows-bootstrap.js", L"chaoxing-plus.windows.js",
    L"trampoline.js", L"sweetalert2.min.css"
};
static const WCHAR *assetFiles[] = {
    L"windows-bootstrap.js", L"chaoxing-plus.windows.js",
    L"trampoline.js", L"vendor\\sweetalert2.min.css"
};
static const WORD assetIds[] = {
    CX_RESOURCE_BOOTSTRAP, CX_RESOURCE_BUNDLE,
    CX_RESOURCE_TRAMPOLINE, CX_RESOURCE_SWAL_STYLE
};

static void asset_error(WCHAR *error, DWORD cap, const WCHAR *message) {
    if (error && cap) lstrcpynW(error, message, (int)cap);
}

DWORD cx_asset_count(void) { return sizeof(assetIds) / sizeof(assetIds[0]); }

BOOL cx_asset_resources_embedded(void) {
#ifdef CX_MULTI_FILE_BUILD
    return FALSE;
#else
    return TRUE;
#endif
}

const WCHAR *cx_asset_name(DWORD index) {
    return index < cx_asset_count() ? assetNames[index] : NULL;
}

static BOOL asset_file(const WCHAR *directory, const WCHAR *name,
                       char **data, DWORD *length, WCHAR *error, DWORD errorCap) {
    WCHAR *path;
    HANDLE file;
    LARGE_INTEGER size;
    DWORD at = 0, i = 0, read = 0;
    char *bytes;
    BOOL ok;
    path = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_ASSET_PATH_CAP * sizeof(WCHAR));
    if (!path) { asset_error(error, errorCap, L"out of memory building asset path"); return FALSE; }
    while (directory[at] && at + 1 < CX_ASSET_PATH_CAP) { path[at] = directory[at]; ++at; }
    if (directory[at]) { HeapFree(GetProcessHeap(), 0, path); asset_error(error, errorCap, L"external asset path is too long"); return FALSE; }
    if (at && path[at - 1] != L'\\' && path[at - 1] != L'/') {
        if (at + 1 >= CX_ASSET_PATH_CAP) { HeapFree(GetProcessHeap(), 0, path); asset_error(error, errorCap, L"external asset path is too long"); return FALSE; }
        path[at++] = L'\\';
    }
    while (name[i] && at + 1 < CX_ASSET_PATH_CAP) path[at++] = name[i++];
    path[at] = 0;
    if (name[i]) { HeapFree(GetProcessHeap(), 0, path); asset_error(error, errorCap, L"external asset path is too long"); return FALSE; }
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    HeapFree(GetProcessHeap(), 0, path);
    if (file == INVALID_HANDLE_VALUE) { asset_error(error, errorCap, L"cannot open explicit external asset"); return FALSE; }
    if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > CX_ASSET_MAX_BYTES) {
        CloseHandle(file); asset_error(error, errorCap, L"external asset is empty or exceeds its size limit"); return FALSE;
    }
    bytes = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size.LowPart + 1);
    if (!bytes) { CloseHandle(file); asset_error(error, errorCap, L"out of memory reading external asset"); return FALSE; }
    ok = ReadFile(file, bytes, size.LowPart, &read, NULL);
    CloseHandle(file);
    if (!ok || read != size.LowPart) {
        HeapFree(GetProcessHeap(), 0, bytes); asset_error(error, errorCap, L"cannot read explicit external asset"); return FALSE;
    }
    bytes[read] = 0; *data = bytes; *length = read;
    return TRUE;
}

#ifndef CX_MULTI_FILE_BUILD
static BOOL asset_embedded(WORD id, char **data, DWORD *length, WCHAR *error, DWORD errorCap) {
    HMODULE module;
    HRSRC resource;
    HGLOBAL loaded;
    const void *source;
    DWORD size;
    char *bytes;
    if (data) *data = NULL;
    if (length) *length = 0;
    module = GetModuleHandleW(NULL);
    resource = FindResourceW(module, MAKEINTRESOURCEW(id), RT_RCDATA);
    if (!resource) { asset_error(error, errorCap, L"embedded native asset is missing"); return FALSE; }
    size = SizeofResource(module, resource);
    loaded = LoadResource(module, resource);
    source = loaded ? LockResource(loaded) : NULL;
    if (!source || !size || size > CX_ASSET_MAX_BYTES) { asset_error(error, errorCap, L"embedded native asset is empty or exceeds its size limit"); return FALSE; }
    bytes = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size + 1);
    if (!bytes) { asset_error(error, errorCap, L"out of memory loading embedded asset"); return FALSE; }
    CopyMemory(bytes, source, size);
    bytes[size] = 0;
    if (data) *data = bytes; else HeapFree(GetProcessHeap(), 0, bytes);
    if (length) *length = size;
    return TRUE;
}
#else
static const WCHAR *multiAssetFiles[] = {
    L"assets\\windows-bootstrap.js", L"assets\\chaoxing-plus.windows.js",
    L"assets\\trampoline.js", L"assets\\vendor\\sweetalert2.min.css", L"winmm-proxy.dll"
};
#define CX_MULTI_ASSET_COUNT (sizeof(multiAssetFiles) / sizeof(multiAssetFiles[0]))

static INIT_ONCE multiAssetOnce = INIT_ONCE_STATIC_INIT;
/* Keep the validated sidecars for this process, including after their files are removed. */
static char *multiAssetData[CX_MULTI_ASSET_COUNT];
static DWORD multiAssetLengths[CX_MULTI_ASSET_COUNT];

typedef struct ASSET_MULTI_ERROR {
    WCHAR *text;
    DWORD cap;
} ASSET_MULTI_ERROR;

static BOOL CALLBACK asset_multi_initialize(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    ASSET_MULTI_ERROR *failure = (ASSET_MULTI_ERROR *)parameter;
    WCHAR *directory;
    WCHAR reason[160], message[320];
    DWORD length, cut = 0, i;
    BOOL ok = FALSE;
    (void)once; (void)context;
    directory = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, CX_ASSET_PATH_CAP * sizeof(WCHAR));
    if (!directory) { asset_error(failure->text, failure->cap, L"out of memory resolving multi-file resource directory"); return FALSE; }
    length = GetModuleFileNameW(NULL, directory, CX_ASSET_PATH_CAP);
    if (!length || length >= CX_ASSET_PATH_CAP) {
        asset_error(failure->text, failure->cap, L"cannot resolve multi-file host executable directory");
        goto done;
    }
    for (i = 0; i < length; ++i) if (directory[i] == L'\\' || directory[i] == L'/') cut = i;
    if (!cut) { asset_error(failure->text, failure->cap, L"cannot resolve multi-file host executable directory"); goto done; }
    directory[cut] = 0;
    for (i = 0; i < CX_MULTI_ASSET_COUNT; ++i) {
        reason[0] = 0;
        if (!asset_file(directory, multiAssetFiles[i], &multiAssetData[i], &multiAssetLengths[i], reason, 160)) {
            wsprintfW(message, L"multi-file resource %s: %s", multiAssetFiles[i], reason);
            asset_error(failure->text, failure->cap, message);
            goto done;
        }
    }
    ok = TRUE;
done:
    HeapFree(GetProcessHeap(), 0, directory);
    if (!ok) {
        for (i = 0; i < CX_MULTI_ASSET_COUNT; ++i) {
            if (multiAssetData[i]) HeapFree(GetProcessHeap(), 0, multiAssetData[i]);
            multiAssetData[i] = NULL; multiAssetLengths[i] = 0;
        }
    }
    return ok;
}

static BOOL asset_multi_prepare(WCHAR *error, DWORD errorCap) {
    ASSET_MULTI_ERROR failure;
    failure.text = error; failure.cap = errorCap;
    return InitOnceExecuteOnce(&multiAssetOnce, asset_multi_initialize, &failure, NULL);
}

static BOOL asset_multi_copy(DWORD index, char **data, DWORD *length, WCHAR *error, DWORD errorCap) {
    char *bytes;
    if (!asset_multi_prepare(error, errorCap)) return FALSE;
    bytes = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)multiAssetLengths[index] + 1);
    if (!bytes) { asset_error(error, errorCap, L"out of memory loading multi-file resource"); return FALSE; }
    CopyMemory(bytes, multiAssetData[index], (SIZE_T)multiAssetLengths[index] + 1);
    *data = bytes; *length = multiAssetLengths[index];
    return TRUE;
}
#endif

BOOL cx_asset_load(const WCHAR *name, const WCHAR *overrideDir,
                   char **data, DWORD *length, WCHAR *error, DWORD errorCap) {
    DWORD index;
    if (data) *data = NULL;
    if (length) *length = 0;
    if (!name || !data || !length) { asset_error(error, errorCap, L"invalid native asset request"); return FALSE; }
    for (index = 0; index < cx_asset_count(); ++index)
        if (lstrcmpW(name, assetNames[index]) == 0) break;
    if (index == cx_asset_count()) { asset_error(error, errorCap, L"unknown native asset name"); return FALSE; }
    if (overrideDir && overrideDir[0]) return asset_file(overrideDir, assetFiles[index], data, length, error, errorCap);
#ifdef CX_MULTI_FILE_BUILD
    return asset_multi_copy(index, data, length, error, errorCap);
#else
    return asset_embedded(assetIds[index], data, length, error, errorCap);
#endif
}

/* ---- 内嵌代理 DLL ---- */

static const WCHAR *proxyAssetNames[] = { L"winmm.dll" };
static const WORD proxyAssetIds[] = { CX_RESOURCE_PROXY_WINMM };

DWORD cx_asset_proxy_count(void) { return sizeof(proxyAssetIds) / sizeof(proxyAssetIds[0]); }

const WCHAR *cx_asset_proxy_name(DWORD index) {
    return index < cx_asset_proxy_count() ? proxyAssetNames[index] : NULL;
}

BOOL cx_asset_proxy_exists(const WCHAR *dllName) {
    DWORD index;
    if (!dllName || !*dllName) return FALSE;
    for (index = 0; index < cx_asset_proxy_count(); ++index) {
        if (lstrcmpiW(dllName, proxyAssetNames[index]) != 0) continue;
#ifdef CX_MULTI_FILE_BUILD
        return asset_multi_prepare(NULL, 0);
#else
        return FindResourceW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(proxyAssetIds[index]), RT_RCDATA) != NULL;
#endif
    }
    return FALSE;
}

BOOL cx_asset_load_proxy(const WCHAR *dllName, char **data, DWORD *length,
                         WCHAR *error, DWORD errorCap) {
    DWORD index;
    if (data) *data = NULL;
    if (length) *length = 0;
    if (!dllName || !data || !length) { asset_error(error, errorCap, L"invalid embedded proxy request"); return FALSE; }
    for (index = 0; index < cx_asset_proxy_count(); ++index) {
        if (lstrcmpiW(dllName, proxyAssetNames[index]) != 0) continue;
#ifdef CX_MULTI_FILE_BUILD
        return asset_multi_copy(cx_asset_count() + index, data, length, error, errorCap);
#else
        return asset_embedded(proxyAssetIds[index], data, length, error, errorCap);
#endif
    }
    asset_error(error, errorCap, L"no embedded proxy for that carrier");
    return FALSE;
}


BOOL cx_asset_validate_embedded(WCHAR *error, DWORD errorCap) {
#ifdef CX_MULTI_FILE_BUILD
    return asset_multi_prepare(error, errorCap);
#else
    DWORD index, length;
    char *data;
    for (index = 0; index < cx_asset_count(); ++index) {
        if (!cx_asset_load(assetNames[index], NULL, &data, &length, error, errorCap)) return FALSE;
        HeapFree(GetProcessHeap(), 0, data);
    }
    return TRUE;
#endif
}
