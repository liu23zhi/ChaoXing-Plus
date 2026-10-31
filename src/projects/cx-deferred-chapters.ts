export type DeferredChapterTask = {
  tabKey: string;
  jobId: string;
  attempts: number;
  state: 'deferred' | 'complete' | 'abandoned';
  terminalExpired: boolean;
  missingVisits: number;
};

export type ChapterDeferredState = {
  scope: string;
  phase: 'scan' | 'retry' | 'settled';
  inspectedTabs: string[];
  tasks: Record<string, DeferredChapterTask>;
};

function taskKey(tabKey: string, jobId: string) {
  return JSON.stringify([tabKey, jobId]);
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

export function createChapterDeferredState(scope: string): ChapterDeferredState {
  return { scope, phase: 'scan', inspectedTabs: [], tasks: {} };
}

export function readChapterDeferredState(value: unknown, scope: string): ChapterDeferredState {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return createChapterDeferredState(scope);
    }
  }
  const state = createChapterDeferredState(scope);
  if (!value || typeof value !== 'object') return state;
  const record = value as Record<string, unknown>;
  if (record.scope !== scope) return state;
  if (record.phase === 'retry' || record.phase === 'settled') state.phase = record.phase;
  if (Array.isArray(record.inspectedTabs)) {
    state.inspectedTabs = [...new Set(record.inspectedTabs.filter((tab): tab is string => typeof tab === 'string' && tab.length > 0))];
  }
  if (!record.tasks || typeof record.tasks !== 'object' || Array.isArray(record.tasks)) return state;
  for (const item of Object.values(record.tasks)) {
    if (!item || typeof item !== 'object') continue;
    const task = item as Record<string, unknown>;
    if (typeof task.tabKey !== 'string' || !task.tabKey || typeof task.jobId !== 'string' || !task.jobId) continue;
    const terminalExpired = task.terminalExpired === true;
    state.tasks[taskKey(task.tabKey, task.jobId)] = {
      tabKey: task.tabKey,
      jobId: task.jobId,
      attempts: nonNegativeInteger(task.attempts),
      state: terminalExpired || task.state === 'abandoned' ? 'abandoned' : task.state === 'complete' ? 'complete' : 'deferred',
      terminalExpired,
      missingVisits: nonNegativeInteger(task.missingVisits)
    };
  }
  return state;
}

export function recordChapterDeferral(state: ChapterDeferredState, tabKey: string, jobId: string): DeferredChapterTask {
  const key = taskKey(tabKey, jobId);
  const existing = state.tasks[key];
  if (existing) return existing;
  const task: DeferredChapterTask = {
    tabKey, jobId, attempts: 0, state: 'deferred', terminalExpired: false, missingVisits: 0
  };
  state.tasks[key] = task;
  state.phase = 'scan';
  return task;
}

export function markChapterTabInspected(state: ChapterDeferredState, tabKey: string): void {
  if (!state.inspectedTabs.includes(tabKey)) state.inspectedTabs.push(tabKey);
}

export function getNextUninspectedChapterTab(state: ChapterDeferredState, tabKeys: readonly string[]): string | undefined {
  return tabKeys.find((tabKey) => !state.inspectedTabs.includes(tabKey));
}

export function chooseNextDeferredChapterTask(
  state: ChapterDeferredState,
  tabKeys: readonly string[],
  maxAttempts: number
): DeferredChapterTask | undefined {
  if (getNextUninspectedChapterTab(state, tabKeys) !== undefined) {
    state.phase = 'scan';
    return undefined;
  }
  const limit = nonNegativeInteger(maxAttempts);
  const tasks = Object.values(state.tasks);
  for (const task of tasks) {
    if (task.state === 'deferred' && (task.terminalExpired || task.attempts >= limit)) task.state = 'abandoned';
  }
  const pending = tasks.filter((task) => task.state === 'deferred');
  // Keep discovery order inside each tab and use the current page's tab order.
  const next = tabKeys.map((tabKey) => pending.find((task) => task.tabKey === tabKey)).find(Boolean) ?? pending[0];
  state.phase = next ? 'retry' : 'settled';
  return next;
}

export function markDeferredChapterAttempt(
  state: ChapterDeferredState,
  tabKey: string,
  jobId: string,
  maxAttempts: number
): boolean {
  const task = state.tasks[taskKey(tabKey, jobId)];
  if (!task || task.state !== 'deferred') return false;
  if (task.terminalExpired || task.attempts >= nonNegativeInteger(maxAttempts)) {
    task.state = 'abandoned';
    return false;
  }
  task.attempts += 1;
  task.missingVisits = 0;
  return true;
}

export function markDeferredChapterResult(
  state: ChapterDeferredState,
  tabKey: string,
  jobId: string,
  result: { finished?: boolean; terminalExpired?: boolean; manual?: boolean },
  maxAttempts: number
): void {
  const task = state.tasks[taskKey(tabKey, jobId)];
  if (!task || task.state !== 'deferred') return;
  if (result.terminalExpired) {
    task.terminalExpired = true;
    task.state = 'abandoned';
  } else if (result.manual) {
    // Pair this result with a successful attempt reservation before opening the worker.
    task.attempts = Math.max(0, task.attempts - 1);
  } else if (result.finished) {
    task.state = 'complete';
    task.missingVisits = 0;
  } else if (task.attempts >= nonNegativeInteger(maxAttempts)) {
    task.state = 'abandoned';
  }
}

export function markDeferredChapterMissing(
  state: ChapterDeferredState,
  tabKey: string,
  jobId: string,
  maxMissingVisits: number
): boolean {
  const task = state.tasks[taskKey(tabKey, jobId)];
  if (!task) return false;
  if (task.state !== 'deferred') return task.state === 'abandoned';
  task.missingVisits += 1;
  if (task.missingVisits >= nonNegativeInteger(maxMissingVisits)) task.state = 'abandoned';
  return task.state === 'abandoned';
}
