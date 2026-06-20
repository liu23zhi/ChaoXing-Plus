import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const buildScriptPath = resolve(process.cwd(), 'build.mjs');
const packageJsonPath = resolve(process.cwd(), 'package.json');
const packageLockPath = resolve(process.cwd(), 'package-lock.json');
const popupHtmlPath = resolve(process.cwd(), 'src', 'popup.html');
const popupJsPath = resolve(process.cwd(), 'src', 'popup.js');

const expectedDescription = '给超星网站使用的自动学习与自动搜题扩展。';
const expectedHomepage = 'https://www.chaoxing.com/';

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
  assert.equal(packageJson.version, manifestVersion);
  assert.equal(packageLock.version, manifestVersion);
  assert.equal(packageLock.packages[''].version, manifestVersion);
});

test('popup page introduces the extension for Chaoxing users', async () => {
  const source = await readFile(popupHtmlPath, 'utf8');

  assert.equal(source.includes('给 chaoxing.com 官方站点使用的自动学习 / 自动搜题扩展'), true);
  assert.equal(source.includes('打开 chaoxing.com 官网'), true);
});

test('popup script opens the Chaoxing homepage', async () => {
  const source = await readFile(popupJsPath, 'utf8');

  assert.equal(source.includes(expectedHomepage), true);
  assert.equal(source.includes('chrome.tabs.create'), true);
});
