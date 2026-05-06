import { createPanelRoot } from './panel.js';
import { runtimeStore } from './store.js';
import type { ConfigMap, ScriptDefinition, ScriptInstance } from './types.js';

function buildDefaultConfig(namespace: string, configs: ConfigMap = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(configs)) {
    result[key] = runtimeStore.get(`${namespace}.${key}`, definition.defaultValue);
  }
  return result;
}

export function createScriptInstance(definition: ScriptDefinition, projectName: string): ScriptInstance {
  const namespace = definition.namespace ?? `${projectName}.${definition.name}`;
  const listeners = new Map<number, { key: string; listener: (value: any) => void }>();
  let nextListenerId = 1;
  const shouldCreatePanel = typeof definition.hideInPanel === 'function' ? !definition.hideInPanel() : !definition.hideInPanel;

  const instance: ScriptInstance = {
    name: definition.name,
    namespace,
    cfg: buildDefaultConfig(namespace, definition.configs),
    panel: shouldCreatePanel ? createPanelRoot(`panel-${namespace.replace(/[^a-z0-9_-]/gi, '-')}`) : undefined,
    methods: {},
    onConfigChange(key, listener) {
      const id = nextListenerId++;
      listeners.set(id, { key, listener });
      return id;
    },
    offConfigChange(id) {
      if (typeof id === 'number') listeners.delete(id);
    }
  };

  instance.methods = definition.methods?.call(instance) ?? {};
  return instance;
}
