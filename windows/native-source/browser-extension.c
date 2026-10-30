#include "browser-extension.h"
#include <wincrypt.h>
#include <bcrypt.h>
#include "json.h"

#define CX_BE_MAX_PACKAGE (64UL * 1024UL * 1024UL)
#define CX_BE_MAX_ENTRY (16UL * 1024UL * 1024UL)
#define CX_BE_MAX_ENTRIES 512
#define CX_BE_MAX_NAME 1024

typedef struct {
    const BYTE *data;
    DWORD size;
    DWORD bit;
} BE_BITS;

typedef struct {
    WORD code[320];
    BYTE length[320];
    WORD count;
} BE_TREE;

typedef struct {
    DWORD offset;
    DWORD compressed;
    DWORD expanded;
    DWORD crc;
    WORD method;
    WORD flags;
    WORD nameLength;
    const BYTE *name;
    DWORD externalAttributes;
} BE_ENTRY;

static BOOL be_equal(const void *left, const void *right, DWORD size) {
    const BYTE *a = (const BYTE *)left, *b = (const BYTE *)right; DWORD i;
    for (i = 0; i < size; ++i) if (a[i] != b[i]) return FALSE;
    return TRUE;
}

typedef NTSTATUS (WINAPI *BE_HASH_OPEN)(BCRYPT_ALG_HANDLE *, LPCWSTR, LPCWSTR, ULONG);
typedef NTSTATUS (WINAPI *BE_HASH_CLOSE)(BCRYPT_ALG_HANDLE, ULONG);
typedef NTSTATUS (WINAPI *BE_HASH_PROPERTY)(BCRYPT_HANDLE, LPCWSTR, PUCHAR, ULONG, ULONG *, ULONG);
typedef NTSTATUS (WINAPI *BE_HASH_CREATE)(BCRYPT_ALG_HANDLE, BCRYPT_HASH_HANDLE *, PUCHAR, ULONG, PUCHAR, ULONG, ULONG);
typedef NTSTATUS (WINAPI *BE_HASH_DATA)(BCRYPT_HASH_HANDLE, PUCHAR, ULONG, ULONG);
typedef NTSTATUS (WINAPI *BE_HASH_FINISH)(BCRYPT_HASH_HANDLE, PUCHAR, ULONG, ULONG);
typedef NTSTATUS (WINAPI *BE_HASH_DESTROY)(BCRYPT_HASH_HANDLE);
typedef NTSTATUS (WINAPI *BE_KEY_DESTROY)(BCRYPT_KEY_HANDLE);
typedef NTSTATUS (WINAPI *BE_VERIFY)(BCRYPT_KEY_HANDLE, VOID *, PUCHAR, ULONG, PUCHAR, ULONG, ULONG);
typedef BOOL (WINAPI *BE_DECODE)(DWORD, LPCSTR, const BYTE *, DWORD, DWORD, PCRYPT_DECODE_PARA, VOID *, DWORD *);
typedef BOOL (WINAPI *BE_IMPORT)(DWORD, PCERT_PUBLIC_KEY_INFO, DWORD, VOID *, BCRYPT_KEY_HANDLE *);
typedef BOOL (WINAPI *BE_BASE64)(const BYTE *, DWORD, DWORD, LPSTR, DWORD *);

typedef struct {
    HMODULE bcrypt, crypt32;
    BE_HASH_OPEN open; BE_HASH_CLOSE close; BE_HASH_PROPERTY property;
    BE_HASH_CREATE create; BE_HASH_DATA data; BE_HASH_FINISH finish; BE_HASH_DESTROY destroy;
    BE_KEY_DESTROY destroyKey; BE_VERIFY verify; BE_DECODE decode; BE_IMPORT importKey; BE_BASE64 base64;
} BE_CRYPTO;

static HMODULE be_system_library(const WCHAR *name) {
    WCHAR path[MAX_PATH]; UINT length = GetSystemDirectoryW(path, MAX_PATH);
    if (!length || length >= MAX_PATH || length + 1 + (UINT)lstrlenW(name) >= MAX_PATH) return NULL;
    path[length++] = '\\'; path[length] = 0; lstrcatW(path, name); return LoadLibraryW(path);
}

static BOOL be_crypto_load(BE_CRYPTO *api) {
    ZeroMemory(api, sizeof(*api));
    api->bcrypt = be_system_library(L"bcrypt.dll"); api->crypt32 = be_system_library(L"crypt32.dll");
    if (!api->bcrypt || !api->crypt32) return FALSE;
#define BE_PROC(field, type, module, name) api->field = (type)GetProcAddress(api->module, name)
    BE_PROC(open, BE_HASH_OPEN, bcrypt, "BCryptOpenAlgorithmProvider");
    BE_PROC(close, BE_HASH_CLOSE, bcrypt, "BCryptCloseAlgorithmProvider");
    BE_PROC(property, BE_HASH_PROPERTY, bcrypt, "BCryptGetProperty");
    BE_PROC(create, BE_HASH_CREATE, bcrypt, "BCryptCreateHash");
    BE_PROC(data, BE_HASH_DATA, bcrypt, "BCryptHashData");
    BE_PROC(finish, BE_HASH_FINISH, bcrypt, "BCryptFinishHash");
    BE_PROC(destroy, BE_HASH_DESTROY, bcrypt, "BCryptDestroyHash");
    BE_PROC(destroyKey, BE_KEY_DESTROY, bcrypt, "BCryptDestroyKey");
    BE_PROC(verify, BE_VERIFY, bcrypt, "BCryptVerifySignature");
    BE_PROC(decode, BE_DECODE, crypt32, "CryptDecodeObjectEx");
    BE_PROC(importKey, BE_IMPORT, crypt32, "CryptImportPublicKeyInfoEx2");
    BE_PROC(base64, BE_BASE64, crypt32, "CryptBinaryToStringA");
#undef BE_PROC
    return api->open && api->close && api->property && api->create && api->data && api->finish && api->destroy && api->destroyKey && api->verify && api->decode && api->importKey && api->base64;
}

