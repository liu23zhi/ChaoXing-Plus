export type LogType = 'log' | 'info' | 'debug' | 'warn' | 'error';

export function runtimeLog(type: LogType, ...args: unknown[]): void {
  const method = type === 'debug' ? 'log' : type;
  console[method]('[chaoxing-plus]', ...args);
}
