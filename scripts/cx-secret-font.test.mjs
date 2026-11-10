// 加密字体（font-cxsecret）检测链路。
//
// 为什么要独立盯这条链路：学习通把题目文字换成错位字形后，DOM 里拿到的是
// 「正确码位 + 错误字形」，题库答案的题干/选项会比对不上 —— 表现是「答案明明对
// 却填错」。识别不出来时用户完全无从知晓，所以这里的三件事必须逐条钉死：
//
//   1. glyphToPath -> JSON.stringify -> md5 -> slice(24) 这条链路的**口径**；
//   2. 「什么时候才算真的加密」（避免误告警，误告警会让用户不再信任提示）；
//   3. 不引入远程映射表（离线可用 + 供应链）。
//
// 夹具 tests/fixtures/encrypted-font/ 里的 expected-hashes.json 是用 Python
// 按 Typr._simpleGlyph 的轮廓顺序**独立复刻**出来的，不是抄 JS 输出。
// 详见该目录 make-fixture.py 的文件头。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { register } from 'node:module';

register('./ci/ts-source-hooks.mjs', import.meta.url);

// typr.js 在模块顶层读 window.TextDecoder，Node 里必须先补上再 import。
// 它是个 2019 年的 UMD 包（index.js 单文件），没有 ESM 构建，无法避开这一步。
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { TextDecoder };
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../tests/fixtures/encrypted-font');
const fixtureBase64 = readFileSync(resolve(fixtureDir, 'fixture.ttf.base64'), 'utf8').trim();
const fixtureExpected = JSON.parse(readFileSync(resolve(fixtureDir, 'expected-hashes.json'), 'utf8'));

const { default: Typr } = await import('typr.js');
const { default: md5 } = await import('md5');
const {
  CX_SECRET_FONT_FAMILY,
  CX_SECRET_FONT_CLASS,
  collectSecretFontStyleText,
  CX_GLYPH_HASH_SLICE_OFFSET,
  CX_CJK_SCAN_START,
  CX_CJK_SCAN_END,
  CX_DEFAULT_MAX_HASHED_GLYPHS,
  extractInlineFontFaces,
  collectSecretFontEvidence,
  base64ToBytes,
  hashSecretGlyphs,
  scanSecretFonts,
  describeSecretFontReport,
  logSecretFontEvidence
} = await import('../src/projects/cx-secret-font.js');

// ---------------------------------------------------------------------------
// 最小 DOM 替身：本模块只用到 querySelectorAll + textContent。
// 用真 puppeteer 会把这些用例变成「跳过」（本机没有浏览器），而这条链路的
// 正确性不该依赖浏览器是否可用。
// ---------------------------------------------------------------------------
function fakeDocument({ marked = 0, styles = [] } = {}) {
  return {
    querySelectorAll(selector) {
      if (selector === `.${CX_SECRET_FONT_CLASS}`) {
        return Array.from({ length: marked }, () => ({}));
      }
      if (selector === 'style') return styles.map((text) => ({ textContent: text }));
      return [];
    }
  };
}

/** 把夹具字体包成学习通那种内联 @font-face。 */
function secretFontCss(base64 = fixtureBase64, family = 'font-cxsecret') {
  return `.TiMu .font-cxsecret { font-family: ${family}; }
@font-face {
  font-family: ${family};
  src: url(data:font/truetype;charset=utf-8;base64,${base64}) format('truetype');
}`;
}

const typography = { parse: (bytes) => Typr.parse(bytes), U: Typr.U };

// ---------------------------------------------------------------------------
// 1. 核心算法口径：glyphToPath -> JSON.stringify -> md5 -> slice(24)
// ---------------------------------------------------------------------------
test('glyphToPath -> md5(pathStr).slice(24) reproduces the independently derived fixture hashes', () => {
  const font = Typr.parse(base64ToBytes(fixtureBase64));
  const codepoints = Object.keys(fixtureExpected.codepoints);
  assert.ok(codepoints.length >= 3, '夹具至少要覆盖 3 个字形');

  for (const code of codepoints) {
    const expected = fixtureExpected.codepoints[code];
    const glyphIndex = Typr.U.codeToGlyph(font, Number(code));
    assert.ok(glyphIndex > 0, `码位 ${code} 应有真实字形`);

    const signature = JSON.stringify(Typr.U.glyphToPath(font, glyphIndex));
    const full = md5(signature);
    assert.equal(
      full.slice(CX_GLYPH_HASH_SLICE_OFFSET),
      expected.glyphHash,
      `码位 ${code} 的 glyphHash 必须与 Python 独立复刻值一致（slice 偏移 ${CX_GLYPH_HASH_SLICE_OFFSET}）`
    );
    // 完整 md5 也钉住：只对上后 8 位而前 24 位不同，说明序列化已经漂移。
    assert.equal(full, expected.md5);
  }
});

