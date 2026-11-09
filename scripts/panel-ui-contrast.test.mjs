import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

// 面板文字对比度回归：把 WCAG AA 的 4.5:1 底线变成可执行断言，而不是目测。
// 色板来源是 src/projects/common.ts 的 panelThemes（业务侧）与
// windows/share-file/windows-bootstrap.js 的 PANEL_THEME_STYLES（折叠壳），
// 两边必须同源同值，否则展开前后会跳色。

const commonPath = resolve(process.cwd(), 'src', 'projects', 'common.ts');
const bootstrapPath = resolve(process.cwd(), 'windows', 'share-file', 'windows-bootstrap.js');
const popupPath = resolve(process.cwd(), 'src', 'popup.html');

function srgbToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function parseColor(input) {
  if (input && typeof input === 'object' && typeof input.r === 'number') {
    return { r: input.r, g: input.g, b: input.b, a: typeof input.a === 'number' ? input.a : 1 };
  }
  const text = String(input).trim();
  const hexMatch = text.match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) {
    const int = parseInt(hexMatch[1], 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
  }
  const rgbaMatch = text.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map((item) => Number(item.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((item) => !Number.isFinite(item))) {
      throw new Error(`无法解析颜色：${text}`);
    }
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  throw new Error(`无法解析颜色：${text}`);
}

function over(top, bottom) {
  const alpha = top.a;
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
    a: 1
  };
}

function flatten(color) {
  const parsed = parseColor(color);
  return parsed.a >= 1 ? parsed : over(parsed, { r: 255, g: 255, b: 255, a: 1 });
}
function luminance(color) {
  const value = flatten(color);
  return 0.2126 * srgbToLinear(value.r) + 0.7152 * srgbToLinear(value.g) + 0.0722 * srgbToLinear(value.b);
}

function contrastRatio(foreground, background) {
  const bg = flatten(background);
  const fgRaw = parseColor(foreground);
  const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [light, dark] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (light + 0.05) / (dark + 0.05);
}

