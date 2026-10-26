import type { ScriptPanel } from './types.js';

function isTopFrame() {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

function claimTopWindowPanelOwnership() {
  // 非顶层 frame 绝不占用顶层面板所有权：答题页会在 about:blank iframe 里注入业务脚本，
  // 若子 frame 先把 owner 写成自己的 URL，顶层面板会因 owner 不匹配被隐藏（进入答题后面板消失）。
  if (!isTopFrame()) {
    return false;
  }

  try {
    const topRoot = window.top?.document.documentElement;
    if (!topRoot) {
      return true;
    }

    const ownerFrameHref = topRoot.dataset.chaoxingPlusPanelOwner || '';
    if (!ownerFrameHref) {
      topRoot.dataset.chaoxingPlusPanelOwner = window.location.href;
      return true;
    }

    return ownerFrameHref === window.location.href;
  } catch {
    return true;
  }
}

// 考试答题页/SPA 可能会替换 body 内容，把已挂载的面板节点从 DOM 移除。
// 顶层面板被移除时自动重新挂载，保证进入答题后仍然可见。
function ensureTopPanelKeepAlive(root: HTMLElement) {
  if (!isTopFrame()) {
    return;
  }

  try {
    const observer = new MutationObserver(() => {
      try {
        if (root.isConnected) {
          return;
        }
        const parent = document.body || document.documentElement;
        if (parent) {
          parent.appendChild(root);
        }
      } catch {
        // ignore remount failures
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    // ignore MutationObserver failures
  }
}

export function createPanelRoot(id = 'chaoxing-plus-runtime-panel'): ScriptPanel {
  let root = document.getElementById(id);
  if (!root) {
    root = document.createElement('div');
    root.id = id;
    root.style.position = 'fixed';
    root.style.top = '16px';
    root.style.right = '16px';
    // 面板层级必须低于弹窗（弹窗固定 2147483647），最高位留给弹窗。
    root.style.zIndex = '2147483644';
    root.style.width = '360px';
    root.style.maxHeight = '80vh';
    root.style.overflow = 'auto';
    root.dataset.chaoxingPlusTheme = 'pink';
    // 不透明底色 + 紧凑阴影：半透明 + 大半径阴影在 CEF75/软件渲染下会在面板周围形成模糊光晕。
    root.style.background = 'linear-gradient(145deg, #fff0f7 0%, #fffafd 48%, #ffecf4 100%)';
    root.style.border = '1px solid rgba(244, 114, 182, 0.30)';
    root.style.boxShadow = '0 10px 28px rgba(190, 24, 93, 0.16), 0 2px 8px rgba(190, 24, 93, 0.10)';
    root.style.borderRadius = '24px';
    root.style.padding = '12px';
    if (!claimTopWindowPanelOwnership()) {
      root.style.display = 'none';
      root.dataset.chaoxingPlusLockedOut = 'true';
    }
    (document.body || document.documentElement).appendChild(root);
    ensureTopPanelKeepAlive(root);
  }

  const lockWrapper = document.createElement('div');
  const configsContainer = document.createElement('div');
  const body = document.createElement('div');
  root.replaceChildren(lockWrapper, configsContainer, body);

  return { root, lockWrapper, configsContainer, body };
}
