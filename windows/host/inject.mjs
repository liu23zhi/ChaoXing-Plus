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

export class PageSession {
  constructor({ port, target, assets, configStore, instanceToken, injectBlankFrames, captureConsole, injectStrategy = 'hybrid', injectRetries = 2, bundleTimeoutMs = 120000, logger, onConfigSync, onBundleInjected }) {
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
    this.connection = null;
    this.scriptIdentifier = null;
    this.contexts = new Map();
    this.frameUrls = new Map();
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
    const connection = await CdpConnection.open(this.target.webSocketDebuggerUrl);
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

  async handleEvent(message) {
    if (this.closed || !message) return;
    if (message.method === 'cx.disconnected') {
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
      this.contexts.delete(contextId);
      this.bootstrapped.delete(contextId);
      this.readyContexts.delete(contextId);
      this.bundleLoaded.delete(contextId);
      this.bundlePending.delete(contextId);
      this.stats.contexts = this.contexts.size;
      return;
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      this.contexts.clear();
      this.bootstrapped.clear();
      this.readyContexts.clear();
      this.bundleLoaded.clear();
      this.bundlePending.clear();
      this.stats.contexts = 0;
      return;
    }
    if (message.method === 'Page.frameNavigated') {
      const frame = params.frame || {};
      if (frame.id) {
        this.frameUrls.set(frame.id, frame.url || '');
      }
      if (!frame.parentId) {
        this.topFrameId = frame.id || this.topFrameId;
        this.logger.info(`[nav] 顶层导航：${sanitizeForLog(frame.url || '')}`);
        this.scheduleTopFrameEnsure();
      }
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      this.handleConsoleEvent(params);
      return;
    }
    if (this.captureConsole && message.method === 'Runtime.exceptionThrown') {
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
      if (Number.isInteger(contextId) && contextId > 0) await this.injectBootstrap(contextId);
      return;
    }
    if (payload.kind === 'ready') {
      if (!Number.isInteger(contextId) || contextId <= 0) return;
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
      this.onConfigSync?.(detail);
      return;
    }
    if (payload.kind === 'bootstrap-error') {
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
    const prefix = `window.__CX_WIN_CONFIG_JSON__=${configJson};`
      + `window.__CX_WIN_INSTANCE__=${JSON.stringify(this.instanceToken)};`
      + `window.__CX_WIN_STYLE_TEXT__=${JSON.stringify(this.assets.style || '')};\n`;
    try {
      await this.injectSource(contextId, prefix + this.assets.bootstrap, 'bootstrap 执行失败');
      if (this.closed || this.contexts.get(contextId) !== context) return;
      this.stats.bootstraps += 1;
    } catch (error) {
      if (error.code === 'CX_INJECTION_CANCELLED') return;
      this.bootstrapped.delete(contextId);
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
    const suffix = `\n;window.__CX_WIN_BUNDLE_LOADED__=true;window.__CX_WIN_BUNDLE_VERSION__=${version};`;
    const injection = (async () => {
      try {
        await this.injectSource(contextId, this.assets.bundle + suffix, '业务 bundle 执行失败', { timeoutMs: this.bundleTimeoutMs });
        this.bundleLoaded.add(contextId);
        this.stats.bundles += 1;
        this.logger.info(`[inject] 已注入业务 bundle：context=${contextId} url=${this.frameUrlForContext(contextId) || 'about:blank'}`);
        this.onBundleInjected?.(contextId, this.frameUrlForContext(contextId));
      } catch (error) {
        if (error.code === 'CX_INJECTION_CANCELLED') return;
        const message = String(error.message || error);
        // 导航过程中上下文被销毁是正常时序，不计入错误。
        if (/Cannot find context/i.test(message)) {
          this.logger.info(`[session] 上下文已随导航销毁，跳过 bundle：context=${contextId}`);
          return;
        }
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
        this.logger.warn(`[session] 广播配置失败 context=${contextId}：${error.message}`);
      }
      if (this.readyContexts.has(contextId)) {
        await this.injectBundle(contextId);
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
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
