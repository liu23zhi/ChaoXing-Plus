import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const panelRuntimePath = resolve(scriptsDir, '..', 'src', 'runtime', 'panel.ts');
const modalRuntimePath = resolve(scriptsDir, '..', 'src', 'runtime', 'message.ts');
const commonProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'common.ts');
const cxProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'cx.ts');

function normalize(source) {
  return source.replace(/\r\n/g, '\n');
}

function createModalDocument() {
  const style = { id: 'chaoxing-plus-swal-style-reset' };
  const host = { id: 'chaoxing-plus-swal-host', style: {} };
  const target = { id: 'chaoxing-plus-swal-target', style: {} };
  const elements = new Map([[style.id, style], [host.id, host], [target.id, target]]);
  const body = {
    lastElementChild: host,
    appendChild(element) {
      elements.set(element.id, element);
      this.lastElementChild = element;
    }
  };

  return {
    body,
    documentElement: { appendChild: body.appendChild.bind(body) },
    getElementById: (id) => elements.get(id),
    target
  };
}

async function loadModalRuntime(window, document, swal) {
  const source = await readFile(modalRuntimePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
  const module = { exports: {} };
  window.document = document;
  document.defaultView = window;
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (id) => {
      assert.equal(id, 'sweetalert2');
      return swal;
    },
    window,
    document,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });

  vm.runInContext(compiled, context);
  return module.exports.$modal;
}

function createFramePair({ crossOrigin = false } = {}) {
  const topListeners = new Set();
  const childListeners = new Set();
  const dispatch = (listeners, event) => queueMicrotask(() => {
    for (const listener of listeners) listener(event);
  });
  const topWindow = {
    top: undefined,
    self: undefined,
    location: { origin: 'https://a.chaoxing.com' },
    addEventListener: (type, listener) => type === 'message' && topListeners.add(listener),
    removeEventListener: (type, listener) => type === 'message' && topListeners.delete(listener)
  };
  const childWindow = {
    top: undefined,
    self: undefined,
    addEventListener: (type, listener) => type === 'message' && childListeners.add(listener),
    removeEventListener: (type, listener) => type === 'message' && childListeners.delete(listener)
  };
  const childSource = {
    top: topWindow,
    postMessage(data) {
      dispatch(childListeners, { data, source: childWindow.top, origin: 'https://a.chaoxing.com' });
    }
  };
  const childTop = {
    postMessage(data) {
      dispatch(topListeners, { data, source: childSource, origin: 'https://b.chaoxing.com' });
    }
  };

  topWindow.top = topWindow;
  topWindow.self = topWindow;
  topWindow.postMessage = childTop.postMessage;
  childWindow.top = crossOrigin ? childTop : topWindow;
  childWindow.self = childWindow;
  if (crossOrigin) {
    Object.defineProperty(childTop, 'document', {
      get() { throw new DOMException('Blocked by same-origin policy', 'SecurityError'); }
    });
  }

  return { topWindow, childWindow };
}

function createSwal() {
  const calls = [];
  function runtime() {}
  runtime.DismissReason = { timer: 'timer' };
  runtime.fire = (options) => {
    calls.push(options);
    return Promise.resolve({ isConfirmed: true, isDenied: false, isDismissed: false });
  };
  return {
    calls,
    runtime
  };
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

test('nested same-origin alerts target the top document while the top Swal alias is unavailable', async () => {
  const { topWindow, childWindow } = createFramePair();
  const topDocument = createModalDocument();
  const childDocument = createModalDocument();
  const topSwal = createSwal();
  const childSwal = createSwal();

  await loadModalRuntime(topWindow, topDocument, topSwal.runtime);
  const childModal = await loadModalRuntime(childWindow, childDocument, childSwal.runtime);
  await childModal.alert('nested same-origin alert');

  const calls = [...topSwal.calls, ...childSwal.calls];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, topDocument.target);
});

test('nested alerts reuse a callable top Swal runtime without initializing in the child realm', async () => {
  const { topWindow, childWindow } = createFramePair();
  const topDocument = createModalDocument();
  const childDocument = createModalDocument();
  const topSwal = createSwal();
  const childSwal = createSwal();
  topWindow.document = topDocument;
  topWindow.__chaoxing_plus_swal__ = topSwal.runtime;

  const childModal = await loadModalRuntime(childWindow, childDocument, childSwal.runtime);
  await childModal.alert('callable top runtime');

  assert.equal(topSwal.calls.length, 1);
  assert.equal(topSwal.calls[0].target, topDocument.target);
  assert.equal(childSwal.calls.length, 0);
});

test('nested cross-origin alerts wait for the top runtime and render in the top document', async () => {
  const { topWindow, childWindow } = createFramePair({ crossOrigin: true });
  const topDocument = createModalDocument();
  const childDocument = createModalDocument();
  const topSwal = createSwal();
  const childSwal = createSwal();
  const childModal = await loadModalRuntime(childWindow, childDocument, childSwal.runtime);
  const alertPromise = childModal.alert('nested cross-origin alert');

  await new Promise((resolve) => setTimeout(resolve, 50));
  await loadModalRuntime(topWindow, topDocument, topSwal.runtime);
  await alertPromise;

  assert.equal(topSwal.calls.length, 1);
  assert.equal(topSwal.calls[0].text, 'nested cross-origin alert');
  assert.equal(topSwal.calls[0].target, topDocument.target);
  assert.equal(childSwal.calls.length, 0);
});
