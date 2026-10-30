import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const executable = process.env.CX_NATIVE_SELECTION_EXE;

function parseCaps(stdout) {
  const match = /caps: injectMask=0x([0-9a-f]+) carrierMask=0x([0-9a-f]+) reasons=0x([0-9a-f]+)/iu.exec(stdout);
  assert.ok(match, `缺少 caps 输出：${stdout}`);
  return {
    injectMask: Number.parseInt(match[1], 16),
    carrierDisabledMask: Number.parseInt(match[2], 16),
    reasons: Number.parseInt(match[3], 16)
  };
}

test('packed clients keep dll-proxy selectable while cdp-port stays greyed', { skip: !executable }, async () => {
  const hookDll = path.join(path.dirname(executable), '..', 'hook', 'winmm.dll');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-caps-'));
  try {
    // 载体目录相对"宿主自身"的目录扫描，所以探测器也要复制进同一目录。
    const probeHost = path.join(directory, 'probe-host.exe');
    await fs.copyFile(executable, probeHost);
    const hook = path.join(directory, 'hook');
    await fs.mkdir(hook, { recursive: true });
    // selection-tests.exe 导入 VERSION.dll；载体目录只要存在同名代理，dll-proxy 就应可用。
    if (await fs.stat(hookDll).catch(() => null)) {
      await fs.copyFile(hookDll, path.join(hook, 'version.dll'));
    } else {
      await fs.writeFile(path.join(hook, 'version.dll'), 'placeholder');
    }
    const probe = path.join(directory, 'probe.exe');
    await fs.copyFile(executable, probe);

    const plain = spawnSync(probeHost, ['--caps', probe], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /embedded=winmm\.dll/u, 'winmm 代理必须内嵌在 EXE 里');
    const plainCaps = parseCaps(plain.stdout);
    assert.equal(plainCaps.injectMask & 0x2, 0, '未加壳客户端可以选择 cdp-port');
    assert.equal(plainCaps.injectMask & 0x4, 0, '有代理 DLL 时 dll-proxy 可选');
    assert.equal(plainCaps.reasons, 0, '没有灰化原因时不显示提示');

    // 把第一个节名改成 .themida，模拟 4.3.0.4 这类加壳客户端。
    const packed = path.join(directory, 'packed.exe');
    await fs.copyFile(executable, packed);
    const handle = await fs.open(packed, 'r+');
    try {
      const header = Buffer.alloc(4096);
      await handle.read(header, 0, header.length, 0);
      const peOffset = header.readUInt32LE(0x3c);
      const sections = header.readUInt16LE(peOffset + 6);
      const optionalSize = header.readUInt16LE(peOffset + 20);
      assert.ok(sections > 0, '测试二进制必须带节表');
      const name = Buffer.alloc(8);
      name.write('.themida', 'ascii');
      await handle.write(name, 0, name.length, peOffset + 24 + optionalSize);
    } finally {
      await handle.close();
    }
    const packedRun = spawnSync(probeHost, ['--caps', packed], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(packedRun.status, 0, packedRun.stdout + packedRun.stderr);
    assert.match(packedRun.stdout, /embedded=winmm\.dll/u);
    const packedCaps = parseCaps(packedRun.stdout);
    assert.equal(packedCaps.injectMask & 0x2, 0x2, '加壳客户端禁用 cdp-port');
    assert.equal(packedCaps.injectMask & 0x4, 0, '加壳客户端的 dll-proxy 必须仍然可选');
    assert.equal(packedCaps.reasons & 0x1, 0x1, '加壳原因必须记录，供界面提示');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test('compiled native client selection builds its real hidden controls', { skip: !executable }, () => {
  const result = spawnSync(executable, [], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
  assert.match(result.stdout, /full disk scan remains available/);
  for (const expected of [
    /hidden full-scan progress window thread starts/,
    /progress window binds discovery progress\/cancel hooks/,
    /ending the progress window normally is not a cancellation/,
    /the auto-cancel timer reports cancellation/,
    /discovery reports visited directory progress/,
    /the cancel callback reports a cancelled full scan/,
    /the injection hint control exists for greyed modes/,
    /injection reasons stay hidden unless --show-inject-reasons is passed/,
    /explained mode shows the injection reason line/,
    /auto injection mode keeps only the automatic carrier entry/,
    /dll-proxy mode expands the carrier list/,
    /the winmm proxy DLL is embedded in the executable/,
    /the embedded proxy is a PE image/,
    /selection layout uses the active DPI scale/,
    /the high-DPI progress window scales its width from 96 DPI metrics/
  ]) {
    assert.match(result.stdout, expected);
  }
  assert.doesNotMatch(result.stdout, /^FAIL /mu);
});

test('standalone EXE lists the embedded carrier without any hook directory', { skip: !executable }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-standalone-'));
  try {
    // 空目录里只有 EXE：载体列表必须来自内嵌资源，否则 dll-proxy 会被误灰化。
    const copy = path.join(directory, 'selection-tests.exe');
    await fs.copyFile(executable, copy);
    const result = spawnSync(copy, [], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /auto injection mode keeps only the automatic carrier entry/u);
    assert.match(result.stdout, /dll-proxy mode expands the carrier list/u);
    assert.match(result.stdout, /the winmm proxy DLL is embedded in the executable/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native full-scan progress window is visible and cancellable', {
  skip: !executable || process.env.CX_TEST_NATIVE_WINDOW !== '1'
}, () => {
  const result = spawnSync(executable, ['--scan-progress'], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /the progress window is visible to the operating system/);
  assert.match(result.stdout, /clicking cancel reports a progress-window cancellation/);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
  assert.doesNotMatch(result.stdout, /^FAIL /mu);
});

test('native full scan button returns a scan request without selecting or launching a client', {
  skip: !executable || process.env.CX_TEST_NATIVE_WINDOW !== '1'
}, () => {
  const result = spawnSync(executable, ['--request-scan-all'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CXPLUS_NATIVE_SELECTION_AUTO_CLOSE_MS: '3000' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /the full scan button requests scanning without selecting or launching a client/);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
});

test('native client selection displays and cancels without launching a client', {
  skip: !executable || process.env.CX_TEST_NATIVE_WINDOW !== '1'
}, () => {
  const result = spawnSync(executable, ['--show-cancel'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CXPLUS_NATIVE_SELECTION_AUTO_CLOSE_MS: '200' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /closing the actual window cancels without a selected client/);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
});

test('native client selection returns a validated Unicode client path after choosing its row', {
  skip: !executable || process.env.CX_TEST_NATIVE_WINDOW !== '1'
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-select-中文 空格-'));
  try {
    const client = path.join(directory, 'CXExam.exe');
    await fs.copyFile(executable, client);
    const result = spawnSync(executable, ['--choose', client], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, CXPLUS_NATIVE_SELECTION_AUTO_CLOSE_MS: '3000' }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /choosing a row returns its validated Unicode PE path/);
    assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native selection and progress windows scale their layout at a configured high DPI', {
  skip: !executable
}, () => {
  const result = spawnSync(executable, [], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, CXPLUS_NATIVE_UI_DPI: '144' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /selection layout uses the active DPI scale/);
  assert.match(result.stdout, /the high-DPI progress window scales its width from 96 DPI metrics/);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
  assert.doesNotMatch(result.stdout, /^FAIL /mu);
});
