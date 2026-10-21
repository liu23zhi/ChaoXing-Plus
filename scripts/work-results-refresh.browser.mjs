import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');

async function readDeclaration(path, name) {
  const source = await readFile(path, 'utf8');
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let found;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name) {
      found = node.getText(parsed);
    } else if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) {
      found = `const ${node.getText(parsed)};`;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(found, `Expected ${name} declaration in ${path}`);
  return found.replace(/^export /, '');
}

test('browser panel shows the active question as searching before its answer search returns', { timeout: 20000 }, async () => {
  const declarations = [
    await readDeclaration('src/core/utils/event.ts', 'CommonEventEmitter'),
    await readDeclaration('src/core/worker/interface.ts', 'DEFAULT_WORKER_THREAD_COUNT'),
    await readDeclaration('src/core/worker/interface.ts', 'resolveWorkerThreadCount'),
    await readDeclaration('src/core/worker/worker.ts', 'OCSWorker'),
    await readDeclaration('src/utils/work.ts', 'simplifyWorkResult'),
    await readDeclaration('src/projects/work-results-status.ts', 'formatWorkResultStatus'),
    `const domSearchAll = (_elements, root) => ({ title: [root.querySelector('.question-title')], options: [] });`,
    `const AnswerWrapperHandlerConfig = { timeout_seconds: 2 };`,
    `window.startAnswerFlow = () => {
      const panel = document.querySelector('#results');
      const render = (results) => {
        const items = simplifyWorkResult(results, (titles) => titles.map((title) => title?.textContent ?? '').join(' '));
        panel.replaceChildren(...items.map((item) => {
          const row = document.createElement('article');
          row.dataset.question = item.question;
          const title = document.createElement('h2');
          title.textContent = item.question;
          const status = document.createElement('span');
          status.dataset.status = 'true';
          status.textContent = formatWorkResultStatus(item);
          row.append(title, status);
          return row;
        }));
      };
      const worker = new OCSWorker({
        root: Array.from(document.querySelectorAll('.question')),
        elements: {},
        thread: 1,
        onResultsInitialized: render,
        onResultsUpdate: (_current, _index, results) => render(results),
        answerer: async () => {
          const infos = await new Promise((resolve) => { window.releaseSearch = () => resolve([
            { name: 'fixture', results: [{ question: '题目甲', answer: '答案甲' }] }
          ]); });
          window.searchReturned = true;
          return infos;
        },
        work: async () => {
          await new Promise((resolve) => { window.releaseAnswer = resolve; });
          return { finish: true };
        }
      });
      window.searchReturned = false;
      window.workerDone = false;
      window.workerPromise = worker.doWork().then(() => { window.workerDone = true; });
    };`
  ].join('\n');
  const runtime = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(6000);
    await page.setContent(`<!doctype html><html><body>
      <main id="results"></main>
      <section class="question"><h2 class="question-title">题目甲</h2></section>
    </body></html>`);
    await page.addScriptTag({ content: runtime });
    await page.evaluate(() => window.startAnswerFlow());

    await page.waitForFunction(() => document.querySelector('[data-status="true"]')?.textContent === '搜题中');
    const pendingSearch = await page.evaluate(() => ({
      question: document.querySelector('[data-question] h2')?.textContent,
      status: document.querySelector('[data-status="true"]')?.textContent,
      searchReturned: window.searchReturned
    }));
    assert.deepEqual(pendingSearch, {
      question: '题目甲',
      status: '搜题中',
      searchReturned: false
    });

    await page.evaluate(() => window.releaseSearch());
    await page.waitForFunction(() => document.querySelector('[data-status="true"]')?.textContent === '等待答题中');
    await page.waitForFunction(() => typeof window.releaseAnswer === 'function');
    await page.evaluate(() => window.releaseAnswer());
    await page.waitForFunction(() => window.workerDone === true);
    assert.equal(await page.$eval('[data-status="true"]', (element) => element.textContent), '已完成');
  } finally {
    await browser.close();
  }
});
