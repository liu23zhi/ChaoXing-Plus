#ifndef CX_JSON_H
#define CX_JSON_H
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

typedef struct { int start, end, next, count; char type; } JT;
int jparse(const char *text, int length, JT *tokens, int capacity);
int jkey(const char *text, const JT *tokens, int object, const char *key);
int jint(const char *text, const JT *tokens, int index, int fallback);
BOOL jeq(const char *text, const JT *tokens, int index, const char *value);
BOOL jstr(const char *text, const JT *tokens, int index, char *out, int capacity);
BOOL jwstr(const char *text, const JT *tokens, int index, WCHAR *out, int capacity);
#endif


