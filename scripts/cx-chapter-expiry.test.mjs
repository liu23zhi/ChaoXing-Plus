import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

const cxPath = resolve(process.cwd(), 'src', 'projects', 'cx.ts');

async function loadCxFunction(name, context) {
  const source = await readFile(cxPath, 'utf8');
  const parsed = ts.createSourceFile(cxPath, source, ts.ScriptTarget.Latest, true);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      declaration = node.getText(parsed);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(declaration, `Expected ${name} function in cx.ts`);
  const code = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInContext(code, context);
  return context[name];
}

function documentWithStatus(text) {
  const elements = text === undefined ? [] : [{ innerText: text, textContent: text }];
  return {
    querySelectorAll() {
      return elements;
    }
  };
}

test('chapter expiry marker is detected without treating a normal deadline as expired', async () => {
  const isChapterTestExpired = await loadCxFunction('isChapterTestExpired', vm.createContext({}));

  assert.equal(isChapterTestExpired(documentWithStatus('截止时间: 2026-10-12 18:41:00（已截止，不能作答）')), true);
  assert.equal(isChapterTestExpired(documentWithStatus('截止时间: 2026-12-12 18:41:00')), false);
  assert.equal(isChapterTestExpired(documentWithStatus(undefined)), false);
});

test('chapter answering checks expiry before processing questions and before submission', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.match(source, /const expired = isChapterTestExpired\(frameDocument\)/u);
  assert.match(source, /return \{ finished: true, expired: true \};/u);
  assert.match(source, /if \(isChapterTestExpired\(frameDocument\)\) \{/u);
  assert.match(source, /if \(isChapterTestExpired\(frameDocument\)\) \{[\s\S]*?btnBlueSubmit/u);
});

test('expired chapter jobs are skipped for the current scan so other task points can continue', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.match(source, /expired\?: boolean;/u);
  assert.match(source, /const alreadySearchedJob = searchedJobs\.find\(\(job\) => job\.mid === attachment\.property\.mid\);/u);
  assert.match(source, /if \(alreadySearchedJob\?\.expired\) \{[\s\S]*?visibleContentState: 'finished-job'/u);
  assert.match(source, /job\.expired = true;/u);
});

