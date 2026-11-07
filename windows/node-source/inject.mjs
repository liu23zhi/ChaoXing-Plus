import { CdpConnection } from './cdp.mjs';

const MESSAGE_PREFIX = '__CX_WIN_MSG__';
const CHROMIUM_75_ALLOWED_HOST_SUFFIX = 'chaoxing.com';

function isChaoxingUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.hostname === CHROMIUM_75_ALLOWED_HOST_SUFFIX || parsed.hostname.endsWith(`.${CHROMIUM_75_ALLOWED_HOST_SUFFIX}`);
  } catch {
    return false;
  }
}

export function isBlankishUrl(url) {
  if (!url) return true;
  return url === ':'
    || url === '://'
    || url === 'null'
    || url === 'nullblank'
    || url === 'blank'
    || url.startsWith('about:')
    || url.startsWith('data:')
    || url.startsWith('blob:')
    || url.startsWith('chrome:')
    || url.startsWith('edge:')
    || url.startsWith('devtools:');
}

function sanitizeForLog(url, maxLength = 220) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return url.split('?')[0].split('#')[0].slice(0, maxLength);
    }
    const sanitized = `${parsed.origin}${parsed.pathname}`;
    return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}…` : sanitized;
  } catch {
    return url.split('?')[0].split('#')[0].slice(0, maxLength);
  }
}

function targetWebSocketUrl(value, port) {
  const match = typeof value === 'string' ? /^ws:\/\/(?:127\.0\.0\.1|localhost):([0-9]+)(\/.*)$/iu.exec(value) : null;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !match || Number(match[1]) !== port
    || !/^[\x21-\x7e]+$/u.test(match[2]) || match[2].includes('#')) {
    throw Object.assign(new Error('拒绝非本机、端口不匹配或无效的 CDP WebSocket 地址'), { code: 'CX_ENDPOINT_URL' });
  }
  // localhost must use the same IPv4 listener whose PID the host verified.
  return `ws://127.0.0.1:${port}${match[2]}`;
}

export class PageSession {
  constructor({ port, target, assets, configStore, instanceToken, injectBlankFrames, captureConsole, injectStrategy = 'hybrid', injectRetries = 2, bundleTimeoutMs = 120000, logger, onConfigSync, onBundleInjected, diagnostics, silentControl = null, onSilentEvent = null }) {
    this.port = port;
    this.target = target;
    this.assets = assets;
    this.configStore = configStore;
    this.instanceToken = instanceToken;
    this.injectBlankFrames = injectBlankFrames;
    this.captureConsole = captureConsole;
    this.injectStrategy = ['hybrid', 'runtime', 'script'].includes(injectStrategy) ? injectStrategy : 'hybrid';
    this.injectRetries = Number.isInteger(injectRetries) ? Math.max(0, Math.min(5, injectRetries)) : 2;
    this.bundleTimeoutMs = Number.isInteger(bundleTimeoutMs) ? bundleTimeoutMs : 120000;
    this.logger = logger;
    this.onConfigSync = onConfigSync;
    this.onBundleInjected = onBundleInjected;
    this.silentControl = silentControl && typeof silentControl === 'object' ? silentControl : null;
    this.onSilentEvent = typeof onSilentEvent === 'function' ? onSilentEvent : null;
    this.diagnostics = diagnostics;
    this.diagnosticEvents = new Set();
    this.diagnosticDelivery = null;
    this.diagnosticDirty = false;
    this.diagnosticsReadyContexts = new Set();
    this.diagnosticAcknowledged = new Map();
    this.diagnosticRetryTimer = null;
    this.pageErrorReported = false;
    this.connection = null;
    this.scriptIdentifier = null;
    this.contexts = new Map();
    this.frameUrls = new Map();
    this.frameParents = new Map();
    this.topFrameId = null;
    this.bootstrapped = new Set();
    this.readyContexts = new Set();
    this.bundleLoaded = new Set();
    this.bundlePending = new Map();
    this.rescanTimer = null;
    this.topEnsureTimer = null;
    this.closed = false;
    this.stats = {
      targetId: target.id,
      url: target.url,
      contexts: 0,
      bootstraps: 0,
      bundles: 0,
      configSyncs: 0,
      errors: []
    };
  }

