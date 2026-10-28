import { promises as fs, watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';

export const SHARED_STORE_PREFIXES = [
  'common.settings.',
  'cx.new.study.',
  'cx.new.work.',
  'cx.new.auto-read.',
  'cx.new.study-dispatcher.'
];
export const SHARED_STORE_EXCLUDED_KEYS = new Set(['common.work-results.results']);
export const SHARED_STORE_EXACT_KEYS = new Set(['common.apps.question-caches']);
export const ENABLED_KEY = 'common.settings.extension-enabled';

const DEFAULT_CONFIG = {
  clientPath: '',
  port: 0,
  expectedBrowser: 'Chrome/',
  stopClientOnExit: false,
  injectBlankFrames: true,
  captureConsole: true,
  injectStrategy: 'hybrid',
  injectRetries: 2,
  debugEndpointTimeoutMs: 30000,
  targetPollIntervalMs: 1000,
  bundleTimeoutMs: 120000,
  dpiAwareness: '',
  settings: {
    [ENABLED_KEY]: true
  }
};

export function isSharedStoreKey(key) {
  return typeof key === 'string'
    && key.length > 0
    && !SHARED_STORE_EXCLUDED_KEYS.has(key)
    && (SHARED_STORE_EXACT_KEYS.has(key) || SHARED_STORE_PREFIXES.some((prefix) => key.startsWith(prefix)));
}

export function pickSharedValues(values) {
  const result = {};
  if (!values || typeof values !== 'object') return result;
  for (const [key, value] of Object.entries(values)) {
    if (isSharedStoreKey(key)) result[key] = value;
  }
  return result;
}

export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const settings = source.settings && typeof source.settings === 'object' ? source.settings : {};
  const normalized = {
    ...DEFAULT_CONFIG,
    ...source,
    settings: {
      ...DEFAULT_CONFIG.settings,
      ...pickSharedValues(settings)
    }
  };
  normalized.port = Number.isInteger(Number(source.port)) ? Math.max(0, Math.min(65535, Number(source.port))) : 0;
  normalized.clientPath = typeof source.clientPath === 'string' ? source.clientPath.trim() : '';
  normalized.expectedBrowser = typeof source.expectedBrowser === 'string' && source.expectedBrowser
    ? source.expectedBrowser
    : DEFAULT_CONFIG.expectedBrowser;
  normalized.stopClientOnExit = normalized.stopClientOnExit === true;
  normalized.injectBlankFrames = normalized.injectBlankFrames !== false;
  normalized.captureConsole = normalized.captureConsole !== false;
  normalized.injectStrategy = ['hybrid', 'runtime', 'script'].includes(source.injectStrategy)
    ? source.injectStrategy
    : DEFAULT_CONFIG.injectStrategy;
  normalized.injectRetries = Number.isInteger(Number(source.injectRetries))
    && Number(source.injectRetries) >= 0 && Number(source.injectRetries) <= 5
    ? Number(source.injectRetries)
    : DEFAULT_CONFIG.injectRetries;
  const boundedInteger = (value, fallback, minimum, maximum) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
  };
  normalized.debugEndpointTimeoutMs = boundedInteger(source.debugEndpointTimeoutMs, DEFAULT_CONFIG.debugEndpointTimeoutMs, 1000, 120000);
  normalized.targetPollIntervalMs = boundedInteger(source.targetPollIntervalMs, DEFAULT_CONFIG.targetPollIntervalMs, 250, 10000);
  normalized.bundleTimeoutMs = boundedInteger(source.bundleTimeoutMs, DEFAULT_CONFIG.bundleTimeoutMs, 1000, 300000);
  normalized.dpiAwareness = source.dpiAwareness === 'system' ? 'system' : '';
  return normalized;
}

export function mergeConfigLayers(...layers) {
  const merged = {};
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    const previousSettings = merged.settings;
    Object.assign(merged, layer);
    if (layer.settings && typeof layer.settings === 'object' && !Array.isArray(layer.settings)) {
      merged.settings = { ...(previousSettings || {}), ...pickSharedValues(layer.settings) };
    }
  }
  return normalizeConfig(merged);
}

