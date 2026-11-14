// tiku-adapter-error.ts 的错误分类与作用域边界。
//
// 这些断言盯的是**分类本身**：同一个 HTTP 401 可能表示钱包余额不足、Key 额度耗尽或普通鉴权失败，
// 三者在界面上是三条不同的引导（充值 / 调整额度 / 重新登录），所以不能靠状态码猜测。
// 另外余额阻断是按「baseurl + key」隔离的，作用域算错会让另一个 Key 被连坐。
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// 直接加载 src 的 .ts 源码（而不是影子 .js），口径与构建产物一致。
register('./ci/ts-source-hooks.mjs', import.meta.url);
const errors = await import('../src/core/utils/tiku-adapter-error.js');

test('wallet balance, key quota and generic auth failures stay three distinct codes', () => {
  const wallet = errors.createTikuAdapterRequestError({ errCode: 401, detail: '当前余额不足，系统题库已禁用' }, 401);
  assert.equal(wallet.code, 'INSUFFICIENT_BALANCE');
  assert.match(wallet.message, /余额不足/u);

  const quota = errors.createTikuAdapterRequestError({ error: { code: 'access_token_quota_exceeded' } }, 401);
  assert.equal(quota.code, 'ACCESS_TOKEN_QUOTA_EXCEEDED', '机器码大小写不该改变分类');
  assert.match(quota.message, /额度/u);
  assert.doesNotMatch(quota.message, /充值|余额|登录/u, '额度耗尽不能引导成充值或重新登录');

  // 普通鉴权失败：状态码 401 但没有任何余额证据，必须留在 UPSTREAM_ERROR。
  const plain = errors.createTikuAdapterRequestError({ errCode: 401, message: '访问令牌鉴权失败' }, 401);
  assert.equal(plain.code, 'UPSTREAM_ERROR');
  assert.equal(plain.status, 401);
  assert.match(plain.message, /服务器内部错误/u);
});

test('balance detection requires the wallet wording, never a bare 401 or upstream credits', () => {
  // 上游自己的 "insufficient credits" 是上游计费，不是本系统钱包。
  assert.equal(errors.isTikuAdapterInsufficientBalance({ detail: 'upstream insufficient credits' }, 401), false);
  // 文案对但状态码不是 401，不算钱包问题。
  assert.equal(errors.isTikuAdapterInsufficientBalance({ detail: '当前余额不足' }, 500), false);
  // 字符串载荷（旧服务端返回纯文本）也要按 401 + 文案判定。
  assert.equal(errors.isTikuAdapterInsufficientBalance('当前余额不足，请充值', 401), true);
  assert.equal(errors.isTikuAdapterInsufficientBalance('当前余额不足，请充值', 402), false);
  // 非对象、空值、null 都不能炸。
  for (const value of [undefined, null, '', 0, false, []]) {
    assert.equal(errors.isTikuAdapterInsufficientBalance(value, 401), false, `value=${String(value)}`);
  }
});

test('quota detection never fires on non-object payloads or unrelated codes', () => {
  assert.equal(errors.isTikuAdapterQuotaExceeded('ACCESS_TOKEN_QUOTA_EXCEEDED'), false, '字符串载荷不采信');
  assert.equal(errors.isTikuAdapterQuotaExceeded({ code: 'INSUFFICIENT_BALANCE' }), false);
  assert.equal(errors.isTikuAdapterQuotaExceeded({ error: { code: '  ACCESS_TOKEN_QUOTA_EXCEEDED  ' } }), true, '码值两端空白要容忍');
  for (const value of [undefined, null, 0, '']) {
    assert.equal(errors.isTikuAdapterQuotaExceeded(value), false);
  }
});

