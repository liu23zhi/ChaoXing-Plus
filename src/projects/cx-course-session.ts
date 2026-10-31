export type CourseSessionScope = { courseId: string; classId: string };
type Decision = 'pending' | 'accepted' | 'declined';
type SessionOptions = {
  noDiskWrite: () => boolean;
  confirm: () => Promise<boolean>;
  ownerWindow?: Window;
  handshakeMs?: number;
};
export type CourseSession = {
  ready(): Promise<boolean>;
  requestManualDecision(scope?: CourseSessionScope): Promise<boolean>;
  resumeManualDecision(scope?: CourseSessionScope): Promise<boolean>;
  canReload(): boolean;
  persist(): void;
};

const registryKey = '__chaoxing_plus_course_session_v1__';
const namespace = 'chaoxing-plus:course-session:v1';
const chaptersAttribute = 'data-chaoxing-plus-deferred-chapters';
const courseAttribute = 'data-chaoxing-plus-deferred-courses';
const decisionAttribute = 'data-chaoxing-plus-manual-answer-decision';
const declinedAttribute = 'data-chaoxing-plus-manual-answer-declined';
const attributes = [chaptersAttribute, courseAttribute, decisionAttribute, declinedAttribute];
type Snapshot = {
  version: 1;
  scope: CourseSessionScope;
  runId: string;
  chapters: Record<string, unknown>;
  course?: unknown;
  decision?: Decision;
};

function scopeKey(scope: CourseSessionScope) {
  return JSON.stringify([scope.courseId, scope.classId]);
}

function validScope(value: unknown): value is CourseSessionScope {
  if (!value || typeof value !== 'object') return false;
  const scope = value as CourseSessionScope;
  return typeof scope.courseId === 'string' && scope.courseId.length > 0 && scope.courseId.length <= 512
    && typeof scope.classId === 'string' && scope.classId.length > 0 && scope.classId.length <= 512;
}

function readScope(owner: Window): CourseSessionScope | undefined {
  try {
    const params = new URL(owner.location.href).searchParams;
    const normalized = new Map<string, string>();
    params.forEach((value, key) => normalized.set(key.toLowerCase(), value));
    const courseId = owner.document.querySelector<HTMLInputElement>('#curCourseId')?.value
      || normalized.get('courseid') || '';
    const classId = owner.document.querySelector<HTMLInputElement>('#curClazzId')?.value
      || normalized.get('clazzid') || normalized.get('classid') || '';
    const scope = { courseId, classId };
    return validScope(scope) ? scope : undefined;
  } catch { return undefined; }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value || value.length > 2_000_000) return {};
  try { const parsed = JSON.parse(value); return object(parsed) ? parsed : {}; } catch { return {}; }
}

function validStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 5000 && value.every((item) => typeof item === 'string' && item.length <= 2000);
}

function validChapter(value: unknown, key: string): boolean {
  if (!object(value) || value.scope !== key || !['scan', 'retry', 'settled'].includes(String(value.phase))
    || !validStrings(value.inspectedTabs) || !object(value.tasks)) return false;
  const tasks = Object.values(value.tasks);
  return tasks.length <= 5000 && tasks.every((task) => object(task)
    && typeof task.tabKey === 'string' && task.tabKey.length > 0 && task.tabKey.length <= 2000
    && typeof task.jobId === 'string' && task.jobId.length > 0 && task.jobId.length <= 2000
    && typeof task.attempts === 'number' && Number.isSafeInteger(task.attempts) && task.attempts >= 0
    && typeof task.missingVisits === 'number' && Number.isSafeInteger(task.missingVisits) && task.missingVisits >= 0
    && typeof task.terminalExpired === 'boolean'
    && ['deferred', 'complete', 'abandoned'].includes(String(task.state))
    && (task.pauseReason === undefined || ['saved', 'disabled', 'not-ready', 'manual'].includes(String(task.pauseReason))));
}

