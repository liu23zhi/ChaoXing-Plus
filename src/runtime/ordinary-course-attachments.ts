/** These page-provided hints never carry runtime authority. */
export type OrdinaryCourseAttachmentHint = {
  jobid?: string;
  job: boolean | undefined;
  isPassed: boolean | undefined;
  property: { mid: string; _jobid: string; name?: string; title?: string; bookname?: string; author?: string; };
};

const id = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,96}$/.test(value) ? value : '';
const label = (value: unknown) => typeof value === 'string' ? value.slice(0, 120).replace(/[<>\u0000-\u001f]/gu, '').trim() : '';
export function readOrdinaryCourseAttachments(doc: EventTarget = document): OrdinaryCourseAttachmentHint[] {
  const eventName = 'chaoxing-plus:ordinary-card-metadata';
  let result: OrdinaryCourseAttachmentHint[] = [];
  const onSnapshot = (event: Event) => {
    const raw = (event as CustomEvent).detail;
    if (typeof raw !== 'string' || raw.length > 65536) return;
    try {
      const list: unknown = JSON.parse(raw);
      if (!Array.isArray(list) || list.length > 64) return;
      const seen = new Set<string>();
      result = list.flatMap<OrdinaryCourseAttachmentHint>(entry => {
        if (!entry || typeof entry !== 'object' || !entry.property || typeof entry.property !== 'object') return [];
        const jobid = id(entry.jobid);
        const _jobid = id(entry.property._jobid);
        const lookup = jobid || _jobid;
        if (!lookup || seen.has(lookup)) return [];
        seen.add(lookup);
        const property = { mid: id(entry.property.mid), _jobid };
        for (const key of ['name', 'title', 'bookname', 'author'] as const) {
          const value = label(entry.property[key]);
          if (value) Object.assign(property, { [key]: value });
        }
        return [{ ...(jobid ? { jobid } : {}), job: typeof entry.job === 'boolean' ? entry.job : undefined,
          isPassed: typeof entry.isPassed === 'boolean' ? entry.isPassed : undefined, property }];
      });
    } catch { /* Ignore malformed page hints. */ }
  };
  doc.addEventListener(eventName, onSnapshot);
  try { doc.dispatchEvent(new Event('chaoxing-plus:ordinary-card-metadata-read')); }
  finally { doc.removeEventListener(eventName, onSnapshot); }
  return result;
}