static void be_crypto_free(BE_CRYPTO *api) {
    if (api->bcrypt) FreeLibrary(api->bcrypt); if (api->crypt32) FreeLibrary(api->crypt32);
}

static BOOL be_hash(BE_CRYPTO *api, const BYTE **parts, const DWORD *lengths, DWORD count, BYTE digest[32]) {
    BCRYPT_ALG_HANDLE algorithm = NULL; BCRYPT_HASH_HANDLE hash = NULL;
    BYTE *object = NULL; DWORD objectSize = 0, got = 0, i; BOOL ok = FALSE;
    if (api->open(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0 || api->property(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&objectSize, sizeof(objectSize), &got, 0) < 0 || !objectSize || objectSize > 65536) goto done;
    object = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, objectSize);
    if (!object || api->create(algorithm, &hash, object, objectSize, NULL, 0, 0) < 0) goto done;
    for (i = 0; i < count; ++i) if (api->data(hash, (PUCHAR)parts[i], lengths[i], 0) < 0) goto done;
    ok = api->finish(hash, digest, 32, 0) >= 0;
done:
    if (hash) api->destroy(hash); if (algorithm) api->close(algorithm, 0); if (object) HeapFree(GetProcessHeap(), 0, object); return ok;
}

static BOOL be_varint(const BYTE *data, DWORD size, DWORD *offset, DWORD *value) {
    DWORD shift = 0, result = 0; BYTE byte;
    do { if (*offset >= size || shift > 28) return FALSE; byte = data[(*offset)++]; if (shift == 28 && (byte & 0xF0)) return FALSE; result |= (DWORD)(byte & 127) << shift; shift += 7; } while (byte & 128);
    *value = result; return TRUE;
}

static BOOL be_field(const BYTE *data, DWORD size, DWORD *offset, DWORD *field, const BYTE **value, DWORD *length) {
    DWORD tag, scalar;
    if (!be_varint(data, size, offset, &tag)) return FALSE;
    *field = tag >> 3;
    if ((tag & 7) == 0) { if (!be_varint(data, size, offset, &scalar)) return FALSE; *value = NULL; *length = 0; return TRUE; }
    if ((tag & 7) != 2 || !be_varint(data, size, offset, length) || *length > size - *offset) return FALSE;
    *value = data + *offset; *offset += *length; return TRUE;
}

static BOOL be_signature(const BYTE *data, DWORD size, DWORD headerSize, const BYTE **publicKey, DWORD *publicLength, WCHAR *extensionId, DWORD idCap) {
    BE_CRYPTO api; DWORD at = 0, field, length, signedSize = 0, signedAt, idSize = 0, i;
    const BYTE *value, *signedData = NULL, *signedId = NULL; BOOL valid = FALSE;
    *publicKey = NULL; *publicLength = 0;
    while (at < headerSize) {
        if (!be_field(data + 12, headerSize, &at, &field, &value, &length)) return FALSE;
        if (field == 10000) { signedData = value; signedSize = length; }
    }
    if (!signedData || !signedSize) return FALSE;
    signedAt = 0;
    while (signedAt < signedSize) { if (!be_field(signedData, signedSize, &signedAt, &field, &value, &length)) return FALSE; if (field == 1) { signedId = value; idSize = length; } }
    if (!signedId || idSize != 16) return FALSE;
    if (!be_crypto_load(&api)) { be_crypto_free(&api); return FALSE; }
    at = 0;
    while (at < headerSize) {
        const BYTE *proof, *key = NULL, *signature = NULL; DWORD proofLength, proofAt = 0, keySize = 0, signatureSize = 0;
        BYTE digest[32], keyDigest[32], lengthBytes[4]; const BYTE *parts[4]; DWORD lengths[4];
        PCERT_PUBLIC_KEY_INFO info = NULL; DWORD infoSize = 0; BCRYPT_KEY_HANDLE imported = NULL;
        BCRYPT_PKCS1_PADDING_INFO padding = {BCRYPT_SHA256_ALGORITHM};
        if (!be_field(data + 12, headerSize, &at, &field, &value, &length)) break;
        if (field != 2 || !value) continue;
        proof = value; proofLength = length;
        while (proofAt < proofLength) { if (!be_field(proof, proofLength, &proofAt, &field, &value, &length)) break; if (field == 1) { key = value; keySize = length; } if (field == 2) { signature = value; signatureSize = length; } }
        if (!key || !signature || !keySize || !signatureSize) continue;
        parts[0] = key; lengths[0] = keySize;
        if (!be_hash(&api, parts, lengths, 1, keyDigest) || !be_equal(keyDigest, signedId, 16)) continue;
        parts[0] = (const BYTE *)"CRX3 SignedData\0"; lengths[0] = 16;
        for (i = 0; i < 4; ++i) lengthBytes[i] = (BYTE)(signedSize >> (i * 8));
        parts[1] = lengthBytes; lengths[1] = 4; parts[2] = signedData; lengths[2] = signedSize; parts[3] = data + 12 + headerSize; lengths[3] = size - 12 - headerSize;
        if (!be_hash(&api, parts, lengths, 4, digest)) continue;
        if (!api.decode(X509_ASN_ENCODING, X509_PUBLIC_KEY_INFO, key, keySize, CRYPT_DECODE_ALLOC_FLAG, NULL, &info, &infoSize)) continue;
        if (api.importKey(X509_ASN_ENCODING, info, 0, NULL, &imported) && api.verify(imported, &padding, digest, 32, (PUCHAR)signature, signatureSize, BCRYPT_PAD_PKCS1) >= 0) {
            valid = TRUE; *publicKey = key; *publicLength = keySize;
            if (extensionId && idCap >= 33) { for (i = 0; i < 16; ++i) { extensionId[i * 2] = (WCHAR)(L'a' + (signedId[i] >> 4)); extensionId[i * 2 + 1] = (WCHAR)(L'a' + (signedId[i] & 15)); } extensionId[32] = 0; }
        }
        if (imported) api.destroyKey(imported); if (info) LocalFree(info); if (valid) break;
    }
    be_crypto_free(&api); return valid;
}

