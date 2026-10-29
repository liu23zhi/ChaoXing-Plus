import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const commonPath = resolve(scriptsDir, '..', 'src', 'projects', 'common.ts');
const panelPath = resolve(scriptsDir, '..', 'src', 'runtime', 'panel.ts');

test('runtime panel root uses the pink shell theme', async () => {
  const source = await readFile(panelPath, 'utf8');

  assert.equal(source.includes("root.dataset.chaoxingPlusTheme = 'pink';"), true);
  assert.equal(source.includes("root.style.background = 'linear-gradient(145deg, #fff0f7 0%, #fffafd 48%, #ffecf4 100%)';"), true);
  assert.equal(source.includes("root.style.border = '1px solid rgba(244, 114, 182, 0.30)';"), true);
  assert.equal(source.includes("root.style.boxShadow = '0 10px 28px rgba(190, 24, 93, 0.16), 0 2px 8px rgba(190, 24, 93, 0.10)';"), true);
  assert.equal(source.includes("root.style.borderRadius = '24px';"), true);
});

test('floating panel avoids backdrop blur and device-pixel blurry artifacts', async () => {
  const panelSource = await readFile(panelPath, 'utf8');
  const commonSource = await readFile(commonPath, 'utf8');

  // 不再使用 backdrop-filter：它会把面板背后的页面内容整体模糊（Windows/CEF75 下尤其明显）。
  assert.equal(panelSource.includes('backdropFilter'), false);
  assert.equal(commonSource.includes("backdropFilter = 'blur"), false);
  assert.equal(commonSource.includes("panel.root.style.backdropFilter = 'none';"), true);

  // 阴影必须是紧凑的低透明度阴影，不能再用 70px 级别的大半径光晕。
  assert.equal(panelSource.includes('0 24px 70px'), false);
  assert.equal(commonSource.includes('0 24px 70px'), false);
  assert.equal(commonSource.includes('0 20px 54px'), false);
  assert.equal(commonSource.includes('0 18px 48px'), false);

  // fixed 面板位置必须吸附到设备像素网格，否则 125%/150% 缩放下会亚像素发虚。
  assert.equal(commonSource.includes('function snapToDevicePixel('), true);
  assert.equal(commonSource.includes('function getDevicePixelRatio('), true);
  assert.equal(commonSource.includes('function snapPanelOuterWidth('), true);
  assert.equal(commonSource.includes('snapPanelOuterWidth(panel.root);'), true);
  assert.equal(commonSource.includes('top: snapToDevicePixel('), true);
  assert.equal(commonSource.includes('right: snapToDevicePixel('), true);
});

test('common panel style helpers expose a cohesive pink theme palette', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes('const panelThemes: Record<PanelThemeName, PanelPalette> = {'), true);
  assert.equal(source.includes('  pink: {'), true);
  assert.equal(source.includes("primary: '#db2777'"), true);
  assert.equal(source.includes("primarySoft: 'rgba(244, 114, 182, 0.14)'"), true);
  assert.equal(source.includes("surface: '#fffafd'"), true);
  assert.equal(source.includes("surfaceStrong: '#ffffff'"), true);
  assert.equal(source.includes("border: 'rgba(244, 114, 182, 0.24)'"), true);
  assert.equal(source.includes("shadow: '0 8px 20px rgba(190, 24, 93, 0.10)'"), true);
  assert.equal(source.includes("shellGradient: 'linear-gradient(145deg, #fff0f7 0%, #fffafd 48%, #ffecf4 100%)'"), true);
  assert.equal(source.includes("shellShadow: '0 10px 28px rgba(190, 24, 93, 0.16), 0 2px 8px rgba(190, 24, 93, 0.10)'"), true);
});

test('panel themes are palette-driven with a fixed fallback', async () => {
  const source = await readFile(commonPath, 'utf8');
  assert.equal(source.includes("const WINDOWS_PANEL_THEME_KEY = 'common.settings.windows-panel-theme';"), true);
  assert.equal(source.includes('const panelThemes: Record<PanelThemeName, PanelPalette> = {'), true);
  for (const palette of ['  pink: {', '  blue: {', '  green: {']) {
    assert.equal(source.includes(palette), true, palette);
  }
  assert.equal(source.includes('function resolvePanelThemeName(): PanelThemeName'), true);
  assert.equal(source.includes("raw = runtimeStore.get<unknown>(WINDOWS_PANEL_THEME_KEY, 'pink')"), true);
  assert.equal(source.includes('panel.root.dataset.chaoxingPlusTheme = resolvePanelThemeName();'), true);
  assert.equal(source.includes('panelThemes[resolvePanelThemeName()][property as keyof PanelPalette]'), true);
  // 色板之外的硬编码粉色阴影已全部改为 shadowRgb 派生的 panelShadowColor，避免换主题后残留粉色阴影。
  const afterPalette = source.slice(source.indexOf('const panelPinkTheme'));
  for (const stale of ['rgba(190, 24, 93', 'rgba(219, 39, 119', "background = '#fff5fa'"]) {
    assert.equal(afterPalette.includes(stale), false, stale);
  }
});

