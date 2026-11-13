import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';
import ts from '@typescript/typescript6';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const statusPanelPath = resolve(scriptsDir, '..', 'src', 'projects', 'status-panel.ts');

/**
 * 360px 面板里的状态页布局回归。
 *
 * 为什么必须真浏览器：`min-width:0`、`flex:1 1 0`、`grid-template-columns: minmax(0,1fr)`
 * 这类防溢出写法在 JSDOM 里全都没有布局引擎，量不出真实宽度 —— 用假 DOM 断言
 * 「没有横向溢出」是典型的假钉子（问「实现坏了这条会不会红」时会答不上来）。
 */
const PANEL_WIDTH = 360;

async function loadStatusPanelModule() {
  const source = await readFile(statusPanelPath, 'utf8');
  // 必须编译成 CommonJS：页面里用 `new Function('module','exports','require', ...)` 执行，
  // ESNext 输出的 `export {...}` 会在函数体里直接 SyntaxError。
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
  }).outputText;
}

const THEME = {
  surfaceStrong: '#ffffff',
  surface: '#fffafd',
  border: 'rgba(244, 114, 182, 0.24)',
  borderStrong: 'rgba(219, 39, 119, 0.34)',
  text: '#7a1039',
  muted: '#8a1a4d',
  subtle: '#7d2f52',
  primaryDeep: '#be185d',
  successFg: '#14663b',
  warningFg: '#7a4c00',
  dangerFg: '#a11818'
};

let browser;
let moduleSource;

