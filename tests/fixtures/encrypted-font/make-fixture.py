"""生成「加密字体」测试夹具（离线、确定性、可复现）。

背景
====
学习通在题目页用 `@font-face { font-family: font-cxsecret }` 内嵌 base64 的 TTF，
把 CJK 码位映射到**与真实字形不同**的字形上，于是 DOM 里是「正确码位 + 错误字形」
或反之，肉眼看到乱码/错字。

上游 Chaoxing-Exam-Extractor v4.5 的解密链路是：
    glyphToPath(font, glyphIndex) -> JSON.stringify -> md5 -> slice(24) -> 查映射表

本脚本造一个**只含 3 个字**的极小 TTF，让测试能验证
glyphToPath -> JSON.stringify -> md5 -> slice(24) 这条链路本身，
而不需要上游那份完整映射表（PLUS 不引入远程依赖，理由见
src/projects/cx-secret-font.ts 的注释）。

复现
====
    python tests/fixtures/encrypted-font/make-fixture.py

输出（都是纯文本，进仓库无二进制膨胀）：
    fixture.ttf.base64   上面这个极小 TTF 的 base64
    expected-hashes.json 每个码位的 glyphHash（md5(pathStr).slice(24)）

★ 期望值为什么可信（这是本夹具的关键）
=====================================
`expected-hashes.json` **不调用 JS 实现**，而是用 Python 独立复刻了一遍
Typr._simpleGlyph 的轮廓遍历算法（下方 `typr_simple_glyph_path`）。
它不是「把 JS 输出抄一遍」，而是「按 Typr 的算法规范重新实现一次」——
所以下面两点会被独立检出：

  1. slice 偏移从 24 改成别的（upstream 明确要求后 8 位）；
  2. 序列化顺序退化成 fontTools/RecordingPen 的顺序。

第 2 点不是纸上空谈：Typr 的 `_simpleGlyph` 在闭合轮廓上**先 moveTo 到最后一个点**、
再走 i0..il，最后 closePath，因此 path 会**多出一个首点重复**：

    三角形 A(0,0) B(500,0) C(250,700)
    RecordingPen 顺序: M A, L B, L C, Z                    -> 4 点
    Typr 实际顺序:     M C, L A, L B, L C, Z                -> 5 点（C 出现两次）

若照 RecordingPen 的顺序算 hash，得到的是一组「永远匹配不上学习通字体」的值。
本脚本按 Typr 的真实顺序算，实测与 JS 侧逐字节一致（见测试断言）。
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent

# cmap: 码位 -> 字形名。刻意选 CJK 统一表意文字区（0x4E00-0x9FFF），
# 与学习通加密字体的码位区间一致 —— 上线代码用 for(code=19968; code<40870) 扫这一段。
CODEPOINTS = {
    0x4E00: "u4E00",  # 一
    0x4E01: "u4E01",  # 丁
    0x4E02: "u4E02",  # 丂
}


def _triangle() -> TTGlyphPen:
    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((500, 0))
    pen.lineTo((250, 700))
    pen.closePath()
    return pen


def _square() -> TTGlyphPen:
    pen = TTGlyphPen(None)
    pen.moveTo((100, 100))
    pen.lineTo((400, 100))
    pen.lineTo((400, 400))
    pen.lineTo((100, 400))
    pen.closePath()
    return pen


def _diamond() -> TTGlyphPen:
    pen = TTGlyphPen(None)
    pen.moveTo((300, 50))
    pen.lineTo((550, 400))
    pen.lineTo((300, 750))
    pen.lineTo((50, 400))
    pen.closePath()
    return pen


def build_fixture_ttf(path: Path) -> None:
    glyph_order = [".notdef", *CODEPOINTS.values()]
    fb = FontBuilder(unitsPerEm=1000, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({code: name for code, name in CODEPOINTS.items()})

    # 三个形状互不相同，且与码位顺序无对应关系（模拟「字形被洗牌」的加密字体）。
    glyphs = {
        ".notdef": TTGlyphPen(None).glyph(),
        "u4E00": _diamond().glyph(),
        "u4E01": _triangle().glyph(),
        "u4E02": _square().glyph(),
    }
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (600, 0) for name in glyph_order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable(
        {
            "familyName": "font-cxsecret-fixture",
            "styleName": "Regular",
            "psName": "FontCxSecretFixture-Regular",
        }
    )
    fb.setupOS2()
    fb.setupPost()
    fb.save(str(path))


def js_number(value: float) -> str:
    """按 JavaScript 的 Number -> JSON.stringify 规则序列化一个数字。"""
    if isinstance(value, int) or float(value).is_integer():
        return str(int(value))
    return repr(float(value))


def path_signature(cmds: list[str], crds: list[float]) -> str:
    """复刻 JSON.stringify({ cmds, crds }) 的输出。"""
    cmds_json = "[" + ",".join(f'"{c}"' for c in cmds) + "]"
    crds_json = "[" + ",".join(js_number(c) for c in crds) + "]"
    return '{"cmds":' + cmds_json + ',"crds":' + crds_json + "}"


def typr_simple_glyph_path(glyph) -> tuple[list[str], list[float]]:
    """Python 独立复刻 Typr.U._simpleGlyph 的轮廓遍历（不含曲线，fixture 只有直线）。

    逐行对照 node_modules/typr.js 里的 _simpleGlyph：
        for c in contours:
          i0 = 0 if c == 0 else endPts[c-1] + 1
          il = endPts[c]
          for i in i0..il:
            pr = il if i == i0 else i - 1
            nx = i0 if i == il else i + 1
            onCurve = flags[i] & 1 ; prOnCurve = flags[pr] & 1
            if i == i0:
              if onCurve:
                if prOnCurve: M(xs[pr], ys[pr])
                else: M(xs[i], ys[i]); continue
              else:
                if prOnCurve: M(xs[pr], ys[pr])
                else: M((xs[pr]+xs[i])/2, (ys[pr]+ys[i])/2)
            if onCurve:
              if prOnCurve: L(xs[i], ys[i])
            else:
              if nxOnCurve: Q(xs[i], ys[i], xs[nx], ys[nx])
              else: Q(xs[i], ys[i], (xs[i]+xs[nx])/2, (ys[i]+ys[nx])/2)
          Z
    """
    # 用 fontTools 取出 Typr 会看到的同一份数据：绝对坐标 + on-curve 标志 + 每个轮廓的末点索引。
    glyf_table = _GLYF
    coords, end_pts, flags = glyph.getCoordinates(glyf_table)
    xs = [int(p[0]) for p in coords]
    ys = [int(p[1]) for p in coords]

    cmds: list[str] = []
    crds: list[float] = []

    def moveTo(x, y):
        cmds.append("M")
        crds.extend([x, y])

    def lineTo(x, y):
        cmds.append("L")
        crds.extend([x, y])

    for c in range(len(end_pts)):
        i0 = 0 if c == 0 else end_pts[c - 1] + 1
        il = end_pts[c]
        for i in range(i0, il + 1):
            pr = il if i == i0 else i - 1
            nx = i0 if i == il else i + 1
            on_curve = bool(flags[i] & 1)
            pr_on_curve = bool(flags[pr] & 1)
            if i == i0:
                if on_curve:
                    if pr_on_curve:
                        moveTo(xs[pr], ys[pr])
                    else:
                        moveTo(xs[i], ys[i])
                        continue
                else:
                    if pr_on_curve:
                        moveTo(xs[pr], ys[pr])
                    else:
                        moveTo((xs[pr] + xs[i]) / 2, (ys[pr] + ys[i]) / 2)
            if on_curve:
                if pr_on_curve:
                    lineTo(xs[i], ys[i])
            else:
                # fixture 不含二次曲线点；出现即说明夹具被改坏了，直接报错而不是算错 hash。
                raise SystemExit("fixture 不应包含 off-curve 点")
        cmds.append("Z")
    return cmds, crds


_GLYF = None  # set by main()


def main() -> None:
    global _GLYF
    out_ttf = HERE / "fixture.ttf"
    build_fixture_ttf(out_ttf)
    raw = out_ttf.read_bytes()
    (HERE / "fixture.ttf.base64").write_text(
        base64.b64encode(raw).decode("ascii"), encoding="utf-8"
    )

    tt = TTFont(str(out_ttf))
    _GLYF = tt["glyf"]

    expected = {}
    for code, name in CODEPOINTS.items():
        cmds, crds = typr_simple_glyph_path(_GLYF[name])
        sig = path_signature(cmds, crds)
        full = hashlib.md5(sig.encode("utf-8")).hexdigest()
        expected[str(code)] = {
            "glyphName": name,
            "pathSignature": sig,
            "md5": full,
            # upstream v4.5：必须截取后 8 位才能与映射表匹配
            "glyphHash": full[24:],
        }

    (HERE / "expected-hashes.json").write_text(
        json.dumps(
            {
                "note": (
                    "由 make-fixture.py 生成。glyphHash 是按 Typr._simpleGlyph 的轮廓顺序"
                    "独立复刻算出的 md5(pathStr).slice(24)，不调用 JS 实现。"
                ),
                "sliceOffset": 24,
                "codepoints": expected,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    out_ttf.unlink()  # 只保留 base64，避免二进制进仓库
    print("wrote fixture.ttf.base64 and expected-hashes.json")
    for code, item in expected.items():
        print(f"  0x{int(code):04X} {item['glyphName']} -> {item['glyphHash']}")


if __name__ == "__main__":
    main()
