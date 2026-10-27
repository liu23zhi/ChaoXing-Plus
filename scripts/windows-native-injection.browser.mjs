import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const executable = process.env.CX_NATIVE_INJECTION_EXE;
const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
let browser;
let server;
let port;

before(async () => {
  if (!executable) return;
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/csp') response.setHeader('Content-Security-Policy', "script-src 'none'");
    response.end('<!doctype html><html><head><title>Native injection fixture</title></head><body>Local native script fixture</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server']
  });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

function nativeScriptCommand(source) {
  const result = spawnSync(executable, ['--emit-script-expression', source], {
    encoding: 'utf8', timeout: 5000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const command = JSON.parse(result.stdout);
  assert.equal(command.method, 'Runtime.evaluate');
  assert.equal(command.params.returnByValue, true);
  return command;
}

for (const fixture of [
  {
    name: 'acknowledges actual execution and removes its temporary script and marker',
    source: "window.__nativeFixtureMethod=document.currentScript?'script':'runtime';window.__nativeFixtureText='中文';// final comment",
    route: '/', expected: true
  },
  { name: 'rejects a DOM script blocked by CSP', source: 'window.__nativeFixtureMethod="script";', route: '/csp', expected: false },
  { name: 'rejects a script that throws at runtime', source: 'throw new Error("native fixture error");', route: '/', expected: false },
  { name: 'rejects a script with a syntax error', source: 'var = ;', route: '/', expected: false },
  { name: 'rejects a document without a script mounting node', source: 'window.__nativeFixtureMethod="script";', route: '/', removeRoot: true, expected: false }
]) {
  test(`native generated expression ${fixture.name}`, { skip: !executable }, async () => {
    const page = await browser.newPage();
    const client = await page.createCDPSession();
    try {
      await page.goto(`http://127.0.0.1:${port}${fixture.route}`);
      if (fixture.removeRoot) await page.evaluate(() => document.documentElement.remove());
      const command = nativeScriptCommand(fixture.source);
      const result = await client.send(command.method, command.params);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      assert.equal(result.result.value, fixture.expected);
      assert.equal(await page.$$eval('script', (scripts) => scripts.length), 0);
      assert.deepEqual(await page.evaluate(() => Object.keys(window).filter((key) => key.startsWith('__CX_WIN_NATIVE_SCRIPT_'))), []);
      if (fixture.expected) {
        assert.equal(await page.evaluate(() => window.__nativeFixtureMethod), 'script');
        assert.equal(await page.evaluate(() => window.__nativeFixtureText), '中文');
      } else if (fixture.route === '/csp') {
        assert.equal(await page.evaluate(() => window.__nativeFixtureMethod), undefined);
      }
    } finally {
      await client.detach();
      await page.close();
    }
  });
}
