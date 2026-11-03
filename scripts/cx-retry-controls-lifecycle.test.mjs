import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cxProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'cx.ts');

async function readCxSource() {
  return (await readFile(cxProjectPath, 'utf8')).replace(/\r\n/g, '\n');
}

test('cx keeps retry controls after normal chapter, preview, and stepwise completion', async () => {
  const source = await readCxSource();

  const chapterStart = source.indexOf('  async chapter(');
  const previewStart = source.indexOf('  } else {\n    const getNextBtn');
  assert.ok(chapterStart >= 0);
  assert.ok(previewStart > chapterStart);
  const chapter = source.slice(chapterStart, source.indexOf('  async readPPTWithAudio(', chapterStart));
  const workOrExam = source.slice(previewStart, source.indexOf('\n  }\n\n  return worker;', previewStart));

  assert.doesNotMatch(chapter, /finally\s*\{\s*clearRuntimeControls\(\);/u);
  assert.doesNotMatch(workOrExam, /\}\)\(\)\.finally\(clearRuntimeControls\);/u);
  assert.doesNotMatch(workOrExam, /untrackTikuAdapterWorker\(worker\);\s+clearRuntimeControls\(\);\s+\}\);/u);
  assert.match(chapter, /worker\.on\('close', clearRuntimeControls\);/u);
  assert.match(workOrExam, /worker\.on\('close', clearRuntimeControls\);/u);
});

test('cx exposes retry controls for stepwise questions and tracks question navigation', async () => {
  const source = await readCxSource();
  const stepStart = source.indexOf('  } else {\n    const getNextBtn');
  const stepEnd = source.indexOf('\n  }\n\n  return worker;', stepStart);
  assert.ok(stepStart >= 0 && stepEnd > stepStart);
  const stepwise = source.slice(stepStart, stepEnd);

  assert.doesNotMatch(stepwise, /canRetryQuestion: \(\) => false/u);
  assert.doesNotMatch(stepwise, /retryQuestion: async \(\) => undefined/u);
  assert.match(stepwise, /canRetryQuestion: \(index\) =>/u);
  assert.match(stepwise, /retryQuestion: \(index, resetAnswer\) => retryStepwiseQuestion\(index, false, resetAnswer\)/u);
  assert.match(stepwise, /navigateWorkOrExamQuestion\(direction\)/u);
  assert.match(stepwise, /createWorkOrExamWorker\(\[root\], \{[\s\S]*?shouldSkipCacheForManualRetry\(initialResult\)/u);
  assert.match(stepwise, /stepwiseRetryInFlight = false/u);
  assert.match(stepwise, /retrying: true/u);
  assert.match(stepwise, /retrying: false/u);
});