test('status panel fits 360px without horizontal overflow', async (t) => {
  const executablePath = process.env.CX_BROWSER_EXECUTABLE;
  if (!executablePath) return t.skip('未设置 CX_BROWSER_EXECUTABLE');

  const puppeteer = (await import('puppeteer-core')).default;
  moduleSource = await loadStatusPanelModule();

  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    protocolTimeout: 30000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setViewport({ width: PANEL_WIDTH, height: 900, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><body><div id="host"></div></body></html>');

    // 用面板真实的可用内容宽模拟：面板 360px、padding 14px、无边框占位。
    await page.evaluate(({ source, theme, width }) => {
      const module = { exports: {} };
      const require = () => { throw new Error('status-panel 不应有运行时依赖'); };
      new Function('module', 'exports', 'require', source)(module, module.exports, require);
      const api = module.exports;
      window.statusPanelApi = api;

      const host = document.getElementById('host');
      host.style.width = `${width - 28}px`;
      host.style.boxSizing = 'border-box';
      const section = api.createStatusPanelSection({
        theme,
        snapshot: api.createFixtureServiceStatusSnapshot(Date.now()),
        now: Date.now(),
        onRequestRefresh: () => {}
      });
      host.append(section);
      window.fixtureSnapshot = api.createFixtureServiceStatusSnapshot(Date.now());
    }, { source: moduleSource, theme: THEME, width: PANEL_WIDTH });

    const metrics = await page.evaluate(() => {
      const host = document.getElementById('host');
      const section = host.querySelector('[data-cx-status-panel]');
      const band = host.querySelector('[data-cx-status-band]');
      const cells = Array.from(host.querySelectorAll('[data-cx-status-cell]'));
      const legend = host.querySelector('[data-cx-status-legend]');
      const minutes = host.querySelector('[data-cx-status-minutes]');

      const hostBox = host.getBoundingClientRect();
      // 溢出判定：任何后代节点的右边界越过容器右边界（允许 1px 亚像素误差）。
      const overflowing = Array.from(section.querySelectorAll('*'))
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.right > hostBox.right + 1;
        })
        .map((node) => ({
          tag: node.tagName,
          dataset: JSON.stringify(node.dataset).slice(0, 80),
          right: Math.round(node.getBoundingClientRect().right),
          hostRight: Math.round(hostBox.right)
        }));

      return {
        hostWidth: Math.round(hostBox.width),
        scrollWidth: section.scrollWidth,
        clientWidth: section.clientWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        overflowing,
        bandRows: band ? band.dataset.cxStatusBandRows : null,
        bandBox: band ? { width: Math.round(band.getBoundingClientRect().width), height: Math.round(band.getBoundingClientRect().height) } : null,
        cellCount: cells.length,
        // 单行：所有格子的 top 必须相同（双行实现会分成两组 top）。
        cellTops: [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().top)))],
        legendColumns: legend ? (getComputedStyle(legend).gridTemplateColumns || '').split(' ').length : 0,
        minutesOverflowX: minutes ? minutes.scrollWidth - minutes.clientWidth : null
      };
    });

    // ---- 判据 ③：360px 下不横向溢出 ----
    assert.equal(metrics.overflowing.length, 0, `不得有子节点越界，实际 ${JSON.stringify(metrics.overflowing)}`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1,
      `状态页自身不得横向滚动，scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`);
    assert.ok(metrics.docScrollWidth <= metrics.viewportWidth,
      `整页不得横向滚动，docScrollWidth=${metrics.docScrollWidth} viewport=${metrics.viewportWidth}`);
    assert.deepEqual(metrics.minutesOverflowX, 0, '逐分钟列表只能纵向滚动（overflowX 必须裁掉）');

    // ---- 288 格 + 单行 ----
    assert.equal(metrics.cellCount, 288, `色带必须是 288 格，实际 ${metrics.cellCount}`);
    assert.equal(metrics.bandRows, '1', '单行渐变色带（118 §3.1）：行数恒为 1');
    assert.equal(metrics.cellTops.length, 1,
      `288 格必须在同一行（同一个 top），实际 ${metrics.cellTops.length} 个不同 top：${JSON.stringify(metrics.cellTops)}`);
    assert.ok(metrics.bandBox.width > 0 && metrics.bandBox.width <= metrics.hostWidth + 1,
      `色带宽度必须受限，band=${metrics.bandBox.width} host=${metrics.hostWidth}`);
    // 单格近似等分：288 格 × ~1.25px ≈ 360px。允许浏览器取整带来的偏差。
    assert.ok(metrics.bandBox.height <= 30, `色带高度必须单行（≤30px），实际 ${metrics.bandBox.height}`);

    // ---- 图例是 3 列网格（12 项 → 4 行），不是会撑宽的 flex-wrap ----
    assert.equal(metrics.legendColumns, 3, `图例必须是 3 列网格，实际 ${metrics.legendColumns} 列`);

    // ---- 判据 ④/⑦：逐格落档 + 无数据格颜色 ----
    const tierAudit = await page.evaluate(() => {
      const api = window.statusPanelApi;
      const snapshot = window.fixtureSnapshot;
      const now = Date.now();
      const expected = api.buildServiceStatusBuckets(snapshot.buckets, now);
      const cells = Array.from(document.querySelectorAll('[data-cx-status-cell]'));
      const mismatches = [];
      cells.forEach((cell, index) => {
        const bucket = expected[index];
        const tier = api.resolveServiceStatusTier(bucket.successRate);
        if (cell.dataset.cxStatusTier !== tier.id) {
          mismatches.push({ index, actual: cell.dataset.cxStatusTier, expected: tier.id });
        }
        if (cell.dataset.cxStatusStart !== String(bucket.startMs)) {
          mismatches.push({ index, startMismatch: true, actual: cell.dataset.cxStatusStart, expected: String(bucket.startMs) });
        }
        if (getComputedStyle(cell).backgroundColor !== toRgb(tier.color)) {
          mismatches.push({ index, colorMismatch: true, actual: getComputedStyle(cell).backgroundColor, expected: tier.color });
        }
      });
      function toRgb(hex) {
        const value = hex.replace('#', '');
        return `rgb(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)})`;
      }
      // 无数据格必须是浅灰，不是暗红。
      const noDataCells = cells.filter((cell) => cell.dataset.cxStatusTier === 'none');
      const totalFailureCells = cells.filter((cell) => cell.dataset.cxStatusTier === 't0');
      return {
        mismatches,
        noDataCount: noDataCells.length,
        noDataColors: [...new Set(noDataCells.map((cell) => getComputedStyle(cell).backgroundColor))],
        totalFailureCount: totalFailureCells.length,
        totalFailureColors: [...new Set(totalFailureCells.map((cell) => getComputedStyle(cell).backgroundColor))],
        // 不加阈值线标记：格子里必须是零子节点。
        cellChildCounts: [...new Set(cells.map((cell) => cell.children.length))]
      };
    });

    assert.deepEqual(tierAudit.mismatches, [],
      `288 格必须逐格对应到分档与起点，实际差异 ${JSON.stringify(tierAudit.mismatches.slice(0, 5))}`);
    assert.equal(tierAudit.noDataCount > 0, true, 'fixture 必须产生无数据格（否则判据 ⑦ 无从验证）');
    assert.deepEqual(tierAudit.noDataColors, ['rgb(209, 213, 219)'],
      `无数据格必须是浅灰 #d1d5db，实际 ${JSON.stringify(tierAudit.noDataColors)}`);
    assert.equal(tierAudit.totalFailureCount > 0, true, 'fixture 必须产生全部失败格');
    assert.deepEqual(tierAudit.totalFailureColors, ['rgb(127, 29, 29)'],
      `全部失败格必须是暗红 #7f1d1d，实际 ${JSON.stringify(tierAudit.totalFailureColors)}`);
    assert.deepEqual(tierAudit.cellChildCounts, [0], '格子内不得有任何子节点（不加阈值线标记）');
  } finally {
    await browser?.close();
    browser = undefined;
  }
});