function courseChapters(values: Record<string, unknown>, scope: CourseSessionScope) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values).slice(0, 5000)) {
    try {
      const parts: unknown = JSON.parse(key);
      if (Array.isArray(parts) && parts.length === 3 && parts[0] === scope.courseId && parts[1] === scope.classId
        && typeof parts[2] === 'string' && validChapter(value, key)) {
        const chapter = value as Record<string, unknown>;
        const tasks: Record<string, unknown> = {};
        for (const raw of Object.values(chapter.tasks as Record<string, Record<string, unknown>>)) {
          const task = { tabKey: raw.tabKey, jobId: raw.jobId, attempts: raw.attempts, missingVisits: raw.missingVisits,
            terminalExpired: raw.terminalExpired, state: raw.terminalExpired ? 'abandoned' : raw.state,
            ...(raw.pauseReason ? { pauseReason: raw.pauseReason } : {}) };
          tasks[JSON.stringify([raw.tabKey, raw.jobId])] = task;
        }
        result[key] = { scope: key, phase: chapter.phase, inspectedTabs: chapter.inspectedTabs, tasks };
      }
    } catch { /* Ignore state from unrelated or malformed scopes. */ }
  }
  return result;
}

function validCourse(value: unknown, key: string): boolean {
  return object(value) && value.scope === key && ['scan', 'retry', 'settled'].includes(String(value.phase))
    && validStrings(value.chapterIds) && validStrings(value.inspectedChapters)
    && (value.inspectedSnapshots === undefined || object(value.inspectedSnapshots));
}

function normalizedCourse(value: unknown, key: string) {
  if (!validCourse(value, key)) return undefined;
  const course = value as Record<string, unknown>;
  const inspectedSnapshots: Record<string, unknown> = {};
  if (object(course.inspectedSnapshots)) {
    for (const [id, raw] of Object.entries(course.inspectedSnapshots).slice(0, 5000)) {
      if (object(raw) && typeof raw.signature === 'string' && raw.signature.length <= 100000) {
        inspectedSnapshots[id] = { signature: raw.signature,
          ...(typeof raw.unFinishCount === 'number' && Number.isSafeInteger(raw.unFinishCount)
            && raw.unFinishCount >= 0 ? { unFinishCount: raw.unFinishCount } : {}) };
      }
    }
  }
  return { scope: key, phase: course.phase, chapterIds: course.chapterIds, inspectedChapters: course.inspectedChapters,
    ...(course.inspectedSnapshots ? { inspectedSnapshots } : {}) };
}

function messageId(owner: Window) {
  try { return `${Date.now().toString(36)}-${owner.crypto.getRandomValues(new Uint32Array(3)).join('-')}`; }
  catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
}

