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

  for (const project of projects) {
    if (!matchesDomain(project, hostname)) continue;

    for (const scriptDefinition of Object.values(project.scripts)) {
      if (!matchesScript(scriptDefinition, url)) continue;
      const script = createScriptInstance(scriptDefinition, project.name);
      const ctx = { projectName: project.name, url, hostname };
      await scriptDefinition.onstart?.call(script, ctx);
      await scriptDefinition.onactive?.call(script, ctx);
      await scriptDefinition.oncomplete?.call(script, ctx);
      if (script.panel) {
        await scriptDefinition.onrender?.call(script, { ...ctx, panel: script.panel });
      }
    }
  }
}
