import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import {
  canBindPort,
  chooseBindablePort,
  describeMachine,
  parsePeMachine,
  sanitizeUrl
} from '../windows/host/launch.mjs';
import {
  createConfigStore,
  isSharedStoreKey,
  normalizeConfig,
  pickSharedValues
} from '../windows/host/config.mjs';
import { fetchJson, CdpConnection } from '../windows/host/cdp.mjs';
import { isBlankishUrl } from '../windows/host/inject.mjs';
import { evaluateDpiDiagnosis, evaluatePageDiagnosis } from '../windows/host/diagnostics.mjs';

const root = process.cwd();
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeServerFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x81;
  return Buffer.concat([header, payload]);
}

function consumeClientFrames(socketState, chunk, onMessage) {
  socketState.buffer = Buffer.concat([socketState.buffer, chunk]);
  let offset = 0;
  for (;;) {
    const buffer = socketState.buffer;
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const maskOffset = offset + headerLength;
    const dataOffset = maskOffset + (masked ? 4 : 0);
    if (buffer.length < dataOffset + length) break;
    const payload = Buffer.from(buffer.subarray(dataOffset, dataOffset + length));
    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= buffer[maskOffset + (index % 4)];
      }
    }
    offset = dataOffset + length;
    if (opcode === 1) onMessage(payload.toString('utf8'));
    if (opcode === 8) {
      try { socketState.socket.end(); } catch { /* ignore */ }
    }
  }
  socketState.buffer = socketState.buffer.subarray(offset);
}

