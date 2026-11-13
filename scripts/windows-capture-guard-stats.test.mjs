import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';

// 抓屏守护的 W 值呈现（T-21）。
//
// ## 背景（已实测确认，别重新调研）
//
//   - `scripts/windows-client-capture-guard.ps1` 落盘事件并算 P50/P95（PR#18/19/20 已在 main）
//   - `scripts/windows-real-client-injection.ps1:521-560` 把它汇总成 `captureGuard` 四态 reason
//   - `windows/share-file/windows-bootstrap.js` 的 `applyCaptureGuard()` 只读
//     `__CX_WIN_CAPTURE_GUARD__` 隐藏面板，**从不展示 W**
//
// 本文件测的就是最后这段：面板上要显示 P50/P95 与样本数，且「没触发」不能显示成 0。
//
// ## ⚠️ 语义红线：只观察，不改客户端行为
//
// 参考项目 `cef-hook/thread.cpp:128-135` 的 hook 方向是「`WDA_NONE` 时 return true」，
// 即**阻止客户端关掉** WDA_MONITOR 保护。PLUS 需要的是**相反方向**：两向放行、只观察 ——
// 因为要在客户端把保护关掉**之后**立刻隐藏面板（抓屏已经在进行，此时才需要藏）。
//
// 所以本文件最后两条用例是反向断言：呈现层不得越权去动客户端窗口/亲和力。

const root = resolve(import.meta.dirname, '..');
const bootstrapPath = resolve(root, 'windows', 'share-file', 'windows-bootstrap.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.attributes = new Map();
    this.id = '';
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = '';
    this.parentNode = null;
  }

  addEventListener(type, callback) {
    this.listeners.set(String(type), callback);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) {
      this.children.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }
}

function createHarness({ config = {}, href = 'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist?secret=1' } = {}) {
  const messages = [];
  const createdElements = [];
  const listeners = new Map();

  const documentObject = {
    readyState: 'complete',
    documentElement: new FakeElement('html'),
    head: null,
    body: null,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      for (const callback of listeners.get(event && event.type ? event.type : '') || []) callback(event);
      return true;
    },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      createdElements.push(element);
      return element;
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text) };
    },
    getElementById(id) {
      // 只返回**仍挂在文档里**的节点：宿主用 removeChild 摘掉角标后必须查不到，
      // 否则「抓屏期间角标消失」这条断言会被一个已摘掉的孤儿节点骗过去。
      // 从后往前找：重新挂上来的是新节点，而旧节点还留在 createdElements 里（parentNode=null）。
      for (let index = createdElements.length - 1; index >= 0; index -= 1) {
        const element = createdElements[index];
        if (element.id === id && element.parentNode) return element;
      }
      return null;
    },
    querySelectorAll: () => []
  };
  documentObject.head = documentObject.createElement('head');
  documentObject.body = documentObject.createElement('body');

  const windowObject = {
    location: { href, origin: new URL(href).origin, pathname: new URL(href).pathname },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    __CX_WIN_CONFIG_JSON__: config,
    __CX_WIN_INSTANCE__: 'capture-stats',
    __CX_WIN_STYLE_TEXT__: '',
    CustomEvent: class FakeCustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init ? init.detail : undefined;
      }
    }
  };
  windowObject.addEventListener = () => {};
  windowObject.removeEventListener = () => {};
  windowObject.dispatchEvent = () => true;
  windowObject.window = windowObject;
  windowObject.self = windowObject;
  windowObject.top = windowObject;
  windowObject.Element = FakeElement;
  windowObject.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  windowObject.getComputedStyle = () => ({ display: 'block' });

  const sandbox = {
    window: windowObject,
    document: documentObject,
    console: { log: (...args) => messages.push(String(args[0])), warn() {}, error() {} },
    CustomEvent: windowObject.CustomEvent,
    Element: FakeElement,
    setInterval: () => 0,
    clearInterval: () => {}
  };
  const context = vm.createContext(sandbox);

  async function run() {
    const source = await readFile(bootstrapPath, 'utf8');
    vm.runInContext(source, context, { filename: 'windows-bootstrap.js' });
  }

  function parseMessages() {
    return messages
      .filter((message) => message.startsWith('__CX_WIN_MSG__'))
      .map((message) => JSON.parse(message.slice('__CX_WIN_MSG__'.length)));
  }

  return { window: windowObject, document: documentObject, createdElements, parseMessages, run };
}

const BADGE_ID = 'cx-win-capture-stats';

function badgeOf(harness) {
  return harness.document.getElementById(BADGE_ID);
}

