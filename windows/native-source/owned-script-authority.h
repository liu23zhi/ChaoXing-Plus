#ifndef CX_OWNED_SCRIPT_AUTHORITY_H
#define CX_OWNED_SCRIPT_AUTHORITY_H
#include <windows.h>

/* Private to the launcher. Never read this grant from a settings file, arguments, or a page. */
typedef struct CX_OWNED_RUN_GRANT {
    WCHAR service[1024];
    WCHAR token[4096];
    WCHAR identity[128];
    FILETIME expires;
} CX_OWNED_RUN_GRANT;

static __inline unsigned cx_grant_number(const WCHAR *s, int at, int n) {
    unsigned v=0; int i;
    for(i=0;i<n;i++) { WCHAR c=s[at+i]; if(c<L'0'||c>L'9')return 65535; v=v*10+(unsigned)(c-L'0'); } return v;
}
static __inline BOOL cx_grant_time(const WCHAR *s, FILETIME *out) {
    int n=s?lstrlenW(s):0, i=19, sign=0, digits=0; unsigned h,m;
    SYSTEMTIME st; FILETIME time; ULARGE_INTEGER value, offset;
    if(n<20||n>40||s[4]!=L'-'||s[7]!=L'-'||s[10]!=L'T'||s[13]!=L':'||s[16]!=L':')return FALSE;
    ZeroMemory(&st,sizeof(st));st.wYear=(WORD)cx_grant_number(s,0,4);st.wMonth=(WORD)cx_grant_number(s,5,2);
    st.wDay=(WORD)cx_grant_number(s,8,2);st.wHour=(WORD)cx_grant_number(s,11,2);st.wMinute=(WORD)cx_grant_number(s,14,2);st.wSecond=(WORD)cx_grant_number(s,17,2);
    if(st.wYear<1970||st.wYear>9999||!SystemTimeToFileTime(&st,&time))return FALSE;
    if(s[i]==L'.') {++i;while(i<n&&s[i]>=L'0'&&s[i]<=L'9'){++i;++digits;}if(!digits||digits>9)return FALSE;}
    if(i+1==n&&s[i]==L'Z') {*out=time;return TRUE;}
    if(i+6!=n||(s[i]!=L'+'&&s[i]!=L'-')||s[i+3]!=L':')return FALSE;
    sign=s[i]==L'+'?1:-1;h=cx_grant_number(s,i+1,2);m=cx_grant_number(s,i+4,2);if(h>23||m>59)return FALSE;
    offset.QuadPart=(ULONGLONG)(h*60+m)*600000000UL;
    value.LowPart=time.dwLowDateTime;value.HighPart=time.dwHighDateTime;
    if(sign>0){ if(value.QuadPart<offset.QuadPart)return FALSE;value.QuadPart-=offset.QuadPart; }else value.QuadPart+=offset.QuadPart;
    out->dwLowDateTime=value.LowPart;out->dwHighDateTime=value.HighPart;return TRUE;
}
static __inline BOOL cx_grant_capture(CX_OWNED_RUN_GRANT *g,const WCHAR *service,const WCHAR *token,const WCHAR *identity,const WCHAR *expiry) {
    FILETIME now;
    if(!g)return FALSE; SecureZeroMemory(g,sizeof(*g));
    if(!service||!*service||lstrlenW(service)>=1024||!token||lstrlenW(token)<19||lstrlenW(token)>=4096||token[0]!=L's'||token[1]!=L'r'||token[2]!=L'_'
       ||!identity||!*identity||lstrlenW(identity)>=128||!cx_grant_time(expiry,&g->expires))return FALSE;
    GetSystemTimeAsFileTime(&now); if(CompareFileTime(&g->expires,&now)<=0)return FALSE;
    lstrcpynW(g->service,service,1024);lstrcpynW(g->token,token,4096);lstrcpynW(g->identity,identity,128);return TRUE;
}
typedef void (*CX_OWNED_DISPATCH)(void *context);
static __inline BOOL cx_grant_dispatch(const CX_OWNED_RUN_GRANT *g,const WCHAR *service,const WCHAR *token,const WCHAR *identity,CX_OWNED_DISPATCH next,void *context) {
    FILETIME now;
    if(!g||!service||lstrcmpW(g->service,service)||!g->token[0]||!g->identity[0]||!token||!identity||!next||lstrcmpW(g->token,token)||lstrcmpW(g->identity,identity))return FALSE;
    GetSystemTimeAsFileTime(&now); if(CompareFileTime(&g->expires,&now)<=0)return FALSE;
    next(context);return TRUE;
}
#endif
