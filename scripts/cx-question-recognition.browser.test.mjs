import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import ts from '@typescript/typescript6';
import { build } from 'vite';

let browser;
let runtime;
let resolverBundle;

before(async () => {
  const declarations = async (path, names) => {
    const source = await readFile(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    return ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
      .map((node) => node.getText(ast).replace(/^export /u, '')).join('\n');
  };
  runtime = ts.transpileModule([
    await declarations('src/projects/cx.ts', ['queryWorkOrExamQuestionRoots', 'getWorkOrExamQuestionSelector']),
    await declarations('src/utils/work.ts', ['optimizationElementWithImage', 'extractQuestionImageEvidence', 'extractExplicitCorrectAnswerEvidence', 'inferQuestionTypeFromOptionElements', 'extractQuestionOptionTexts', 'simplifyWorkResult'])
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const built = await build({ configFile: false, logLevel: 'silent', build: {
    write: false, target: 'es2020', minify: false,
    lib: { entry: 'src/core/index.ts', name: 'QuestionResolverFixture', formats: ['iife'] }
  } });
  resolverBundle = (Array.isArray(built) ? built[0] : built).output.find((entry) => entry.type === 'chunk' && entry.isEntry).code;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'] });
});

after(async () => { await browser?.close(); });

async function withPage(html, run) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (request) => request.abort());
    await page.setContent(`<base href="https://fixture.invalid/course/">${html}`);
    await page.addScriptTag({ content: runtime });
    await page.addScriptTag({ content: resolverBundle });
    return await run(page);
  } finally { await page.close(); }
}

test('real DOM selects current roots once and falls back to legacy roots', async () => {
  await withPage('<div class="questionLi"><div class="singleQuesId" id="q1"></div></div><div class="singleQuesId" id="q2"></div>', async (page) => {
    assert.deepEqual(await page.evaluate(() => ({ selector: getWorkOrExamQuestionSelector(),
      ids: queryWorkOrExamQuestionRoots().map((root) => root.id) })), { selector: '.singleQuesId', ids: ['q1', 'q2'] });
    await page.setContent('<div class="questionLi" id="old1"></div><div class="questionLi" id="old2"></div>');
    assert.deepEqual(await page.evaluate(() => ({ selector: getWorkOrExamQuestionSelector(),
      ids: queryWorkOrExamQuestionRoots().map((root) => root.id) })), { selector: '.questionLi', ids: ['old1', 'old2'] });
  });
});

test('visible sibling labels take priority over English content and remapped platform values', async () => {
  await withPage(`<div class="singleQuesId"><ul>
    <li class="answerBg" data="A"><span class="num_option">B</span><div class="answer_p">A variable</div></li>
    <li class="answerBg" data="B"><span class="num_option">A</span><div class="answer_p">Beta</div></li>
    </ul></div>`, async (page) => {
    const result = await page.evaluate(async () => {
      const options = [...document.querySelectorAll('.answer_p')];
      const selected = [];
      const result = await QuestionResolverFixture.createDefaultQuestionResolver({ answerMatchMode: 'exact' })
        .single([{ results: [{ answer: 'A' }] }], options, (_type, _answer, option) => {
          selected.push({ text: option.innerText, value: option.closest('.answerBg').getAttribute('data') });
        });
      return { finish: result.finish, selected };
    });
    assert.deepEqual(result, { finish: true, selected: [{ text: 'Beta', value: 'B' }] });
  });
});