// 造一个 captureGuard 汇总（字段名与 windows-real-client-injection.ps1 的报告一致）。
function summary(patch) {
  return {
    available: true,
    guardStarted: true,
    eventsPath: 'C:\\Temp\\capture-guard-events-1234.jsonl',
    reason: 'ok',
    events: 3,
    rawEventCount: 6,
    unpairedOn: 0,
    errorCount: 0,
    wMinMs: 40,
    wMaxMs: 240,
    wP50Ms: 120.5,
    wP95Ms: 240,
    pollMs: 200,
    ...patch
  };
}

// ---- 判据①：面板显示 P50/P95 与样本数 ----
test('判据①：有配对事件时，读数角标显示 P50 / P95 与样本数', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const state = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({}));
  assert.equal(state.state, 'ok');
  assert.equal(state.samples, 3);
  assert.equal(state.p50Ms, 120.5);
  assert.equal(state.p95Ms, 240);

  const badge = badgeOf(harness);
  assert.notEqual(badge, null, '必须真的往页面里挂读数角标');
  const text = badge.textContent;
  // 三个数字都必须出现，且不能被四舍五入成一个数。
  assert.match(text, /120\.5/u, `P50 必须逐字显示，实际：${text}`);
  assert.match(text, /240/u, `P95 必须逐字显示，实际：${text}`);
  assert.match(text, /3/u, `样本数必须显示，实际：${text}`);
  assert.match(text, /P50/u);
  assert.match(text, /P95/u);
  assert.equal(badge.getAttribute('data-cx-win-capture-stats'), 'ok');
});

test('判据①：样本数与分位数不是同一个数字时也不会互相顶掉', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    events: 17, wP50Ms: 62, wP95Ms: 199
  }));
  const text = badgeOf(harness).textContent;
  assert.match(text, /P50 62 ms/u, text);
  assert.match(text, /P95 199 ms/u, text);
  assert.match(text, /样本 17/u, text);
});

// ---- 判据②：无事件时显示「本次未触发」而不是 0 ----
test('判据②：「守护跑满但零跳变」显示「本次未触发」，绝不能是 W=0', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const state = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    available: false,
    guardStarted: true,
    eventsPath: null,
    // events 必须显式写 0：不写会继承 summary() 的默认 3，
    // 那这条用例就变成「3 个样本 + 没触发的 reason」这种自相矛盾的输入，
    // 在变异下会因为错误的原因变红（第一次就跑出了这个问题）。
    events: 0,
    reason: 'no-capture-triggered'
  }));
  assert.equal(state.state, 'no-capture-triggered');
  // 关键：没触发时不能有分位数 —— 有分位数就意味着「测到了 0ms 的窗口」。
  assert.equal(state.p50Ms, null);
  assert.equal(state.p95Ms, null);
  assert.equal(state.samples, 0);

  const text = badgeOf(harness).textContent;
  assert.match(text, /本次未触发/u, `必须说明「没触发」，实际：${text}`);
  // 「未触发」与「触发但 W=0」在界面上必须可区分：前者不得出现任何 0 ms 读数。
  assert.doesNotMatch(text, /P50/u, `未触发时不得显示 P50，实际：${text}`);
  assert.doesNotMatch(text, /P95/u, `未触发时不得显示 P95，实际：${text}`);
  assert.doesNotMatch(text, /0\s*ms/u, `未触发不是 W=0，实际：${text}`);
});

test('判据②补充：真正的「触发但 W=0」要显示成 0 ms，不能被归并到「未触发」', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  // W=0 是**有样本**（客户端确实关了又立刻开了），只是时长为 0。
  const state = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    events: 1, wMinMs: 0, wMaxMs: 0, wP50Ms: 0, wP95Ms: 0
  }));
  assert.equal(state.state, 'ok', '有样本就是 ok，哪怕时长是 0');
  assert.equal(state.samples, 1);
  assert.equal(state.p50Ms, 0);
  const text = badgeOf(harness).textContent;
  assert.match(text, /P50 0 ms/u, `W=0 要显示成 0 ms，实际：${text}`);
  assert.match(text, /样本 1/u, text);
  assert.doesNotMatch(text, /本次未触发/u, 'W=0 是触发过的，不能说没触发');
});

