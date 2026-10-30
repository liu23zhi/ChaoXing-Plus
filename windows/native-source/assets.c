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
    return asset_embedded(assetIds[index], data, length, error, errorCap);
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
        return FindResourceW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(proxyAssetIds[index]), RT_RCDATA) != NULL;
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
        return asset_embedded(proxyAssetIds[index], data, length, error, errorCap);
    }
    asset_error(error, errorCap, L"no embedded proxy for that carrier");
    return FALSE;
}


BOOL cx_asset_validate_embedded(WCHAR *error, DWORD errorCap) {
    DWORD index, length;
    char *data;
    for (index = 0; index < cx_asset_count(); ++index) {
        if (!cx_asset_load(assetNames[index], NULL, &data, &length, error, errorCap)) return FALSE;
        HeapFree(GetProcessHeap(), 0, data);
    }
    return TRUE;
}
