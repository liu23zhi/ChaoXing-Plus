// Objective-answer accuracy benchmark.
//
// Compiles a resolver implementation (current working tree or a git worktree of
// an older commit) with the same TypeScript toolchain the tests use, runs the
// labeled fixture matrix, and reports per-case verdicts plus aggregate metrics.
//
// Usage:
//   node scripts/question-accuracy-benchmark.mjs --source-root . --label current
//   node scripts/question-accuracy-benchmark.mjs --source-root <worktree> --label baseline
// Options:
//   --source-root <path>  repository root that owns src/core/worker/question.resolver.ts
//   --label <name>        label recorded in the report
//   --json <path>         write machine-readable results
//   --verbose             print every case verdict

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './fixtures/question-accuracy-cases.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscEntry = resolve(repoRoot, 'node_modules', '@typescript/typescript6', 'bin', 'tsc6');

function readArgs(argv) {
  const parsed = { sourceRoot: repoRoot, label: 'current', json: undefined, verbose: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--source-root') parsed.sourceRoot = resolve(argv[++index]);
    else if (arg === '--label') parsed.label = argv[++index];
    else if (arg === '--json') parsed.json = resolve(argv[++index]);
    else if (arg === '--verbose') parsed.verbose = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

async function findFile(root, fileName) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(full, fileName);
      if (nested) return nested;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return undefined;
}

async function loadResolver(sourceRoot) {
  const outDir = await mkdtemp(join(tmpdir(), 'cx-accuracy-'));
  const source = resolve(sourceRoot, 'src', 'core', 'worker', 'question.resolver.ts');
  const result = spawnSync(process.execPath, [
    tscEntry,
    source,
    '--outDir', outDir,
    '--module', 'commonjs',
    '--target', 'es2022',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--ignoreConfig',
    '--ignoreDeprecations', '6.0'
  ], { encoding: 'utf8', cwd: repoRoot });

  if (result.status !== 0) {
    throw new Error(`TypeScript compile failed for ${source}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }

  const compiled = await findFile(outDir, 'question.resolver.js');
  if (!compiled) throw new Error(`Compiled resolver not found under ${outDir}`);
  await writeFile(join(outDir, 'package.json'), '{"type":"commonjs"}\n');

  const require = createRequire(import.meta.url);
  delete require.cache[compiled];
  return { mod: require(compiled), outDir };
}

// Minimal DOM stand-in: the resolver only reads innerText/textContent, walks to
// the option root with closest(), and looks up the visible label span.
function createOption({ label, text, dataValue }) {
  const labelText = label ? `${label}` : '';
  const innerText = labelText ? `${labelText}. ${text}`.trimEnd() : text;
  const labelElement = {
    textContent: labelText,
    innerText: labelText,
    getAttribute: (name) => (name === 'data' ? dataValue ?? labelText : null)
  };
  const root = {
    querySelector: (selector) => (labelText && String(selector).includes('num_option') ? labelElement : null),
    querySelectorAll: () => []
  };
  return {
    innerText,
    textContent: innerText,
    closest: () => root,
    querySelector: () => null,
    getAttribute: () => null
  };
}

function buildContext(kind, mode, options) {
  return {
    answerSeparators: ['#'],
    answerMatchMode: mode,
    elements: { options },
    root: {},
    searchInfos: [],
    type: kind
  };
}

function toInfos(answers) {
  return [{
    name: 'fixture',
    results: answers.map((group) => ({
      question: 'fixture',
      answer: group.join('#'),
      extra_data: {}
    }))
  }];
}

async function runCase(mod, testCase) {
  const options = testCase.options.map(createOption);
  const ctx = buildContext(testCase.kind, testCase.mode, options);
  const resolver = mod.createDefaultQuestionResolver(ctx);
  const applied = [];
  await resolver[testCase.kind](toInfos(testCase.answers), options, (_type, answer, option) => {
    const index = options.indexOf(option);
    applied.push({
      answer,
      label: index >= 0 ? testCase.options[index].label ?? `#${index}` : 'unknown',
      index
    });
  });
  return applied;
}

