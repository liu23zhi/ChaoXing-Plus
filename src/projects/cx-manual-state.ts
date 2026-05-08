export type CXManualStateQuestionType =
  | 'single'
  | 'multiple'
  | 'judgement'
  | 'completion'
  | 'line'
  | 'fill'
  | 'reader'
  | undefined;

export type CXManualStateResult = {
  requested?: boolean;
  resolved?: boolean;
  finish?: boolean;
  result?: {
    finish?: boolean;
  };
};

function detectAnsweredDomState(root: HTMLElement, type: CXManualStateQuestionType) {
  if (type === 'single' || type === 'multiple' || type === 'judgement') {
    return (
      Array.from(root.querySelectorAll('input[type="radio"], input[type="checkbox"], label input')).some((input) => {
        const element = input as HTMLInputElement;
        return element.checked || element.getAttribute('checked') === 'checked';
      }) || root.querySelector('[aria-checked="true"]') !== null
    );
  }

  if (type === 'completion' || type === 'fill' || type === 'reader') {
    return (
      Array.from(root.querySelectorAll('textarea')).some((input) => (input as HTMLTextAreaElement).value.trim()) ||
      Array.from(root.querySelectorAll('iframe')).some((frame) => frame.contentDocument?.body?.innerText?.trim()) ||
      Array.from(root.querySelectorAll('.filling_answer, .reading_answer')).some((el) => el.textContent?.trim())
    );
  }

  if (type === 'line') {
    return root.querySelector('.line_answer_ct .selectBox [class*="active"]') !== null;
  }

  return false;
}

function hasAutomaticAttempt(result?: CXManualStateResult) {
  return result?.requested === true;
}

export function resolveManualAnswerState(options: {
  root: HTMLElement;
  type: CXManualStateQuestionType;
  previousManual?: boolean;
  result?: CXManualStateResult;
}) {
  const { root, type, previousManual = false, result } = options;

  if (previousManual) {
    return true;
  }

  if (hasAutomaticAttempt(result)) {
    return false;
  }

  return detectAnsweredDomState(root, type);
}
