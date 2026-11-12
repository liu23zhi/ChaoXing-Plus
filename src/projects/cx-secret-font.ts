// 学习通「加密字体」题面识别（font-cxsecret）。
//
// 背景：学习通在题目页用内嵌 base64 的 TTF 把 CJK 码位映射到错位字形，
// DOM 里拿到的是「正确码位 + 错误字形」，答案比对就会失败。
//
// 上游 Chaoxing-Exam-Extractor v4.5 的做法是本地解密：
//     glyphToPath(font, glyphIndex) -> JSON.stringify -> md5 -> slice(24) -> 查映射表
// 映射表来自 https://forestpolice.org/ttf/2.0/table.json（远程）。
//
// ── 为什么本模块只做「检测 + 告警」而不做还原 ────────────────────────────────
// 不内置映射表、也不在运行时拉取，理由是两条硬约束，不是偷懒：
//
//   1) 供应链与可用性：那份 table.json 是第三方的私有资产，PLUS 的运行链路
//      不能依赖一个不受我们控制的远程地址 —— 断网 / 对方下线 / 被投毒任一条
//      都会让答题直接错乱，而「错乱的答案」比「明确告警」危害大得多。
//   2) 映射表不是「一份就够」：hash -> 码位 的对应关系随学习通换字体而变，
//      要长期可用必须有持续更新的数据源。我们没有可靠来源，就不假装有。
//
// 注意：**PLUS 的 cx.ts 里已经存在一条完整的还原链路**（mappingRecognize +
// loadTyprMapping，从 cdn.ocsjs.com 拉 table.json）。本模块不替换它，也不改它：
// 那条路径是既有行为、有它自己的调用点（章节测试 / 整卷预览），改动风险高于收益。
// 本模块补的是它**缺的那一块** —— 在无法还原时给出明确、可观测、不误判的告警。
//
// 关键判据（别用类名当唯一信号）：学习通还原成功后会摘掉 `.font-cxsecret` 类名，
// 但**摘类名不等于字体已还原** —— 页面上可能残留未处理的节点；反过来，
// 有类名但拿不到字体数据时，我们根本无从判断，此时不该告警。

/** 学习通加密字体固定使用的字族名（@font-face 里就这么写）。 */
export const CX_SECRET_FONT_FAMILY = 'font-cxsecret';

/** 加密字形的类名标记。 */
export const CX_SECRET_FONT_CLASS = 'font-cxsecret';

/**
 * CJK 统一表意文字区。上线代码（cx.ts mappingRecognize）扫的就是这一段：
 *     for (let i = 19968; i < 40870; i++)
 * 抽成常量，避免两处各写一遍魔数后漂移。
 */
export const CX_CJK_SCAN_START = 19968; // U+4E00
export const CX_CJK_SCAN_END = 40870; // 不含

/** upstream v4.5 要求：md5(JSON.stringify(path)) 必须截取后 8 位。 */
export const CX_GLYPH_HASH_SLICE_OFFSET = 24;

/** 默认最多计算多少个字形 hash：够用来补表/对表，又不至于卡住页面。 */
export const CX_DEFAULT_MAX_HASHED_GLYPHS = 64;

export interface SecretFontGlyphHash {
  /** 码位（十进制）。 */
  code: number;
  /** 该码位在字体里的字形索引。 */
  glyphIndex: number;
  /** md5(JSON.stringify(glyphToPath)).slice(24)，与 upstream 映射表口径一致。 */
  glyphHash: string;
  /** 完整 md5，便于排查映射表口径差异。 */
  md5: string;
}

export interface SecretFontFace {
  /** @font-face 里的 font-family 名。 */
  family: string;
  /** base64 字体数据（不含 `base64,` 前缀）。 */
  base64: string;
  /** 内联样本长度，仅用于日志。 */
  byteLength: number;
}

export type SecretFontFailure = 'no-marked-element' | 'no-font-face' | 'font-parse-failed';

