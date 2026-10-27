import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');

test('compiled native bootstrap installs its embedded Swal style in the top document', {
  skip: !process.env.CX_NATIVE_INJECTION_EXE
}, async () => {
  const emitted = spawnSync(process.env.CX_NATIVE_INJECTION_EXE, ['--emit-page-setup'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  const commands = emitted.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(commands.length, 2, 'the native setup and actual embedded bootstrap must both be emitted');
  const browser = await puppeteer.launch({
    headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check']
  });
  try {
    const page = await browser.newPage();
    const session = await page.createCDPSession();
    for (const command of commands) {
      const result = await session.send(command.method, command.params);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    }
    const state = await page.evaluate(() => {
      const container = document.createElement('div');
      container.className = 'swal2-container';
      document.body.appendChild(container);
      const style = [...document.querySelectorAll('style')].find((node) => node.textContent.includes('.swal2-container'));
      return {
        hostReady: !!window.__CX_WIN_HOST__,
        topDocument: style?.ownerDocument === window.top.document,
        styleLength: style?.textContent.length || 0,
        position: getComputedStyle(container).position,
        noPanel: !document.getElementById('panel-common-work-results')
      };
    });
    assert.equal(state.hostReady, true);
    assert.equal(state.topDocument, true);
    assert.ok(state.styleLength > 20_000);
    assert.equal(state.position, 'fixed');
    assert.equal(state.noPanel, true);
    await session.detach();
  } finally {
    await browser.close();
  }
});
