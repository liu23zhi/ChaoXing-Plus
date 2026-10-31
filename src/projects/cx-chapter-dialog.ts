type ChapterDialogWindow = Window & Record<string, any>;

function isChapterDialogVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden) return false;
    const style = ownerWindow.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return element.getClientRects().length > 0;
}

function getChapterSubmissionDialog(popup: HTMLElement, requireVisible = true) {
  if (popup.closest('.swal2-container, .swal2-popup')) return undefined;
  if (popup.id === 'confirmSubWin' && popup.classList.contains('AlertCon02')) {
    const head = popup.querySelector<HTMLElement>('h3');
    const close = head?.querySelector<HTMLElement>('#closeFoucsButton.closed02');
    const content = popup.querySelector<HTMLElement>('.con03 > #tipContent');
    const buttons = Array.from(popup.querySelectorAll<HTMLElement>('.con03 .marTop30 > a'));
    const callback = (element: HTMLElement) => (element.getAttribute('onclick') || '').replace(/\s+/gu, '').replace(/;$/u, '');
    const text = (element: HTMLElement) => (element.textContent || '').replace(/\s+/gu, '');
    const submit = buttons.find((button) => text(button) === '确定' && callback(button) === 'submitCheckTimes()');
    const cancel = buttons.find((button) => text(button) === '取消' && callback(button) === 'hideWindow()');
    if (!head || !close || callback(close) !== 'hideWindow()' || !content || !submit || !cancel) return undefined;
    if (!['确认提交？', '确认提交?', '确认提交'].includes(text(content))) return undefined;
    if (requireVisible && (!isChapterDialogVisible(popup) || !isChapterDialogVisible(content))) return undefined;
    const previous = popup.previousElementSibling;
    const mask = previous?.classList.contains('mask') ? previous as HTMLElement : undefined;
    return { dialog: popup, head, close, content, submit, cancel, mask };
  }
  const dialog = popup.querySelector<HTMLElement>('.popDiv.wid440.Marking');
  if (!dialog || dialog.closest('#workpop') !== popup) return undefined;
  const head = dialog.querySelector<HTMLElement>('#workpopFocus.popHead');
  const close = head?.querySelector<HTMLElement>('#popCloseFocus');
  const content = dialog.querySelector<HTMLElement>('#popcontent');
  const submit = dialog.querySelector<HTMLElement>('#popok');
  const cancel = dialog.querySelector<HTMLElement>('#popno');
  if (!head || !close || !content || !submit || !cancel) return undefined;
  const text = (element: HTMLElement) => (element.textContent || '').replace(/\s+/gu, '');
  if (!['确认提交？', '确认提交?', '确认提交'].includes(text(content))) return undefined;
  if (text(submit) !== '提交' || text(cancel) !== '取消') return undefined;
  if (requireVisible && (!isChapterDialogVisible(popup) || !isChapterDialogVisible(dialog)
    || !isChapterDialogVisible(content))) return undefined;
  return { dialog, head, close, content, submit, cancel, mask: undefined as HTMLElement | undefined };
}

function clickChapterDialogCancel(button: HTMLElement): boolean {
  if (!isChapterDialogVisible(button) || button.getAttribute('aria-disabled') === 'true') return false;
  if ((button as HTMLButtonElement).disabled) return false;
  const ownerWindow = button.ownerDocument.defaultView as ChapterDialogWindow | null;
  const nativeClick = ownerWindow?.HTMLElement?.prototype?.click;
  if (typeof nativeClick !== 'function') return false;
  const preventSubmit = (event: Event) => event.preventDefault();
  button.addEventListener('click', preventSubmit, true);
  try {
    // Dispatch page cancellation handlers once, without a button's implicit form submission.
    nativeClick.call(button);
    return true;
  } finally {
    button.removeEventListener('click', preventSubmit, true);
  }
}

export function dismissChapterSubmissionDialog(windows: ChapterDialogWindow[], options: { jobId?: string } = {}): void {
  const pending = [...windows];
  const visited = new Set<ChapterDialogWindow>();
  const documents = new Set<Document>();
  while (pending.length > 0) {
    const actionWindow = pending.shift();
    if (!actionWindow || visited.has(actionWindow)) continue;
    visited.add(actionWindow);
    try { pending.push(actionWindow.parent as ChapterDialogWindow); } catch { /* Restricted frame. */ }
    try { pending.push(actionWindow.top as ChapterDialogWindow); } catch { /* Restricted frame. */ }
    let doc: Document;
    try { doc = actionWindow.document; } catch { continue; }
    if (!doc || documents.has(doc)) continue;
    documents.add(doc);
    if (options.jobId) {
      const jobIds = Array.from(doc.querySelectorAll<HTMLInputElement>('input[name="jobid"], input[name="jobId"], input#jobid'))
        .map((input) => input.value).filter(Boolean);
      if (jobIds.length && !jobIds.every((jobId) => jobId === options.jobId)) continue;
    }

    for (const popup of Array.from(doc.querySelectorAll<HTMLElement>('#workpop, #confirmSubWin.AlertCon02'))) {
      try {
        const matched = getChapterSubmissionDialog(popup);
        if (!matched) continue;
        let clicked = clickChapterDialogCancel(matched.cancel);
        if (!clicked) clicked = clickChapterDialogCancel(matched.close);
        if (!clicked) {
          const closeAction = (matched.close.getAttribute('onclick') || '').replace(/\s+/gu, '').replace(/;$/u, '');
          const ownerWindow = popup.ownerDocument.defaultView as ChapterDialogWindow | null;
          if ((closeAction === 'popClickFunc()' || closeAction === 'returnpopClickFunc()')
            && typeof ownerWindow?.popClickFunc === 'function') {
            ownerWindow.popClickFunc();
          }
        }

        // A page callback may replace the shared popup with another dialog; only hide the same confirmation.
        const remaining = getChapterSubmissionDialog(popup, false);
        if (remaining?.dialog === matched.dialog && remaining.content === matched.content
          && remaining.submit === matched.submit && remaining.cancel === matched.cancel) {
          popup.style.display = 'none';
          // The old template's adjacent mask is shared with its verification layer.
          const otherDialogVisible = Array.from(doc.querySelectorAll<HTMLElement>('.AlertCon02'))
            .some((dialog) => dialog !== popup && isChapterDialogVisible(dialog));
          if (matched.mask && !otherDialogVisible) matched.mask.style.display = 'none';
        }
      } catch {
        // A document can navigate while its cancellation callback is running.
      }
    }
  }
}
