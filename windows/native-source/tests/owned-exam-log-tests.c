/* Loopback-only harness for the launcher's fixed telemetry HTTP adapter. No target process or exam is loaded. */
#include <stdio.h>
#include <stdlib.h>
#include "../adapter-account.h"
int wmain(int argc,WCHAR **argv) {
    static CX_OWNED_RUN_GRANT g;WCHAR base[80];int port;BOOL expected,got;
    if(argc!=3)return 2;port=_wtoi(argv[1]);if(port<1||port>65535)return 2;
    if(lstrcmpW(argv[2],L"accept")&&lstrcmpW(argv[2],L"disabled")&&lstrcmpW(argv[2],L"ordinary"))return 2;
    expected=!lstrcmpW(argv[2],L"accept");wsprintfW(base,L"http://127.0.0.1:%d",port);
    if(lstrcmpW(argv[2],L"ordinary"))
        (void)cx_grant_capture(&g,base,L"sr_synthetic_receipt_1234567890",L"synthetic-binding",L"2099-01-01T00:00:00Z");
    got=cx_adapter_report_owned_exam_ready(&g,L"fixture-profile-1",L"00000000-0000-4000-8000-000000000001");
    if(got!=expected)return 1;
    puts(expected?"fixed native owned-UI diagnostic was accepted":"no native event accepted");return 0;
}