function judge(testCase, applied) {
  // Fill-in-the-blank resolution is scored on the literal text written into each
  // blank, in order; option labels are irrelevant there.
  const selectedValues = testCase.kind === 'completion'
    ? applied.map((item) => item.answer)
    : applied.map((item) => item.label);
  if (testCase.expect === 'abstain') {
    return {
      verdict: selectedValues.length === 0 ? 'correct' : 'wrong',
      expected: 'abstain',
      got: selectedValues
    };
  }
  if (selectedValues.length === 0) {
    return { verdict: 'abstained', expected: testCase.expect, got: [] };
  }
  const expected = testCase.kind === 'completion' ? [...testCase.expect] : [...testCase.expect].sort();
  const got = testCase.kind === 'completion' ? [...selectedValues] : [...selectedValues].sort();
  const match = expected.length === got.length && expected.every((label, index) => label === got[index]);
  return { verdict: match ? 'correct' : 'wrong', expected: testCase.expect, got: selectedValues };
}

function summarize(rows) {
  const totals = { cases: rows.length, correct: 0, wrong: 0, abstained: 0 };
  const byKind = new Map();
  for (const row of rows) {
    totals[row.verdict] += 1;
    const key = `${row.kind}/${row.mode}`;
    const bucket = byKind.get(key) ?? { cases: 0, correct: 0, wrong: 0, abstained: 0 };
    bucket.cases += 1;
    bucket[row.verdict] += 1;
    byKind.set(key, bucket);
  }
  const answerable = rows.filter((row) => row.expected !== 'abstain');
  const ambiguous = rows.filter((row) => row.expected === 'abstain');
  return {
    ...totals,
    answerable: {
      cases: answerable.length,
      correct: answerable.filter((row) => row.verdict === 'correct').length,
      wrong: answerable.filter((row) => row.verdict === 'wrong').length,
      abstained: answerable.filter((row) => row.verdict === 'abstained').length
    },
    ambiguous: {
      cases: ambiguous.length,
      correct: ambiguous.filter((row) => row.verdict === 'correct').length,
      wrong: ambiguous.filter((row) => row.verdict === 'wrong').length
    },
    byKind: Object.fromEntries(byKind)
  };
}

function percent(part, whole) {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const { mod, outDir } = await loadResolver(args.sourceRoot);
  const rows = [];
  try {
    for (const testCase of cases) {
      let applied;
      try {
        applied = await runCase(mod, testCase);
      } catch (error) {
        rows.push({
          id: testCase.id,
          kind: testCase.kind,
          mode: testCase.mode,
          note: testCase.note,
          expected: testCase.expect,
          got: [],
          verdict: 'wrong',
          error: String(error?.message ?? error)
        });
        continue;
      }
      const verdict = judge(testCase, applied);
      rows.push({ id: testCase.id, kind: testCase.kind, mode: testCase.mode, note: testCase.note, ...verdict });
    }
  } finally {
    await rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const summary = summarize(rows);
  const report = {
    label: args.label,
    sourceRoot: args.sourceRoot,
    generatedAt: new Date().toISOString(),
    summary,
    rows
  };

  console.log(`# label: ${args.label}`);
  console.log(`# source: ${args.sourceRoot}`);
  console.log('');
  console.log('| case | expected | got | verdict |');
  console.log('|---|---|---|---|');
  for (const row of rows) {
    if (!args.verbose && row.verdict === 'correct') continue;
    console.log(`| ${row.id} | ${JSON.stringify(row.expected)} | ${JSON.stringify(row.got)} | ${row.verdict} |`);
  }
  console.log('');
  console.log(`cases=${summary.cases} correct=${summary.correct} wrong=${summary.wrong} abstained=${summary.abstained}`);
  console.log(`answerable: ${summary.answerable.correct}/${summary.answerable.cases} correct (${percent(summary.answerable.correct, summary.answerable.cases)}), wrong ${summary.answerable.wrong}, abstained ${summary.answerable.abstained}`);
  console.log(`ambiguous: ${summary.ambiguous.correct}/${summary.ambiguous.cases} abstained as required (${percent(summary.ambiguous.correct, summary.ambiguous.cases)})`);
  for (const [key, bucket] of Object.entries(summary.byKind)) {
    console.log(`  ${key}: ${bucket.correct}/${bucket.cases} correct, ${bucket.wrong} wrong, ${bucket.abstained} abstained`);
  }

  if (args.json) {
    await mkdir(dirname(args.json), { recursive: true });
    await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\njson: ${args.json}`);
  }
}

await main();
