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
  constructor({ port, target, assets, configStore, instanceToken, injectBlankFrames, captureConsole, logger, onConfigSync, onBundleInjected }) {
    this.port = port;
    this.target = target;
    this.assets = assets;
    this.configStore = configStore;
    this.instanceToken = instanceToken;
    this.injectBlankFrames = injectBlankFrames;
    this.captureConsole = captureConsole;
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
    this.connection = await CdpConnection.open(this.target.webSocketDebuggerUrl);
    this.connection.onEvent((message) => {
      void this.handleEvent(message);
    });
    // 先取 frame 树再开 Runtime：避免 executionContextCreated 先到、frameUrl 还没映射导致误判页面类型。
    await this.connection.send('Page.enable');
    await this.refreshFrameTree();
    await this.connection.send('Runtime.enable');
    const registration = await this.connection.send('Page.addScriptToEvaluateOnNewDocument', {
      source: this.assets.trampoline
    });
    this.scriptIdentifier = registration && registration.identifier ? registration.identifier : null;
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
      return;
    }
    const params = message.params || {};
    if (message.method === 'Runtime.executionContextCreated') {
      const context = params.context || {};
      const auxData = context.auxData || {};
      if (context.id > 0 && auxData.isDefault === true) {
        this.contexts.set(context.id, {
          frameId: auxData.frameId || '',
          origin: context.origin || ''
        });
        this.stats.contexts = this.contexts.size;
        this.logger.info(`[context] id=${context.id} frame=${auxData.frameId || ''} origin=${context.origin || ''}`);
        await this.injectBootstrap(context.id);
      }
      return;
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      this.contexts.clear();
      this.bootstrapped.clear();
      this.readyContexts.clear();
      this.bundleLoaded.clear();
      return;
    }
    if (message.method === 'Page.frameNavigated') {
      const frame = params.frame || {};
      if (frame.id) {
        this.frameUrls.set(frame.id, frame.url || '');
      }
      if (!frame.parentId) {
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

  async injectBootstrap(contextId) {
    if (this.bootstrapped.has(contextId) || this.closed) return;
    this.bootstrapped.add(contextId);
    const configJson = JSON.stringify(this.configStore.settingsSnapshot());
    const prefix = `window.__CX_WIN_CONFIG_JSON__=${configJson};`
      + `window.__CX_WIN_INSTANCE__=${JSON.stringify(this.instanceToken)};`
      + `window.__CX_WIN_STYLE_TEXT__=${JSON.stringify(this.assets.style || '')};\n`;
    try {
      await this.evaluateOrThrow(contextId, prefix + this.assets.bootstrap, 'bootstrap 执行失败');
      this.stats.bootstraps += 1;
    } catch (error) {
      this.bootstrapped.delete(contextId);
      this.recordError(`注入 bootstrap 失败 context=${contextId}：${error.message}`);
    }
  }

  async injectBundle(contextId) {
    if (this.closed || this.bundleLoaded.has(contextId)) return;
    if (!this.configStore.isEnabled()) return;
    if (!this.shouldInjectBundle(contextId)) {
      this.logger.info(`[session] 跳过非超星页面注入 context=${contextId} url=${this.frameUrlForContext(contextId) || 'about:blank'}`);
      return;
    }
    const version = this.assets.version ? JSON.stringify(this.assets.version) : '"dev"';
    const suffix = `\n;window.__CX_WIN_BUNDLE_LOADED__=true;window.__CX_WIN_BUNDLE_VERSION__=${version};`;
    try {
      await this.evaluateOrThrow(contextId, this.assets.bundle + suffix, '业务 bundle 执行失败', { timeoutMs: 120000 });
      this.bundleLoaded.add(contextId);
      this.stats.bundles += 1;
      this.logger.info(`[inject] 已注入业务 bundle：context=${contextId} url=${this.frameUrlForContext(contextId) || 'about:blank'}`);
      this.onBundleInjected?.(contextId, this.frameUrlForContext(contextId));
    } catch (error) {
      const message = String(error.message || error);
      // 导航过程中上下文被销毁是正常时序，不计入错误。
      if (/Cannot find context/i.test(message)) {
        this.logger.info(`[session] 上下文已随导航销毁，跳过 bundle：context=${contextId}`);
        return;
      }
      this.recordError(`注入业务 bundle 失败 context=${contextId}：${message}`);
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
    const settingsJson = JSON.stringify(this.configStore.settingsSnapshot());
    const expression = `try{window.__CX_WIN_ON_CONFIG__ && window.__CX_WIN_ON_CONFIG__(${settingsJson});}catch(e){}`;
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
