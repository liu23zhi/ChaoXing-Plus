import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from '@typescript/typescript6';
import { registerDeepThinking } from '../src/extension-deep-thinking-worker.js';
import { DEEP_THINKING_KIND, readDeepThinkingState } from '../src/extension-deep-thinking.js';

const legacy = 'cx.new.study.deepThinking';
const oldOptions = 'common.settings.work-options';
const enabled = 'deepThinkingEnabled';
const prompted = 'hasPromptedDeepThinking';
const view = 'agreement.view.v1';
const ext = 'extension';
const target = { id: ext, frameId: 0, tab: { id: 1 }, url: 'https://owned.chaoxing.com:123/settings' };

test('strict booleans distinguish old defaults, effective legacy true, explicit false and corrupt pairs', () => {
  for (const [raw, active, done] of [
    [{}, false, false],
    [{ [legacy]: false }, false, false],
    [{ [legacy]: true }, true, false],
    [{ [legacy]: false, [oldOptions]: { deepThinking: true } }, false, false],
    [{ [oldOptions]: { deepThinking: true } }, true, false],
    [{ [oldOptions]: { deepThinking: 'true' } }, false, false],
    [{ [legacy]: 'true', [oldOptions]: { deepThinking: true } }, false, false],
    [{ [enabled]: true }, false, false],
    [{ [enabled]: 'false', [prompted]: true }, false, false],
    [{ [enabled]: true, [prompted]: 'true', [legacy]: true }, false, false],
    [{ [prompted]: true, [legacy]: true }, false, false],
    [{ [enabled]: true, [prompted]: true, [legacy]: false }, true, true],
    [{ [enabled]: false, [prompted]: true, [legacy]: true }, false, true]
  ]) assert.deepEqual(readDeepThinkingState(raw), { enabled: active, prompted: done });
});

test('worker serializes fresh choices, applies one atomic write, protects later switch and retries failures', async () => {
  const values = { [view]: { phase: 'pending' } };
  const writes = [];
  let onMessage;
  let failRead = false;
  let failWrite = false;
  const chrome = {
    runtime: { id: ext, onMessage: { addListener(listener) { onMessage = listener; } } },
    storage: { local: {
      async get(keys) {
        if (failRead) { failRead = false; throw Error('owned read failure'); }
        return Object.fromEntries(keys.map(key => [key, values[key]]));
      },
      async set(patch) {
        if (failWrite) { failWrite = false; throw Error('owned write failure'); }
        writes.push(patch);
        Object.assign(values, patch);
      }
    } }
  };
  bind();
  function bind() { registerDeepThinking(chrome); }
  const send = (message, sender = target) => new Promise(resolve => {
    const handled = onMessage({ kind: DEEP_THINKING_KIND, ...message }, sender, resolve);
    if (!handled) resolve(undefined);
  });
  const choice = value => ({ operation: 'choose', enabled: value });
  const change = (value, expected) => ({ operation: 'change', enabled: value, expected });
  for (const sender of [
    { ...target, id: 'external' }, { ...target, frameId: 1 },
    { ...target, url: 'https://owned.chaoxing.com.other/' },
    { ...target, url: 'https://other.test/?next=https://chaoxing.com/' },
    { ...target, url: 'about:blank' }, { ...target, tab: undefined }
  ]) assert.equal(await send(choice(true), sender), undefined);
  assert.equal(await send(choice('true')), undefined);
  assert.equal(await send({ operation: 'change', enabled: true }), undefined);
  assert.deepEqual(await send(choice(true)), { saved: false });

  values[view].phase = 'accepted';
  values['common.settings.device-instance'] = 'owned-host-marker';
  assert.deepEqual(await send(choice(true)), { saved: false });
  delete values['common.settings.device-instance'];
  values['common.settings.extension-enabled'] = false;
  assert.deepEqual(await send(choice(true)), { saved: false });
  delete values['common.settings.extension-enabled'];
  failRead = true;
  assert.deepEqual(await send(choice(true)), { saved: false });
  failWrite = true;
  assert.deepEqual(await send(choice(true)), { saved: false });
  assert.deepEqual(writes, []);
  assert.equal(Object.hasOwn(values, prompted), false);
  assert.deepEqual(await send(change(true, false)), { saved: false });

  assert.deepEqual(await Promise.all([send(choice(false)), send(choice(true), { ...target, tab: { id: 2 } })]),
    [{ saved: true }, { saved: true }]); // both receive confirmed state, only the first choice writes
  assert.deepEqual(writes, [{ [enabled]: false, [prompted]: true, [legacy]: false }]);
  bind(); // MV3 worker restarted; durable choice still wins over a stale prompt.
  await send(choice(true));
  assert.equal(writes.length, 1);
  assert.deepEqual(await send(change(true, true)), { saved: false }, 'stale panel switch cannot revert another tab');
  assert.deepEqual(await send(change(true, false)), { saved: true });
  assert.deepEqual(writes[1], { [enabled]: true, [prompted]: true, [legacy]: true });
});

test('actual getWorkOptions consumes the same canonical ordinary preference as the production control', () => {
  const src = readFileSync(new URL('../src/projects/common.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('common.ts', src, ts.ScriptTarget.Latest, true);
  const getWorkOptions = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getWorkOptions');
  assert.ok(getWorkOptions);
  const code = ts.transpileModule(getWorkOptions.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let useBrowser = true;
  let state = readDeepThinkingState();
  let old = false;
  let oldFallback = true;
  const dependencies = {
    runtimeStore: { get: (key, fallback) => key === oldOptions ? { deepThinking: oldFallback, thread: 1 } : fallback },
    WORK_OPTIONS_KEY: oldOptions, defaultWorkOptions: {}, getStoredTikuAdapterConfig: () => ({}),
    DEFAULT_TIKU_BASE_URL: 'https://owned.invalid',
    resolveTikuAdapterBaseUrl: (_value, fallback) => fallback, getTikuAdapterConfigProblem: () => true,
    getStudySettingValue: (key, fallback) => key === 'deepThinking' ? old ?? fallback : fallback,
    usesBrowserAgreementGate: () => useBrowser, browserDeepThinkingEnabled: () => state.enabled
  };
  const read = Function(...Object.keys(dependencies), code + '\nreturn getWorkOptions;')(...Object.values(dependencies));
  assert.equal(read().deepThinking, false);
  state = readDeepThinkingState({ [enabled]: true, [prompted]: true, [legacy]: false });
  assert.equal(read().deepThinking, true);
  state = readDeepThinkingState({ [enabled]: false, [prompted]: true, [legacy]: true });
  old = true;
  assert.equal(read().deepThinking, false);
  useBrowser = false;
  assert.equal(read().deepThinking, true);
  old = false;
  assert.equal(read().deepThinking, false);
  old = undefined;
  assert.equal(read().deepThinking, true);
  oldFallback = false;
  assert.equal(read().deepThinking, false);
});