test('adapter url detection and identity extraction reject malformed input instead of throwing', () => {
  assert.equal(errors.isTikuAdapterRequestUrl('https://adapter.test/api/search'), true);
  assert.equal(errors.isTikuAdapterRequestUrl('https://adapter.test/search'), false);
  assert.equal(errors.isTikuAdapterRequestUrl('not a url'), false);

  // 前缀之后的路径段被剥掉，baseurl 只保留到前缀之前（前缀本身不进 baseurl）。
  const identity = errors.resolveTikuAdapterRequestIdentity('https://adapter.test/api/search', {
    authorization: 'Bearer  test-key  '
  });
  assert.deepEqual(identity, { baseurl: 'https://adapter.test', key: 'test-key' }, 'Bearer 前缀与两端空白都该剥掉');

  // 旧前缀同样要能识别（2026-11-14 改名后保留了四个搜索接口的兼容）。
  assert.equal(errors.isTikuAdapterRequestUrl('https://adapter.test/adapter-service/search'), true,
    '旧前缀 /adapter-service 仍须被识别为适配器请求');
  assert.deepEqual(
    errors.resolveTikuAdapterRequestIdentity('https://adapter.test/adapter-service/search/tasks', {}),
    { baseurl: 'https://adapter.test', key: '' },
    '旧前缀的路径段也应被剥掉',
  );

  const noKey = errors.resolveTikuAdapterRequestIdentity('https://adapter.test/api/search', {});
  assert.deepEqual(noKey, { baseurl: 'https://adapter.test', key: '' });

  assert.deepEqual(errors.resolveTikuAdapterRequestIdentity('::::'), { baseurl: '', key: '' }, '非法 URL 返回空身份，不抛');
});

test('balance blocking is scoped to one baseurl and key, and recovers only for that scope', () => {
  const baseurl = 'https://scope-a.adapter.test';
  assert.equal(errors.isTikuAdapterBalanceBlocked(baseurl, 'key-1'), false);

  errors.markTikuAdapterBalanceBlocked(baseurl, 'key-1');
  assert.equal(errors.isTikuAdapterBalanceBlocked(baseurl, 'key-1'), true);
  assert.equal(errors.isTikuAdapterBalanceBlocked(baseurl, 'key-2'), false, '另一个 Key 不得被连坐');
  assert.equal(errors.isTikuAdapterBalanceBlocked('https://scope-b.adapter.test', 'key-1'), false, '另一个站点不得被连坐');
  // 尾斜杠与大小写不该造出新的作用域。
  assert.equal(errors.isTikuAdapterBalanceBlocked(`${baseurl}/`, 'key-1'), true);

  errors.resetTikuAdapterBalanceGuard(baseurl, 'key-1');
  assert.equal(errors.isTikuAdapterBalanceBlocked(baseurl, 'key-1'), false);

  // 空作用域永远不登记，避免把空配置当成一个共享黑名单。
  errors.markTikuAdapterBalanceBlocked('', '');
  assert.equal(errors.isTikuAdapterBalanceBlocked('', ''), false);
  errors.resetTikuAdapterBalanceGuard('', '');
  assert.equal(errors.isTikuAdapterBalanceBlocked('', 'key-1'), false);
});

test('balance notice is claimed once per scope so retries cannot stack dialogs', () => {
  const baseurl = 'https://notice.adapter.test';
  assert.equal(errors.claimTikuAdapterBalanceNotice(baseurl, 'key'), true);
  assert.equal(errors.claimTikuAdapterBalanceNotice(baseurl, 'key'), false, '同一作用域只提示一次');
  assert.equal(errors.claimTikuAdapterBalanceNotice('', ''), false, '空作用域不提示');

  errors.resetTikuAdapterBalanceGuard(baseurl, 'key');
  assert.equal(errors.claimTikuAdapterBalanceNotice(baseurl, 'key'), true, '重置后可以再次提示');
  errors.resetTikuAdapterBalanceGuard(baseurl, 'key');
});

test('answer presence needs real content, not just an answer object', () => {
  assert.equal(errors.hasTikuAdapterAnswer({ answer: { answerKeyText: 'A' } }), true);
  assert.equal(errors.hasTikuAdapterAnswer({ answer: { answerText: '  ' } }), false, '空白答案不算有答案');
  assert.equal(errors.hasTikuAdapterAnswer({ answer: { answerIndex: [0] } }), true, '索引 0 是合法答案');
  assert.equal(errors.hasTikuAdapterAnswer({ answer: { bestAnswer: ['B'] } }), true);
  assert.equal(errors.hasTikuAdapterAnswer({ answer: { allAnswer: [['A'], []] } }), true);
  assert.equal(errors.hasTikuAdapterAnswer({ answer: { allAnswer: [[], []] } }), false);
  for (const value of [undefined, null, 'answer', 42, {}, { answer: null }, { answer: 'A' }]) {
    assert.equal(errors.hasTikuAdapterAnswer(value), false, `value=${JSON.stringify(value) ?? String(value)}`);
  }
});