test('色带点击联动下方逐分钟列表滚动（让模糊色带可用）', async (t) => {
  const executablePath = process.env.CX_BROWSER_EXECUTABLE;
  if (!executablePath) return t.skip('未设置 CX_BROWSER_EXECUTABLE');

  const puppeteer = (await import('puppeteer-core')).default;
  if (!moduleSource) moduleSource = await loadStatusPanelModule();

  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    protocolTimeout: 30000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setViewport({ width: PANEL_WIDTH, height: 900, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><body><div id="host" style="width:332px"></div></body></html>');

    await page.evaluate(({ source, theme }) => {
      const module = { exports: {} };
      const require = () => { throw new Error('status-panel 不应有运行时依赖'); };
      new Function('module', 'exports', 'require', source)(module, module.exports, require);
      const api = module.exports;
      const snapshot = api.createFixtureServiceStatusSnapshot(Date.now());
      window.statusPanelApi = api;
      window.snapshotNow = snapshot;
      document.getElementById('host').append(api.createStatusPanelSection({
        theme, snapshot, now: Date.now(), onRequestRefresh: () => {}
      }));
    }, { source: moduleSource, theme: THEME });

    // 滚到列表底部，再点色带上不同位置的格子 → 列表必须真的跟着滚。
    //
    // 断言用真实 offsetTop 反查「顶部对齐的是哪一行」，不用 `scrollTop / 常量行高` 折算：
    // 行高由字号与间距决定，用常量折算会引入累积误差，量出来的行号本身就不准
    // （实测同一段代码用 26px 折算得到第 53 行，真实是第 59 行）。
    const result = await page.evaluate(() => {
      const list = document.querySelector('[data-cx-status-minutes]');
      const nodes = Array.from(list.querySelectorAll('[data-cx-status-minute]'));
      const offsets = nodes.map((node) => node.offsetTop);
      const starts = nodes.map((node) => Number(node.dataset.cxStatusMinute));

      // scrollTop 落入哪一行：最后一个 offsetTop <= scrollTop 的行。
      const topRowIndex = (scrollTop) => {
        let found = 0;
        for (let index = 0; index < offsets.length; index += 1) {
          if (offsets[index] <= scrollTop + 1) found = index;
        }
        return found;
      };

      const clickCell = (index) => {
        const cell = document.querySelector(`[data-cx-status-cell="${index}"]`);
        cell.click();
        const rowIndex = topRowIndex(list.scrollTop);
        return {
          cellStart: Number(cell.dataset.cxStatusStart),
          scrollTop: list.scrollTop,
          rowIndex,
          rowStart: starts[rowIndex],
          previousRowStart: rowIndex > 0 ? starts[rowIndex - 1] : null,
          // 最后一行是否完整可见（用于「无对应行 → 落到最早一行」的边界）。
          lastRowBottom: offsets[offsets.length - 1] + nodes[nodes.length - 1].offsetHeight,
          viewportBottom: list.scrollTop + list.clientHeight
        };
      };

      list.scrollTop = list.scrollHeight;
      const before = list.scrollTop;
      return {
        before,
        maxScroll: list.scrollHeight - list.clientHeight,
        rows: nodes.length,
        clickCell: [clickCell(287), clickCell(0)]
      };
    });

    assert.ok(result.before > 0, '列表必须先滚到底（否则下面的断言证明不了联动）');
    assert.equal(result.rows, 60, '逐分钟列表必须有 60 行（STATUS_MINUTE_ROW_LIMIT）');

    const [latest, earliest] = result.clickCell;

    // 最新格（索引 287）必然在 60 分钟列表里有对应行：走「第一条命中」分支。
    assert.ok(latest.scrollTop >= 0 && latest.scrollTop <= result.maxScroll,
      `最新格的 scrollTop 必须落在可滚动范围内，实际 ${latest.scrollTop}`);
    assert.equal(latest.rowStart <= latest.cellStart, true,
      `最新格：顶部对齐行（${latest.rowStart}）必须不晚于格子起点（${latest.cellStart}）`);
    assert.equal(latest.previousRowStart === null || latest.previousRowStart > latest.cellStart, true,
      `最新格：必须是第一条命中的行，上一行（${latest.previousRowStart}）应晚于格子起点（${latest.cellStart}）`);

    // 最旧格（索引 0，24h 前）**在 60 分钟列表里没有对应行** —— 这是刻意的边界，
    // 既有分支必须落到最早一行。scrollTop 会被浏览器夹到 maxScroll，
    // 所以判据是「最后一行完整可见」，不是「顶部对齐到最后一行」。
    assert.equal(earliest.scrollTop, result.maxScroll,
      `最旧格无对应行时必须滚到底，实际 ${earliest.scrollTop} 期望 ${result.maxScroll}`);
    assert.ok(earliest.lastRowBottom <= earliest.viewportBottom + 1,
      `最旧格必须让最后一行完整可见，lastRowBottom=${earliest.lastRowBottom} viewportBottom=${earliest.viewportBottom}`);

    // 方向：越老的格子 → 列表越靠下。这条与上面两条互为对照。
    assert.ok(earliest.scrollTop > latest.scrollTop,
      `最旧格必须比最新格滚得更靠下，实际 ${earliest.scrollTop} vs ${latest.scrollTop}`);
  } finally {
    await browser?.close();
    browser = undefined;
  }
});
