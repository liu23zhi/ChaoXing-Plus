type SubmissionWindow = Window & Record<string, any>;

type PendingSubmission = {
  settled: Promise<void>;
  finish: () => void;
};

const submissionResponseTimeoutMs = 30000;

export function observeChapterSubmission(
  windows: SubmissionWindow[],
  onResponse: (value: unknown) => void
): { wait: () => Promise<void>; restore: () => void } {
  const pending = new Set<PendingSubmission>();
  const restorers: Array<() => void> = [];
  const listenerCleanups = new Set<() => void>();
  const installedPrototypes = new Set<object>();
  const installedWindows = new Set<SubmissionWindow>();
  let stopped = false;
  let failure: Error | undefined;

  const fail = (message: string) => {
    if (!failure) failure = new Error(message);
  };
  const notify = (value: unknown) => {
    if (stopped) return;
    try {
      onResponse(value);
    } catch {
      fail('Unable to inspect the chapter submission response.');
    }
  };
  const isSubmission = (method: unknown, url: unknown, base: string) => {
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    try {
      const pathname = new URL(String(url), base).pathname.replace(/\/+$/u, '').toLowerCase();
      return pathname === '/mooc-ans/work/addstudentworknewweb';
    } catch {
      return false;
    }
  };
  const begin = (): PendingSubmission => {
    let resolve: () => void = () => {};
    const task: PendingSubmission = {
      settled: new Promise<void>((done) => { resolve = done; }),
      finish() {
        pending.delete(task);
        resolve();
      }
    };
    pending.add(task);
    return task;
  };

  for (const actionWindow of windows) {
    if (!actionWindow || installedWindows.has(actionWindow)) continue;
    installedWindows.add(actionWindow);
    try {
      const base = actionWindow.location.href;
      const originalFetch = actionWindow.fetch;
      if (typeof originalFetch === 'function') {
        const observedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
          const request = input as Request;
          const method = init?.method ?? request?.method ?? 'GET';
          const url = typeof input === 'string' ? input : request?.url ?? String(input);
          if (!isSubmission(method, url, base)) return originalFetch.call(this, input, init);

          const task = begin();
          let result: Promise<Response>;
          try {
            result = originalFetch.call(this, input, init);
          } catch (error) {
            fail('Chapter submission request failed.');
            task.finish();
            throw error;
          }
          return result.then(async (response) => {
            try {
              notify(await response.clone().text());
              if (!response.ok) fail('Chapter submission returned an HTTP error.');
            } catch {
              fail('Unable to read the chapter submission response.');
            } finally {
              task.finish();
            }
            return response;
          }, (error) => {
            fail('Chapter submission request failed.');
            task.finish();
            throw error;
          });
        };
        actionWindow.fetch = observedFetch;
        restorers.push(() => {
          if (actionWindow.fetch === observedFetch) actionWindow.fetch = originalFetch;
        });
      }

      const prototype = actionWindow.XMLHttpRequest?.prototype as Record<string, any> | undefined;
      if (!prototype || installedPrototypes.has(prototype)) continue;
      installedPrototypes.add(prototype);
      const originalOpen = prototype.open;
      const originalSend = prototype.send;
      if (typeof originalOpen !== 'function' || typeof originalSend !== 'function') continue;

      type RequestState = { cleanup: () => void; start: () => void; finish: () => void };
      const requests = new WeakMap<XMLHttpRequest, RequestState>();
      const observedOpen = function (this: XMLHttpRequest, ...args: any[]) {
        requests.get(this)?.cleanup();
        requests.delete(this);
        const result = originalOpen.apply(this, args);
        if (!isSubmission(args[0], args[1], base)) return result;

        let task: PendingSubmission | undefined;
        let settled = false;
        const cleanup = () => {
          this.removeEventListener('readystatechange', onReady);
          this.removeEventListener('error', onError);
          this.removeEventListener('abort', onError);
          this.removeEventListener('timeout', onError);
          listenerCleanups.delete(cleanup);
          if (task && !settled) {
            settled = true;
            fail('Chapter submission request was interrupted.');
            task.finish();
          }
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          task?.finish();
        };
        const onError = () => {
          if (!task || settled) return;
          fail('Chapter submission request failed.');
          finish();
        };
        const onReady = () => {
          if (!task || settled || this.readyState !== 4) return;
          try {
            if (this.status === 0) {
              fail('Chapter submission request failed.');
            } else {
              if (this.responseType === 'json') notify(this.response);
              else if (this.responseType === '' || this.responseType === 'text') notify(this.responseText);
              if (this.status < 200 || this.status >= 300) fail('Chapter submission returned an HTTP error.');
            }
          } catch {
            fail('Unable to read the chapter submission response.');
          } finally {
            finish();
          }
        };
        requests.set(this, {
          cleanup,
          start: () => { if (!task) task = begin(); },
          finish
        });
        // Install at open(), before page code normally assigns its completion callback.
        this.addEventListener('readystatechange', onReady);
        this.addEventListener('error', onError);
        this.addEventListener('abort', onError);
        this.addEventListener('timeout', onError);
        listenerCleanups.add(cleanup);
        return result;
      };
      const observedSend = function (this: XMLHttpRequest, ...args: any[]) {
        const state = requests.get(this);
        state?.start();
        try {
          return originalSend.apply(this, args);
        } catch (error) {
          if (state) {
            fail('Chapter submission request failed.');
            state.finish();
          }
          throw error;
        }
      };
      prototype.open = observedOpen;
      prototype.send = observedSend;
      restorers.push(() => {
        if (prototype.open === observedOpen) prototype.open = originalOpen;
        if (prototype.send === observedSend) prototype.send = originalSend;
      });
    } catch {
      // A parent or sibling window can be inaccessible; keep observing accessible realms.
    }
  }

  return {
    async wait() {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Chapter submission response timed out.')), submissionResponseTimeoutMs);
      });
      try {
        do {
          await Promise.race([Promise.all(Array.from(pending, (task) => task.settled)), deadline]);
          // Let page callbacks and their synchronous follow-up requests run before restoring hooks.
          await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, 0)), deadline]);
        } while (pending.size > 0);
        if (failure) throw failure;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
    restore() {
      if (stopped) return;
      stopped = true;
      for (const cleanup of listenerCleanups) cleanup();
      for (const restore of restorers.reverse()) {
        try { restore(); } catch { /* A frame may have navigated while submitting. */ }
      }
    }
  };
}
