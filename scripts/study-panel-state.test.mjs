import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'study-panel-state.ts');
const commonProjectPath = resolve(process.cwd(), 'src', 'projects', 'common.ts');

async function loadStudyPanelStateModule() {
  return loadCompiledTypeScriptModule(helperSourcePath, ['study-panel-state.js', 'projects/study-panel-state.js']);
}

test('answer automation defaults to enabled', async () => {
  const mod = await loadStudyPanelStateModule();

  assert.equal(typeof mod.resolveStudyAutomationFlags, 'function');
  assert.equal(mod.resolveStudyAutomationFlags({}).enableAnswer, true);
});

test('global answer switch disables chapter test answering', async () => {
  const mod = await loadStudyPanelStateModule();

  assert.equal(typeof mod.resolveStudyAutomationFlags, 'function');
  assert.equal(
    mod.resolveStudyAutomationFlags({ enableAnswer: false, enableChapterTest: true }).canAnswerChapterTest,
    false
  );
});

test('task capability summary counts enabled capabilities with true defaults', async () => {
  const mod = await loadStudyPanelStateModule();

  assert.equal(typeof mod.countEnabledStudyTaskCapabilities, 'function');
  assert.equal(
    mod.countEnabledStudyTaskCapabilities(
      { enablePPT: false, enableHyperlink: false },
      ['enableMedia', 'enablePPT', 'enableChapterTest', 'enableHyperlink', 'notifyWhenHasFaceRecognition']
    ),
    3
  );
});

test('task capability summary uses enabled-count wording in study settings panel', async () => {
  const mod = await loadStudyPanelStateModule();

  assert.equal(typeof mod.formatEnabledStudyTaskCapabilitySummary, 'function');
  assert.equal(
    mod.formatEnabledStudyTaskCapabilitySummary(
      { enablePPT: false, enableHyperlink: false },
      ['enableMedia', 'enablePPT', 'enableChapterTest', 'enableHyperlink', 'notifyWhenHasFaceRecognition']
    ),
    '已开启3 项'
  );
});

test('work results panel starts expanded and toggles collapse state in memory', async () => {
  const mod = await loadStudyPanelStateModule();

  assert.equal(typeof mod.createDefaultWorkResultsPanelUiState, 'function');
  assert.equal(typeof mod.toggleWorkResultsPanelCollapsed, 'function');

  const uiState = mod.createDefaultWorkResultsPanelUiState();
  assert.equal(uiState.collapsed, false);
  assert.equal(mod.toggleWorkResultsPanelCollapsed(uiState.collapsed), true);
  assert.equal(mod.toggleWorkResultsPanelCollapsed(true), false);
});
