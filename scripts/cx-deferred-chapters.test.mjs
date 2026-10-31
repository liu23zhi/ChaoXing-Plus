import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const source = await readFile(resolve('src/projects/cx-deferred-chapters.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const {
  createChapterDeferredState,
  readChapterDeferredState,
  recordChapterDeferral,
  markChapterTabInspected,
  getNextUninspectedChapterTab,
  chooseNextDeferredChapterTask,
  markDeferredChapterAttempt,
  markDeferredChapterResult,
  markDeferredChapterMissing
} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('static deferral does not count as answering and survives a JSON round trip', () => {
  const state = createChapterDeferredState('course:class:chapter');
  const task = recordChapterDeferral(state, 'tab-1', 'work-1');
  assert.equal(task.attempts, 0);
  assert.equal(task.state, 'deferred');
  assert.equal(task.terminalExpired, false);
  assert.equal(task.missingVisits, 0);
  assert.deepEqual(readChapterDeferredState(JSON.stringify(state), state.scope), state);
});

test('scope changes and invalid storage create an independent clean chapter state', () => {
  const oldState = createChapterDeferredState('course:class:chapter-1');
  recordChapterDeferral(oldState, 'tab', 'work');
  assert.deepEqual(readChapterDeferredState(oldState, 'course:class:chapter-2'), createChapterDeferredState('course:class:chapter-2'));
  assert.deepEqual(readChapterDeferredState('{broken', 'scope'), createChapterDeferredState('scope'));
});

test('normal tasks in every tab are inspected before the first deferred task is chosen', () => {
  const state = createChapterDeferredState('scope');
  recordChapterDeferral(state, 'tab-1', 'expired');
  markChapterTabInspected(state, 'tab-1');
  assert.equal(getNextUninspectedChapterTab(state, ['tab-1', 'tab-2', 'tab-3']), 'tab-2');
  assert.equal(chooseNextDeferredChapterTask(state, ['tab-1', 'tab-2', 'tab-3'], 3), undefined);
  assert.equal(state.phase, 'scan');
  markChapterTabInspected(state, 'tab-2');
  markChapterTabInspected(state, 'tab-3');
  assert.equal(chooseNextDeferredChapterTask(state, ['tab-1', 'tab-2', 'tab-3'], 3)?.jobId, 'expired');
  assert.equal(state.phase, 'retry');
});

test('forward tab selection never wraps to an earlier uninspected tab', () => {
  const state = createChapterDeferredState('scope');
  markChapterTabInspected(state, 'tab-2');
  assert.equal(getNextUninspectedChapterTab(state, ['tab-1', 'tab-2', 'tab-3'], 'tab-2'), 'tab-3');
  markChapterTabInspected(state, 'tab-3');
  assert.equal(getNextUninspectedChapterTab(state, ['tab-1', 'tab-2', 'tab-3'], 'tab-3'), undefined);
  assert.equal(getNextUninspectedChapterTab(state, ['tab-1', 'tab-2', 'tab-3'], 'removed-tab'), undefined);
});

test('saved and disabled results remain paused without using an answer attempt', () => {
  for (const disposition of ['saved', 'disabled', 'not-ready']) {
    const state = createChapterDeferredState('scope');
    const task = recordChapterDeferral(state, 'tab', 'job');
    markChapterTabInspected(state, 'tab');
    markDeferredChapterAttempt(state, 'tab', 'job', 3);
    markDeferredChapterResult(state, 'tab', 'job', { disposition }, 3);
    assert.equal(task.state, 'deferred');
    assert.equal(task.pauseReason, disposition);
    assert.equal(task.attempts, 0);
    assert.equal(chooseNextDeferredChapterTask(state, ['tab'], 3), undefined);
    assert.notEqual(state.phase, 'settled');
    assert.equal(Object.values(readChapterDeferredState(JSON.stringify(state), 'scope').tasks)[0].pauseReason, disposition);
  }
});

test('deferred tasks are selected by tab order and retain task insertion order within a tab', () => {
  const state = createChapterDeferredState('scope');
  const later = recordChapterDeferral(state, 'tab-2', 'later');
  const first = recordChapterDeferral(state, 'tab-1', 'first');
  const second = recordChapterDeferral(state, 'tab-1', 'second');
  markChapterTabInspected(state, 'tab-1');
  markChapterTabInspected(state, 'tab-2');
  assert.equal(chooseNextDeferredChapterTask(state, ['tab-1', 'tab-2'], 3), first);
  markDeferredChapterResult(state, first.tabKey, first.jobId, { finished: true }, 3);
  assert.equal(chooseNextDeferredChapterTask(state, ['tab-1', 'tab-2'], 3), second);
  markDeferredChapterResult(state, second.tabKey, second.jobId, { finished: true }, 3);
  assert.equal(chooseNextDeferredChapterTask(state, ['tab-1', 'tab-2'], 3), later);
});

test('attempt limits are configurable and independent for every job', () => {
  const state = createChapterDeferredState('scope');
  const first = recordChapterDeferral(state, 'tab', 'first');
  const second = recordChapterDeferral(state, 'tab', 'second');
  assert.equal(markDeferredChapterAttempt(state, 'tab', 'first', 2), true);
  markDeferredChapterResult(state, 'tab', 'first', { finished: false }, 2);
  assert.equal(first.state, 'deferred');
  assert.equal(markDeferredChapterAttempt(state, 'tab', 'first', 2), true);
  markDeferredChapterResult(state, 'tab', 'first', { finished: false }, 2);
  assert.equal(first.state, 'abandoned');
  assert.equal(markDeferredChapterAttempt(state, 'tab', 'first', 2), false);
  assert.equal(first.attempts, 2);
  assert.equal(second.attempts, 0);
  assert.equal(markDeferredChapterAttempt(state, 'tab', 'second', 5), true);
});

test('a native expiry response abandons only its own task immediately and cannot be reset by deferral', () => {
  const state = createChapterDeferredState('scope');
  const terminal = recordChapterDeferral(state, 'tab-1', 'same-work');
  const sibling = recordChapterDeferral(state, 'tab-2', 'same-work');
  assert.equal(markDeferredChapterAttempt(state, terminal.tabKey, terminal.jobId, 3), true);
  markDeferredChapterResult(state, terminal.tabKey, terminal.jobId, { terminalExpired: true }, 3);
  assert.equal(terminal.terminalExpired, true);
  assert.equal(terminal.state, 'abandoned');
  assert.equal(recordChapterDeferral(state, terminal.tabKey, terminal.jobId), terminal);
  assert.equal(markDeferredChapterAttempt(state, terminal.tabKey, terminal.jobId, 3), false);
  assert.equal(sibling.state, 'deferred');
  assert.equal(sibling.attempts, 0);
});

test('manual cancellation releases the reserved attempt and leaves the task deferred', () => {
  const state = createChapterDeferredState('scope');
  const task = recordChapterDeferral(state, 'tab', 'work');
  assert.equal(markDeferredChapterAttempt(state, 'tab', 'work', 3), true);
  markDeferredChapterResult(state, 'tab', 'work', { manual: true }, 3);
  assert.equal(task.attempts, 0);
  assert.equal(task.state, 'deferred');
});

test('missing tasks stop after the configured visits without consuming answer attempts', () => {
  const state = createChapterDeferredState('scope');
  const missing = recordChapterDeferral(state, 'tab', 'missing');
  assert.equal(markDeferredChapterMissing(state, 'tab', 'missing', 2), false);
  assert.equal(missing.state, 'deferred');
  assert.equal(markDeferredChapterMissing(state, 'tab', 'missing', 2), true);
  assert.equal(missing.state, 'abandoned');
  assert.equal(missing.attempts, 0);
  assert.equal(missing.missingVisits, 2);
});

test('a successful attempt clears missing visits and settles a completed chapter', () => {
  const state = createChapterDeferredState('scope');
  const task = recordChapterDeferral(state, 'tab', 'work');
  markChapterTabInspected(state, 'tab');
  markDeferredChapterMissing(state, 'tab', 'work', 3);
  markDeferredChapterAttempt(state, 'tab', 'work', 3);
  assert.equal(task.missingVisits, 0);
  markDeferredChapterResult(state, 'tab', 'work', { finished: true }, 3);
  assert.equal(chooseNextDeferredChapterTask(state, ['tab'], 3), undefined);
  assert.equal(state.phase, 'settled');
  assert.equal(recordChapterDeferral(state, 'tab', 'work').state, 'complete');
});

test('task keys cannot collide when tab and job IDs contain separators', () => {
  const state = createChapterDeferredState('scope');
  assert.notEqual(recordChapterDeferral(state, 'a:b', 'c'), recordChapterDeferral(state, 'a', 'b:c'));
  assert.equal(Object.keys(state.tasks).length, 2);
});

test('storage normalization rejects invalid records and preserves terminal decisions', () => {
  const state = readChapterDeferredState({
    scope: 'scope', phase: 'invalid', inspectedTabs: ['tab', 'tab', 42],
    tasks: {
      arbitrary: { tabKey: 'tab', jobId: 'work', attempts: -1, state: 'deferred', terminalExpired: true, missingVisits: 1.5 },
      bad: { tabKey: '', jobId: 'broken' }
    }
  }, 'scope');
  assert.deepEqual(state.inspectedTabs, ['tab']);
  assert.equal(state.phase, 'scan');
  assert.equal(Object.keys(state.tasks).length, 1);
  const task = Object.values(state.tasks)[0];
  assert.equal(task.attempts, 0);
  assert.equal(task.missingVisits, 1);
  assert.equal(task.state, 'abandoned');
});

test('zero retry budget abandons pending tasks without starting work', () => {
  const state = createChapterDeferredState('scope');
  const task = recordChapterDeferral(state, 'tab', 'work');
  assert.equal(markDeferredChapterAttempt(state, 'tab', 'work', 0), false);
  assert.equal(task.attempts, 0);
  assert.equal(task.state, 'abandoned');
});

test('recreating the page between attempts cannot reset the three-attempt budget', () => {
  let state = createChapterDeferredState('scope');
  recordChapterDeferral(state, 'tab', 'work');
  markChapterTabInspected(state, 'tab');
  let starts = 0;
  for (let visit = 0; visit < 6; visit += 1) {
    state = readChapterDeferredState(JSON.stringify(state), 'scope');
    const task = chooseNextDeferredChapterTask(state, ['tab'], 3);
    if (task && markDeferredChapterAttempt(state, task.tabKey, task.jobId, 3)) {
      starts += 1;
      markDeferredChapterResult(state, task.tabKey, task.jobId, { finished: false }, 3);
    }
  }
  assert.equal(starts, 3);
  assert.equal(Object.values(state.tasks)[0].state, 'abandoned');
  assert.equal(state.phase, 'settled');
});

test('recreating the page preserves terminal expiry and leaves other pending tasks selectable', () => {
  const original = createChapterDeferredState('scope');
  recordChapterDeferral(original, 'tab-1', 'expired');
  recordChapterDeferral(original, 'tab-2', 'pending');
  markChapterTabInspected(original, 'tab-1');
  markChapterTabInspected(original, 'tab-2');
  markDeferredChapterAttempt(original, 'tab-1', 'expired', 3);
  markDeferredChapterResult(original, 'tab-1', 'expired', { terminalExpired: true }, 3);
  const restored = readChapterDeferredState(JSON.stringify(original), 'scope');
  assert.equal(markDeferredChapterAttempt(restored, 'tab-1', 'expired', 3), false);
  assert.equal(chooseNextDeferredChapterTask(restored, ['tab-1', 'tab-2'], 3)?.jobId, 'pending');
});
