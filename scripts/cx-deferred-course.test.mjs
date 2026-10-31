import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from '@typescript/typescript6';

const source = await readFile('src/projects/cx-deferred-course.ts', 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const { createCourseDeferredState, readCourseDeferredState, markCourseChapterInspected, chooseCourseDeferredAction } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const scope = JSON.stringify(['course-1', 'class-1']);
const chapters = (counts = [1, 1, 1, 1]) => counts.map((unFinishCount, index) => ({ id: `chapter-${index + 1}`, unFinishCount }));
const deferred = (state = 'deferred', phase = 'retry') => ({
  phase,
  tasks: { task: { tabKey: 'tab-1', jobId: 'job-1', attempts: 0, state, terminalExpired: false, missingVisits: 0 } }
});

test('new course state is JSON serializable and read restores normalized chapter order and inspection', () => {
  const state = createCourseDeferredState(scope);
  markCourseChapterInspected(state, 'chapter-1');
  markCourseChapterInspected(state, 'chapter-1');
  chooseCourseDeferredAction(state, 'chapter-1', chapters(), {});
  assert.deepEqual(readCourseDeferredState(JSON.stringify(state), scope), state);
  assert.deepEqual(state.inspectedChapters, ['chapter-1']);
  assert.deepEqual(state.chapterIds, ['chapter-1', 'chapter-2', 'chapter-3', 'chapter-4']);
});

test('invalid storage, invalid fields, and another course or class cannot reuse inspected state', () => {
  const clean = createCourseDeferredState(scope);
  for (const value of [null, [], '{broken', 4, { scope: 'another-course', phase: 'settled', inspectedChapters: ['chapter-1'] }]) {
    assert.deepEqual(readCourseDeferredState(value, scope), clean);
  }
  const normalized = readCourseDeferredState({
    scope, phase: 'unknown', chapterIds: ['chapter-1', 'chapter-1', '', 4],
    inspectedChapters: ['chapter-2', 'chapter-2', null, '']
  }, scope);
  assert.deepEqual(normalized, { scope, phase: 'scan', chapterIds: ['chapter-1'], inspectedChapters: ['chapter-2'] });
  assert.deepEqual(readCourseDeferredState({ ...normalized, scope: JSON.stringify(['course-1', 'class-2']) }, scope), clean);
});

test('a static expired-only current chapter waits until another unfinished normal chapter is inspected', () => {
  const state = createCourseDeferredState(scope);
  markCourseChapterInspected(state, 'chapter-1');
  const progress = { 'chapter-1': deferred() };
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-1', chapters([1, 1]), progress), { type: 'scan', chapterId: 'chapter-2' });
  assert.equal(state.phase, 'scan');
  markCourseChapterInspected(state, 'chapter-2');
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-2', chapters([1, 0]), progress), { type: 'retry', chapterId: 'chapter-1' });
  assert.equal(state.phase, 'retry');
});

test('starting in the middle scans later chapters before wrapping to earlier unfinished chapters', () => {
  const state = createCourseDeferredState(scope);
  markCourseChapterInspected(state, 'chapter-2');
  const progress = { 'chapter-2': deferred() };
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-2', chapters(), progress), { type: 'scan', chapterId: 'chapter-3' });
  markCourseChapterInspected(state, 'chapter-3');
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-3', chapters(), progress), { type: 'scan', chapterId: 'chapter-4' });
  markCourseChapterInspected(state, 'chapter-4');
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-4', chapters(), progress), { type: 'scan', chapterId: 'chapter-1' });
  markCourseChapterInspected(state, 'chapter-1');
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-1', chapters(), progress), { type: 'retry', chapterId: 'chapter-2' });
});

test('completed chapters are skipped without falsely marking an uninspected unfinished chapter', () => {
  const state = createCourseDeferredState(scope);
  markCourseChapterInspected(state, 'chapter-2');
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-2', chapters([0, 1, 0, 1]), {}), { type: 'scan', chapterId: 'chapter-4' });
  assert.deepEqual(state.inspectedChapters, ['chapter-2']);
});

test('normal scanning of every unfinished chapter precedes all deferred chapters', () => {
  const state = createCourseDeferredState(scope);
  markCourseChapterInspected(state, 'chapter-2');
  const progress = { 'chapter-2': deferred(), 'chapter-4': deferred() };
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-2', chapters(), progress), { type: 'scan', chapterId: 'chapter-3' });
  markCourseChapterInspected(state, 'chapter-3');
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-3', chapters(), progress), { type: 'scan', chapterId: 'chapter-1' });
  markCourseChapterInspected(state, 'chapter-1');
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-1', chapters(), progress), { type: 'retry', chapterId: 'chapter-2' });
});

test('retry selection follows DOM chapter order rather than the current chapter or ledger insertion order', () => {
  const state = createCourseDeferredState(scope);
  for (const chapter of chapters()) markCourseChapterInspected(state, chapter.id);
  const progress = { 'chapter-4': deferred(), 'chapter-2': deferred(), 'chapter-1': deferred('complete') };
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-4', chapters(), progress), { type: 'retry', chapterId: 'chapter-2' });
  progress['chapter-2'].tasks.task.state = 'abandoned';
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-2', chapters(), progress), { type: 'retry', chapterId: 'chapter-4' });
});

test('settled and abandoned chapter ledgers cannot restart normal scanning even if the UI remains unfinished', () => {
  const state = createCourseDeferredState(scope);
  const progress = { 'chapter-1': deferred('abandoned', 'settled'), 'chapter-2': deferred('complete', 'settled') };
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-2', chapters([1, 1]), progress), { type: 'settled' });
  assert.equal(state.phase, 'settled');
  assert.deepEqual(chooseCourseDeferredAction(readCourseDeferredState(JSON.stringify(state), scope), 'chapter-1', chapters([1, 1]), progress), { type: 'settled' });
});

test('a partially inspected chapter in scan phase still needs its ordinary tabs inspected', () => {
  const state = createCourseDeferredState(scope);
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-2', chapters([1, 0]), { 'chapter-1': deferred('abandoned', 'scan') }), {
    type: 'scan', chapterId: 'chapter-1'
  });
});