static void be_error(WCHAR *error, DWORD cap, const WCHAR *message) {
    if (error && cap) lstrcpynW(error, message, (int)cap);
}

static DWORD be_u16(const BYTE *p) { return (DWORD)p[0] | ((DWORD)p[1] << 8); }
static DWORD be_u32(const BYTE *p) {
    return (DWORD)p[0] | ((DWORD)p[1] << 8) | ((DWORD)p[2] << 16) | ((DWORD)p[3] << 24);
}

static BOOL be_take_bits(BE_BITS *bits, DWORD count, DWORD *value) {
    DWORD result = 0, i, at;
    if (!bits || !value || count > 24) return FALSE;
    for (i = 0; i < count; ++i) {
        at = bits->bit++;
        if (at >= bits->size * 8UL) return FALSE;
        if (bits->data[at >> 3] & (BYTE)(1u << (at & 7))) result |= 1UL << i;
    }
    *value = result;
    return TRUE;
}

static DWORD be_reverse(DWORD value, DWORD count) {
    DWORD result = 0, i;
    for (i = 0; i < count; ++i) {
        result = (result << 1) | (value & 1);
        value >>= 1;
    }
    return result;
}

static BOOL be_tree(BE_TREE *tree, const BYTE *lengths, WORD count) {
    WORD blCount[16], nextCode[16];
    WORD i, code = 0;
    DWORD bits; int available = 1;
    if (!tree || !lengths || count > 320) return FALSE;
    ZeroMemory(tree, sizeof(*tree));
    ZeroMemory(blCount, sizeof(blCount));
    ZeroMemory(nextCode, sizeof(nextCode));
    for (i = 0; i < count; ++i) {
        if (lengths[i] > 15) return FALSE;
        if (lengths[i]) ++blCount[lengths[i]];
    }
    for (bits = 1; bits <= 15; ++bits) {
        available = available * 2 - blCount[bits]; if (available < 0) return FALSE;
        code = (WORD)((code + blCount[bits - 1]) << 1);
        nextCode[bits] = code;
    }
    for (i = 0; i < count; ++i) {
        if (lengths[i]) {
            tree->code[i] = (WORD)be_reverse(nextCode[lengths[i]]++, lengths[i]);
            tree->length[i] = lengths[i];
            ++tree->count;
        }
    }
    return tree->count != 0;
}

static BOOL be_symbol(BE_BITS *bits, const BE_TREE *tree, WORD *symbol) {
    DWORD code = 0, bit, length;
    WORD i;
    if (!bits || !tree || !symbol) return FALSE;
    for (length = 1; length <= 15; ++length) {
        if (!be_take_bits(bits, 1, &bit)) return FALSE;
        code |= bit << (length - 1);
        for (i = 0; i < 320; ++i) {
            if (tree->length[i] == length && tree->code[i] == code) {
                *symbol = i;
                return TRUE;
            }
        }
    }
    return FALSE;
}

