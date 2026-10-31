import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

const cxPath = resolve(process.cwd(), 'src', 'projects', 'cx.ts');

async function loadCxFunction(name, context) {
  if (name === 'invokeChapterActionWithExpiryCapture') {
    await loadCxFunction('isChapterSubmissionFailure', context);
    context.observeChapterSubmission ??= () => ({ async wait() {}, restore() {} });
    context.dismissChapterSubmissionDialog ??= () => {};
    context.setTimeout ??= setTimeout;
    context.clearTimeout ??= clearTimeout;
  }
  const source = await readFile(cxPath, 'utf8');
  const parsed = ts.createSourceFile(cxPath, source, ts.ScriptTarget.Latest, true);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      declaration = node.getText(parsed);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(declaration, `Expected ${name} function in cx.ts`);
  const code = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInContext(code, context);
  return context[name];
}

function documentWithStatus(text) {
  if (text === undefined) {
    return {
      querySelectorAll() { return []; },
      querySelector() { return null; }
    };
  }

  const deadline = { innerText: text.split('（')[0], textContent: text.split('（')[0] };
  const statusText = text.includes('已截止，不能作答') ? '（已截止，不能作答）' : undefined;
  const status = statusText ? { innerText: statusText, textContent: statusText } : undefined;
  const statusBlock = {
    querySelectorAll(selector) {
      if (selector === 'span') return [deadline, ...(status ? [status] : [])];
      if (selector.includes('.orangeColor') || selector.includes('.testTit_status')) {
        return status ? [status] : [];
      }
      return [];
    }
  };
  const ceyanName = {
    querySelectorAll(selector) {
      if (selector === 'p') return [statusBlock];
      if (selector === 'span') return [deadline, ...(status ? [status] : [])];
      if (selector.includes('.orangeColor') || selector.includes('.testTit_status')) {
        return status ? [status] : [];
      }
      return [];
    }
  };
  return {
    querySelectorAll(selector) {
      if (selector.includes('.ceyan_name')) return [ceyanName];
      return [];
    },
    querySelector(selector) {
      return selector.includes('.newTestCon') ? {} : null;
    }
  };
}

test('chapter expiry marker is detected without treating a normal deadline as expired', async () => {
  const context = vm.createContext({});
  await loadCxFunction('isExpiredChapterMessage', context);
  const isChapterTestExpired = await loadCxFunction('isChapterTestExpired', context);

  assert.equal(isChapterTestExpired(documentWithStatus('截止时间: 2026-10-12 18:41:00（已截止，不能作答）')), true);
  assert.equal(isChapterTestExpired(documentWithStatus('截止时间: 2026-12-12 18:41:00')), false);
  assert.equal(isChapterTestExpired(documentWithStatus('章节测验 已截止，不能作答')), false);
  assert.equal(isChapterTestExpired(documentWithStatus(undefined)), false);
});

test('chapter expiry message detection covers native expiry dialogs', async () => {
  const context = vm.createContext({});
  await loadCxFunction('isExpiredChapterText', context);
  await loadCxFunction('isExpiredChapterResponse', context);
  const isExpiredChapterMessage = await loadCxFunction('isExpiredChapterMessage', context);

  assert.equal(isExpiredChapterMessage('作业已过期'), true);
  assert.equal(isExpiredChapterMessage('已截止，不能作答'), true);
  assert.equal(isExpiredChapterMessage('登录已过期'), false);
  assert.equal(isExpiredChapterMessage('提交成功'), false);
});

test('chapter expiry response detection accepts wrapped JSON failure responses without broad text matches', async () => {
  const context = vm.createContext({});
  await loadCxFunction('isExpiredChapterText', context);
  const isExpiredChapterResponse = await loadCxFunction('isExpiredChapterResponse', context);

  assert.equal(isExpiredChapterResponse({ msg: '此作业已过期！', status: false }), true);
  assert.equal(isExpiredChapterResponse('{"data":{"msg":" 此作业已过期！ ","status":"false"}}'), true);
  assert.equal(isExpiredChapterResponse({ responseText: '{"result":{"message":"已截止，不能作答","status":0}}' }), true);
  assert.equal(isExpiredChapterResponse({ msg: '登录已过期', status: false }), false);
  assert.equal(isExpiredChapterResponse({ msg: '此作业已过期！', status: true }), false);
  assert.equal(isExpiredChapterResponse('{"msg":"此作业已过期！","status":true}'), false);
  assert.equal(isExpiredChapterResponse([{ error: { message: '此作业已过期！', status: ' failed ' } }]), true);
  assert.equal(isExpiredChapterResponse({ data: { error: { errMsg: '此作业已过期!', success: 'false' } } }), true);
  assert.equal(isExpiredChapterResponse({ msg: '提交成功', status: false }), false);
  assert.equal(isExpiredChapterResponse({ status: true, data: { msg: '此作业已过期！' } }), false);
  assert.equal(isExpiredChapterResponse({ success: 'true', error: { status: false, msg: '此作业已过期！' } }), false);
});

