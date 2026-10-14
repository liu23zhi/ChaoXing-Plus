export const DEFAULT_WORKER_THREAD_COUNT = 4;
export function resolveWorkerThreadCount(thread) {
    if (thread === undefined || !Number.isFinite(thread)) {
        return DEFAULT_WORKER_THREAD_COUNT;
    }
    return Math.max(1, Math.floor(thread));
}
