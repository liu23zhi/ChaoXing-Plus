type ExistingEditor = {
  container?: Node;
  iframe?: HTMLIFrameElement;
  body?: HTMLElement;
  key?: string;
  isReady?: boolean;
  setContent?: (content: string) => void;
  sync?: () => void;
};

const answerWidgetSelector = '.answerBg,.line_answer,.line_answer_ct .selectBox,.filling_answer,.reading_answer';
const editorContainerSelector = '.textDIV,.eidtDiv,.edui-editor-iframeholder';

function isAnswerField(element: Element): boolean {
  // answerId, answertype and answerCount identify the task or its schema.
  // Only the platform's answer / answer123 / answer_123 / answer[123] forms
  // represent answer values; never use a broad [name^=answer] reset.
  const name = element.getAttribute('name') || element.id;
  return /^answer(?:$|\d|[_\[\].:-])/iu.test(name);
}

function emitAnswerChange(element: Element): void {
  const EventType = element.ownerDocument.defaultView?.Event;
  if (!EventType) return;
  element.dispatchEvent(new EventType('input', { bubbles: true }));
  element.dispatchEvent(new EventType('change', { bubbles: true }));
}

function clearAnswerSelection(element: Element): void {
  if (element.hasAttribute('aria-checked')) element.setAttribute('aria-checked', 'false');
  if (element.hasAttribute('aria-selected')) element.setAttribute('aria-selected', 'false');
  for (const name of Array.from(element.classList)) {
    if (/^check_answer(?:_|$)/u.test(name) || ['active', 'selected', 'checked', 'on'].includes(name)) {
      element.classList.remove(name);
    }
  }
}

function clearExistingEditors(root: HTMLElement): void {
  const runtime = root.ownerDocument.defaultView as (Window & {
    UE?: { instants?: Record<string, ExistingEditor> };
  }) | null;
  for (const editor of Object.values(runtime?.UE?.instants || {})) {
    if (!editor || editor.isReady === false || typeof editor.setContent !== 'function') continue;
    try {
      const source = editor.key ? root.ownerDocument.getElementById(editor.key) : null;
      const frame = editor.body?.ownerDocument.defaultView?.frameElement;
      const belongsToRoot = [editor.container, editor.iframe, frame, source]
        .some((node) => Boolean(node && root.contains(node)));
      if (!belongsToRoot) continue;
      // Reuse the existing editor so its internal content cannot restore the
      // old answer. UE.getEditor would construct a new editor as a side effect.
      editor.setContent('');
      editor.sync?.();
    } catch {
      // A disposed editor or an inaccessible frame must not prevent the other
      // answers from being cleared. The scoped DOM reset still applies.
    }
  }
}

/** Clear only answer state within the supplied task's question roots. */
export function resetCxQuestionAnswers(roots: HTMLElement[]): void {
  const uniqueRoots = [...new Set(roots)].filter((root, _index, all) =>
    !all.some((ancestor) => ancestor !== root && ancestor.contains(root)));
  for (const root of uniqueRoots) {
    const changed = new Set<Element>();
    const selectionElements = new Set<Element>();

    for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('input'))) {
      if (input.type === 'radio' || input.type === 'checkbox') {
        const hadAnswer = input.checked || input.defaultChecked || input.hasAttribute('checked');
        input.checked = false;
        input.defaultChecked = false;
        input.removeAttribute('checked');
        if (hadAnswer) changed.add(input);
        selectionElements.add(input);
        for (const selector of ['label', 'li']) {
          const choice = input.closest(selector);
          if (choice && root.contains(choice)) selectionElements.add(choice);
        }
      } else if (!['button', 'submit', 'reset', 'image'].includes(input.type) && isAnswerField(input)) {
        const hadAnswer = Boolean(input.value || input.defaultValue);
        input.value = '';
        input.defaultValue = '';
        if (hadAnswer) changed.add(input);
      }
    }

    for (const textarea of Array.from(root.querySelectorAll<HTMLTextAreaElement>('textarea'))) {
      const hadAnswer = Boolean(textarea.value || textarea.defaultValue);
      textarea.value = '';
      textarea.defaultValue = '';
      if (hadAnswer) changed.add(textarea);
    }

    for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>('select'))) {
      if (!isAnswerField(select) && !select.closest(answerWidgetSelector)) continue;
      const hadAnswer = select.selectedIndex !== -1;
      for (const option of Array.from(select.options)) {
        option.selected = false;
        option.defaultSelected = false;
      }
      select.selectedIndex = -1;
      if (hadAnswer) changed.add(select);
    }

    for (const editable of Array.from(root.querySelectorAll<HTMLElement>('[contenteditable]'))) {
      if (editable.getAttribute('contenteditable')?.toLowerCase() === 'false') continue;
      if (editable.innerHTML) {
        editable.innerHTML = '';
        changed.add(editable);
      }
    }

    for (const iframe of Array.from(root.querySelectorAll<HTMLIFrameElement>('iframe'))) {
      try {
        const body = iframe.contentDocument?.body;
        if (!body || (!body.isContentEditable && !iframe.closest(editorContainerSelector))) continue;
        if (body.innerHTML) {
          body.innerHTML = '';
          changed.add(body);
        }
      } catch { /* Preserve cross-origin content frames and continue clearing this task. */ }
    }

    for (const element of Array.from(root.querySelectorAll('[aria-checked],[aria-selected],[class*="check_answer"]'))) {
      selectionElements.add(element);
    }
    for (const widget of Array.from(root.querySelectorAll(answerWidgetSelector))) {
      selectionElements.add(widget);
      for (const element of Array.from(widget.querySelectorAll('[class],[aria-checked],[aria-selected]'))) {
        selectionElements.add(element);
      }
    }
    for (const element of selectionElements) clearAnswerSelection(element);
    clearExistingEditors(root);
    // Listeners see a completely cleared question, rather than a half-reset
    // radio group or an editor that still contains its previous answer.
    for (const element of changed) emitAnswerChange(element);
  }
}
