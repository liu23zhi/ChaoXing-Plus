import { parseAst } from 'rolldown/parseAst';

/**
 * Chrome 75（CEF 75.1.4 / Chromium 75.0.3770.100）不支持的语法特征。
 * 只覆盖目标项目里真实可能出现的、且运行期补丁无法兜底的语法。
 */
export const UNSUPPORTED_SYNTAX = [
  { test: (node) => node.type === 'ChainExpression', feature: 'optional chaining (?.)' },
  {
    test: (node) => node.type === 'LogicalExpression' && node.operator === '??',
    feature: 'nullish coalescing (??)'
  },
  {
    test: (node) => node.type === 'AssignmentExpression' && ['??=', '||=', '&&='].includes(node.operator),
    feature: 'logical assignment (??=/||=/&&=)'
  },
  { test: (node) => node.type === 'StaticBlock', feature: 'class static block' },
  { test: (node) => node.type === 'PrivateIdentifier', feature: 'private class member (#name)' }
];

export function collectUnsupportedSyntax(ast) {
  const findings = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 200) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node.type === 'string') {
      for (const rule of UNSUPPORTED_SYNTAX) {
        if (rule.test(node)) findings.push(rule.feature);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      walk(node[key], depth + 1);
    }
  };
  walk(ast, 0);
  return [...new Set(findings)];
}

/**
 * 校验一段脚本是否能被 Chrome 75 解析。
 * @param {string} source
 * @param {{label?: string, functionBody?: boolean}} options
 *   functionBody=true 时用于校验 handler 字符串（"return (env) => ..." 需要包在函数体里）。
 * @returns {{ok: boolean, label: string, unsupported: string[]}}
 */
export function checkChrome75Syntax(source, { label = 'script', functionBody = false } = {}) {
  const wrapped = functionBody ? `function __chrome75_handler__(){\n${source}\n}` : source;
  const ast = parseAst(wrapped, { sourceType: 'script' });
  const unsupported = collectUnsupportedSyntax(ast);
  return { ok: unsupported.length === 0, label, unsupported };
}

export function assertChrome75Syntax(source, options) {
  const result = checkChrome75Syntax(source, options);
  if (!result.ok) {
    throw new Error(`${result.label} 含 Chrome 75 不支持的语法：${result.unsupported.join('、')}`);
  }
  return result;
}