test('slice offset 24 is load-bearing: taking the front 8 hex chars yields a different table key', () => {
  // 这条是防止「顺手把 slice(24) 改成 slice(0,8)」的回归钉子。
  // 上游 v4.5 明确写：截取后 8 位才能与映射表匹配；前端 8 位是一组对不上的键。
  const font = Typr.parse(base64ToBytes(fixtureBase64));
  const first = Object.values(fixtureExpected.codepoints)[0];
  const glyphIndex = Typr.U.codeToGlyph(font, Number(Object.keys(fixtureExpected.codepoints)[0]));
  const full = md5(JSON.stringify(Typr.U.glyphToPath(font, glyphIndex)));

  assert.equal(full.slice(24), first.glyphHash);
  assert.notEqual(full.slice(0, 8), first.glyphHash, '前 8 位必须与后 8 位不同，否则这条钉子无效');
  assert.notEqual(
    full.slice(0, 8),
    full.slice(24),
    '夹具字体的 md5 前后各 8 位若相同，slice 偏移就测不出来了'
  );
});

test('hashSecretGlyphs uses the CJK scan window and skips .notdef', () => {
  const font = Typr.parse(base64ToBytes(fixtureBase64));
  const { glyphHashes, truncated } = hashSecretGlyphs(font, typography, md5, 64);

  assert.equal(truncated, false, '只有 3 个字形时不该截断');
  assert.deepEqual(
    glyphHashes.map((glyph) => glyph.code),
    [0x4e00, 0x4e01, 0x4e02],
    '只应命中 cmap 里真实存在的三个码位'
  );
  for (const glyph of glyphHashes) {
    assert.ok(glyph.glyphIndex > 0, '.notdef(0) 必须被跳过');
    assert.ok(glyph.code >= CX_CJK_SCAN_START && glyph.code < CX_CJK_SCAN_END);
    assert.equal(glyph.glyphHash, fixtureExpected.codepoints[String(glyph.code)].glyphHash);
    assert.equal(glyph.glyphHash.length, 8, '后 8 位 = 8 个十六进制字符');
  }
});

test('hashSecretGlyphs honours maxHashedGlyphs and reports truncation', () => {
  const font = Typr.parse(base64ToBytes(fixtureBase64));

  const one = hashSecretGlyphs(font, typography, md5, 1);
  assert.equal(one.glyphHashes.length, 1);
  assert.equal(one.truncated, true, '上限小于可用字形数时必须标记截断');

  const exact = hashSecretGlyphs(font, typography, md5, 3);
  assert.equal(exact.glyphHashes.length, 3);
  assert.equal(exact.truncated, false, '刚好用满上限不算截断');

  const zero = hashSecretGlyphs(font, typography, md5, 0);
  assert.equal(zero.glyphHashes.length, 1, '上限被夹到至少 1，不能返回空');
});

// ---------------------------------------------------------------------------
// 2. @font-face 抽取：只认内联 base64，不碰远程 url
// ---------------------------------------------------------------------------
test('extractInlineFontFaces reads inline base64 and ignores remote url() sources', () => {
  const faces = extractInlineFontFaces(secretFontCss());
  assert.equal(faces.length, 1);
  assert.equal(faces[0].family, 'font-cxsecret');
  assert.equal(faces[0].base64, fixtureBase64);
  assert.ok(faces[0].byteLength > 0);

  // 远程字体是我们明确拒绝的路径：抽不出来才是对的。
  const remote = extractInlineFontFaces(
    `@font-face { font-family: font-cxsecret; src: url(https://cdn.example.com/f.ttf) format('truetype'); }`
  );
  assert.deepEqual(remote, []);
});

