type SubmissionWindow = Window & Record<string, any>;
export type ChapterSubmissionIdentity = {
  courseId?: string; classId?: string; chapterId?: string; tabKey?: string; jobId: string; attemptId: string;
};
type SubmissionMetadata = { requestId: string; ownerWindow: SubmissionWindow; identity?: ChapterSubmissionIdentity };
type SubmissionSubscriber = {
  identityKey?: string;
  jobScoped: boolean;
  accepts: (owner: SubmissionWindow, url: string, body: unknown) => boolean;
  begin: (abort?: () => void, callbackOnly?: boolean) => { respond: (value: unknown, metadata: SubmissionMetadata) => void; finish: (error?: string) => void };
};
type SubmissionRegistry = {
  subscribers: Set<SubmissionSubscriber>;
  responding: Set<SubmissionSubscriber>;
  active?: SubmissionSubscriber;
  handlesEvent: (subscriber: SubmissionSubscriber) => boolean;
  release: () => void;
};

const submissionResponseTimeoutMs = 30000;
const submissionRegistryKey = '__chaoxingPlusChapterSubmissionRegistryV2';

function isChapterSubmissionUrl(url: unknown, base: string): boolean {
  try {
    return new URL(String(url), base).pathname.replace(/\/+$/u, '').toLowerCase()
      === '/mooc-ans/work/addstudentworknewweb';
  } catch { return false; }
}

function chapterSubmissionFields(url: string, body: unknown, base: string): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  const add = (key: string, value: unknown) => {
    const aliases: Record<string, string> = { jobid: 'jobId', originjobid: 'jobId', courseid: 'courseId', classid: 'classId', _classid: 'classId', clazzid: 'classId', knowledgeid: 'chapterId', chapterid: 'chapterId' };
    const name = aliases[key.toLowerCase()];
    if (name && value !== null && value !== undefined && String(value) !== '') (fields[name] ??= []).push(String(value));
  };
  try { new URL(url, base).searchParams.forEach((value, key) => add(key, value)); } catch { /* Invalid URL. */ }
  if (typeof body === 'string') {
    try {
      const value = JSON.parse(body);
      if (value && typeof value === 'object') Object.keys(value).forEach((key) => add(key, value[key]));
    } catch { new URLSearchParams(body).forEach((value, key) => add(key, value)); }
  } else if (body && typeof (body as { forEach?: unknown }).forEach === 'function') {
    (body as URLSearchParams).forEach((value, key) => add(key, value));
  }
  return fields;
}