static BOOL be_fixed(BE_TREE *literal, BE_TREE *distance) {
    BYTE lengths[288], distances[32];
    WORD i;
    for (i = 0; i < 288; ++i) lengths[i] = (BYTE)(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
    for (i = 0; i < 32; ++i) distances[i] = 5;
    return be_tree(literal, lengths, 288) && be_tree(distance, distances, 32);
}

static BOOL be_dynamic(BE_BITS *bits, BE_TREE *literal, BE_TREE *distance) {
    static const BYTE order[19] = {16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15};
    BYTE codeLengths[19], lengths[288 + 32];
    BE_TREE codeTree;
    DWORD hlit, hdist, hclen, value;
    WORD i, symbol, total = 0;
    ZeroMemory(codeLengths, sizeof(codeLengths));
    if (!be_take_bits(bits, 5, &hlit) || !be_take_bits(bits, 5, &hdist) || !be_take_bits(bits, 4, &hclen)) return FALSE;
    hlit += 257; hdist += 1; hclen += 4;
    if (hlit > 288 || hdist > 32) return FALSE;
    for (i = 0; i < hclen; ++i) {
        if (!be_take_bits(bits, 3, &value)) return FALSE;
        codeLengths[order[i]] = (BYTE)value;
    }
    if (!be_tree(&codeTree, codeLengths, 19)) return FALSE;
    while (total < hlit + hdist) {
        if (!be_symbol(bits, &codeTree, &symbol)) return FALSE;
        if (symbol <= 15) {
            lengths[total++] = (BYTE)symbol;
        } else if (symbol == 16) {
            DWORD repeat, previous;
            if (!total || !be_take_bits(bits, 2, &repeat)) return FALSE;
            repeat += 3; previous = lengths[total - 1];
            if (total + repeat > hlit + hdist) return FALSE;
            while (repeat--) lengths[total++] = (BYTE)previous;
        } else if (symbol == 17) {
            DWORD repeat;
            if (!be_take_bits(bits, 3, &repeat)) return FALSE;
            repeat += 3;
            if (total + repeat > hlit + hdist) return FALSE;
            while (repeat--) lengths[total++] = 0;
        } else if (symbol == 18) {
            DWORD repeat;
            if (!be_take_bits(bits, 7, &repeat)) return FALSE;
            repeat += 11;
            if (total + repeat > hlit + hdist) return FALSE;
            while (repeat--) lengths[total++] = 0;
        } else return FALSE;
    }
    return lengths[256] && be_tree(literal, lengths, (WORD)hlit) && be_tree(distance, lengths + hlit, (WORD)hdist);
}

static DWORD be_crc32(const BYTE *data, DWORD size) {
    DWORD crc = 0xFFFFFFFFUL, i, bit;
    for (i = 0; i < size; ++i) {
        crc ^= data[i];
        for (bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xEDB88320UL & (DWORD)-(LONG)(crc & 1));
    }
    return ~crc;
}

static BOOL be_inflate(const BYTE *data, DWORD size, BYTE *out, DWORD expected) {
    static const WORD lengthBase[29] = {3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258};
    static const BYTE lengthExtra[29] = {0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0};
    static const WORD distanceBase[30] = {1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577};
    static const BYTE distanceExtra[30] = {0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13};
    BE_BITS bits = {data, size, 0};
    BE_TREE literal, distance;
    DWORD last, type, value, extra, length, distanceValue, i;
    DWORD output = 0;
    WORD symbol;
    for (;;) {
        if (!be_take_bits(&bits, 1, &last) || !be_take_bits(&bits, 2, &type)) return FALSE;
        if (type == 0) {
            WORD length16, inverted;
            bits.bit = (bits.bit + 7) & ~7UL;
            if (!be_take_bits(&bits, 16, &value)) return FALSE; length16 = (WORD)value;
            if (!be_take_bits(&bits, 16, &value)) return FALSE; inverted = (WORD)value;
            if ((WORD)~length16 != inverted || output + length16 > expected) return FALSE;
            for (i = 0; i < length16; ++i) { if (!be_take_bits(&bits, 8, &value)) return FALSE; out[output++] = (BYTE)value; }
        } else {
            if (type == 1) { if (!be_fixed(&literal, &distance)) return FALSE; }
            else if (type == 2) { if (!be_dynamic(&bits, &literal, &distance)) return FALSE; }
            else return FALSE;
            for (;;) {
                if (!be_symbol(&bits, &literal, &symbol)) return FALSE;
                if (symbol < 256) { if (output >= expected) return FALSE; out[output++] = (BYTE)symbol; continue; }
                if (symbol == 256) break;
                if (symbol < 257 || symbol > 285) return FALSE;
                symbol -= 257; length = lengthBase[symbol]; extra = 0;
                if (lengthExtra[symbol] && !be_take_bits(&bits, lengthExtra[symbol], &extra)) return FALSE;
                length += extra;
                if (!be_symbol(&bits, &distance, &symbol) || symbol >= 30) return FALSE;
                distanceValue = distanceBase[symbol]; extra = 0;
                if (distanceExtra[symbol] && !be_take_bits(&bits, distanceExtra[symbol], &extra)) return FALSE;
                distanceValue += extra;
                if (!distanceValue || distanceValue > output || output + length > expected) return FALSE;
                for (i = 0; i < length; ++i) out[output + i] = out[output - distanceValue + (i % distanceValue)];
                output += length;
            }
        }
        if (last) return output == expected;
    }
}

static BOOL be_name(const BYTE *name, WORD length, WCHAR *out, DWORD cap) {
    int chars; WORD i;
    if (!name || !out || cap < 2 || length > CX_BE_MAX_NAME) return FALSE;
    for (i = 0; i < length; ++i) if (!name[i]) return FALSE;
    chars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (LPCCH)name, length, out, (int)cap - 1);
    if (chars <= 0 || (DWORD)chars >= cap) return FALSE;
    out[chars] = 0;
    return TRUE;
}

