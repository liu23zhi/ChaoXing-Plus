export type StudyAutomationFlags = {
  enableAnswer: boolean;
  enableChapterTest: boolean;
  canAnswerChapterTest: boolean;
};

export type WorkResultsPanelUiState = {
  collapsed: boolean;
};

function toBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

export function resolveStudyAutomationFlags(raw: Record<string, unknown>): StudyAutomationFlags {
  const enableAnswer = toBoolean(raw.enableAnswer, true);
  const enableChapterTest = toBoolean(raw.enableChapterTest, true);

  return {
    enableAnswer,
    enableChapterTest,
    canAnswerChapterTest: enableAnswer && enableChapterTest
  };
}

export function countEnabledStudyTaskCapabilities(raw: Record<string, unknown>, keys: string[]) {
  return keys.filter((key) => toBoolean(raw[key], true)).length;
}

export function formatEnabledStudyTaskCapabilitySummary(raw: Record<string, unknown>, keys: string[]) {
  return `已开启${countEnabledStudyTaskCapabilities(raw, keys)} 项`;
}

export function createDefaultWorkResultsPanelUiState(): WorkResultsPanelUiState {
  return {
    collapsed: false
  };
}

export function toggleWorkResultsPanelCollapsed(collapsed: boolean) {
  return !collapsed;
}
