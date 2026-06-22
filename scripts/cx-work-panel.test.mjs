import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cxProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'cx.ts');

test('work script hides its standalone runtime panel so work pages reuse common results panel', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  const workScriptBlock = source.match(/work:\s*\{[\s\S]*?autoRead:\s*\{/);

  assert.notEqual(workScriptBlock, null);
  assert.equal(workScriptBlock[0].includes('hideInPanel: true'), true);
});

test('study clears work results before moving to the next chapter page', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('const resetWorkResults = () => {'), true);
  assert.equal(source.includes('workResultsMethods().clearRuntimeControls?.();'), true);
  assert.equal(source.includes('workResultsMethods().setResults?.([]);'), true);
  assert.equal(source.includes('resetWorkResults();'), true);
});

test('workOrExam uses step-by-step exam selectors and ignores generic type distractors', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes("const workOrExamTitleSelector = !preview_mode"), true);
  assert.equal(source.includes("'.splitS-left .mark_name'"), true);
  assert.equal(source.includes("'.line_wid_half.fl,.line_wid_half.fr'"), true);
  assert.equal(source.includes('function resolveWorkOrExamQuestionTypeRoot('), true);
  assert.equal(source.includes("elements.type.find((element) => element.getAttribute('name')?.match(/type\\d+/))"), true);
  assert.equal(source.includes('resolveWorkOrExamQuestionTypeRoot(elements) ?? elements.options[0]?.closest(\'.questionLi\') ?? document'), true);
});

test('workOrExam applies choice answers with native click before synthetic fallback', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('function isWorkOrExamChoiceChecked('), true);
  assert.equal(source.includes('const checkedBeforeClick = isWorkOrExamChoiceChecked(option);'), true);
  assert.equal(source.includes('option.click();'), true);
  assert.equal(source.includes('checkedAfterNativeClick = isWorkOrExamChoiceChecked(option);'), true);
  assert.equal(source.includes('triggerSyntheticClick(option);'), true);
  assert.equal(source.includes('作业/考试选项应用诊断'), true);
});
