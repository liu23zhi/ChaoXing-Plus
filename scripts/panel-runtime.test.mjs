import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const panelRuntimePath = resolve(process.cwd(), 'src', 'runtime', 'panel.ts');

test('panel root creation appends to body with documentElement fallback', async () => {
  const source = await readFile(panelRuntimePath, 'utf8');

  assert.equal(source.includes('(document.body || document.documentElement).appendChild(root);'), true);
});
