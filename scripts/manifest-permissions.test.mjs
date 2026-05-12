import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifestPath = resolve(process.cwd(), 'dist', 'manifest.json');
const localePath = resolve(process.cwd(), 'dist', '_locales', 'zh_CN', 'messages.json');
const expectedChaoxingHosts = [
  '*://*.chaoxing.com/*'
];

test('manifest declares storage permission for shared tiku config sync', async () => {
  const source = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(source);

  assert.deepEqual(manifest.permissions, ['storage']);
});

test('manifest uses zh_CN locale, chaoxing helper name, and chaoxing host permissions', async () => {
  const source = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(source);

  assert.equal(manifest.default_locale, 'zh_CN');
  assert.equal(manifest.name, '超星学习助手');
  assert.deepEqual(manifest.host_permissions, expectedChaoxingHosts);
});

test('manifest content script matches exactly the official chaoxing domain scope', async () => {
  const source = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(source);

  assert.deepEqual(manifest.content_scripts[0].matches, expectedChaoxingHosts);
  assert.equal(manifest.content_scripts[0].matches.includes('*://*.xueyinonline.com/*'), false);
  assert.equal(manifest.content_scripts[0].matches.includes('*://*.sslibrary.com/*'), false);
});

test('manifest does not inject into broad edu.cn or org.cn domains', async () => {
  const source = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(source);

  assert.equal(manifest.host_permissions.includes('*://*.edu.cn/*'), false);
  assert.equal(manifest.host_permissions.includes('*://*.org.cn/*'), false);
  assert.equal(manifest.content_scripts[0].matches.includes('*://*.edu.cn/*'), false);
  assert.equal(manifest.content_scripts[0].matches.includes('*://*.org.cn/*'), false);
});

test('dist includes the zh_CN locale messages required by the manifest locale setting', async () => {
  const source = await readFile(localePath, 'utf8');
  const messages = JSON.parse(source);

  assert.deepEqual(messages, {});
});
