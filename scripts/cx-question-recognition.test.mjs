import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const cxPath = resolveTestPath('src', 'projects', 'cx.ts');

test('work and exam recognition chooses current singleQuesId roots and falls back to questionLi', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('function queryWorkOrExamQuestionRoots('), true);
  assert.match(source, /querySelectorAll<HTMLElement>\('\.singleQuesId'\)/u);
  assert.match(source, /querySelectorAll<HTMLElement>\('\.questionLi'\)/u);
  assert.equal(source.includes('const workOrExamQuestionSelector = getWorkOrExamQuestionSelector(document);'), true);
  assert.equal(source.includes('createWorkOrExamWorker(workOrExamQuestionSelector'), true);
  assert.equal(source.includes("closest('.singleQuesId, .questionLi')"), true);
});

test('work and exam retries and preview status use the same version-aware roots', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('const liveRoots = () => queryWorkOrExamQuestionRoots();'), true);
  assert.equal(source.includes('const currentRoot = queryWorkOrExamQuestionRoots()[currentIndex];'), true);
  assert.equal(source.includes('questionCount: queryWorkOrExamQuestionRoots().length'), true);
  assert.equal(source.includes('hasCurrentPage: () => queryWorkOrExamQuestionRoots().length > 0'), true);
});

test('grading evidence upload is gated to completed chapter reviews and homework grading pages', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.match(source, /if \(chapterTest && chapterStatusComplete\) \{[\s\S]{0,320}uploadVisibleCorrectAnswerEvidence/u);
  assert.match(source, /workReview:\s*\{[\s\S]{0,160}matches:\s*\[\['作业批阅页面', '\/work\/selectWorkQuestionYiPiYue'\]\]/u);
  assert.match(await readFile(resolveTestPath('src', 'utils', 'work.ts'), 'utf8'), /querySelectorAll<HTMLElement>\('\.rightAnswerContent'\)/u);
  assert.match(source, /if \(alreadySearched\)[\s\S]{0,60}logDebug/u);
  assert.doesNotMatch(source, /isGradedChapterResult/u);
  assert.doesNotMatch(source, /uploadWorkOrExamResults[\s\S]{0,300}uploadVisibleCorrectAnswerEvidence/u);
});
