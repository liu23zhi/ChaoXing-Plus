import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const buildScriptPath = resolve(process.cwd(), 'build.mjs');
const packageJsonPath = resolve(process.cwd(), 'package.json');
const packageLockPath = resolve(process.cwd(), 'package-lock.json');
const popupHtmlPath = resolve(process.cwd(), 'src', 'popup.html');
const popupJsPath = resolve(process.cwd(), 'src', 'popup.js');
const entryScriptPath = resolve(process.cwd(), 'src', 'extension-entry.js');

const expectedDescription = '给超星网站使用的自动学习与自动搜题扩展。';
const expectedHomepage = 'https://www.chaoxing.com/';
const expectedPopupDescription = '为 chaoxing.com 打造的自动学习与自动搜题扩展：视频自动播放、章节测验、作业与考试自动答题。';
const expectedExtensionEnabledKey = 'common.settings.extension-enabled';

test('build script declares extension icons, popup, and updated description', async () => {
  const source = await readFile(buildScriptPath, 'utf8');

  assert.equal(source.includes("description: '给超星网站使用的自动学习与自动搜题扩展。'"), true);
  assert.equal(source.includes("default_popup: 'popup.html'"), true);
  assert.equal(source.includes("'512': 'icon_512X512.png'"), true);
});

test('package versions follow the extension manifest version from build script', async () => {
  const source = await readFile(buildScriptPath, 'utf8');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const packageLock = JSON.parse(await readFile(packageLockPath, 'utf8'));
  const manifestVersion = source.match(/version: '([^']+)'/)?.[1];

  assert.equal(typeof manifestVersion, 'string');
  const expectedPackageVersion = manifestVersion.split('.').concat(['0', '0']).slice(0, 3).join('.');
  assert.equal(packageJson.version, expectedPackageVersion);
  assert.equal(packageLock.version, expectedPackageVersion);
  assert.equal(packageLock.packages[''].version, expectedPackageVersion);
});

test('popup page introduces the extension for Chaoxing users', async () => {
  const source = await readFile(popupHtmlPath, 'utf8');

  assert.equal(source.includes('<title>超星学习助手</title>'), true);
  assert.equal(source.includes('<div class="title">超星学习助手</div>'), true);
  assert.equal(source.includes(expectedPopupDescription), true);
  assert.equal(source.includes('打开超星官网'), true);
  // 优化前的文案不允许回归
  assert.equal(source.includes('这是一个给 chaoxing.com 官方站点使用的自动学习 / 自动搜题扩展。'), false);
  assert.equal(source.includes('打开 chaoxing.com 官网'), false);
});

test('popup page ships an enable and disable switch for the whole extension', async () => {
  const source = await readFile(popupHtmlPath, 'utf8');

  assert.equal(source.includes('<input id="extension-enabled" type="checkbox" role="switch" checked />'), true);
  assert.equal(source.includes('<span class="switch-label">启用扩展</span>'), true);
  assert.equal(source.includes('<span class="switch-state" id="extension-enabled-state">已启用</span>'), true);
  assert.equal(source.includes('关闭后超星页面不再运行自动学习与答题；切换后已打开的页面会自动刷新。'), true);
});

test('popup switch persists the shared extension-enabled key that gates the content script', async () => {
  const popupSource = await readFile(popupJsPath, 'utf8');
  const entrySource = await readFile(entryScriptPath, 'utf8');

  const popupKey = popupSource.match(/const extensionEnabledKey = '([^']+)'/)?.[1];
  const entryKey = entrySource.match(/const extensionEnabledKey = '([^']+)'/)?.[1];

  assert.equal(popupKey, expectedExtensionEnabledKey);
  assert.equal(entryKey, popupKey);
  assert.equal(popupSource.includes('chrome.storage.local.get(extensionEnabledKey, (result) => {'), true);
  assert.equal(popupSource.includes('renderExtensionEnabled(result?.[extensionEnabledKey] !== false);'), true);
  assert.equal(popupSource.includes('chrome.storage.local.set({ [extensionEnabledKey]: enabled });'), true);
  assert.equal(popupSource.includes("enabledState.textContent = enabled ? '已启用' : '已禁用';"), true);
});

test('popup script opens the Chaoxing homepage', async () => {
  const source = await readFile(popupJsPath, 'utf8');

  assert.equal(source.includes(expectedHomepage), true);
  assert.equal(source.includes('chrome.tabs.create'), true);
});
