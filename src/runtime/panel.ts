import type { ScriptPanel } from './types.js';

function claimTopWindowPanelOwnership() {
  let ownerFrameHref = '';

  try {
    const topRoot = window.top?.document.documentElement;
    if (!topRoot) {
      return true;
    }

    ownerFrameHref = topRoot.dataset.chaoxingPlusPanelOwner || '';
    if (!ownerFrameHref) {
      ownerFrameHref = window.location.href;
      topRoot.dataset.chaoxingPlusPanelOwner = ownerFrameHref;
    }

    if (ownerFrameHref !== window.location.href) {
      return false;
    }
  } catch {
    return window.self === window.top;
  }

  return true;
}

export function createPanelRoot(id = 'chaoxing-plus-runtime-panel'): ScriptPanel {
  let root = document.getElementById(id);
  if (!root) {
    root = document.createElement('div');
    root.id = id;
    root.style.position = 'fixed';
    root.style.top = '16px';
    root.style.right = '16px';
    root.style.zIndex = '2147483646';
    root.style.width = '360px';
    root.style.maxHeight = '80vh';
    root.style.overflow = 'auto';
    root.style.background = '#fff';
    root.style.border = '1px solid #ddd';
    root.style.boxShadow = '0 8px 24px rgba(0,0,0,0.12)';
    root.style.borderRadius = '12px';
    root.style.padding = '12px';
    if (!claimTopWindowPanelOwnership()) {
      root.style.display = 'none';
      root.dataset.chaoxingPlusLockedOut = 'true';
    }
    (document.body || document.documentElement).appendChild(root);
  }

  const lockWrapper = document.createElement('div');
  const configsContainer = document.createElement('div');
  const body = document.createElement('div');
  root.replaceChildren(lockWrapper, configsContainer, body);

  return { root, lockWrapper, configsContainer, body };
}