test('native expiry dialog capture suppresses the expired alert and restores page handlers', async () => {
  const context = vm.createContext({});
  await loadCxFunction('isExpiredChapterText', context);
  await loadCxFunction('isExpiredChapterResponse', context);
  await loadCxFunction('isExpiredChapterMessage', context);
  await loadCxFunction('isChapterTestExpired', context);
  const invokeChapterActionWithExpiryCapture = await loadCxFunction('invokeChapterActionWithExpiryCapture', context);
  const frameDocument = { querySelectorAll() { return []; } };
  const originalAlert = () => { throw new Error('expired alert should be captured'); };
  const originalConfirm = () => { throw new Error('expired confirm should be captured'); };
  const frameWindow = { alert: originalAlert, confirm: originalConfirm };

  assert.equal(
    await invokeChapterActionWithExpiryCapture(frameWindow, frameDocument, () => frameWindow.alert('作业已过期')),
    true
  );
  assert.equal(frameWindow.alert, originalAlert);
  assert.equal(frameWindow.confirm, originalConfirm);
});

for (const message of ['无效的参数: code-1!', ' \n无效的参数：\u3000code-1！\n ']) {
  test(`submission parameter failures preserve code-1 despite spacing: ${JSON.stringify(message)}`, async () => {
    const context = vm.createContext({});
    await loadCxFunction('isExpiredChapterText', context);
    await loadCxFunction('isExpiredChapterResponse', context);
    await loadCxFunction('isExpiredChapterMessage', context);
    const invoke = await loadCxFunction('invokeChapterActionWithExpiryCapture', context);
    let nativeAlerts = 0;
    const frameWindow = { alert() { nativeAlerts++; }, confirm() { return true; } };
    const originalAlert = frameWindow.alert;
    await assert.rejects(invoke(frameWindow, {}, () => frameWindow.alert(message), 0, { phase: 'open-confirmation' }), /参数校验失败.*code-1/);
    assert.equal(nativeAlerts, 0);
    assert.equal(frameWindow.alert, originalAlert);
  });
}

test('native expiry capture handles a response returned from a submit action', async () => {
  const context = vm.createContext({});
  await loadCxFunction('isExpiredChapterText', context);
  await loadCxFunction('isExpiredChapterResponse', context);
  await loadCxFunction('isExpiredChapterMessage', context);
  await loadCxFunction('isChapterTestExpired', context);
  const invokeChapterActionWithExpiryCapture = await loadCxFunction('invokeChapterActionWithExpiryCapture', context);
  const frameDocument = { querySelectorAll() { return []; } };
  const frameWindow = { alert() {}, confirm() { return true; } };

  assert.equal(
    await invokeChapterActionWithExpiryCapture(
      frameWindow,
      frameDocument,
      () => Promise.resolve('{"payload":{"msg":"此作业已过期！","status":false}}')
    ),
    true
  );
});

test('native expiry capture classifies rejected expiry responses but propagates other submit errors', async () => {
  const context = vm.createContext({});
  await loadCxFunction('isExpiredChapterText', context);
  await loadCxFunction('isExpiredChapterResponse', context);
  await loadCxFunction('isExpiredChapterMessage', context);
  await loadCxFunction('isChapterTestExpired', context);
  const invokeChapterActionWithExpiryCapture = await loadCxFunction('invokeChapterActionWithExpiryCapture', context);
  const frameDocument = { querySelectorAll() { return []; } };
  const frameWindow = { alert() {}, confirm() { return true; } };

  assert.equal(
    await invokeChapterActionWithExpiryCapture(
      frameWindow,
      frameDocument,
      () => Promise.reject({ data: { msg: '此作业已过期！', status: false } })
    ),
    true
  );
  await assert.rejects(
    invokeChapterActionWithExpiryCapture(
      frameWindow,
      frameDocument,
      () => Promise.reject(new Error('network failure'))
    ),
    /network failure/u
  );
});

test('chapter answering checks expiry before processing questions and before submission', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.match(source, /const expired = isChapterTestExpired\(frameDocument\)/u);
  assert.match(source, /return \{ finished: true, expired: true, staticExpired: true \};/u);
  assert.match(source, /if \(!allowStaticExpiryFallback && isChapterTestExpired\(frameDocument\)\)/u);
  assert.match(source, /if \(!allowStaticExpiryFallback && isChapterTestExpired\(frameDocument\)\)[\s\S]*?btnBlueSubmit/u);
});

test('expired chapter jobs are skipped for the current scan so other task points can continue', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.match(source, /expired\?: boolean;/u);
  assert.match(source, /staticExpired\?: boolean;/u);
  assert.match(source, /terminalExpired\?: boolean;/u);
  assert.match(source, /const maxSubmissionAttempts = 1 \+ getUnfinishedQuestionRetryAttempts\(\);/u);
  assert.match(source, /const alreadySearchedJob = searchedJobs\.find\(\(job\) => job\.jobId === String\(targetJobId\)\);/u);
  assert.match(source, /if \(alreadySearchedJob\?\.expired\) \{[\s\S]*?visibleContentState: 'finished-job'/u);
  assert.match(source, /job\.expired = true;/u);
  assert.match(source, /chooseNextDeferredChapterTask/u);
  assert.match(source, /markDeferredChapterAttempt\(deferredContext\.state/u);
  assert.match(source, /allowStaticExpiryFallback/u);
  assert.match(source, /job\.func\(true\)/u);
  assert.match(source, /recordChapterDeferral/u);
  assert.match(source, /getNextUninspectedChapterTab/u);
});

test('expired chapter submission captures native alert and confirm messages before abandoning the task', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.match(source, /isExpiredChapterMessage\(message\)/u);
  assert.match(source, /actionWindow\.alert =/u);
  assert.match(source, /actionWindow\.confirm =/u);
  assert.match(source, /ancestor = ancestor\.parent/u);
  assert.match(source, /addActionWindow\(topWindow\)/u);
  assert.match(source, /chapterExpired = true;/u);
});