test('image evidence uses lazy sources and alt in DOM order, stays idempotent and uses ownerDocument', async () => {
  await withPage(`<div id="stem">题干<img src="placeholder.png" data-original="/img/stem.png" alt="x² + y²">结束</div>
    <div id="option"><img src="placeholder.png" data-src="/img/choice.png" alt="α"></div>`, async (page) => {
    const result = await page.evaluate(() => {
      const root = document.querySelector('#stem');
      const first = optimizationElementWithImage(root).innerText;
      const second = optimizationElementWithImage(root).innerText;
      const cloned = optimizationElementWithImage(root, true).innerText;
      const option = optimizationElementWithImage(document.querySelector('#option'), true).innerText;
      return { first, second, cloned, option, markers: root.querySelectorAll('[data-cx-image-reference]').length };
    });
    assert.equal(result.first, result.second);
    assert.equal(result.first, result.cloned);
    assert.match(result.first, /题干.*x² \+ y².*https:\/\/fixture\.invalid\/img\/stem\.png.*结束/su);
    assert.equal(result.first.includes('placeholder.png'), false);
    assert.match(result.option, /α.*https:\/\/fixture\.invalid\/img\/choice\.png/su);
    assert.equal(result.markers, 1);
  });
});

test('simplified results retain independent search snapshots after DOM changes', async () => {
  await withPage('<div id="a">new display</div>', async (page) => {
    const result = await page.evaluate(() => {
      const snapshots = [{ type: 'single', options: ['A\nline', 'B'] }, { type: 'unknown', options: ['C', 'D'] }];
      return simplifyWorkResult(snapshots.map((searchIdentity) => ({ requested: true, resolved: true,
        ctx: { type: undefined, searchIdentity, elements: { title: [], options: [document.querySelector('#a')] } }
      }))).map((item) => item.searchIdentity);
    });
    assert.deepEqual(result, [{ type: 'single', options: ['A\nline', 'B'] }, { type: 'unknown', options: ['C', 'D'] }]);
  });
});

test('image evidence resolves relative URLs in the iframe owner document', async () => {
  await withPage('<iframe></iframe>', async (page) => {
    const result = await page.evaluate(() => {
      const doc = document.querySelector('iframe').contentDocument;
      doc.open();
      doc.write('<base href="https://iframe.invalid/assets/"><div id="stem"><img data-src="formula.png" alt="a+b"></div>');
      doc.close();
      const root = doc.querySelector('#stem');
      const extracted = optimizationElementWithImage(root);
      return { text: extracted.innerText,
        ownerMatches: extracted.querySelector('[data-cx-image-reference]').ownerDocument === doc };
    });
    assert.match(result.text, /a\+b.*https:\/\/iframe\.invalid\/assets\/formula\.png/su);
    assert.equal(result.ownerMatches, true);
  });
});

test('question image evidence preserves ordered stem and option images with lazy URLs and alt text', async () => {
  await withPage(`<div id="stem"><img data-src="/a.png" alt="formula"><img src="placeholder.png" data-original="/b.png" alt="diagram"></div>
    <div class="option"><img data-src="/c.png" alt="choice"></div>`, async (page) => {
    const result = await page.evaluate(() => extractQuestionImageEvidence(
      [document.querySelector('#stem')], [...document.querySelectorAll('.option')]
    ));
    assert.deepEqual(result, {
      stemImages: [
        { url: 'https://fixture.invalid/a.png', alt: 'formula', index: 0 },
        { url: 'https://fixture.invalid/b.png', alt: 'diagram', index: 1 }
      ],
      optionImages: [{ url: 'https://fixture.invalid/c.png', alt: 'choice', index: 0 }]
    });
  });
});

test('conservative type inference preserves unknown while recognizing explicit choice and text controls', async () => {
  await withPage(`<div id="single"><label><input type="radio">A</label><label><input type="radio">B</label><label><input type="radio">C</label></div>
    <div id="judgement"><label><input type="radio">正确</label><label><input type="radio">错误</label></div>
    <div id="ambiguous"><label><input type="radio">选项甲</label><label><input type="radio">选项乙</label></div>
    <div id="multiple"><label><input type="checkbox">甲</label></div>
    <div id="fill"><textarea></textarea></div>`, async (page) => {
    const types = await page.evaluate(() => [
      inferQuestionTypeFromOptionElements([...document.querySelectorAll('#single label')]),
      inferQuestionTypeFromOptionElements([...document.querySelectorAll('#judgement label')]),
      inferQuestionTypeFromOptionElements([...document.querySelectorAll('#ambiguous label')]),
      inferQuestionTypeFromOptionElements([...document.querySelectorAll('#multiple label')]),
      inferQuestionTypeFromOptionElements([document.querySelector('#fill textarea')])
    ]);
    assert.deepEqual(types, ['single', 'judgement', null, 'multiple', 'completion']);
  });
});

