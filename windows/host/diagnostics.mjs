import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const hostDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * 在页面主世界采集渲染诊断：DPI/缩放、视口、面板位置与关键样式、是否支持 backdrop-filter。
 * 用于判断“悬浮窗附近模糊”来自页面 CSS、fixed 亚像素定位，还是客户端/系统的 DPI 缩放。
 * 返回值是 JSON 字符串，宿主解析后写日志与文件。
 */
export const RENDER_DIAGNOSTICS_EXPRESSION = `(() => {
  try {
    const dpr = Number(window.devicePixelRatio) || 0;
    const pickStyle = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        position: style.position,
        top: style.top,
        right: style.right,
        width: style.width,
        height: style.height,
        zoom: style.zoom,
        transform: style.transform,
        filter: style.filter,
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter || '',
        boxShadow: style.boxShadow,
        borderRadius: style.borderRadius,
        backgroundImage: style.backgroundImage,
        opacity: style.opacity,
        willChange: style.willChange
      };
    };
    const describeElement = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        id: element.id || '',
        theme: element.getAttribute ? element.getAttribute('data-chaoxing-plus-theme') || '' : '',
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom
        },
        devicePixels: {
          x: rect.x * dpr,
          y: rect.y * dpr,
          width: rect.width * dpr,
          height: rect.height * dpr,
          fractional: Math.abs(rect.x * dpr - Math.round(rect.x * dpr)) > 0.01
            || Math.abs(rect.y * dpr - Math.round(rect.y * dpr)) > 0.01
        },
        style: pickStyle(element)
      };
    };
    let panelDiagnosticsEnabled = true;
    try {
      const host = window.__CX_WIN_HOST__;
      const hostConfig = host && typeof host.getConfig === 'function' ? host.getConfig() : null;
      if (hostConfig && hostConfig['common.settings.windows-panel-enabled'] === false) {
        panelDiagnosticsEnabled = false;
      }
    } catch (error) {
      panelDiagnosticsEnabled = true;
    }
    const panels = panelDiagnosticsEnabled
      ? Array.from(document.querySelectorAll('[id^="panel-"], [data-chaoxing-plus-theme="pink"]'))
      : [];
    const topPanel = panels.find((node) => node.getBoundingClientRect().top >= 0) || panels[0] || null;
    const supports = (property, value) => {
      try { return !!(window.CSS && CSS.supports && CSS.supports(property, value)); } catch (error) { return false; }
    };
    return JSON.stringify({
      collectedAt: new Date().toISOString(),
      url: location.origin + location.pathname,
      hostBridge: !!window.__CX_WIN_HOST__,
      bootstrapVersion: window.__CX_WIN_HOST__ ? window.__CX_WIN_HOST__.version : null,
      bundleLoaded: !!window.__CX_WIN_BUNDLE_LOADED__,
      devicePixelRatio: dpr,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screen: window.screen ? { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight } : null,
      visualViewport: window.visualViewport
        ? { scale: visualViewport.scale, width: visualViewport.width, height: visualViewport.height, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop }
        : null,
      documentElement: {
        clientWidth: document.documentElement ? document.documentElement.clientWidth : 0,
        clientHeight: document.documentElement ? document.documentElement.clientHeight : 0,
        style: pickStyle(document.documentElement),
        zoom: document.documentElement ? getComputedStyle(document.documentElement).zoom : '',
        transform: document.documentElement ? getComputedStyle(document.documentElement).transform : ''
      },
      body: {
        style: pickStyle(document.body),
        zoom: document.body ? getComputedStyle(document.body).zoom : '',
        transform: document.body ? getComputedStyle(document.body).transform : ''
      },
      supports: {
        backdropFilter: supports('backdrop-filter', 'blur(1px)'),
        webkitBackdropFilter: supports('-webkit-backdrop-filter', 'blur(1px)'),
        cssZoom: supports('zoom', '1'),
        devicePixelContentBox: supports('width', '1px')
      },
      panelCount: panels.length,
      panelDiagnosticsEnabled,
      topPanel: describeElement(topPanel),
      themePanel: describeElement(panelDiagnosticsEnabled ? document.querySelector('[data-chaoxing-plus-theme="pink"]') : null),
      searchInfosDefined: !!(window.customElements && customElements.get && customElements.get('search-infos')),
      readyState: document.readyState
    });
  } catch (error) {
    return JSON.stringify({ error: String((error && error.message) || error) });
  }
})()`;

