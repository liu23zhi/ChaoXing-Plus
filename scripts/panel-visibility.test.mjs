import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'panel-visibility.ts');

async function loadPanelVisibilityModule() {
  return loadCompiledTypeScriptModule(helperSourcePath, ['panel-visibility.js', 'projects/panel-visibility.js']);
}

test('floating panel stays hidden in deeply nested iframes so only the outermost page owns it', async () => {
  const mod = await loadPanelVisibilityModule();

  assert.equal(typeof mod.shouldShowFloatingPanel, 'function');
  assert.equal(
    mod.shouldShowFloatingPanel({
      selfWindow: {},
      topWindow: {},
      parentWindow: {}
    }),
    false
  );
});

test('floating panel remains visible in top window', async () => {
  const mod = await loadPanelVisibilityModule();
  const topWindow = {};

  assert.equal(typeof mod.shouldShowFloatingPanel, 'function');
  assert.equal(
    mod.shouldShowFloatingPanel({
      selfWindow: topWindow,
      topWindow,
      parentWindow: topWindow
    }),
    true
  );
});

test('Windows 端只在考试/答题相关页面显示悬浮面板', async () => {
  const mod = await loadPanelVisibilityModule();
  assert.equal(typeof mod.isWindowsExamRelatedUrl, 'function');
  assert.equal(typeof mod.getWindowsExamRelatedUrlPatterns, 'function');

  const examUrls = [
    'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist?edition=1&nohead=0',
    'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examnotes?courseId=1',
    'https://mooc1.chaoxing.com/exam-ans/exam/test/reVersionTestStartNew?courseId=1',
    'https://mooc1.chaoxing.com/exam/test/reVersionTestStartNew?courseId=1',
    'https://mooc1.chaoxing.com/mooc2/exam/preview?courseId=1'
  ];
  for (const url of examUrls) {
    assert.equal(mod.isWindowsExamRelatedUrl(url), true, `${url} 应属于考试相关页面`);
  }

  const nonExamUrls = [
    'https://passport2.chaoxing.com/login?loginType=4&fid=2182',
    'http://zsc.kaoshi.chaoxing.com/cflogin/kskhdlogin?backurl=x',
    'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1',
    'https://mooc1.chaoxing.com/knowledge/cards?clazzid=1',
    'about:blank',
    ''
  ];
  for (const url of nonExamUrls) {
    assert.equal(mod.isWindowsExamRelatedUrl(url), false, `${url} 不应显示 Windows 悬浮面板`);
  }
  assert.equal(mod.isWindowsExamRelatedUrl(null), false);
  assert.equal(mod.isWindowsExamRelatedUrl(undefined), false);
  assert.equal(mod.getWindowsExamRelatedUrlPatterns().length >= 5, true);
});
