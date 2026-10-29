import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { CdpConnection } from '../windows/node-source/cdp.mjs';

async function within(promise, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CDP operation did not settle promptly')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function openFixture(t) {
  const sockets = new Set();
  const server = http.createServer();
  let peer;
  server.on('upgrade', (request, socket) => {
    peer = socket;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const accept = crypto.createHash('sha1')
      .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let connection;
  t.after(async () => {
    connection?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  connection = await CdpConnection.open(`ws://127.0.0.1:${server.address().port}/devtools/page/fixture`);
  return { connection, peer };
}

test('CDP rejects immediately when a peer Close frame leaves WebSocket closing', async (t) => {
  const { connection, peer } = await openFixture(t);
  const events = [];
  connection.onEvent((message, disconnected) => events.push({ message, disconnected }));
  const pending = connection.send('Runtime.enable', {}, { timeoutMs: 5000 }).catch((error) => error);
  peer.write(Buffer.from([0x88, 0]));
  const deadline = Date.now() + 1000;
  while (connection.socket.readyState !== WebSocket.CLOSING && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(connection.socket.readyState, WebSocket.CLOSING);

  await assert.rejects(within(connection.send('Runtime.evaluate', {}, { timeoutMs: 5000 })), /CDP 连接已关闭/);
  assert.match((await within(pending)).message, /CDP 连接已关闭/);
  assert.equal(connection.closed, true);
  assert.equal(connection.pending.size, 0);
  assert.equal(connection.nextId, 2);
  assert.deepEqual(events, [{ message: { method: 'cx.disconnected', params: {} }, disconnected: true }]);

  connection.socket.dispatchEvent(new Event('close'));
  connection.close();
  assert.equal(events.length, 1);
});

test('CDP remote close clears every pending request and notifies once', async (t) => {
  const { connection, peer } = await openFixture(t);
  const events = [];
  connection.onEvent(() => { throw new Error('fixture listener failure'); });
  connection.onEvent((message) => {
    events.push(message.method);
    connection.close();
  });
  const pending = ['Page.enable', 'Runtime.enable'].map((method) => (
    connection.send(method, {}, { timeoutMs: 5000 }).catch((error) => error)
  ));
  peer.destroy();
  const errors = await within(Promise.all(pending));
  for (const error of errors) assert.match(error.message, /CDP 连接已关闭/);
  assert.equal(connection.closed, true);
  assert.equal(connection.pending.size, 0);
  assert.equal(connection.listeners.size, 0);
  assert.deepEqual(events, ['cx.disconnected']);

  connection.socket.dispatchEvent(new Event('close'));
  connection.close();
  assert.deepEqual(events, ['cx.disconnected']);
});

test('CDP explicit close rejects pending requests without a disconnect notification', async (t) => {
  const { connection } = await openFixture(t);
  const events = [];
  connection.onEvent((message) => events.push(message.method));
  const pending = connection.send('Page.enable', {}, { timeoutMs: 5000 }).catch((error) => error);
  connection.close();
  connection.close();
  assert.match((await within(pending)).message, /CDP 连接已关闭/);
  assert.equal(connection.pending.size, 0);
  assert.equal(connection.listeners.size, 0);
  connection.socket.dispatchEvent(new Event('close'));
  await assert.rejects(connection.send('Runtime.enable'), /CDP 连接已关闭/);
  assert.deepEqual(events, []);
});
