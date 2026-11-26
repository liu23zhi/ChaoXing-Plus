import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

test('the ordinary projection exposes only bounded attachment labels and identifiers from the current cards document', async () => {
  const script = await readFile('src/extension-course-metadata.js', 'utf8');
  const { readOrdinaryCourseAttachments } = await loadCompiledTypeScriptModule('src/runtime/ordinary-course-attachments.ts');
  const stub = new EventTarget();
  const window = { attachments: [
    { jobid: 'owned-card', job: true, isPassed: false, privateFixtureField: 'do not copy', property: { name: 'Owned audiovisual card', mid: 'asset-1', extra: 'do not copy' } },
    { jobid: 'invalid identifier', job: true },
    { jobid: 'duplicate.ok', job: false, property: { name: '<owned> display' } },
    { jobid: 'duplicate.ok', job: true },
    ...Array.from({ length: 100 }, (_, index) => ({ jobid: 'bounded-' + index, property: { name: 'x'.repeat(400) } }))
  ] };
  vm.runInNewContext(script, { window, document: stub, location: { pathname: '/knowledge/cards' }, Event, CustomEvent });
  const hints = readOrdinaryCourseAttachments(stub);
  assert.equal(hints.length <= 64, true);
  assert.deepEqual(hints.slice(0, 2), [
    { jobid: 'owned-card', job: true, isPassed: false, property: { mid: 'asset-1', _jobid: '', name: 'Owned audiovisual card' } },
    { jobid: 'duplicate.ok', job: false, isPassed: undefined, property: { mid: '', _jobid: '', name: 'owned display' } }
  ]);
  assert.equal(JSON.stringify(hints).includes('do not copy'), false);

  const unrelatedPage = new EventTarget();
  vm.runInNewContext(script, { window, document: unrelatedPage, location: { pathname: '/unrelated' }, Event, CustomEvent });
  assert.deepEqual(readOrdinaryCourseAttachments(unrelatedPage), []);
});


test('the real ordinary waiter re-reads the same attachments live status, not the first copy or another item', async () => {
  const [src, cx] = await Promise.all([readFile('src/extension-course-metadata.js', 'utf8'), readFile('src/projects/cx.ts', 'utf8')]);
  const { readOrdinaryCourseAttachments } = await loadCompiledTypeScriptModule('src/runtime/ordinary-course-attachments.ts');
  const cards = new EventTarget();
  const entry = { jobid: 'original', job: true, isPassed: false, property: { name: 'Inert ordinary card' } };
  const unrelated = { jobid: 'other', job: false, isPassed: true, property: {} };
  const main = { attachments: [entry, unrelated] };
  vm.runInNewContext(src, { window: main, document: cards, location: { pathname: '/knowledge/cards' }, Event, CustomEvent });
  const original = readOrdinaryCourseAttachments(cards)[0];
  const names = new Set(['isAttachmentFinished', 'readAttachmentCompletionObservation', 'waitForAttachmentComplete']);
  const ast = ts.createSourceFile('cx.ts', cx, ts.ScriptTarget.Latest, true);
  const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
    .map(node => node.getText(ast)).join(String.fromCharCode(10));
  let now = 0;
  const sandbox = {
    Date: class extends Date { static now() { return now; } },
    usesBrowserAgreementGate: () => true,
    readCurrentCourseAttachments: () => readOrdinaryCourseAttachments(cards),
    async sleep(ms) {
      now += ms;
      // Missing job metadata isn't an affirmative state. The other item remains finished.
      main.attachments[0] = now === 1 ? { ...entry, job: undefined } : { ...entry, job: false };
    }
  };
  vm.runInNewContext(ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  let confirmation;
  assert.equal(await sandbox.waitForAttachmentComplete(original, 3, 1, value => { confirmation = value; }), true);
  assert.equal(now, 2, 'only the positively changed status of the same attachment can finish');
  assert.equal(original.job, true);
  assert.deepEqual({ id: confirmation.jobid, job: confirmation.job }, { id: 'original', job: false });

  sandbox.usesBrowserAgreementGate = () => false;
  sandbox.readCurrentCourseAttachments = () => { throw new Error('Native does not read the browser projection'); };
  sandbox.sleep = async ms => { now += ms; entry.isPassed = true; };
  assert.equal(await sandbox.waitForAttachmentComplete(entry, 3, 1), true, 'the original Native object still observes in-place changes');
});