export function summarizeRenderDiagnostics(sample, { includePanel = true } = {}) {
  if (!sample || typeof sample !== 'object') return 'no sample';
  if (sample.error) return `error=${sample.error}`;
  const parts = [
    `dpr=${sample.devicePixelRatio}`,
    `viewport=${sample.innerWidth}x${sample.innerHeight}`
  ];
  if (includePanel) {
    const panel = sample.topPanel || sample.themePanel;
    const style = panel && panel.style ? panel.style : {};
    const rect = panel && panel.rect ? panel.rect : null;
    const devicePixels = panel && panel.devicePixels ? panel.devicePixels : null;
    parts.push(`backdropFilter=${sample.supports ? sample.supports.backdropFilter : '?'}`);
    parts.push(`panels=${sample.panelCount}`);
    if (rect) {
      parts.push(`panel=${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      parts.push(`panelDpr=[${devicePixels ? devicePixels.x.toFixed(2) : '?'},${devicePixels ? devicePixels.y.toFixed(2) : '?'}]`);
      parts.push(`fractional=${devicePixels ? devicePixels.fractional : '?'}`);
    }
    parts.push(`shadow=${style.boxShadow ? style.boxShadow.slice(0, 80) : 'none'}`);
    parts.push(`backdrop=${style.backdropFilter || 'none'}`);
    parts.push(`zoom=${style.zoom || 'normal'}`);
    parts.push(`transform=${style.transform || 'none'}`);
  }
  return parts.join(' ');
}

export async function collectSystemProbe({ pid = 0, processName = 'CXExam', screenshotPath = '', logger = () => {} } = {}) {
  const scriptPath = path.join(hostDirectory, 'system-probe.ps1');
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-ClientPid',
    String(pid || 0),
    '-ProcessName',
    processName || 'CXExam'
  ];
  if (screenshotPath) args.push('-ScreenshotPath', screenshotPath);
  try {
    const { stdout } = await execFileAsync('powershell.exe', args, {
      timeout: 25000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    const text = String(stdout || '').trim();
    if (!text) throw new Error('system-probe.ps1 没有输出');
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch (error) {
    logger(`[diagnostics] 采集系统渲染信息失败：${error.message}`);
    return { error: error.message, collectedAt: new Date().toISOString() };
  }
}

export async function writeDiagnosticsFile(directory, payload, logger = () => {}) {
  const filePath = path.join(directory, 'render-diagnostics.json');
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    logger(`[diagnostics] 已写入 ${filePath}`);
    return filePath;
  } catch (error) {
    logger(`[diagnostics] 写入诊断文件失败：${error.message}`);
    return null;
  }
}

export async function writeScreenshot(directory, fileName, base64Data, logger = () => {}) {
  if (!base64Data) return null;
  try {
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, fileName);
    await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));
    logger(`[diagnostics] 已保存页面截图 ${filePath}`);
    return filePath;
  } catch (error) {
    logger(`[diagnostics] 保存页面截图失败：${error.message}`);
    return null;
  }
}

export function normalizeDiagnosticsSample(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue) return null;
  try {
    return JSON.parse(rawValue);
  } catch {
    return { error: `无法解析诊断 JSON：${rawValue.slice(0, 200)}` };
  }
}

/**
 * 判断“客户端窗口是否被 Windows 位图缩放”：窗口 DPI 与系统 DPI 不一致时，
 * Windows 会把整个窗口按比例放大，所有文字（包括脚本悬浮窗）都会发虚。
 */
export function evaluateDpiDiagnosis(system) {
  if (!system || system.error) return { status: 'unknown', reason: system ? system.error : 'no system info' };
  const systemDpi = Number(system.systemDpi || system.appliedDpi || 0);
  const windows = Array.isArray(system.windows) ? system.windows.filter((item) => Number(item.windowDpi) > 0) : [];
  const areaOf = (item) => {
    if (item && item.area) return Number(item.area);
    const rect = item && item.rect ? item.rect : null;
    return rect ? Number(rect.width) * Number(rect.height) : 0;
  };
  const visibleWindows = windows.filter((item) => item.visible !== false);
  const candidates = (visibleWindows.length ? visibleWindows : windows).filter((item) => areaOf(item) >= 100000);
  const pool = candidates.length ? candidates : (visibleWindows.length ? visibleWindows : windows);
  const windowInfo = pool.sort((left, right) => areaOf(right) - areaOf(left))[0] || null;
  const windowDpi = windowInfo ? Number(windowInfo.windowDpi || 0) : 0;
  if (!systemDpi || !windowDpi) return { status: 'unknown', systemDpi, windowDpi };
  if (windowDpi === systemDpi) {
    return { status: 'match', systemDpi, windowDpi, scale: Number((systemDpi / 96).toFixed(3)), windowClass: windowInfo.className || '' };
  }
  return {
    status: 'mismatch',
    systemDpi,
    windowDpi,
    scale: Number((systemDpi / 96).toFixed(3)),
    windowClass: windowInfo.className || '',
    windowProcessId: windowInfo.processId || 0,
    windowArea: areaOf(windowInfo),
    suggestion: '客户端窗口 DPI 感知与系统不一致：Windows 正在位图缩放整个客户端窗口（125%/150% 缩放下文字必然发虚）。'
      + '可用 --dpi-aware 启动一次，或在 windows/data/config.json 设置 "dpiAwareness": "system" 后重试。'
  };
}

/** 从页面采样中提取与“悬浮窗周围模糊”相关的可疑项。 */
export function evaluatePageDiagnosis(sample) {
  const findings = [];
  if (!sample || sample.error) return { status: 'unknown', findings };
  const panel = sample.topPanel || sample.themePanel;
  const style = panel && panel.style ? panel.style : null;
  const devicePixels = panel && panel.devicePixels ? panel.devicePixels : null;
  if (devicePixels && devicePixels.fractional) {
    findings.push({
      code: 'SUBPIXEL_POSITION',
      detail: '面板 rect 与设备像素网格不对齐，可能造成亚像素模糊',
      rect: panel.rect,
      devicePixels
    });
  }
  if (style && style.backdropFilter && style.backdropFilter !== 'none') {
    findings.push({
      code: 'BACKDROP_BLUR_ACTIVE',
      detail: '面板仍启用了 backdrop-filter，会模糊面板背后的页面内容',
      backdropFilter: style.backdropFilter
    });
  }
  if (style && style.transform && style.transform !== 'none') {
    findings.push({ code: 'PANEL_TRANSFORM', detail: '面板根节点带 transform，可能触发图层缩放模糊', transform: style.transform });
  }
  if (sample.devicePixelRatio && Number(sample.devicePixelRatio) > 0) {
    const dpr = Number(sample.devicePixelRatio);
    if (Math.abs(dpr - 1) < 0.01 && sample.screen && sample.screen.width) {
      // 页面 DPR=1 但系统可能是 125%/150%：结合系统诊断再判断
      findings.push({ code: 'PAGE_DPR_1', detail: '页面 devicePixelRatio=1，若系统缩放不为 100% 则页面可能被位图放大', dpr });
    }
  }
  return { status: findings.length ? 'suspect' : 'clean', findings };
}