test('判据③：reason 四态互不塌缩 —— 同样的 payload 只改 reason，四句话必须两两不同', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const base = { available: false, guardStarted: false, events: 0, wP50Ms: null, wP95Ms: null };
  const seen = new Map();
  for (const reason of ['guard-not-started', 'no-capture-triggered', 'ok', 'error']) {
    const state = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__({ ...base, reason });
    const badge = badgeOf(harness);
    seen.set(reason, { state: state.state, text: badge ? badge.textContent : null });
  }
  // 'ok' + 0 样本按语义归到「未触发」（见上一条用例），所以它允许与 no-capture-triggered 同形；
  // 其余三态必须彼此可区分 —— 这是「四态不能压成布尔」的核心判据。
  const states = ['guard-not-started', 'no-capture-triggered', 'error'].map((reason) => seen.get(reason).state);
  assert.equal(new Set(states).size, 3,
    `guard-not-started / no-capture-triggered / error 必须映射到 3 个不同状态，实际：${states.join(' / ')}`);
  const texts = ['guard-not-started', 'no-capture-triggered', 'error'].map((reason) => seen.get(reason).text);
  for (const text of texts) assert.ok(text, '每态都要有显示');
  assert.equal(new Set(texts).size, 3, `三态的显示文案必须两两不同，实际：${texts.join(' | ')}`);
});

test('「守护根本没起来」必须自己有一条显示，且不含任何 W 读数', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const state = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    available: false, guardStarted: false, events: 0, reason: 'guard-not-started'
  }));
  assert.equal(state.state, 'guard-not-started');
  const text = badgeOf(harness).textContent;
  assert.notEqual(text, '', '守护没起来也要有显示，不能静默');
  assert.match(text, /未启动|未运行|没起来/u, `要指出守护没启动，实际：${text}`);
  assert.doesNotMatch(text, /P50|P95/u, '没有样本就不该有分位数');
});


test('判据②：reason 为 ok 但样本数为 0 时同样按「未触发」处理（不是 W=0）', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const state = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    reason: 'ok', events: 0, wP50Ms: null, wP95Ms: null
  }));
  assert.equal(state.state, 'no-capture-triggered', '0 个配对样本 = 没触发，不是 0ms');
  assert.match(badgeOf(harness).textContent, /本次未触发/u);
});

test('「守护根本没起来」与「跑了没跳变」必须是两种不同的显示（原因不同，下一步动作相反）', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const notStarted = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    available: false, guardStarted: false, reason: 'guard-not-started'
  }));
  const notStartedText = badgeOf(harness).textContent;
  assert.equal(notStarted.state, 'guard-not-started');
  assert.notEqual(notStartedText, '', '这条也要有显示，不能静默');

  const notTriggered = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    available: false, guardStarted: true, reason: 'no-capture-triggered'
  }));
  const notTriggeredText = badgeOf(harness).textContent;
  assert.notEqual(notTriggered.state, notStarted.state);
  assert.notEqual(
    notTriggeredText,
    notStartedText,
    '两种原因必须显示成两句不同的话，否则用户无从判断该查配置还是该认为正常'
  );
});

test('reason=error 显示读取失败，且不冒充任何一种「没问题」的状态', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const state = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    available: false, reason: 'error'
  }));
  assert.equal(state.state, 'error');
  const text = badgeOf(harness).textContent;
  assert.match(text, /失败|错误|读取/u, text);
  assert.doesNotMatch(text, /本次未触发/u, '读取失败不能被显示成「没触发」');
});

test('没有收到任何汇总时不挂空角标（未装宿主的老页面零视觉变化）', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  assert.equal(badgeOf(harness), null, '没数据就不该有角标');
  const state = harness.window.__CX_WIN_APPLY_CAPTURE_GUARD_STATS__();
  assert.equal(state.state, 'absent');
  assert.equal(badgeOf(harness), null);
});

test('坏输入不抛异常：字符串坏 JSON / null / 数字 都退化成 absent 或 error', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  assert.equal(harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__('{not json').state, 'absent');
  assert.equal(harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(null).state, 'absent');
  assert.equal(harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(42).state, 'absent');
  // 每行都必须是「有意义的归一化结果」，不能是 undefined/null。
  for (const state of harness.window.__CX_WIN_APPLY_CAPTURE_GUARD_STATS__ ? [] : []) void state;
  assert.notEqual(harness.window.__CX_WIN_APPLY_CAPTURE_GUARD_STATS__(), null);
});

test('JSON 字符串形式的汇总（宿主经 CDP Runtime.evaluate 传入的形态）也能正常解析', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const state = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(JSON.stringify(summary({
    events: 5, wP50Ms: 88, wP95Ms: 176
  })));
  assert.equal(state.state, 'ok');
  assert.equal(state.samples, 5);
  assert.match(badgeOf(harness).textContent, /样本 5/u);
});