function allowedChild(owner: Window, event: MessageEvent): boolean {
  if (!event.source || event.source === owner || !/^https?:\/\//.test(event.origin)) return false;
  try {
    const source = event.source as Window;
    if (source.top !== owner.top) return false;
    const pending = [owner];
    let inspected = 0;
    while (pending.length && inspected++ < 200) {
      const frame = pending.shift()!;
      for (let index = 0; index < frame.frames.length; index++) {
        const child = frame.frames[index];
        if (child === source) {
          if (event.origin === owner.location.origin) return true;
          const hostname = new URL(event.origin).hostname;
          if (hostname === 'chaoxing.com' || hostname.endsWith('.chaoxing.com')) return true;
          // For local/test hosts and other explicitly embedded origins, verify the iframe URL.
          try {
            const element = Array.from(frame.document.querySelectorAll('iframe, frame'))
              .find((entry) => (entry as HTMLIFrameElement).contentWindow === source) as HTMLIFrameElement | undefined;
            return Boolean(element?.src && new URL(element.src, frame.location.href).origin === event.origin);
          } catch { return false; }
        }
        pending.push(child);
      }
    }
  } catch { /* A detached or inaccessible source cannot own a course operation. */ }
  return false;
}

export function initializeCourseSession(frameWindow: Window, options: SessionOptions): CourseSession {
  const owner = options.ownerWindow || frameWindow.top || frameWindow;
  let accessible = false;
  try { accessible = Boolean(owner.document.documentElement); } catch { /* Cross-origin client below. */ }
  if (!accessible) return initializeRemoteSession(frameWindow, owner, options);
  const registry = owner as unknown as Record<string, unknown>;
  const existing = registry[registryKey] as { document?: Document; api?: CourseSession } | undefined;
  if (existing?.document === owner.document && existing.api) return existing.api;

  const root = owner.document.documentElement;
  let currentScope: CourseSessionScope | undefined;
  let runId = messageId(owner);
  let storageAvailable = true;
  let decisionPromise: Promise<boolean> | undefined;
  let overrideDecision: ((accepted: boolean) => void) | undefined;
  let applying = false;
  let initialized = false;
  let scopeGeneration = 0;
  const memory = new Map<string, Snapshot>();
  const noDiskWrite = () => { try { return options.noDiskWrite(); } catch { return true; } };
  const tabIdentity = root.getAttribute('data-chaoxing-plus-tab-identity');
  const tabPartition = tabIdentity ? `:tab:${JSON.stringify(tabIdentity)}` : '';
  const storageKey = (scope: CourseSessionScope) => `${namespace}${tabPartition}:${scopeKey(scope)}`;
  const readDecision = (): Decision | undefined => {
    if (root.hasAttribute(declinedAttribute)) return 'declined';
    const value = root.getAttribute(decisionAttribute);
    return value === 'pending' || value === 'accepted' || value === 'declined' ? value : undefined;
  };
  const snapshot = (scope: CourseSessionScope): Snapshot => {
    const course = normalizedCourse(parseObject(root.getAttribute(courseAttribute))[scopeKey(scope)], scopeKey(scope));
    return { version: 1, scope, runId,
      chapters: courseChapters(parseObject(root.getAttribute(chaptersAttribute)), scope),
      ...(course ? { course } : {}),
      ...(readDecision() ? { decision: readDecision() } : {}) };
  };
  const save = () => {
    if (!currentScope) return;
    const value = snapshot(currentScope);
    memory.set(scopeKey(currentScope), value);
    if (noDiskWrite() || !storageAvailable) return;
    try { owner.sessionStorage.setItem(storageKey(currentScope), JSON.stringify(value)); }
    catch { storageAvailable = false; }
  };
  const synchronizeScope = () => {
    const scope = readScope(owner);
    if ((scope && currentScope && scopeKey(scope) === scopeKey(currentScope)) || (!scope && !currentScope)) return;
    save();
    const initialDecision = initialized ? undefined : readDecision();
    initialized = true;
    scopeGeneration++;
    applying = true;
    currentScope = scope;
    overrideDecision?.(false);
    overrideDecision = undefined;
    decisionPromise = undefined;
    runId = messageId(owner);
    root.removeAttribute(decisionAttribute);
    root.removeAttribute(declinedAttribute);
    try { delete registry.__chaoxing_plus_manual_answer_declined__; } catch { /* Ignore a page-owned property. */ }
    if (scope) {
      let value = memory.get(scopeKey(scope));
      if (!value && !noDiskWrite() && storageAvailable) {
        try {
          const stored = parseObject(owner.sessionStorage.getItem(storageKey(scope)));
          if (stored.version === 1 && validScope(stored.scope) && scopeKey(stored.scope) === scopeKey(scope)
            && typeof stored.runId === 'string' && stored.runId.length <= 200 && object(stored.chapters)) {
            value = { version: 1, scope, runId: stored.runId, chapters: courseChapters(stored.chapters, scope),
              ...(normalizedCourse(stored.course, scopeKey(scope)) ? { course: normalizedCourse(stored.course, scopeKey(scope)) } : {}),
              ...(['pending', 'accepted', 'declined'].includes(String(stored.decision)) ? { decision: stored.decision as Decision } : {}) };
          }
        } catch { storageAvailable = false; }
      }
      if (value) {
        runId = value.runId;
        const chapters = parseObject(root.getAttribute(chaptersAttribute));
        for (const key of Object.keys(courseChapters(chapters, scope))) delete chapters[key];
        Object.assign(chapters, value.chapters);
        root.setAttribute(chaptersAttribute, JSON.stringify(chapters));
        const courses = parseObject(root.getAttribute(courseAttribute));
        delete courses[scopeKey(scope)];
        if (value.course) courses[scopeKey(scope)] = value.course;
        root.setAttribute(courseAttribute, JSON.stringify(courses));
        if (value.decision) {
          const decision = value.decision === 'pending' ? 'declined' : value.decision;
          root.setAttribute(decisionAttribute, decision);
          if (decision === 'declined') root.setAttribute(declinedAttribute, 'true');
        }
      } else if (initialDecision) {
        root.setAttribute(decisionAttribute, initialDecision);
        if (initialDecision === 'declined') root.setAttribute(declinedAttribute, 'true');
      }
    }
    applying = false;
  };
  synchronizeScope();
  initialized = true;
  const requestDecision = (scope?: CourseSessionScope): Promise<boolean> => {
    synchronizeScope();
    if (scope && (!currentScope || !validScope(scope) || scopeKey(scope) !== scopeKey(currentScope))) return Promise.resolve(false);
    const decision = readDecision();
    if (decision === 'accepted' || decision === 'declined') return Promise.resolve(decision === 'accepted');
    if (decisionPromise) return decisionPromise;
    const expectedScope = currentScope && scopeKey(currentScope);
    const expectedGeneration = scopeGeneration;
    root.setAttribute(decisionAttribute, 'pending');
    save();
    const explicitDecision = new Promise<boolean>((resolve) => { overrideDecision = resolve; });
    const confirmation = Promise.resolve().then(() => options.confirm()).catch(() => false);
    const pending = Promise.race([confirmation, explicitDecision]).then((accepted) => {
      synchronizeScope();
      if ((currentScope && scopeKey(currentScope)) !== expectedScope || scopeGeneration !== expectedGeneration) return false;
      root.setAttribute(decisionAttribute, accepted ? 'accepted' : 'declined');
      if (!accepted) root.setAttribute(declinedAttribute, 'true');
      else root.removeAttribute(declinedAttribute);
      root.dispatchEvent(new Event('chaoxing-plus:manual-answer-decision'));
      save();
      return accepted;
    }).finally(() => {
      if (decisionPromise === pending) { decisionPromise = undefined; overrideDecision = undefined; }
    });
    decisionPromise = pending;
    return pending;
  };
  const resumeDecision = (scope?: CourseSessionScope): Promise<boolean> => {
    synchronizeScope();
    if (scope && (!currentScope || !validScope(scope) || scopeKey(scope) !== scopeKey(currentScope))) return Promise.resolve(false);
    root.removeAttribute(declinedAttribute);
    root.setAttribute(decisionAttribute, 'accepted');
    try { delete registry.__chaoxing_plus_manual_answer_declined__; } catch { /* Ignore a page-owned property. */ }
    overrideDecision?.(true);
    root.dispatchEvent(new Event('chaoxing-plus:manual-answer-decision'));
    save();
    return Promise.resolve(true);
  };
  const api: CourseSession = {
    ready: async () => { synchronizeScope(); return true; },
    requestManualDecision: requestDecision,
    resumeManualDecision: resumeDecision,
    canReload() {
      synchronizeScope();
      save();
      if (currentScope && !noDiskWrite() && storageAvailable) return true;
      return !readDecision() && Object.keys(parseObject(root.getAttribute(chaptersAttribute))).length === 0
        && Object.keys(parseObject(root.getAttribute(courseAttribute))).length === 0;
    },
    persist() { synchronizeScope(); save(); }
  };
  registry[registryKey] = { document: owner.document, api };
  const Observer = (owner as Window & { MutationObserver: typeof MutationObserver }).MutationObserver;
  new Observer((mutations) => {
    if (!applying && mutations.some((mutation) => attributes.includes(mutation.attributeName || ''))) api.persist();
  }).observe(root, { attributes: true, attributeFilter: attributes });
  owner.addEventListener('pagehide', () => api.persist());
  owner.addEventListener('message', (event: MessageEvent) => {
    const message = event.data;
    if (!object(message) || message.namespace !== namespace || !['hello', 'decision', 'resume'].includes(String(message.kind))
      || typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{1,160}$/.test(message.id) || !allowedChild(owner, event)) return;
    synchronizeScope();
    const source = event.source as Window;
    const replyScope = currentScope;
    const replyRun = runId;
    const matches = Boolean(currentScope && (!message.scope || (validScope(message.scope) && scopeKey(message.scope) === scopeKey(currentScope))));
    const respond = (kind: string, extra: Record<string, unknown>) => {
      try { source.postMessage({ namespace, kind, id: message.id, scope: replyScope, runId: replyRun, ...extra }, event.origin); } catch { /* Source left the course. */ }
    };
    if (message.kind === 'hello') respond('ready', { accepted: matches });
    else if (!matches || !validScope(message.scope) || message.runId !== runId) respond('result', { accepted: false });
    else {
      const requestedScope = message.scope;
      respond('accepted', {});
      void (message.kind === 'resume' ? resumeDecision(requestedScope) : requestDecision(requestedScope))
        .then((accepted) => respond('result', { accepted }));
    }
  });
  return api;
}

function initializeRemoteSession(frame: Window, owner: Window, options: SessionOptions): CourseSession {
  const timeoutMs = Math.max(50, Math.min(10000, options.handshakeMs || 2500));
  let remoteScope: CourseSessionScope | undefined;
  let remoteOrigin: string | undefined;
  let remoteRun: string | undefined;
  const pending = new Map<string, { resolve: (accepted: boolean) => void; timer?: ReturnType<typeof setTimeout> }>();
  const helloId = messageId(frame);
  let readyResolve: (accepted: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { readyResolve = resolve; });
  let completedHandshake = false;
  const finish = (accepted: boolean) => {
    if (completedHandshake) return;
    completedHandshake = true;
    clearTimeout(timeout);
    clearInterval(interval);
    readyResolve(accepted);
  };
  frame.addEventListener('message', (event: MessageEvent) => {
    const message = event.data;
    if (event.source !== owner || !/^https?:\/\//.test(event.origin) || !object(message) || message.namespace !== namespace
      || typeof message.id !== 'string') return;
    if (message.kind === 'ready' && message.id === helloId && !completedHandshake) {
      if (message.accepted === true && validScope(message.scope) && typeof message.runId === 'string') {
        remoteScope = message.scope;
        remoteOrigin = event.origin;
        remoteRun = message.runId;
        finish(true);
      } else finish(false);
      return;
    }
    if (event.origin !== remoteOrigin || !validScope(message.scope) || !remoteScope
      || scopeKey(message.scope) !== scopeKey(remoteScope) || message.runId !== remoteRun) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.kind === 'accepted') {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
    } else if (message.kind === 'result' && typeof message.accepted === 'boolean') {
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(message.id);
      entry.resolve(message.accepted);
    }
  });
  const hello = () => {
    try { owner.postMessage({ namespace, kind: 'hello', id: helloId, scope: readScope(frame) }, '*'); } catch { /* Await the bounded handshake. */ }
  };
  const timeout = setTimeout(() => finish(false), timeoutMs);
  const interval = setInterval(hello, Math.min(100, timeoutMs));
  hello();
  const request = async (kind: 'decision' | 'resume', scope?: CourseSessionScope) => {
      if (!await ready || !remoteScope || !remoteOrigin || (scope && (!validScope(scope) || scopeKey(scope) !== scopeKey(remoteScope)))) return false;
      const id = messageId(frame);
      const targetOrigin = remoteOrigin;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve(false); }, timeoutMs);
        pending.set(id, { resolve, timer });
        try { owner.postMessage({ namespace, kind, id, scope: remoteScope, runId: remoteRun }, targetOrigin); }
        catch { clearTimeout(timer); pending.delete(id); resolve(false); }
      });
  };
  return {
    ready: () => ready,
    requestManualDecision: (scope) => request('decision', scope),
    resumeManualDecision: (scope) => request('resume', scope),
    canReload: () => false,
    persist() { /* Only the owner may persist the shared course state. */ }
  };
}
