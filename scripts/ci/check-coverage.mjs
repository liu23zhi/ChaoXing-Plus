#!/usr/bin/env node
// 覆盖率门禁。
//
// 口径说明（很重要，别当成"全仓覆盖率"）：
//
//   Node 的 --experimental-test-coverage 只能统计**被 Node 模块加载器加载过**的文件。
//   本仓库的业务主体 src/projects/** 与 src/runtime/** 跑在构建产物 dist/chaoxing-plus.js
//   里，由 puppeteer 加载，**不经过 Node 的模块加载**，所以它们的覆盖率在这里恒为
//   "未统计"，而不是 0%。把它们算进分母会得出一个没有意义的低值。
//
//   因此门禁分三组，各自只对**真正被统计到**的文件负责：
//
//   A. windows/node-source/**   Node 宿主（已冻结，但仍是可执行代码）
//   B. windows/share-file/**    构建/打包/参数生成等共享脚本
//   C. src/**                   只有 src/core/utils/request.js 会被统计到 —— 因为有几个
//                               测试直接 import 它。src 的其余部分进不了这里的统计。
//
//   src/projects/** 与 src/runtime/** 的覆盖率由浏览器回归覆盖，
//   它们的正确性靠行为断言而不是行覆盖率 —— 这是本仓库的既有策略，不是本门禁的疏漏。
//
// 用法：
//   node scripts/ci/check-coverage.mjs <coverage-tap-file>
//
// TAP 文件由 CI 这样生成（先 npm run build，否则 manifest 相关测试会假失败）：
//   node --test --experimental-test-coverage --test-concurrency=1 --test-reporter=tap \
//     @testFiles > coverage.tap

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// TAP 覆盖率报告是**缩进式目录树**：
//   # scripts |                                  ← 1 个空格 = 深度 0
//   #  test-helpers |                            ← 2 个空格 = 深度 1
//   #   load-compiled-typescript.mjs | 100.00 |  ← 3 个空格 = 深度 2（文件）
// 必须按深度维护目录栈还原完整路径，否则文件会被算成"未归组"，
// 门禁看起来通过、实际什么都没检查。
const ROW = /^#( +)(.+?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/u;
const DIR = /^#( +)(.+?)\s*\|\s*\|\s*\|\s*\|?\s*$/u;

const THRESHOLDS = {
  // 按 2026-11-09 实测值向下留 3 个百分点余量。改这些数字要在 PR 里写依据。
  'windows/node-source': { line: 83, branch: 71, funcs: 77 },
  'windows/share-file': { line: 89, branch: 73, funcs: 90 },
  // src 只有单个文件被统计，阈值等同该文件，留同样余量。
  src: { line: 93, branch: 68, funcs: 76 },
};

function groupOf(fullPath) {
  if (fullPath.startsWith('windows/node-source/')) return 'windows/node-source';
  if (fullPath.startsWith('windows/share-file/')) return 'windows/share-file';
  if (fullPath.startsWith('src/')) return 'src';
  return undefined;
}

