import { applyMotionPreference } from './motion.js';
import { createScriptInstance } from './script.js';
import type { MatchRule, ProjectDefinition, ScriptDefinition } from './types.js';

function matchesRule(rule: MatchRule, url: string): boolean {
  const [, pattern] = rule;
  return typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url);
}

function matchesScript(script: ScriptDefinition, url: string): boolean {
  return script.matches.some((rule) => matchesRule(rule, url));
}

function matchesDomain(project: ProjectDefinition, hostname: string): boolean {
  if (project.domains.length === 0) return true;
  return project.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export async function start(projects: ProjectDefinition[]): Promise<void> {
  const url = window.location.href;
  const hostname = window.location.hostname;

  // 动效三档开关（78 §6.3 / 45 §0.27.4）：先于任何面板渲染生效，避免首屏出现一次
  // 「有动效 → 突然 0ms」的闪跳。失败不阻塞启动（样式注入只是装饰）。
  try {
    applyMotionPreference();
  } catch {
    // ignore motion preference failures
  }

  for (const project of projects) {
    if (!matchesDomain(project, hostname)) continue;

    for (const scriptDefinition of Object.values(project.scripts)) {
      if (!matchesScript(scriptDefinition, url)) continue;

      // ⚠️ 每个 script 的错误必须在本层隔离（本轮修复）。
      //
      // 原实现是裸的串行 await：任何一个 script 的 onstart/onactive/oncomplete/
      // onrender 抛错，整个 for 循环当场中断，**后面所有 script 一律不初始化**。
      //
      // 这不是理论风险。CI run 43666425749 的浏览器回归里，`work` script（cx.ts，
      // 匹配 /mooc2/work/dowork）在 work 页面抛错，而「📄 答题结果」面板是另一个
      // script（common.ts 的 workResults）创建的 —— 于是面板根本没挂上，用例
      // `work pages show the auto-answer countdown…` 卡在
      // `Waiting for selector #panel-common-work-results` 直到 45s 超时。
      // 本地用变异注入 `throw` 精确复现了同一失败（2 pass / 1 fail，错误文案一字不差），
      // 而 course 页面不匹配 work script，所以 138/139 一直正常 —— 这也解释了
      // 「为什么只有 work 页失败」。
      //
      // 隔离后：单个 script 失败记一条带名字的错误日志，其余 script 照常初始化。
      // 不吞错误 —— 日志里能直接看出是哪个 project 的哪个 script 挂了，
      // 比原来只有一句 `startup failed`（拿不到 script 身份）更可诊断。
      const scriptName = scriptDefinition.name;
      try {
        const script = createScriptInstance(scriptDefinition, project.name);
        const ctx = { projectName: project.name, url, hostname };
        await scriptDefinition.onstart?.call(script, ctx);
        await scriptDefinition.onactive?.call(script, ctx);
        await scriptDefinition.oncomplete?.call(script, ctx);
        if (script.panel) {
          await scriptDefinition.onrender?.call(script, { ...ctx, panel: script.panel });
        }
      } catch (error) {
        // 措辞刻意避开 `startup failed`：那个串是 src/index.ts 的「整体启动失败」
        // 信号，测试也靠它断言（openPage 的 t.after 要求 startupErrors 为空）。
        // 这里是「某个 script 失败」，语义不同，不能混用同一个串。
        // 把原因拼进字符串而不是作为第二个参数传：puppeteer 的 message.text()
        // 只能拿到格式化后的文本（第二个参数会变成 `JSHandle@error`），
        // 而这段日志的全部价值就是「在 CI 日志里看得出 work script 到底抛了什么」。
        const reason =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error(`[chaoxing-plus] script ${project.name}.${scriptName} failed: ${reason}`);
      }
    }
  }
}