test('work option text elements infer type through their containing answerBg controls', async () => {
  await withPage(`<div class="questionLi"><div class="answerBg"><input type="radio"><span class="num_option">正确</span><div class="answer_p">正确</div></div>
    <div class="answerBg"><input type="radio"><span class="num_option">错误</span><div class="answer_p">错误</div></div></div>`, async (page) => {
    const result = await page.evaluate(() => inferQuestionTypeFromOptionElements([...document.querySelectorAll('.answer_p')]));
    assert.equal(result, 'judgement');
  });
});

test('option extraction prefers displayed labels over conflicting platform values and preserves image order', async () => {
  await withPage(`<ul><li class="answerBg" data="B"><span class="num_option">A</span><div class="answer_p">first</div></li>
    <li class="answerBg" data="A"><span class="num_option">B</span><div class="answer_p"><img data-src="/choice.png" alt="diagram">second</div></li></ul>`, async (page) => {
    const values = await page.evaluate(() => extractQuestionOptionTexts([...document.querySelectorAll('.answer_p')]));
    assert.deepEqual(values, ['A first', 'B diagram https://fixture.invalid/choice.png second']);
  });
});

test('correct answer extraction requires an explicit visible platform label inside the question root', async () => {
  await withPage(`<div id="q1"><dd class="rightAnswerContent">正确答案：B</dd></div>
    <div id="q2"><dd class="rightAnswerContent">我的答案：A</dd></div>
    <div id="q3"><dd class="rightAnswerContent" style="display:none">正确答案：C</dd></div>
    <div id="q4"><div class="description">题目描述中提到正确答案：D，但没有独立答案字段</div></div>`, async (page) => {
    const result = await page.evaluate(() => ['q1', 'q2', 'q3', 'q4'].map((id) =>
      extractExplicitCorrectAnswerEvidence(document.querySelector(`#${id}`))
    ));
    assert.deepEqual(result, [
      { label: 'rightAnswerContent', answer: 'B', text: '正确答案：B' },
      null,
      null,
      null
    ]);
  });
});

test('graded answer extraction preserves multiple blank answers and formula image evidence', async () => {
  await withPage(`<div id="q"><dd class="rightAnswerContent">参考答案：first blank</dd>
    <dd class="rightAnswerContent"><img data-src="/answer.png" alt="x² − y²"></dd></div>`, async (page) => {
    const result = await page.evaluate(() => extractExplicitCorrectAnswerEvidence(document.querySelector('#q')));
    assert.deepEqual(result, {
      label: 'rightAnswerContent',
      answer: 'first blank#x² − y² https://fixture.invalid/answer.png',
      text: '参考答案：first blank\nx² − y² https://fixture.invalid/answer.png'
    });
  });
});

test('the bundled resolver accepts unique exact multiple answers beside similar options', async () => {
  await withPage('<div class="option">abcdefghijklmnop</div><div class="option">abcdefghijklmnoq</div><div class="option">somethingelse</div>', async (page) => {
    const result = await page.evaluate(async () => {
      const selected = [];
      const result = await QuestionResolverFixture.createDefaultQuestionResolver({ answerMatchMode: 'similar', answerSeparators: ['#'] })
        .multiple([{ results: [{ answer: 'abcdefghijklmnop#somethingelse' }] }], [...document.querySelectorAll('.option')],
          (_type, _answer, option) => selected.push(option.innerText));
      return { finish: result.finish, selected };
    });
    assert.deepEqual(result, { finish: true, selected: ['abcdefghijklmnop', 'somethingelse'] });
  });
});
