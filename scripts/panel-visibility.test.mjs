import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const helperModulePath = resolve(process.cwd(), '.tmp-tests', 'panel-visibility.js');

async function loadPanelVisibilityModule() {
  try {
    return await import(pathToFileURL(helperModulePath).href);
  } catch {
    return {};
  }
}

test('floating panel stays hidden in deeply nested iframes so only the outermost page owns it', async () => {
  const mod = await loadPanelVisibilityModule();

  assert.equal(typeof mod.shouldShowFloatingPanel, 'function');
  assert.equal(
    mod.shouldShowFloatingPanel({
      selfWindow: {},
      topWindow: {},
      parentWindow: {}
    }),
    false
  );
});

test('floating panel remains visible in top window', async () => {
  const mod = await loadPanelVisibilityModule();
  const topWindow = {};

  assert.equal(typeof mod.shouldShowFloatingPanel, 'function');
  assert.equal(
    mod.shouldShowFloatingPanel({
      selfWindow: topWindow,
      topWindow,
      parentWindow: topWindow
    }),
    true
  );
});