function installChapterSubmissionRegistry(owner: SubmissionWindow): SubmissionRegistry {
  if (owner[submissionRegistryKey]) return owner[submissionRegistryKey];
  const subscribers = new Set<SubmissionSubscriber>();
  const responding = new Set<SubmissionSubscriber>();
  const requestOwners = new WeakMap<object, SubmissionSubscriber[]>();
  const originalFetch = owner.fetch;
  const prototype = owner.XMLHttpRequest?.prototype as Record<string, any> | undefined;
  const originalOpen = prototype?.open;
  const originalSend = prototype?.send;
  const base = owner.location.href;
  let sequence = 0;
  const metadata = () => ({ requestId: `${Date.now()}-${++sequence}`, ownerWindow: owner });
  const registry: SubmissionRegistry = {
    subscribers, responding,
    handlesEvent(subscriber) {
      const target = owner.event?.target;
      return !!target && !!requestOwners.get(target)?.includes(subscriber);
    },
    release() {
      if (subscribers.size) return;
      if (owner.fetch === observedFetch) owner.fetch = originalFetch;
      if (prototype?.open === observedOpen) prototype.open = originalOpen;
      if (prototype?.send === observedSend) prototype.send = originalSend;
      if (owner[submissionRegistryKey] === registry) delete owner[submissionRegistryKey];
    }
  };
  const start = (url: string, body: unknown, abort?: () => void, initiatingSubscriber = registry.active) => {
    let candidates = Array.from(subscribers).filter((subscriber) => subscriber.accepts(owner, url, body));
    if (initiatingSubscriber) candidates = candidates.includes(initiatingSubscriber) ? [initiatingSubscriber] : [];
    else candidates = candidates.filter((subscriber, index) => !subscriber.identityKey
      || !candidates.slice(index + 1).some((later) => later.identityKey === subscriber.identityKey));
    return candidates.map((subscriber) => ({ subscriber, task: subscriber.begin(url || subscriber.jobScoped ? abort : undefined) }));
  };
  const respond = (tasks: ReturnType<typeof start>, value: unknown, info: SubmissionMetadata) => {
    tasks.forEach(({ task }) => task.respond(value, info));
  };
  const withResponseOwner = <T>(tasks: ReturnType<typeof start>, action: () => T): T => {
    const previous = new Set(responding);
    tasks.forEach(({ subscriber }) => responding.add(subscriber));
    try { return action(); }
    finally {
      tasks.forEach(({ subscriber }) => { if (!previous.has(subscriber)) responding.delete(subscriber); });
    }
  };
  const ownFetchCallbacks = <T>(promise: Promise<T>, prepared: Promise<ReturnType<typeof start>>): Promise<T> => {
    let tasks: ReturnType<typeof start> = [];
    void prepared.then((value) => { tasks = value; });
    const originalThen = promise.then;
    promise.then = function (fulfilled?: any, rejected?: any): any {
      const wrap = (callback: any) => typeof callback === 'function'
        ? (value: unknown) => withResponseOwner(tasks, () => callback(value)) : callback;
      const next = originalThen.call(this, wrap(fulfilled), wrap(rejected));
      void prepared.then((owners) => owners.forEach(({ subscriber }) => {
        const hold = subscriber.begin(undefined, true);
        // Page response.json() and following callbacks can finish after the transport promise.
        // Keep their hooks alive without altering rejection handling on the page's chain.
        Promise.prototype.then.call(next, () => hold.finish(), () => hold.finish());
      }));
      return ownFetchCallbacks(next, prepared);
    };
    return promise;
  };
  const observedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input as Request;
    const method = init?.method ?? request?.method ?? 'GET';
    const url = typeof input === 'string' ? input : request?.url ?? String(input);
    if (String(method).toUpperCase() !== 'POST' || !isChapterSubmissionUrl(url, base)) {
      return originalFetch.call(this, input, init);
    }
    const controller: AbortController | undefined = typeof owner.AbortController === 'function' ? new owner.AbortController() : undefined;
    const signal = init?.signal ?? request?.signal;
    const onAbort = () => controller?.abort();
    if (signal?.aborted) controller?.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const info = metadata();
    // Clone Request bodies; the page must still be able to consume its original request.
    const body = init?.body;
    const bodyPromise: Promise<unknown> = body !== undefined || typeof request?.clone !== 'function'
      ? Promise.resolve(body) : request.clone().text().catch(() => undefined);
    const initiatingSubscriber = registry.active;
    const prepared = bodyPromise.then((value) => start(url, value, controller ? () => controller.abort() : undefined, initiatingSubscriber));
    let result: Promise<Response>;
    try { result = originalFetch.call(this, input, controller ? { ...init, signal: controller.signal } : init); }
    catch (error) { result = Promise.reject(error); }
    const inspected = result.then(async (response) => {
      const tasks = await prepared;
      try {
        respond(tasks, await response.clone().text(), info);
        tasks.forEach(({ task }) => task.finish(response.ok ? undefined : 'Chapter submission returned an HTTP error.'));
      } catch { tasks.forEach(({ task }) => task.finish('Unable to read the chapter submission response.')); }
      return response;
    }, async (error) => {
      (await prepared).forEach(({ task }) => task.finish('Chapter submission request failed.'));
      throw error;
    }).finally(() => signal?.removeEventListener('abort', onAbort));
    return ownFetchCallbacks(inspected, prepared);
  };
  type OpenState = { method: string; url: string; cleanup?: () => void; ready?: () => void; earlyReady?: () => void };
  const requests = new WeakMap<XMLHttpRequest, OpenState>();
  const observedOpen = function (this: XMLHttpRequest, ...args: any[]) {
    requests.get(this)?.cleanup?.();
    const result = originalOpen.apply(this, args);
    const opened: OpenState = { method: String(args[0]).toUpperCase(), url: String(args[1]) };
    opened.earlyReady = () => opened.ready?.();
    this.addEventListener('readystatechange', opened.earlyReady);
    opened.cleanup = () => this.removeEventListener('readystatechange', opened.earlyReady!);
    requests.set(this, opened);
    return result;
  };
  const observedSend = function (this: XMLHttpRequest, ...args: any[]) {
    const opened = requests.get(this);
    if (opened && (opened.method !== 'POST' || !isChapterSubmissionUrl(opened.url, base))) return originalSend.apply(this, args);
    // Already-open XHR exposes its URL only with response headers: verify before notification.
    // Only a matching job in the sent body can grant ownership before the URL is known.
    const url = opened?.url ?? '';
    const tasks = start(url, args[0], () => this.abort());
    if (!tasks.length) return originalSend.apply(this, args);
    requestOwners.set(this, tasks.map(({ subscriber }) => subscriber));
    const info = metadata();
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      this.removeEventListener('readystatechange', opened?.earlyReady ?? ready);
      this.removeEventListener('error', failed);
      this.removeEventListener('abort', failed);
      this.removeEventListener('timeout', failed);
      tasks.forEach(({ task }) => task.finish(error));
    };
    const failed = () => finish('Chapter submission request failed.');
    const ready = () => {
      if (finished || this.readyState !== 4) return;
      try {
        if (!opened && !isChapterSubmissionUrl(this.responseURL, base)) { finish(); return; }
        if (this.status === 0) { failed(); return; }
        const value = this.responseType === 'json' ? this.response
          : this.responseType === '' || this.responseType === 'text' ? this.responseText : undefined;
        respond(tasks, value, info);
        finish(this.status >= 200 && this.status < 300 ? undefined : 'Chapter submission returned an HTTP error.');
      } catch { finish('Unable to read the chapter submission response.'); }
    };
    if (opened) {
      opened.cleanup = () => finish('Chapter submission request was interrupted.');
      opened.ready = ready;
    } else this.addEventListener('readystatechange', ready);
    this.addEventListener('error', failed);
    this.addEventListener('abort', failed);
    this.addEventListener('timeout', failed);
    try { return originalSend.apply(this, args); }
    catch (error) { failed(); throw error; }
  };
  if (typeof originalFetch === 'function') owner.fetch = observedFetch;
  if (prototype && typeof originalOpen === 'function' && typeof originalSend === 'function') {
    prototype.open = observedOpen;
    prototype.send = observedSend;
  }
  owner[submissionRegistryKey] = registry;
  return registry;
}