// ---- 与既有隐藏逻辑的协同 ----
test('抓屏窗口期内角标一并隐藏（那几毫秒里界面上任何悬浮物都会被拍进证据）', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({}));
  assert.notEqual(badgeOf(harness), null, '前提：先有角标');

  // 模拟宿主把 __CX_WIN_CAPTURE_GUARD__ 置真并调用隐藏函数（与 windows-client-cdp.ps1:155 同一调用序列）。
  harness.window.__CX_WIN_CAPTURE_GUARD__ = true;
  harness.window.__CX_WIN_APPLY_CAPTURE_GUARD__();
  assert.equal(badgeOf(harness), null, '抓屏期间角标必须消失');

  harness.window.__CX_WIN_CAPTURE_GUARD__ = false;
  harness.window.__CX_WIN_APPLY_CAPTURE_GUARD__();
  assert.notEqual(badgeOf(harness), null, '抓屏结束后角标要回来');
});

test('面板没挂时不往页面里塞角标（非考试页 / --windows-panel-enabled=false）', async () => {
  const harness = createHarness({
    config: {
      'common.settings.extension-enabled': true,
      'common.settings.windows-panel-enabled': false
    }
  });
  await harness.run();
  const state = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({}));
  assert.equal(state.state, 'ok', '归一化仍然要算，只是不渲染');
  assert.equal(badgeOf(harness), null, '没有面板就不要有角标');
});

// ---- 四态合并的变异必须被抓住（判据③ 的对照组）----
test('判据③对照：「文件不存在」与「跑了没跳变」在四态下不同，在布尔化后会同形', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  // 这两个状态在「布尔 available」视角下都是 false —— 这正是要避免的合并。
  const notStarted = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    available: false, guardStarted: false, reason: 'guard-not-started'
  }));
  const notTriggered = harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({
    available: false, guardStarted: true, reason: 'no-capture-triggered'
  }));
  assert.equal(notStarted.state !== notTriggered.state, true,
    '两种 reason 必须映射到不同的显示状态（把四态压成布尔后这里恒 false）');
  assert.equal(notStarted.samples === notTriggered.samples, true,
    '两种状态都没有样本 —— 所以只有 reason 能区分它们');
});

// ---- 只观察不改客户端行为 ----
test('呈现层只读：不得调用任何改变客户端窗口/亲和力的 API', async () => {
  const source = await readFile(bootstrapPath, 'utf8');
  // 与参考项目 cef-hook/thread.cpp:128-135 的方向相反：那里「WDA_NONE 时 return true」是阻止
  // 客户端关闭保护；PLUS 只需要观察，然后在关掉之后藏面板。
  // 页面侧本来就没有这些 API，断言这些名字不出现是「不越权」最直接的钉子。
  //
  // 只钉**调用形态**（名字后跟左括号），不钉普通名词：源文件里本来就有一句
  // 「客户端会先把自己窗口的 WDA_MONITOR 关掉」的说明性注释，那是描述客户端行为，不是我们在调。
  for (const api of [
    'SetWindowDisplayAffinity',
    'GetWindowDisplayAffinity',
    'SetForegroundWindow',
    'ShowWindow',
    'SetWindowPos',
    'SetWindowLong',
    'SendMessage'
  ]) {
    assert.equal(
      new RegExp(`${api}\\s*\\(`, 'u').test(source),
      false,
      `页面侧不得调用 ${api}（只观察，不干预客户端）`
    );
  }
  // 反向确认：隐藏逻辑本身还在，且方向正确（置真时藏、置假时恢复）。
  assert.match(source, /var hidden = win\.__CX_WIN_CAPTURE_GUARD__ === true;/u);
  assert.match(source, /shell\.style\.display = hidden \? 'none' : '';/u);
});

test('呈现层不发起网络请求、不写 localStorage、不改全局抓屏标记', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const before = harness.window.__CX_WIN_CAPTURE_GUARD__;
  harness.window.__CX_WIN_SET_CAPTURE_GUARD_STATS__(summary({}));
  assert.equal(
    harness.window.__CX_WIN_CAPTURE_GUARD__,
    before,
    '渲染读数不得顺手改写 __CX_WIN_CAPTURE_GUARD__（那是宿主与隐藏逻辑的唯一通道）'
  );
  // 读数角标必须是 pointer-events: none，否则会挡住面板里的点击。
  assert.equal(badgeOf(harness).style.pointerEvents, 'none');
  // 层级必须低于面板壳（2147483645）与弹窗（2147483647）。
  assert.ok(Number(badgeOf(harness).style.zIndex) < 2147483645, '角标不能盖住面板');
});
