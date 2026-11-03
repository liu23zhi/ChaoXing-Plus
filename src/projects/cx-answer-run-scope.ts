type AnswerRunWorker = {
  isClose: boolean;
  emit: (event: 'close') => unknown;
  opts: {
    onResultsInitialized?: (...args: any[]) => unknown;
    onResultsUpdate?: (...args: any[]) => unknown;
    onElementSearched?: (...args: any[]) => unknown;
  };
};

/** Owns workers and waits for one answer generation, independently of tab pause. */
export function createCxAnswerRunScope() {
  let generation = 0;
  const workers = new Set<AnswerRunWorker>();
  const tracked = new WeakSet<AnswerRunWorker>();
  const pending = new Set<() => void>();
  const cancelledError = () => {
    const error = new Error('本轮答题已取消，正在重新作答。');
    error.name = 'AbortError';
    return error;
  };

  return {
    capture: () => generation,
    isCurrent: (token: number) => token === generation,
    track<T extends AnswerRunWorker>(worker: T): T {
      if (tracked.has(worker)) return worker;
      tracked.add(worker);
      workers.add(worker);
      const token = generation;
      const callbacks = ['onResultsInitialized', 'onResultsUpdate', 'onElementSearched'] as const;
      for (const name of callbacks) {
        const callback = worker.opts[name];
        if (!callback) continue;
        worker.opts[name] = function (this: unknown, ...args: any[]) {
          if (token !== generation || worker.isClose) return undefined;
          return callback.apply(this, args);
        };
      }
      return worker;
    },
    cancel() {
      generation++;
      const cancelledWorkers = Array.from(workers);
      const cancelledWaits = Array.from(pending);
      workers.clear();
      pending.clear();
      cancelledWaits.forEach((cancel) => cancel());
      for (const worker of cancelledWorkers) {
        worker.isClose = true;
        try { worker.emit('close'); } catch { /* One stale listener must not leave other workers active. */ }
      }
    },
    wait<T>(task: Promise<T>): Promise<T> {
      const token = generation;
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          pending.delete(cancel);
          callback();
        };
        const cancel = () => finish(() => reject(cancelledError()));
        pending.add(cancel);
        // Always observe the original promise, including a rejection after cancellation.
        Promise.resolve(task).then(
          (result) => token === generation ? finish(() => resolve(result)) : cancel(),
          (error: unknown) => token === generation ? finish(() => reject(error)) : cancel()
        );
      });
    }
  };
}
