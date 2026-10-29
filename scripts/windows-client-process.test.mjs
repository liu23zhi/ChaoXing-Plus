import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { observeClientProcess } from '../windows/node-source/client-process.mjs';

test('只观察本次宿主持有的 ChildProcess 退出事件', () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const events = [];
  const detach = observeClientProcess(child, {
    onExit: (event) => events.push(['exit', event]),
    onError: (error) => events.push(['error', error.message])
  });

  child.emit('exit', 17, 'SIGTERM');
  child.emit('exit', 18, null);
  assert.deepEqual(events, [['exit', { code: 17, signal: 'SIGTERM' }]]);
  detach();
});

test('客户端启动错误只通知一次并阻止后续退出重复触发', () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const events = [];
  observeClientProcess(child, {
    onExit: (event) => events.push(['exit', event]),
    onError: (error) => events.push(['error', error.message])
  });

  child.emit('error', new Error('spawn failed'));
  child.emit('exit', 1, null);
  assert.deepEqual(events, [['error', 'spawn failed']]);
});

test('取消观察后不再回调，已结束的子进程通过微任务补发退出事件', async () => {
  const child = new EventEmitter();
  child.exitCode = 0;
  child.signalCode = null;
  const events = [];
  observeClientProcess(child, {
    onExit: (event) => events.push(event)
  });
  await Promise.resolve();
  assert.deepEqual(events, [{ code: 0, signal: null }]);

  const second = new EventEmitter();
  second.exitCode = null;
  second.signalCode = null;
  const later = [];
  const detach = observeClientProcess(second, { onExit: () => later.push(true) });
  detach();
  second.emit('exit', 0, null);
  assert.deepEqual(later, []);
});

test('拒绝没有事件接口或观察回调类型错误', () => {
  assert.throws(() => observeClientProcess({}, {}), /once/u);
  const child = new EventEmitter();
  assert.throws(() => observeClientProcess(child, { onExit: null }), /observers/u);
});
