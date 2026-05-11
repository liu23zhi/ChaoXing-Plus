export type LogType = 'log' | 'info' | 'debug' | 'warn' | 'error';

export function runtimeLog(type: LogType, ...args: unknown[]): void {
  const method = type === 'debug' ? 'log' : type;
  const normalizedArgs = args.map((arg) => {
    if (typeof arg === 'string') {
      return arg;
    }

    if (arg && typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return '[unserializable]';
      }
    }

    return String(arg);
  });

  console[method]('[chaoxing-plus]', ...normalizedArgs);
}
