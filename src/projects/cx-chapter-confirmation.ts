import { getChapterSubmissionConfirmation } from './cx-chapter-dialog.js';

type ConfirmationWindow = Window & Record<string, any>;
type Confirmation = NonNullable<ReturnType<typeof getChapterSubmissionConfirmation>>;
type BoundConfirmation = Confirmation & { ownerWindow: ConfirmationWindow; document: Document };
type Lease = { ambiguous: boolean };
type LeaseRegistry = { document: Document; leases: Set<Lease> };
type Owner = {
  ownerWindow: ConfirmationWindow;
  document: Document;
  registry: LeaseRegistry;
  lease: Lease;
  initialPopups: Map<HTMLElement, boolean>;
};

const confirmationLeaseKey = '__chaoxingPlusChapterConfirmationLeaseV1';
const confirmationSelector = '#workpop, #confirmSubWin';

function isConfirmationContainerVisible(element: HTMLElement): boolean {
  const owner = element.ownerDocument.defaultView;
  if (!owner || !element.isConnected) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden) return false;
    const style = owner.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return element.getClientRects().length > 0;
}

export function createChapterConfirmationSession(
  frameWindow: ConfirmationWindow,
  actionOwnerWindow: ConfirmationWindow,
  options: { jobId?: string; isCurrent: () => boolean }
) {
  const frameDocument = frameWindow.document;
  const owners: Owner[] = [];
  let bound: BoundConfirmation | undefined;
  let released = false;

  const scope = (ownerWindow: ConfirmationWindow, doc: Document) => {
    const ids = Array.from(doc.querySelectorAll<HTMLInputElement>('input[name="jobid"],input[name="jobId"],input#jobid'))
      .map((input) => input.value).filter(Boolean);
    if (options.jobId && ids.some((id) => id !== options.jobId)) return 'foreign';
    if (ownerWindow === frameWindow || ownerWindow === actionOwnerWindow || (options.jobId && ids.length)) return 'owned';
    return 'shared';
  };
  const taskIsCurrent = () => {
    try { return !released && frameWindow.document === frameDocument && options.isCurrent(); }
    catch { return false; }
  };
  const ownerIsCurrent = (owner: Owner) => {
    try {
      return owner.ownerWindow.document === owner.document
        && owner.ownerWindow[confirmationLeaseKey] === owner.registry
        && owner.registry.leases.has(owner.lease)
        && !owner.lease.ambiguous && scope(owner.ownerWindow, owner.document) !== 'foreign';
    } catch { return false; }
  };
  const release = () => {
    if (released) return;
    released = true;
    bound = undefined;
    for (const owner of owners) {
      owner.registry.leases.delete(owner.lease);
      try {
        if (!owner.registry.leases.size && owner.ownerWindow[confirmationLeaseKey] === owner.registry) {
          delete owner.ownerWindow[confirmationLeaseKey];
        }
      } catch { /* The owner can navigate while an old attempt is released. */ }
    }
  };

  try {
    if (!taskIsCurrent()) throw new Error('答题任务或文档已切换，已取消提交确认。');
    const pending = [frameWindow, actionOwnerWindow];
    const visited = new Set<ConfirmationWindow>();
    const candidates: Array<Omit<Owner, 'registry' | 'lease'>> = [];
    while (pending.length) {
      const ownerWindow = pending.shift()!;
      if (visited.has(ownerWindow)) continue;
      visited.add(ownerWindow);
      try { if (ownerWindow.parent !== ownerWindow) pending.push(ownerWindow.parent as ConfirmationWindow); }
      catch { /* A restricted ancestor cannot host a local confirmation. */ }
      let doc: Document;
      try { doc = ownerWindow.document; } catch { continue; }
      const ownerScope = scope(ownerWindow, doc);
      if (ownerScope === 'foreign') continue;
      const initialPopups = new Map(Array.from(doc.querySelectorAll<HTMLElement>(confirmationSelector))
        .map((popup) => [popup, isConfirmationContainerVisible(popup)] as const));
      if (ownerScope === 'shared' && Array.from(initialPopups.values()).some(Boolean)) {
        throw new Error('父页面已有未确认归属的弹窗，已暂停本次提交，请先处理该提示。');
      }
      candidates.push({ ownerWindow, document: doc, initialPopups });
    }
    for (const candidate of candidates) {
      const ownerWindow = candidate.ownerWindow;
      let registry = ownerWindow[confirmationLeaseKey] as LeaseRegistry | undefined;
      if (!registry || registry.document !== candidate.document) {
        registry = { document: candidate.document, leases: new Set() };
        ownerWindow[confirmationLeaseKey] = registry;
      }
      const lease: Lease = { ambiguous: registry.leases.size > 0 };
      // A late exit must not make an overlapping precheck appear uniquely owned again.
      registry.leases.forEach((other) => { other.ambiguous = true; });
      registry.leases.add(lease);
      owners.push({ ...candidate, registry, lease });
    }
  } catch (error) {
    release();
    throw error;
  }

  const current = (): BoundConfirmation | undefined => {
    if (!bound || !taskIsCurrent()) return undefined;
    const owner = owners.find((entry) => entry.document === bound!.document);
    if (!owner || !ownerIsCurrent(owner)) return undefined;
    const matched = getChapterSubmissionConfirmation(owner.document);
    if (!matched || matched.popup !== bound.popup || matched.dialog !== bound.dialog
      || matched.content !== bound.content || matched.submit !== bound.submit || matched.cancel !== bound.cancel) return undefined;
    return bound;
  };
  return {
    find(): BoundConfirmation | undefined {
      if (!taskIsCurrent()) throw new Error('答题任务或文档已切换，已取消提交确认。');
      if (bound) {
        const matched = current();
        if (!matched) throw new Error('本次提交确认已失效，已取消提交。');
        return matched;
      }
      const matches: BoundConfirmation[] = [];
      for (const owner of owners) {
        try {
          if (owner.ownerWindow.document !== owner.document) continue;
        } catch { continue; }
        if (scope(owner.ownerWindow, owner.document) === 'foreign') continue;
        const matched = getChapterSubmissionConfirmation(owner.document);
        if (!matched) continue;
        if (!ownerIsCurrent(owner)) throw new Error('提交确认归属存在并发冲突，已停止本次提交。');
        if (scope(owner.ownerWindow, owner.document) === 'shared' && owner.initialPopups.get(matched.popup)) continue;
        matches.push({ ...matched, ownerWindow: owner.ownerWindow, document: owner.document });
      }
      if (matches.length > 1) throw new Error('出现多个提交确认窗口，无法确定归属，已停止本次提交。');
      bound = matches[0];
      return bound;
    },
    current,
    clear() { bound = undefined; },
    release
  };
}
