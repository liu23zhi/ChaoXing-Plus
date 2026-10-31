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
  return { dialog, head, close, content, submit, cancel };
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

export function dismissChapterSubmissionDialog(windows: ChapterDialogWindow[]): void {
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

    for (const popup of Array.from(doc.querySelectorAll<HTMLElement>('#workpop'))) {
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
        }
      } catch {
        // A document can navigate while its cancellation callback is running.
      }
    }
  }
}
