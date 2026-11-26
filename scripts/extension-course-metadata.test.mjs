import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
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