static BOOL be_safe_path(const WCHAR *name) {
    const WCHAR *p = name;
    if (!name || !name[0] || name[0] == L'\\' || name[0] == L'/' || (name[1] == L':' && name[2] == L'\\')) return FALSE;
    while (*p) {
        const WCHAR *begin = p;
        while (*p && *p != L'\\' && *p != L'/') { if (*p < 32 || *p == L':' || *p == L'"' || *p == L'<' || *p == L'>' || *p == L'|' || *p == L'*' || *p == L'?') return FALSE; ++p; }
        if (p == begin || (p - begin == 1 && begin[0] == L'.') || (p - begin == 2 && begin[0] == L'.' && begin[1] == L'.') || p[-1] == L'.' || p[-1] == L' ') return FALSE;
        { WCHAR component[16]; DWORD k = 0; const WCHAR *s = begin; while (s < p && *s != L'.' && k < 15) { component[k++] = *s++; } component[k] = 0;
          if (lstrcmpiW(component, L"CON") == 0 || lstrcmpiW(component, L"PRN") == 0 || lstrcmpiW(component, L"AUX") == 0 || lstrcmpiW(component, L"NUL") == 0 || ((k == 4) && (CompareStringOrdinal(component, 3, L"COM", 3, TRUE) == CSTR_EQUAL || CompareStringOrdinal(component, 3, L"LPT", 3, TRUE) == CSTR_EQUAL) && component[3] >= L'1' && component[3] <= L'9')) return FALSE; }
        if (*p) { if (!p[1]) return FALSE; ++p; }
    }
    return TRUE;
}

static BOOL be_unique_keys(const char *text, const JT *tokens, int count) {
    int object, left, right, p; WCHAR first[256], second[256];
    for (object = 0; object < count; ++object) if (tokens[object].type == 's') {
        for (p = tokens[object].start; p < tokens[object].end; ++p) if (text[p] == '\\') {
            ++p; if (text[p] == 'u') { if (text[p + 1] == '0' && text[p + 2] == '0' && text[p + 3] == '0' && text[p + 4] == '0') return FALSE; p += 4; }
        }
    }
    for (object = 0; object < count; ++object) if (tokens[object].type == '{') {
        for (left = object + 1; left < tokens[object].next; left = tokens[left + 1].next) {
            if (!jwstr(text, tokens, left, first, 256)) return FALSE;
            for (right = tokens[left + 1].next; right < tokens[object].next; right = tokens[right + 1].next) {
                if (!jwstr(text, tokens, right, second, 256) || lstrcmpW(first, second) == 0) return FALSE;
            }
        }
    }
    return TRUE;
}

static BOOL be_version(const char *version) {
    DWORD parts = 0, number; const char *start; BOOL nonzero = FALSE;
    do {
        if (++parts > 4) return FALSE; start = version; number = 0;
        while (*version >= '0' && *version <= '9') { number = number * 10 + (DWORD)(*version++ - '0'); if (number > 65535) return FALSE; }
        if (start == version || (version - start > 1 && *start == '0')) return FALSE;
        if (number) nonzero = TRUE; if (!*version) return nonzero; if (*version++ != '.' || !*version) return FALSE;
    } while (*version);
    return FALSE;
}

static BOOL be_manifest(const BYTE *bytes, DWORD size, const BYTE *publicKey, DWORD publicLength, BYTE **output, DWORD *outputSize) {
    char *text = NULL, *base64 = NULL, *result = NULL; DWORD base64Size = 0, i, used; JT *tokens = NULL; int count;
    char name[1024], version[128];
    BE_CRYPTO api; BOOL loaded = FALSE, ok = FALSE;
    ZeroMemory(&api, sizeof(api));
    if (!bytes || size < 2 || size > 262144) return FALSE;
    text = (char *)HeapAlloc(GetProcessHeap(), 0, size + 1); tokens = (JT *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 8192 * sizeof(JT));
    if (!text || !tokens || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (LPCCH)bytes, size, NULL, 0)) goto done; CopyMemory(text, bytes, size); text[size] = 0;
    count = jparse(text, (int)size, tokens, 8192);
    if (count <= 0 || tokens[0].type != '{' || !be_unique_keys(text, tokens, count) || jint(text, tokens, jkey(text, tokens, 0, "manifest_version"), 0) != 3 ||
        !jstr(text, tokens, jkey(text, tokens, 0, "name"), name, sizeof(name)) || !name[0] ||
        !jstr(text, tokens, jkey(text, tokens, 0, "version"), version, sizeof(version)) || !be_version(version)) goto done;
    loaded = be_crypto_load(&api); if (!loaded || !api.base64(publicKey, publicLength, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, NULL, &base64Size) || !base64Size || base64Size > 16384) goto done;
    base64 = (char *)HeapAlloc(GetProcessHeap(), 0, base64Size); if (!base64 || !api.base64(publicKey, publicLength, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, base64, &base64Size)) goto done;
    i = (DWORD)jkey(text, tokens, 0, "key");
    if ((int)i >= 0) {
        DWORD length = (DWORD)(tokens[i].end - tokens[i].start);
        if (length != (DWORD)lstrlenA(base64) || !be_equal(text + tokens[i].start, base64, length)) goto done;
        if (output) { *output = (BYTE *)text; *outputSize = size; text = NULL; } ok = TRUE; goto done;
    }
    used = (DWORD)tokens[0].end - 1;
    result = (char *)HeapAlloc(GetProcessHeap(), 0, used + base64Size + 16); if (!result) goto done;
    CopyMemory(result, text, used); result[used++] = ',';
    { const char *key = "\"key\":\""; while (*key) result[used++] = *key++; }
    for (i = 0; base64[i]; ++i) result[used++] = base64[i]; result[used++] = '"'; result[used++] = '}';
    if (output) { *output = (BYTE *)result; *outputSize = used; result = NULL; }
    ok = TRUE;
