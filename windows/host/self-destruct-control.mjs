import { createSelfDestructMonitor, SELF_DESTRUCT_STATES } from './self-destruct.mjs';

// 自毁控制：把页面热键/全屏、CXExam 进程事件接入状态机，并在获批后执行
// 确认、延迟与最终清理回调。确认只在交互控制台询问；无人值守时必须显式
// 使用 --no-self-destruct-confirm，否则不执行破坏性操作。

export function createSelfDestructController({
  keys = [],
  fullscreenExit = false,
  delayMs = 0,
  confirm = true,
  interactive = Boolean(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY),
  logger = () => {},
  confirmFn = null,
  onDestruct = async () => {},
  onTransition = () => {}
} = {}) {
  let monitor = createSelfDestructMonitor({
    selfDestructKeys: keys,
    onTransition: (transition) => {
      try { onTransition(transition); } catch { /* observers cannot break lifecycle */ }
      if (transition.state === SELF_DESTRUCT_STATES.DESTRUCT_REQUESTED) {
        void requestDestruction(transition.snapshot.requestReason || 'unknown');
      }
    }
  });
  let destroying = false;
  let clientPid = 0;
  let fullscreenSeen = false;

  async function askConfirmation(reason) {
    if (!confirm) return true;
    if (typeof confirmFn === 'function') return Boolean(await confirmFn(reason));
    if (!interactive) {
      logger('[self-destruct] 需要确认但当前无交互控制台；未执行自毁（请使用 --no-self-destruct-confirm 显式允许）');
      return false;
    }
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`自毁将删除程序痕迹且不可恢复（原因：${reason}），确认执行？[y/N] `);
      return /^y(?:es)?$/iu.test(String(answer || '').trim());
    } finally {
      rl.close();
    }
  }

  async function requestDestruction(reason) {
    if (destroying) return;
    destroying = true;
    try {
      const approved = await askConfirmation(reason);
      if (!approved) {
        logger('[self-destruct] 已取消自毁');
        destroying = false;
        return;
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      logger(`[self-destruct] 开始执行（原因：${reason}）`);
      await onDestruct(reason);
    } catch (error) {
      logger(`[self-destruct] 执行失败：${error && error.message ? error.message : String(error)}`);
    }
  }

  return {
    attachClient(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return;
      clientPid = pid;
      monitor.dispatch({ type: 'client-started', pid, owned: true });
    },
    handleHotkey(shortcut) {
      if (!clientPid) return;
      monitor.dispatch({ type: 'shortcut', shortcut: String(shortcut || '') });
    },
    handleFullscreen(fullscreen, pid = clientPid) {
      if (!clientPid || !fullscreenExit || pid !== clientPid) return;
      fullscreenSeen = Boolean(fullscreen);
      monitor.dispatch({ type: 'fullscreen-change', pid: clientPid, fullscreen: Boolean(fullscreen) });
    },
    clientExited(pid = clientPid) {
      if (!clientPid || pid !== clientPid) return;
      monitor.dispatch({ type: 'process-exited', pid: clientPid });
    },
    get snapshot() {
      return { ...monitor.getSnapshot(), fullscreenSeen, destroying, clientPid };
    }
  };
}
