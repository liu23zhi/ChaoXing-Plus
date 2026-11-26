import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

test('ordinary packaged browser gate stops the real task, synchronous, AI and evidence entry points before fetch', async () => {
  const old = { window: globalThis.window, document: globalThis.document, chrome: globalThis.chrome, online: globalThis.navigator, fetch: globalThis.fetch };
  const events = new EventTarget();
  const requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: events });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.__CXPLUS_BROWSER_AGREEMENT_GATE__ = true;
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, method: opts.method });
    return Response.json({ success: true, data: { taskId: 't1' } });
  };
  try {
    const { requestTikuAdapterSearchTask, createTikuAdapterAnswererWrapper, requestTikuAdapterAIFallback, requestTikuAdapterAnswerEvidence } =
      await loadCompiledTypeScriptModule('src/projects/tiku-adapter-config.ts');
    const config = { baseurl: 'https://tiku.fixture.test', key: 'fixture-key', asyncSearch: false };
    const wrapper = createTikuAdapterAnswererWrapper(config);
    let allowed = false;
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
      runtime: { id: 'owned-fixture', sendMessage: async () => ({ allowed }) }
    } });
    await assert.rejects(requestTikuAdapterSearchTask(config, {}), /阅读并同意/);
    await assert.rejects(wrapper.executeRequest({ data: {}, timeoutMs: 500 }), /阅读并同意/);
    await assert.rejects(requestTikuAdapterAIFallback(config, { title: 'fixture' }), /阅读并同意/);
    await assert.rejects(requestTikuAdapterAnswerEvidence(config, { title: 'fixture', evidence: {} }), /阅读并同意/);
    assert.equal(requests.length, 0);
    allowed = true;
    await wrapper.executeRequest({ data: {}, timeoutMs: 500 });
    assert.deepEqual(requests, [{ url: config.baseurl + '/api/search', method: 'POST' }]);
    globalThis.__CXPLUS_BROWSER_AGREEMENT_GATE__ = false;
    allowed = false;
    await wrapper.executeRequest({ data: {}, timeoutMs: 500 });
    assert.equal(requests.length, 2, 'the injected non-extension build does not participate');
  } finally {
    delete globalThis.__CXPLUS_BROWSER_AGREEMENT_GATE__;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: old.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: old.document });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: old.online });
    globalThis.fetch = old.fetch;
    if (old.chrome) Object.defineProperty(globalThis, 'chrome', { configurable: true, value: old.chrome });
    else delete globalThis.chrome;
  }
});

test('packaging uses the same consent renderer for the MV3 target pages and the internal install page', async () => {
  const build = await readFile('build.mjs', 'utf8');
  const worker = await readFile('src/extension-worker.js', 'utf8');
  const html = await readFile('src/extension-agreement.html', 'utf8');
  assert.match(build, /['"]extension-agreement-view\.js['"].*['"]extension-agreement-content\.js['"]/s);
  assert.match(worker, /registerAgreement/);
  assert.match(html, /extension-agreement-view\.js/);
  assert.match(html, /extension-agreement-content\.js/);
});

test('ordinary answer application and final save/submit revalidate even if work started before an update', async () => {
  const source = await readFile('src/projects/cx.ts', 'utf8');
  const chapter = source.slice(source.indexOf('  async chapter('), source.indexOf('function getWorkOrExamTitleSelector'));
  assert.match(chapter, /work: async \(ctx\) => \{\s*await requireTikuWorkAgreement\(\)/);
  assert.match(chapter, /const performChapterAction = async[^]*?await requireTikuWorkAgreement\(\)[^]*?checkChapterTask\(\)/);
  assert.match(chapter, /const saveChapter = async[^]*?await requireTikuWorkAgreement\(\)[^]*?resolveChapterAction\('noSubmit'\)/);
  const homework = source.slice(source.indexOf('  const createWorkOrExamWorker ='), source.indexOf('  async function retryUnfinishedWorkOrExamQuestionAtIndex'));
  assert.match(homework, /work: async \(ctx\) => \{\s*await requireTikuWorkAgreement\(\)/);
  assert.match(source, /await waitForTabAnswerContinue\(\);\s*await requireTikuWorkAgreement\(\);\s*if \(shouldSubmit\)/);
});
