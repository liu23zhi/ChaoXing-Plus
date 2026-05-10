import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const panelRuntimePath = resolve(process.cwd(), 'src', 'runtime', 'panel.ts');
const modalRuntimePath = resolve(process.cwd(), 'src', 'runtime', 'message.ts');

test('panel root creation claims a top-window lock before appending', async () => {
  const source = await readFile(panelRuntimePath, 'utf8');

  assert.equal(source.includes('function claimTopWindowPanelOwnership()'), true);
  assert.equal(source.includes('topRoot.dataset.chaoxingPlusPanelOwner = ownerFrameHref;'), true);
  assert.equal(source.includes('if (ownerFrameHref !== window.location.href) {'), true);
  assert.equal(source.includes("root.dataset.chaoxingPlusLockedOut = 'true';"), true);
});

test('panel root creation appends to body with documentElement fallback', async () => {
  const source = await readFile(panelRuntimePath, 'utf8');

  assert.equal(source.includes('(document.body || document.documentElement).appendChild(root);'), true);
});

test('modal alerts route Swal calls through an isolated extension alias instead of page window.Swal', async () => {
  const source = await readFile(modalRuntimePath, 'utf8');

  assert.equal(source.includes('const swalAliasKey = \'__chaoxing_plus_swal__\';'), true);
  assert.equal(source.includes('return ownerWindow[swalAliasKey] as typeof Swal;'), true);
  assert.equal(source.includes('topWindow?.Swal && typeof topWindow.Swal.fire === \'function\''), false);
  assert.equal(source.includes('const runtimeSwal = getTopWindowSwal();'), true);
  assert.equal(source.includes("const result = await runtimeSwal.fire({ icon: 'info', text: content, confirmButtonText: '知道了'"), true);
});
