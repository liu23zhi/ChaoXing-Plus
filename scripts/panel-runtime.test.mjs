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

test('modal alerts prefer top-window SweetAlert runtime and keep target in that same document', async () => {
  const source = await readFile(modalRuntimePath, 'utf8');

  assert.equal(source.includes("const swalAliasKey = '__chaoxing_plus_swal__';"), true);
  assert.equal(source.includes('function getSwalRuntime()'), true);
  assert.equal(source.includes('const topWindow = window.top as SwalOwnerWindow | null;'), true);
  assert.equal(source.includes('const runtimeSwal = topWindow?.[swalAliasKey];'), true);
  assert.equal(source.includes("return { runtimeSwal: runtimeSwal as typeof Swal, targetDocument: topDocument }"), true);
  assert.equal(source.includes('const { runtimeSwal, targetDocument } = getSwalRuntime();'), true);
  assert.equal(source.includes('target: getOrCreateSwalTarget(targetDocument)'), true);
  assert.equal(source.includes('return { runtimeSwal: Swal, targetDocument: document };'), true);
  assert.equal(source.includes('return Swal.fire({'), false);
});
