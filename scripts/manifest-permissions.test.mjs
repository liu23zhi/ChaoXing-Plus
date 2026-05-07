import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifestPath = resolve(process.cwd(), 'dist', 'manifest.json');

test('manifest declares storage permission for shared tiku config sync', async () => {
  const source = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(source);

  assert.deepEqual(manifest.permissions, ['storage']);
});