done:
    if (text) HeapFree(GetProcessHeap(), 0, text); if (tokens) HeapFree(GetProcessHeap(), 0, tokens); if (base64) HeapFree(GetProcessHeap(), 0, base64); if (result) HeapFree(GetProcessHeap(), 0, result); be_crypto_free(&api); return ok;
}

static BOOL be_mkdirs(const WCHAR *path) {
    WCHAR *copy; DWORD i, n; BOOL result = TRUE;
    if (!path || !path[0]) return FALSE;
    n = (DWORD)lstrlenW(path); if (n >= 32768) return FALSE;
    copy = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, 32768 * sizeof(WCHAR)); if (!copy) return FALSE;
    lstrcpyW(copy, path);
    for (i = 3; i < n; ++i) if (copy[i] == L'\\' || copy[i] == L'/') {
        DWORD attributes;
        copy[i] = 0; if (copy[0] && !CreateDirectoryW(copy, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) { result = FALSE; break; }
        attributes = GetFileAttributesW(copy); if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) { result = FALSE; break; } copy[i] = L'\\';
    }
    if (result) { DWORD attributes; if (!CreateDirectoryW(copy, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) result = FALSE; attributes = GetFileAttributesW(copy); if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) result = FALSE; }
    HeapFree(GetProcessHeap(), 0, copy); return result;
}

static BOOL be_zip_entries(const BYTE *zip, DWORD size, BE_ENTRY *entries, DWORD *count) {
    DWORD p, eocd = 0, entriesCount, cdSize, cdOffset, i, total = 0;
    if (!zip || !entries || !count || size < 22) return FALSE;
    for (p = size - 22; p + 22 >= p && p >= (size > 65557 ? size - 65557 : 0); --p) {
        if (be_u32(zip + p) == 0x06054B50UL && be_u16(zip + p + 20) == 0) { eocd = p; break; }
        if (!p) break;
    }
    if (!eocd || eocd + 22 != size || be_u16(zip + eocd + 4) || be_u16(zip + eocd + 6) || be_u16(zip + eocd + 8) != be_u16(zip + eocd + 10)) return FALSE;
    entriesCount = be_u16(zip + eocd + 10); cdSize = be_u32(zip + eocd + 12); cdOffset = be_u32(zip + eocd + 16);
    if (!entriesCount || entriesCount > CX_BE_MAX_ENTRIES || cdOffset > eocd || cdSize > eocd - cdOffset || cdOffset + cdSize != eocd) return FALSE;
    p = cdOffset;
    for (i = 0; i < entriesCount; ++i) {
        WORD nameLength, extraLength, commentLength;
        if (p > size || size - p < 46 || be_u32(zip + p) != 0x02014B50UL) return FALSE;
        nameLength = (WORD)be_u16(zip + p + 28); extraLength = (WORD)be_u16(zip + p + 30); commentLength = (WORD)be_u16(zip + p + 32);
        if (nameLength > CX_BE_MAX_NAME || 46UL + nameLength + extraLength + commentLength > size - p) return FALSE;
        entries[i].flags = (WORD)be_u16(zip + p + 8); entries[i].method = (WORD)be_u16(zip + p + 10);
        entries[i].crc = be_u32(zip + p + 16); entries[i].compressed = be_u32(zip + p + 20); entries[i].expanded = be_u32(zip + p + 24);
        entries[i].nameLength = nameLength; entries[i].name = zip + p + 46; entries[i].offset = be_u32(zip + p + 42);
        entries[i].externalAttributes = be_u32(zip + p + 38);
        if (!nameLength || entries[i].expanded > CX_BE_MAX_ENTRY || entries[i].compressed > size || entries[i].offset >= cdOffset || total > CX_BE_MAX_PACKAGE - entries[i].expanded || (entries[i].flags & ~0x080E) || (entries[i].method != 0 && entries[i].method != 8) || ((entries[i].externalAttributes >> 16) & 0xF000) == 0xA000 || be_u16(zip + p + 34)) return FALSE;
        total += entries[i].expanded;
        p += 46UL + nameLength + extraLength + commentLength;
    }
    *count = entriesCount; return p == cdOffset + cdSize;
}