test('extractInlineFontFaces tolerates wrapped base64 and multiple faces', () => {
  const wrapped = `${fixtureBase64.slice(0, 40)}\n  ${fixtureBase64.slice(40)}`;
  const faces = extractInlineFontFaces(secretFontCss(wrapped));
  assert.equal(faces.length, 1);
  assert.equal(faces[0].base64, fixtureBase64, '换行必须被剔除，否则 base64 解出来是坏字体');

  const two = extractInlineFontFaces(
    `@font-face { font-family: other; src: url(data:font/ttf;base64,${fixtureBase64}) }
     @font-face { font-family: font-cxsecret; src: url(data:font/ttf;base64,${fixtureBase64}) }`
  );
  assert.deepEqual(two.map((face) => face.family), ['other', 'font-cxsecret']);
});

// ---------------------------------------------------------------------------
// 3. 什么才算「确实加密」—— 这是防误告警的核心
// ---------------------------------------------------------------------------
test('scanSecretFonts reports encrypted only when marks, font data and glyph hashes all exist', () => {
  const report = scanSecretFonts(fakeDocument({ marked: 2, styles: [secretFontCss()] }), {
    typography,
    digest: md5
  });

  assert.equal(report.encrypted, true);
  assert.equal(report.failure, undefined);
  assert.equal(report.markedElementCount, 2);
  assert.equal(report.fontFaces.length, 1);
  assert.equal(report.glyphHashes.length, 3);
  assert.equal(report.glyphScanTruncated, false);
});

test('scanSecretFonts does not claim encryption when no element carries the secret class', () => {
  // 还原链路跑完之后类名会被摘掉，此时页面上没有标记节点 —— 不能告警。
  const report = scanSecretFonts(fakeDocument({ marked: 0, styles: [secretFontCss()] }), {
    typography,
    digest: md5
  });
  assert.equal(report.encrypted, false);
  assert.equal(report.failure, 'no-marked-element');
  assert.equal(report.glyphHashes.length, 0);
  assert.equal(describeSecretFontReport(report), undefined, '不加密时不得产出提示文案');
});

test('scanSecretFonts does not claim encryption when the font data is unreachable', () => {
  // 有类名但 @font-face 已被移除（或指向远程）：我们没法判断，此时告警就是误报。
  const report = scanSecretFonts(fakeDocument({ marked: 1, styles: ['.font-cxsecret{}'] }), {
    typography,
    digest: md5
  });
  assert.equal(report.encrypted, false);
  assert.equal(report.failure, 'no-font-face');
  assert.deepEqual(report.fontFaces, []);
});

test('scanSecretFonts ignores a @font-face that is not the cxsecret family', () => {
  // 关键：style 里必须**同时**出现 `.font-cxsecret` 规则（否则收集器会先把它过滤掉，
  // 这条用例就变成了在测收集器而不是在测字族过滤 —— 那是假钉子）。
  // 真实页面也是这样：类名规则和 @font-face 在同一个 style 块里。
  const css = `.TiMu .font-cxsecret { font-family: "SimSun"; }
@font-face { font-family: SimSun; src: url(data:font/ttf;base64,${fixtureBase64}) }`;
  const report = scanSecretFonts(fakeDocument({ marked: 1, styles: [css] }), { typography, digest: md5 });

  assert.equal(report.encrypted, false);
  assert.equal(report.failure, 'no-font-face', '只认 font-cxsecret 字族，普通字体不算加密');
  assert.deepEqual(report.fontFaces, []);

  // 反向对照：同一个 style 里加一个 cxsecret 字族就必须被认出来，
  // 证明上面那条 false 不是因为整段 style 都被丢弃了。
  const withSecret = `${css}
@font-face { font-family: font-cxsecret; src: url(data:font/ttf;base64,${fixtureBase64}) }`;
  const second = scanSecretFonts(fakeDocument({ marked: 1, styles: [withSecret] }), {
    typography,
    digest: md5
  });
  assert.equal(second.encrypted, true);
  assert.deepEqual(second.fontFaces.map((face) => face.family), ['font-cxsecret']);
});

