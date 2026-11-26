import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('disabled packaged content script evaluates without reading the document or installing business listeners', async () => {
  const source = await readFile('dist/chaoxing-plus.js', 'utf8');
  let touched = 0;
  const context = {
    __CXPLUS_EXTENSION_BOOT__: Promise.resolve(false),
    get document() { touched++; throw new Error('business module evaluated while off'); },
    get HTMLElement() { touched++; throw new Error('business module evaluated while off'); },
    get window() { touched++; throw new Error('business module evaluated while off'); }
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(touched, 0);
});