static BOOL be_entry_data(const BYTE *zip, DWORD zipSize, const BE_ENTRY *entry, BYTE **out, WCHAR *error, DWORD errorCap) {
    DWORD local, start; BYTE *expanded = NULL;
    *out = NULL;
    local = entry->offset; if (local > zipSize || zipSize - local < 30 || be_u32(zip + local) != 0x04034B50UL) goto fail;
    if (be_u16(zip + local + 8) != entry->method || be_u16(zip + local + 6) != entry->flags || be_u16(zip + local + 26) != entry->nameLength || entry->nameLength > zipSize - local - 30 || !be_equal(zip + local + 30, entry->name, entry->nameLength)) goto fail;
    start = local + 30UL + be_u16(zip + local + 26) + be_u16(zip + local + 28);
    if (start > zipSize || entry->compressed > zipSize - start) goto fail;
    expanded = (BYTE *)HeapAlloc(GetProcessHeap(), 0, entry->expanded ? entry->expanded : 1); if (!expanded) goto fail;
    if (entry->method == 0) { if (entry->compressed != entry->expanded) goto fail; CopyMemory(expanded, zip + start, entry->expanded); }
    else if (entry->method == 8) { if (!be_inflate(zip + start, entry->compressed, expanded, entry->expanded)) { be_error(error, errorCap, L"扩展包 DEFLATE 数据无效。"); goto fail; } }
    else goto fail;
    if (be_crc32(expanded, entry->expanded) != entry->crc) { be_error(error, errorCap, L"扩展包 CRC 校验失败。"); goto fail; }
    *out = expanded; return TRUE;
fail:
    if (expanded) HeapFree(GetProcessHeap(), 0, expanded); if (!error || !errorCap || !error[0]) be_error(error, errorCap, L"扩展包压缩内容校验失败。"); return FALSE;
}

static BOOL be_write_entry(const WCHAR *name, const BYTE *expanded, DWORD size, const WCHAR *directory, WCHAR *error, DWORD errorCap) {
    WCHAR *path = NULL, *parent = NULL; DWORD i, n, parentLength; HANDLE file = INVALID_HANDLE_VALUE; DWORD written;
    n = (DWORD)lstrlenW(directory); if (n + 1 + (DWORD)lstrlenW(name) + 1 >= 32768) return FALSE;
    path = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, 32768 * sizeof(WCHAR)); parent = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, 32768 * sizeof(WCHAR)); if (!path || !parent) goto fail;
    lstrcpyW(path, directory); if (n && path[n - 1] != L'\\') lstrcatW(path, L"\\"); lstrcatW(path, name);
    lstrcpyW(parent, path); parentLength = (DWORD)lstrlenW(parent);
    for (i = parentLength; i && parent[i - 1] != L'\\'; --i) { }
    if (i > 1) { parent[i - 1] = 0; if (!be_mkdirs(parent)) { be_error(error, errorCap, L"无法创建扩展文件目录。"); goto fail; } }
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE || (size && (!WriteFile(file, expanded, size, &written, NULL) || written != size))) goto fail;
    CloseHandle(file); HeapFree(GetProcessHeap(), 0, path); HeapFree(GetProcessHeap(), 0, parent); return TRUE;
fail:
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file); if (path) HeapFree(GetProcessHeap(), 0, path); if (parent) HeapFree(GetProcessHeap(), 0, parent); if (!error || !errorCap || !error[0]) be_error(error, errorCap, L"无法写入扩展临时文件。"); return FALSE;
}