  async open() {
    const connection = await CdpConnection.open(targetWebSocketUrl(this.target.webSocketDebuggerUrl, this.port));
    if (this.closed) {
      connection.close();
      throw Object.assign(new Error('注入会话已关闭，取消迟到的 CDP 连接'), { code: 'CX_INJECTION_CANCELLED' });
    }
    this.connection = connection;
    this.connection.onEvent((message) => {
      void this.handleEvent(message);
    });
    // 先取 frame 树再开 Runtime：避免 executionContextCreated 先到、frameUrl 还没映射导致误判页面类型。
    await this.connection.send('Page.enable');
    await this.refreshFrameTree();
    await this.connection.send('Runtime.enable');
    const assertRegistrationActive = () => {
      if (this.closed || connection.closed) {
        throw Object.assign(new Error('注入会话或调试连接已关闭，取消新文档脚本注册'), { code: 'CX_INJECTION_CANCELLED' });
      }
    };
    try {
      const registration = await this.connection.send('Page.addScriptToEvaluateOnNewDocument', {
        source: this.assets.trampoline
      });
      assertRegistrationActive();
      this.scriptIdentifier = registration && registration.identifier ? registration.identifier : null;
    } catch (error) {
      assertRegistrationActive();
      if (error.code === 'CX_INJECTION_CANCELLED') throw error;
      this.logger.warn(`[session] 新文档脚本注册失败，已降级为当前上下文注入与顶层补注入：${error.message}`);
    }
    this.scheduleTopFrameEnsure();
    this.logger.info(`[session] 已连接 target ${this.target.id} ${this.target.url || ''}`);
    return this;
  }

  async refreshFrameTree() {
    try {
      const result = await this.connection.send('Page.getFrameTree');
      const visit = (tree, depth) => {
        if (!tree || depth > 16) return;
        if (tree.frame && tree.frame.id) {
          this.frameUrls.set(tree.frame.id, tree.frame.url || '');
          if (tree.frame.parentId) this.frameParents.set(tree.frame.id, tree.frame.parentId);
          else this.frameParents.delete(tree.frame.id);
        }
        for (const child of tree.childFrames || []) visit(child, depth + 1);
      };
      this.topFrameId = result.frameTree && result.frameTree.frame ? result.frameTree.frame.id || null : null;
      visit(result.frameTree, 0);
    } catch (error) {
      this.logger.warn(`[session] 读取 frame 树失败：${error.message}`);
    }
  }

  frameUrlForContext(contextId) {
    const context = this.contexts.get(contextId);
    if (context && context.frameId && this.frameUrls.has(context.frameId)) {
      return this.frameUrls.get(context.frameId);
    }
    return context ? context.origin || '' : '';
  }

  /** 返回顶层 frame 最近一次注册的执行上下文 id（用于注入/诊断）。 */
  getTopContextId() {
    let topContextId = null;
    for (const [contextId, context] of this.contexts) {
      if (!this.topFrameId || context.frameId === this.topFrameId) {
        topContextId = contextId;
      }
    }
    return topContextId;
  }