export function mergeHostConfigLayers({ defaultHostConfig, appConfig, selectedConfig, loadedConfig, inlineConfig }) {
  return mergeConfigLayers(
    defaultHostConfig || loadedConfig,
    appConfig,
    selectedConfig,
    inlineConfig
  );
}

export function createConfigStore(filePath, { logger = () => {}, debounceMs = 250, persistEnabled = true, onError = () => {} } = {}) {
  let config = normalizeConfig(undefined);
  let revision = 0;
  let timer = null;
  let closed = false;
  let pending = false;
  const notifyError = () => { try { onError(); } catch { /* Observers cannot change config failure handling. */ } };

  async function load() {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      config = normalizeConfig(JSON.parse(text.replace(/^\uFEFF/, '')));
      logger(`[config] 已加载 ${filePath}（revision=${revision}）`);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        logger(`[config] 未找到 ${filePath}，使用默认配置并在首次写入时创建`);
        config = normalizeConfig(undefined);
      } else {
        throw new Error(`配置文件无法读取或不是合法 JSON：${filePath}：${error.message}`);
      }
    }
    return config;
  }

  async function persist() {
    try {
      pending = false;
      const directory = path.dirname(filePath);
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, filePath);
    } catch (error) {
      notifyError();
      throw error;
    }
  }

  function schedulePersist() {
    if (closed || !persistEnabled) return;
    pending = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      void persist().catch((error) => logger(`[config] 写入失败：${error.message}`));
    }, debounceMs);
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(config));
  }

  return {
    filePath,
    get revision() {
      return revision;
    },
    get config() {
      return config;
    },
    load,
    snapshot,
    settingsSnapshot() {
      return { ...config.settings };
    },
    isEnabled() {
      return config.settings[ENABLED_KEY] !== false;
    },
    updateFromPage(changes) {
      const shared = pickSharedValues(changes);
      if (Object.keys(shared).length === 0) return false;
      let changed = false;
      for (const [key, value] of Object.entries(shared)) {
        if (JSON.stringify(config.settings[key]) !== JSON.stringify(value)) {
          config.settings[key] = value;
          changed = true;
        }
      }
      if (!changed) return false;
      revision += 1;
      schedulePersist();
      return true;
    },
    replaceFromDisk(next) {
      const normalized = normalizeConfig(next);
      const before = JSON.stringify({ settings: config.settings, port: config.port, clientPath: config.clientPath });
      config = normalized;
      revision += 1;
      const after = JSON.stringify({ settings: config.settings, port: config.port, clientPath: config.clientPath });
      return before !== after;
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending && persistEnabled) await persist();
    },
    watch({ onChange, resolveConfig = (next) => next, intervalMs = 1500 } = {}) {
      watchFile(filePath, { interval: intervalMs }, async (current) => {
        if (current.mtimeMs === 0 || closed) return;
        try {
          const text = await fs.readFile(filePath, 'utf8');
          const next = JSON.parse(text.replace(/^\uFEFF/, ''));
          const resolved = await resolveConfig(next);
          if (closed) return;
          const changed = this.replaceFromDisk(resolved);
          if (changed) {
            logger(`[config] 检测到配置文件变更，revision=${revision}`);
            onChange?.(config);
          }
        } catch (error) {
          logger(`[config] 配置文件变更解析失败（忽略本次）：${error.message}`);
          notifyError();
        }
      });
      return () => unwatchFile(filePath);
    },
    async close() {
      closed = true;
      await this.flush();
    }
  };
}

export function defaultConfigPath(rootDir) {
  return path.join(rootDir, 'windows', 'data', 'config.json');
}

export async function ensureConfigFile(rootDir, filePath, logger = () => {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
    return false;
  } catch {
    const examplePath = path.join(rootDir, 'windows', 'config.example.json');
    let template;
    try {
      template = JSON.parse(await fs.readFile(examplePath, 'utf8'));
    } catch {
      template = {};
    }
    const config = normalizeConfig(template);
    await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    logger(`[config] 已创建默认配置 ${filePath}，请检查 clientPath`);
    return true;
  }
}
