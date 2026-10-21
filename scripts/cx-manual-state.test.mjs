import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'cx-manual-state.ts');

async function loadHelperModule() {
  return loadCompiledTypeScriptModule(helperSourcePath, ['cx-manual-state.js', 'projects/cx-manual-state.js']);
}

function createRoot({ checked = false, ariaChecked = false, textareaValue = '', frameText = '', fillText = '', active = false } = {}) {
  return {
    querySelectorAll(selector) {
      if (selector === 'input[type="radio"], input[type="checkbox"], label input') {
        return checked
          ? [
              {
                checked: true,
                getAttribute: () => null
              }
            ]
          : [];
      }

      if (selector === 'textarea') {
        return textareaValue ? [{ value: textareaValue }] : [];
      }

      if (selector === 'iframe') {
        return frameText ? [{ contentDocument: { body: { innerText: frameText } } }] : [];
      }

      if (selector === '.filling_answer, .reading_answer') {
        return fillText ? [{ textContent: fillText }] : [];
      }

      return [];
    },
    querySelector(selector) {
      if (selector === '[aria-checked="true"]') {
        return ariaChecked ? {} : null;
      }

      if (selector === '.line_answer_ct .selectBox [class*="active"]') {
        return active ? {} : null;
      }

      return null;
    }
  };
}

test('automatic completed answers do not become manual just because the DOM is filled', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.resolveManualAnswerState, 'function');
  assert.equal(
    mod.resolveManualAnswerState({
      root: createRoot({ checked: true }),
      type: 'single',
      previousManual: false,
      result: {
        requested: true,
        resolved: true,
        finish: true
      }
    }),
    false
  );
});

test('previous manual state stays true after later automatic updates complete', async () => {
  const mod = await loadHelperModule();

  assert.equal(
    mod.resolveManualAnswerState({
      root: createRoot({ checked: true }),
      type: 'single',
      previousManual: true,
      result: {
        requested: true,
        resolved: true,
        finish: true
      }
    }),
    true
  );
});

test('unfinished filled answers still count as manual intervention before a search happens', async () => {
  const mod = await loadHelperModule();

  assert.equal(
    mod.resolveManualAnswerState({
      root: createRoot({ textareaValue: '人工填写' }),
      type: 'completion',
      previousManual: false,
      result: {
        requested: false,
        resolved: false,
        finish: false
      }
    }),
    true
  );
});

test('requested but unresolved unanswered results do not become manual just because the DOM already has answer widgets', async () => {
  const mod = await loadHelperModule();

  assert.equal(
    mod.resolveManualAnswerState({
      root: createRoot({ fillText: '系统题面残留' }),
      type: 'fill',
      previousManual: false,
      result: {
        requested: true,
        resolved: false,
        finish: false
      }
    }),
    false
  );
});
