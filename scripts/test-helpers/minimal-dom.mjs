import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 最小 DOM：只实现 `status-panel.ts` 渲染层真正用到的那一小撮 API。
//
// 为什么不用 jsdom：本项目零运行期 DOM 依赖，为一个测试引 devDependency 会改
// package.json/lock 并影响 CI 的 `npm ci`。而渲染层用到的只有
// createElement / dataset / style / append / querySelectorAll，30 行就能覆盖。
// 真实布局（360px 不溢出）由 status-panel-layout.browser.test.mjs 用真浏览器量。

const scriptsDir = dirname(fileURLToPath(import.meta.url));

/** 极简选择器：只支持测试里出现的三种形态。 */
function matches(node, selector) {
  if (selector.startsWith('[data-') && selector.endsWith(']')) {
    // [data-foo="bar"]
    const attrMatch = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(selector);
    if (!attrMatch) return false;
    const key = camelFromDataAttr(attrMatch[1]);
    const expected = attrMatch[2];
    const actual = node.dataset ? node.dataset[key] : undefined;
    if (actual === undefined) return false;
    return expected === undefined ? true : String(actual) === expected;
  }
  const tagMatch = /^([a-z0-9]+)$/i.exec(selector);
  if (tagMatch) {
    return String(node.tagName).toLowerCase() === tagMatch[1].toLowerCase();
  }
  return false;
}

function camelFromDataAttr(name) {
  return name.replace(/-([a-z0-9])/gi, (_, char) => char.toUpperCase());
}

function createDocument() {
  const makeElement = (tagName) => {
    const element = {
      tagName: String(tagName).toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      attributes: {},
      textContent: '',
      className: '',
      parentNode: undefined,
      get children_() { return this.children; },
      append(...nodes) {
        for (const node of nodes) {
          if (node === null || node === undefined) continue;
          node.parentNode = this;
          this.children.push(node);
        }
      },
      appendChild(node) { this.append(node); return node; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      querySelectorAll(selector) {
        const found = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (matches(child, selector)) found.push(child);
            walk(child);
          }
        };
        walk(this);
        return found;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      },
      /** 把自身与所有子孙的 textContent 拼起来（断言文案用）。 */
      get textContentAll() {
        const parts = [this.textContent ?? ''];
        const walk = (node) => {
          for (const child of node.children) {
            parts.push(child.textContent ?? '');
            walk(child);
          }
        };
        walk(this);
        return parts.join(' ');
      }
    };
    return element;
  };

  return {
    createElement: makeElement,
    getElementById: () => null,
    dispatchEvent: () => true
  };
}

/**
 * 在安装了最小 DOM 的全局环境里执行 fn，结束后恢复。
 *
 * `status-panel.ts` 的渲染层直接调用全局 `document`，所以必须临时挂到 globalThis 上。
 */
export async function withMinimalDom(fn) {
  const previous = globalThis.document;
  const doc = createDocument();
  globalThis.document = doc;
  try {
    return await fn(doc);
  } finally {
    if (previous === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previous;
    }
  }
}

export function resolveScriptPath(...parts) {
  return resolve(scriptsDir, '..', ...parts);
}
