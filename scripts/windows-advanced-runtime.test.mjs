import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { listProgramFiles, createProgramCleanupController } from '../windows/node-source/program-cleanup.mjs';
import { createSelfDestructController } from '../windows/node-source/self-destruct-control.mjs';
import { parseHostArgs } from '../windows/node-source/options.mjs';

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-advanced-runtime-'));
}

async function writeReleaseLayout(root) {
  const files = ['main.mjs', 'start-windows-silent.cmd'];
  for (const name of files) await fs.writeFile(path.join(root, name), '// fixture\n', 'utf8');
  // 自带 Node 运行时也是发布包登记的 payload，但它正在执行、绝不能被清理删除。
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(root, 'runtime', 'node.exe'), '// runtime fixture\n', 'utf8');
  const sums = [...files, 'runtime/node.exe']
    .map((name) => `${createHash('sha256').update(name === 'runtime/node.exe' ? '// runtime fixture\n' : '// fixture\n').digest('hex').toUpperCase()} *${name}`)
    .join('\n');
  const dataDirectory = path.join(root, 'windows', 'data');
  await fs.mkdir(path.join(dataDirectory, 'logs'), { recursive: true });
  await fs.writeFile(path.join(dataDirectory, 'logs', 'host-1.log'), 'log\n', 'utf8');
  await fs.writeFile(path.join(dataDirectory, 'scan-cache.json'), '{}', 'utf8');
  await fs.writeFile(path.join(root, 'SHA256SUMS.txt'), `${sums}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'release-info.json'), '{"name":"fixture"}\n', 'utf8');
  return { dataDirectory, files };
}

test('program-cleanup 只删除发布包程序与宿主数据，模拟模式不删除', async () => {
  const root = await tempRoot();
  try {
    const { dataDirectory, files } = await writeReleaseLayout(root);
    const untrusted = await listProgramFiles(root);
    assert.equal(untrusted.releaseLayout, true);
    assert.equal(untrusted.files.some((file) => file.endsWith('main.mjs')), true);

    const simulate = createProgramCleanupController({ appRoot: root, dataDirectory, simulate: true });
    await simulate.start();
    assert.equal(await fs.readFile(path.join(root, files[0]), 'utf8'), '// fixture\n');
    await simulate.close();

    const real = createProgramCleanupController({ appRoot: root, dataDirectory, simulate: false, retryDelayMs: 1 });
    const result = await real.start();
    assert.equal(result.pending.length, 0);
    await assert.rejects(fs.access(path.join(root, files[0])));
    await assert.rejects(fs.access(path.join(dataDirectory, 'scan-cache.json')));
    // 自带运行时正在执行、且不属于程序痕迹：清理必须原样保留。
    assert.equal(await fs.readFile(path.join(root, 'runtime', 'node.exe'), 'utf8'), '// runtime fixture\n');
    assert.equal(result.deleted.includes(path.join(root, 'runtime', 'node.exe')), false);
    await real.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelayMs: 100 });
  }
});

test('非发布布局拒绝真实删除程序文件，只清理宿主数据', async () => {
  const root = await tempRoot();
  try {
    await fs.writeFile(path.join(root, 'main.mjs'), '// no sums\n', 'utf8');
    const dataDirectory = path.join(root, 'windows', 'data');
    await fs.mkdir(dataDirectory, { recursive: true });
    await fs.writeFile(path.join(dataDirectory, 'config.json'), '{}', 'utf8');
    const controller = createProgramCleanupController({ appRoot: root, dataDirectory, simulate: false, retryDelayMs: 1 });
    await controller.start();
    assert.equal(await fs.readFile(path.join(root, 'main.mjs'), 'utf8'), '// no sums\n');
    await assert.rejects(fs.access(path.join(dataDirectory, 'config.json')));
    await controller.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelayMs: 100 });
  }
});

test('self-destruct 仅在客户端启动后响应热键/全屏/进程退出，并只收尾一次', async () => {
  const reasons = [];
  const controller = createSelfDestructController({
    keys: ['Ctrl+Alt+Shift+E', 'F8'],
    fullscreenExit: true,
    confirm: false,
    logger: () => {},
    onDestruct: async (reason) => { reasons.push(reason); }
  });
  controller.handleHotkey('F8');
  assert.deepEqual(reasons, [], '未启动客户端不得触发');

  controller.attachClient(4321);
  controller.handleHotkey('F8');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(reasons, ['shortcut']);

  // 已销毁后重复事件不得再次收尾。
  controller.clientExited(4321);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(reasons, ['shortcut']);
});

test('self-destruct 全屏退出只在此前进入全屏后触发，进程退出也可触发', async () => {
  const reasons = [];
  const controller = createSelfDestructController({
    keys: [],
    fullscreenExit: true,
    confirm: false,
    logger: () => {},
    onDestruct: async (reason) => { reasons.push(reason); }
  });
  controller.attachClient(99);
  controller.handleFullscreen(false, 99);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reasons, [], '未进入全屏时退出不应触发');
  controller.handleFullscreen(true, 99);
  controller.handleFullscreen(false, 99);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(reasons, ['fullscreen-exit']);
});

test('self-destruct 客户端从未启动时，全屏与进程事件都不得触发', async () => {
  const reasons = [];
  const controller = createSelfDestructController({
    keys: ['F8'],
    fullscreenExit: true,
    confirm: false,
    logger: () => {},
    onDestruct: async (reason) => { reasons.push(reason); }
  });
  controller.handleFullscreen(true, 4242);
  controller.handleFullscreen(false, 4242);
  controller.handleHotkey('F8');
  controller.clientExited(4242);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(reasons, [], '未启动 CXExam 时不得自毁');
});

test('静默场景固定调参：自毁键、全屏规则、手动放行、零落盘与扫描策略', () => {
  const silent = parseHostArgs(['--silent-scenario', '--execution-mode', 'memory']);
  assert.equal(silent.silentScenario, true);
  assert.equal(silent.silentDeleteSimulate, false);
  assert.deepEqual(silent.selfDestructKeys, ['Ctrl+Alt+Shift+E', 'F8']);
  assert.equal(silent.selfDestructOnFullscreenExit, true);
  assert.equal(silent.selfDestructConfirm, false);
  assert.equal(silent.selfDestructDelayMs, 0);
  assert.equal(silent.executionMode, 'memory');
  assert.equal(silent.noDiskWrite, true);
  assert.equal(silent.noLog, true);
  assert.equal(silent.logFileEnabled, false);
  assert.equal(silent.quiet, true);
  assert.equal(silent.panelEnabled, false);
  assert.equal(silent.noDiagnose, true);
  assert.equal(silent.answerMode, 'manual');
  assert.equal(silent.answerKey, 'Ctrl+Alt+Shift+S');
  assert.equal(silent.answerThreads, 1);
  assert.equal(silent.showAnswerDialog, false);
  assert.equal(silent.clientFirst, true);
  assert.equal(silent.scanMode, 'fallback-all');
  assert.equal(silent.noScanCache, true);
  assert.equal(silent.reportPath, '');
  // 调试入口：同样的场景但保留控制台输出，并且不触发全盘回退。
  const debug = parseHostArgs(['--silent-scenario', '--silent-delete-simulate', '--scan-mode', 'common']);
  assert.equal(debug.silentDeleteSimulate, true);
  assert.equal(debug.quiet, false, '模拟删除的调试入口必须保留控制台输出');
  assert.equal(debug.scanMode, 'common');
  assert.equal(debug.noDiskWrite, true);
  assert.equal(debug.panelEnabled, false);
});

test('程序清理每个文件启动期最多尝试 5 次，失败不阻塞并在运行期重试', async () => {
  const root = await tempRoot();
  try {
    const { dataDirectory } = await writeReleaseLayout(root);
    const attempts = new Map();
    const rmStub = async (filePath, options) => {
      const count = (attempts.get(filePath) || 0) + 1;
      attempts.set(filePath, count);
      if (count <= 5) throw Object.assign(new Error('EBUSY: file is locked'), { code: 'EBUSY' });
      return fs.rm(filePath, options);
    };
    const controller = createProgramCleanupController({
      appRoot: root,
      dataDirectory,
      simulate: false,
      retries: 5,
      retryDelayMs: 1,
      runtimeRetryMs: 5,
      fsImpl: { rm: rmStub },
      logger: () => {}
    });
    const started = await controller.start();
    assert.equal(started.pending.length > 0, true, '启动期失败必须保留为待重试而不是抛错');
    const firstPending = started.pending[0];
    assert.equal(attempts.get(firstPending), 5, '启动期必须恰好尝试 5 次');
    const deadline = Date.now() + 2000;
    while (controller.getSummary().pending.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const summary = controller.getSummary();
    assert.deepEqual(summary.pending, [], '运行期重试成功后不应再有待删除文件');
    assert.equal(summary.deleted.includes(firstPending), true);
    await controller.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelayMs: 100 });
  }
});

test('模拟删除只报告计划，调用方关闭后不再重试', async () => {
  const root = await tempRoot();
  try {
    const { dataDirectory, files } = await writeReleaseLayout(root);
    let removeCalls = 0;
    const events = [];
    const controller = createProgramCleanupController({
      appRoot: root,
      dataDirectory,
      simulate: true,
      retries: 5,
      fsImpl: { rm: async () => { removeCalls += 1; } },
      logger: (event) => { events.push(event); }
    });
    await controller.start();
    assert.equal(removeCalls, 0, '模拟模式不得调用删除');
    assert.equal(await fs.readFile(path.join(root, files[0]), 'utf8'), '// fixture\n');
    const summary = controller.getSummary();
    assert.equal(summary.simulate, true);
    assert.equal(summary.deleted.length > 0, true, '模拟模式记录计划删除的文件');
    assert.equal(events.some((event) => event.type === 'start' && event.simulate === true), true);
    await controller.close();
    const closed = await controller.finalPass();
    assert.equal(removeCalls, 0);
    assert.equal(closed.status, 'closed');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelayMs: 100 });
  }
});
