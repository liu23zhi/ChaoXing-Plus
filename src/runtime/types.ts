export type MatchRule = [label: string, pattern: string | RegExp];

export interface ConfigDefinition<T = unknown> {
  defaultValue: T;
  label?: string;
  attrs?: Record<string, string | number | boolean>;
  options?: Array<[string, string, string?]>;
  elementClassName?: string;
  providerClassName?: string;
  labelClassName?: string;
  showIf?: string;
  separator?: string;
}

export type ConfigMap = Record<string, ConfigDefinition>;

export interface ScriptLifecycleContext {
  projectName: string;
  url: string;
  hostname: string;
}

export interface ScriptPanel {
  root: HTMLElement;
  body: HTMLElement;
  lockWrapper: HTMLElement;
  configsContainer: HTMLElement;
}

export interface ScriptInstance {
  name: string;
  namespace?: string;
  cfg: Record<string, unknown>;
  panel?: ScriptPanel;
  methods: Record<string, (...args: any[]) => any>;
  onConfigChange(key: string, listener: (value: any) => void): number;
  offConfigChange(id?: number): void;
}

export interface ScriptDefinition {
  name: string;
  namespace?: string;
  matches: MatchRule[];
  hideInPanel?: boolean | (() => boolean);
  configs?: ConfigMap;
  methods?: (this: ScriptInstance) => Record<string, (...args: any[]) => any>;
  onstart?: (this: ScriptInstance, ctx: ScriptLifecycleContext) => void | Promise<void>;
  onactive?: (this: ScriptInstance, ctx: ScriptLifecycleContext) => void | Promise<void>;
  oncomplete?: (this: ScriptInstance, ctx: ScriptLifecycleContext) => void | Promise<void>;
  onrender?: (this: ScriptInstance, ctx: ScriptLifecycleContext & { panel: ScriptPanel }) => void | Promise<void>;
}

export interface ProjectDefinition {
  name: string;
  domains: string[];
  scripts: Record<string, ScriptDefinition>;
}