test('work results panel hero, cards, toggles, and selected items use the pink theme', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const title = createElement('div', { text: '超星学习助手' });"), true);
  assert.equal(source.includes('ChaoXing Plus Pink Console'), false);
  assert.equal(source.includes('hero.style.background = panelPinkTheme.heroGradient;'), true);
  assert.equal(source.includes('hero.style.border = `1px solid ${panelPinkTheme.borderStrong}`;'), true);
  assert.equal(source.includes('hero.style.boxShadow = panelPinkTheme.heroShadow;'), true);
  assert.equal(source.includes('button.style.background = panelPinkTheme.primaryGradient;'), true);
  assert.equal(source.includes('selectedBadge.style.background = panelPinkTheme.primarySoft;'), true);
  assert.equal(source.includes('option.style.border = selected ? `1px solid ${panelPinkTheme.borderStrong}` : `1px solid ${panelPinkTheme.border}`;'), true);
  assert.equal(source.includes('toggle.style.border = checked ? `1px solid ${panelPinkTheme.borderStrong}` : `1px solid ${panelPinkTheme.border}`;'), true);
  assert.equal(source.includes("item.style.borderLeft = index === state.workResults.currentResultIndex ? `4px solid ${panelPinkTheme.primary}` : '4px solid transparent';"), true);
  assert.equal(source.includes("button.style.background = panelPinkTheme.primaryGradient;"), true);
});

test('Windows 端默认折叠面板，扩展保持原有默认展开', async () => {
  const source = await readFile(commonPath, 'utf8');
  const studyStatePath = resolve(scriptsDir, '..', 'src', 'projects', 'study-panel-state.ts');
  const studyStateSource = await readFile(studyStatePath, 'utf8');

  assert.equal(source.includes('function isWindowsHostRuntime()'), true);
  assert.equal(source.includes('__CX_WIN_HOST__'), true);
  assert.equal(source.includes('if (isWindowsHostRuntime()) {'), true);
  assert.equal(source.includes('ui.collapsed = !shellExpandRequested;'), true);
  assert.equal(source.includes('__CX_WIN_SHELL_EXPAND_REQUESTED__'), true);
  assert.equal(source.includes('ui: resolveInitialWorkResultsPanelUiState()'), true);
  // 扩展侧默认状态必须保持展开（否则扩展行为会被 Windows 端改动影响）。
  assert.equal(studyStateSource.includes('collapsed: false'), true);
});

test('Windows 面板只保留考试/答题相关功能，扩展保持完整面板', async () => {
  const source = await readFile(commonPath, 'utf8');

  // 页面可见性：Windows 端只在考试/答题相关页面创建面板。
  assert.equal(source.includes('isWindowsExamRelatedUrl(window.location.href)'), true);

  // Windows 端裁剪学习相关功能（扩展分支必须保留）。
  assert.equal(source.includes('const windowsExamOnly = isWindowsHostRuntime();'), true);
  assert.equal(source.includes("windowsExamOnly ? '考试答题助手' : '答题结果与学习控制'"), true);
  assert.equal(source.includes("windowsExamOnly ? '考试设置' : '学习设置'"), true);
  assert.equal(source.includes("text: isWindowsHostRuntime()"), true);
  assert.equal(source.includes("createSettingsGroup('考试与诊断', '控制考试自动交卷权限。', ['enableExamAutoSubmit'])"), true);
  const normalizedSource = source.replace(/\r\n/g, '\n');
  assert.equal(normalizedSource.includes('if (!windowsExamOnly) {\n    container.append(cacheSection);'), true);

  // 学习相关设置组只能出现在扩展分支，不能进入 Windows 分支。
  const settingsStart = source.indexOf('function createStudySettingsPanel');
  const settingsEnd = source.indexOf('function createTikuAdapterConfigSection', settingsStart);
  assert.notEqual(settingsStart, -1);
  assert.notEqual(settingsEnd, -1);
  const settingsSource = source.slice(settingsStart, settingsEnd);
  const windowsBranchStart = settingsSource.indexOf('if (windowsExamOnly) {');
  assert.notEqual(windowsBranchStart, -1);
  const windowsBranchEnd = settingsSource.indexOf('return container;', windowsBranchStart);
  const windowsBranch = settingsSource.slice(windowsBranchStart, windowsBranchEnd);
  assert.equal(windowsBranch.includes('媒体控制'), false);
  assert.equal(windowsBranch.includes('学习流程'), false);
  assert.equal(windowsBranch.includes('任务能力'), false);
  assert.equal(windowsBranch.includes('enableExamAutoSubmit'), true);
  assert.equal(windowsBranch.includes('AI 搜题'), true);
  assert.equal(windowsBranch.includes('题库缓存'), true);

  // 扩展分支仍保留完整分组，确保扩展行为不变。
  const extensionBranch = settingsSource.slice(windowsBranchEnd);
  assert.equal(extensionBranch.includes('媒体控制'), true);
  assert.equal(extensionBranch.includes('学习流程'), true);
  assert.equal(extensionBranch.includes('任务能力'), true);
});

test('settings, cache, and apps panels are restyled with pink cards and actions', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("createSettingsGroup('考试与诊断', '控制考试自动交卷权限和页面日志窗口。', examAndDebugKeys)"), true);
  assert.equal(source.includes('section.style.background = panelPinkTheme.sectionGradient;'), true);
  assert.equal(source.includes('field.style.background = panelPinkTheme.surfaceStrong;'), true);
  assert.equal(source.includes('panel.root.style.background = panelPinkTheme.shellGradient;'), true);
  assert.equal(source.includes('panel.root.style.border = `1px solid ${panelPinkTheme.borderStrong}`;'), true);
  assert.equal(source.includes('panel.root.style.boxShadow = panelPinkTheme.shellShadow;'), true);
  assert.equal(source.includes('clearButton.style.border = `1px solid ${panelPinkTheme.border}`;'), true);
  assert.equal(source.includes('item.style.background = panelPinkTheme.surfaceStrong;'), true);
});
