#include "../json.h"

static JT tokens[256];
static DWORD test_count;
static DWORD failure_count;

static void output(const char *text) {
    DWORD written;
    HANDLE handle = GetStdHandle(STD_OUTPUT_HANDLE);
    if (handle && handle != INVALID_HANDLE_VALUE) {
        WriteFile(handle, text, (DWORD)lstrlenA(text), &written, 0);
    }
}

static void check(const char *name, BOOL passed) {
    test_count++;
    if (!passed) failure_count++;
    output(passed ? "PASS " : "FAIL ");
    output(name);
    output("\r\n");
}

static int parse(const char *text) {
    return jparse(text, lstrlenA(text), tokens, 256);
}

static void number_case(const char *name, const char *text, int expected) {
    int count = parse(text);
    check(name, count == 1 && jint(text, tokens, 0, -99) == expected);
}

static void output_number(DWORD value) {
    char digits[16];
    int size = 0;
    do {
        digits[size++] = (char)('0' + value % 10);
        value /= 10;
    } while (value);
    while (size) {
        char one[2];
        one[0] = digits[--size];
        one[1] = 0;
        output(one);
    }
}

void __stdcall WinMainCRTStartup(void) {
    const char *text;
    WCHAR wide[8];
    unsigned char short_utf8[7];
    int count, outer, items, first, second;
    BOOL copied;

    text = "{\"a\":1,\"b\":null,\"c\":true}";
    count = parse(text);
    check("valid object and property access", count > 0 && tokens[0].type == '{'
        && jint(text, tokens, jkey(text, tokens, 0, "a"), -99) == 1
        && jeq(text, tokens, jkey(text, tokens, 0, "b"), "null")
        && jeq(text, tokens, jkey(text, tokens, 0, "c"), "true"));

    text = "[null,true,false,0,-12,1.5,6e+2]";
    count = parse(text);
    check("valid array with JSON primitive variants", count == 8
        && tokens[0].type == '[' && tokens[0].count == 7 && tokens[0].next == 8);

    text = "null";
    check("top-level null", parse(text) == 1 && jeq(text, tokens, 0, "null"));
    text = "true";
    check("top-level true", parse(text) == 1 && jeq(text, tokens, 0, "true"));
    text = "false";
    check("top-level false", parse(text) == 1 && jeq(text, tokens, 0, "false"));
    text = "-12.5e+2";
    check("top-level decimal exponent", parse(text) == 1 && tokens[0].type == 'p');

    check("reject trueX", parse("trueX") < 0);
    check("reject multiple decimal points", parse("1.2.3") < 0);
    check("reject bare minus", parse("-") < 0);
    check("reject leading zero", parse("01") < 0);
    check("reject incomplete exponent", parse("1e") < 0);

    number_case("INT_MAX", "2147483647", 2147483647);
    number_case("INT_MIN", "-2147483648", (-2147483647 - 1));
    number_case("positive integer overflow uses fallback", "2147483648", -99);
    number_case("negative integer overflow uses fallback", "-2147483649", -99);

    text = "\"\\u4E2D\"";
    count = parse(text);
    check("decode Unicode escape", count == 1 && jwstr(text, tokens, 0, wide, 8)
        && wide[0] == 0x4e2d && wide[1] == 0);

    text = "{\"outer\":{\"items\":[{\"x\":7},{\"x\":8}]},\"tail\":9}";
    count = parse(text);
    outer = jkey(text, tokens, 0, "outer");
    items = jkey(text, tokens, outer, "items");
    first = items >= 0 ? items + 1 : -1;
    second = first >= 0 ? tokens[first].next : -1;
    check("nested next traversal skips complete subtrees", count > 0 && items >= 0
        && tokens[items].type == '[' && tokens[items].count == 2 && second >= 0
        && jint(text, tokens, jkey(text, tokens, second, "x"), -99) == 8
        && jint(text, tokens, jkey(text, tokens, 0, "tail"), -99) == 9);
    check("missing property returns negative index", jkey(text, tokens, 0, "missing") < 0
        && jkey(text, tokens, outer, "tail") < 0);

    text = "\"AB\xE4\xB8\xAD\xE4\xB8\xAD\"";
    count = parse(text);
    short_utf8[0] = 0x5a;
    short_utf8[1] = 0x5a;
    short_utf8[2] = 0x5a;
    short_utf8[3] = 0x5a;
    short_utf8[4] = 0x5a;
    short_utf8[5] = 0x5a;
    short_utf8[6] = 0x5a;
    copied = jstr(text, tokens, 0, (char *)short_utf8, 6);
    check("UTF-8 truncation preserves a complete prefix and buffer guard", count == 1
        && !copied && short_utf8[0] == 'A' && short_utf8[1] == 'B'
        && short_utf8[2] == 0xe4 && short_utf8[3] == 0xb8 && short_utf8[4] == 0xad
        && short_utf8[5] == 0 && short_utf8[6] == 0x5a);

    text = "[1,2]";
    check("token capacity exhaustion fails safely", jparse(text, lstrlenA(text), tokens, 2) < 0);

    output("tests=");
    output_number(test_count);
    output(" failures=");
    output_number(failure_count);
    output("\r\n");
    ExitProcess(failure_count);
}


