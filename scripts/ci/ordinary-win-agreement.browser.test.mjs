import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveTestPath } from '../test-helpers/temp-directory.mjs';
import {
  assertNoAuthorityInPackages, expectProbe, extensionIdentity, launchOwnedBrowser, makeExtension, ownedMessage, readStockFiles,
  shapeBase, shapeHash, startOwnedPage
} from './ordinary-win-agreement/browser-fixture.mjs';
import { authorizeOwnedHostRequest, instrumentOwnedWorker } from './ordinary-win-agreement/host-result.mjs';

const exec = promisify(execFile);
const helperPath = fileURLToPath(new URL('./ordinary-win-agreement/registry.ps1', import.meta.url));
const hostedWindows = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true'
  && process.env.RUNNER_OS === 'Windows' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const requestedWindows = Boolean(process.env.CX_T04_PROVIDER_EXE || process.env.CX_T04_NATIVE_EXE);
const providerFields = ['baseUrl', 'caPem', 'controlKey', 'deviceId', 'deviceCredential', 'accountToken', 'hostDeviceId', 'instance'];

test('owned host bridge accepts only the exact sender, request and one-field native reply', async () => {
  const scope = { hostName: 'org.cxplus.t04_unit', url: 'http://127.0.0.1:12345/owned-t04/active',
    origin: 'http://127.0.0.1:12345', shapeBase, shapeHash };
  const sender = { id: 'owned-extension', frameId: 0, tab: { id: 1 }, documentId: 'owned-doc',
    url: scope.url, origin: scope.origin };
  const sends = [];
  let answer, lastError;
  const runtime = { id: sender.id, get lastError() { return lastError; },
    sendNativeMessage(hostName, request, respond) { sends.push({ hostName, request }); respond(answer); } };
  answer = { allowed: true };
  assert.deepEqual(await authorizeOwnedHostRequest(runtime, scope, ownedMessage, sender), { allowed: true });
  assert.deepEqual(sends, [{ hostName: scope.hostName, request: { operation: 'agreement-status' } }]);

  for (const bad of [{ id: 'another-extension' }, { frameId: 1 }, { tab: { id: -1 } },
    { documentId: '' }, { url: scope.url + '?other' }, { origin: 'http://127.0.0.1:54321' }]) {
    assert.deepEqual(await authorizeOwnedHostRequest(runtime, scope, ownedMessage, { ...sender, ...bad }), { allowed: false });
  }
  for (const bad of [{ ...ownedMessage, allowed: true }, { ...ownedMessage, keyHash: '0'.repeat(64) },
    { ...ownedMessage, base: scope.origin }]) {
    assert.deepEqual(await authorizeOwnedHostRequest(runtime, scope, bad, sender), { allowed: false });
  }
  assert.equal(sends.length, 1, 'out-of-scope messages must not reach native transport');

  for (const invalid of [null, [], {}, true, { allowed: 1 }, { allowed: 'true' }, { allowed: true, extra: 'unexpected' }]) {
    answer = invalid;
    assert.deepEqual(await authorizeOwnedHostRequest(runtime, scope, ownedMessage, sender), { allowed: false });
  }
  lastError = { message: 'host missing' };
  answer = { allowed: true };
  assert.deepEqual(await authorizeOwnedHostRequest(runtime, scope, ownedMessage, sender), { allowed: false });
  let lateReply;
  const waiting = authorizeOwnedHostRequest({
    id: sender.id, sendNativeMessage(_name, _request, respond) { lateReply = respond; }
  }, scope, ownedMessage, sender, 5);
  assert.deepEqual(await waiting, { allowed: false });
  lateReply({ allowed: true });
  assert.deepEqual(await waiting, { allowed: false });
  const worker = await readFile(resolveTestPath('src/extension-agreement-worker.js'), 'utf8');
  assert.match(instrumentOwnedWorker(worker, scope), /if \(op === 'authorize'\) \{\n {6}void authorizeOwnedHostRequest/);
  assert.throws(() => instrumentOwnedWorker('missing seam', scope), /test seam changed/);
});

async function requiredFile(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required on the hosted Windows runner');
  const file = await realpath(value);
  if (!(await stat(file)).isFile()) throw new Error(name + ' must name a file');
  return file;
}

function decodeProvider(raw) {
  const info = JSON.parse(raw);
  if (!info || Array.isArray(info) || !providerFields.every(key => typeof info[key] === 'string' && info[key])) {
    throw new Error('Provider did not produce its expected native-only configuration');
  }
  let url;
  try { url = new URL(info.baseUrl); }
  catch { throw new Error('Provider origin is not the scoped owned fixture'); }
  if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== info.baseUrl
    || !info.caPem.startsWith('-----BEGIN CERTIFICATE-----')) {
    throw new Error('Provider origin/certificate is not the scoped owned fixture');
  }
  return info;
}

