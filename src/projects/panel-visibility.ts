export function shouldShowFloatingPanel(context?: {
  selfWindow?: unknown;
  topWindow?: unknown;
  parentWindow?: unknown;
}) {
  return context?.selfWindow === context?.topWindow;
}
