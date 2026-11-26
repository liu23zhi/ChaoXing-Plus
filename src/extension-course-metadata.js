// MAIN contains only this passive projection of the existing ordinary cards metadata.
(() => {
  if (!/^\/knowledge\/cards(?:\/|$)/u.test(location.pathname)) return;
  const request = 'chaoxing-plus:ordinary-card-metadata-read';
  const response = 'chaoxing-plus:ordinary-card-metadata';
  const propertyKeys = ['name', 'title', 'bookname', 'author'];
  const read = (object, key) => object != null && Object.getOwnPropertyDescriptor(object, key)?.value;
  const id = value => {
    const text = typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : '';
    return /^[a-zA-Z0-9._-]{1,96}$/.test(text) ? text : '';
  };
  const label = value => typeof value === 'string' ? value.slice(0, 120).replace(/[<>\u0000-\u001f]/gu, '').trim() : '';
  document.addEventListener(request, () => {
    const list = read(window, 'attachments');
    if (!Array.isArray(list)) return;
    const hints = [];
    const seen = new Set();
    // No arbitrary page fields, dynamic requests, credentials or write operations.
    for (let index = 0; index < Math.min(list.length, 64); index++) {
      const entry = read(list, index);
      const property = read(entry, 'property');
      const primaryId = id(read(entry, 'jobid'));
      const secondaryId = id(read(property, '_jobid'));
      const lookup = primaryId || secondaryId;
      if (!lookup || seen.has(lookup)) continue;
      seen.add(lookup);
      const job = read(entry, 'job');
      const isPassed = read(entry, 'isPassed');
      const metadata = { mid: id(read(property, 'mid')), _jobid: secondaryId };
      for (const key of propertyKeys) {
        const value = label(read(property, key));
        if (value) metadata[key] = value;
      }
      hints.push({ jobid: primaryId || undefined, job: typeof job === 'boolean' ? job : undefined,
        isPassed: typeof isPassed === 'boolean' ? isPassed : undefined, property: metadata });
    }
    document.dispatchEvent(new CustomEvent(response, { detail: JSON.stringify(hints) }));
  });
})();