export function observeChapterSubmission(
  windows: SubmissionWindow[],
  onResponse: (value: unknown, metadata?: SubmissionMetadata) => void,
  options: { jobId?: string; identity?: ChapterSubmissionIdentity; ownerWindow?: SubmissionWindow; timeoutMs?: number } = {}
) {
  const pending = new Set<{ settled: Promise<void>; finish: () => void; abort?: () => void }>();
  const registries: SubmissionRegistry[] = [];
  let failure: Error | undefined;
  let stopped = false;
  let completed = 0;
  let observed = 0;
  const startedAt = Date.now();
  const subscriber: SubmissionSubscriber = {
    jobScoped: Boolean(options.identity?.jobId || options.jobId),
    identityKey: options.identity ? JSON.stringify([
      options.identity.courseId, options.identity.classId, options.identity.chapterId,
      options.identity.tabKey, options.identity.jobId
    ]) : undefined,
    accepts(owner, url, body) {
      if (stopped) return false;
      const jobId = options.identity?.jobId ?? options.jobId;
      if (!jobId) return true;
      const fields = chapterSubmissionFields(url, body, owner.location.href);
      const identity = options.identity;
      if (identity) {
        for (const name of ['courseId', 'classId', 'chapterId'] as const) {
          if (identity[name] && fields[name]?.some((value) => value !== identity[name])) return false;
        }
        // On a shared parent, a reused job ID alone cannot identify the originating chapter.
        if (owner !== options.ownerWindow && identity.chapterId
          && !fields.chapterId?.every((value) => value === identity.chapterId)) return false;
      }
      const ids = fields.jobId ?? [];
      if (ids.length) return ids.every((id) => id === jobId);
      return owner === options.ownerWindow && !!url;
    },
    begin(abort, callbackOnly = false) {
      if (!callbackOnly) observed++;
      let resolve: () => void = () => {};
      let finished = false;
      const task = { settled: new Promise<void>((done) => { resolve = done; }), finish: () => {}, abort };
      const finish = (error?: string) => {
        if (finished) return;
        finished = true;
        pending.delete(task);
        if (error && !failure) failure = new Error(error);
        resolve();
      };
      task.finish = () => finish();
      pending.add(task);
      return {
        respond(value, info) {
          if (stopped) return;
          completed++;
          try { onResponse(value, { ...info, identity: options.identity }); } catch { if (!failure) failure = new Error('Unable to inspect the chapter submission response.'); }
        },
        finish
      };
    }
  };
  for (const owner of new Set(windows)) {
    try {
      const registry = installChapterSubmissionRegistry(owner);
      registry.subscribers.add(subscriber);
      registries.push(registry);
    } catch { /* A parent can be inaccessible; continue in accessible realms. */ }
  }
  const abort = () => {
    for (const task of pending) {
      try { task.abort?.(); } catch { /* Navigated frame. */ }
      task.finish();
    }
  };
  return {
    runAction<T>(action: () => T): T {
      const previous = registries.map((registry) => registry.active);
      registries.forEach((registry) => { registry.active = subscriber; });
      try { return action(); }
      finally { registries.forEach((registry, index) => { registry.active = previous[index]; }); }
    },
    isHandlingResponse(owner: SubmissionWindow) {
      try {
        return registries.some((registry) => registry.handlesEvent(subscriber))
          || !!owner[submissionRegistryKey]?.responding.has(subscriber);
      } catch { return false; }
    },
    async wait(requireSubmission = false) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort();
          reject(new Error('Chapter submission response timed out.'));
        }, Math.max(0, (options.timeoutMs ?? submissionResponseTimeoutMs) - (Date.now() - startedAt)));
      });
      try {
        do {
          await Promise.race([Promise.all(Array.from(pending, (task) => task.settled)), deadline]);
          await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, requireSubmission && !observed ? 20 : 0)), deadline]);
        } while (pending.size || (requireSubmission && !observed));
        if (failure) throw failure;
        return { observed, completed };
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
    restore() {
      if (stopped) return;
      abort();
      stopped = true;
      registries.forEach((registry) => { registry.subscribers.delete(subscriber); registry.responding.delete(subscriber); registry.release(); });
    }
  };
}
