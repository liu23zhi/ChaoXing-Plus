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
  assert.equal(source.includes("root.style.background = 'linear-gradient(145deg, rgba(255, 240, 247, 0.98) 0%, rgba(255, 250, 253, 0.96) 48%, rgba(255, 236, 244, 0.98) 100%)';"), true);
  assert.equal(source.includes("root.style.border = '1px solid rgba(244, 114, 182, 0.30)';"), true);
  assert.equal(source.includes("root.style.boxShadow = '0 24px 70px rgba(190, 24, 93, 0.20), 0 8px 24px rgba(251, 113, 133, 0.14)';"), true);
  assert.equal(source.includes("root.style.borderRadius = '24px';"), true);
});

test('common panel style helpers expose a cohesive pink theme palette', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes('const panelPinkTheme = {'), true);
  assert.equal(source.includes("primary: '#db2777'"), true);
  assert.equal(source.includes("primarySoft: 'rgba(244, 114, 182, 0.14)'"), true);
  assert.equal(source.includes("surface: 'rgba(255, 250, 253, 0.92)'"), true);
  assert.equal(source.includes("border: 'rgba(244, 114, 182, 0.24)'"), true);
  assert.equal(source.includes("shadow: '0 18px 48px rgba(190, 24, 93, 0.12)'"), true);
});

test('work results panel hero, cards, toggles, and selected items use the pink theme', async () => {
  const source = await readFile(commonPath, 'utf8');

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
