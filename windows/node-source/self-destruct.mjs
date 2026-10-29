// Pure design model: no hotkeys, process hooks, termination or deletion is installed.
export const SELF_DESTRUCT_STATES = Object.freeze({
  IDLE: 'idle',
  WATCHING_CLIENT: 'watching-client',
  FULLSCREEN_SEEN: 'fullscreen-seen',
  DESTRUCT_REQUESTED: 'destruct-requested',
  CLOSING_INJECTION: 'closing-injection',
  CLEANING: 'cleaning',
  FINISHED: 'finished'
});

const modifierOrder = ['ctrl', 'alt', 'shift', 'meta'];
const modifierAliases = new Map([
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['shift', 'shift'],
  ['meta', 'meta'],
  ['cmd', 'meta'],
  ['command', 'meta'],
  ['win', 'meta'],
  ['windows', 'meta'],
  ['super', 'meta']
]);

function normalizeShortcut(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const parts = value.split('+').map((part) => part.trim().toLowerCase());
  if (parts.some((part) => !part)) return '';

  const modifiers = new Set();
  const keys = [];
  for (const part of parts) {
    const modifier = modifierAliases.get(part);
    if (modifier) modifiers.add(modifier);
    else keys.push(part === 'esc' ? 'escape' : part === 'spacebar' ? 'space' : part);
  }
  if (keys.length !== 1) return '';

  return [...modifierOrder.filter((modifier) => modifiers.has(modifier)), keys[0]].join('+');
}

function isValidPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function snapshot(state, clientPid, fullscreenSeen, requestReason) {
  return Object.freeze({ state, clientPid, fullscreenSeen, requestReason });
}

export function createSelfDestructMonitor({
  selfDestructKeys = [],
  onTransition
} = {}) {
  if (!Array.isArray(selfDestructKeys)) {
    throw new TypeError('selfDestructKeys 必须是字符串数组');
  }
  if (selfDestructKeys.some((key) => typeof key !== 'string' || !normalizeShortcut(key))) {
    throw new TypeError('selfDestructKeys 中包含无效快捷键');
  }
  if (onTransition !== undefined && typeof onTransition !== 'function') {
    throw new TypeError('onTransition 必须是函数');
  }
  const configuredKeys = new Set(selfDestructKeys.map(normalizeShortcut));
  const notify = onTransition || (() => {});
  let state = SELF_DESTRUCT_STATES.IDLE;
  let clientPid = null;
  let fullscreenSeen = false;
  let requestReason = '';
  const getSnapshot = () => snapshot(state, clientPid, fullscreenSeen, requestReason);

  function dispatch(event) {
    if (!event || typeof event !== 'object') {
      return { accepted: false, previousState: state, state, reason: '', snapshot: getSnapshot() };
    }

    const previousState = state;
    let reason = '';

    if (event.type === 'client-started'
      && state === SELF_DESTRUCT_STATES.IDLE
      && event.owned === true
      && isValidPid(event.pid)) {
      clientPid = event.pid;
      state = SELF_DESTRUCT_STATES.WATCHING_CLIENT;
      reason = 'client-started';
    } else if (event.type === 'shortcut'
      && (state === SELF_DESTRUCT_STATES.WATCHING_CLIENT || state === SELF_DESTRUCT_STATES.FULLSCREEN_SEEN)
      && configuredKeys.has(normalizeShortcut(event.shortcut))) {
      state = SELF_DESTRUCT_STATES.DESTRUCT_REQUESTED;
      requestReason = 'shortcut';
      reason = requestReason;
    } else if (event.type === 'fullscreen-change'
      && event.pid === clientPid
      && typeof event.fullscreen === 'boolean') {
      if (state === SELF_DESTRUCT_STATES.WATCHING_CLIENT && event.fullscreen) {
        state = SELF_DESTRUCT_STATES.FULLSCREEN_SEEN;
        fullscreenSeen = true;
        reason = 'fullscreen-entered';
      } else if (state === SELF_DESTRUCT_STATES.FULLSCREEN_SEEN && !event.fullscreen) {
        state = SELF_DESTRUCT_STATES.DESTRUCT_REQUESTED;
        requestReason = 'fullscreen-exit';
        reason = requestReason;
      }
    } else if (event.type === 'process-exited'
      && event.pid === clientPid
      && (state === SELF_DESTRUCT_STATES.WATCHING_CLIENT || state === SELF_DESTRUCT_STATES.FULLSCREEN_SEEN)) {
      state = SELF_DESTRUCT_STATES.DESTRUCT_REQUESTED;
      requestReason = 'client-exited';
      reason = requestReason;
    } else if (event.type === 'destruct-approved' && state === SELF_DESTRUCT_STATES.DESTRUCT_REQUESTED) {
      state = SELF_DESTRUCT_STATES.CLOSING_INJECTION;
      reason = 'destruct-approved';
    } else if (event.type === 'injection-closed' && state === SELF_DESTRUCT_STATES.CLOSING_INJECTION) {
      state = SELF_DESTRUCT_STATES.CLEANING;
      reason = 'injection-closed';
    } else if (event.type === 'cleanup-finished' && state === SELF_DESTRUCT_STATES.CLEANING) {
      state = SELF_DESTRUCT_STATES.FINISHED;
      reason = 'cleanup-finished';
    }

    if (state === previousState) {
      return { accepted: false, previousState, state, reason: '', snapshot: getSnapshot() };
    }

    const transition = { accepted: true, previousState, state, reason, snapshot: getSnapshot() };
    try {
      notify(transition);
    } catch {
      // Observers must not interrupt lifecycle state transitions.
    }
    return transition;
  }

  return Object.freeze({
    dispatch,
    getSnapshot
  });
}