/** 从 common.ts 里抽出 panelThemes 的 pink/blue/green 三个色板对象。 */
function readPanelThemes(source) {
  const parsed = ts.createSourceFile('common.ts', source, ts.ScriptTarget.Latest, true);
  let themes;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'panelThemes' && node.initializer) {
      themes = node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(themes, 'panelThemes 必须存在');

  const result = {};
  for (const property of themes.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name.getText(parsed).replace(/^['"]|['"]$/g, '');
    const palette = {};
    for (const entry of property.initializer.properties) {
      if (!ts.isPropertyAssignment(entry)) continue;
      const key = entry.name.getText(parsed).replace(/^['"]|['"]$/g, '');
      const value = entry.initializer.getText(parsed).replace(/^['"]|['"]$/g, '');
      palette[key] = value;
    }
    result[name] = palette;
  }
  return result;
}

/** 从 bootstrap 里抽出 PANEL_THEME_STYLES（纯 JSON 形状，去掉单引号即可）。 */
function readBootstrapThemes(source) {
  const match = source.match(/var PANEL_THEME_STYLES = (\{[\s\S]*?\n  \});/u);
  assert.ok(match, 'bootstrap 必须保留 PANEL_THEME_STYLES');
  const normalized = match[1]
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/gu, '$1"$2":')
    .replace(/'/gu, '"')
    .replace(/,(\s*[}\]])/gu, '$1');
  return JSON.parse(normalized);
}

test('panel palette keeps WCAG AA 4.5:1 for text in all three themes', async () => {
  const themes = readPanelThemes(await readFile(commonPath, 'utf8'));
  assert.deepEqual(Object.keys(themes).sort(), ['blue', 'green', 'pink']);

  const failures = [];
  for (const [name, palette] of Object.entries(themes)) {
    const checks = [
      ['正文 / 卡片白底', palette.text, palette.surfaceStrong],
      ['正文 / 面板底', palette.text, palette.surface],
      ['正文 / 次级卡底', palette.text, '#ffffff'],
      ['说明 / 卡片白底', palette.muted, palette.surfaceStrong],
      ['说明 / primarySoft 底', palette.muted, palette.primarySoft],
      ['弱化文字 / 卡片白底', palette.subtle, palette.surfaceStrong],
      ['弱化文字 / primarySoft 底', palette.subtle, palette.primarySoft],
      ['选中态 primaryDeep / primarySoft 底', palette.primaryDeep, palette.primarySoft],
      ['链接 link / 卡片白底', palette.link, palette.surfaceStrong],
      ['链接 link / 次级卡底', palette.link, '#ffffff'],
      ['状态·成功', palette.successFg, palette.successBg],
      ['状态·警告', palette.warningFg, palette.warningBg],
      ['状态·失败', palette.dangerFg, palette.dangerBg],
      ['状态·信息', palette.infoFg, palette.infoBg]
    ];
    for (const [label, foreground, background] of checks) {
      assert.ok(foreground, `${name} 缺少前景色：${label}`);
      assert.ok(background, `${name} 缺少背景色：${label}`);
      const ratio = contrastRatio(foreground, background);
      if (ratio < 4.5) {
        failures.push(`${name} ${label}: ${foreground} on ${background} = ${ratio.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, [], `以下组合低于 WCAG AA 4.5:1：\n${failures.join('\n')}`);
});

test('state accent colors stay distinguishable from the plain text color', async () => {
  const themes = readPanelThemes(await readFile(commonPath, 'utf8'));
  for (const [name, palette] of Object.entries(themes)) {
    // 成功/警告/失败/信息四种状态不能退化成同一色，否则「不只靠颜色区分」也无从谈起。
    const accents = [palette.successFg, palette.warningFg, palette.dangerFg, palette.infoFg];
    assert.equal(new Set(accents).size, 4, `${name} 状态色重复`);
    for (const accent of accents) {
      const ratio = contrastRatio(accent, palette.surfaceStrong);
      assert.ok(ratio >= 4.5, `${name} 状态色 ${accent} 在白底只有 ${ratio.toFixed(2)}:1`);
    }
  }
});

test('primary gradient keeps white label text readable at every stop', async () => {
  const themes = readPanelThemes(await readFile(commonPath, 'utf8'));
  for (const [name, palette] of Object.entries(themes)) {
    const stops = [...palette.primaryGradient.matchAll(/#[0-9a-f]{6}/giu)].map((match) => match[0]);
    assert.ok(stops.length >= 2, `${name} primaryGradient 至少要有两个色标`);
    for (const stop of stops) {
      // 主按钮是实心渐变 + 白字，色标最浅处也必须 ≥ 4.5:1（旧 pink 渐变末端只有 1.6:1）。
      const ratio = contrastRatio('#ffffff', stop);
      assert.ok(ratio >= 4.5, `${name} 主渐变色标 ${stop} 上的白字只有 ${ratio.toFixed(2)}:1`);
    }
  }
});

test('status strip stays readable on the opaque surface used by the panel', async () => {
  const themes = readPanelThemes(await readFile(commonPath, 'utf8'));
  const common = await readFile(commonPath, 'utf8');
  // 状态条底色必须是不透明白：彩色半透明底会把 pink 主题正文压到 4.04:1（实测）。
  assert.match(common, /strip\.style\.background = panelPinkTheme\.surfaceStrong;/u,
    '状态条必须使用 surfaceStrong 不透明底色');
  for (const [name, palette] of Object.entries(themes)) {
    for (const key of ['text', 'successFg', 'warningFg', 'dangerFg']) {
      const ratio = contrastRatio(palette[key], palette.surfaceStrong);
      assert.ok(ratio >= 4.5, `${name} 状态条 ${key} 只有 ${ratio.toFixed(2)}:1`);
    }
  }
});

test('bootstrap shell palette mirrors the business palette tokens', async () => {
  const themes = readPanelThemes(await readFile(commonPath, 'utf8'));
  const bootstrapThemes = readBootstrapThemes(await readFile(bootstrapPath, 'utf8'));

  for (const name of ['pink', 'blue', 'green']) {
    const business = themes[name];
    const shell = bootstrapThemes[name];
    assert.ok(business && shell, `两侧都必须有 ${name} 主题`);
    // 折叠壳在展开前是唯一可见文字面，文字色必须与业务侧一致。
    assert.equal(shell.text, business.text, `${name} 主题折叠壳标题色未同步`);
    assert.equal(shell.muted, business.muted, `${name} 主题折叠壳说明色未同步`);
    assert.equal(shell.gradient, business.shellGradient, `${name} 主题底色未同步`);
    assert.equal(shell.shadow, business.shellShadow, `${name} 主题阴影未同步`);
    assert.equal(shell.border, `1px solid ${business.borderStrong}`, `${name} 主题边框未同步`);

    // 折叠壳可见文字同样必须达标。
    const titleRatio = contrastRatio(shell.text, shell.headerBackground);
    const hintRatio = contrastRatio(shell.muted, shell.headerBackground);
    assert.ok(titleRatio >= 4.5, `${name} 折叠壳标题对比度只有 ${titleRatio.toFixed(2)}:1`);
    assert.ok(hintRatio >= 4.5, `${name} 折叠壳说明对比度只有 ${hintRatio.toFixed(2)}:1`);
  }
});

test('popup tokens meet WCAG AA on the card surface', async () => {
  const html = await readFile(popupPath, 'utf8');
  const token = (name) => {
    const match = html.match(new RegExp(`--${name}:\\s*([^;]+);`, 'u'));
    assert.ok(match, `popup 缺少 --${name}`);
    return match[1].trim();
  };
  const surface = token('surface-strong');
  for (const [label, name] of [['正文', 'ink'], ['说明', 'ink-muted'], ['弱化', 'ink-subtle']]) {
    const ratio = contrastRatio(token(name), surface);
    assert.ok(ratio >= 4.5, `popup ${label} 只有 ${ratio.toFixed(2)}:1`);
  }
  // 主按钮是实心渐变 + 白字：渐变两端都要 ≥ 4.5:1。
  for (const stop of ['--accent', '--accent-deep']) {
    const ratio = contrastRatio('#ffffff', token(stop.replace(/^--/u, '')));
    assert.ok(ratio >= 4.5, `popup 主按钮 ${stop} 上的白字只有 ${ratio.toFixed(2)}:1`);
  }
  // 触控目标：面板/弹窗里的按钮不能低于 32px。
  assert.match(html, /min-height:\s*44px;/u, 'popup 主按钮必须保留 44px 触控高度');
  assert.match(html, /\.switch-row\s*\{[^}]*min-height:\s*32px;/u, 'popup 开关行必须 ≥ 32px');
});

export const __testing = { contrastRatio, parseColor };
