/* Windows 端：页面侧 bootstrap（由宿主通过 CDP Runtime.evaluate 注入）。
 *
 * 职责（对齐 extension-entry.js 的平台无关部分）：
 *  1. Chrome75 缺失 API 的补丁（replaceChildren / Promise.allSettled / crypto.randomUUID）；
 *  2. 把宿主持久化的共享配置写入 localStorage 与 documentElement 属性，供业务 runtimeStore 读取；
 *  3. 建立页面 -> 宿主的消息通道（console 前缀通道，Chrome75 可用且无需 Runtime.addBinding）；
 *  4. 在 DOMContentLoaded 后通知宿主注入业务 bundle；
 *  5. 监听业务 store 的同步事件，把变更回传宿主持久化并广播到其它 origin/frame。
 *
 * 宿主在注入本文件前会先设置：
 *   window.__CX_WIN_CONFIG_JSON__  —— 共享配置快照（对象）
 *   window.__CX_WIN_INSTANCE__     —— 本次宿主运行的唯一标识
 *   window.__CX_WIN_STYLE_TEXT__   —— 需要注入的样式（SweetAlert2 CSS，字符串）
 *
 * 语言级别保持 ES5，客户端内核为 CEF/Chromium 75（不支持 ?. / ??）。
 */
(function () {
  'use strict';

  var BOOTSTRAP_VERSION = '1.0.0';
  var win = window;
  var doc = document;
  var MESSAGE_PREFIX = '__CX_WIN_MSG__';
  var MARK_KEY = '__CX_WIN_MARK__';
  var BUNDLE_KEY = '__CX_WIN_BUNDLE_LOADED__';
  var HOST_KEY = '__CX_WIN_HOST__';
  var STYLE_ID = 'chaoxing-plus-windows-swal-style';
  var HYDRATE_EVENT = 'chaoxing-plus:shared-store-hydrate';
  var REMOVE_EVENT = 'chaoxing-plus:shared-store-remove';
  var SYNC_EVENT = 'chaoxing-plus:shared-store-sync';
  var DIAGNOSTICS_EVENT = 'chaoxing-plus:windows-host-diagnostics';
  var diagnosticsEntries = [];
  var DIAGNOSTICS_CODES = [
    'host-started', 'client-started', 'endpoint-waiting', 'endpoint-ready',
    'session-connected', 'session-reconnected', 'session-retry', 'bootstrap-ready',
    'bootstrap-failed', 'bundle-ready', 'bundle-failed', 'config-updated',
    'config-failed', 'page-error', 'top-navigated'
  ];
  var ENABLED_KEY = 'common.settings.extension-enabled';
  var PANEL_ENABLED_KEY = 'common.settings.windows-panel-enabled';
  var PANEL_THEME_KEY = 'common.settings.windows-panel-theme';
  var NO_DISK_WRITE_KEY = 'common.settings.windows-no-disk-write';
  var noDiskWriteEnabled = false;
  var SHARED_STORE_PREFIXES = [
    'common.settings.',
    'cx.new.study.',
    'cx.new.work.',
    'cx.new.auto-read.',
    'cx.new.study-dispatcher.'
  ];
  var SHARED_STORE_EXCLUDED_KEYS = ['common.work-results.results'];
  var SHARED_STORE_EXACT_KEYS = ['common.apps.question-caches'];

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return undefined;
    }
  }

  function send(kind, detail) {
    try {
      if (typeof console === 'undefined' || typeof console.log !== 'function') {
        return;
      }
      console.log(MESSAGE_PREFIX + safeStringify({ source: 'chaoxing-plus-windows', instance: instance, kind: kind, detail: detail }));
    } catch (error) {
      // 页面可能代理/禁用了 console；宿主会根据 ready 超时给出诊断。
    }
  }

  var silentFullscreenState = null;
  var silentControlInstalled = false;
  function silentShortcutFor(event) {
    var parts = [];
    if (event.ctrlKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey) parts.push('shift');
    if (event.metaKey) parts.push('meta');
    var key = String(event.key || '');
    if (!key) return '';
    if (key.length === 1) key = key.toUpperCase();
    if (key === 'Esc') key = 'Escape';
    parts.push(key);
    return parts.join('+');
  }
  function silentIsFullscreen() {
    if (doc.fullscreenElement || doc.webkitFullscreenElement) return true;
    var screenWidth = Number(win.screen && win.screen.width);
    var screenHeight = Number(win.screen && win.screen.height);
    if (!screenWidth || !screenHeight) return false;
    return win.innerWidth >= screenWidth - 4 && win.innerHeight >= screenHeight - 4;
  }
  function reportSilentFullscreen(force) {
    var next = silentIsFullscreen();
    if (!force && next === silentFullscreenState) return;
    silentFullscreenState = next;
    send('silent-fullscreen', { fullscreen: next, pid: Number(win.__CX_WIN_SILENT__ && win.__CX_WIN_SILENT__.clientPid) || 0 });
  }
  function installSilentControl() {
    if (silentControlInstalled) return;
    var silent = win.__CX_WIN_SILENT__;
    if (!silent || typeof silent !== "object") return;
    // 只有顶层文档可以上报静默热键/全屏状态：答题页会注入大量 about:blank
    // iframe，子 frame 的 innerWidth/innerHeight 永远小于屏幕，一旦把它当成
    // "已退出全屏"就会在考试进行中误触发自毁。
    try {
      if (win.self !== win.top) return;
    } catch (error) {
      return;
    }
    silentControlInstalled = true;
    var keys = Array.isArray(silent.selfDestructKeys) ? silent.selfDestructKeys : [];
    try {
      win.addEventListener('keydown', function (event) {
        if (!event || event.repeat) return;
        var shortcut = silentShortcutFor(event);
        if (!shortcut) return;
        for (var i = 0; i < keys.length; i += 1) {
          if (String(keys[i]).toLowerCase() === shortcut.toLowerCase()) {
            try { event.preventDefault(); } catch (ignore) {}
            try { event.stopPropagation(); } catch (ignore2) {}
            send('silent-hotkey', { shortcut: shortcut });
            return;
          }
        }
      }, true);
    } catch (error) { /* ignore */ }
    try {
      win.addEventListener('resize', function () { reportSilentFullscreen(false); });
      doc.addEventListener('fullscreenchange', function () { reportSilentFullscreen(false); });
      doc.addEventListener('webkitfullscreenchange', function () { reportSilentFullscreen(false); });
      setInterval(function () { reportSilentFullscreen(false); }, 1000);
    } catch (error2) { /* ignore */ }
    reportSilentFullscreen(true);
  }

  function notifyDiagnostics() {
    try {
      var CustomEventCtor = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : undefined);
      if (typeof CustomEventCtor === 'function') {
        doc.dispatchEvent(new CustomEventCtor(DIAGNOSTICS_EVENT));
      }
    } catch (error) {
      // Diagnostics remain readable even when a page blocks custom events.
    }
  }

  function copyDiagnostics() {
    return diagnosticsEntries.map(function (entry) {
      return { sequence: entry.sequence, elapsedMs: entry.elapsedMs, level: entry.level, code: entry.code };
    });
  }

  function setDiagnostics(snapshot) {
    try {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || snapshot.source !== 'chaoxing-plus-windows-host'
        || !instance || snapshot.instance !== instance
        || !Array.isArray(snapshot.entries) || snapshot.entries.length > 100) {
        return false;
      }
      var entries = [];
      var previousSequence = 0;
      var index;
      for (index = 0; index < snapshot.entries.length; index += 1) {
        var entry = snapshot.entries[index];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || typeof entry.sequence !== 'number' || !isFinite(entry.sequence)
          || Math.floor(entry.sequence) !== entry.sequence || entry.sequence <= previousSequence
          || entry.sequence > 9007199254740991
          || typeof entry.elapsedMs !== 'number' || !isFinite(entry.elapsedMs)
          || entry.elapsedMs < 0 || entry.elapsedMs > 9007199254740991
          || (entry.level !== 'info' && entry.level !== 'warn' && entry.level !== 'error')
          || DIAGNOSTICS_CODES.indexOf(entry.code) === -1) {
          return false;
        }
        previousSequence = entry.sequence;
        entries.push({ sequence: entry.sequence, elapsedMs: entry.elapsedMs, level: entry.level, code: entry.code });
      }
      if (safeStringify(entries) !== safeStringify(diagnosticsEntries)) {
        diagnosticsEntries = entries;
        notifyDiagnostics();
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  function currentLocation() {
    var origin = '';
    var path = '';
    var href = '';
    try {
      href = String((win.location && win.location.href) || '');
      origin = String((win.location && win.location.origin) || '');
      path = String((win.location && win.location.pathname) || '');
    } catch (error) {
      // about:blank / 跨源容器可能抛错，保持空串。
    }
    return { href: href, origin: origin, path: path };
  }

  function isSharedStoreKey(key) {
    if (typeof key !== 'string' || !key) {
      return false;
    }
    var index;
    for (index = 0; index < SHARED_STORE_EXCLUDED_KEYS.length; index += 1) {
      if (SHARED_STORE_EXCLUDED_KEYS[index] === key) {
        return false;
      }
    }
    for (index = 0; index < SHARED_STORE_EXACT_KEYS.length; index += 1) {
      if (SHARED_STORE_EXACT_KEYS[index] === key) {
        return true;
      }
    }
    for (index = 0; index < SHARED_STORE_PREFIXES.length; index += 1) {
      if (key.indexOf(SHARED_STORE_PREFIXES[index]) === 0) {
        return true;
      }
    }
    return false;
  }

  function sharedAttributeName(key) {
    return 'data-chaoxing-plus-shared-' + key.replace(/[^a-z0-9_-]/gi, '-');
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function collectSharedValues(values) {
    var result = {};
    if (!values || typeof values !== 'object') {
      return result;
    }
    var keys = Object.keys(values);
    var index;
    for (index = 0; index < keys.length; index += 1) {
      if (isSharedStoreKey(keys[index])) {
        result[keys[index]] = values[keys[index]];
      }
    }
    return result;
  }

  function writeLocalStorage(values) {
    if (noDiskWriteEnabled) {
      return;
    }
    try {
      if (!win.localStorage) {
        return;
      }
      var keys = Object.keys(values);
      var index;
      for (index = 0; index < keys.length; index += 1) {
        var serialized = safeStringify(values[keys[index]]);
        if (typeof serialized === 'string') {
          win.localStorage.setItem(keys[index], serialized);
        }
      }
    } catch (error) {
      // 不透明 origin（about:blank 等）访问 localStorage 会抛错，忽略即可。
    }
  }

  function writeDocumentAttributes(values) {
    var root = doc.documentElement;
    if (!root) {
      return false;
    }
    var keys = Object.keys(values);
    var index;
    for (index = 0; index < keys.length; index += 1) {
      var serialized = safeStringify(values[keys[index]]);
      if (typeof serialized !== 'string') {
        continue;
      }
      try {
        root.setAttribute(sharedAttributeName(keys[index]), serialized);
      } catch (error) {
        // 属性写入失败不影响 localStorage 主路径。
      }
    }
    return true;
  }

  function dispatchHydrate(values) {
    if (!values || Object.keys(values).length === 0) {
      return;
    }
    try {
      var CustomEventCtor = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : undefined);
      if (typeof CustomEventCtor === 'function') {
        doc.dispatchEvent(new CustomEventCtor(HYDRATE_EVENT, { detail: values }));
      }
    } catch (error) {
      // 事件派发失败时业务仍能从 localStorage 读到值。
    }
  }

  function applySharedValues(values, dispatch) {
    var shared = collectSharedValues(values);
    if (Object.keys(shared).length === 0) {
      return shared;
    }
    writeLocalStorage(shared);
    var attributesWritten = writeDocumentAttributes(shared);
    if (!attributesWritten) {
      pendingAttributeValues = merge(pendingAttributeValues, shared);
    }
    if (dispatch) {
      dispatchHydrate(shared);
    }
    return shared;
  }

  function removeSharedValues(keys) {
    if (keys.length === 0) {
      return;
    }
    var index;
    for (index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      delete pendingAttributeValues[key];
      try {
        if (doc.documentElement) {
          doc.documentElement.removeAttribute(sharedAttributeName(key));
        }
      } catch (error) {
        // A missing document element must not retain a queued stale value.
      }
      if (!noDiskWriteEnabled) {
        try {
          win.localStorage.removeItem(key);
        } catch (error) {
          // Opaque origins may not expose localStorage.
        }
      }
    }
    try {
      var CustomEventCtor = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : undefined);
      if (typeof CustomEventCtor === 'function') {
        doc.dispatchEvent(new CustomEventCtor(REMOVE_EVENT, { detail: keys }));
      }
    } catch (error) {
      // Keep the bridge usable when page events are unavailable.
    }
  }

  var pendingAttributeValues = {};

  function merge(base, extra) {
    var result = {};
    var key;
    for (key in base) {
      if (hasOwn(base, key)) {
        result[key] = base[key];
      }
    }
    for (key in extra) {
      if (hasOwn(extra, key)) {
        result[key] = extra[key];
      }
    }
    return result;
  }

  function installPolyfills() {
    try {
      var elementProto = win.Element && win.Element.prototype;
      if (elementProto && typeof elementProto.replaceChildren !== 'function') {
        elementProto.replaceChildren = function replaceChildren() {
          var index;
          while (this.firstChild) {
            this.removeChild(this.firstChild);
          }
          for (index = 0; index < arguments.length; index += 1) {
            var node = arguments[index];
            if (node === null || node === undefined) {
              continue;
            }
            if (node.nodeType) {
              this.appendChild(node);
            } else {
              this.appendChild(doc.createTextNode(String(node)));
            }
          }
        };
      }
    } catch (error) {
      // 老内核缺少 Element 时忽略。
    }

    try {
      var PromiseCtor = win.Promise;
      if (typeof PromiseCtor === 'function' && typeof PromiseCtor.allSettled !== 'function') {
        PromiseCtor.allSettled = function allSettled(iterable) {
          var list = Array.prototype.slice.call(iterable || []);
          return PromiseCtor.all(list.map(function (item) {
            return PromiseCtor.resolve(item).then(
              function (value) { return { status: 'fulfilled', value: value }; },
              function (reason) { return { status: 'rejected', reason: reason }; }
            );
          }));
        };
      }
    } catch (error) {
      // ignore
    }

    try {
      var cryptoObj = win.crypto;
      if (cryptoObj && typeof cryptoObj.randomUUID !== 'function' && typeof cryptoObj.getRandomValues === 'function') {
        cryptoObj.randomUUID = function randomUUID() {
          var bytes = new (win.Uint8Array || Uint8Array)(16);
          cryptoObj.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
          var hex = [];
          var index;
          for (index = 0; index < bytes.length; index += 1) {
            hex.push((bytes[index] + 0x100).toString(16).slice(1));
          }
          return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('')
            + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
        };
      }
    } catch (error) {
      // ignore
    }
  }

  function ensureStyle() {
    var css = win.__CX_WIN_STYLE_TEXT__;
    if (typeof css !== 'string' || !css || doc.getElementById(STYLE_ID)) {
      return;
    }
    try {
      var style = doc.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-source', 'chaoxing-plus-windows');
      style.appendChild(doc.createTextNode(css));
      var parent = doc.head || doc.documentElement;
      if (parent) {
        parent.appendChild(style);
      }
    } catch (error) {
      // 样式失败不阻塞业务，SweetAlert2 有默认样式兜底。
    }
  }

  function isTopWindow() {
    try {
      return win.self === win.top;
    } catch (error) {
      return false;
    }
  }

  // ---- Windows 考试面板：提前挂载折叠壳 ----
  // 宿主只在 CEF75 客户端注入本文件；跨页面跳转时新文档一加载就立刻出现同款折叠标题条，
  // 业务 bundle 稍后接管同一个 DOM 节点，避免“面板反复消失/出现”。扩展端不使用本文件。
  var PANEL_SHELL_ID = 'panel-common-work-results';
  var EXAM_URL_PATTERNS = [
    /\/exam-ans\//i,
    /\/exam\/test\//i,
    /\/mooc2\/exam/i,
    /\/reVersionTestStartNew/i,
    /\/examcode\//i
  ];

  function panelAllPagesForced() { return window.__CX_WIN_PANEL_ALL_PAGES__ === true; }
