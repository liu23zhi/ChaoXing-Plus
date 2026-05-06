import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const cxProjectPath = resolve(process.cwd(), 'src', 'projects', 'cx.ts');

test('work script hides its standalone runtime panel so work pages reuse common results panel', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  const workScriptBlock = source.match(/work:\s*\{[\s\S]*?autoRead:\s*\{/);

  assert.notEqual(workScriptBlock, null);
  assert.equal(workScriptBlock[0].includes('hideInPanel: true'), true);
});
