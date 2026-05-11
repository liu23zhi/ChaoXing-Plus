import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const panelRuntimePath = resolve(scriptsDir, '..', 'src', 'runtime', 'panel.ts');
const modalRuntimePath = resolve(scriptsDir, '..', 'src', 'runtime', 'message.ts');

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

test('modal alerts inject a SweetAlert style reset so page rem scaling does not distort popup layout', async () => {
  const source = await readFile(modalRuntimePath, 'utf8');

  assert.equal(source.includes("const swalStyleId = 'chaoxing-plus-swal-style-reset';"), true);
  assert.equal(source.includes("host.style.fontSize = '16px';"), true);
  assert.equal(source.includes("target.style.fontSize = '16px';"), true);
  assert.equal(source.includes('#${swalTargetId} .swal2-container {'), true);
  assert.equal(source.includes('#${swalTargetId} .swal2-popup {'), true);
  assert.equal(source.includes('font-size: 16px !important;'), true);
  assert.equal(source.includes('--swal2-container-padding: 10px;'), true);
  assert.equal(source.includes('--swal2-border-radius: 5px;'), true);
});
