import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// 面板视觉回归：真实 Chromium + 真实构建产物 + 真实截图。
// 覆盖 3 主题 × {Windows 折叠态, 扩展展开态} × {桌面宽度, 小屏宽度}，共 12 张截图。
// 把「不能只靠源码字符串」的几条红线变成可测量的 DOM 断言：
// 无 backdrop-filter、近不透明底色、紧凑阴影、像素网格吸附、长列表内部滚动、
// 触控目标 ≥ 32px、小屏不溢出视口、Windows 折叠 / 扩展展开。

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');

const screenshotDir = join(tmpdir(), 'cxplus-panel-ui-polish');
const WINDOWS_BUNDLE = 'dist-windows/chaoxing-plus.windows.js';
const BOOTSTRAP = 'windows/share-file/windows-bootstrap.js';
const EXTENSION_BUNDLE = 'dist/chaoxing-plus.js';

const PANEL = '#panel-common-work-results';
const THEMES = ['pink', 'blue', 'green'];
const VIEWPORTS = [
  { label: 'desktop', width: 1100, height: 900 },
  { label: 'narrow', width: 360, height: 720 }
];

// 固定一份「有内容」的结果集：长题目、搜题中、失败、人工作答都要出现，
// 并且条目数量必须真的超过限高（否则测不出内部滚动），
// 才能看出长列表限高、状态条与错误下一步的实际呈现。
const FIXTURE_RESULTS = (() => {
  const answered = Array.from({ length: 18 }, (_, index) => ({
    question: `${index + 1}. 下列哪一项属于操作系统调度算法的正确描述，并说明其在多道程序设计中的作用与代价？`,
    type: 'single',
    requested: true,
    resolved: true,
    finish: true,
    searchInfos: [{
      name: 'tikuAdapter',
      // 单个题库返回很多条答案，用来看答案列表是否也限高。
      results: Array.from({ length: 6 }, (_, answerIndex) => [
        `候选题面 ${index + 1}-${answerIndex + 1}`,
        `参考答案 ${index + 1}-${answerIndex + 1}`,
        {}
      ])
    }]
  }));
  return [
    ...answered,
    { question: '这是一道正在搜题的题目', type: 'single', requested: false, resolved: false, searching: true, searchInfos: [] },
    {
      question: '这是一道搜题失败的题目',
      type: 'multiple',
      requested: true,
      resolved: false,
      error: JSON.stringify({
        errCode: 402,
        message: '当前 Key 额度已用尽或本次请求将超额',
        request: { method: 'POST', path: '/adapter-service/search' }
      }),
      searchInfos: []
    },
    {
      question: '这是一道已人工作答的题目',
      type: 'judgement',
      requested: true,
      resolved: true,
      finish: true,
      manual: true,
      searchInfos: [{ name: 'tikuAdapter', results: [['这是一道已人工作答的题目', '正确', {}]] }]
    }
  ];
})();

let browser;
let windowsBundle;
let extensionBundle;
let bootstrapSource;

before(async () => {
  await mkdir(screenshotDir, { recursive: true });
  windowsBundle = await readFile(WINDOWS_BUNDLE, 'utf8');
  extensionBundle = await readFile(EXTENSION_BUNDLE, 'utf8');
  bootstrapSource = await readFile(BOOTSTRAP, 'utf8');
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    protocolTimeout: 30000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });
});

after(async () => { await browser?.close(); });

