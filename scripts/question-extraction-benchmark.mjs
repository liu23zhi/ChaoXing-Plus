// Question-extraction benchmark: image evidence carried into the search prompt.
//
// Compiles src/utils/work.ts from a given repository worktree with `--noResolve`
// (imports are stubbed), runs `optimizationElementWithImage` against a minimal
// fake DOM, and checks the evidence emitted for each image: preferred URL
// attribute, absolute URL, alt transcription, per-image order, one node per
// image, and idempotence on repeated extraction.
//
// Usage:
//   node scripts/question-extraction-benchmark.mjs --source-root . --label current
//   node scripts/question-extraction-benchmark.mjs --source-root <worktree> --label baseline
// Options:
//   --source-root <path>  repository root owning src/utils/work.ts
//   --label <name>        label recorded in the report
//   --json <path>         write machine-readable results
//   --verbose             print every case

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractionCases } from './fixtures/question-extraction-cases.mjs';

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

// --- minimal DOM -----------------------------------------------------------

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this._text = undefined;
    this._innerText = undefined;
    this.currentSrc = '';
  }

  get baseURI() {
    return this.ownerDocument?.baseURI ?? 'https://fixture.invalid/';
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  after(node) {
    const parent = this.parentNode;
    if (!parent) return;
    node.parentNode = parent;
    const index = parent.children.indexOf(this);
    parent.children.splice(index + 1, 0, node);
  }

  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentNode = null;
  }

  get src() {
    return this.getAttribute('src') ?? '';
  }

  get textContent() {
    if (this._text !== undefined) return this._text;
    if (this._innerText !== undefined) return this._innerText;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
  }

  get innerText() {
    if (this._innerText !== undefined) return this._innerText;
    if (this._text !== undefined) return this._text;
    return this.children.map((child) => child.innerText).join('');
  }

  set innerText(value) {
    this._innerText = String(value);
  }

  cloneNode(deep) {
    const clone = new FakeElement(this.tagName, this.ownerDocument);
    for (const [name, value] of this.attributes) clone.setAttribute(name, value);
    clone.style = { ...this.style };
    clone._text = this._text;
    clone._innerText = this._innerText;
    clone.currentSrc = this.currentSrc;
    if (deep) for (const child of this.children) clone.appendChild(child.cloneNode(true));
    return clone;
  }

  querySelectorAll(selector) {
    const matches = [];
    const wanted = String(selector).trim();
    const visit = (node) => {
      for (const child of node.children) {
        const tagMatch = /^[a-zA-Z]+$/.test(wanted) && child.tagName === wanted.toUpperCase();
        const attrMatch = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(wanted)
          && child.attributes.has(RegExp.$1)
          && (RegExp.$2 === undefined || child.attributes.get(RegExp.$1) === RegExp.$2);
        if (tagMatch || attrMatch) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

class FakeDocument {
  constructor(baseURI) {
    this.baseURI = baseURI;
    this.documentElement = new FakeElement('html', this);
    this.body = this.documentElement.appendChild(new FakeElement('body', this));
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

function buildRoot(testCase) {
  const document = new FakeDocument(testCase.baseURI ?? 'https://mooc1.chaoxing.com/');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const images = [];
  for (const image of testCase.images) {
    const img = document.createElement('img');
    if (image.src !== undefined) img.setAttribute('src', image.src);
    if (image.dataOriginal !== undefined) img.setAttribute('data-original', image.dataOriginal);
    if (image.dataSrc !== undefined) img.setAttribute('data-src', image.dataSrc);
    if (image.alt !== undefined) img.setAttribute('alt', image.alt);
    img.currentSrc = image.currentSrc ?? '';
    root.appendChild(img);
    images.push(img);
  }
  return { document, root, images };
}

function readEvidence(root) {
  return root.children
    .filter((child) => child.tagName === 'SPAN' && child.style?.fontSize === '0px')
    .map((child) => String(child.textContent ?? child.innerText ?? '').trim());
}

// --- harness ---------------------------------------------------------------

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

async function writeStub(outDir, relativePath, exportName) {
  const target = join(outDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  const body = exportName === 'runtimeStore'
    ? 'exports.runtimeStore = { get() { return undefined; }, set() {}, onChange() {} };\n'
    : exportName === '$modal'
      ? 'exports.$modal = async () => undefined;\n'
      : [
        'exports.DEFAULT_TIKU_BASE_URL = "https://tiku.example/";',
        'exports.TIKU_ADAPTER_BASEURL_KEY = "tikuAdapterBaseUrl";',
        'exports.TIKU_ADAPTER_KEY_KEY = "tikuAdapterKey";',
        'exports.getTikuAdapterConfigProblem = () => undefined;',
        'exports.resolveTikuAdapterBaseUrl = () => "https://tiku.example/";',
        ''
      ].join('\n');
  await writeFile(target, body, 'utf8');
}

async function loadWorkModule(sourceRoot) {
  const outDir = await mkdtemp(join(tmpdir(), 'cx-extraction-'));
  const source = resolve(sourceRoot, 'src', 'utils', 'work.ts');
  const result = spawnSync(process.execPath, [
    tscEntry,
    source,
    '--outDir', outDir,
    '--rootDir', resolve(sourceRoot, 'src'),
    '--module', 'commonjs',
    '--target', 'es2022',
    '--noResolve',
    '--noEmitOnError', 'false',
    '--skipLibCheck',
    '--ignoreConfig',
    '--ignoreDeprecations', '6.0'
  ], { encoding: 'utf8', cwd: repoRoot });

  // `--noResolve` intentionally produces TS2307 for the stubbed imports; only a
  // missing emit is fatal.
  const compiledOut = await findFile(outDir, 'work.js');
  if (!compiledOut) {
    throw new Error(`TypeScript compile failed for ${source}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }

  await writeStub(outDir, join('runtime', 'index.js'), 'runtimeStore');
  await writeStub(outDir, join('runtime', 'message.js'), '$modal');
  await writeStub(outDir, join('projects', 'tiku-adapter-config.js'), 'config');
  await writeFile(join(outDir, 'package.json'), '{"type":"commonjs"}\n');

  const compiled = await findFile(outDir, 'work.js');
  if (!compiled) throw new Error(`Compiled work module not found under ${outDir}`);
  const require = createRequire(import.meta.url);
  delete require.cache[compiled];
  return { mod: require(compiled), outDir };
}

function judge(testCase, evidence) {
  const expected = testCase.expect;
  const same = expected.length === evidence.length && expected.every((value, index) => value === evidence[index]);
  return { verdict: same ? 'correct' : 'wrong', expected, got: evidence };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const { mod, outDir } = await loadWorkModule(args.sourceRoot);
  const rows = [];
  const previousDocument = globalThis.document;
  try {
    for (const testCase of extractionCases) {
      const { document, root } = buildRoot(testCase);
      // The pre-change implementation reaches for the global `document`.
      globalThis.document = document;
      let evidence;
      try {
        for (let run = 1; run <= (testCase.extractTwice ? 2 : 1); run++) {
          mod.optimizationElementWithImage(root, false);
        }
        evidence = readEvidence(root);
      } catch (error) {
        evidence = [`<error: ${error?.message ?? error}>`];
      }
      rows.push({ id: testCase.id, note: testCase.note, ...judge(testCase, evidence) });
    }
  } finally {
    globalThis.document = previousDocument;
    await rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const correct = rows.filter((row) => row.verdict === 'correct').length;
  const report = {
    label: args.label,
    sourceRoot: args.sourceRoot,
    generatedAt: new Date().toISOString(),
    summary: { cases: rows.length, correct, wrong: rows.length - correct },
    rows
  };

  console.log(`# label: ${args.label}`);
  console.log(`# source: ${args.sourceRoot}`);
  console.log('');
  console.log('| case | expected evidence | got | verdict |');
  console.log('|---|---|---|---|');
  for (const row of rows) {
    if (!args.verbose && row.verdict === 'correct') continue;
    console.log(`| ${row.id} | ${JSON.stringify(row.expected)} | ${JSON.stringify(row.got)} | ${row.verdict} |`);
  }
  console.log('');
  console.log(`cases=${rows.length} correct=${correct} wrong=${rows.length - correct}`);

  if (args.json) {
    await mkdir(dirname(args.json), { recursive: true });
    await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`json: ${args.json}`);
  }
}

await main();
