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
