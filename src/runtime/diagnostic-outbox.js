// Local T08 core, intentionally not imported by any runtime entry. The
// caller binds storage to an approved owner/destination and one fixed stream;
// nothing in the event can choose a recipient, credential, or stream.
export const DIAGNOSTIC_OUTBOX_PENDING_LIMIT = 64;
export const DIAGNOSTIC_OUTBOX_BATCH_LIMIT = 24;

const MODES = new Set(['extension', 'native_browser', 'native_exam']);
const LEVELS = new Set(['info', 'warn', 'error', 'debug']);
const EVENTS = new Set([
  'extension.ready', 'settings.saved', 'sync.success', 'sync.failed',
  'network.timeout', 'network.offline', 'runtime.error'
]);
const SCOPE_FIELDS = ['mode', 'version', 'device_id', 'launch_id'];
const ENTRY_FIELDS = ['time', 'event', 'level'];
const OPTIONAL_FIELDS = ['duration_ms', 'count'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VERSION = /^(dev|[0-9]{1,6}(\.[0-9]{1,6}){1,3})$/;
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_MILLIS = /^[2-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

function record(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function only(value, required, optional = []) {
  return record(value) && required.every(key => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every(key => required.includes(key) || optional.includes(key));
}

const count = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const uuid = v => typeof v === 'string' && UUID.test(v);
const device = v => typeof v === 'string' && DEVICE.test(v) && !v.includes('..');

function validScope(v) {
  if (!record(v) || !MODES.has(v.mode)) return false;
  const fields = v.mode === 'native_browser' ? [...SCOPE_FIELDS, 'browser_id'] : SCOPE_FIELDS;
  return only(v, fields) && typeof v.version === 'string' && VERSION.test(v.version) &&
    device(v.device_id) && uuid(v.launch_id) && (v.mode !== 'native_browser' || device(v.browser_id));
}

function validEntry(e, persisted = false) {
  const fields = persisted ? [...ENTRY_FIELDS, 'event_id', 'event_seq'] : ENTRY_FIELDS;
  if (!only(e, fields, OPTIONAL_FIELDS) || !EVENTS.has(e.event) || !LEVELS.has(e.level) ||
    typeof e.time !== 'string' || !UTC_MILLIS.test(e.time)) return false;
  const ts = Date.parse(e.time);
  return Number.isFinite(ts) && new Date(ts).toISOString() === e.time &&
    (!Object.hasOwn(e, 'duration_ms') || count(e.duration_ms, 0, 86_400_000)) &&
    (!Object.hasOwn(e, 'count') || count(e.count, 0, 1_000_000));
}

function sameRecord(a, b) {
  return Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}

function snapshotFor(saved, scope) {
  if (saved === null || saved === undefined) {
    return {schema: 1, scope, next_seq: 1, entries: [], batch: null};
  }
  const ids = new Set();
  const {entries, batch, next_seq: next} = saved;
  if (!only(saved, ['schema', 'scope', 'next_seq', 'entries', 'batch']) || saved.schema !== 1 ||
    !validScope(saved.scope) || !sameRecord(scope, saved.scope) ||
    !count(next, 1, Number.MAX_SAFE_INTEGER) || !Array.isArray(entries) ||
    entries.length > DIAGNOSTIC_OUTBOX_PENDING_LIMIT || entries.length >= next ||
    !entries.every((e, idx) => {
      if (!validEntry(e, true) || !uuid(e.event_id) || ids.has(e.event_id) || e.event_seq !== next - entries.length + idx) return false;
      ids.add(e.event_id);
      return true;
    }) || (batch !== null && (!only(batch, ['batch_id', 'size']) || !uuid(batch.batch_id) ||
      !count(batch.size, 1, Math.min(DIAGNOSTIC_OUTBOX_BATCH_LIMIT, entries.length))))) {
    throw new TypeError('invalid or differently bound diagnostic outbox snapshot');
  }
  return saved;
}

function responseState(response, packet, scope) {
  const status = response?.status;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429 || (Number.isInteger(status) && status >= 500 && status < 600)) return 'retry';
  const receipt = response?.receipt;
  if ((status !== 200 && status !== 201) ||
    !only(receipt, ['scope', 'batch_id', 'accepted_event_ids']) || !validScope(receipt.scope) ||
    !sameRecord(scope, receipt.scope) || receipt.batch_id !== packet.batch_id ||
    !Array.isArray(receipt.accepted_event_ids) || receipt.accepted_event_ids.length !== packet.entries.length ||
    !packet.entries.every((event, i) => event.event_id === receipt.accepted_event_ids[i])) return 'unconfirmed';
  return 'accepted';
}

/**
 * storage.transact(fn) must serialize read/mutate/durable commit for this
 * stream. fn receives a JSON value (null if absent) and returns
 * {snapshot,value}; an unchanged snapshot means no write. A rejection must
 * not report a commit as complete. The adapter, not this module, owns any
 * cross-context storage lock. Transport runs outside storage transactions.
 *
 * The send/receipt shape below is an abstract local contract, not a server
 * HTTP format. Opening does not read settings, send, or schedule work.
 */
export function createDiagnosticOutbox({storage, scope, capacity = DIAGNOSTIC_OUTBOX_PENDING_LIMIT,
  batchSize = DIAGNOSTIC_OUTBOX_BATCH_LIMIT, randomId = () => globalThis.crypto.randomUUID()}) {
  if (!validScope(scope) || typeof storage?.transact !== 'function' || typeof randomId !== 'function' ||
    !count(capacity, 1, DIAGNOSTIC_OUTBOX_PENDING_LIMIT) || !count(batchSize, 1, DIAGNOSTIC_OUTBOX_BATCH_LIMIT)) {
    throw new TypeError('invalid diagnostic outbox configuration');
  }
  const bound = Object.freeze({...scope});
  if (!validScope(bound)) throw new TypeError('invalid diagnostic outbox configuration');
  const transact = fn => storage.transact(saved => fn(snapshotFor(saved, bound), saved));
  const unchanged = (saved, value) => ({snapshot: saved, value});
  let flushing = false;
  const newId = () => {
    const id = randomId();
    if (!uuid(id)) throw new TypeError('invalid diagnostic identifier');
    return id.toLowerCase();
  };

  async function enqueue(input) {
    // Copy validated scalar data before a deferred storage transaction.
    if (!validEntry(input)) throw new TypeError('invalid diagnostic event');
    const event = {...input};
    if (!validEntry(event)) throw new TypeError('invalid diagnostic event');
    return transact((state, saved) => {
      if (state.entries.length >= capacity) return unchanged(saved, {state:'full'});
      if (state.next_seq === Number.MAX_SAFE_INTEGER) return unchanged(saved, {state:'sequence-exhausted'});
      const event_id = newId();
      if (state.entries.some(e => e.event_id === event_id)) throw new TypeError('duplicate diagnostic identifier');
      const event_seq = state.next_seq;
      const entry = {...event, event_id, event_seq};
      return {
        snapshot: {...state, next_seq: event_seq + 1, entries: [...state.entries, entry]},
        value: {state:'queued', event_id, event_seq}
      };
    });
  }

  async function flush({enabled = false, transport} = {}) {
    if (enabled !== true) return {state:'disabled'};
    if (typeof transport !== 'function') throw new TypeError('diagnostic transport required');
    if (flushing) return {state:'busy'};
    flushing = true;
    try {
      const packet = await transact((state, saved) => {
        if (!state.entries.length) return unchanged(saved, null);
        const batch = state.batch ?? {batch_id: newId(), size: Math.min(batchSize, state.entries.length)};
        const entries = Object.freeze(state.entries.slice(0, batch.size).map(e => Object.freeze({...e})));
        const value = Object.freeze({...bound, batch_id: batch.batch_id, entries});
        return {snapshot: state.batch ? saved : {...state, batch}, value};
      });
      if (!packet) return {state:'empty'};
      let response;
      try { response = await transport(packet); } catch { return {state:'retry'}; }
      const status = responseState(response, packet, bound);
      if (status !== 'accepted') return {state:status};
      return await transact((state, saved) => {
        // Independent openers can retry the same persisted batch. A late
        // receipt must never delete another prefix staged since it was sent.
        if (state.batch?.batch_id !== packet.batch_id || state.batch.size !== packet.entries.length ||
          !packet.entries.every((e, i) => state.entries[i] && sameRecord(e, state.entries[i]))) {
          return unchanged(saved, {state:'stale-receipt'});
        }
        return {
          snapshot: {...state, entries: state.entries.slice(packet.entries.length), batch: null},
          value: {state:'accepted', accepted: packet.entries.length}
        };
      });
    } finally {
      flushing = false;
    }
  }

  function pendingCount() {
    return transact((state, saved) => unchanged(saved, state.entries.length));
  }

  return Object.freeze({enqueue, flush, pendingCount});
}
