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
  normalized.dpiAwareness = source.dpiAwareness === 'system' ? 'system' : '';
  return normalized;
}

export function createConfigStore(filePath, { logger = () => {}, debounceMs = 250 } = {}) {
  let config = normalizeConfig(undefined);
  let revision = 0;
  let timer = null;
  let closed = false;
  let pending = false;

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
    pending = false;
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filePath);
  }

  function schedulePersist() {
    if (closed) return;
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
      if (pending) await persist();
    },
    watch({ onChange, intervalMs = 1500 } = {}) {
      watchFile(filePath, { interval: intervalMs }, async (current) => {
        if (current.mtimeMs === 0 || closed) return;
        try {
          const text = await fs.readFile(filePath, 'utf8');
          const next = JSON.parse(text.replace(/^\uFEFF/, ''));
          const changed = this.replaceFromDisk(next);
          if (changed) {
            logger(`[config] 检测到配置文件变更，revision=${revision}`);
            onChange?.(config);
          }
        } catch (error) {
          logger(`[config] 配置文件变更解析失败（忽略本次）：${error.message}`);
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
