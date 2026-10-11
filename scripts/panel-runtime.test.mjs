import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const panelRuntimePath = resolve(scriptsDir, '..', 'src', 'runtime', 'panel.ts');
const modalRuntimePath = resolve(scriptsDir, '..', 'src', 'runtime', 'message.ts');
const commonProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'common.ts');
const cxProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'cx.ts');

function normalize(source) {
  return source.replace(/\r\n/g, '\n');
}

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
  const source = normalize(await readFile(modalRuntimePath, 'utf8'));

  assert.equal(source.includes("const swalStyleId = 'chaoxing-plus-swal-style-reset';"), true);
  assert.equal(source.includes("host.style.fontSize = '16px';"), true);
  assert.equal(source.includes("target.style.fontSize = '16px';"), true);
  assert.equal(source.includes('#${swalTargetId} .swal2-container {'), true);
  assert.equal(source.includes('#${swalTargetId} .swal2-popup {'), true);
  assert.equal(source.includes('font-size: 16px !important;'), true);
  assert.equal(source.includes('--swal2-container-padding: 10px;'), true);
  assert.equal(source.includes('--swal2-border-radius: 5px;'), true);
});

test('modal alerts claim the top z-index and the last paint slot so they cover the floating panels', async () => {
  const modalSource = normalize(await readFile(modalRuntimePath, 'utf8'));
  const panelSource = normalize(await readFile(panelRuntimePath, 'utf8'));
  const commonSource = normalize(await readFile(commonProjectPath, 'utf8'));
  const cxSource = normalize(await readFile(cxProjectPath, 'utf8'));

  const modalZIndex = Number(modalSource.match(/const swalContainerZIndex = (\d+);/)?.[1]);
  assert.equal(Number.isInteger(modalZIndex), true);
  assert.equal(modalSource.includes('z-index: ${swalContainerZIndex} !important;'), true);

  const raisedZIndexes = [panelSource, commonSource, cxSource].flatMap((source) =>
    [...source.matchAll(/\.style\.zIndex = '(\d+)'/g)].map((match) => Number(match[1]))
  );

  assert.notEqual(raisedZIndexes.length, 0);
  // 面板必须严格低于弹窗层级，最高位 2147483647 只留给弹窗。
  assert.equal(raisedZIndexes.filter((value) => value >= modalZIndex).length, 0);
  assert.equal(modalZIndex, 2147483647);

  // 兜底：页面自身也占用最高 z-index 时，弹窗宿主保持最后绘制。
  assert.equal(modalSource.includes('function pinSwalHostToPaintTop(targetDocument: Document, host: HTMLElement) {'), true);
  assert.equal(modalSource.includes('const parent = targetDocument.body || targetDocument.documentElement;'), true);
  assert.equal(modalSource.includes('if (parent && parent.lastElementChild !== host) {'), true);
  assert.equal(modalSource.includes('parent.appendChild(host);'), true);
  assert.equal(modalSource.includes('pinSwalHostToPaintTop(targetDocument, host);'), true);
});