  async evaluateReturnByValue(contextId, expression, { timeoutMs = 15000 } = {}) {
    const response = await this.connection.send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true
    }, { timeoutMs });
    if (response && response.exceptionDetails) {
      return { value: null, exception: response.exceptionDetails };
    }
    const remote = response && response.result ? response.result : null;
    return { value: remote ? remote.value : null, exception: null };
  }

  async captureScreenshot() {
    try {
      const result = await this.connection.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 20000 });
      return result && result.data ? result.data : null;
    } catch (error) {
      this.logger.warn(`[session] 页面截图失败：${error.message}`);
      return null;
    }
  }

  shouldInjectBundle(contextId) {
    const url = this.frameUrlForContext(contextId);
    if (isChaoxingUrl(url)) return true;
    if (isBlankishUrl(url)) return this.injectBlankFrames;
    return false;
  }

  clearContext(contextId) {
    if (this.isTopContext(contextId)) this.cancelDiagnosticRetry();
    this.diagnosticsReadyContexts.delete(contextId);
    this.diagnosticAcknowledged.delete(contextId);
    for (const key of this.diagnosticEvents) if (key.endsWith(`:${contextId}`)) this.diagnosticEvents.delete(key);
    this.contexts.delete(contextId);
    this.bootstrapped.delete(contextId);
    this.readyContexts.delete(contextId);
    this.bundleLoaded.delete(contextId);
    this.bundlePending.delete(contextId);
  }

  removeFrameSubtree(frameId) {
    if (!frameId) return;
    const removedFrames = new Set([frameId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [childId, parentId] of this.frameParents) {
        if (!removedFrames.has(childId) && removedFrames.has(parentId)) {
          removedFrames.add(childId);
          changed = true;
        }
      }
    }
    for (const [contextId, context] of this.contexts) {
      if (removedFrames.has(context.frameId)) this.clearContext(contextId);
    }
    for (const removedFrameId of removedFrames) {
      this.frameUrls.delete(removedFrameId);
      this.frameParents.delete(removedFrameId);
    }
    if (removedFrames.has(this.topFrameId)) this.topFrameId = null;
    this.stats.contexts = this.contexts.size;
  }

  isHostMessage(payload, contextId) {
    return Number.isInteger(contextId)
      && contextId > 0
      && this.contexts.has(contextId)
      && this.bootstrapped.has(contextId)
      && payload.source === 'chaoxing-plus-windows'
      && payload.instance === this.instanceToken;
  }

  async handleEvent(message) {
    if (this.closed || !message) return;
    if (message.method === 'cx.disconnected') {
      this.recordDiagnostic('session-retry', 'warn');
      this.logger.warn(`[session] target ${this.target.id} 调试连接已断开`);
      this.close();
      return;
    }
    const params = message.params || {};
    if (message.method === 'Runtime.executionContextCreated') {
      const context = params.context || {};
      const auxData = context.auxData || {};
      if (context.id > 0 && auxData.isDefault === true) {
        if (!this.contexts.has(context.id)) {
          if (this.topFrameId && auxData.frameId === this.topFrameId) {
            this.cancelDiagnosticRetry();
            this.diagnosticAcknowledged.clear();
          }
          this.contexts.set(context.id, {
            frameId: auxData.frameId || '',
            origin: context.origin || ''
          });
        }
        this.stats.contexts = this.contexts.size;
        this.logger.info(`[context] id=${context.id} frame=${auxData.frameId || ''} origin=${context.origin || ''}`);
        await this.injectBootstrap(context.id);
      }
      return;
    }
    if (message.method === 'Runtime.executionContextDestroyed') {
      const contextId = params.executionContextId;
      this.clearContext(contextId);
      this.stats.contexts = this.contexts.size;
      return;
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      this.contexts.clear();
      this.bootstrapped.clear();
      this.readyContexts.clear();
      this.bundleLoaded.clear();
      this.bundlePending.clear();
      this.diagnosticEvents.clear();
      this.diagnosticsReadyContexts.clear();
      this.diagnosticAcknowledged.clear();
      this.cancelDiagnosticRetry();
      this.stats.contexts = 0;
      return;
    }
    if (message.method === 'Page.frameAttached') {
      if (params.frameId && params.parentFrameId) {
        this.frameParents.set(params.frameId, params.parentFrameId);
      }
      return;
    }
    if (message.method === 'Page.frameDetached') {
      this.removeFrameSubtree(params.frameId);
      this.scheduleRescan();
      return;
    }
    if (message.method === 'Page.frameNavigated') {
      const frame = params.frame || {};
      if (frame.id) {
        this.frameUrls.set(frame.id, frame.url || '');
        if (frame.parentId) this.frameParents.set(frame.id, frame.parentId);
        else this.frameParents.delete(frame.id);
      }
      if (!frame.parentId) {
        this.topFrameId = frame.id || this.topFrameId;
        this.pageErrorReported = false;
        this.recordDiagnostic('top-navigated');
        this.logger.info(`[nav] 顶层导航：${sanitizeForLog(frame.url || '')}`);
        this.scheduleTopFrameEnsure();
      }
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      this.handleConsoleEvent(params);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      if (!this.pageErrorReported) {
        this.pageErrorReported = true;
        this.recordDiagnostic('page-error', 'error');
      }
      if (!this.captureConsole) return;
      const description = params.exceptionDetails && params.exceptionDetails.exception
        ? params.exceptionDetails.exception.description || params.exceptionDetails.exception.value
        : '';
      if (description) this.recordError(`页面异常：${String(description).split('\n')[0]}`);
    }
  }

  handleConsoleEvent(params) {
    const args = Array.isArray(params.args) ? params.args : [];
    for (const arg of args) {
      if (!arg || arg.type !== 'string' || typeof arg.value !== 'string') continue;
      if (!arg.value.startsWith(MESSAGE_PREFIX)) continue;
      let payload;
      try {
        payload = JSON.parse(arg.value.slice(MESSAGE_PREFIX.length));
      } catch {
        continue;
      }
      void this.handlePageMessage(payload, params.executionContextId);
      return;
    }
  }

  async handlePageMessage(payload, contextId) {
    if (!payload || typeof payload !== 'object') return;
    const detail = payload.detail || {};
    if (payload.kind === 'boot-request') {
      const hasSource = Object.prototype.hasOwnProperty.call(payload, 'source');
      const hasInstance = Object.prototype.hasOwnProperty.call(payload, 'instance');
      // trampoline requests precede bootstrap; an existing envelope must match completely.
      if ((hasSource || hasInstance) && (!hasSource || !hasInstance
        || payload.source !== 'chaoxing-plus-windows' || payload.instance !== this.instanceToken)) return;
      if (Number.isInteger(contextId) && contextId > 0 && this.contexts.has(contextId)) {
        await this.injectBootstrap(contextId);
      }
      return;
    }
    if (!this.isHostMessage(payload, contextId)) return;
    if (payload.kind === 'ready') {
      this.readyContexts.add(contextId);
      if (!this.configStore.isEnabled()) return;
      await this.injectBundle(contextId);
      return;
    }
    if (payload.kind === 'disabled') {
      this.logger.info(`[session] 总开关关闭，跳过业务注入：${this.target.url || ''}`);
      return;
    }
    if (payload.kind === 'config-sync') {
      this.stats.configSyncs += 1;
      this.onConfigSync?.(detail, contextId);
      return;
    }
    if (payload.kind === 'silent-hotkey' || payload.kind === 'silent-fullscreen' || payload.kind === 'script-session-expired') {
      // 只接受顶层文档的静默控制事件：答题页大量 about:blank iframe 各自上报
      // 全屏状态时，子 frame 的窗口尺寸必然小于屏幕，会把"已进入全屏"翻成
      // "退出全屏"并误触发自毁。frame 树未知时保持旧行为（不阻断功能）。
      if (this.topFrameId && !this.isTopContext(contextId)) return;
      this.onSilentEvent?.(payload.kind, detail, contextId);
      return;
    }
    if (payload.kind === 'bootstrap-error') {
      this.recordDiagnostic('bootstrap-failed', 'error', contextId);
      this.recordError(`bootstrap 错误：${detail.stage || ''} ${detail.message || ''}`.trim());
      return;
    }
    if (payload.kind === 'panel-shell') {
      this.logger.info(`[panel] 已提前挂载折叠面板壳 ${sanitizeForLog(detail.url || '')}`);
      return;
    }
    if (payload.kind === 'panel-state') {
      const pieces = [
        `panels=${detail.count}`,
        `visible=${detail.visible}`,
        `removed=${detail.removed || 0}`,
        `owner=${String(detail.owner || '').slice(0, 120)}`
      ];
      if (detail.initial) pieces.push('initial');
      this.logger.info(`[panel] ${pieces.join(' ')}`);
      return;
    }
    if (payload.kind === 'panel-owner-change') {
      this.logger.info(`[panel] owner 变更 -> ${String(detail.owner || '').slice(0, 120) || '(空)'}`);
      return;
    }
    if (payload.kind === 'log') {
      if (this.captureConsole) this.logger.info(`[page] ${detail.message}`);
    }
  }

  recordError(message) {
    const text = String(message || '');
    if (!text) return;
    this.stats.errors.push(text.slice(0, 500));
    if (this.stats.errors.length > 20) this.stats.errors.shift();
    this.logger.warn(`[session] ${text.slice(0, 300)}`);
  }

  isTopContext(contextId) {
    const context = this.contexts.get(contextId);
    return Boolean(this.topFrameId && context && context.frameId === this.topFrameId);
  }

  recordDiagnostic(code, level = 'info', contextId) {
    if (!this.diagnostics || this.closed) return;
    if (contextId !== undefined) {
      if (!this.isTopContext(contextId)) return;
      const key = `${code}:${contextId}`;
      if (this.diagnosticEvents.has(key)) return;
      this.diagnosticEvents.add(key);
    }
    this.diagnostics.record(code, level);
  }

  cancelDiagnosticRetry() {
    if (this.diagnosticRetryTimer !== null) clearTimeout(this.diagnosticRetryTimer);
    this.diagnosticRetryTimer = null;
  }

  scheduleDiagnosticRetry() {
    const contextId = this.getTopContextId();
    if (this.diagnosticRetryTimer !== null || this.closed || !this.connection || this.connection.closed
      || !this.isTopContext(contextId) || !this.diagnosticsReadyContexts.has(contextId)
      || this.configStore.settingsSnapshot()['common.settings.windows-panel-enabled'] === false) return;
    this.diagnosticRetryTimer = setTimeout(() => {
      this.diagnosticRetryTimer = null;
      void this.broadcastDiagnostics();
    }, 2000);
  }

  async broadcastDiagnostics() {
    if (!this.diagnostics || this.closed || !this.connection || this.connection.closed
      || this.configStore.settingsSnapshot()['common.settings.windows-panel-enabled'] === false) return false;
    this.diagnosticDirty = true;
    if (this.diagnosticRetryTimer !== null) return false;
    if (this.diagnosticDelivery) return this.diagnosticDelivery;
    const delivery = (async () => {
      let acknowledged = false;
      do {
        this.diagnosticDirty = false;
        const contextId = this.getTopContextId();
        const context = this.contexts.get(contextId);
        const connection = this.connection;
        if (!this.isTopContext(contextId) || !this.diagnosticsReadyContexts.has(contextId)) return false;
        const active = () => !this.closed && this.connection === connection && !connection.closed
          && this.contexts.get(contextId) === context && this.isTopContext(contextId) && this.getTopContextId() === contextId
          && this.diagnosticsReadyContexts.has(contextId)
          && this.configStore.settingsSnapshot()['common.settings.windows-panel-enabled'] !== false;
        const entries = this.diagnostics.snapshot();
        const lastSequence = entries.length ? entries[entries.length - 1].sequence : 0;
        const previous = this.diagnosticAcknowledged.get(contextId);
        if (previous && previous.context === context && previous.sequence === lastSequence && previous.count === entries.length) {
          this.cancelDiagnosticRetry();
          acknowledged = true;
          continue;
        }
        const payload = JSON.stringify({ source: 'chaoxing-plus-windows-host', instance: this.instanceToken, entries });
        const expression = `(function(){if(window.self!==window.top)return false;var host=window.__CX_WIN_HOST__;return !!host&&typeof host.setDiagnostics==='function'&&host.setDiagnostics(${payload})===true;})()`;
        try {
          const result = await this.evaluateReturnByValue(contextId, expression, { timeoutMs: 3000 });
          acknowledged = active() && !result.exception && result.value === true;
        } catch {
          acknowledged = false;
        }
        if (acknowledged) {
          this.diagnosticAcknowledged.set(contextId, { context, sequence: lastSequence, count: entries.length });
          this.cancelDiagnosticRetry();
        } else if (active()) this.scheduleDiagnosticRetry();
      } while (this.diagnosticDirty && !this.closed && this.diagnosticRetryTimer === null);
      return acknowledged;
    })();
    this.diagnosticDelivery = delivery;
    try { return await delivery; }
    finally { if (this.diagnosticDelivery === delivery) this.diagnosticDelivery = null; }
  }

  async evaluate(contextId, expression, { timeoutMs = 60000 } = {}) {
    return this.connection.send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: false
    }, { timeoutMs });
  }

  async evaluateOrThrow(contextId, expression, label, { timeoutMs = 60000 } = {}) {
    const response = await this.evaluate(contextId, expression, { timeoutMs });
    const details = response && response.exceptionDetails;
    if (details) {
      const description = details.exception && details.exception.description
        ? details.exception.description
        : details.text || 'unknown exception';
      throw new Error(`${label}：${String(description).split('\n')[0]}`);
    }
    return response;
  }

  async injectViaScriptElement(contextId, source, label, { timeoutMs = 60000 } = {}) {
    const marker = `__CX_WIN_SCRIPT_INJECT_ERROR_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const markerJson = JSON.stringify(marker);
    const sourceJson = JSON.stringify(String(source || ''));
    const expression = `(function(){var marker=${markerJson};var source=${sourceJson};var script=document.createElement('script');var parent=document.head||document.documentElement||document.body;if(!parent){throw new Error('document 没有可用的 script 挂载节点');}script.onerror=function(){window[marker]='脚本元素加载失败（可能被页面 CSP 阻止）';};script.textContent='try{\\n'+source+'\\n;window['+JSON.stringify(marker)+']="__CX_WIN_SCRIPT_INJECT_OK__";\\n}catch(error){window['+JSON.stringify(marker)+']=(error&&error.stack)||String(error);}';parent.appendChild(script);if(script.parentNode){script.parentNode.removeChild(script);}var result=window[marker]||'';try{delete window[marker];}catch(e){window[marker]=undefined;}if(result !== "__CX_WIN_SCRIPT_INJECT_OK__"){return {ok:false,error:String(result||'script 执行失败或被页面策略阻止')};}return {ok:true};})()`;
    const result = await this.evaluateReturnByValue(contextId, expression, { timeoutMs });
    if (result.exception) {
      const detail = result.exception.exception && result.exception.exception.description
        ? result.exception.exception.description
        : result.exception.text || 'unknown exception';
      throw new Error(`${label}（script）：${String(detail).split('\n')[0]}`);
    }
    if (!result.value || result.value.ok !== true) {
      throw new Error(`${label}（script）：${result.value && result.value.error ? result.value.error : 'script 执行失败'}`);
    }
    return result;
  }

  async injectSource(contextId, source, label, { timeoutMs = 60000 } = {}) {
    const context = this.contexts.get(contextId);
    const assertActive = () => {
      if (this.closed || this.contexts.get(contextId) !== context) {
        throw Object.assign(new Error('注入会话已关闭或执行上下文已销毁'), { code: 'CX_INJECTION_CANCELLED' });
      }
    };
    const runtime = () => this.evaluateOrThrow(contextId, source, label, { timeoutMs });
    const script = () => this.injectViaScriptElement(contextId, source, label, { timeoutMs });
    const methods = this.injectStrategy === 'runtime'
      ? [runtime]
      : this.injectStrategy === 'script'
        ? [script, runtime]
        : [runtime, script];
    let lastError = null;
    for (let attempt = 0; attempt <= this.injectRetries; attempt += 1) {
      for (const method of methods) {
        assertActive();
        try {
          const result = await method();
          assertActive();
          return result;
        } catch (error) {
          assertActive();
          lastError = error;
          if (methods.length > 1) {
            this.logger.warn(`[inject] ${label} ${this.injectStrategy} 路径失败，尝试下一路径：${error.message}`);
          }
        }
      }
      if (attempt < this.injectRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * (attempt + 1))));
      }
    }
    throw lastError || new Error(`${label} 执行失败`);
  }

  async injectBootstrap(contextId) {
    if (this.bootstrapped.has(contextId) || this.closed) return;
    this.bootstrapped.add(contextId);
    const context = this.contexts.get(contextId);
    const configJson = JSON.stringify(this.configStore.settingsSnapshot());
    const silentPrefix = this.silentControl
      ? `window.__CX_WIN_SILENT__=${JSON.stringify(this.silentControl)};`
      : '';
    const prefix = `window.__CX_WIN_CONFIG_JSON__=${configJson};`
      + `window.__CX_WIN_INSTANCE__=${JSON.stringify(this.instanceToken)};`
      + silentPrefix
      + `window.addEventListener('chaoxing-plus:script-session-expired',function(){try{console.log(${JSON.stringify(MESSAGE_PREFIX)}+JSON.stringify({kind:'script-session-expired',detail:{}}));}catch(e){}});`
      + `window.__CX_WIN_STYLE_TEXT__=${JSON.stringify(this.assets.style || '')};\n`;
    try {
      await this.injectSource(contextId, prefix + this.assets.bootstrap, 'bootstrap 执行失败', { timeoutMs: this.bundleTimeoutMs });
      if (this.closed || this.contexts.get(contextId) !== context) return;
      this.stats.bootstraps += 1;
      this.diagnosticsReadyContexts.add(contextId);
      this.recordDiagnostic('bootstrap-ready', 'info', contextId);
      void this.broadcastDiagnostics();
    } catch (error) {
      if (error.code === 'CX_INJECTION_CANCELLED' || this.closed || this.contexts.get(contextId) !== context) return;
      this.bootstrapped.delete(contextId);
      this.recordDiagnostic('bootstrap-failed', 'error', contextId);
      this.recordError(`注入 bootstrap 失败 context=${contextId}：${error.message}`);
    }
  }

  async injectBundle(contextId) {
    if (this.closed || this.bundleLoaded.has(contextId)) return;
    if (this.bundlePending.has(contextId)) return this.bundlePending.get(contextId);
    if (!this.configStore.isEnabled()) return;
    if (!this.shouldInjectBundle(contextId)) {
      this.logger.info(`[session] 跳过非超星页面注入 context=${contextId} url=${this.frameUrlForContext(contextId) || 'about:blank'}`);
      return;
    }
    const version = this.assets.version ? JSON.stringify(this.assets.version) : '"dev"';
    const context = this.contexts.get(contextId);
    const suffix = `\n;window.__CX_WIN_BUNDLE_LOADED__=true;window.__CX_WIN_BUNDLE_VERSION__=${version};`;
    const injection = (async () => {
      try {
        await this.injectSource(contextId, this.assets.bundle + suffix, '业务 bundle 执行失败', { timeoutMs: this.bundleTimeoutMs });
        if (this.closed || this.contexts.get(contextId) !== context) return;
        this.bundleLoaded.add(contextId);
        this.stats.bundles += 1;
        this.recordDiagnostic('bundle-ready', 'info', contextId);
        void this.broadcastDiagnostics();
        this.logger.info(`[inject] 已注入业务 bundle：context=${contextId} url=${this.frameUrlForContext(contextId) || 'about:blank'}`);
        this.onBundleInjected?.(contextId, this.frameUrlForContext(contextId));
      } catch (error) {
        if (error.code === 'CX_INJECTION_CANCELLED' || this.closed || this.contexts.get(contextId) !== context) return;
        const message = String(error.message || error);
        // 导航过程中上下文被销毁是正常时序，不计入错误。
        if (/Cannot find context/i.test(message)) {
          this.logger.info(`[session] 上下文已随导航销毁，跳过 bundle：context=${contextId}`);
          return;
        }
        this.recordDiagnostic('bundle-failed', 'error', contextId);
        this.recordError(`注入业务 bundle 失败 context=${contextId}：${message}`);
      }
    })();
    this.bundlePending.set(contextId, injection);
    try {
      await injection;
    } finally {
      if (this.bundlePending.get(contextId) === injection) this.bundlePending.delete(contextId);
    }
  }

  scheduleRescan() {
    if (this.rescanTimer) return;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      if (this.closed || !this.connection || this.connection.closed) return;
      // 真实客户端上出现过“文档已导航但没收到 executionContextCreated”的时序；
      // 重新 Runtime.enable 让 CEF 重放现存上下文，再按事件去重注入。
      this.connection.send('Runtime.enable').catch((error) => {
        this.logger.warn(`[session] 上下文重扫失败：${error.message}`);
      });
    }, 1000);
  }

  // 顶层 frame 兜底：答题页等 SPA 场景下可能出现顶层 READY 丢失，
  // 导航后主动检查顶层上下文是否已注入 bootstrap/bundle，未注入则补注入。
  scheduleTopFrameEnsure() {
    if (this.topEnsureTimer) {
      clearTimeout(this.topEnsureTimer);
    }
    this.topEnsureTimer = setTimeout(() => {
      this.topEnsureTimer = null;
      void this.ensureTopFrameInjected();
    }, 2500);
  }

  async ensureTopFrameInjected() {
    if (this.closed || !this.connection || this.connection.closed) return;
    try {
      let contextId = this.getTopContextId();
      if (!contextId) {
        await this.connection.send('Runtime.enable').catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 400));
        contextId = this.getTopContextId();
      }
      if (!contextId) {
        this.logger.warn('[session] 顶层执行上下文未找到，跳过兜底注入');
        return;
      }
      const probe = await this.evaluateReturnByValue(
        contextId,
        "JSON.stringify({host:!!window.__CX_WIN_HOST__,loaded:!!window.__CX_WIN_BUNDLE_LOADED__})"
      ).catch(() => null);
      let state = {};
      try {
        state = JSON.parse((probe && probe.value) || '{}');
      } catch {
        state = {};
      }
      if (!state.host) {
        this.logger.info('[session] 顶层 frame 缺少 bootstrap，执行兜底注入');
        await this.injectBootstrap(contextId);
      }
      if (!state.loaded) {
        this.logger.info('[session] 顶层 frame 缺少业务 bundle，执行兜底注入');
        await this.injectBundle(contextId);
      } else {
        this.logger.info('[session] 顶层 frame 兜底检查通过（bootstrap/bundle 已注入）');
      }
    } catch (error) {
      this.logger.warn(`[session] 顶层 frame 兜底注入失败：${error.message}`);
    }
  }

  async broadcastConfig() {
    if (this.closed || !this.connection || this.connection.closed) return;
    const payloadJson = JSON.stringify({ kind: 'config', values: this.configStore.settingsSnapshot() });
    const expression = `try{window.__CX_WIN_ON_CONFIG__ && window.__CX_WIN_ON_CONFIG__(${payloadJson});}catch(e){}`;
    for (const contextId of [...this.bootstrapped]) {
      try {
        await this.evaluate(contextId, expression, { timeoutMs: 10000 });
      } catch (error) {
        this.recordDiagnostic('config-failed', 'warn', contextId);
        this.logger.warn(`[session] 广播配置失败 context=${contextId}：${error.message}`);
      }
      if (this.readyContexts.has(contextId)) {
        await this.injectBundle(contextId);
      }
    }
    void this.broadcastDiagnostics();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelDiagnosticRetry();
    this.diagnosticsReadyContexts.clear();
    this.diagnosticAcknowledged.clear();
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.topEnsureTimer) {
      clearTimeout(this.topEnsureTimer);
      this.topEnsureTimer = null;
    }
    if (this.connection && this.scriptIdentifier) {
      void this.connection.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: this.scriptIdentifier
      }).catch(() => {});
    }
    if (this.connection) this.connection.close();
  }
}
