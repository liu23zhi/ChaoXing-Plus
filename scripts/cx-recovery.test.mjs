import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const execFileAsync = promisify(execFile);
const outDir = resolve(process.cwd(), '.tmp-tests-cx-recovery-cjs');
const helperModulePath = resolve(outDir, 'cx-recovery.js');
const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'cx-recovery.ts');
const tscCliPath = resolve(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

async function loadHelperModule() {
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}\n');
  await execFileAsync(process.execPath, [
    tscCliPath,
    helperSourcePath,
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck'
  ]);
  const require = createRequire(import.meta.url);
  delete require.cache[helperModulePath];
  return require(helperModulePath);
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

async function createVideoMonitor(mod) {
  const source = await readFile(resolve(process.cwd(), 'src', 'projects', 'cx.ts'), 'utf8');
  const start = source.indexOf('const attemptedVideoRoutes = new Set<unknown>();');
  const intervalEnd = '}, 3000);';
  const end = source.indexOf(intervalEnd, start);
  assert.ok(start >= 0 && end > start, 'the media route monitor must be present');
  const script = ts.transpileModule(source.slice(start, end + intervalEnd.length), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const media = { paused: true, readyState: 0, networkState: 3, error: { code: 4 } };
  const clicks = [];
  const logs = [];
  const skips = [];
  let activeIndex = 0;
  let now = 1000;
  let tick;
  const doc = {
    querySelector(selector) {
      return selector === 'video, audio'
        ? media
        : { innerText: '视频因格式不支持或者服务器或网络的问题无法加载。', style: {} };
    },
    querySelectorAll() {
      return Array.from({ length: 3 }, (_, index) => ({
        value: 'on',
        checked: index === activeIndex,
        click() {
          activeIndex = index;
          clicks.push(index);
        }
      }));
    }
  };
  // Execute the production interval without starting a browser or real timers.
  runInNewContext(script, {
    ...mod,
    doc,
    attachment: { jobid: 'video-1', property: { name: '木雕' } },
    CXAnalyses: { getCurrentChapterStayKey: () => 'chapter-1' },
    buildChapterCorrelationId: () => 'chapter-1:video-1',
    Date: { now: () => now },
    shouldWaitAfterVideoRouteSwitch: (switchedAt) => mod.shouldWaitAfterVideoRouteSwitch(switchedAt, now),
    logDebug: (level, title, details) => logs.push({ level, title, details }),
    $console: { warn() {}, error() {} },
    $message: { warn() {}, error() {} },
    setInterval(callback, delay) {
      assert.equal(delay, 3000);
      tick = callback;
      return 1;
    },
    clearInterval() {},
    setTimeout(callback, delay) {
      skips.push(delay);
    },
    resolve() {}
  });
  return {
    media, clicks, logs, skips,
    tick(time) {
      now = time;
      tick();
    }
  };
}

test('visible-content recovery reloads at most three times and reports only after the fourth failure', async () => {
  const mod = await loadHelperModule();
  const storage = createStorage();
  const signature = 'chapter=cur123::job=work-1::url=/knowledge/cards';
  const reloads = [];
  const notices = [];

  for (let failure = 1; failure <= 4; failure += 1) {
    const result = mod.handleVisibleContentRecovery({
      storage,
      signature,
      reload: () => reloads.push(failure),
      notifyFinalFailure: () => notices.push(failure)
    });
    if (failure < 4) {
      assert.equal(result, 'reloading');
    } else {
      assert.equal(result, 'exhausted');
    }
  }

  assert.deepEqual(reloads, [1, 2, 3]);
  assert.deepEqual(notices, [4]);
});

test('visible-content recovery waits three seconds after a pending reload and resets for a new signature', async () => {
  const mod = await loadHelperModule();
  const storage = createStorage();
  const signature = 'chapter=cur123::job=work-1::url=/knowledge/cards';
  const waits = [];

  assert.equal(mod.handleVisibleContentRecovery({
    storage,
    signature,
    reload() {}
  }), 'reloading');

  const resumed = await mod.resumeVisibleContentRecovery({
    storage,
    signature,
    wait: async (ms) => waits.push(ms)
  });
  assert.equal(resumed, true);
  assert.deepEqual(waits, [3000]);

  assert.equal(mod.handleVisibleContentRecovery({
    storage,
    signature: 'chapter=cur999::job=work-2::url=/knowledge/cards',
    reload() {}
  }), 'reloading');
});

test('video route recovery selects an enabled alternate route and stops when none remain', async () => {
  const mod = await loadHelperModule();
  const clicks = [];
  const root = {
    innerText: '视频因格式不支持或者服务器或网络的问题无法加载。',
    querySelectorAll(selector) {
      assert.equal(selector, 'input[type="radio"]');
      return [
        { disabled: true, checked: true, click() { clicks.push('公网1'); } },
        { disabled: false, checked: false, click() { clicks.push('公网2'); } }
      ];
    }
  };

  assert.equal(mod.trySwitchVideoRoute(root), true);
  assert.deepEqual(clicks, ['公网2']);
  assert.equal(mod.isVideoLoadFailure(root), true);
  assert.equal(mod.isVideoLoadFailure({ innerText: '正常播放中' }), false);
});

test('video route recovery keeps waiting briefly after a successful route switch', async () => {
  const mod = await loadHelperModule();
  const switchedAt = 1000;

  assert.equal(mod.shouldWaitAfterVideoRouteSwitch(switchedAt, 9000), true);
  assert.equal(mod.shouldWaitAfterVideoRouteSwitch(switchedAt, 11000), false);
  assert.equal(mod.shouldWaitAfterVideoRouteSwitch(undefined, 11000), false);
});

test('video route recovery ignores stale error text while the media element is playing', async () => {
  const mod = await loadHelperModule();
  const errorText = '视频因格式不支持或者服务器或网络的问题无法加载。';
  const root = {
    querySelector(selector) {
      if (selector === 'video, audio') {
        return { paused: false, readyState: 4, error: null };
      }
      return { innerText: errorText };
    }
  };

  assert.equal(mod.isVideoLoadFailure(root), false);
  assert.equal(mod.isVideoLoadFailure({ innerText: errorText }), true);
});

test('recovered video can pause or buffer without triggering route recovery from stale text', async () => {
  const mod = await loadHelperModule();
  const media = { paused: true, readyState: 4, networkState: 1, currentTime: 35.397296, error: null };
  let clicks = 0;
  const root = {
    querySelector(selector) {
      return selector === 'video, audio'
        ? media
        : { innerText: '视频因格式不支持或者服务器或网络的问题无法加载。', style: {} };
    },
    querySelectorAll() {
      return [{ checked: false, disabled: false, click() { clicks += 1; } }];
    }
  };

  const diagnostics = mod.inspectVideoLoadState(root);
  assert.equal(diagnostics.playbackHealthy, false);
  assert.equal(mod.isVideoLoadFailure(root), false);
  assert.equal(mod.trySwitchVideoRoute(root, new Set()), false);
  assert.equal(clicks, 0);

  media.readyState = 1;
  media.networkState = 2;
  assert.equal(mod.isVideoLoadFailure(root), false);
  media.readyState = 0;
  assert.equal(mod.isVideoLoadFailure(root), false);

  media.error = { code: 4, message: 'New source error' };
  assert.equal(mod.isVideoLoadFailure(root), true);
});

test('actual media errors trigger recovery even when no error text is present', async () => {
  const mod = await loadHelperModule();
  const root = {
    querySelector(selector) {
      return selector === 'video, audio'
        ? { paused: true, readyState: 0, networkState: 3, error: { code: 4 } }
        : null;
    }
  };
  assert.equal(mod.isVideoLoadFailure(root), true);
});

test('error visibility checks the computed style of parent elements', async () => {
  const mod = await loadHelperModule();
  const parent = { style: {} };
  const ownerDocument = {
    defaultView: {
      getComputedStyle(node) {
        return { display: node === parent ? 'none' : 'block', visibility: 'visible', opacity: '1' };
      }
    }
  };
  parent.ownerDocument = ownerDocument;
  const errorElement = {
    innerText: '视频因格式不支持或者服务器或网络的问题无法加载。',
    style: {},
    parentElement: parent,
    ownerDocument
  };
  const root = {
    querySelector(selector) {
      return selector === 'video, audio'
        ? { paused: true, readyState: 0, networkState: 3, error: null }
        : errorElement;
    }
  };

  assert.equal(mod.inspectVideoLoadState(root).errorElementVisible, false);
  assert.equal(mod.isVideoLoadFailure(root), false);
});

test('visible load errors still recover when the media has no usable source', async () => {
  const mod = await loadHelperModule();
  const media = { paused: true, readyState: 0, networkState: 3, error: null };
  const root = {
    querySelector(selector) {
      return selector === 'video, audio'
        ? media
        : { innerText: '视频因格式不支持或者服务器或网络的问题无法加载。', style: {} };
    }
  };
  assert.equal(mod.isVideoLoadFailure(root), true);
  media.networkState = 0;
  assert.equal(mod.isVideoLoadFailure(root), true);
});

test('radio routes with the default on value keep distinct identities across recreated controls', async () => {
  const mod = await loadHelperModule();
  const attempted = new Set();
  let activeIndex = 0;
  const clicks = [];
  const root = {
    innerText: '视频因格式不支持或者服务器或网络的问题无法加载。',
    querySelectorAll() {
      return Array.from({ length: 3 }, (_, index) => ({
        value: 'on',
        checked: index === activeIndex,
        disabled: false,
        click() {
          activeIndex = index;
          clicks.push(index);
        }
      }));
    }
  };

  assert.deepEqual(mod.inspectVideoLoadState(root).routeControls.map((route) => route.key), ['route-1', 'route-2', 'route-3']);
  assert.equal(mod.trySwitchVideoRoute(root, attempted), true);
  assert.equal(mod.trySwitchVideoRoute(root, attempted), true);
  assert.equal(mod.trySwitchVideoRoute(root, attempted), false);
  assert.deepEqual(clicks, [1, 2]);
  assert.equal(attempted.size, 3);
});

test('explicit route values cannot collide with generated default-on route keys', async () => {
  const mod = await loadHelperModule();
  let clicks = 0;
  const root = {
    innerText: '视频因格式不支持或者服务器或网络的问题无法加载。',
    querySelectorAll() {
      return [
        { value: 'route-2', checked: true },
        { value: 'on', checked: false, click() { clicks += 1; } }
      ];
    }
  };
  const keys = mod.inspectVideoLoadState(root).routeControls.map((route) => route.key);
  assert.equal(new Set(keys).size, 2);
  assert.equal(mod.trySwitchVideoRoute(root, new Set()), true);
  assert.equal(clicks, 1);
});

test('video diagnostics expose stale error text, media playback state, and route controls', async () => {
  const mod = await loadHelperModule();
  const root = {
    querySelector(selector) {
      if (selector === 'video, audio') {
        return { paused: false, readyState: 4, currentTime: 12, duration: 60, networkState: 1, error: null };
      }
      return { innerText: '视频因格式不支持或者服务器或网络的问题无法加载。', style: {} };
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'input[type="radio"]');
      return [
        { value: '公网1', checked: true, disabled: false },
        { value: '公网2', checked: false, disabled: false }
      ];
    }
  };

  const diagnostics = mod.inspectVideoLoadState(root);
  assert.equal(diagnostics.failureTextDetected, true);
  assert.equal(diagnostics.playbackHealthy, true);
  assert.equal(diagnostics.mediaCurrentTime, 12);
  assert.deepEqual(diagnostics.routeControls.map((route) => route.key), ['value:公网1', 'value:公网2']);
});

test('the media monitor waits for each alternate route and does not skip recovered pauses', async () => {
  const mod = await loadHelperModule();
  const monitor = await createVideoMonitor(mod);
  monitor.tick(1000);
  assert.deepEqual(monitor.clicks, [1]);
  monitor.tick(4000);
  assert.deepEqual(monitor.clicks, [1]);
  assert.equal(monitor.logs.at(-1).title, '视频线路切换等待诊断');
  monitor.tick(12000);
  assert.deepEqual(monitor.clicks, [1, 2]);
  monitor.tick(15000);
  assert.deepEqual(monitor.skips, []);

  Object.assign(monitor.media, { error: null, paused: false, readyState: 4, networkState: 1 });
  monitor.tick(18000);
  monitor.media.paused = true;
  monitor.tick(53000);
  assert.deepEqual(monitor.clicks, [1, 2]);
  assert.deepEqual(monitor.skips, []);
  assert.equal(monitor.logs.some((log) => log.level === 'error'), false);
});

test('the media monitor reports failure only after all alternate routes finish their grace periods', async () => {
  const mod = await loadHelperModule();
  const monitor = await createVideoMonitor(mod);
  monitor.tick(1000);
  monitor.tick(4000);
  monitor.tick(12000);
  monitor.tick(15000);
  assert.deepEqual(monitor.clicks, [1, 2]);
  assert.deepEqual(monitor.skips, []);
  monitor.tick(23000);
  assert.deepEqual(monitor.skips, [3000]);
  assert.equal(monitor.logs.at(-1).title, '视频线路切换失败诊断');
  assert.equal(monitor.logs.at(-1).details.loadFailureReason, 'media-error');
});

test('the media monitor preserves its grace period while the new source is still loading', async () => {
  const mod = await loadHelperModule();
  for (const readyState of [0, 1]) {
    const monitor = await createVideoMonitor(mod);
    monitor.tick(1000);
    Object.assign(monitor.media, { error: null, readyState, networkState: 2 });
    monitor.tick(4000);
    monitor.media.error = { code: 4 };
    monitor.tick(7000);
    assert.deepEqual(monitor.clicks, [1]);
    assert.deepEqual(monitor.skips, []);
    monitor.tick(12000);
    assert.deepEqual(monitor.clicks, [1, 2]);
  }
});

test('video state and route waiting diagnostics are not repeated while the state stays unchanged', async () => {
  const mod = await loadHelperModule();
  const monitor = await createVideoMonitor(mod);
  Object.assign(monitor.media, { error: null, paused: false, readyState: 4, networkState: 1, currentTime: 2 });
  monitor.tick(1000);
  monitor.media.currentTime = 8;
  monitor.tick(7000);
  monitor.media.readyState = 3;
  monitor.tick(13000);
  assert.equal(monitor.logs.filter((log) => log.title === '视频线路状态诊断').length, 1);
  monitor.media.paused = true;
  monitor.tick(19000);
  monitor.tick(25000);
  assert.equal(monitor.logs.filter((log) => log.title === '视频线路状态诊断').length, 2);

  const failing = await createVideoMonitor(mod);
  failing.tick(1000);
  failing.tick(4000);
  const stateLogCount = failing.logs.filter((log) => log.title === '视频线路状态诊断').length;
  failing.tick(7000);
  failing.tick(10000);
  assert.equal(failing.logs.filter((log) => log.title === '视频线路状态诊断').length, stateLogCount);
  assert.equal(failing.logs.filter((log) => log.title === '视频线路切换等待诊断').length, 1);
});

test('cx wires recovery into the study scanner and media runner', async () => {
  const source = await (await import('node:fs/promises')).readFile(resolve(process.cwd(), 'src', 'projects', 'cx.ts'), 'utf8');

  assert.equal(source.includes("from './cx-recovery.js'"), true);
  assert.equal(source.includes('resumeVisibleContentRecovery'), true);
  assert.equal(source.includes('async function waitForTopWindowLoad()'), true);
  assert.equal(source.includes('await waitForTopWindowLoad();'), true);
  assert.equal(source.includes('function buildVisibleContentRecoverySignature()'), true);
  assert.equal(source.includes("const chapterKey = CXAnalyses.getCurrentChapterKey() || 'unknown-chapter';"), true);
  assert.equal(source.includes('CXAnalyses.getCurrentChapterKey() || CXAnalyses.getCurrentChapterStayKey()'), false);
  assert.equal(source.includes('handleVisibleContentRecovery'), true);
  assert.equal(source.includes('trySwitchVideoRoute'), true);
  assert.equal(source.includes('inspectVideoLoadState'), true);
  assert.equal(source.includes('视频线路状态诊断'), true);
  assert.equal(source.includes('shouldWaitAfterVideoRouteSwitch'), true);
  assert.equal(source.includes('视频线路切换等待诊断'), true);
  assert.equal(source.includes("logDebug('warn', '视频线路切换诊断'"), true);
  assert.equal(source.includes("logDebug('error', '视频线路切换失败诊断'"), true);
  assert.equal(source.includes('attemptedVideoRoutes.size'), true);
  assert.equal(source.includes("topWindow.location['reload']()"), true);
});