static BOOL be_process(const BYTE *data, DWORD size, const WCHAR *directory, const WCHAR *expectedId, WCHAR *extensionId, DWORD idCapacity, WCHAR *error, DWORD errorCapacity) {
    DWORD headerSize, zipOffset, count, i, k, publicLength = 0; BE_ENTRY *entries = NULL; const BYTE *zip, *publicKey = NULL; BOOL manifest = FALSE, result = FALSE;
    WCHAR verifiedId[33]; WCHAR *names = NULL; BYTE *expanded = NULL, *rewritten = NULL;
    if (error && errorCapacity) error[0] = 0; if (extensionId && idCapacity) extensionId[0] = 0;
    if (!data || size < 16 || size > CX_BE_MAX_PACKAGE) { be_error(error, errorCapacity, L"扩展包参数无效。"); return FALSE; }
    if (be_u32(data) != 0x34327243UL || be_u32(data + 4) != 3) { be_error(error, errorCapacity, L"只支持 CRX3 扩展包。"); return FALSE; }
    headerSize = be_u32(data + 8); if (headerSize > size - 12 || headerSize > 1024 * 1024UL) { be_error(error, errorCapacity, L"扩展包 CRX3 头部无效。"); return FALSE; } zipOffset = 12 + headerSize; zip = data + zipOffset;
    if (!be_signature(data, size, headerSize, &publicKey, &publicLength, verifiedId, 33)) { be_error(error, errorCapacity, L"扩展包开发者签名或扩展标识校验失败。"); return FALSE; }
    if (expectedId && (!expectedId[0] || lstrcmpW(expectedId, verifiedId) != 0)) { be_error(error, errorCapacity, L"扩展包身份与所选商店扩展不一致。"); return FALSE; }
    entries = (BE_ENTRY *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, CX_BE_MAX_ENTRIES * sizeof(BE_ENTRY)); if (!entries) return FALSE;
    if (!be_zip_entries(zip, size - zipOffset, entries, &count)) { be_error(error, errorCapacity, L"扩展包 ZIP 目录无效。"); goto done; }
    names = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, count * CX_BE_MAX_NAME * sizeof(WCHAR)); if (!names) goto done;
    for (i = 0; i < count; ++i) {
        WCHAR *name = names + i * CX_BE_MAX_NAME; DWORD length;
        if (!be_name(entries[i].name, entries[i].nameLength, name, CX_BE_MAX_NAME)) goto done;
        length = (DWORD)lstrlenW(name);
        if (length && (name[length - 1] == '/' || name[length - 1] == '\\')) { if (entries[i].expanded) goto done; name[length - 1] = 0; }
        if (!be_safe_path(name)) { be_error(error, errorCapacity, L"扩展包包含不安全路径。"); goto done; }
        for (k = 0; name[k]; ++k) if (name[k] == '/') name[k] = '\\';
        for (k = 0; k < i; ++k) {
            const WCHAR *previous = names + k * CX_BE_MAX_NAME; DWORD previousLength = (DWORD)lstrlenW(previous), nameLength = (DWORD)lstrlenW(name);
            BOOL previousDirectory = entries[k].name[entries[k].nameLength - 1] == '/' || entries[k].name[entries[k].nameLength - 1] == '\\';
            BOOL currentDirectory = entries[i].name[entries[i].nameLength - 1] == '/' || entries[i].name[entries[i].nameLength - 1] == '\\';
            if (lstrcmpiW(name, previous) == 0 ||
                (!previousDirectory && nameLength > previousLength && name[previousLength] == '\\' && CompareStringOrdinal(name, previousLength, previous, previousLength, TRUE) == CSTR_EQUAL) ||
                (!currentDirectory && previousLength > nameLength && previous[nameLength] == '\\' && CompareStringOrdinal(name, nameLength, previous, nameLength, TRUE) == CSTR_EQUAL)) {
                be_error(error, errorCapacity, L"扩展包包含重复或冲突路径。"); goto done;
            }
        }
    }
    if (directory && !be_mkdirs(directory)) { be_error(error, errorCapacity, L"无法创建扩展临时目录。"); goto done; }
    for (i = 0; i < count; ++i) {
        const WCHAR *name = names + i * CX_BE_MAX_NAME; DWORD outputSize = entries[i].expanded; const BYTE *output;
        if (!be_entry_data(zip, size - zipOffset, &entries[i], &expanded, error, errorCapacity)) goto done;
        output = expanded;
        if (lstrcmpiW(name, L"manifest.json") == 0) {
            manifest = TRUE;
            if (!be_manifest(expanded, entries[i].expanded, publicKey, publicLength, directory ? &rewritten : NULL, &outputSize)) { be_error(error, errorCapacity, L"扩展清单格式或开发者密钥无效。"); goto done; }
            if (rewritten) output = rewritten;
        }
        if (directory && lstrcmpiW(name, L"_metadata\\verified_contents.json") != 0 && entries[i].name[entries[i].nameLength - 1] != '/' && entries[i].name[entries[i].nameLength - 1] != '\\' && !be_write_entry(name, output, outputSize, directory, error, errorCapacity)) goto done;
        HeapFree(GetProcessHeap(), 0, expanded); expanded = NULL; if (rewritten) { HeapFree(GetProcessHeap(), 0, rewritten); rewritten = NULL; }
    }
    if (!manifest) { be_error(error, errorCapacity, L"扩展包缺少 manifest.json。"); goto done; }
    result = TRUE; if (extensionId && idCapacity) lstrcpynW(extensionId, verifiedId, (int)idCapacity);
done:
    if (expanded) HeapFree(GetProcessHeap(), 0, expanded); if (rewritten) HeapFree(GetProcessHeap(), 0, rewritten); if (names) HeapFree(GetProcessHeap(), 0, names); if (entries) HeapFree(GetProcessHeap(), 0, entries);
    if (!result && (!error || !errorCapacity || !error[0])) be_error(error, errorCapacity, L"扩展包内容无效。"); return result;
}

BOOL cx_browser_extension_verify(const BYTE *data, DWORD size, const WCHAR *expectedExtensionId, WCHAR *error, DWORD errorCapacity) {
    return be_process(data, size, NULL, expectedExtensionId, NULL, 0, error, errorCapacity);
}

BOOL cx_browser_extension_extract(const BYTE *data, DWORD size, const WCHAR *directory, WCHAR *extensionId, DWORD idCapacity, WCHAR *error, DWORD errorCapacity) {
    if (!directory) { be_error(error, errorCapacity, L"扩展临时目录无效。"); return FALSE; }
    return be_process(data, size, directory, NULL, extensionId, idCapacity, error, errorCapacity);
}

BOOL cx_browser_extension_extract_file(const WCHAR *file, const WCHAR *directory, WCHAR *extensionId, DWORD idCapacity, WCHAR *error, DWORD errorCapacity) {
    HANDLE handle; LARGE_INTEGER length; BYTE *data; DWORD read; BOOL result;
    if (!file || !directory) return FALSE; handle = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle == INVALID_HANDLE_VALUE || !GetFileSizeEx(handle, &length) || length.QuadPart <= 0 || length.QuadPart > CX_BE_MAX_PACKAGE) { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); be_error(error, errorCapacity, L"无法读取扩展包文件。"); return FALSE; }
    data = (BYTE *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)length.QuadPart); if (!data) { CloseHandle(handle); return FALSE; }
    result = ReadFile(handle, data, (DWORD)length.QuadPart, &read, NULL) && read == (DWORD)length.QuadPart; CloseHandle(handle); if (!result) { HeapFree(GetProcessHeap(), 0, data); return FALSE; }
    result = cx_browser_extension_extract(data, read, directory, extensionId, idCapacity, error, errorCapacity); HeapFree(GetProcessHeap(), 0, data); return result;
}
