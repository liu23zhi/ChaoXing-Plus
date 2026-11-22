/* Standalone first-party authorization gate test. No client, network, or process operation. */
#include <stdio.h>
#include "../owned-script-authority.h"
static void count(void *context) { ++*(int *)context; }
#define CHECK(x) do { if (!(x)) { printf("failure at line %d\n",__LINE__);return 1; } } while(0)
int main(void) {
    static CX_OWNED_RUN_GRANT grant;
    const WCHAR *s=L"https://service.invalid", *k=L"sr_fixture_session_only_1234",*id=L"synthetic-identity";
    int calls=0;FILETIME a,b;
    CHECK(!cx_grant_dispatch(&grant,s,k,id,count,&calls));CHECK(!calls);
    CHECK(!cx_grant_capture(&grant,s,L"tk_fixture_ordinary_token",id,L"2099-01-01T02:00:00Z"));
    CHECK(!cx_grant_capture(&grant,s,k,L"",L"2099-01-01T02:00:00Z"));
    CHECK(!cx_grant_capture(&grant,s,k,id,L"2000-01-01T02:00:00Z"));
    CHECK(!cx_grant_capture(&grant,s,k,id,L"bad expiry"));
    CHECK(!cx_grant_dispatch(&grant,s,k,id,count,&calls));CHECK(!calls);
    CHECK(cx_grant_time(L"2099-03-06T12:30:00+08:00",&a));
    CHECK(cx_grant_time(L"2099-03-06T04:30:00Z",&b));CHECK(!CompareFileTime(&a,&b));
    CHECK(cx_grant_capture(&grant,s,k,id,L"2099-01-01T02:00:00.123456789Z"));
    CHECK(!cx_grant_dispatch(&grant,s,L"tk_fixture_ordinary_token",id,count,&calls));
    CHECK(!cx_grant_dispatch(&grant,s,k,L"not-bound",count,&calls));
    CHECK(!cx_grant_dispatch(&grant,L"https://other.invalid",k,id,count,&calls));CHECK(!calls);
    CHECK(cx_grant_dispatch(&grant,s,k,id,count,&calls));CHECK(calls==1);
    grant.expires.dwHighDateTime=0;grant.expires.dwLowDateTime=0;
    CHECK(!cx_grant_dispatch(&grant,s,k,id,count,&calls));CHECK(calls==1);
    puts("native launcher: denied before callback; verified stub calls=1; expired/rebound callbacks=0");return 0;
}
