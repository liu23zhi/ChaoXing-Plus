(() => {
  if (window.__CX_PLUS_PAGE_HOOKS_BRIDGE__) return;
  window.__CX_PLUS_PAGE_HOOKS_BRIDGE__ = true;

  const state = {
    rateChangeGuard: false,
    pauseGuard: false,
    rateEnforcer: false,
    videoJsRateBypass: false,
    highRatePatch: false,
  };

  function installRateChangeGuard(cfg) {
    if (state.rateChangeGuard) return;
    state.rateChangeGuard = true;
    const rateTsAttr = cfg?.rateTsAttr || 'data-cx-rate-ts';
    const suppressWindowMs = Number(cfg?.suppressWindowMs || 100);
    document.addEventListener('ratechange', (e) => {
      const el = e.target;
      if (!el || typeof el.getAttribute !== 'function') return;
      const ts = el.getAttribute(rateTsAttr);
      if (!ts) return;
      const n = Number(ts);
      if (n > 0 && Date.now() - n < suppressWindowMs) {
        e.stopImmediatePropagation();
      }
    }, { capture: true, passive: false });
  }

  function installPauseGuard(cfg) {
    if (state.pauseGuard) return;
    state.pauseGuard = true;
    const rateDesiredAttr = cfg?.rateDesiredAttr || 'data-cx-desired-rate';
    const userPauseMs = Number(cfg?.userPauseGraceWindowMs || 900);
    const nativePause = HTMLMediaElement.prototype.pause;
    if (typeof nativePause !== 'function') {
      console.warn('[超星助手][pause-trace] pause-hook-skip: native pause missing');
      return;
    }

    let allowPauseUntil = 0;
    let lastPointerLeaveAt = 0;
    const markUserIntent = () => { allowPauseUntil = Date.now() + userPauseMs; };
    document.addEventListener('pointerdown', markUserIntent, { capture: true, passive: true });
    document.addEventListener('touchstart', markUserIntent, { capture: true, passive: true });
    document.addEventListener('mousedown', markUserIntent, { capture: true, passive: true });
    document.addEventListener('keydown', (e) => {
      const key = e && e.key ? String(e.key).toLowerCase() : '';
      if (key === ' ' || key === 'spacebar' || key === 'k' || key === 'p') {
        markUserIntent();
      }
    }, { capture: true, passive: true });
    document.addEventListener('mouseleave', () => {
      lastPointerLeaveAt = Date.now();
    }, { capture: true, passive: true });

    function tracedPause() {
      let blocked = false;
      let userInitiated = false;
      let desired = 1;
      const el = this;
      try {
        const desiredRaw = el.getAttribute && el.getAttribute(rateDesiredAttr);
        desired = desiredRaw ? Number(desiredRaw) : 1;
        userInitiated = Date.now() <= allowPauseUntil;
        const pointerLeaveTriggered = Date.now() - lastPointerLeaveAt < 1500;
        if (pointerLeaveTriggered && desired > 1 && !el.ended) blocked = true;
        if (!userInitiated && desired > 1 && !el.ended) blocked = true;

        let src = '';
        try { src = (el.currentSrc || el.src || '').slice(0, 120); } catch (_) {}
        let stack = '';
        try { stack = String((new Error('pause-trace')).stack || ''); } catch (_) {}
        console.log('[超星助手][pause-trace]', {
          blocked,
          userInitiated,
          desiredRate: desired,
          currentRate: typeof el.playbackRate === 'number' ? el.playbackRate : -1,
          paused: !!el.paused,
          src,
          stack,
        });
      } catch (_) {}

      if (blocked) return;
      return nativePause.call(this);
    }

    let hooked = false;
    try {
      Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
        value: tracedPause,
        writable: false,
        configurable: false,
      });
      hooked = true;
      console.info('[超星助手][pause-trace] pause-hook-installed:prototype');
    } catch (err) {
      console.warn('[超星助手][pause-trace] pause-hook-prototype-failed', err);
    }

    const patchVideoInstance = (v) => {
      if (!v || v.__cxPlusPausePatched) return;
      try {
        Object.defineProperty(v, 'pause', {
          value: tracedPause,
          writable: false,
          configurable: false,
        });
        v.__cxPlusPausePatched = true;
        hooked = true;
        console.info('[超星助手][pause-trace] pause-hook-installed:instance');
      } catch (err) {
        console.warn('[超星助手][pause-trace] pause-hook-instance-failed', err);
      }
    };

    document.querySelectorAll('video').forEach(patchVideoInstance);
    new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'VIDEO') patchVideoInstance(node);
          if (typeof node.querySelectorAll === 'function') {
            node.querySelectorAll('video').forEach(patchVideoInstance);
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });

    if (!hooked) {
      console.warn('[超星助手][pause-trace] pause-hook-not-installed');
    }
  }

  function installRateEnforcer(cfg) {
    if (state.rateEnforcer) return;
    state.rateEnforcer = true;
    const rateTsAttr = cfg?.rateTsAttr || 'data-cx-rate-ts';
    const rateDesiredAttr = cfg?.rateDesiredAttr || 'data-cx-desired-rate';
    const epsilon = Number(cfg?.epsilon || 0.01);

    let trueNativeSet;
    let trueNativeGet;
    try {
      const iframe = document.createElement('iframe');
      document.documentElement.appendChild(iframe);
      const iframeDesc = Object.getOwnPropertyDescriptor(
        iframe.contentWindow.HTMLMediaElement.prototype,
        'playbackRate',
      );
      trueNativeSet = iframeDesc && iframeDesc.set;
      trueNativeGet = iframeDesc && iframeDesc.get;
      iframe.remove();
    } catch (_) {
      const fallbackDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
      trueNativeSet = fallbackDesc && fallbackDesc.set;
      trueNativeGet = fallbackDesc && fallbackDesc.get;
    }
    if (!trueNativeSet || !trueNativeGet) return;

    function interceptSet(el, rate) {
      const desiredStr = el.getAttribute(rateDesiredAttr);
      const desired = desiredStr !== null ? parseFloat(desiredStr) : null;
      if (desired !== null && !isNaN(desired) && Math.abs(rate - desired) > epsilon) {
        rate = desired;
      }
      el.setAttribute(rateTsAttr, String(Date.now()));
      trueNativeSet.call(el, rate);
    }

    try {
      Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
        get: trueNativeGet,
        set: function (rate) { interceptSet(this, rate); },
        configurable: false,
        enumerable: true,
      });
    } catch (_) {}

    const applyToVideoElement = (el) => {
      if (el.__cxPlusRateOverride) return;
      try {
        Object.defineProperty(el, 'playbackRate', {
          get: function () { return trueNativeGet.call(this); },
          set: function (rate) { interceptSet(this, rate); },
          configurable: false,
          enumerable: true,
        });
        el.__cxPlusRateOverride = true;
      } catch (_) {}
    };

    document.querySelectorAll('video').forEach(applyToVideoElement);
    new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'VIDEO') applyToVideoElement(node);
          if (typeof node.querySelectorAll === 'function') {
            node.querySelectorAll('video').forEach(applyToVideoElement);
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function installVideoJsRateBypass() {
    if (state.videoJsRateBypass) return;
    state.videoJsRateBypass = true;

    const patch = () => {
      const Ext = window.Ext;
      const videojs = window.videojs;
      if (!Ext || !videojs || typeof Ext.define !== 'function') return false;
      try {
        Ext.define('ans.VideoJs', {
          override: 'ans.VideoJs',
          constructor: function (data) {
            this.addEvents && this.addEvents(['seekstart']);
            this.mixins && this.mixins.observable &&
              this.mixins.observable.constructor &&
              this.mixins.observable.constructor.call(this, data);

            const vjs = videojs(
              data.videojs,
              this.params2VideoOpt ? this.params2VideoOpt(data.params) : data.params,
              function () {},
            );

            if (Ext.fly) {
              Ext.fly(data.videojs).on('contextmenu', (evt) => evt.preventDefault());
              Ext.fly(data.videojs).on('keydown', (evt) => {
                if (evt.keyCode === 32 || evt.keyCode === 37 || evt.keyCode === 39 || evt.keyCode === 107) {
                  evt.preventDefault();
                }
              });
            }

            if (vjs.videoJsResolutionSwitcher) {
              vjs.on('resolutionchange', () => {
                const cr = vjs.currentResolution && vjs.currentResolution();
                const re = cr && cr.sources ? cr.sources[0].res : false;
                Ext.setCookie && Ext.setCookie('resolution', re);
              });
            }

            if (vjs.videoJsPlayLine) {
              vjs.on('playlinechange', () => {
                const cp = vjs.currentPlayline && vjs.currentPlayline();
                Ext.setCookie && Ext.setCookie('net', cp && cp.net);
              });
            }
          },
        });
        return true;
      } catch (_) {
        return false;
      }
    };

    if (patch()) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (patch() || tries >= 80) clearInterval(timer);
    }, 250);
  }

  function installHighRatePatch(cfg) {
    if (state.highRatePatch) return;
    state.highRatePatch = true;
    const dragResetWindowMs = Number(cfg?.dragResetWindowMs || 2000);
    const dragStormThreshold = Number(cfg?.dragStormThreshold || 100);
    const dragStormResetPoint = Number(cfg?.dragStormResetPoint || 90);

    const patch = () => {
      const videojs = window.videojs;
      if (!videojs || typeof videojs.getPlugin !== 'function' || typeof videojs.extend !== 'function') return;
      const origin = videojs.getPlugin('seekBarControl');
      if (!origin || origin.__cxPlusPatched) return;
      const basePlugin = videojs.getPlugin('plugin');
      const plugin = videojs.extend(basePlugin, {
        constructor: function (videoExt, data) {
          let dragCount = 0;
          let lastDragAt = 0;
          const sendLog = data && data.sendLog;
          if (typeof sendLog === 'function') {
            data.sendLog = function (...args) {
              if (args[1] === 'drag') {
                const now = Date.now();
                if (now - lastDragAt > dragResetWindowMs) dragCount = 0;
                lastDragAt = now;
                dragCount += 1;
                if (dragCount > dragStormThreshold) {
                  dragCount = dragStormResetPoint;
                  return;
                }
                return;
              }
              return sendLog.apply(this, args);
            };
          }
          return origin.call(this, videoExt, data);
        },
      });
      origin.__cxPlusPatched = true;
      videojs.registerPlugin('seekBarControl', plugin);
    };

    patch();
    document.addEventListener('readystatechange', patch, { passive: true });
    window.addEventListener('load', patch, { once: true, passive: true });
  }

  function callDocFinishJob() {
    // Mirrors ocsjs JobRunner.read(): call finishJob() on the document viewer
    // iframe window. Chaoxing exposes this function to signal that a single-page
    // document has been viewed; calling it triggers the backend XHR that marks
    // the task point as passed and updates the sidebar icon to icon-finish.
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var win = iframes[i].contentWindow;
        if (!win) continue;
        if (typeof win.finishJob === 'function') {
          win.finishJob();
          console.info(`[超星助手] 已调用文档完成方法 (finishJob on iframe ${i})`);
          return;
        }
      } catch (e) {
        // cross-origin iframe — skip
      }
    }
    // Fallback: finishJob may be on the current window in some page layouts.
    if (typeof window.finishJob === 'function') {
      window.finishJob();
      console.info('[超星助手] 已调用文档完成方法 (finishJob on current window)');
    }
  }

  document.addEventListener('cx-plus:page-hook', (event) => {
    const detail = event?.detail || {};
    const type = detail.type;
    const payload = detail.payload || {};
    if (type === 'injectRateChangeGuard') return installRateChangeGuard(payload);
    if (type === 'injectPauseGuard') return installPauseGuard(payload);
    if (type === 'injectRateEnforcer') return installRateEnforcer(payload);
    if (type === 'injectVideoJsRateBypass') return installVideoJsRateBypass();
    if (type === 'injectHighRatePatch') return installHighRatePatch(payload);
    if (type === 'callDocFinishJob') return callDocFinishJob();
  });

  console.info('[超星助手] page-hooks bridge ready');
})();