async function startProvider(exe, fixtureDir, signal) {
  const child = spawn(exe, ['-test.run', '^TestOwnedOrdinaryWindowsAgreementProvider$'], {
    env: { ...process.env, CX_T04_FIXTURE_DIR: fixtureDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.on('error', () => {});
  let finished;
  const done = new Promise(resolve => {
    child.once('error', () => resolve({ code: -1 }));
    child.once('close', code => resolve({ code }));
  });
  done.then(state => { finished = state; });
  async function close() {
    child.stdin.end();
    for (let attempt = 0; !finished && attempt < 100; attempt++) await sleep(50);
    if (!finished) {
      child.kill();
      for (let attempt = 0; !finished && attempt < 40; attempt++) await sleep(50);
      throw new Error('Owned provider did not stop cleanly on stdin EOF');
    }
    if (finished.code !== 0) throw new Error('Owned provider exit was not zero');
  }
  try {
    const file = join(fixtureDir, 'provider.json');
    for (let attempt = 0; attempt < 200; attempt++) {
      if (finished) throw new Error('Owned provider exited before exposing fixture configuration');
      let raw;
      try { raw = await readFile(file, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (raw) {
        try { return { info: decodeProvider(raw), close }; }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      await sleep(75, undefined, { signal });
    }
    throw new Error('Timed out waiting for owned provider configuration');
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Owned provider start and cleanup failed'); }
    throw error;
  }
}

function control(info, action, signal) {
  if (!['accept', 'rotate'].includes(action)) throw new Error('Unexpected owned action');
  const body = JSON.stringify({ action });
  return new Promise((resolve, reject) => {
    const req = request(info.baseUrl + '/__owned_t04', {
      method: 'POST', ca: info.caPem, signal,
      headers: { 'X-Owned-Control': info.controlKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      res.resume();
      res.once('end', () => res.statusCode === 204 ? resolve() : reject(new Error('Owned action ' + action + ' returned ' + res.statusCode)));
      res.once('error', () => reject(new Error('Owned HTTPS control response failed')));
    });
    req.once('error', () => reject(new Error('Owned HTTPS control request failed')));
    req.setTimeout(5000, () => req.destroy());
    req.end(body);
  });
}

async function registry(action, hostName, manifest) {
  if (!hostedWindows) throw new Error('Registry operation requires a hosted Windows runner');
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await exec(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-Action', action, '-Name', hostName, '-Manifest', manifest
  ], { timeout: 10_000, windowsHide: true });
  return stdout.trim();
}

async function ownedScratch() {
  const temp = await realpath(process.env.RUNNER_TEMP);
  const root = await mkdtemp(join(temp, 'cx-t04-owned-'));
  return { root, async remove() {
    if ((await lstat(root)).isSymbolicLink() || relative(root, await realpath(root)) !== ''
      || relative(temp, dirname(root)) !== '') throw new Error('Refusing to remove unexpected fixture path');
    await rm(root, { recursive: true, maxRetries: 5, retryDelay: 150 });
    await assert.rejects(access(root), { code: 'ENOENT' });
  } };
}

test('ordinary Windows native result controls an owned browser operation, stock still denies', {
  skip: hostedWindows || requestedWindows ? false : 'requires ephemeral GitHub-hosted Windows CI; no local registration',
  timeout: 185_000
}, async t => {
  if (!hostedWindows) throw new Error('Requested test must run on an ephemeral GitHub-hosted Windows runner');
  const signal = t.signal;
  const providerExe = await requiredFile('CX_T04_PROVIDER_EXE');
  const nativeExe = await requiredFile('CX_T04_NATIVE_EXE');
  const { default: puppeteer } = await import('puppeteer');
  const dist = resolveTestPath('dist');
  const stock = await readStockFiles(dist);
  const scratch = await ownedScratch();
  const hostName = 'org.cxplus.t04_' + randomUUID().replaceAll('-', '');
  const identity = extensionIdentity(), wrongIdentity = extensionIdentity();
  const candidate = join(scratch.root, 'candidate-ext'), original = join(scratch.root, 'stock-ext');
  const wrongOrigin = join(scratch.root, 'wrong-origin-ext'), nativeDir = join(scratch.root, 'native');
  const manifest = join(nativeDir, 'native-host.json'), fixtureDir = join(scratch.root, 'provider');
  let owned, provider, browser, attemptedRegistration = false;

  async function unregister() {
    if (!attemptedRegistration) return;
    assert.equal(await registry('Unregister', hostName, manifest), 'removed');
    attemptedRegistration = false;
  }
  async function check(dir, profile, id, want, label) {
    const launched = await launchOwnedBrowser(puppeteer, dir, join(scratch.root, profile), id, signal);
    try { await expectProbe(launched, owned, owned.url, want, label); }
    finally { await launched.close(); }
  }
  const failures = [];
  try {
    await Promise.all([mkdir(nativeDir), mkdir(fixtureDir)]);
    owned = await startOwnedPage();
    provider = await startProvider(providerExe, fixtureDir, signal);
    await Promise.all([
      makeExtension(candidate, stock, identity, owned, hostName),
      makeExtension(original, stock, identity, owned),
      makeExtension(wrongOrigin, stock, wrongIdentity, owned, hostName)
    ]);
    await assertNoAuthorityInPackages([candidate, original, wrongOrigin], providerFields.map(key => provider.info[key]));
    const broker = join(nativeDir, 'broker.exe');
    await copyFile(nativeExe, broker);
    const nativeInfo = Object.fromEntries(providerFields.filter(key => key !== 'controlKey').map(key => [key, provider.info[key]]));
    await writeFile(join(nativeDir, 'broker.json'), JSON.stringify({ ...nativeInfo, origin: identity.origin }), { flag: 'wx' });
    await writeFile(manifest, JSON.stringify({
      name: hostName, description: 'Disposable owned Windows agreement result fixture', path: broker,
      type: 'stdio', allowed_origins: [identity.origin]
    }), { flag: 'wx' });
    attemptedRegistration = true;
    assert.equal(await registry('Register', hostName, manifest), 'registered');

    browser = await launchOwnedBrowser(puppeteer, candidate, join(scratch.root, 'candidate-profile'), identity, signal);
    await expectProbe(browser, owned, owned.url, false, 'pending + forged display cache');
    t.diagnostic('pending + forged display cache: denied; protected calls=0');
    await control(provider.info, 'accept', signal);
    await check(original, 'stock-baseline-profile', identity, false, 'stock baseline with accepted provider and same input');
    await expectProbe(browser, owned, owned.url, true, 'accepted via owned provider');
    await check(original, 'stock-restored-profile', identity, false, 'stock restored with same accepted provider and input');
    t.diagnostic('same accepted provider + input: BASELINE allowed=false calls=0; MODIFIED allowed=true calls=1; ROLLBACK allowed=false calls=0');
    await expectProbe(browser, owned, owned.otherUrl, false, 'wrong owned page with current consent');
    await check(wrongOrigin, 'wrong-origin-profile', wrongIdentity, false, 'wrong extension origin with current consent');
    t.diagnostic('wrong page and wrong extension origin: denied; protected calls=0');
    await control(provider.info, 'rotate', signal);
    await expectProbe(browser, owned, owned.url, false, 'new release pending');
    t.diagnostic('release rotated: denied; protected calls=0');
    await control(provider.info, 'accept', signal);
    await expectProbe(browser, owned, owned.url, true, 'fresh consent to rotated release');
    await browser.close();
    browser = undefined;

    await unregister();
    await check(candidate, 'missing-host-profile', identity, false, 'native host removed with live accepted provider');
    t.diagnostic('native host removed, consent current: denied; protected calls=0');
    assert.deepEqual(await readStockFiles(dist), stock, 'ordinary build manifest and agreement files changed');
  } catch (error) {
    failures.push(error);
  } finally {
    for (const cleanup of [() => browser?.close(), unregister, () => provider?.close(), () => owned?.close(), scratch.remove]) {
      try { await cleanup(); }
      catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Owned T04 execution or cleanup failed');
  t.diagnostic('disposable profiles, native files, registry key and fixture processes cleaned; ordinary dist unchanged');
});
