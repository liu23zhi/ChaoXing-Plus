import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const moduleUrl = (name) => new URL('../windows/node-source/' + name + '.mjs', import.meta.url).href;

test('main closes an invalid lease before launching, and stops only its owned child after launch', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-node-lease-main-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = path.join(directory, 'config.json');
  const assets = path.join(directory, 'assets');
  await fs.mkdir(path.join(assets, 'vendor'), { recursive: true });
  await fs.writeFile(config, '{}');
  for (const name of ['windows-bootstrap.js', 'chaoxing-plus.windows.js', 'trampoline.js', 'vendor/sweetalert2.min.css']) {
    await fs.writeFile(path.join(assets, name), '/* fixture */');
  }
  for (const stage of ['before-launch', 'after-launch', 'normal-close', 'uac', 'startup-uac']) {
    const source = `
      import { mock } from 'node:test';
      import { EventEmitter } from 'node:events';
      import assert from 'node:assert/strict';
      const launch = await import(${JSON.stringify(moduleUrl('launch'))});
      const config = await import(${JSON.stringify(moduleUrl('config'))});
      const noop = async () => {};
      let invalidate;
      let spawns = 0;
      let closes = 0;
      const killed = [];
      const stage = ${JSON.stringify(stage)};
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://adapter.example/api/script-command/a/activate');
        const body = JSON.parse(init.body);
        assert.equal(body.activationToken, 'activation-fixture');
        assert.match(body.identity, /^[a-f0-9]{64}$/u);
        return Response.json({ token: 'DO_NOT_PERSIST_SESSION', heartbeatUrl: '/api/script-command/a/heartbeat', expiresAt: new Date(Date.now() + 60000).toISOString() });
      };
      mock.module(${JSON.stringify(moduleUrl('config'))}, { namedExports: { ...config,
        defaultConfigPath: () => ${JSON.stringify(config)}
      } });
      const leases = await import(${JSON.stringify(moduleUrl('script-lease'))});
      mock.module(${JSON.stringify(moduleUrl('script-lease'))}, { namedExports: { ...leases,
        startScriptSessionLease: (_activation, options) => {
          invalidate = options.onInvalid;
          return { close() { closes += 1; } };
        }
      } });
      mock.module(${JSON.stringify(moduleUrl('program-cleanup'))}, { namedExports: {
        createProgramCleanupController: () => ({ start: noop, finalPass: noop, close: noop })
      } });
      const wipe = await import(${JSON.stringify(moduleUrl('wipe'))});
      mock.module(${JSON.stringify(moduleUrl('wipe'))}, { namedExports: { ...wipe,
        createWipeController: () => ({ start: noop, close: noop })
      } });
      mock.module(${JSON.stringify(moduleUrl('client-selection'))}, { namedExports: {
        resolveClientSelection: async () => ${JSON.stringify(path.join(directory, 'CXExam.exe'))}
      } });
      mock.module(${JSON.stringify(moduleUrl('launch'))}, { namedExports: { ...launch,
        isElevated: async () => false,
        readPeMachine: async () => 0x014c,
        listProcessIdsByName: async () => [],
        chooseBindablePort: async () => {
          if (stage === 'before-launch') await invalidate('expired');
          return { port: 38100, rejected: [] };
        },
        spawnClient: () => {
          spawns += 1;
          if (stage === 'uac') throw Object.assign(new Error('elevation required'), { win32Code: 740 });
          return { child: Object.assign(new EventEmitter(), { pid: 7654321, exitCode: null }) };
        },
        waitForDebugEndpoint: async () => {
          if (stage === 'after-launch') await invalidate('heartbeat-failed');
          if (stage === 'normal-close') process.emit('SIGINT');
          return { Browser: 'Chrome/75.0.3770.100' };
        },
        killProcessTree: async (pid) => { killed.push(pid); },
        relaunchElevated: async () => { throw new Error('SCRIPT_SESSION_MUST_NOT_HANDOFF'); }
      } });
      process.env.CXPLUS_SCRIPT_BOOTSTRAP_B64 = Buffer.from(JSON.stringify({
        settings: {
          'common.settings.tiku-adapter.baseurl': 'https://adapter.example',
          'common.settings.tiku-adapter.script-session-url': 'https://adapter.example/api/script-command/a/activate',
          'common.settings.tiku-adapter.script-activation-token': 'activation-fixture'
        }, noDiskWrite: true, elevateOnStart: stage === 'startup-uac'
      })).toString('base64');
      process.argv = [process.execPath, ${JSON.stringify(moduleUrl('main'))}, ...${JSON.stringify([
        '--config', config, '--assets', assets, '--data-dir', path.join(directory, 'data'), '--client-first', '--ui', 'cli'
      ])}];
      process.once('beforeExit', () => {
        assert.equal(spawns, ['before-launch', 'startup-uac'].includes(stage) ? 0 : 1, 'invalidating before launch must prevent CreateProcess');
        assert.deepEqual(killed, ['after-launch', 'normal-close'].includes(stage) ? [7654321] : [], 'only the owned active child may be terminated');
        if (stage !== 'startup-uac') assert.ok(closes > 0, 'stop must close the lease controller');
        console.log('LEASE_MAIN_STOP_CONFIRMED');
      });
      await import(${JSON.stringify(moduleUrl('main'))});
    `;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source], {
        cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('mock host did not stop')); }, 15000);
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    assert.equal(result.code, stage.includes('uac') ? 3 : 0, result.output);
    assert.match(result.output, /LEASE_MAIN_STOP_CONFIRMED/u);
    assert.doesNotMatch(result.output, /DO_NOT_PERSIST_SESSION|SCRIPT_SESSION_MUST_NOT_HANDOFF/u);
  }
  assert.deepEqual((await fs.readdir(directory)).sort(), ['assets', 'config.json']);
});