async function startMockCdp() {
  const captured = { evaluates: [], trampolineSource: null, methodLog: [] };
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const port = server.address().port;
    if (request.url === '/json/version') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        Browser: 'Chrome/75.0.3770.100',
        'Protocol-Version': '1.3',
        'User-Agent': 'mock-cef-75',
        'WebKit-Version': '75.0'
      }));
      return;
    }
    if (request.url === '/json/list') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify([{
        id: 'page-1',
        type: 'page',
        title: 'mock page',
        url: 'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist?secret=1',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1`
      }]));
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  server.on('upgrade', (request, socket) => {
    if (!String(request.url || '').startsWith('/devtools/page/')) {
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const socketState = { buffer: Buffer.alloc(0), socket };
    sockets.add(socket);

    const sendJson = (payload) => {
      try { socket.write(encodeServerFrame(JSON.stringify(payload))); } catch { /* ignore */ }
    };

    const sendContextCreated = () => {
      sendJson({
        method: 'Runtime.executionContextCreated',
        params: {
          context: {
            id: 1,
            origin: 'https://mooc1.chaoxing.com',
            name: '',
            auxData: { isDefault: true, type: 'default', frameId: 'frame-1' }
          }
        }
      });
    };

    const createSandbox = () => {
      const windowObject = {};
      windowObject.window = windowObject;
      windowObject.location = {
        href: 'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist',
        origin: 'https://mooc1.chaoxing.com',
        pathname: '/exam-ans/exam/test/examcode/examlist'
      };
      windowObject.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
      const consoleObject = {
        log: (...args) => {
          sendJson({
            method: 'Runtime.consoleAPICalled',
            params: {
              type: 'log',
              executionContextId: 1,
              args: [{ type: 'string', value: String(args[0]) }]
            }
          });
        },
        warn: () => {},
        error: () => {}
      };
      return {
        window: windowObject,
        document: { title: '', documentElement: { setAttribute: () => {}, getAttribute: () => null }, head: null, body: null },
        console: consoleObject,
        CustomEvent: class MockCustomEvent { constructor(type, init) { this.type = type; this.detail = init ? init.detail : undefined; } }
      };
    };

    socket.on('data', (chunk) => {
      consumeClientFrames(socketState, chunk, (text) => {
        let message;
        try { message = JSON.parse(text); } catch { return; }
        if (!message || message.id === undefined) return;
        captured.methodLog.push(message.method);
        switch (message.method) {
          case 'Runtime.enable':
            sendJson({ id: message.id, result: {} });
            sendContextCreated();
            return;
          case 'Page.enable':
            sendJson({ id: message.id, result: {} });
            return;
          case 'Page.addScriptToEvaluateOnNewDocument':
            captured.trampolineSource = message.params && message.params.source ? message.params.source : '';
            sendJson({ id: message.id, result: { identifier: 'script-1' } });
            return;
          case 'Page.getFrameTree':
            sendJson({
              id: message.id,
              result: {
                frameTree: {
                  frame: {
                    id: 'frame-1',
                    loaderId: 'loader-1',
                    url: 'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist',
                    securityOrigin: 'https://mooc1.chaoxing.com',
                    mimeType: 'text/html'
                  }
                }
              }
            });
            return;
          case 'Page.removeScriptToEvaluateOnNewDocument':
            sendJson({ id: message.id, result: {} });
            return;
          case 'Runtime.evaluate': {
            captured.evaluates.push(String(message.params && message.params.expression ? message.params.expression : ''));
            try {
              vm.runInNewContext(captured.evaluates[captured.evaluates.length - 1], createSandbox(), { timeout: 2000 });
              sendJson({ id: message.id, result: { result: { type: 'undefined' } } });
            } catch (error) {
              sendJson({
                id: message.id,
                result: {
                  result: { type: 'object', subtype: 'error' },
                  exceptionDetails: { text: String(error && error.message || error) }
                }
              });
            }
            return;
          }
          default:
            sendJson({ id: message.id, result: {} });
        }
      });
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    captured,
    async close() {
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function runCommand(command, args, { cwd = root, env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时：${command} ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function writeFixtureAssets(directory, { bootstrap, bundle }) {
  await fs.mkdir(path.join(directory, 'vendor'), { recursive: true });
  await fs.writeFile(path.join(directory, 'windows-bootstrap.js'), bootstrap, 'utf8');
  await fs.writeFile(path.join(directory, 'chaoxing-plus.windows.js'), bundle, 'utf8');
  await fs.copyFile(path.resolve(root, 'windows', 'host', 'trampoline.js'), path.join(directory, 'trampoline.js'));
  await fs.writeFile(path.join(directory, 'vendor', 'sweetalert2.min.css'), '/*mock*/', 'utf8');
}

test('config 只持久化共享键并保留默认结构', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-config-'));
  const filePath = path.join(directory, 'config.json');
  const store = createConfigStore(filePath);
  await store.load();
  assert.equal(store.isEnabled(), true);
  assert.equal(store.updateFromPage({ 'common.settings.a': 1, 'other.key': 'x' }), true);
  assert.equal(store.updateFromPage({ 'common.settings.a': 1 }), false);
  assert.equal(store.config.settings['common.settings.a'], 1);
  assert.equal(store.config.settings['other.key'], undefined);
  await store.flush();
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(persisted.settings['common.settings.a'], 1);
  assert.equal(persisted.settings['other.key'], undefined);
  await fs.rm(directory, { recursive: true, force: true });
});

test('config 工具函数覆盖共享键过滤与归一化', () => {
  assert.equal(isSharedStoreKey('common.settings.x'), true);
  assert.equal(isSharedStoreKey('common.apps.question-caches'), true);
  assert.equal(isSharedStoreKey('common.work-results.results'), false);
  assert.equal(isSharedStoreKey('random.key'), false);
  assert.deepEqual(pickSharedValues({ 'cx.new.study.a': 1, nope: 2 }), { 'cx.new.study.a': 1 });
  const normalized = normalizeConfig({ port: 70000, clientPath: '  C:/x.exe  ', settings: { 'common.settings.a': true } });
  assert.equal(normalized.port, 65535);
  assert.equal(normalized.clientPath, 'C:/x.exe');
  assert.equal(normalized.settings['common.settings.a'], true);
  assert.equal(normalized.injectBlankFrames, true);
  assert.equal(normalized.dpiAwareness, '');
  assert.equal(normalizeConfig({ dpiAwareness: 'system' }).dpiAwareness, 'system');
  assert.equal(normalizeConfig({ dpiAwareness: 'invalid' }).dpiAwareness, '');
});

test('launch 工具函数：PE 解析、URL 脱敏、端口选择', async () => {
  const buffer = Buffer.alloc(4096);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(0x014c, 0x84);
  assert.equal(parsePeMachine(buffer), 0x014c);
  assert.equal(describeMachine(0x014c), 'x86');
  assert.equal(parsePeMachine(Buffer.from('not a pe')), null);

  assert.equal(
    sanitizeUrl('https://mooc1.chaoxing.com/exam-ans/x?secret=1#frag'),
    'https://mooc1.chaoxing.com/exam-ans/x'
  );

  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  const busyPort = busy.address().port;
  assert.equal((await canBindPort(busyPort)).ok, false);
  const chosen = await chooseBindablePort([busyPort, 0]);
  assert.equal(chosen.port, 0);
  await new Promise((resolve) => busy.close(resolve));
});

test('CDP 客户端可以连接 mock 端点并收到执行上下文事件', async () => {
  const mock = await startMockCdp();
  try {
    const version = await fetchJson(mock.port, '/json/version');
    assert.equal(version.Browser, 'Chrome/75.0.3770.100');
    const list = await fetchJson(mock.port, '/json/list');
    assert.equal(list[0].webSocketDebuggerUrl.includes('/devtools/page/page-1'), true);
    const connection = await CdpConnection.open(list[0].webSocketDebuggerUrl);
    const events = [];
    connection.onEvent((message) => events.push(message));
    await connection.send('Runtime.enable');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(events.some((message) => message.method === 'Runtime.executionContextCreated'), true);
    connection.close();
  } finally {
    await mock.close();
  }
});

test('空白 frame URL 判定覆盖 CEF75 的 origin 形式（含 about:blank iframe）', () => {
  for (const blank of [':', '://', 'null', 'nullblank', 'blank', '', 'about:blank', 'about:srcdoc', 'data:text/html,x']) {
    assert.equal(isBlankishUrl(blank), true, `${blank} 应视为空白 frame`);
  }
  assert.equal(isBlankishUrl('https://mooc1.chaoxing.com/exam-ans/exam/test'), false);
  assert.equal(isBlankishUrl('http://zsc.kaoshi.chaoxing.com/cflogin/kskhdlogin'), false);
});

test('DPI 诊断能识别系统位图缩放（窗口 DPI ≠ 系统 DPI）', () => {
  const mismatch = evaluateDpiDiagnosis({
    systemDpi: 120,
    appliedDpi: 120,
    windows: [{ processId: 100, windowDpi: 96, className: 'Chrome_WidgetWin_0' }]
  });
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(mismatch.scale, 1.25);
  assert.equal(mismatch.systemDpi, 120);
  assert.equal(mismatch.windowDpi, 96);
  assert.match(mismatch.suggestion, /dpi-aware/);

  const match = evaluateDpiDiagnosis({
    systemDpi: 120,
    windows: [{ processId: 100, windowDpi: 120 }]
  });
  assert.equal(match.status, 'match');

  // 过滤掉 Chrome/客户端进程里的辅助小窗口（283x40、144 DPI），不能误报 mismatch。
  const withHelperWindow = evaluateDpiDiagnosis({
    systemDpi: 120,
    windows: [
      { processId: 1, windowDpi: 144, visible: true, rect: { width: 283, height: 40 } },
      { processId: 2, windowDpi: 120, visible: true, rect: { width: 1920, height: 1200 } }
    ]
  });
  assert.equal(withHelperWindow.status, 'match');
  assert.equal(withHelperWindow.windowDpi, 120);

  assert.equal(evaluateDpiDiagnosis(null).status, 'unknown');
  assert.equal(evaluateDpiDiagnosis({ error: 'no powershell' }).status, 'unknown');
});

test('页面渲染诊断能发现亚像素定位与 backdrop 模糊残留', () => {
  const suspect = evaluatePageDiagnosis({
    devicePixelRatio: 1,
    screen: { width: 1920, height: 1200 },
    topPanel: {
      rect: { x: 10.5, y: 16 },
      devicePixels: { x: 10.5, y: 16, fractional: true },
      style: { backdropFilter: 'blur(14px)', transform: 'none' }
    }
  });
  assert.equal(suspect.status, 'suspect');
  assert.deepEqual(suspect.findings.map((finding) => finding.code).sort(), ['BACKDROP_BLUR_ACTIVE', 'PAGE_DPR_1', 'SUBPIXEL_POSITION']);

  const clean = evaluatePageDiagnosis({
    devicePixelRatio: 1.25,
    topPanel: {
      rect: { x: 760, y: 16 },
      devicePixels: { x: 950, y: 20, fractional: false },
      style: { backdropFilter: 'none', transform: 'none' }
    }
  });
  assert.equal(clean.status, 'clean');
});

test('宿主 attach 模式可完成 bootstrap -> bundle -> 配置回写', async () => {
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-host-'));
  const assetsDir = path.join(directory, 'assets');
  const configPath = path.join(directory, 'config.json');
  const reportPath = path.join(directory, 'report.json');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({kind:'ready',detail:{}}));",
    bundle: "console.log('__CX_WIN_MSG__'+JSON.stringify({kind:'config-sync',detail:{'common.settings.fromPage':42}}));"
  });
  await fs.writeFile(configPath, JSON.stringify({
    clientPath: '',
    port: 0,
    settings: { 'common.settings.extension-enabled': true }
  }), 'utf8');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'host', 'main.mjs'),
      '--attach', String(mock.port),
      '--assets', assetsDir,
      '--config', configPath,
      '--duration', '3000',
      '--report', reportPath,
      '--quiet',
      '--no-elevate'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' } });
    assert.equal(result.code, 0, `宿主退出码 ${result.code}\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.mode, 'attach');
    assert.equal(report.endpoint.browser, 'Chrome/75.0.3770.100');
    assert.equal(report.totals.bootstraps >= 1, true);
    assert.equal(report.totals.bundles >= 1, true);
    assert.equal(report.totals.configSyncs >= 1, true);
    assert.equal(mock.captured.methodLog.includes('Page.addScriptToEvaluateOnNewDocument'), true);
    assert.equal(String(mock.captured.trampolineSource).includes('__CX_WIN_MSG__'), true);
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(persisted.settings['common.settings.fromPage'], 42);
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('宿主 --diagnose 会采集渲染诊断并写入诊断文件', async () => {
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-diagnostics-'));
  const assetsDir = path.join(directory, 'assets');
  const configPath = path.join(directory, 'config.json');
  const reportPath = path.join(directory, 'report.json');
  const diagnosticsDir = path.join(directory, 'diagnostics');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({kind:'ready',detail:{}}));",
    bundle: "console.log('__CX_WIN_MSG__'+JSON.stringify({kind:'ready',detail:{}}));"
  });
  await fs.writeFile(configPath, JSON.stringify({
    clientPath: '',
    port: 0,
    settings: { 'common.settings.extension-enabled': true }
  }), 'utf8');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'host', 'main.mjs'),
      '--attach', String(mock.port),
      '--assets', assetsDir,
      '--config', configPath,
      '--duration', '8000',
      '--report', reportPath,
      '--diagnose',
      '--diagnostics-dir', diagnosticsDir,
      '--quiet',
      '--no-elevate'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' }, timeoutMs: 60000 });
    assert.equal(result.code, 0, `宿主退出码 ${result.code}\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.diagnostics.enabled, true);
    assert.equal(report.diagnostics.samples.length >= 1, true);
    const diagnosticsFile = path.join(diagnosticsDir, 'render-diagnostics.json');
    const diagnostics = JSON.parse(await fs.readFile(diagnosticsFile, 'utf8'));
    assert.equal(diagnostics.enabled, true);
    assert.equal(diagnostics.samples.length >= 1, true);
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('宿主 --self-check 在缺少 clientPath 时仍能通过核心检查', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-selfcheck-'));
  const assetsDir = path.join(directory, 'assets');
  await writeFixtureAssets(assetsDir, {
    bootstrap: 'window.__CX_WIN_HOST__={};',
    bundle: 'window.__CX_WIN_BUNDLE_LOADED__=true;'
  });
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ clientPath: '', port: 0 }), 'utf8');
  const reportPath = path.join(directory, 'self-check.json');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'host', 'main.mjs'),
      '--self-check',
      '--assets', assetsDir,
      '--config', configPath,
      '--report', reportPath,
      '--quiet'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' } });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.mode, 'self-check');
    assert.equal(report.failures.length, 0);
    assert.equal(report.checks.some((check) => check.name.includes('WebSocket') && check.ok), true);
    assert.equal(report.checks.some((check) => check.name.includes('调试端口') && check.ok), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
