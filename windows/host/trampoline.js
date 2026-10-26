/* Windows 端：新文档启动探针（由宿主通过 Page.addScriptToEvaluateOnNewDocument 注册）。
 * 该脚本在 document_start 执行，只负责通知宿主“这里有新文档”，不接触业务逻辑。
 * 语言级别保持 ES5，客户端内核为 CEF/Chromium 75。
 */
(function () {
  'use strict';
  try {
    var win = window;
    if (win.__CX_WIN_TRAMPOLINE__) {
      return;
    }
    win.__CX_WIN_TRAMPOLINE__ = true;
    if (win.__CX_WIN_HOST__) {
      return;
    }
    var href = '';
    try {
      href = String(win.location && win.location.href ? win.location.href : '');
    } catch (ignored) {
      href = '';
    }
    // 只上报 origin+pathname，避免把考试 URL 的查询参数带进宿主日志。
    var origin = '';
    var pathname = '';
    try {
      if (win.location && win.location.origin) {
        origin = String(win.location.origin);
        pathname = String(win.location.pathname || '');
      }
    } catch (ignoredOrigin) {
      origin = '';
      pathname = '';
    }
    if (typeof console !== 'undefined' && typeof console.log === 'function') {
      console.log('__CX_WIN_MSG__' + JSON.stringify({
        kind: 'boot-request',
        origin: origin,
        path: pathname,
        hrefLength: href.length
      }));
    }
  } catch (error) {
    try {
      if (typeof console !== 'undefined' && typeof console.log === 'function') {
        console.log('__CX_WIN_MSG__' + JSON.stringify({
          kind: 'bootstrap-error',
          stage: 'trampoline',
          message: String((error && error.message) || error)
        }));
      }
    } catch (ignored) {
      // 页面可能禁用了 console，宿主仍可通过 CDP 事件判断。
    }
  }
})();
