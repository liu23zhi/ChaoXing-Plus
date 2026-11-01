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
  isSupportedClientMachine,
  parsePeMachine,
  sanitizeUrl
} from '../windows/node-source/launch.mjs';
import {
  createConfigStore,
  isSharedStoreKey,
  mergeConfigLayers,
  mergeHostConfigLayers,
  normalizeConfig,
  pickSharedValues
} from '../windows/node-source/config.mjs';
import { fetchJson, CdpConnection } from '../windows/node-source/cdp.mjs';
import { isBlankishUrl, PageSession } from '../windows/node-source/inject.mjs';
import { evaluateDpiDiagnosis, evaluatePageDiagnosis } from '../windows/node-source/diagnostics.mjs';

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

async function startMockCdp({ disconnectOnExpression = '', suppressReadyAfterFirstConnection = false } = {}) {
  const captured = { evaluates: [], trampolineSource: null, methodLog: [], connections: 0 };
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
    captured.connections += 1;
    const connectionIndex = captured.connections;

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
          if (suppressReadyAfterFirstConnection && connectionIndex > 1
            && String(args[0]).includes('"kind":"ready"')) return;
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

    const sandbox = vm.createContext(createSandbox());
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
              vm.runInContext(captured.evaluates[captured.evaluates.length - 1], sandbox, { timeout: 2000 });
              sendJson({ id: message.id, result: { result: { type: 'undefined' } } });
              if (captured.connections === 1 && disconnectOnExpression
                && captured.evaluates.at(-1).includes(disconnectOnExpression)) {
                socket.end(Buffer.from([0x88, 0x00]));
              }
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
  await fs.copyFile(path.resolve(root, 'windows', 'share-file', 'trampoline.js'), path.join(directory, 'trampoline.js'));
  await fs.writeFile(path.join(directory, 'vendor', 'sweetalert2.min.css'), '/*mock*/', 'utf8');
}

