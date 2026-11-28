import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { AGREEMENT_KIND, instrumentOwnedWorker } from './host-result.mjs';
import { diagnosticBrowserArgs } from '../../test-helpers/local-diagnostic-page.mjs';

export const shapeBase = 'https://127.0.0.1:1';
// Only the syntax of the stock request envelope is needed here, not a key hash.
export const shapeHash = 'b'.repeat(64);
export const ownedMessage = Object.freeze({ kind: AGREEMENT_KIND, operation: 'authorize', base: shapeBase, keyHash: shapeHash });

export function extensionIdentity() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const bytes = publicKey.export({ format: 'der', type: 'spki' });
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  return { id, key: bytes.toString('base64'), origin: 'chrome-extension://' + id + '/' };
}

export async function startOwnedPage() {
  let calls = 0;
  let origin;
  const active = '/owned-t04/active', offScope = '/owned-t04/off-scope', protectedPath = '/owned-t04/protected';
  const server = createServer((request, response) => {
    if (request.headers.host !== new URL(origin).host) {
      response.writeHead(400).end();
    } else if (request.method === 'GET' && [active, offScope].includes(request.url)) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Cache-Control': 'no-store'
      }).end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned ordinary agreement fixture</title><p>Loopback only.</p></html>');
    } else if (request.method === 'POST' && request.url === protectedPath
      && !request.headers.authorization && !request.headers.cookie && !request.headers['x-agreement-device']
      && request.headers.origin === origin
      && !request.headers['transfer-encoding'] && (request.headers['content-length'] ?? '0') === '0') {
      calls++;
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  return {
    origin, url: origin + active, otherUrl: origin + offScope, protectedPath,
    calls: () => calls,
    close() {
      return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  };
}

export async function readStockFiles(dist) {
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.background, { service_worker: 'extension-worker.js', type: 'module' });
  return {
    manifest,
    worker: await readFile(join(dist, 'extension-agreement-worker.js'), 'utf8'),
    core: await readFile(join(dist, 'extension-agreement-core.js'), 'utf8')
  };
}

export async function makeExtension(directory, stock, identity, owned, hostName) {
  await mkdir(directory);
  const match = 'http://127.0.0.1/*';
  const manifest = {
    manifest_version: 3,
    name: 'Owned ordinary Windows agreement test (unpacked fixture only)',
    version: stock.manifest.version,
    key: identity.key,
    permissions: hostName ? [...stock.manifest.permissions, 'nativeMessaging'] : stock.manifest.permissions,
    host_permissions: [match],
    background: { service_worker: 'fixture-worker.js', type: 'module' },
    content_scripts: [{ matches: [match], all_frames: false, world: 'ISOLATED', run_at: 'document_idle', js: ['probe.js'] }]
  };
  const scope = { hostName, url: owned.url, origin: owned.origin, shapeBase, shapeHash };
  const worker = hostName ? instrumentOwnedWorker(stock.worker, scope) : stock.worker;
  const probe = [
    'void (async () => {',
    '  let allowed = false, protectedOK = false;',
    '  try {',
    '    const reply = await chrome.runtime.sendMessage(' + JSON.stringify(ownedMessage) + ');',
    "    allowed = reply !== null && typeof reply === 'object' && !Array.isArray(reply)",
    "      && Object.keys(reply).length === 1 && Object.hasOwn(reply, 'allowed') && reply.allowed === true;",
    '    if (allowed) protectedOK = (await fetch(' + JSON.stringify(owned.protectedPath) + ', {',
    "      method: 'POST', credentials: 'omit', cache: 'no-store'",
    '    })).status === 204;',
    '  } catch { /* The probe never tries the protected operation after a channel failure. */ }',
    '  document.documentElement.dataset.ownedT04 = JSON.stringify({ allowed, protectedOK });',
    '})();'
  ].join('\n');
  const files = {
    'manifest.json': JSON.stringify(manifest),
    'extension-agreement-worker.js': worker,
    'extension-agreement-core.js': stock.core,
    'fixture-worker.js': "import { registerAgreement } from './extension-agreement-worker.js';\nregisterAgreement(chrome, " + JSON.stringify(shapeBase) + ");\n",
    'extension-agreement.html': '<!doctype html><title>Owned ordinary agreement settings fixture</title>',
    'probe.js': probe
  };
  if (hostName) files['host-result.js'] = await readFile(new URL('./host-result.mjs', import.meta.url), 'utf8');
  await Promise.all(Object.entries(files).map(([file, body]) => writeFile(join(directory, file), body, { flag: 'wx' })));
  if (!hostName) assert.equal(await readFile(join(directory, 'extension-agreement-worker.js'), 'utf8'), stock.worker);
}