async function openPanelPage(t, { theme, mode, viewport }) {
  // 每个用例用独立 browser context：localStorage 天然隔离，
  // 不会出现上一个用例的主题残留在下一个截图里（实测踩过）。
  const context = await browser.createBrowserContext();
  // context 关闭会连带关掉 page，不要再单独注册 page.close（会抛 Target.closeTarget）。
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message)));
  t.after(() => assert.deepEqual(pageErrors, [], 'panel page must not throw'));

  await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isNavigationRequest()) {
      void request.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><title>模拟考试页</title></head><body>
          <main style="font:16px/1.6 sans-serif;padding:24px">模拟考试页面（面板视觉回归）</main>
        </body></html>`
      });
    } else {
      void request.abort();
    }
  });
  await page.goto('http://a.chaoxing.com/exam-ans/exam/list');

  // 每个用例都从干净的存储开始：同一 origin 的 localStorage 会在用例间共享，
  // 不清理会让上一个用例的 --panel-theme 残留，截图主题与用例名不符（实测踩过）。
  await page.evaluate(() => { localStorage.clear(); });

  if (mode === 'windows') {
    // Windows 分支：bootstrap 注入 __CX_WIN_HOST__，并保持默认折叠。
    await page.evaluate(({ bootstrap, config, results }) => {
      window.__CX_WIN_INSTANCE__ = 'panel-visual';
      window.__CX_WIN_CONFIG_JSON__ = config;
      (0, eval)(bootstrap);
      // 面板结果走 runtimeStore（localStorage），这里预置一份固定内容。
      localStorage.setItem('common.work-results.results', JSON.stringify(results));
    }, {
      bootstrap: bootstrapSource,
      config: {
        'common.settings.extension-enabled': true,
        'common.settings.windows-panel-enabled': true,
        'common.settings.windows-no-disk-write': false,
        'common.settings.windows-panel-theme': theme,
        'common.settings.windows-panel-collapsed': true,
        'cx.new.study.enableAnswer': false
      },
      results: FIXTURE_RESULTS
    });
    await page.addScriptTag({ content: windowsBundle });
  } else {
    // 扩展分支：不注入 __CX_WIN_HOST__，必须保持完整面板 + 默认展开。
    // 主题仍写入同一个共享键，这样扩展分支也能用同一套三主题截图。
    await page.evaluate(({ results, theme }) => {
      localStorage.setItem('common.work-results.results', JSON.stringify(results));
      localStorage.setItem('common.settings.windows-panel-theme', JSON.stringify(theme));
    }, { results: FIXTURE_RESULTS, theme });
    await page.addScriptTag({ content: extensionBundle });
  }

  await page.waitForSelector(`${PANEL}[data-chaoxing-plus-theme]`, { timeout: 20000 });
  return page;
}

async function measure(page, selector) {
  return page.evaluate((panelSelector) => {
    const root = document.querySelector(panelSelector);
    const style = getComputedStyle(root);
    const rect = root.getBoundingClientRect();

    const tooSmallTargets = [];
    for (const element of root.querySelectorAll('button, input, select, a')) {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && box.height < 32) {
        tooSmallTargets.push({
          tag: element.tagName,
          text: (element.textContent || '').trim().slice(0, 24),
          height: Math.round(box.height * 100) / 100
        });
      }
    }

    const scrollPanes = Array.from(root.querySelectorAll('[data-cx-scroll-pane="true"]')).map((element) => {
      const paneStyle = getComputedStyle(element);
      const paneRect = element.getBoundingClientRect();
      return {
        overflowY: paneStyle.overflowY,
        maxHeight: paneStyle.maxHeight,
        scrollbarWidth: paneStyle.scrollbarWidth,
        clientHeight: Math.round(paneRect.height),
        scrollHeight: element.scrollHeight,
        scrollable: element.scrollHeight > element.clientHeight + 1
      };
    });

    // 折叠判定：折叠时业务 body 与设置容器都 display:none，面板内没有可见按钮。
    const visibleButtons = Array.from(root.querySelectorAll('button')).filter((button) => {
      const box = button.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }).length;

    return {
      theme: root.getAttribute('data-chaoxing-plus-theme'),
      backdropFilter: style.backdropFilter || '',
      webkitBackdropFilter: style.webkitBackdropFilter || '',
      backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      borderRadius: style.borderRadius,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      visibleButtons,
      tooSmallTargets,
      scrollPanes,
      hasStatusStrip: Boolean(root.querySelector('[data-cx-panel-status]')),
      statusStrip: Array.from(root.querySelectorAll('[data-cx-panel-status]')).map((element) => ({
        state: element.getAttribute('data-cx-panel-status'),
        text: (element.textContent || '').trim()
      })),
      hasBackdropInAnyElement: Array.from(root.querySelectorAll('*')).some((element) => {
        const elementStyle = getComputedStyle(element);
        const value = elementStyle.backdropFilter || elementStyle.webkitBackdropFilter || '';
        return value && value !== 'none';
      })
    };
  }, selector);
}

test('panel visual regression across themes, branches and viewport widths', { timeout: 240000 }, async (t) => {
  const summary = [];
  for (const theme of THEMES) {
    for (const mode of ['windows', 'extension']) {
      for (const viewport of VIEWPORTS) {
        const page = await openPanelPage(t, { theme, mode, viewport });
        const name = `${theme}-${mode}-${viewport.label}.png`;
        await page.screenshot({ path: join(screenshotDir, name), fullPage: false });
        const measurements = await measure(page, PANEL);
        summary.push({ name, theme, mode, viewport: viewport.label, ...measurements });

        // 红线：任何主题、任何分支都不允许 backdrop-filter（含子元素）。
        assert.equal(measurements.backdropFilter === '' || measurements.backdropFilter === 'none', true,
          `${name} 面板 backdrop-filter 必须为 none，实际 "${measurements.backdropFilter}"`);
        assert.equal(measurements.hasBackdropInAnyElement, false, `${name} 面板内存在 backdrop-filter`);
        // 近不透明底色：必须有背景（渐变或实色），不能靠页面透出。
        assert.notEqual(measurements.backgroundImage, 'none', `${name} 面板必须有背景`);
        // 紧凑阴影：不允许 40px 以上的大半径光晕。
        assert.doesNotMatch(measurements.boxShadow, /\b(70|60|54|48|40)px\b/u, `${name} 阴影必须紧凑：${measurements.boxShadow}`);
        // 主题落地。
        assert.equal(measurements.theme, theme, `${name} 主题未生效`);
        // 像素网格吸附：位置与外宽都必须是设备像素整数倍。
        for (const [key, value] of [['left', measurements.left], ['width', measurements.width], ['right', measurements.right]]) {
          const scaled = value * measurements.devicePixelRatio;
          assert.ok(Math.abs(scaled - Math.round(scaled)) <= 0.001,
            `${name} ${key}=${value} 未吸附设备像素网格（${scaled}）`);
        }
        // 小屏不溢出视口。
        assert.ok(measurements.right <= measurements.viewportWidth + 0.5,
          `${name} 右边缘 ${measurements.right} 超出视口 ${measurements.viewportWidth}`);
        assert.ok(measurements.left >= -0.5, `${name} 左边缘 ${measurements.left} 越界`);
        // 触控目标 ≥ 32px。
        assert.deepEqual(measurements.tooSmallTargets, [], `${name} 存在 < 32px 的触控目标`);
        // 长内容：滚动容器必须限高 + 内部滚动 + 细滚动条。
        for (const pane of measurements.scrollPanes) {
          assert.equal(pane.overflowY, 'auto', `${name} 滚动容器 overflowY 必须是 auto`);
          assert.notEqual(pane.maxHeight, 'none', `${name} 滚动容器必须有 maxHeight`);
          assert.equal(pane.scrollbarWidth, 'thin', `${name} 滚动条必须收窄`);
        }
        // Windows 折叠 / 扩展展开（既有红线，视觉层同样验证）。
        if (mode === 'windows') {
          assert.equal(measurements.visibleButtons, 0, `${name} Windows 端必须默认折叠（不应有可见按钮）`);
        } else {
          assert.ok(measurements.visibleButtons > 0, `${name} 扩展端必须默认展开`);
        }
      }
    }
  }

  // 展开态必须有可枚举状态条。
  for (const entry of summary.filter((item) => item.mode === 'extension')) {
    assert.equal(entry.hasStatusStrip, true, `${entry.name} 缺少状态条`);
    assert.equal(entry.statusStrip.length, 1, `${entry.name} 状态条必须唯一（互斥）`);
    const [strip] = entry.statusStrip;
    assert.ok(['idle', 'searching', 'answering', 'paused', 'waiting-manual', 'completed', 'error'].includes(strip.state),
      `${entry.name} 状态不在枚举内：${strip.state}`);
    assert.ok(strip.text.length > 0, `${entry.name} 状态条缺少可见文字`);
  }

  // 有长列表的两个分支都必须出现可滚动区域（限高生效）。
  const scrollable = summary.filter((entry) => entry.scrollPanes.some((pane) => pane.scrollable));
  assert.ok(scrollable.length >= summary.length / 2,
    `限高滚动未生效：只有 ${scrollable.length}/${summary.length} 个场景出现内部滚动`);

  console.log(`[panel-visual] 截图目录: ${screenshotDir}`);
  for (const entry of summary) {
    console.log(`[panel-visual] ${entry.name} theme=${entry.theme} width=${entry.width} right=${entry.right} buttons=${entry.visibleButtons} status=${entry.statusStrip.map((item) => item.state).join(',') || '-'} panes=${entry.scrollPanes.length}`);
  }
});

test('narrow viewport keeps the panel inside the viewport in every theme', { timeout: 120000 }, async (t) => {
  for (const theme of THEMES) {
    for (const mode of ['windows', 'extension']) {
      const page = await openPanelPage(t, { theme, mode, viewport: { label: 'tiny', width: 320, height: 640 } });
      const measurements = await measure(page, PANEL);
      assert.ok(measurements.width <= 320, `${theme}/${mode} 面板宽度 ${measurements.width} 超过 320 视口`);
      assert.ok(measurements.right <= 320.5, `${theme}/${mode} 右边缘越界`);
      assert.ok(measurements.left >= -0.5, `${theme}/${mode} 左边缘越界`);
      await page.screenshot({ path: join(screenshotDir, `${theme}-${mode}-tiny.png`) });
    }
  }
});

test('long answer lists scroll internally and error blocks state the next step', { timeout: 120000 }, async (t) => {
  for (const theme of THEMES) {
    // 用扩展分支（默认展开）验证内容呈现；折叠/展开本身已在上面的用例覆盖。
    const page = await openPanelPage(t, { theme, mode: 'extension', viewport: { label: 'desktop', width: 1100, height: 900 } });

    const pickByTitle = (pattern) => page.evaluate((patternSource) => {
      const regex = new RegExp(patternSource, 'u');
      const root = document.querySelector('#panel-common-work-results');
      const buttons = Array.from(root.querySelectorAll('button')).filter((b) => /^\d+$/.test(b.textContent.trim()));
      const target = buttons.find((b) => regex.test(b.title || ''));
      if (!target) return null;
      target.click();
      return target.title;
    }, pattern.source);

    // 1) 选中一道「已完成且有 6 条候选答案」的题：答案列表必须内部滚动。
    const answeredTitle = await pickByTitle(/已完成/u);
    assert.ok(answeredTitle, `${theme} 必须能选中已完成题目`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const answeredPanes = await page.evaluate(() => Array.from(
      document.querySelectorAll('#panel-common-work-results [data-cx-scroll-pane="true"]')
    ).map((el) => ({
      maxHeight: getComputedStyle(el).maxHeight,
      overflowY: getComputedStyle(el).overflowY,
      clientHeight: Math.round(el.getBoundingClientRect().height),
      scrollHeight: el.scrollHeight
    })));
    const overflowing = answeredPanes.filter((pane) => pane.scrollHeight > pane.clientHeight + 1);
    assert.ok(overflowing.length >= 1,
      `${theme} 长答案列表必须内部滚动，实际 ${JSON.stringify(answeredPanes)}`);
    for (const pane of answeredPanes) {
      assert.equal(pane.overflowY, 'auto', `${theme} 滚动容器必须 overflowY:auto`);
      assert.notEqual(pane.maxHeight, 'none', `${theme} 滚动容器必须限高`);
    }
    await page.screenshot({ path: join(screenshotDir, `${theme}-long-answers.png`) });

    // 2) 选中「搜题失败」的题：错误块必须给出可执行的下一步。
    const failedTitle = await pickByTitle(/额度/u);
    assert.ok(failedTitle, `${theme} 必须能选中搜题失败题目，实际 title=${failedTitle}`);
    await new Promise((resolve) => setTimeout(resolve, 250));

    // 「下一步」提示必须在面板可视范围内，不能被 max-height 裁到看不见。
    const nextStepElement = await page.evaluate(() => {
      const root = document.querySelector('#panel-common-work-results');
      const nodes = Array.from(root.querySelectorAll('div'));
      const target = nodes.find((node) => node.children.length === 0 && /^下一步：/u.test((node.textContent || '').trim()));
      if (!target) return null;
      target.scrollIntoView({ block: 'center' });
      const rect = target.getBoundingClientRect();
      const panelRect = root.getBoundingClientRect();
      return {
        text: (target.textContent || '').trim(),
        // 需要可滚动命中：元素在面板内部滚动容器里，滚动后应落在面板可视区内。
        visibleAfterScroll: rect.top >= panelRect.top - 1 && rect.bottom <= panelRect.bottom + 1,
        inPanel: rect.top >= panelRect.top - 1 && rect.top <= panelRect.bottom
      };
    });
    assert.ok(nextStepElement, `${theme} 详情区必须渲染「下一步」提示`);
    assert.match(nextStepElement.text, /调整额度|更换 Key/u, `${theme} 额度用尽的下一步不明确：${nextStepElement.text}`);
    assert.equal(nextStepElement.visibleAfterScroll, true,
      `${theme} 「下一步」提示即使在滚动后也不在面板可视区，说明面板/滚动容器把内容裁掉了`);

    // 原始错误必须默认折叠，避免长 JSON 撑爆面板。
    const collapsedDetails = await page.evaluate(() => Array.from(
      document.querySelectorAll('#panel-common-work-results details')
    ).filter((el) => el.open === false).length);
    assert.ok(collapsedDetails >= 1, `${theme} 原始错误必须默认折叠`);

    await page.screenshot({ path: join(screenshotDir, `${theme}-error-state.png`) });
  }
});
