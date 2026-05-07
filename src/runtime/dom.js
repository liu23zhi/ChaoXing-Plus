export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function observeDOM(target, callback) {
    const observer = new MutationObserver(() => callback());
    observer.observe(target, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect();
}
export function cleanText(input) {
    const value = typeof input === 'string' ? input : input.textContent ?? '';
    return value.replace(/\s+/g, ' ').trim();
}