test('scanSecretFonts degrades to font-parse-failed instead of throwing on corrupt font bytes', () => {
  const corrupt = 'AAAA'; // 合法 base64，但不是字体
  const report = scanSecretFonts(fakeDocument({ marked: 1, styles: [secretFontCss(corrupt)] }), {
    typography,
    digest: md5
  });
  assert.equal(report.encrypted, false);
  assert.equal(report.failure, 'font-parse-failed');
  // 解析失败不能留下半截字形，否则调用方会拿垃圾 hash 去对表。
  assert.deepEqual(report.glyphHashes, []);
});

test('scanSecretFonts degrades when no typography or digest is available', () => {
  const noTypography = scanSecretFonts(fakeDocument({ marked: 1, styles: [secretFontCss()] }), { digest: md5 });
  assert.equal(noTypography.encrypted, false);
  assert.equal(noTypography.failure, 'font-parse-failed');

  const noDigest = scanSecretFonts(fakeDocument({ marked: 1, styles: [secretFontCss()] }), { typography });
  assert.equal(noDigest.encrypted, false);
  assert.equal(noDigest.failure, 'font-parse-failed');
});

// ---------------------------------------------------------------------------
// 4. 告警文案与日志：说清后果 + 打出可补表的 hash
// ---------------------------------------------------------------------------
test('describeSecretFontReport states the consequence, not just the detection', () => {
  const report = scanSecretFonts(fakeDocument({ marked: 1, styles: [secretFontCss()] }), {
    typography,
    digest: md5
  });
  const message = describeSecretFontReport(report);
  assert.ok(message, '加密时必须给出文案');
  assert.match(message, /加密字体/u);
  assert.match(message, /比对可能失败/u, '必须说清后果：用户不知道「加密字体」意味着什么');
  assert.match(message, /人工复核/u);
  // 未截断时不该出现取样说明。
  assert.doesNotMatch(message, /取样/u);
});

test('describeSecretFontReport mentions sampling when the glyph scan was truncated', () => {
  const report = scanSecretFonts(fakeDocument({ marked: 1, styles: [secretFontCss()] }), {
    typography,
    digest: md5,
    maxHashedGlyphs: 1
  });
  const message = describeSecretFontReport(report);
  assert.ok(message);
  assert.equal(report.glyphScanTruncated, true);
  assert.match(message, /取样前 1 个字形/u);
});

test('logSecretFontEvidence emits the raw glyph hashes needed to extend a mapping table', () => {
  const report = scanSecretFonts(fakeDocument({ marked: 1, styles: [secretFontCss()] }), {
    typography,
    digest: md5
  });
  const calls = [];
  logSecretFontEvidence(report, (message, payload) => calls.push([message, payload]));

  assert.equal(calls.length, 1);
  const [message, payload] = calls[0];
  assert.match(message, /字形清单/u);
  assert.deepEqual(payload.fontFamilies, ['font-cxsecret']);
  assert.equal(payload.glyphHashes.length, 3);
  assert.deepEqual(
    payload.glyphHashes.map((glyph) => glyph.glyphHash),
    Object.values(fixtureExpected.codepoints).map((item) => item.glyphHash),
    '日志里的 hash 必须就是可用于补表的那组值'
  );
});

test('logSecretFontEvidence stays silent for a clean page', () => {
  const report = scanSecretFonts(fakeDocument({ marked: 0 }), { typography, digest: md5 });
  const calls = [];
  logSecretFontEvidence(report, (...args) => calls.push(args));
  assert.deepEqual(calls, [], '未检测到加密时不得产出任何日志噪音');
});

