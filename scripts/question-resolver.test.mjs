import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const resolverSourcePath = resolve(process.cwd(), 'src', 'core', 'worker', 'question.resolver.ts');
const outDir = resolve(process.cwd(), '.tmp-tests-cjs');
const resolverModulePath = resolve(outDir, 'worker', 'question.resolver.js');
const tscCliPath = resolve(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

async function compileResolverHelper() {
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}\n');
  await execFileAsync(process.execPath, [
    tscCliPath,
    resolverSourcePath,
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck'
  ]);
}

async function loadResolverModule() {
  await compileResolverHelper();
  const require = createRequire(import.meta.url);
  delete require.cache[resolverModulePath];
  return require(resolverModulePath);
}

function createOption(text) {
  return {
    innerText: text,
    textContent: text
  };
}

test('multiple choice similar matching does not select more options than returned answers', async () => {
  const mod = await loadResolverModule();
  const selected = [];
  const options = [
    createOption('ABCDE'),
    createOption('WXYZ'),
    createOption('ABCDEF')
  ];
  const ctx = {
    answerSeparators: ['#'],
    answerMatchMode: 'similar',
    elements: { options },
    root: {},
    searchInfos: [],
    type: 'multiple'
  };

  const resolver = mod.createDefaultQuestionResolver(ctx);
  const result = await resolver.multiple(
    [
      {
        name: 'fixture',
        results: [{ question: '题目', answer: 'ABCDE#WXYZ', extra_data: {} }]
      }
    ],
    options,
    (_type, _answer, option) => {
      selected.push(option.innerText);
    }
  );

  assert.equal(result.finish, true);
  assert.deepEqual(selected, ['ABCDE', 'WXYZ']);
});