test('terminal expiry flags are never scheduled for retry even in a stale deferred task state', () => {
  const state = createCourseDeferredState(scope);
  const terminal = deferred();
  terminal.tasks.task.terminalExpired = true;
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-1', chapters([1]), { 'chapter-1': terminal }), { type: 'settled' });
});

test('chapter retry attempts and task states are left untouched by course scheduling', () => {
  const state = createCourseDeferredState(scope);
  const progress = { 'chapter-1': deferred() };
  progress['chapter-1'].tasks.task.attempts = 2;
  const previous = JSON.stringify(progress);
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-2', chapters([1, 0]), progress), { type: 'retry', chapterId: 'chapter-1' });
  assert.equal(JSON.stringify(progress), previous);
});

test('missing current chapter falls back to the active DOM chapter then scans the following chapter', () => {
  const state = createCourseDeferredState(scope);
  const available = chapters();
  available[1].active = true;
  assert.deepEqual(chooseCourseDeferredAction(state, 'missing', available, {}), { type: 'scan', chapterId: 'chapter-3' });
  available[1].active = false;
  assert.deepEqual(chooseCourseDeferredAction(state, 'missing', available, {}), { type: 'scan', chapterId: 'chapter-1' });
});

test('duplicate and empty DOM chapter ids are ignored and unavailable stale ledgers are never navigated to', () => {
  const state = createCourseDeferredState(scope);
  const available = [{ id: '', unFinishCount: 1 }, ...chapters([0, 0]), { id: 'chapter-1', unFinishCount: 1 }];
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-1', available, { removed: deferred() }), { type: 'settled' });
  assert.deepEqual(state.chapterIds, ['chapter-1', 'chapter-2']);
});

test('a newly available unfinished chapter resumes normal scanning after the course was settled', () => {
  const state = readCourseDeferredState({ scope, phase: 'settled', inspectedChapters: ['chapter-1'] }, scope);
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-1', chapters([1, 1]), {}), { type: 'scan', chapterId: 'chapter-2' });
  assert.equal(state.phase, 'scan');
});

test('empty directories block retry and a ready zero-count chapter can still be reconciled', () => {
  const state = createCourseDeferredState(scope);
  assert.deepEqual(chooseCourseDeferredAction(state, '', [], {}), { type: 'blocked', reason: 'directory-not-ready' });
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-1', chapters([0]), { 'chapter-1': deferred() }), { type: 'retry', chapterId: 'chapter-1' });
});

test('next never wraps ordinary scanning to a previous chapter', () => {
  const state = createCourseDeferredState(scope);
  markCourseChapterInspected(state, 'chapter-2');
  markCourseChapterInspected(state, 'chapter-3');
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-3', chapters([1, 1, 0]), {
    'chapter-2': deferred()
  }, 'next'), { type: 'blocked', reason: 'earlier-normal-work' });
});

test('an increased normal signature invalidates inspection while preserving terminal tasks', () => {
  const state = createCourseDeferredState(scope);
  const available = chapters([1, 1]);
  available[0].normalSignature = '1';
  markCourseChapterInspected(state, 'chapter-1', available[0].normalSignature);
  const progress = { 'chapter-1': deferred('abandoned', 'settled') };
  available[0].normalSignature = '2';
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-2', available, progress), { type: 'scan', chapterId: 'chapter-1' });
  assert.equal(progress['chapter-1'].tasks.task.state, 'abandoned');
});

test('only paused jobs keep the course paused rather than settled', () => {
  const state = createCourseDeferredState(scope);
  markCourseChapterInspected(state, 'chapter-1');
  const progress = { 'chapter-1': deferred() };
  progress['chapter-1'].tasks.task.pauseReason = 'saved';
  assert.deepEqual(chooseCourseDeferredAction(state, 'chapter-1', chapters([1]), progress), { type: 'paused' });
  assert.notEqual(state.phase, 'settled');
});