// ---------------------------------------------------------------------------
// 5. 红线：不引入远程映射表
// ---------------------------------------------------------------------------
test('the module never fetches a remote mapping table', () => {
  const source = readFileSync(resolve(here, '../src/projects/cx-secret-font.ts'), 'utf8');
  // 只看**代码**，不看注释：文件头刻意写了两处来源地址，用来说明「为什么不用」。
  // 如果不剥注释，这条断言会被自己的说明文字判红，属于假钉子。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[ \t]*\/\/.*$/gmu, '');

  // 只做检测/告警，不内置也不拉取 hash -> 码位 的映射表（理由见文件头）。
  assert.doesNotMatch(code, /forestpolice\.org/u);
  assert.doesNotMatch(code, /ocsjs\.com/u);
  assert.doesNotMatch(code, /\bfetch\s*\(/u);
  assert.doesNotMatch(code, /XMLHttpRequest/u);
  assert.doesNotMatch(code, /\$request\b|\brequest\s*\(/u);
  // 代码里不能出现「映射表」形态的数据。
  assert.doesNotMatch(code, /typrMapping|loadTyprMapping/u);
  // 也不能有远程 url() 的解析分支（只允许 data: 内联）。
  assert.doesNotMatch(code, /https?:\/\//u);
});

test('collectSecretFontEvidence returns nothing when the page has no marked element', () => {
  const evidence = collectSecretFontEvidence(fakeDocument({ marked: 0, styles: [secretFontCss()] }));
  assert.equal(evidence.markedElementCount, 0);
  assert.deepEqual(evidence.fontFaces, []);
});

test('default glyph cap is small enough to stay cheap on a real page', () => {
  assert.ok(CX_DEFAULT_MAX_HASHED_GLYPHS > 0);
  assert.ok(
    CX_DEFAULT_MAX_HASHED_GLYPHS <= 256,
    `默认上限 ${CX_DEFAULT_MAX_HASHED_GLYPHS} 过大：整段 CJK 区有 2 万个码位，` +
      '每个都要做一次 glyphToPath + md5，会明显卡住题目页。'
  );
});

// ---------------------------------------------------------------------------
// collectSecretFontStyleText：只收「含 font-cxsecret 的 style」，其余必须被过滤
//
// 为什么要单独钉：这层过滤是「不误告警」的第一道闸。若它把无关 style 也收进来，
// 后续 collectSecretFontEvidence 会拿一堆不含加密字体的 CSS 去解析，既慢又可能
// 因别处的 @font-face 造出假证据。
// ---------------------------------------------------------------------------
test('collectSecretFontStyleText keeps only styles that mention the secret font class', () => {
  const unrelated = '.TiMu { padding: 8px; }';
  const marked = secretFontCss();
  const alsoUnrelated = '@font-face { font-family: Roboto; src: url(data:font/woff;base64,AAAA); }';

  const joined = collectSecretFontStyleText(fakeDocument({ styles: [unrelated, marked, alsoUnrelated] }));

  assert.ok(joined.includes('font-cxsecret'), '含加密字体字族的 style 必须被保留');
  assert.ok(!joined.includes('padding: 8px'), '无关 style 必须被过滤掉');
  assert.ok(!joined.includes('Roboto'), '另一个字族的 @font-face 也必须被过滤掉');
  // 三条 style 里只有一条命中：joined 必须恰好等于那条的内容（不多拼接其它 style）。
  assert.equal(joined, marked, 'joined 必须恰好等于命中的那一条 style 原文');
});

test('collectSecretFontStyleText tolerates a style node with null textContent', () => {
  // style.textContent ?? '' 的兜底分支：某些注入场景下节点存在但内容为空。
  const doc = {
    querySelectorAll(selector) {
      if (selector === 'style') return [{ textContent: null }, { textContent: secretFontCss() }];
      return [];
    }
  };
  const joined = collectSecretFontStyleText(doc);
  assert.ok(joined.includes('font-cxsecret'), 'null 内容不得让整条链路抛错，命中的那一条仍要出来');
});

// ---------------------------------------------------------------------------
// CX_SECRET_FONT_FAMILY 与 CLASS 必须同值
//
// 学习通的标记类名与字族名是同一个字符串。若二者漂移，检测会「找到标记节点
// 却匹配不到 @font-face」，表现为永远 encrypted=false —— 静默漏报。
// ---------------------------------------------------------------------------
test('secret font family and class must stay identical', () => {
  assert.equal(CX_SECRET_FONT_FAMILY, CX_SECRET_FONT_CLASS,
    '标记类名与字族名必须一致，否则检测会静默漏报');
  assert.equal(CX_SECRET_FONT_FAMILY, 'font-cxsecret', '口径来自学习通实际使用的字族名');
});

// ---------------------------------------------------------------------------
// codeToGlyph 抛错时必须 continue，不能中断整轮扫描
//
// 为什么单独钉：cmap 缺表 / 字体格式不被 typr 支持时，`U.codeToGlyph` 会抛。
// 若这里没有 try/catch，一个坏码位就会让整页「检测失败」—— 表现为明明有加密
// 字体却报 font-parse-failed，用户看到的是「一切正常」。这条分支是容错的核心。
// ---------------------------------------------------------------------------
test('hashSecretGlyphs keeps scanning when codeToGlyph throws for some codepoints', () => {
  const parsed = Typr.parse(base64ToBytes(fixtureBase64));
  const fixtureCodes = Object.keys(fixtureExpected.codepoints).map(Number);
  const firstCode = fixtureCodes[0];
  const secondCode = fixtureCodes[1];

  let thrown = 0;
  const flakyTypography = {
    parse: (bytes) => Typr.parse(bytes),
    U: {
      codeToGlyph: (font, code) => {
        // 让第一个真实码位抛错，其余码位正常。
        if (code === firstCode) {
          thrown += 1;
          throw new Error('synthetic cmap failure');
        }
        return Typr.U.codeToGlyph(font, code);
      },
      glyphToPath: (font, glyphIndex) => Typr.U.glyphToPath(font, glyphIndex)
    }
  };

  const result = hashSecretGlyphs(parsed, flakyTypography, md5, 8);

  assert.equal(thrown, 1, '夹具里的首个码位必须真的抛过一次错');
  // 关键：抛错之后仍要拿到其余码位的 hash，说明 continue 生效而不是整轮退出。
  assert.ok(result.glyphHashes.length > 0,
    '一个码位抛错不得让整轮扫描归零 —— 否则检测会静默退化成 font-parse-failed');
  const got = result.glyphHashes.map((item) => item.code);
  assert.ok(!got.includes(firstCode), '抛错的码位不该产生 hash');
  assert.ok(got.includes(secondCode), '后续码位必须继续被扫描到');
});

test('hashSecretGlyphs floors a fractional cap and never drops below one', () => {
  const parsed = Typr.parse(base64ToBytes(fixtureBase64));
  // Math.max(1, Math.floor(...)) 的两个分支：小数被向下取整、0 被抬到 1。
  const fractional = hashSecretGlyphs(parsed, typography, md5, 2.9);
  assert.equal(fractional.glyphHashes.length, 2, '2.9 应向下取整成 2');

  const zeroCap = hashSecretGlyphs(parsed, typography, md5, 0);
  assert.equal(zeroCap.glyphHashes.length, 1, '上限 0 必须被抬到 1，不能返回空');
});

// ---------------------------------------------------------------------------
// 默认日志通道：不传 log 时必须走 console.warn
//
// 为什么单独钉：生产调用方（cx.ts）不传第二个参数。若默认分支坏掉（例如被改成
// 空函数），加密字体告警会静默消失 —— 用户看到的就是「一切正常」，而题目文字
// 其实是错位字形。这条断言让「默认通道真的会说话」变成可判定的。
// ---------------------------------------------------------------------------
test('logSecretFontEvidence falls back to console.warn when no logger is given', (t) => {
  const report = scanSecretFonts(fakeDocument({ marked: 1, styles: [secretFontCss()] }), {
    typography,
    digest: md5
  });

  const original = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args);
  t.after(() => { console.warn = original; });

  logSecretFontEvidence(report);

  assert.equal(seen.length, 1, '不传 log 时必须落到 console.warn，且只调用一次');
  assert.match(String(seen[0][0]), /字形清单/u, '默认通道的文案必须与显式通道一致');
  assert.equal(seen[0][1].glyphHashes.length, 3, '默认通道也必须带上完整字形清单');
});

test('logSecretFontEvidence default channel stays silent for a clean page', (t) => {
  const report = scanSecretFonts(fakeDocument({ marked: 0, styles: [] }), { typography, digest: md5 });
  const original = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args);
  t.after(() => { console.warn = original; });

  logSecretFontEvidence(report);
  assert.equal(seen.length, 0, '无加密字体时默认通道也必须是静默的');
});
