import test from 'node:test';
import assert from 'node:assert/strict';

import { createSelfDestructMonitor } from '../windows/node-source/self-destruct.mjs';

function startOwnedClient(monitor, pid = 42) {
  return monitor.dispatch({ type: 'client-started', pid, owned: true });
}

test('idle 状态忽略快捷键和进程退出，只有本次宿主启动的有效客户端才开始监控', () => {
  const monitor = createSelfDestructMonitor({ selfDestructKeys: ['F8'] });

  assert.equal(monitor.getSnapshot().state, 'idle');
  assert.equal(monitor.dispatch({ type: 'shortcut', shortcut: 'F8' }).accepted, false);
  assert.equal(monitor.dispatch({ type: 'process-exited', pid: 42 }).accepted, false);
  assert.equal(monitor.dispatch({ type: 'client-started', pid: 42, owned: false }).accepted, false);
  assert.equal(monitor.dispatch({ type: 'client-started', pid: 0, owned: true }).accepted, false);

  assert.deepEqual(startOwnedClient(monitor), {
    accepted: true,
    previousState: 'idle',
    state: 'watching-client',
    reason: 'client-started',
    snapshot: {
      state: 'watching-client',
      clientPid: 42,
      fullscreenSeen: false,
      requestReason: ''
    }
  });
});

test('多快捷键事件可命中任意配置快捷键并统一请求自毁', () => {
  const monitor = createSelfDestructMonitor({
    selfDestructKeys: ['Control + Alt + Shift + E', 'F8']
  });
  startOwnedClient(monitor, 91);

  assert.equal(monitor.dispatch({ type: 'shortcut', shortcut: 'Ctrl+Alt+X' }).accepted, false);
  assert.equal(monitor.dispatch({ type: 'shortcut', shortcut: 'Ctrl+Alt+Shift+E' }).accepted, true);
  assert.equal(monitor.getSnapshot().state, 'destruct-requested');
  assert.equal(monitor.getSnapshot().requestReason, 'shortcut');
});

test('全屏退出只有在同一客户端先进入全屏后才请求自毁', () => {
  const monitor = createSelfDestructMonitor({});
  startOwnedClient(monitor, 12);

  assert.equal(monitor.dispatch({ type: 'fullscreen-change', pid: 12, fullscreen: false }).accepted, false);
  assert.equal(monitor.dispatch({ type: 'fullscreen-change', pid: 999, fullscreen: true }).accepted, false);
  assert.equal(monitor.dispatch({ type: 'fullscreen-change', pid: 12, fullscreen: true }).state, 'fullscreen-seen');
  assert.equal(monitor.dispatch({ type: 'fullscreen-change', pid: 12, fullscreen: false }).state, 'destruct-requested');
  assert.equal(monitor.getSnapshot().fullscreenSeen, true);
  assert.equal(monitor.getSnapshot().requestReason, 'fullscreen-exit');
});

test('仅被监控客户端的进程结束事件会请求自毁', () => {
  const monitor = createSelfDestructMonitor({});
  startOwnedClient(monitor, 77);

  assert.equal(monitor.dispatch({ type: 'process-exited', pid: 78 }).accepted, false);
  assert.equal(monitor.dispatch({ type: 'process-exited', pid: 77 }).state, 'destruct-requested');
  assert.equal(monitor.getSnapshot().requestReason, 'client-exited');
});

test('确认后按关闭注入、清理、完成顺序推进，结束态不再转移', () => {
  const transitions = [];
  const monitor = createSelfDestructMonitor({
    selfDestructKeys: ['Escape'],
    onTransition: (transition) => transitions.push(transition.state)
  });
  startOwnedClient(monitor, 31);
  monitor.dispatch({ type: 'shortcut', shortcut: 'Esc' });

  assert.equal(monitor.dispatch({ type: 'destruct-approved' }).state, 'closing-injection');
  assert.equal(monitor.dispatch({ type: 'injection-closed' }).state, 'cleaning');
  assert.equal(monitor.dispatch({ type: 'cleanup-finished' }).state, 'finished');
  assert.equal(monitor.dispatch({ type: 'process-exited', pid: 31 }).accepted, false);
  assert.deepEqual(transitions, [
    'watching-client',
    'destruct-requested',
    'closing-injection',
    'cleaning',
    'finished'
  ]);
});

test('快照不可篡改，且后续启动事件不能替换已登记客户端 PID', () => {
  const monitor = createSelfDestructMonitor({});
  startOwnedClient(monitor, 88);
  const initial = monitor.getSnapshot();

  assert.equal(Object.isFrozen(initial), true);
  assert.throws(() => { initial.clientPid = 99; }, TypeError);
  assert.equal(monitor.dispatch({ type: 'client-started', pid: 99, owned: true }).accepted, false);
  assert.equal(monitor.getSnapshot().clientPid, 88);
});

test('状态观察回调异常不会中断状态转换', () => {
  const monitor = createSelfDestructMonitor({
    selfDestructKeys: ['F8'],
    onTransition() { throw new Error('observer failed'); }
  });

  assert.doesNotThrow(() => monitor.dispatch({ type: 'client-started', pid: 89, owned: true }));
  assert.doesNotThrow(() => monitor.dispatch({ type: 'shortcut', shortcut: 'F8' }));
  assert.equal(monitor.getSnapshot().state, 'destruct-requested');
});
