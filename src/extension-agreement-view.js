// This renderer runs in extension-owned contexts: the isolated content world or the internal page.
const mountCxAgreement = ({ internal, send }) => {
  const host = document.createElement('div');
  host.id = 'cx-plus-agreement';
  const shadow = host.attachShadow({ mode: 'open' });
  const styles = new CSSStyleSheet();
  styles.replaceSync(`
    :host{all:initial;position:fixed;inset:auto max(12px,4vw) 20px auto;display:block;z-index:2147483647;
      color:#1f2937;font:14px/1.55 system-ui,sans-serif}
    :host([hidden]),[hidden]{display:none!important}
    :host([data-internal]){position:relative;inset:auto;margin:5vh auto;width:min(840px,94vw)}
    section{box-sizing:border-box;width:min(500px,92vw);padding:16px;background:#fff;
      border:1px solid #94a3b8;border-radius:14px;box-shadow:0 8px 30px #33415533}
    :host([data-internal]) section{width:100%;padding:24px}
    h2,p{margin:0 0 10px}
    .body{box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;overscroll-behavior:contain;
      background:#f8fafc;border:1px solid #94a3b8;border-radius:8px;padding:12px;max-height:min(45vh,480px)}
    footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
    button{cursor:pointer;min-height:36px;border:1px solid #64748b;border-radius:8px;padding:5px 11px;
      color:#1f2937;background:#fff;font:inherit}
    button:focus-visible,a:focus-visible,.body:focus-visible{outline:2px solid #1d4ed8;outline-offset:2px}
    button:disabled{cursor:default;background:#e2e8f0;color:#475569}
    .accept:not(:disabled){color:#fff;background:#1e40af;border-color:#1e40af}
    `);
  shadow.adoptedStyleSheets = [styles];
  if (internal) host.dataset.internal = 'true';
  const create = (tag, cls, text, parent) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    parent.append(node);
    return node;
  };
  const reopen = create('button', 'reopen', '阅读并同意用户协议', shadow);
  const card = create('section', 'card', '', shadow);
  card.setAttribute('aria-label', '用户协议');
  create('h2', '', '用户协议', card);
  const status = create('p', 'status', '', card);
  status.setAttribute('role', 'status');
  const summary = create('p', 'summary', '', card);
  const body = create('div', 'body', '', card);
  body.tabIndex = 0;
  body.setAttribute('aria-label', '协议正文，滚动到底部后开始五秒确认');
  const timing = create('p', 'timing', '', card);
  const controls = create('footer', '', '', card);
  const accept = create('button', 'accept', '读完并同意', controls);
  const retry = create('button', 'retry', '重新获取', controls);
  const dismiss = create('button', 'dismiss', '暂不同意', controls);
  for (const node of [accept, retry, dismiss, reopen]) node.type = 'button';
  dismiss.hidden = internal;
  let state, identity, readAt, timer, preparing = false, destroyed = false, collapsed = false, sending = false, serial = 0;

  function clearReading(notify) {
    serial++;
    readAt = undefined;
    preparing = false;
    sending = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    accept.disabled = true;
    if (notify) void send('abandon');
  }

  function tick() {
    const remaining = readAt === undefined ? 5000 : Math.max(0, 5000 - (performance.now() - readAt));
    accept.disabled = sending || !state?.canSign || remaining > 0 || !navigator.onLine || collapsed;
    timing.textContent = !state?.canSign || !navigator.onLine || collapsed ? ''
      : sending ? '正在等待服务端确认…'
        : preparing ? '正在确认阅读进度…'
          : readAt === undefined ? '请先滚动到底部。'
          : remaining > 0 ? '请等待 ' + Math.ceil(remaining / 1000) + ' 秒。' : '请主动点击“读完并同意”。';
    if (remaining === 0 && timer) { clearInterval(timer); timer = undefined; }
  }

  async function noteBottom() {
    if (destroyed || collapsed || preparing || readAt !== undefined || !state?.canSign || !navigator.onLine
      || body.scrollTop + body.clientHeight < body.scrollHeight - 2 || !body.clientHeight) return;
    const reading = ++serial;
    preparing = true;
    tick();
    const doc = state.document;
    const ready = await send('prepare', { version: doc.version, hash: doc.hash });
    if (destroyed || reading !== serial) return;
    preparing = false;
    if (!ready?.canSign || ready.scope !== state.scope || ready.document?.hash !== doc.hash) {
      readAt = undefined;
      tick();
      return;
    }
    readAt = performance.now();
    timer = setInterval(tick, 150);
    tick();
  }

  function render(next) {
    if (destroyed) return;
    const previousIdentity = identity;
    const nextDoc = next?.document;
    identity = nextDoc ? [next?.scope, nextDoc.version, nextDoc.hash].join(':') : '';
    if (identity !== previousIdentity || !next?.canSign) clearReading(false);
    if (identity !== previousIdentity) {
      summary.textContent = nextDoc ? (nextDoc.offlineOnly ? '' : '版本 ' + nextDoc.version + ' · ') + nextDoc.summary : '';
      body.textContent = nextDoc?.body ?? '';
      body.scrollTop = 0;
      collapsed = false;
    }
    state = next;
    const phase = state?.phase;
    const signed = phase === 'accepted' && navigator.onLine;
    host.hidden = !internal && (signed || phase === 'host' || phase === 'disabled');
    reopen.hidden = !collapsed;
    card.hidden = collapsed;
    body.hidden = !nextDoc;
    accept.hidden = signed || !next?.canSign;
    retry.hidden = signed;
    dismiss.hidden = internal || signed;
    status.textContent = !navigator.onLine ? '当前离线，可只读；无法签署或使用受限功能。' : ({
      accepted: '服务端已确认同意当前版本。',
      pending: next?.acceptedVersion ? '协议已更新，请重新阅读并签署后再使用题库。' : '请完整阅读并同意后再使用题库。',
      'not-published': '服务端尚未发布协议。请稍后重试；暂不能签署或使用受限功能。',
      'version-changed': '服务端版本已变更。保留原正文只读，请重新获取。',
      'submit-failed': '未能确认签署。请重新获取，并在确认后主动重试。',
      contract: '正文或摘要未通过校验。保留原正文只读，请稍后重试。',
      unavailable: '暂时无法确认服务端状态。保留原正文只读，请稍后重试。',
      offline: '当前离线，可只读；无法签署或使用受限功能。',
      configuration: '无法验证当前题库配置或设备。请核对配置并重试。',
      disabled: '扩展已停用。',
      host: '此运行模式不使用普通扩展协议页。'
    })[phase] ?? '正在获取当前协议…';
    tick();
    if (next?.canSign && (identity !== previousIdentity || readAt === undefined)) requestAnimationFrame(noteBottom);
  }

  async function onAccept(ev) {
    if (!ev.isTrusted || accept.disabled || !state?.canSign || sending) return;
    sending = true;
    const active = serial;
    const current = state.document;
    tick();
    const result = await send('accept', { version: current.version, hash: current.hash });
    if (destroyed || active !== serial) return;
    sending = false;
    render(result ?? { ...state, phase: 'submit-failed', canSign: false });
  }
  function onDismiss(ev) {
    if (!ev.isTrusted) return;
    clearReading(true);
    collapsed = true;
    render(state);
    reopen.focus();
  }
  function onReopen(ev) {
    if (!ev.isTrusted) return;
    collapsed = false;
    render(state);
    void send('refresh');
  }
  async function onRetry(ev) {
    if (!ev.isTrusted) return;
    clearReading(true);
    body.scrollTop = 0;
    const active = serial;
    const updated = await send('refresh');
    if (!destroyed && active === serial) render(updated);

  }
  body.addEventListener('scroll', noteBottom);
  accept.addEventListener('click', onAccept);
  dismiss.addEventListener('click', onDismiss);
  reopen.addEventListener('click', onReopen);
  retry.addEventListener('click', onRetry);
  document.body.append(host);
  render(null);
  return {
    render,
    destroy() {
      destroyed = true;
      clearReading(true);
      body.removeEventListener('scroll', noteBottom);
      accept.removeEventListener('click', onAccept);
      dismiss.removeEventListener('click', onDismiss);
      reopen.removeEventListener('click', onReopen);
      retry.removeEventListener('click', onRetry);
      host.remove();
    }
  };
};
