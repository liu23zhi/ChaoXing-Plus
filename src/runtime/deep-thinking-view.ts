interface DeepThinkingDialogActions {
  choose(enabled: boolean): Promise<boolean>;
  dismiss(): void;
}

export function mountDeepThinkingDialog(actions: DeepThinkingDialogActions) {
  const host = document.createElement('div');
  host.id = 'cx-deep-thinking-guide';
  const shadow = host.attachShadow({ mode: 'open' });
  // Static markup in the isolated world. Native dialog contains keyboard focus and handles Escape.
  shadow.innerHTML = `
    <style>
      dialog{box-sizing:border-box;width:min(29rem,calc(100% - 2rem));padding:1.5rem;border:1px solid #979db1;border-radius:1rem;color:#202337;background:#fff;font:16px/1.5 system-ui,sans-serif;box-shadow:0 14px 48px #171d3d55}
      dialog::backdrop{background:#171d3d80}
      h2{font-size:1.3rem;margin:0 2rem 0 0}
      p{margin:.9rem 0}
      .close{position:absolute;inset:1rem 1rem auto auto;min-width:2.5rem;padding:.25rem;font-size:1.25rem}
      .actions{display:flex;justify-content:flex-end;gap:.65rem;flex-wrap:wrap}
      button{font:inherit;font-weight:600;color:#202337;background:#f6f7fb;min-height:2.5rem;padding:.35rem .9rem;border:1px solid #979db1;border-radius:.5rem;cursor:pointer}
      button:focus-visible{outline:3px solid #5039bf;outline-offset:2px}
      button:disabled{opacity:.65;cursor:wait}
      .enable{color:#fff;background:#452bb3;border-color:#452bb3}
      .notice{color:#99231a;margin:.5rem 0 0}
      .notice:empty{display:none}
    </style>
    <dialog aria-labelledby="guide-title" aria-describedby="guide-description">
      <button type="button" class="close" aria-label="关闭深度思考引导" autofocus>×</button>
      <h2 id="guide-title">要开启深度思考吗？</h2>
      <p id="guide-description">开启后，AI 可能进行多轮模型调用与联网搜索，等待时间会更长，费用也可能更高。你可以随时在学习设置中更改。</p>
      <div class="actions">
        <button type="button" class="disable">暂不开启</button>
        <button type="button" class="enable">立即开启</button>
      </div>
      <p class="notice" role="status" aria-live="polite"></p>
    </dialog>`;
  const dialog = shadow.querySelector('dialog')!;
  const enable = shadow.querySelector<HTMLButtonElement>('.enable')!;
  const disable = shadow.querySelector<HTMLButtonElement>('.disable')!;
  const notice = shadow.querySelector<HTMLElement>('.notice')!;
  const restoreFocus = document.activeElement;
  let destroyed = false;
  let pending = false;

  async function choose(event: Event, enabled: boolean) {
    if (!event.isTrusted || destroyed || pending || !dialog.open) return;
    pending = enable.disabled = disable.disabled = true;
    notice.textContent = '';
    const saved = await actions.choose(enabled);
    if (destroyed) return;
    if (!saved) notice.textContent = '未能保存选择，请重试。';
    pending = enable.disabled = disable.disabled = false;
  }
  enable.addEventListener('click', event => { void choose(event, true); });
  disable.addEventListener('click', event => { void choose(event, false); });
  shadow.querySelector('.close')?.addEventListener('click', event => { if (event.isTrusted) actions.dismiss(); });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (event.isTrusted) actions.dismiss();
  });
  document.body.append(host);
  dialog.showModal();
  return {
    destroy() {
      destroyed = true;
      dialog.close();
      host.remove();
      if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected) restoreFocus.focus({ preventScroll: true });
    }
  };
}
