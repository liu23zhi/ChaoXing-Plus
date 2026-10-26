export function shouldShowFloatingPanel(context?: {
  selfWindow?: unknown;
  topWindow?: unknown;
  parentWindow?: unknown;
}) {
  return context?.selfWindow === context?.topWindow;
}

// Windows 端只服务考试/答题场景：这些页面才需要悬浮面板。
// 登录页、通用课程页、跳转页不显示面板，避免跨页面跳转时面板反复出现/消失。
const WINDOWS_EXAM_RELATED_URL_PATTERNS = [
  /\/exam-ans\//i,
  /\/exam\/test\//i,
  /\/mooc2\/exam/i,
  /\/reVersionTestStartNew/i,
  /\/examcode\//i
];

export function isWindowsExamRelatedUrl(url: string | null | undefined) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }

  return WINDOWS_EXAM_RELATED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

export function getWindowsExamRelatedUrlPatterns() {
  return WINDOWS_EXAM_RELATED_URL_PATTERNS.slice();
}
