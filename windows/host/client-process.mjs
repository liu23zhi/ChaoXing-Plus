/**
 * Observe only the child process created by this host.
 *
 * This deliberately does not search for arbitrary CXExam.exe processes. The
 * host already owns the child returned by spawnClient(), so exit/error events
 * can be tied to the current run without touching another session.
 */
export function observeClientProcess(child, {
  onExit = () => {},
  onError = () => {}
} = {}) {
  if (!child || typeof child.once !== 'function') {
    throw new TypeError('client child process must support once()');
  }
  if (typeof onExit !== 'function' || typeof onError !== 'function') {
    throw new TypeError('client process observers must be functions');
  }

  let settled = false;
  let detached = false;
  const handleExit = (code, signal) => {
    if (settled || detached) return;
    settled = true;
    onExit({ code: code === undefined ? null : code, signal: signal || null });
  };
  const handleError = (error) => {
    if (settled || detached) return;
    settled = true;
    onError(error);
  };

  child.once('exit', handleExit);
  child.once('error', handleError);

  // A test double or a very short-lived process may already have exited
  // before observers are attached. Queue the same event once in that case.
  if (child.exitCode !== null && child.exitCode !== undefined) {
    queueMicrotask(() => handleExit(child.exitCode, child.signalCode));
  }

  return () => {
    if (detached) return;
    detached = true;
    if (typeof child.removeListener === 'function') {
      child.removeListener('exit', handleExit);
      child.removeListener('error', handleError);
    }
  };
}