test('普通启动流程校验有效 PE 后能到达 spawnClient，不启动真实程序', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-launch-entry-'));
  const assetsDir = path.join(directory, 'assets');
  const clientPath = path.join(directory, 'CXExam.exe');
  const configPath = path.join(directory, 'config.json');
  const sentinel = 'CXPLUS_TEST_SPAWN_CLIENT_REACHED';
  const buffer = Buffer.alloc(4096);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(0x014c, 0x84);
  await fs.writeFile(clientPath, buffer);
  await fs.writeFile(configPath, '{}', 'utf8');
  await writeFixtureAssets(assetsDir, { bootstrap: 'true;', bundle: 'true;' });
  const launchUrl = new URL('../windows/node-source/launch.mjs', import.meta.url).href;
  const mainUrl = new URL('../windows/node-source/main.mjs', import.meta.url).href;
  const args = [
    '--client', clientPath, '--config', configPath, '--assets', assetsDir,
    '--no-disk-write', '--no-log', '--no-diagnose', '--no-elevate'
  ];
  const source = `
    import { mock } from 'node:test';
    const launch = await import(${JSON.stringify(launchUrl)});
    mock.module(${JSON.stringify(launchUrl)}, { namedExports: {
      ...launch,
      isElevated: async () => { throw new Error('ordinary launch must not query elevation before CreateProcess'); },
      listProcessIdsByName: async () => [],
      chooseBindablePort: async () => ({ port: 38100, rejected: [] }),
      spawnClient() { throw new Error(${JSON.stringify(sentinel)}); }
    } });
    process.argv = [process.execPath, ${JSON.stringify(mainUrl)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(mainUrl)});
  `;
  try {
    const result = await runCommand(process.execPath, [
      '--experimental-test-module-mocks', '--input-type=module', '-e', source
    ]);
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, new RegExp(sentinel, 'u'));
    assert.doesNotMatch(result.stderr, /isCxExamExecutablePath is not defined/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Windows 无参数 main 入口先选择 GUI，UAC 接续传递实际选择且不启动客户端', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-default-gui-'));
  const configPath = path.join(directory, 'config.json');
  const selectedClientPath = path.join(directory, 'CXExam.exe');
  await fs.writeFile(configPath, JSON.stringify({ clientPath: selectedClientPath, ui: 'auto', noDiskWrite: true, quiet: true }), 'utf8');
  const launchUrl = new URL('../windows/node-source/launch.mjs', import.meta.url).href;
  const configUrl = new URL('../windows/node-source/config.mjs', import.meta.url).href;
  const selectionUrl = new URL('../windows/node-source/client-selection.mjs', import.meta.url).href;
  const mainUrl = new URL('../windows/node-source/main.mjs', import.meta.url).href;
  const source = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    const config = await import(${JSON.stringify(configUrl)});
    const launch = await import(${JSON.stringify(launchUrl)});
    const selected = ${JSON.stringify(selectedClientPath)};
    mock.module(${JSON.stringify(configUrl)}, { namedExports: { ...config, defaultConfigPath: () => ${JSON.stringify(configPath)} } });
    mock.module(${JSON.stringify(selectionUrl)}, { namedExports: {
      resolveClientSelection: async (options) => {
        assert.equal(options.ui, 'gui');
        assert.equal(options.clientPath, '');
        return selected;
      }
    } });
    mock.module(${JSON.stringify(launchUrl)}, { namedExports: {
      ...launch, isElevated: async () => false,
      readPeMachine: async () => 0x014c,
      listProcessIdsByName: async () => [],
      chooseBindablePort: async () => ({ port: 38100, rejected: [] }),
      relaunchElevated: async (options) => {
        assert.deepEqual(options.args, ['--ui', 'gui', '--scan-mode', 'common']);
        assert.equal(options.selectedClientPath, selected);
        console.log('NO_ARGS_GUI_HANDOFF_CONFIRMED');
      },
      spawnClient() { throw Object.assign(new Error('No client may be started by this test'), { win32Code: 740 }); }
    } });
    process.argv = [process.execPath, ${JSON.stringify(mainUrl)}];
    await import(${JSON.stringify(mainUrl)});
  `;
  try {
    const result = await runCommand(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /NO_ARGS_GUI_HANDOFF_CONFIRMED/u);
    assert.deepEqual(await fs.readdir(directory), ['config.json']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('启动提权在扫描前执行，遵守 quiet、真实 token 和只读模式，并且取消不会循环', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-early-uac-'));
  const configPath = path.join(directory, 'config.json');
  const launchUrl = new URL('../windows/node-source/launch.mjs', import.meta.url).href;
  const configUrl = new URL('../windows/node-source/config.mjs', import.meta.url).href;
  const selectionUrl = new URL('../windows/node-source/client-selection.mjs', import.meta.url).href;
  const mainUrl = new URL('../windows/node-source/main.mjs', import.meta.url).href;
  const cases = [
    { args: ['--elevate-on-start'], config: {}, token: false, expected: 'UAC_REQUESTED', code: 0, selected: false },
    { args: ['--ui', 'gui'], config: { elevateOnStart: true }, token: false, expected: 'UAC_REQUESTED', code: 0, selected: false },
    { args: ['--elevate-on-start'], config: {}, token: true, expected: 'SELECTION_REACHED', code: 0, selected: true },
    { args: ['--elevate-on-start', '--elevated'], config: {}, token: false, expected: 'TOKEN_CHECK', code: 3, selected: false, noUac: true },
    { args: ['--elevate-on-start'], config: {}, token: false, cancel: true, expected: 'UAC_REQUESTED', code: 3, selected: false },
    { args: ['--elevate-on-start', '--list-clients'], config: {}, token: false, expected: 'SELECTION_REACHED', code: 0, selected: true, noUac: true, noTokenCheck: true }
  ];
  try {
    for (const item of cases) {
      await fs.writeFile(configPath, JSON.stringify({ noDiskWrite: true, quiet: true, ...item.config }), 'utf8');
      const source = `
        import { mock } from 'node:test';
        import assert from 'node:assert/strict';
        const config = await import(${JSON.stringify(configUrl)});
        const launch = await import(${JSON.stringify(launchUrl)});
        mock.module(${JSON.stringify(configUrl)}, { namedExports: { ...config, defaultConfigPath: () => ${JSON.stringify(configPath)} } });
        mock.module(${JSON.stringify(selectionUrl)}, { namedExports: {
          resolveClientSelection: async () => { console.log('SELECTION_REACHED'); return null; }
        } });
        mock.module(${JSON.stringify(launchUrl)}, { namedExports: {
          ...launch,
          isElevated: async () => { console.log('TOKEN_CHECK'); return ${JSON.stringify(item.token)}; },
          relaunchElevated: async (options) => {
            assert.equal(options.cwd, process.cwd());
            assert.ok(options.args.includes('--elevate-on-start') || ${JSON.stringify(!!item.config.elevateOnStart)});
            console.log('UAC_REQUESTED');
            if (${JSON.stringify(!!item.cancel)}) throw Object.assign(new Error('cancelled UAC'), { win32Code: 1223 });
          },
          spawnClient() { throw new Error('must not start any client'); }
        } });
        process.argv = [process.execPath, ${JSON.stringify(mainUrl)}, ...${JSON.stringify(item.args)}];
        await import(${JSON.stringify(mainUrl)});
      `;
      const result = await runCommand(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source]);
      assert.equal(result.code, item.code, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(item.expected, 'u'));
      assert.equal(result.stdout.includes('SELECTION_REACHED'), item.selected);
      assert.doesNotMatch(result.stdout + result.stderr, /\[windows-host\]/u, 'JSON quiet applies before early UAC output');
      if (item.noUac) assert.doesNotMatch(result.stdout, /UAC_REQUESTED/u);
      if (item.noTokenCheck) assert.doesNotMatch(result.stdout, /TOKEN_CHECK/u);
    }
    assert.deepEqual(await fs.readdir(directory), ['config.json']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('客户端默认仅 Win32 740 可触发提权，权限禁用及其他错误直接停止', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-demand-uac-'));
  const configPath = path.join(directory, 'config.json');
  const client = path.join(directory, 'CXExam.exe');
  const launchUrl = new URL('../windows/node-source/launch.mjs', import.meta.url).href;
  const configUrl = new URL('../windows/node-source/config.mjs', import.meta.url).href;
  const selectionUrl = new URL('../windows/node-source/client-selection.mjs', import.meta.url).href;
  const mainUrl = new URL('../windows/node-source/main.mjs', import.meta.url).href;
  await fs.writeFile(configPath, JSON.stringify({ noDiskWrite: true, quiet: true }), 'utf8');
  const cases = [
    { win32Code: 5, code: 'EACCES', args: [], token: false, uac: false },
    { win32Code: 0, code: 'UNKNOWN', args: [], token: false, uac: false },
    { win32Code: 740, args: ['--no-elevate'], token: false, uac: false },
    { win32Code: 740, args: ['--elevated'], token: false, uac: false },
    { win32Code: 740, args: [], token: true, uac: false },
    { win32Code: 740, args: [], token: false, uac: true }
  ];
  try {
    for (const item of cases) {
      const source = `
        import { mock } from 'node:test';
        import assert from 'node:assert/strict';
        const config = await import(${JSON.stringify(configUrl)});
        const launch = await import(${JSON.stringify(launchUrl)});
        mock.module(${JSON.stringify(configUrl)}, { namedExports: { ...config, defaultConfigPath: () => ${JSON.stringify(configPath)} } });
        mock.module(${JSON.stringify(selectionUrl)}, { namedExports: { resolveClientSelection: async () => ${JSON.stringify(client)} } });
        mock.module(${JSON.stringify(launchUrl)}, { namedExports: {
          ...launch,
          isElevated: async () => ${JSON.stringify(item.token)},
          readPeMachine: async () => 0x014c,
          listProcessIdsByName: async () => [],
          chooseBindablePort: async () => ({ port: 38100, rejected: [] }),
          relaunchElevated: async (options) => {
            assert.equal(options.selectedClientPath, ${JSON.stringify(client)});
            console.log('UAC_REQUESTED');
          },
          spawnClient() { throw Object.assign(new Error('expected ordinary launch failure'), ${JSON.stringify({ win32Code: item.win32Code, code: item.code })}); }
        } });
        process.argv = [process.execPath, ${JSON.stringify(mainUrl)}, ...${JSON.stringify(['--client-first', ...item.args])}];
        await import(${JSON.stringify(mainUrl)});
      `;
      const result = await runCommand(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source]);
      assert.equal(result.code, item.uac ? 0 : 3, result.stdout + result.stderr);
      assert.equal(result.stdout.includes('UAC_REQUESTED'), item.uac, JSON.stringify(item));
    }
    assert.deepEqual(await fs.readdir(directory), ['config.json']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('help、capabilities、self-check 和 attach 不执行启动提权', { skip: process.platform !== 'win32' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-readonly-uac-'));
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ noDiskWrite: true, quiet: true }), 'utf8');
  const launchUrl = new URL('../windows/node-source/launch.mjs', import.meta.url).href;
  const configUrl = new URL('../windows/node-source/config.mjs', import.meta.url).href;
  const cdpUrl = new URL('../windows/node-source/cdp.mjs', import.meta.url).href;
  const mainUrl = new URL('../windows/node-source/main.mjs', import.meta.url).href;
  try {
    for (const args of [['--help'], ['--capabilities'], ['--self-check', '--no-disk-write'], ['--attach', '9333']]) {
      const source = `
        import { mock } from 'node:test';
        const config = await import(${JSON.stringify(configUrl)});
        const launch = await import(${JSON.stringify(launchUrl)});
        const cdp = await import(${JSON.stringify(cdpUrl)});
        mock.module(${JSON.stringify(configUrl)}, { namedExports: { ...config, defaultConfigPath: () => ${JSON.stringify(configPath)} } });
        mock.module(${JSON.stringify(launchUrl)}, { namedExports: {
          ...launch, isElevated: async () => false,
          relaunchElevated: async () => { console.log('UNEXPECTED_UAC_REQUEST'); throw new Error('must not request UAC'); }
        } });
        mock.module(${JSON.stringify(cdpUrl)}, { namedExports: {
          ...cdp, fetchJson: async () => { console.log('READONLY_ATTACH_REACHED'); throw new Error('expected attach test stop'); }
        } });
        process.argv = [process.execPath, ${JSON.stringify(mainUrl)}, '--elevate-on-start', ...${JSON.stringify(args)}];
        await import(${JSON.stringify(mainUrl)});
      `;
      const result = await runCommand(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source]);
      assert.equal(result.code, args.includes('--attach') ? 3 : 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_UAC_REQUEST/u);
      if (args.includes('--attach')) assert.match(result.stdout, /READONLY_ATTACH_REACHED/u);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

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

test('no-disk-write 配置存储只在内存中更新', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-config-memory-'));
  const filePath = path.join(directory, 'config.json');
  const store = createConfigStore(filePath, { persistEnabled: false });
  await store.load();
  assert.equal(store.updateFromPage({ 'common.settings.a': 1 }), true);
  await store.flush();
  await assert.rejects(() => fs.access(filePath), { code: 'ENOENT' });
  assert.equal(store.config.settings['common.settings.a'], 1);
  await store.close();
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
  assert.equal(normalized.injectStrategy, 'hybrid');
  assert.equal(normalized.injectRetries, 2);
  assert.equal(normalized.debugEndpointTimeoutMs, 30000);
  assert.equal(normalized.targetPollIntervalMs, 1000);
  assert.equal(normalized.bundleTimeoutMs, 120000);
  assert.equal(normalizeConfig({ injectStrategy: 'script', injectRetries: 5, debugEndpointTimeoutMs: 45000, targetPollIntervalMs: 1500, bundleTimeoutMs: 90000 }).injectStrategy, 'script');
  assert.equal(normalized.dpiAwareness, '');
  assert.equal(normalizeConfig({ dpiAwareness: 'system' }).dpiAwareness, 'system');
  assert.equal(normalizeConfig({ dpiAwareness: 'invalid' }).dpiAwareness, '');
});

test('config layers apply later values and keep only shared settings', () => {
  const merged = mergeConfigLayers(
    { clientPath: 'default.exe', settings: { 'common.settings.a': 1, 'other.key': 1 } },
    { clientPath: 'override.exe', settings: { 'common.settings.a': 2, 'other.key': 2 } }
  );
  assert.equal(merged.clientPath, 'override.exe');
  assert.equal(merged.settings['common.settings.a'], 2);
  assert.equal(merged.settings['other.key'], undefined);
});

test('宿主分层配置使用稀疏文件值，避免归一化默认值覆盖低优先级层', () => {
  const merged = mergeHostConfigLayers({
    defaultHostConfig: { clientPath: 'C:/default/CXExam.exe', port: 5000 },
    appConfig: { clientPath: 'D:/app/CXExam.exe' },
    selectedConfig: { settings: { 'common.settings.windows-panel-enabled': false } },
    loadedConfig: normalizeConfig({ clientPath: '' }),
    inlineConfig: {}
  });
  assert.equal(merged.clientPath, 'D:/app/CXExam.exe');
  assert.equal(merged.port, 5000);
  assert.equal(merged.settings['common.settings.windows-panel-enabled'], false);
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

test('客户端架构兼容 x86 Windows 和 x64 Windows 的可运行范围', () => {
  assert.equal(isSupportedClientMachine(0x014c, { platform: 'win32', arch: 'ia32', env: { PROCESSOR_ARCHITECTURE: 'x86' } }), true);
  assert.equal(isSupportedClientMachine(0x8664, { platform: 'win32', arch: 'ia32', env: { PROCESSOR_ARCHITECTURE: 'x86' } }), false);
  assert.equal(isSupportedClientMachine(0x8664, { platform: 'win32', arch: 'ia32', env: { PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' } }), true);
  assert.equal(isSupportedClientMachine(0x8664, { platform: 'win32', arch: 'x64', env: {} }), true);
  assert.equal(isSupportedClientMachine(0xaa64, { platform: 'win32', arch: 'arm64', env: { PROCESSOR_ARCHITECTURE: 'ARM64' } }), false);
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
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: "console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'config-sync',detail:{'common.settings.fromPage':42}}));"
  });
  await fs.writeFile(configPath, JSON.stringify({
    clientPath: '',
    port: 0,
    settings: { 'common.settings.extension-enabled': true }
  }), 'utf8');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
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
    assert.equal(report.host, 'node');
    assert.equal(report.version, '6.3.0');
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

test('Node SEA 单 EXE 脱离构建目录后完成 mock CDP 注入且 no-disk-write 不落盘', {
  skip: process.platform !== 'win32',
  timeout: 120000
}, async () => {
  const { buildNodeExe } = await import('../windows/node-source/package-node-exe.mjs');
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-sea-host-'));
  const assetsDir = path.join(directory, 'assets');
  const buildDir = path.join(directory, 'build');
  const stagingDir = path.join(directory, 'staging');
  const standaloneDir = path.join(directory, 'standalone');
  const executable = path.join(standaloneDir, 'chaoxing_plus_node.exe');
  const configPath = path.join(standaloneDir, 'config.json');
  const dataDirectory = path.join(standaloneDir, 'data');
  const diagnosticsDir = path.join(standaloneDir, 'diagnostics');
  const reportPath = path.join(standaloneDir, 'report.json');
  try {
    const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
    await writeFixtureAssets(assetsDir, {
      bootstrap: "window.__CX_SEA_BOOTSTRAP__=true;window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
      bundle: "window.__CX_SEA_BUNDLE__=true;console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'config-sync',detail:{'common.settings.fromSea':42}}));"
    });
    await fs.writeFile(path.join(assetsDir, 'package-manifest.json'), JSON.stringify({
      version, features: { injectionLog: false }
    }), 'utf8');
    const build = await buildNodeExe({
      version,
      hostDir: path.join(root, 'windows', 'node-source'),
      scriptsDir: path.join(root, 'windows', 'node-scripts'),
      distDir: assetsDir,
      configExample: path.join(root, 'windows', 'share-file', 'config.example.json'),
      icon: path.join(root, 'windows', 'share-file', 'assets', 'app-icon.ico'),
      buildDir,
      out: stagingDir
    });
    await fs.mkdir(standaloneDir);
    await fs.copyFile(build.executable, executable);
    for (const sourceDirectory of [assetsDir, buildDir, stagingDir]) {
      await fs.rm(sourceDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    assert.deepEqual(await fs.readdir(directory), ['standalone']);

    const result = await runCommand(executable, [
      '--attach', String(mock.port),
      '--config', configPath,
      '--data-dir', dataDirectory,
      '--diagnostics-dir', diagnosticsDir,
      '--report', reportPath,
      '--log', '--diagnose', '--no-disk-write',
      '--duration', '2500', '--quiet', '--no-elevate'
    ], { cwd: standaloneDir });
    assert.equal(result.code, 0, `SEA 宿主退出码 ${result.code}\n${result.stdout}\n${result.stderr}`);
    assert.ok(mock.captured.evaluates.some((source) => source.includes('window.__CX_SEA_BOOTSTRAP__=true')));
    assert.ok(mock.captured.evaluates.some((source) => source.includes('window.__CX_SEA_BUNDLE__=true')));
    assert.ok(mock.captured.evaluates.some((source) => source.startsWith('try{window.__CX_WIN_ON_CONFIG__')
      && source.includes('"common.settings.fromSea":42')));
    assert.ok(mock.captured.methodLog.includes('Page.addScriptToEvaluateOnNewDocument'));
    assert.ok(String(mock.captured.trampolineSource).includes('__CX_WIN_MSG__'));
    assert.deepEqual(await fs.readdir(standaloneDir), ['chaoxing_plus_node.exe']);
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('target 仍存在但 CDP 断开时宿主会在轮询中重建会话', async () => {
  const mock = await startMockCdp({ disconnectOnExpression: '__reconnectBundle' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-reconnect-'));
  const assetsDir = path.join(directory, 'assets');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: 'window.__reconnectBundle=true;'
  });
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port), '--assets', assetsDir,
      '--config', path.join(directory, 'config.json'),
      '--target-poll-interval', '250', '--duration', '1800',
      '--no-disk-write', '--quiet'
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(mock.captured.connections >= 2, `实际连接数 ${mock.captured.connections}`);
    assert.ok(mock.captured.evaluates.filter((source) => source.includes('__reconnectBundle')).length >= 2);
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('CDP 重连后保留前一会话已完成的注入统计及成功退出码', async () => {
  const mock = await startMockCdp({ disconnectOnExpression: '__historyBundle', suppressReadyAfterFirstConnection: true });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-reconnect-history-'));
  const assetsDir = path.join(directory, 'assets');
  const reportPath = path.join(directory, 'report.json');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: 'window.__historyBundle=true;'
  });
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port), '--assets', assetsDir,
      '--config', path.join(directory, 'config.json'), '--report', reportPath,
      '--target-poll-interval', '250', '--duration', '1800', '--no-log', '--quiet'
    ]);
    assert.ok(mock.captured.connections >= 2, `实际连接数 ${mock.captured.connections}`);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.totals.bundles, 1);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('宿主 --no-disk-write 禁止配置、日志、诊断和报告输出', async () => {
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-no-disk-write-'));
  const assetsDir = path.join(directory, 'assets');
  const configPath = path.join(directory, 'config.json');
  const dataDirectory = path.join(directory, 'data');
  const diagnosticsDir = path.join(directory, 'diagnostics');
  const reportPath = path.join(directory, 'report.json');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: "console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'config-sync',detail:{'common.settings.fromPage':42}}));"
  });
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port),
      '--assets', assetsDir,
      '--config', configPath,
      '--data-dir', dataDirectory,
      '--diagnostics-dir', diagnosticsDir,
      '--report', reportPath,
      '--log',
      '--diagnose',
      '--no-disk-write',
      '--duration', '2500',
      '--quiet'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' } });
    assert.equal(result.code, 0, `宿主退出码 ${result.code}\n${result.stdout}\n${result.stderr}`);
    for (const outputPath of [configPath, dataDirectory, diagnosticsDir, reportPath]) {
      await assert.rejects(fs.access(outputPath), { code: 'ENOENT' });
    }
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('配置文件 noDiskWrite 在创建 config store 前生效', async () => {
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-config-no-disk-write-'));
  const assetsDir = path.join(directory, 'assets');
  const configPath = path.join(directory, 'config.json');
  const dataDirectory = path.join(directory, 'data');
  const diagnosticsDir = path.join(directory, 'diagnostics');
  const reportPath = path.join(directory, 'report.json');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: "console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'config-sync',detail:{'common.settings.fromPage':42}}));"
  });
  const originalConfig = JSON.stringify({
    noDiskWrite: true,
    clientPath: '',
    port: 0,
    settings: { 'common.settings.extension-enabled': true }
  });
  await fs.writeFile(configPath, originalConfig, 'utf8');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port),
      '--assets', assetsDir,
      '--config', configPath,
      '--data-dir', dataDirectory,
      '--diagnostics-dir', diagnosticsDir,
      '--report', reportPath,
      '--log',
      '--diagnose',
      '--duration', '2500',
      '--quiet'
    ]);
    assert.equal(result.code, 0, `宿主退出码 ${result.code}\n${result.stdout}\n${result.stderr}`);
    assert.equal(await fs.readFile(configPath, 'utf8'), originalConfig);
    for (const outputPath of [dataDirectory, diagnosticsDir, reportPath]) {
      await assert.rejects(fs.access(outputPath), { code: 'ENOENT' });
    }
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('配置层 deleteConfig 在最终合并后仍会删除显式外部配置', async () => {
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-delete-config-layer-'));
  const assetsDir = path.join(directory, 'assets');
  const configPath = path.join(directory, 'config.json');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: "console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));"
  });
  await fs.writeFile(configPath, JSON.stringify({
    deleteConfig: true,
    clientPath: '',
    port: 0,
    settings: { 'common.settings.extension-enabled': true }
  }), 'utf8');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port),
      '--assets', assetsDir,
      '--config', configPath,
      '--duration', '250',
      '--quiet',
      '--no-elevate'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' } });
    assert.equal(result.code, 0, `宿主退出码 ${result.code}\n${result.stdout}\n${result.stderr}`);
    await assert.rejects(fs.access(configPath), { code: 'ENOENT' });
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('启动清理与自毁参数已接入，--help 下不执行清理或落盘', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-advanced-help-'));
  const configPath = path.join(directory, 'config.json');
  const dataDirectory = path.join(directory, 'data');
  const originalConfig = JSON.stringify({ settings: {} });
  await fs.writeFile(configPath, originalConfig, 'utf8');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--wipe-owned-files-on-start', '--wipe-retries', '7',
      '--self-destruct-key', 'Ctrl+Alt+Shift+E', '--no-self-destruct-confirm',
      '--config', configPath, '--data-dir', dataDirectory, '--help'
    ]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--wipe-owned-files-on-start/u);
    assert.equal(await fs.readFile(configPath, 'utf8'), originalConfig);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('不保留本轮数据时保留已有诊断目录及其中用户文件', async () => {
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-retain-existing-diagnostics-'));
  const assetsDir = path.join(directory, 'assets');
  const configPath = path.join(directory, 'config.json');
  const diagnosticsDir = path.join(directory, 'diagnostics');
  const sentinelPath = path.join(diagnosticsDir, 'user-notes.txt');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: "console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));"
  });
  await fs.mkdir(diagnosticsDir);
  await fs.writeFile(sentinelPath, 'keep user data', 'utf8');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port), '--assets', assetsDir, '--config', configPath,
      '--diagnose', '--diagnostics-dir', diagnosticsDir, '--no-retain-data',
      '--no-log', '--duration', '2500', '--quiet'
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fs.readFile(sentinelPath, 'utf8'), 'keep user data');
    await assert.rejects(fs.access(path.join(diagnosticsDir, 'render-diagnostics.json')), { code: 'ENOENT' });
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('显式指定但不存在的 options-json 文件会在启动前报错', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-options-json-'));
  const missingOptionsPath = path.join(directory, 'missing-options.json');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--options-json', `@${missingOptionsPath}`,
      '--quiet'
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--options-json 配置\s+无法读取/u);
    assert.match(result.stderr, /ENOENT/u);
  } finally {
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
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: "console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));"
  });
  await fs.writeFile(configPath, JSON.stringify({
    clientPath: '',
    port: 0,
    settings: { 'common.settings.extension-enabled': true }
  }), 'utf8');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port),
      '--assets', assetsDir,
      '--config', configPath,
      '--duration', '15000',
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
  const dataDir = path.join(directory, 'data');
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--self-check',
      '--assets', assetsDir,
      '--config', configPath,
      '--data-dir', dataDir,
      '--report', reportPath,
      '--quiet'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' } });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.mode, 'self-check');
    assert.equal(report.version, '6.3.0');
    assert.equal(report.host, 'node');
    assert.equal(report.failures.length, 0);
    assert.equal(report.capabilities.unsupported.implemented, false);
    assert.deepEqual(report.capabilities.unsupported.executionModes.supported, ['normal', 'memory', 'delete-suspend']);
    assert.equal(report.checks.some((check) => check.name.includes('原生客户端选择窗口') && check.ok), true);
    assert.equal(report.checks.some((check) => check.name.includes('WebSocket') && check.ok), true);
    assert.equal(report.checks.some((check) => check.name.includes('调试端口') && check.ok), true);
    assert.equal(await fs.access(dataDir).then(() => true, () => false), false,
      '自检默认必须保持只读，不创建数据目录或隐式日志');
    const explicitLogDir = path.join(directory, 'explicit-log-data');
    const logResult = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--self-check',
      '--assets', assetsDir,
      '--config', configPath,
      '--data-dir', explicitLogDir,
      '--log',
      '--quiet'
    ], { env: { CXPLUS_NO_LOG_FILE: '0' } });
    assert.equal(logResult.code, 0, logResult.stderr);
    const explicitLogs = await fs.readdir(path.join(explicitLogDir, 'logs')).catch(() => []);
    assert.equal(explicitLogs.some((name) => name.endsWith('.log')), true,
      '显式 --log 时自检仍应写出日志');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('宿主配置热更新保留 CLI 和内联覆盖，同时广播可变磁盘设置', async () => {
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-reload-main-'));
  const assetsDir = path.join(directory, 'assets');
  const configPath = path.join(directory, 'config.json');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: 'window.__reloadBundle=true;'
  });
  await fs.writeFile(configPath, JSON.stringify({ settings: { 'common.settings.mutable': 'old' } }), 'utf8');
  let resultPromise;
  try {
    resultPromise = runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port), '--assets', assetsDir, '--config', configPath,
      '--duration', '4000', '--no-disk-write', '--no-panel', '--answer-mode', 'manual',
      '--options-json', JSON.stringify({ settings: { 'common.settings.inline-only': 'inline' } }),
      '--quiet', '--no-elevate'
    ]);
    const deadline = Date.now() + 8000;
    while (!mock.captured.evaluates.some((expression) => expression.includes('__reloadBundle'))) {
      assert.ok(Date.now() < deadline, 'host did not inject the initial bundle');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Wait until main has registered watchFile after its first target poll.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.writeFile(configPath, JSON.stringify({
      settings: {
        'common.settings.windows-panel-enabled': true,
        'common.settings.windows-answer-mode': 'auto',
        'common.settings.windows-no-disk-write': false,
        'common.settings.inline-only': 'disk',
        'common.settings.mutable': 'new'
      }
    }), 'utf8');
    const result = await resultPromise;
    assert.equal(result.code, 0, result.stderr);
    const broadcasts = mock.captured.evaluates.filter((expression) => expression.startsWith('try{window.__CX_WIN_ON_CONFIG__'));
    const last = broadcasts.at(-1);
    assert.ok(last, 'host did not broadcast the config update');
    const settings = JSON.parse(last.split('__CX_WIN_ON_CONFIG__(')[1].split(');')[0]).values;
    assert.equal(settings['common.settings.mutable'], 'new');
    assert.equal(settings['common.settings.inline-only'], 'inline');
    assert.equal(settings['common.settings.windows-panel-enabled'], false);
    assert.equal(settings['common.settings.windows-answer-mode'], 'manual');
    assert.equal(settings['common.settings.windows-no-disk-write'], true);
  } finally {
    if (resultPromise) await resultPromise;
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

for (const startupNoDiskWrite of [true, false]) {
  test(`配置热更新不能改变本次启动的 noDiskWrite=${startupNoDiskWrite} 策略`, async () => {
    const mock = await startMockCdp();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-reload-policy-'));
    const assetsDir = path.join(directory, 'assets');
    const configPath = path.join(directory, 'config.json');
    const reportPath = path.join(directory, 'report.json');
    await writeFixtureAssets(assetsDir, {
      bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
      bundle: 'window.__policyBundle=true;'
    });
    await fs.writeFile(configPath, JSON.stringify({
      noDiskWrite: startupNoDiskWrite,
      settings: { 'common.settings.mutable': 'old' }
    }), 'utf8');
    let resultPromise;
    try {
      resultPromise = runCommand(process.execPath, [
        path.resolve(root, 'windows', 'node-source', 'main.mjs'),
        '--attach', String(mock.port), '--assets', assetsDir, '--config', configPath,
        '--duration', '4000', '--no-log', '--no-diagnose', '--report', reportPath, '--no-elevate'
      ]);
      const deadline = Date.now() + 8000;
      while (!mock.captured.evaluates.some((expression) => expression.includes('__policyBundle'))) {
        assert.ok(Date.now() < deadline, 'host did not inject the initial bundle');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      await fs.writeFile(configPath, JSON.stringify({
        noDiskWrite: !startupNoDiskWrite,
        settings: {
          'common.settings.windows-no-disk-write': !startupNoDiskWrite,
          'common.settings.windows-log-enabled': true,
          'common.settings.mutable': 'new'
        }
      }), 'utf8');
      const result = await resultPromise;
      assert.equal(result.code, 0, result.stderr);
      const broadcasts = mock.captured.evaluates.filter((expression) => expression.startsWith('try{window.__CX_WIN_ON_CONFIG__'));
      assert.ok(broadcasts.length > 0, 'host did not broadcast the config update');
      const last = broadcasts.at(-1);
      const settings = JSON.parse(last.split('__CX_WIN_ON_CONFIG__(')[1].split(');')[0]).values;
      assert.equal(settings['common.settings.mutable'], 'new');
      assert.equal(settings['common.settings.windows-no-disk-write'], startupNoDiskWrite);
      assert.equal(settings['common.settings.windows-log-enabled'], false);
      assert.match(result.stdout + result.stderr, /noDiskWrite.*重启/u);
      if (startupNoDiskWrite) {
        await assert.rejects(fs.access(reportPath), { code: 'ENOENT' });
      } else {
        const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
        assert.equal(report.mode, 'attach');
    assert.equal(report.host, 'node');
    assert.equal(report.version, '6.3.0');
      }
    } finally {
      if (resultPromise) await resultPromise;
      await mock.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

test('宿主配置热更新拒绝未实现参数并保留上一有效配置', async () => {
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-reload-unsupported-'));
  const assetsDir = path.join(directory, 'assets');
  const configPath = path.join(directory, 'config.json');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: 'window.__unsupportedReloadBundle=true;'
  });
  await fs.writeFile(configPath, JSON.stringify({ noDiskWrite: true, settings: { 'common.settings.mutable': 'old' } }), 'utf8');
  let resultPromise;
  try {
    resultPromise = runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port), '--assets', assetsDir, '--config', configPath,
      '--duration', '4000', '--no-elevate'
    ]);
    const deadline = Date.now() + 8000;
    while (!mock.captured.evaluates.some((expression) => expression.includes('__unsupportedReloadBundle'))) {
      assert.ok(Date.now() < deadline, 'host did not inject the initial bundle');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.writeFile(configPath, JSON.stringify({
      executionMode: 'memory',
      settings: { 'common.settings.mutable': 'rejected' }
    }), 'utf8');
    const result = await resultPromise;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /热更新配置.*executionMode.*启动策略/u);
    assert.equal(mock.captured.evaluates.some((expression) => expression.startsWith('try{window.__CX_WIN_ON_CONFIG__') && expression.includes('rejected')), false);
  } finally {
    if (resultPromise) await resultPromise;
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('页面回写受 CLI 和内联约束时仍广播校正值给发起页面', async () => {
  const mock = await startMockCdp();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-page-policy-'));
  const assetsDir = path.join(directory, 'assets');
  await writeFixtureAssets(assetsDir, {
    bootstrap: "window.__CX_WIN_HOST__={};console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready',detail:{}}));",
    bundle: "console.log('__CX_WIN_MSG__'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'config-sync',detail:{'common.settings.windows-panel-enabled':true,'common.settings.windows-answer-mode':'auto','common.settings.windows-no-disk-write':false,'common.settings.inline-only':'page'}}));"
  });
  try {
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--attach', String(mock.port), '--assets', assetsDir, '--config', path.join(directory, 'config.json'),
      '--no-disk-write', '--no-panel', '--answer-mode', 'manual',
      '--options-json', JSON.stringify({ settings: { 'common.settings.inline-only': 'inline' } }),
      '--duration', '1800', '--quiet', '--no-elevate'
    ]);
    assert.equal(result.code, 0, result.stderr);
    const broadcasts = mock.captured.evaluates.filter((expression) => expression.startsWith('try{window.__CX_WIN_ON_CONFIG__'));
    assert.ok(broadcasts.length > 0, 'host did not correct the rejected page write');
    const settings = JSON.parse(broadcasts.at(-1).split('__CX_WIN_ON_CONFIG__(')[1].split(');')[0]).values;
    assert.equal(settings['common.settings.windows-panel-enabled'], false);
    assert.equal(settings['common.settings.windows-answer-mode'], 'manual');
    assert.equal(settings['common.settings.windows-no-disk-write'], true);
    assert.equal(settings['common.settings.inline-only'], 'inline');
  } finally {
    await mock.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('PageSession 支持 runtime、script 与 hybrid 注入策略', async () => {
  const logs = [];
  const createSession = (injectStrategy) => new PageSession({
    port: 9333,
    target: { id: `target-${injectStrategy}`, url: 'https://mooc1.chaoxing.com/exam-ans/' },
    assets: { bootstrap: '', bundle: '', trampoline: '', style: '' },
    configStore: { isEnabled: () => true, settingsSnapshot: () => ({}) },
    instanceToken: 'test',
    injectBlankFrames: true,
    captureConsole: true,
    injectStrategy,
    injectRetries: 0,
    logger: { info: (message) => logs.push(`info:${message}`), warn: (message) => logs.push(`warn:${message}`) }
  });

  const runtime = createSession('runtime');
  let runtimeCalls = 0;
  runtime.evaluateOrThrow = async () => { runtimeCalls += 1; return {}; };
  await runtime.injectSource(1, 'window.__runtime=1;', 'runtime');
  assert.equal(runtimeCalls, 1);

  const script = createSession('script');
  let expression = '';
  script.evaluateReturnByValue = async (_contextId, value) => {
    expression = value;
    return { value: { ok: true }, exception: null };
  };
  await script.injectViaScriptElement(1, 'window.__script=1;', 'script');
  assert.match(expression, /createElement\('script'\)/u);
  assert.match(expression, /__CX_WIN_SCRIPT_INJECT_OK__/u);
  assert.match(expression, /脚本元素加载失败/u);
  assert.match(expression, /window\[marker\]/u);

  const hybrid = createSession('hybrid');
  let hybridRuntimeCalls = 0;
  hybrid.evaluateOrThrow = async () => {
    hybridRuntimeCalls += 1;
    throw new Error('runtime unavailable');
  };
  hybrid.evaluateReturnByValue = async () => ({ value: { ok: true }, exception: null });
  await hybrid.injectSource(1, 'window.__hybrid=1;', 'hybrid');
  assert.equal(hybridRuntimeCalls, 1);
  assert.equal(logs.some((line) => line.includes('尝试下一路径')), true);
});
test('Node --capabilities 如实列出已支持的数据、诊断与配置能力', async () => {
  const result = await runCommand(process.execPath, [
    path.resolve(root, 'windows', 'node-source', 'main.mjs'),
    '--capabilities'
  ], { env: { CXPLUS_NO_LOG_FILE: '1' } });
  assert.equal(result.code, 0, result.stderr);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.hostVersion, '6.3.0');
  assert.equal(capabilities.executionMode, 'normal');
  assert.deepEqual(capabilities.supported.executionModes, ['normal', 'memory', 'delete-suspend']);
  for (const key of [
    'scanner',
    'parameterGenerator',
    'configReload',
    'configPersistence',
    'fileLogging',
    'runReport',
    'pageRenderDiagnostics',
    'pageScreenshots',
    'windowDiagnostics',
    'renderDiagnostics',
    'retainData',
    'deleteConfig'
  ]) {
    assert.equal(capabilities.supported[key], true, `capability must be advertised truthfully: ${key}`);
  }
  assert.equal(capabilities.supported.nativeClientSelection, process.platform === 'win32');
  assert.equal(capabilities.unsupported.implemented, false);
  assert.ok(Array.isArray(capabilities.notes) && capabilities.notes.length > 0);
});
test('Node --version 只输出版本号且不创建数据目录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-version-'));
  try {
    const dataDir = path.join(directory, 'data');
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--version',
      '--data-dir', dataDir
    ], { env: { CXPLUS_NO_LOG_FILE: '1' } });
    assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '6.3.0');
    assert.equal(await fs.access(dataDir).then(() => true, () => false), false,
      '--version 不得创建数据目录或日志');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('Node --list-clients --report 写入列表报告且 --no-disk-write 抑制', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-list-report-'));
  try {
    const reportPath = path.join(directory, 'list-report.json');
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--list-clients',
      '--scan-mode', 'common',
      '--no-scan-cache',
      '--report', reportPath,
      '--data-dir', path.join(directory, 'data'),
      '--quiet'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' }, timeoutMs: 120000 });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.mode, 'list-clients');
    assert.equal(report.host, 'node');
  assert.equal(report.version, '6.3.0');
    assert.equal(report.stopReason, 'list-clients');
    assert.equal(report.success, true);
    assert.equal(report.scanMode, 'common');
    assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0);
    assert.ok(Number.isInteger(report.total) && report.total >= 0);
    assert.equal(report.total, report.candidates.length);
    for (const candidate of report.candidates) {
      assert.equal(typeof candidate.path, 'string');
      assert.equal(typeof candidate.machine, 'string');
    }
    assert.equal(Number.isNaN(Date.parse(report.startedAt)), false);
    assert.equal(Number.isNaN(Date.parse(report.finishedAt)), false);

    const suppressedPath = path.join(directory, 'suppressed-report.json');
    const suppressed = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--list-clients',
      '--scan-mode', 'common',
      '--no-scan-cache',
      '--report', suppressedPath,
      '--data-dir', path.join(directory, 'data-no-write'),
      '--no-disk-write',
      '--quiet'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' }, timeoutMs: 120000 });
    assert.equal(suppressed.code, 0, suppressed.stderr);
    assert.equal(await fs.access(suppressedPath).then(() => true, () => false), false,
      '--no-disk-write 必须抑制列表报告写入');
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
test('Node --execution-mode memory 保持正常可见启动且宿主侧零落盘', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-memory-mode-'));
  try {
    const reportPath = path.join(directory, 'memory-report.json');
    const dataDir = path.join(directory, 'data');
    const result = await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'),
      '--execution-mode', 'memory',
      '--list-clients',
      '--scan-mode', 'common',
      '--no-scan-cache',
      '--report', reportPath,
      '--data-dir', dataDir,
      '--quiet'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' }, timeoutMs: 120000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fs.access(reportPath).then(() => true, () => false), false,
      'memory 模式必须抑制报告落盘');
    assert.equal(await fs.access(dataDir).then(() => true, () => false), false,
      'memory 模式必须不创建数据目录或日志');
    const capabilities = JSON.parse((await runCommand(process.execPath, [
      path.resolve(root, 'windows', 'node-source', 'main.mjs'), '--execution-mode', 'memory', '--capabilities'
    ], { env: { CXPLUS_NO_LOG_FILE: '1' } })).stdout);
    assert.equal(capabilities.executionMode, 'memory');
    assert.deepEqual(capabilities.supported.executionModes, ['normal', 'memory', 'delete-suspend']);
    assert.deepEqual(capabilities.unsupported.nodeOnly, ['delete-suspend', 'startup-wipe', 'self-destruct', 'silent-scenario']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
