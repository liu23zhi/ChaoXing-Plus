export type StudyAutomationFlags = {
  enableAnswer: boolean;
  enableChapterTest: boolean;
  canAnswerChapterTest: boolean;
};

// 面板顶部 tab：把原本纵向堆叠的板块收进互斥页签，避免长距离滚动。
//
// - overview：状态 + 主操作 + 指标 + 答题结果（首屏必须能操作，所以不放进设置页）
// - tiku：题库适配器配置
// - cache：本地题库缓存
// - study：学习设置（仅扩展端；Windows 端是考试专用，没有这个页签）
export type WorkResultsPanelTab = 'overview' | 'tiku' | 'cache' | 'study';

export const WORK_RESULTS_PANEL_TABS: WorkResultsPanelTab[] = ['overview', 'tiku', 'cache', 'study'];

export type WorkResultsPanelUiState = {
  collapsed: boolean;
  activeTab: WorkResultsPanelTab;
  /**
   * 一次性标记：下一次渲染是用户切了页签，应把滚动位置归零。
   *
   * 为什么需要它：面板重渲染会恢复 scrollTop（避免「答一题就跳回顶部」），
   * 但切页签时恢复旧 scrollTop 会让新页签停在中间一截。渲染完立即清除。
   */
  pendingTabScrollReset?: boolean;
};

export function isWorkResultsPanelTab(value: unknown): value is WorkResultsPanelTab {
  return typeof value === 'string' && (WORK_RESULTS_PANEL_TABS as string[]).includes(value);
}

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
    collapsed: false,
    activeTab: 'overview'
  };
}

export function toggleWorkResultsPanelCollapsed(collapsed: boolean) {
  return !collapsed;
}

// 切换页签：未知值回落到 overview，不把面板留在空白页。
export function resolveWorkResultsPanelTab(value: unknown): WorkResultsPanelTab {
  return isWorkResultsPanelTab(value) ? value : 'overview';
}

// 给定当前可见的页签集合，返回一个一定可见的页签。
// Windows 端没有 study 页，若此前停在 study 就要回落，否则会渲染出空面板。
export function clampWorkResultsPanelTab(
  requested: WorkResultsPanelTab,
  available: WorkResultsPanelTab[]
): WorkResultsPanelTab {
  if (available.includes(requested)) return requested;
  return available.includes('overview') ? 'overview' : (available[0] ?? 'overview');
}
