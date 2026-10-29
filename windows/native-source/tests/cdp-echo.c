/* 假 CDP 对端：从 stdin 读一帧，回一帧 Browser.getVersion 响应，用于验证管道握手链路。 */
#include "../net.c"

void __stdcall CdpEchoMain(void) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    char *payload = NULL;
    DWORD length = 0;
    static const char reply[] = "{\"id\":1,\"result\":{\"product\":\"cx-echo/1.0\"}}";
    if (net_pipe_recv_frame(input, &payload, &length, 5000) != 1) ExitProcess(2);
    if (payload) net_free(payload);
    if (!net_pipe_send_frame(output, reply, (DWORD)sizeof(reply) - 1)) ExitProcess(3);
    ExitProcess(0);
}