export interface SecretFontScanReport {
  /**
   * 页面是否**确实**需要解密：标记节点、可解析字体、至少一个字形 hash，三者齐备。
   * 少任一条都算 false —— 无法判断时谎报 true 会造成误告警。
   */
  encrypted: boolean;
  /** 页面上带加密类名的元素数量（原始观测值，不参与 encrypted 判定）。 */
  markedElementCount: number;
  /** 解析到的 font-cxsecret @font-face 列表。 */
  fontFaces: SecretFontFace[];
  /** 被计算 hash 的字形。 */
  glyphHashes: SecretFontGlyphHash[];
  /** 是否因为上限而截断了字形扫描。 */
  glyphScanTruncated: boolean;
  /** 无法完成检测的原因；为空表示流程正常走完。 */
  failure?: SecretFontFailure;
}

/** typr.js 的最小契约面，避免为测试伪造整个库。 */
export interface SecretFontTypography {
  parse(bytes: Uint8Array): unknown;
  U: {
    codeToGlyph(font: unknown, code: number): number;
    glyphToPath(font: unknown, glyphIndex: number): unknown;
  };
}

export interface SecretFontScanOptions {
  /** 字体解析器（生产传 typr.js）。缺省时无法算 hash，扫描会以 font-parse-failed 收尾。 */
  typography?: SecretFontTypography;
  /** md5 实现（生产传 md5 包）。缺省时无法算 hash。 */
  digest?: (input: string) => string;
  /** base64 解码器；缺省用全局 atob。 */
  atobImpl?: (input: string) => string;
  /** 最多计算多少个字形 hash。 */
  maxHashedGlyphs?: number;
}

/**
 * 从一段 CSS 文本里抽出 @font-face 块的内联字体数据。
 *
 * 只认 `src: url(data:...;base64,XXX)` —— 学习通内联样本就是这种形式；
 * 刻意**不解析远程 url()**：那等于引入运行时远程依赖，与上面的设计决定冲突。
 */
export function extractInlineFontFaces(cssText: string): SecretFontFace[] {
  const faces: SecretFontFace[] = [];
  // @font-face 块内不会嵌套花括号，非贪婪匹配到第一个 } 即可。
  const blockPattern = /@font-face\s*\{([^{}]*)\}/giu;
  for (const block of cssText.matchAll(blockPattern)) {
    const body = block[1] ?? '';
    const familyMatch = body.match(/font-family\s*:\s*['"]?([^;'"}]+)['"]?/iu);
    const family = familyMatch?.[1]?.trim() ?? '';
    if (!family) continue;

    // base64 常被折行，匹配后统一去掉所有空白。
    // 注意 `data:` 之后可能带多个参数（`font/truetype;charset=utf-8;base64,`），
    // 因此用惰性匹配吞掉 `;base64,` 之前的全部内容，不能只允许一个 `;` 段。
    const urlMatch = body.match(/url\(\s*['"]?data:[^)'"]*?;base64,([A-Za-z0-9+/=\s]+)['"]?\s*\)/iu);
    if (!urlMatch) continue;
    const base64 = (urlMatch[1] ?? '').replace(/\s+/gu, '');
    if (!base64) continue;

    faces.push({ family, base64, byteLength: Math.floor((base64.length * 3) / 4) });
  }
  return faces;
}

