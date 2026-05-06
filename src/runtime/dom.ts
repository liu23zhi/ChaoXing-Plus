export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function observeDOM(target: ParentNode, callback: () => void): () => void {
  const observer = new MutationObserver(() => callback());
  observer.observe(target, { childList: true, subtree: true, attributes: true });
  return () => observer.disconnect();
}

export function cleanText(input: Element | string): string {
  const value = typeof input === 'string' ? input : input.textContent ?? '';
  return value.replace(/\s+/g, ' ').trim();
}
