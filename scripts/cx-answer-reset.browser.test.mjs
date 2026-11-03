import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import ts from '@typescript/typescript6';

let browser;
let runtime;

before(async () => {
  const source = await readFile('src/projects/cx-answer-reset.ts', 'utf8');
  runtime = ts.transpileModule(`${source.replace(/^export /gmu, '')}\nwindow.resetCxQuestionAnswers = resetCxQuestionAnswers;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
  }).outputText;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'] });
});

after(async () => { await browser?.close(); });

async function withPage(html, run) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    await page.addScriptTag({ content: runtime });
    return await run(page);
  } finally { await page.close(); }
}

test('clears both choice templates and answer values while preserving option and identity values', async () => {
  await withPage(`<div class="singleQuesId" id="current"><h3>Current question</h3>
    <div class="answerBg active" aria-checked="true"><span class="num_option check_answer_dx">A</span><div class="answer_p">Choice A</div>
      <input type="radio" name="choice" value="A" checked></div>
    <div class="answerBg"><span class="num_option check_answer check_answer_custom">B</span><div class="answer_p">Choice B</div>
      <input type="checkbox" name="choice" value="B" checked></div>
    <input type="hidden" name="answer123" value="AB"><input type="hidden" name="answer_123" value="AB">
    <input type="hidden" name="answer[123]" value="AB"><input type="hidden" id="answer-123" value="AB">
    <input type="hidden" name="answer" value="AB"><input type="hidden" name="answertype123" value="1">
    <input type="hidden" name="answerId" value="identity"><input type="hidden" name="answerCount" value="2">
    <input type="hidden" name="courseId" value="course"><button onclick="window.saves++">保存</button>
    </div><div class="TiMu" id="chapter"><div class="Zy_TItle">Chapter question</div><ul><li class="selected">
    <label aria-checked="true"><input type="radio" name="chapterChoice" value="yes" checked></label><span class="after">Yes</span></li></ul></div>
    <div id="sibling"><input type="checkbox" checked><input name="answer999" value="untouched"></div>`, async (page) => {
    const result = await page.evaluate(() => {
      window.saves = 0;
      const roots = [document.querySelector('#current'), document.querySelector('#chapter')];
      const optionTexts = [...document.querySelectorAll('.answer_p,.after')].map((node) => node.textContent);
      window.resetCxQuestionAnswers(roots);
      return {
        choices: roots.flatMap((root) => [...root.querySelectorAll('input[type=radio],input[type=checkbox]')])
          .map((input) => ({ checked: input.checked, defaultChecked: input.defaultChecked, attr: input.hasAttribute('checked'), value: input.value })),
        answerValues: [...document.querySelectorAll('#current input[type=hidden]')].map((input) => input.value),
        selected: roots.flatMap((root) => [...root.querySelectorAll('[aria-checked=true],[class*=check_answer],.answerBg.active,.selected')]).length,
        optionTexts: [...document.querySelectorAll('.answer_p,.after')].map((node) => node.textContent),
        originalOptionTexts: optionTexts,
        title: document.querySelector('h3').textContent,
        sibling: { checked: document.querySelector('#sibling input').checked, answer: document.querySelector('#sibling input[name]').value },
        saves: window.saves
      };
    });
    assert.deepEqual(result.choices, [
      { checked: false, defaultChecked: false, attr: false, value: 'A' },
      { checked: false, defaultChecked: false, attr: false, value: 'B' },
      { checked: false, defaultChecked: false, attr: false, value: 'yes' }
    ]);
    assert.deepEqual(result.answerValues, ['', '', '', '', '', '1', 'identity', '2', 'course']);
    assert.equal(result.selected, 0);
    assert.deepEqual(result.optionTexts, result.originalOptionTexts);
    assert.equal(result.title, 'Current question');
    assert.deepEqual(result.sibling, { checked: true, answer: 'untouched' });
    assert.equal(result.saves, 0);
  });
});

test('clears textareas, editable text and editor frames without clearing content frames', async () => {
  await withPage(`<div class="singleQuesId" id="question"><h3>Keep the stem</h3>
    <textarea name="answer123">Old text</textarea><div class="textDIV"><div contenteditable="true"><p>Editable answer</p></div>
    <iframe id="editor"></iframe></div><div contenteditable="plaintext-only">Plain answer</div>
    <div contenteditable="false">Readonly question text</div><iframe id="content"></iframe>
    <iframe sandbox="" srcdoc="<body contenteditable='true'>Opaque content</body>"></iframe>
    <button onclick="window.submits++">提交</button></div>`, async (page) => {
    const result = await page.evaluate(() => {
      const editor = document.querySelector('#editor').contentDocument;
      editor.body.contentEditable = 'true';
      editor.body.innerHTML = '<p>Editor answer</p>';
      const content = document.querySelector('#content').contentDocument;
      content.body.innerHTML = '<p>Reference material</p>';
      window.submits = 0;
      window.resetCxQuestionAnswers([document.querySelector('#question')]);
      return { textarea: document.querySelector('textarea').value, defaultValue: document.querySelector('textarea').defaultValue,
        editables: [...document.querySelectorAll('[contenteditable]')].map((node) => node.textContent),
        editor: editor.body.textContent, content: content.body.textContent,
        title: document.querySelector('h3').textContent, submits: window.submits };
    });
    assert.deepEqual(result, { textarea: '', defaultValue: '', editables: ['', '', 'Readonly question text'],
      editor: '', content: 'Reference material', title: 'Keep the stem', submits: 0 });
  });
});

test('clears existing UEditor state only for the requested question and never constructs an editor', async () => {
  await withPage(`<div class="singleQuesId" id="question"><textarea id="answer1">Old source</textarea>
    <div class="textDIV" id="editorContainer"><iframe id="editor"></iframe></div></div>
    <div id="other"><textarea id="answer2">Other source</textarea><div id="otherEditor"></div></div>`, async (page) => {
    const result = await page.evaluate(() => {
      const frame = document.querySelector('#editor');
      frame.contentDocument.body.innerHTML = '<p>Old editor answer</p>';
      const own = { container: document.querySelector('#editorContainer'), iframe: frame, isReady: true, answer: 'Old editor answer',
        setContent(answer) { this.answer = answer; this.iframe.contentDocument.body.innerHTML = answer; },
        sync() { document.querySelector('#answer1').value = this.answer; } };
      const other = { container: document.querySelector('#otherEditor'), isReady: true, answer: 'Other source',
        setContent(answer) { this.answer = answer; } };
      window.UE = { instants: { own, other }, getEditor() { throw new Error('must not construct an editor'); } };
      window.resetCxQuestionAnswers([document.querySelector('#question')]);
      return { answer: own.answer, source: document.querySelector('#answer1').value, body: frame.contentDocument.body.textContent,
        otherAnswer: other.answer, otherSource: document.querySelector('#answer2').value };
    });
    assert.deepEqual(result, { answer: '', source: '', body: '', otherAnswer: 'Other source', otherSource: 'Other source' });
  });
});

test('clears line, fill and reader selection state while retaining every available option', async () => {
  await withPage(`<div class="singleQuesId" id="question"><h3>Keep all question contents</h3>
    <div class="line_answer"><input type="hidden" name="answer55" value="A#B"></div>
    <div class="line_answer_ct"><div class="selectBox"><ul><li class="active" data="A"><a>A connection</a></li>
    <li data="B"><a>B connection</a></li></ul><select name="answer_55"><option value="A" selected>A</option><option value="B">B</option></select></div></div>
    <div class="filling_answer"><input type="hidden" name="answer56" value="A"><span class="saveSingleSelect active" data="A" aria-checked="true">Fill A</span>
    <span class="saveSingleSelect" data="B">Fill B</span></div>
    <div class="reading_answer"><input type="hidden" name="answer57" value="B"><span class="saveSingleSelect on selected" data="A">Reader A</span>
    <span class="saveSingleSelect check_answer" data="B" aria-selected="true">Reader B</span></div></div>`, async (page) => {
    const result = await page.evaluate(() => {
      const root = document.querySelector('#question');
      const options = [...root.querySelectorAll('li a,.saveSingleSelect')].map((node) => node.textContent);
      window.resetCxQuestionAnswers([root]);
      return { answers: [...root.querySelectorAll('input')].map((input) => input.value), selectedIndex: root.querySelector('select').selectedIndex,
        selectedDefaults: [...root.querySelectorAll('option')].map((option) => option.defaultSelected),
        markers: root.querySelectorAll('.active,.selected,.on,.check_answer,[aria-checked=true],[aria-selected=true]').length,
        options: [...root.querySelectorAll('li a,.saveSingleSelect')].map((node) => node.textContent), originalOptions: options,
        title: root.querySelector('h3').textContent };
    });
    assert.deepEqual(result.answers, ['', '', '']);
    assert.equal(result.selectedIndex, -1);
    assert.deepEqual(result.selectedDefaults, [false, false]);
    assert.equal(result.markers, 0);
    assert.deepEqual(result.options, result.originalOptions);
    assert.equal(result.title, 'Keep all question contents');
  });
});

test('uses the question owner document and its editor registry across an iframe boundary', async () => {
  await withPage('<div class="singleQuesId" id="topQuestion"><textarea>Top answer</textarea></div><iframe id="task"></iframe>', async (page) => {
    const result = await page.evaluate(() => {
      const doc = document.querySelector('#task').contentDocument;
      doc.body.innerHTML = '<div class="TiMu" id="question"><input type="checkbox" checked><textarea>Inner answer</textarea><div id="editor"></div></div>';
      const own = { container: doc.querySelector('#editor'), answer: 'Inner state', setContent(answer) { this.answer = answer; } };
      doc.defaultView.UE = { instants: { own } };
      window.UE = { instants: { top: { container: document.querySelector('#topQuestion'), answer: 'Top state', setContent(answer) { this.answer = answer; } } } };
      window.resetCxQuestionAnswers([doc.querySelector('#question')]);
      return { inner: doc.querySelector('textarea').value, checked: doc.querySelector('input').checked, editor: own.answer,
        top: document.querySelector('textarea').value, topEditor: window.UE.instants.top.answer };
    });
    assert.deepEqual(result, { inner: '', checked: false, editor: '', top: 'Top answer', topEditor: 'Top state' });
  });
});

test('emits answer input changes once and leaves identity fields and controls untouched', async () => {
  await withPage(`<div class="singleQuesId" id="question"><input type="checkbox" value="A" checked>
    <textarea>Answer</textarea><input name="answer1" value="A"><input name="answerId" value="identity">
    <button type="submit">Submit</button><input type="submit" value="Save"></div>`, async (page) => {
    const result = await page.evaluate(() => {
      const root = document.querySelector('#question');
      const changes = [];
      const clearedAtNotification = [];
      root.addEventListener('change', (event) => {
        changes.push(event.target.tagName + ':' + (event.target.name || event.target.type));
        clearedAtNotification.push(!root.querySelector('input[type=checkbox]').checked
          && root.querySelector('textarea').value === '' && root.querySelector('[name=answer1]').value === '');
      });
      window.resetCxQuestionAnswers([root, root]);
      window.resetCxQuestionAnswers([root]);
      return { changes: changes.sort(), clearedAtNotification, identity: root.querySelector('[name=answerId]').value, save: root.querySelector('[type=submit]').textContent,
        submitValue: root.querySelector('input[type=submit]').value };
    });
    assert.deepEqual(result, { changes: ['INPUT:answer1', 'INPUT:checkbox', 'TEXTAREA:textarea'], clearedAtNotification: [true, true, true],
      identity: 'identity', save: 'Submit', submitValue: 'Save' });
  });
});