/** 收集文档里可能定义加密字体的 style 文本。 */
export function collectSecretFontStyleText(doc: Document): string {
  return Array.from(doc.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .filter((text) => text.includes(CX_SECRET_FONT_CLASS))
    .join('\n');
}

/** base64 -> Uint8Array。 */
export function base64ToBytes(base64: string, atobImpl?: (input: string) => string): Uint8Array {
  const decode = atobImpl ?? (typeof atob === 'function' ? atob : undefined);
  if (!decode) throw new Error('base64 解码器不可用');
  const binary = decode(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export interface SecretFontEvidence {
  markedElementCount: number;
  /** 仅含 font-cxsecret 字族的 @font-face。 */
  fontFaces: SecretFontFace[];
}

/**
 * 收集加密字体证据（不做 hash 计算）。
 *
 * 无标记节点时直接返回空 —— 不去扫 style，省掉无谓的 CSS 解析。
 */
export function collectSecretFontEvidence(doc: Document): SecretFontEvidence {
  const markedElementCount = doc.querySelectorAll(`.${CX_SECRET_FONT_CLASS}`).length;
  if (markedElementCount === 0) return { markedElementCount: 0, fontFaces: [] };

  const fontFaces = extractInlineFontFaces(collectSecretFontStyleText(doc))
    .filter((face) => face.family.includes(CX_SECRET_FONT_FAMILY));
  return { markedElementCount, fontFaces };
}

/**
 * 对给定字体算出 CJK 区每个有字形码位的 hash。
 *
 * 与 cx.ts 的运行期实现保持同一口径（md5(JSON.stringify(path)).slice(24)），
 * 但这里限流并跳过 glyphIndex === 0 —— 0 是 .notdef，不代表任何真实字符。
 */
export function hashSecretGlyphs(
  font: unknown,
  typography: SecretFontTypography,
  digest: (input: string) => string,
  maxHashedGlyphs: number = CX_DEFAULT_MAX_HASHED_GLYPHS
): { glyphHashes: SecretFontGlyphHash[]; truncated: boolean } {
  const limit = Math.max(1, Math.floor(maxHashedGlyphs));
  const glyphHashes: SecretFontGlyphHash[] = [];
  let truncated = false;

  for (let code = CX_CJK_SCAN_START; code < CX_CJK_SCAN_END; code++) {
    let glyphIndex = 0;
    try {
      glyphIndex = typography.U.codeToGlyph(font, code);
    } catch {
      // cmap 缺表或格式不支持时 codeToGlyph 会抛；不因为一个码位打断整轮扫描。
      continue;
    }
    if (!glyphIndex) continue;

    // 上限检查放在「确认这是一个真实字形」之后：否则刚好用满上限时，
    // 下一个码位即使没有字形也会把 truncated 置 true，调用方会以为还有更多没算。
    if (glyphHashes.length >= limit) {
      truncated = true;
      break;
    }

    const signature = JSON.stringify(typography.U.glyphToPath(font, glyphIndex));
    const md5Value = digest(signature);
    glyphHashes.push({
      code,
      glyphIndex,
      glyphHash: md5Value.slice(CX_GLYPH_HASH_SLICE_OFFSET),
      md5: md5Value
    });
  }

  return { glyphHashes, truncated };
}

/**
 * 完整扫描：检测 + 抽字体 + 算 hash。
 *
 * 任何一步失败都不抛（页面脚本不该因为字体怪而中断答题），
 * 而是把原因写进 report.failure 让调用方决定措辞。
 */
export function scanSecretFonts(
  doc: Document,
  options: SecretFontScanOptions = {}
): SecretFontScanReport {
  const { typography, digest, atobImpl, maxHashedGlyphs } = options;
  const report: SecretFontScanReport = {
    encrypted: false,
    markedElementCount: 0,
    fontFaces: [],
    glyphHashes: [],
    glyphScanTruncated: false
  };

  const evidence = collectSecretFontEvidence(doc);
  report.markedElementCount = evidence.markedElementCount;
  if (evidence.markedElementCount === 0) return { ...report, failure: 'no-marked-element' };

  report.fontFaces = evidence.fontFaces;
  if (evidence.fontFaces.length === 0) return { ...report, failure: 'no-font-face' };

  // 没有解析器/md5 就算不出 hash；这不是「没加密」，而是「没法判断」。
  if (!typography || !digest) return { ...report, failure: 'font-parse-failed' };

  for (const face of evidence.fontFaces) {
    let font: unknown;
    try {
      font = typography.parse(base64ToBytes(face.base64, atobImpl));
    } catch {
      return { ...report, failure: 'font-parse-failed' };
    }
    if (!font) return { ...report, failure: 'font-parse-failed' };

    const { glyphHashes, truncated } = hashSecretGlyphs(font, typography, digest, maxHashedGlyphs);
    report.glyphHashes.push(...glyphHashes);
    report.glyphScanTruncated = report.glyphScanTruncated || truncated;
  }

  if (report.glyphHashes.length === 0) return { ...report, failure: 'font-parse-failed' };
  report.encrypted = true;
  return report;
}

/**
 * 还原**前置条件**的判定结果。
 *
 * 背景：cx.ts 的 mappingRecognize 有两道「静默跳过」的闸门 ——
 *   :7244  if (fontFaceEl && Object.keys(typrMapping).length > 0) { ... }
 * 只要其中任一为假，整个还原块被跳过、**一个日志都不打**，DOM 里仍留着
 * `.font-cxsecret` 的错位字形，题干照常送进题库搜索，结果是「答案明明对却填错」。
 * 用户与日志都无从发现。本函数把那两种情形显式区分出来。
 */
export type SecretFontUnrestorableReason =
  /** 页面没有 font-cxsecret @font-face（可能真没加密，也可能字体在外链 CSS 里）。 */
  | 'no-font-face'
  /** 有字体但没有映射表（table.json 拉取失败/为空）—— 有字体也解不了。 */
  | 'no-mapping-table'
  /** 字体和映射表都在，可以还原。 */
  | 'restorable';

export interface SecretFontRestorability {
  reason: SecretFontUnrestorableReason;
  /** 页面里带 .font-cxsecret 的节点数；0 表示这页没有要还原的东西。 */
  markedElementCount: number;
  /** 页内 font-cxsecret @font-face 个数。 */
  fontFaceCount: number;
  /** 映射表条目数。 */
  mappingEntryCount: number;
}

/**
 * 判断这次能不能真的还原。**无标记节点时返回 no-font-face**，因为调用方
 * 只在「有密文」时才需要据此告警 —— 这点与 scanSecretFonts 的
 * no-marked-element 区分开，避免把「这页没加密」误报成「还原失败」。
 */
export function evaluateSecretFontRestorability(
  evidence: SecretFontEvidence,
  mapping: Record<string, number> | undefined | null
): SecretFontRestorability {
  const mappingEntryCount = mapping ? Object.keys(mapping).length : 0;
  const fontFaceCount = evidence.fontFaces.length;
  const markedElementCount = evidence.markedElementCount;

  let reason: SecretFontUnrestorableReason;
  if (fontFaceCount === 0) reason = 'no-font-face';
  else if (mappingEntryCount === 0) reason = 'no-mapping-table';
  else reason = 'restorable';

  return { reason, markedElementCount, fontFaceCount, mappingEntryCount };
}

/**
 * 还原失败时给用户的话。返回 undefined 表示无需告警
 * （没密文、或本来就解得了）。
 *
 * 关键：**区分「有字体没映射表」与「连字体都没有」**。前者是我们的映射表
 * 拉取失败（可重试/该报错），后者可能只是这页没加密（不该打扰用户）。
 */
export function describeSecretFontRestorability(
  result: SecretFontRestorability
): string | undefined {
  if (result.markedElementCount === 0) return undefined;
  if (result.reason === 'restorable') return undefined;
  if (result.reason === 'no-mapping-table') {
    return `检测到该页题目使用加密字体，但字体映射表未加载成功（条目数=0），题干无法还原，题库答案的题干/选项比对会失败。请检查网络后刷新页面。`;
  }
  return `检测到该页题目使用加密字体，但页面里找不到对应的 @font-face，题干无法还原，题库答案比对可能失败，请人工复核。`;
}

/**
 * 把扫描结果压成一句给用户看的话。
 *
 * 措辞要求：**说清后果**（答案比对可能失败），而不是只说「检测到加密字体」——
 * 用户不知道那意味着什么。返回 undefined 表示无需提示。
 */
export function describeSecretFontReport(report: SecretFontScanReport): string | undefined {
  if (!report.encrypted) return undefined;
  const glyphCount = report.glyphHashes.length;
  const suffix = report.glyphScanTruncated ? `（已取样前 ${glyphCount} 个字形）` : '';
  return `检测到该页题目使用加密字体${suffix}，题库答案的题干/选项比对可能失败，请人工复核。`;
}

/** 把字形 hash 打出来，供后续补映射表；默认走 console.warn。 */
export function logSecretFontEvidence(
  report: SecretFontScanReport,
  log: (message: string, payload?: unknown) => void = (message, payload) => {
    // eslint-disable-next-line no-console
    console.warn(message, payload);
  }
): void {
  if (!report.encrypted) return;
  log('[chaoxing-plus] 加密字体字形清单（可用于补映射表）', {
    markedElementCount: report.markedElementCount,
    fontFamilies: report.fontFaces.map((face) => face.family),
    glyphScanTruncated: report.glyphScanTruncated,
    glyphHashes: report.glyphHashes.map((glyph) => ({
      code: glyph.code,
      glyphIndex: glyph.glyphIndex,
      glyphHash: glyph.glyphHash
    }))
  });
}