function parseCoverage(tapPath) {
  const lines = readFileSync(tapPath, 'utf8').split(/\r?\n/u);
  const files = [];
  // 目录栈：stack[i] = 深度 i 的目录名
  const stack = [];
  let started = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u001B\[[0-9;]*m/gu, '');

    if (/^# start of coverage report/u.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (/^# -+$/u.test(line) || /^# file\s+\|/u.test(line)) continue;
    if (/^# end of coverage report/u.test(line)) break;

    const fileMatch = line.match(ROW);
    if (fileMatch) {
      const depth = fileMatch[1].length; // 空格数
      const name = fileMatch[2].trim();
      const dirs = stack.slice(0, depth - 1);
      // 顶层文件（depth 1）直接是文件名；正常情况文件都在 depth >= 2
      const fullPath = dirs.length > 0 ? `${dirs.join('/')}/${name}` : name;
      files.push({
        path: fullPath,
        line: Number.parseFloat(fileMatch[3]),
        branch: Number.parseFloat(fileMatch[4]),
        funcs: Number.parseFloat(fileMatch[5]),
      });
      continue;
    }

    const dirMatch = line.match(DIR);
    if (dirMatch) {
      const depth = dirMatch[1].length;
      const name = dirMatch[2].trim();
      stack.length = depth;
      stack[depth - 1] = name;
    }
  }

  return files;
}

function average(rows, key) {
  return rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
}

function main() {
  const tapPath = process.argv[2];
  if (!tapPath) {
    console.error('用法: node scripts/ci/check-coverage.mjs <coverage-tap-file>');
    process.exit(2);
  }

  const absoluteTap = resolve(tapPath);
  const files = parseCoverage(absoluteTap);
  if (files.length === 0) {
    console.error(`覆盖率报告解析为空：${absoluteTap}`);
    console.error('确认：(1) TAP 含 "# start of coverage report"；(2) --experimental-test-coverage 已开启');
    process.exit(2);
  }

  const groups = new Map();
  const ungrouped = [];
  for (const file of files) {
    const group = groupOf(file.path);
    if (!group) {
      ungrouped.push(file.path);
      continue;
    }
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(file);
  }

  console.log('覆盖率门禁（按组，只统计 Node 加载得到的文件）');
  console.log('');

  const failures = [];
  for (const [group, threshold] of Object.entries(THRESHOLDS)) {
    const rows = groups.get(group) || [];
    if (rows.length === 0) {
      // 组内一个文件都没统计到，说明解析或测试范围出了问题，不能静默放过。
      console.log(`  ${group.padEnd(22)} ✗ 未统计到任何文件`);
      failures.push({ group, reason: 'no files matched', detail: `该组应有被统计的文件，但没有解析到` });
      continue;
    }
    const actual = {
      line: average(rows, 'line'),
      branch: average(rows, 'branch'),
      funcs: average(rows, 'funcs'),
    };
    const parts = [];
    let groupFailed = false;
    for (const metric of ['line', 'branch', 'funcs']) {
      const value = actual[metric];
      const required = threshold[metric];
      const ok = value >= required;
      if (!ok) groupFailed = true;
      parts.push(`${metric} ${value.toFixed(2)}% (≥${required}%)${ok ? '' : ' ✗'}`);
    }
    console.log(`  ${group.padEnd(22)} ${String(rows.length).padStart(2)} 文件  ${parts.join('  ')}`);
    if (groupFailed) failures.push({ group, actual, threshold });
  }

  if (ungrouped.length > 0) {
    console.log('');
    console.log(`  未纳入门禁（${ungrouped.length} 个）：`);
    for (const path of ungrouped.slice(0, 8)) console.log(`    ${path}`);
    if (ungrouped.length > 8) console.log(`    ...另有 ${ungrouped.length - 8} 个`);
  }

  console.log('');
  console.log('未纳入统计（设计如此）：');
  console.log('  src/projects/**   跑在构建产物里，由浏览器回归覆盖，Node 覆盖率工具看不到');
  console.log('  src/runtime/**    同上');
  console.log('  src/core/*.ts     测试直接 import .js 影子文件，统计口径与产物不一致');

  if (failures.length > 0) {
    console.log('');
    console.error('覆盖率门禁失败：');
    for (const failure of failures) {
      if (failure.reason) {
        console.error(`  ${failure.group}: ${failure.detail}`);
        continue;
      }
      const lines = [];
      for (const metric of ['line', 'branch', 'funcs']) {
        if (failure.actual[metric] < failure.threshold[metric]) {
          lines.push(`${metric} ${failure.actual[metric].toFixed(2)}% < 要求 ${failure.threshold[metric]}%`);
        }
      }
      console.error(`  ${failure.group}: ${lines.join('，')}`);
    }
    process.exit(1);
  }

  console.log('');
  console.log('覆盖率门禁通过。');
}

main();
