// 面板 UI 优化：三主题对比度实测表（WCAG 2.1 相对亮度，sRGB）。
// 不参与构建，仅用于把「改前/改后」数字固化进 PR 说明。
function srgbToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}
function parse(value) {
  const text = String(value).trim();
  if (text.startsWith('#')) {
    const int = parseInt(text.slice(1), 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
  }
  const parts = text.match(/rgba?\(([^)]+)\)/)[1].split(',').map((x) => Number(x.trim()));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}
function over(top, bottom) {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1
  };
}
function lum(color) {
  const c = color.a < 1 ? over(color, { r: 255, g: 255, b: 255, a: 1 }) : color;
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}
function ratio(fg, bg) {
  const a = lum(parse(fg));
  const b = lum(parse(bg));
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const BEFORE = {
  pink: { emptyState: ['#94a3b8', '#ffffff'], toggleOffHint: ['rgba(157,23,77,0.62)', '#ffffff'], link: ['#db2777', '#ffffff'] },
  blue: { emptyState: ['#94a3b8', '#ffffff'], toggleOffHint: ['rgba(30,58,138,0.62)', '#ffffff'], link: ['#2563eb', '#ffffff'] },
  green: { emptyState: ['#94a3b8', '#ffffff'], toggleOffHint: ['rgba(6,78,59,0.62)', '#ffffff'], link: ['#059669', '#ffffff'] }
};

const AFTER = {
  pink: {
    emptyState: ['#7d2f52', '#ffffff'],
    toggleOffHint: ['#7d2f52', '#ffffff'],
    link: ['#be185d', '#ffffff'],
    text: ['#7a1039', '#ffffff'],
    muted: ['#8a1a4d', '#ffffff'],
    success: ['#14663b', 'rgba(34,197,94,0.14)'],
    warning: ['#7a4c00', 'rgba(250,204,21,0.18)'],
    danger: ['#a11818', 'rgba(239,68,68,0.12)'],
    primaryGradient0: ['#ffffff', '#be185d'],
    primaryGradient1: ['#ffffff', '#db2777']
  },
  blue: {
    emptyState: ['#2b3f6b', '#ffffff'],
    toggleOffHint: ['#2b3f6b', '#ffffff'],
    link: ['#1d4ed8', '#ffffff'],
    text: ['#152e6b', '#ffffff'],
    muted: ['#1a3fa0', '#ffffff'],
    success: ['#14663b', 'rgba(34,197,94,0.14)'],
    warning: ['#7a4c00', 'rgba(250,204,21,0.18)'],
    danger: ['#a11818', 'rgba(239,68,68,0.12)'],
    primaryGradient0: ['#ffffff', '#1d4ed8'],
    primaryGradient1: ['#ffffff', '#2563eb']
  },
  green: {
    emptyState: ['#2b4a3f', '#ffffff'],
    toggleOffHint: ['#2b4a3f', '#ffffff'],
    link: ['#035743', '#ffffff'],
    text: ['#04392b', '#ffffff'],
    muted: ['#035743', '#ffffff'],
    success: ['#12593a', 'rgba(34,197,94,0.16)'],
    warning: ['#6d4300', 'rgba(250,204,21,0.18)'],
    danger: ['#961616', 'rgba(239,68,68,0.12)'],
    primaryGradient0: ['#ffffff', '#065f46'],
    primaryGradient1: ['#ffffff', '#047857']
  }
};

const pad = (text, width) => String(text).padEnd(width);
console.log('=== 改前（不达标项） ===');
console.log(`${pad('主题', 7)}${pad('元素', 16)}${pad('前景', 26)}${pad('背景', 14)}${pad('比值', 8)}结论`);
for (const [theme, items] of Object.entries(BEFORE)) {
  for (const [name, [fg, bg]] of Object.entries(items)) {
    const value = ratio(fg, bg);
    console.log(`${pad(theme, 7)}${pad(name, 16)}${pad(fg, 26)}${pad(bg, 14)}${pad(value.toFixed(2), 8)}${value >= 4.5 ? 'PASS' : 'FAIL'}`);
  }
}

console.log('\n=== 改后 ===');
console.log(`${pad('主题', 7)}${pad('元素', 20)}${pad('前景', 26)}${pad('背景', 26)}${pad('比值', 8)}结论`);
let failures = 0;
for (const [theme, items] of Object.entries(AFTER)) {
  for (const [name, [fg, bg]] of Object.entries(items)) {
    const value = ratio(fg, bg);
    if (value < 4.5) failures += 1;
    console.log(`${pad(theme, 7)}${pad(name, 20)}${pad(fg, 26)}${pad(bg, 26)}${pad(value.toFixed(2), 8)}${value >= 4.5 ? 'PASS' : 'FAIL'}`);
  }
}
console.log(`\n改后不达标数：${failures}`);