export async function restoreExtension(candidate, original, restored) {
  const entries = await readdir(candidate, { withFileTypes: true });
  assert.ok(entries.every(entry => entry.isFile()), 'candidate package must be flat');
  await mkdir(restored);
  await Promise.all(entries.map(entry => copyFile(join(candidate, entry.name), join(restored, entry.name))));
  for (const name of ['manifest.json', 'extension-agreement-worker.js']) {
    const pristine = await readFile(join(original, name));
    const copy = join(restored, name);
    assert.ok(!(await readFile(copy)).equals(pristine), name + ': restored copy must start instrumented');
    await writeFile(copy, pristine);
  }
  await unlink(join(restored, 'host-result.js'));
  const names = (await readdir(original)).sort();
  assert.deepEqual((await readdir(restored)).sort(), names, 'restored package file inventory');
  for (const name of names) {
    const [pristine, after] = await Promise.all([readFile(join(original, name)), readFile(join(restored, name))]);
    assert.ok(after.equals(pristine), name + ': restored package bytes differ from original');
  }
}

export async function assertNoAuthorityInPackages(directories, forbidden) {
  for (const directory of directories) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(entry.isFile(), 'unexpected nested artifact in the owned test package');
      const body = await readFile(join(directory, entry.name), 'utf8');
      assert.ok(!forbidden.some(value => body.includes(value) || body.includes(JSON.stringify(value).slice(1, -1))),
        'owned test package must not contain provider configuration or credentials');
    }
  }
}

function browserEnvironment() {
  // Puppeteer is given a fresh profile. In particular, do not inherit the provider,
  // broker, workflow, or control environments into Chrome.
  const keys = new Set(['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATH', 'TEMP', 'TMP',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS']);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => keys.has(name.toUpperCase())));
}

export async function launchOwnedBrowser(puppeteer, directory, profile, identity, signal) {
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: [directory],
    userDataDir: profile,
    executablePath: process.env.CX_BROWSER_EXECUTABLE || puppeteer.executablePath(),
    env: browserEnvironment(),
    args: diagnosticBrowserArgs,
    timeout: 25_000,
    protocolTimeout: 15_000,
    signal
  });
  try {
    await browser.waitForTarget(target => target.type() === 'service_worker'
      && target.url() === identity.origin + 'fixture-worker.js', { timeout: 15_000 });
    const settings = await browser.newPage();
    try {
      await settings.goto(identity.origin + 'extension-agreement.html', { waitUntil: 'domcontentloaded', timeout: 12_000 });
      await settings.evaluate(async base => {
        await chrome.storage.local.set({
          'common.settings.tiku-adapter.baseurl': base,
          'common.settings.device-instance': 'synthetic-ordinary-host',
          'common.settings.extension-enabled': true
        });
      }, shapeBase);
      await settings.waitForFunction(async () => {
        const key = 'agreement.view.v1';
        return (await chrome.storage.local.get(key))[key]?.phase === 'host';
      }, { timeout: 5000 });
      assert.equal(await settings.evaluate(async () => {
        const key = 'agreement.view.v1';
        await chrome.storage.local.set({ [key]: { phase: 'accepted', acceptedVersion: 'untrusted-display-only' } });
        return (await chrome.storage.local.get(key))[key]?.phase;
      }), 'accepted', 'the negative fixture must actually seed a forged display phase');
      const localKeys = await settings.evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
      const inertSettings = new Set(['common.settings.tiku-adapter.baseurl', 'common.settings.device-instance',
        'common.settings.extension-enabled', 'agreement.view.v1', 'agreement.install.v1']);
      assert.ok(localKeys.every(key => inertSettings.has(key)), 'browser storage contains a non-fixture field');
    } finally {
      await settings.close();
    }
    return browser;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function expectProbe(browser, owned, url, allowed, label) {
  const seen = owned.calls();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-owned-t04'), { timeout: 8500 });
    const result = await page.$eval('html', html => JSON.parse(html.dataset.ownedT04));
    assert.deepEqual(result, { allowed, protectedOK: allowed }, label + ': authorization response');
    assert.equal(owned.calls() - seen, Number(allowed), label + ': protected loopback operation count');
  } finally {
    await page.close();
  }
}