function isExamRelatedUrl(url) {
    if (typeof url !== 'string' || url.length === 0) {
      return false;
    }
    var index;
    for (index = 0; index < EXAM_URL_PATTERNS.length; index += 1) {
      if (EXAM_URL_PATTERNS[index].test(url)) {
        return true;
      }
    }
    return false;
  }

  function findPanelById(id) {
    try {
      return doc.getElementById ? doc.getElementById(id) : null;
    } catch (error) {
      return null;
    }
  }

  // ---- 拍照窗口期隐藏面板 ----
  // 客户端自己的取证抓屏（server 端 GetScreenImage）会先把自己窗口的 WDA_MONITOR 关掉，
  // 再 GetDC(NULL) 拷整屏，页面里的悬浮面板会被一起拍进去并上传。宿主监测到亲和力 1 -> 0 的
  // 跳变时把 __CX_WIN_CAPTURE_GUARD__ 置真并调用下面的函数，这里立刻隐藏面板壳；跳回来再恢复。
  function applyCaptureGuard() {
    var hidden = win.__CX_WIN_CAPTURE_GUARD__ === true;
    try {
      if (hidden) {
        doc.documentElement.setAttribute('data-cx-win-capture', 'hide');
      } else {
        doc.documentElement.removeAttribute('data-cx-win-capture');
      }
    } catch (error) {
      // ignore attribute failures
    }
    var shell = findPanelById(PANEL_SHELL_ID);
    if (shell) {
      try {
        shell.style.display = hidden ? 'none' : '';
      } catch (error) {
        // ignore style failures
      }
    }
  }
  win.__CX_WIN_APPLY_CAPTURE_GUARD__ = applyCaptureGuard;

  function createShellHeader() {
    var header = doc.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.gap = '12px';
    header.style.margin = '-14px -14px 0';
    header.style.padding = '14px 14px 12px';
    // 先用 pink 占位；applyPanelShellTheme 会按当前 --panel-theme 覆盖为同主题色，
    // 避免蓝/绿主题下展开前后出现粉色头。
    header.style.borderBottom = '1px solid rgba(244, 114, 182, 0.24)';
    header.style.background = '#fffafd';
    header.style.boxShadow = '0 6px 16px rgba(190, 24, 93, 0.08)';
    header.style.borderRadius = '24px 24px 0 0';
    header.style.cursor = 'pointer';

    var title = doc.createElement('div');
    title.textContent = '超星学习助手';
    title.style.fontSize = '13px';
    title.style.fontWeight = '800';
    title.style.color = '#7a1039';
    title.style.letterSpacing = '0.02em';

    var hint = doc.createElement('div');
    hint.textContent = '点击展开 · 可拖动';
    hint.style.fontSize = '12px';
    hint.style.color = '#8a1a4d';

    header.appendChild(title);
    header.appendChild(hint);
    header.addEventListener('click', function onShellClick() {
      // 业务 bundle 接管后会读取该标记并直接展开，避免用户点击被丢弃。
      try {
        win.__CX_WIN_SHELL_EXPAND_REQUESTED__ = true;
      } catch (error) {
        // ignore
      }
      hint.textContent = '加载中…';
    });
    return header;
  }

  function mountPanelShell() {
    if (!isTopWindow() || (!isExamRelatedUrl(currentLocation().href) && !panelAllPagesForced()) || !isEnabled() || !isPanelEnabled()) {
      return;
    }
    if (findPanelById(PANEL_SHELL_ID)) {
      return;
    }
    var root;
    try {
      root = doc.createElement('div');
      root.id = PANEL_SHELL_ID;
      root.setAttribute('data-cx-win-panel-shell', '1');
      root.style.position = 'fixed';
      root.style.top = getPanelNumber('common.settings.windows-panel-top', 16, 0, 10000) + 'px';
      root.style.right = getPanelNumber('common.settings.windows-panel-right', 16, 0, 10000) + 'px';
      root.style.zIndex = '2147483645';
      // 与业务侧一致用 border-box 并限制不超过视口：小屏下折叠壳同样不能溢出。
      var shellWidth = getPanelNumber('common.settings.windows-panel-width', 460, 320, 800);
      root.style.width = shellWidth + 'px';
      root.style.maxWidth = 'calc(100vw - 24px)';
      root.style.padding = '14px';
      root.style.boxSizing = 'border-box';
      root.style.borderRadius = '24px';
      root.style.fontFamily = '"Microsoft YaHei", "PingFang SC", -apple-system, sans-serif';
      root.appendChild(createShellHeader());
      // 主题必须在 header 挂上之后再应用：头部颜色也由色板决定。
      applyPanelShellTheme(root);
      var parent = doc.body || doc.documentElement;
      if (!parent) {
        return;
      }
      parent.appendChild(root);
      // 如果宿主已经在拍照窗口期，新挂载的壳也要立刻隐藏。
      applyCaptureGuard();
    } catch (error) {
      send('bootstrap-error', { stage: 'panel-shell', message: String((error && error.message) || error) });
      return;
    }

    // 与业务侧一致的 owner 标记，保证后续顶层判断稳定。
    try {
      var rootEl = doc.documentElement;
      if (rootEl && !rootEl.getAttribute('data-chaoxing-plus-panel-owner')) {
        rootEl.setAttribute('data-chaoxing-plus-panel-owner', currentLocation().href);
      }
    } catch (error) {
      // ignore
    }

    // 页面 SPA 可能替换 body 移除 shell；壳被移除时自动重挂载（业务接管后为同一节点，不会重复）。
    try {
      if (win.MutationObserver) {
        var shellObserver = new win.MutationObserver(function keepPanelShell() {
          try {
            if (root.parentNode) {
              return;
            }
            if (findPanelById(PANEL_SHELL_ID)) {
              return;
            }
            var parentNow = doc.body || doc.documentElement;
            if (parentNow) {
              parentNow.appendChild(root);
            }
          } catch (error) {
            // ignore
          }
        });
        shellObserver.observe(doc.documentElement, { childList: true, subtree: true });
      }
    } catch (error) {
      // ignore shell observer failures
    }

    send('panel-shell', { url: currentLocation().href, collapsed: true });
  }

  // 面板生命周期观测（仅顶层 frame）：面板被页面 SPA 移除、或面板 owner 变化时上报宿主，
  // 用于诊断“进入答题后面板消失”。不修改 DOM。
  function installPanelLifecycleObserver() {
    if (!isTopWindow() || !isPanelEnabled()) {
      return;
    }
    var lastCount = -1;
    var lastVisible = -1;

    function snapshot() {
      var panels = [];
      try {
        panels = Array.prototype.slice.call(doc.querySelectorAll('[id^="panel-"], [data-chaoxing-plus-theme="pink"]'));
      } catch (error) {
        panels = [];
      }
      var visible = 0;
      for (var index = 0; index < panels.length; index += 1) {
        try {
          var style = win.getComputedStyle ? win.getComputedStyle(panels[index]) : null;
          if (!style || style.display !== 'none') {
            visible += 1;
          }
        } catch (error) {
          visible += 1;
        }
      }
      var owner = '';
      try {
        owner = doc.documentElement ? (doc.documentElement.getAttribute('data-chaoxing-plus-panel-owner') || '') : '';
      } catch (error) {
        owner = '';
      }
      return {
        count: panels.length,
        visible: visible,
        owner: owner,
        bodyChildren: doc.body ? doc.body.children.length : 0
      };
    }

    function report(kind, extra) {
      var state = snapshot();
      var detail = {
        count: state.count,
        visible: state.visible,
        owner: state.owner,
        bodyChildren: state.bodyChildren,
        previousCount: lastCount,
        previousVisible: lastVisible
      };
      if (extra) {
        for (var key in extra) {
          if (hasOwn(extra, key)) {
            detail[key] = extra[key];
          }
        }
      }
      send(kind, detail);
    }

    try {
      var observer = new win.MutationObserver(function () {
        var state = snapshot();
        if (state.count !== lastCount || state.visible !== lastVisible) {
          var removed = lastCount > state.count ? lastCount - state.count : 0;
          lastCount = state.count;
          lastVisible = state.visible;
          report('panel-state', { removed: removed });
        }
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    } catch (error) {
      send('bootstrap-error', { stage: 'panel-observer', message: String((error && error.message) || error) });
    }

    try {
      if (win.MutationObserver) {
        var ownerObserver = new win.MutationObserver(function () {
          var state = snapshot();
          send('panel-owner-change', { owner: state.owner, count: state.count });
        });
        ownerObserver.observe(doc.documentElement, {
          attributes: true,
          attributeFilter: ['data-chaoxing-plus-panel-owner']
        });
      }
    } catch (error) {
      // ignore owner observer failures
    }

    var initial = snapshot();
    lastCount = initial.count;
    lastVisible = initial.visible;
    report('panel-state', { initial: true });
  }

  function isEnabled() {
    return config[ENABLED_KEY] !== false;
  }

  function isPanelEnabled() {
    return config[PANEL_ENABLED_KEY] !== false;
  }

  function getPanelNumber(key, fallback, minimum, maximum) {
    var value = Number(config[key]);
    if (!isFinite(value)) {
      return fallback;
    }
    return Math.max(minimum, Math.min(maximum, value));
  }

  // 与 src/projects/common.ts 的 pink/blue/green 色板保持一致；bootstrap 先于业务包
  // 挂载折叠壳，必须用当前主题着色，避免展开前出现粉色闪壳。未知名称回退 pink。
  // text/muted 必须与业务侧同值：折叠壳在展开前是唯一的可见文字面。
  var PANEL_THEME_STYLES = {
    pink: {
      gradient: 'linear-gradient(145deg, #fff0f7 0%, #fffafd 48%, #ffecf4 100%)',
      border: '1px solid rgba(219, 39, 119, 0.34)',
      shadow: '0 10px 28px rgba(190, 24, 93, 0.16), 0 2px 8px rgba(190, 24, 93, 0.10)',
      text: '#7a1039',
      muted: '#8a1a4d',
      headerBackground: '#fffafd'
    },
    blue: {
      gradient: 'linear-gradient(145deg, #f0f6ff 0%, #fbfdff 48%, #eaf2ff 100%)',
      border: '1px solid rgba(37, 99, 235, 0.34)',
      shadow: '0 10px 28px rgba(30, 64, 175, 0.16), 0 2px 8px rgba(30, 64, 175, 0.10)',
      text: '#152e6b',
      muted: '#1a3fa0',
      headerBackground: '#f8fbff'
    },
    green: {
      gradient: 'linear-gradient(145deg, #ecfdf5 0%, #f9fffc 48%, #d1fae5 100%)',
      border: '1px solid rgba(5, 150, 105, 0.34)',
      shadow: '0 10px 28px rgba(6, 78, 59, 0.16), 0 2px 8px rgba(6, 78, 59, 0.10)',
      text: '#04392b',
      muted: '#035743',
      headerBackground: '#f7fffb'
    }
  };

  function getPanelThemeName() {
    var raw = typeof config[PANEL_THEME_KEY] === 'string' ? config[PANEL_THEME_KEY].trim().toLowerCase() : '';
    return hasOwn(PANEL_THEME_STYLES, raw) ? raw : 'pink';
  }

  function applyPanelShellTheme(root) {
    if (!root) {
      return;
    }
    var style = PANEL_THEME_STYLES[getPanelThemeName()];
    root.setAttribute('data-chaoxing-plus-theme', getPanelThemeName());
    root.style.background = style.gradient;
    root.style.border = style.border;
    root.style.boxShadow = style.shadow;
    root.style.color = style.text;
    // 折叠壳的头部与业务侧 header 同色，展开前后不跳色。
    var header = root.firstChild;
    if (header && header.style) {
      header.style.background = style.headerBackground;
      header.style.borderBottom = '1px solid ' + style.border.replace(/^1px solid /, '');
      var children = header.children || [];
      if (children[0] && children[0].style) {
        children[0].style.color = style.text;
      }
      if (children[1] && children[1].style) {
        children[1].style.color = style.muted;
      }
    }
  }

  function onMessageFromHost(payload) {
    if (!payload) {
      return;
    }
    if (payload.kind === 'config') {
      var wasEnabled = isEnabled();
      var wasPanelEnabled = isPanelEnabled();
      var values = payload.values || {};
      var removedKeys = [];
      if (payload.replace === true) {
        values = collectSharedValues(values);
        var previousKeys = Object.keys(collectSharedValues(config));
        var index;
        for (index = 0; index < previousKeys.length; index += 1) {
          if (!hasOwn(values, previousKeys[index])) {
            removedKeys.push(previousKeys[index]);
          }
        }
        config = values;
      } else {
        config = merge(config, values);
      }
      noDiskWriteEnabled = config[NO_DISK_WRITE_KEY] === true;
      // Hydrate the current write policy before runtimeStore handles removals.
      applySharedValues(values, true);
      removeSharedValues(removedKeys);
      // 已挂载的折叠壳同步刷新主题；业务包尚未加载时也能立即跟随 --panel-theme。
      try {
        applyPanelShellTheme(findPanelById(PANEL_SHELL_ID));
      } catch (error) {
        // ignore shell theme refresh failures
      }
      if (wasEnabled !== isEnabled() || wasPanelEnabled !== isPanelEnabled()) {
        // 与扩展行为一致：总开关变化后顶层刷新，让业务脚本按新状态重新注入。
        try {
          if (win.top === win) {
            win.location.reload();
          }
        } catch (error) {
          // ignore
        }
      }
      return;
    }
    if (payload.kind === 'ping') {
      send('pong', { version: BOOTSTRAP_VERSION });
    }
  }

  function whenDomReady(callback) {
    try {
      if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', callback, { once: true });
        return;
      }
    } catch (error) {
      // ignore
    }
    callback();
  }

  // ---- 启动 ----
  var config = {};
  try {
    if (win.__CX_WIN_CONFIG_JSON__ && typeof win.__CX_WIN_CONFIG_JSON__ === 'object') {
      config = win.__CX_WIN_CONFIG_JSON__;
    }
  } catch (error) {
    config = {};
  }
  noDiskWriteEnabled = config[NO_DISK_WRITE_KEY] === true;

  var instance = '';
  try {
    instance = String(win.__CX_WIN_INSTANCE__ || '');
  } catch (error) {
    instance = '';
  }

  var locationInfo = currentLocation();
  var markValue = instance + '|' + locationInfo.href;

  try {
    if (win[MARK_KEY] === markValue) {
      // 宿主重连会更新快照，复用原配置桥同步其闭包，避免重复安装监听和面板。
      try {
        if (typeof win.__CX_WIN_ON_CONFIG__ === 'function') {
          win.__CX_WIN_ON_CONFIG__({ kind: 'config', values: config, replace: true });
        }
      } catch (error) {
        send('bootstrap-error', { stage: 'rehydrate-config', message: String((error && error.message) || error) });
      }
      return;
    }
    win[MARK_KEY] = markValue;
  } catch (error) {
    // 无法写标记时继续，宿主侧也有 context 级别去重。
  }

  installPolyfills();

  // 尽早挂载折叠面板壳（仅 Windows 考试相关页面、仅顶层 frame）。
  mountPanelShell();

  if (win[HOST_KEY]) {
    // A new native host must update the original bridge's sending closure.
    if (typeof win[HOST_KEY].adoptInstance === 'function') {
      win[HOST_KEY].adoptInstance(instance, config);
    }
    whenDomReady(function () {
      mountPanelShell();
      send('ready', { origin: locationInfo.origin, path: locationInfo.path, version: BOOTSTRAP_VERSION });
    });
    return;
  }

  win[HOST_KEY] = {
    version: BOOTSTRAP_VERSION,
    instance: instance,
    send: send,
    log: function log(message) {
      send('log', { message: String(message) });
    },
    getConfig: function getConfig() {
      return config;
    },
    setDiagnostics: setDiagnostics,
    getDiagnostics: copyDiagnostics,
    adoptInstance: function adoptInstance(nextInstance, nextConfig) {
      var normalizedInstance = String(nextInstance || '');
      var changedInstance = normalizedInstance !== instance;
      instance = normalizedInstance;
      win[HOST_KEY].instance = instance;
      if (changedInstance) {
        diagnosticsEntries = [];
        notifyDiagnostics();
      }
      onMessageFromHost({ kind: 'config', values: nextConfig, replace: true });
    },
    requestBundle: function requestBundle() {
      send('ready', { origin: locationInfo.origin, path: locationInfo.path, version: BOOTSTRAP_VERSION, recheck: true });
    }
  };

  win.__CX_WIN_ON_CONFIG__ = function onConfig(json) {
    try {
      onMessageFromHost(typeof json === 'string' ? JSON.parse(json) : json);
    } catch (error) {
      send('bootstrap-error', { stage: 'on-config', message: String((error && error.message) || error) });
    }
  };

  installSilentControl();

  // 初始配置水合：先落 localStorage（业务 runtimeStore 读取主路径），属性在 documentElement 可用后补写。
  applySharedValues(config, false);

  // 业务 store 写入时回传宿主：只允许共享键，避免把逐题缓存写进宿主配置。
  try {
    doc.addEventListener(SYNC_EVENT, function onSync(event) {
      var detail = event && event.detail;
      var shared = collectSharedValues(detail);
      if (Object.keys(shared).length === 0) {
        return;
      }
      send('config-sync', shared);
    });
  } catch (error) {
    // ignore
  }

  if (!isEnabled()) {
    send('disabled', { origin: locationInfo.origin, path: locationInfo.path });
    return;
  }

  // 宿主直接注入 bootstrap 时（已有文档/未触发 trampoline），这里也补发一次 boot 请求语义的 ready。
  whenDomReady(function () {
    // documentElement 就绪后补写属性，保证业务 store 冷启动能读到跨 origin 配置。
    if (Object.keys(pendingAttributeValues).length > 0) {
      writeDocumentAttributes(pendingAttributeValues);
      pendingAttributeValues = {};
    }
    ensureStyle();
    installPanelLifecycleObserver();
    mountPanelShell();
    send('ready', { origin: locationInfo.origin, path: locationInfo.path, version: BOOTSTRAP_VERSION, top: isTopWindow() });
  });
})();

