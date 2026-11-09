// 让 Node 加载 src/** 下的 .ts 源码，而不是同名 .js 影子文件；并提供与 Node 版本无关的转译。
//
// 为什么需要它（口径问题，别当成可有可无的优化）：
//   build.mjs 的 resolve.extensions 把 .ts 排在 .js 前面（PR #19 定的），
//   所以**进构建产物的是 .ts**。但历史测试仍 `import '../src/core/utils/request.js'`，
//   于是 Node 的 --experimental-test-coverage 统计到的是**不上线**的影子 .js ——
//   门禁在给一份不会发布的文件打分。
//
//   实测差异（同一批测试）：
//     影子 request.js 96.81 / 72.22 / 80.00
//     实际 request.ts 84.52 / 62.64 / 81.82
//   数字不同不是重点，"测的不是要上线的那份"才是。
//
// 为什么自己转译而不是用 Node 内置 .ts 支持：
//   Node 22 需要实验性开关、Node 24 才默认可用。CI 固定 Node 22、本机是 Node 24，
//   自建转译让两边口径一致。用仓库已有的 @typescript/typescript6，不引入新依赖。
//
// 只影响 src/ 下的解析与 .ts 加载，不改变任何测试逻辑。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';

const SOURCE_SEGMENT = '/src/';

function isRepositorySource(url) {
  return url instanceof URL && url.protocol === 'file:' && url.pathname.includes(SOURCE_SEGMENT);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL) {
    let target;
    try {
      target = specifier.startsWith('.') ? new URL(specifier, context.parentURL) : new URL(specifier);
    } catch {
      return nextResolve(specifier, context);
    }
    if (isRepositorySource(target)) {
      const tsTarget = new URL(target.href.replace(/\.js$/u, '.ts'));
      if (existsSync(fileURLToPath(tsTarget))) {
        return nextResolve(tsTarget.href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const filePath = fileURLToPath(url);
    const output = ts.transpileModule(readFileSync(filePath, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        // 覆盖率要报源码行号，转译产物必须保留原文件位置。
        inlineSourceMap: true,
        inlineSources: true
      },
      fileName: filePath
    }).outputText;
    return { format: 'module', source: output, shortCircuit: true };
  }
  return nextLoad(url, context);
}
