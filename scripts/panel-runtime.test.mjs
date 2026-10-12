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

test('modal alerts route Swal calls through the top window when available', async () => {
  const source = await readFile(modalRuntimePath, 'utf8');

  assert.equal(source.includes('function getTopWindowSwal()'), true);
  assert.equal(source.includes('const runtimeSwal = getTopWindowSwal();'), true);
  assert.equal(source.includes('return runtimeSwal.fire({'), true);
});

test('modal runtime creates a safe Swal target in the top document before firing', async () => {
  const source = await readFile(modalRuntimePath, 'utf8');

  assert.equal(source.includes("const swalHostId = 'chaoxing-plus-swal-host';"), true);
  assert.equal(source.includes('function getOrCreateSwalTarget()'), true);
  assert.equal(source.includes("host = targetDocument.createElement('div');"), true);
  assert.equal(source.includes('host.attachShadow({ mode: ' + "'open'" + ' });'), true);
  assert.equal(source.includes("target.id = swalTargetId;"), true);
  assert.equal(source.includes('(targetDocument.body || targetDocument.documentElement).appendChild(host);'), true);
  assert.equal(source.includes('target: getOrCreateSwalTarget()'), true);
  assert.equal(source.includes("const host = topDocument?.getElementById('chaoxing-plus-swal-host');"), false);
});
