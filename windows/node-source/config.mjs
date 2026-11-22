import { promises as fs, watchFile, unwatchFile } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

// 设备标识的存储键。**必须与扩展侧（src/runtime/device-identity.ts）和原生侧
// （windows/native-source/device-quota.h 的 CX_DEVICE_ID_KEY）逐字一致** ——
// 这三处任何一处改名，注入到 chrome.storage 的键扩展就读不到。
// scripts/device-quota.test.mjs 对三处做交叉断言。
export const DEVICE_ID_KEY = 'common.settings.device-id';
export const DEVICE_INSTANCE_KEY = 'common.settings.device-instance';

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

/**
 * 从共享设置里取宿主 device_id；没有/不合法时返回空串。
 * device_id 表示「这个 exe 宿主的浏览器 profile」，要跨重启复用（141 §5.1），
 * 所以它是持久值；client_instance 相反，每个会话新生成、绝不持久化（141 §4.3）。
 */
export function hostDeviceId(settings) {
  const value = settings && typeof settings === 'object' ? settings[DEVICE_ID_KEY] : undefined;
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : '';
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

export function createConfigStore(filePath, { logger = () => {}, debounceMs = 250, persistEnabled = true, onError = () => {}, onPersist = () => {} } = {}) {
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
    ensureDeviceId();
    return config;
  }

  /**
   * 宿主 device_id：有就复用，没有就生成 UUIDv4 写进 settings。
   *
   * 写盘**只经过 schedulePersist**（即 persist()），不另开写盘逻辑：
   *   - persistEnabled = !noDiskWrite，所以 --no-disk-write 下 schedulePersist 是 no-op，
   *     不会绕过「不写盘」约定；
   *   - 仍是原有的临时文件 + rename 原子写，不会与页面下发的配置互相截断。
   * 返回本次生效的 deviceId（即使不落盘也返回，供本次运行使用）。
   */
  function ensureDeviceId() {
    const existing = hostDeviceId(config.settings);
    if (existing) return existing;
    const generated = randomUUID();
    config.settings[DEVICE_ID_KEY] = generated;
    revision += 1;
    // ⚠️ 这里**不**调 schedulePersist()（2026-11-15 修，合入后实测红）。
    //
    // 原先调用它，后果是启动时立刻排一次 250ms debounce 写盘。这带来两个问题：
    //
    // 1) **print 模式违约**：--print-effective-config 的契约是「不写配置」，
    //    但它没开 noDiskWrite，于是这次写盘真的发生（windows-print-effective-config
    //    的断言「print mode must not rewrite the config file」实测红）。
    //
    // 2) **与 watch 抢同一个文件**：watch({intervalMs:1500}) 靠 mtime 判变化。
    //    启动那一次写盘与「用户/测试随后修改 config.json」叠在一起时，watch 的
    //    mtime 比对会把真实变更判成未变化 → onConfigChange 不触发 → 不广播。
    //    windows-host 的「配置热更新不能改变本次启动的 noDiskWrite 策略」因此在
    //    任何 noDiskWrite 取值下都红（实测 pass 37 / fail 1）。
    //
    // 不调度 debounce 写盘，但要标脏：这样 flush() / 后续任何真实写入都会把它一起落盘。
    // 只标脏不排定时器，既避免「启动即写」，又保证 device_id 不会丢（否则每次重启
    // 都会生成新 ID → 占掉一个新设备槽位，违背 R5「exe 宿主槽位稳定」）。
    if (persistEnabled) pending = true;
    return generated;
  }

  async function persist() {
    try {
      pending = false;
      const directory = path.dirname(filePath);
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, filePath);
      try { onPersist(); } catch { /* A diagnostic observer must not change save semantics. */ }
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
    /** 当前生效的 device_id（不生成，可能为空）。 */
    deviceId() {
      return hostDeviceId(config.settings);
    },
    /** 需要时生成并（在允许写盘时）持久化 device_id；返回本次生效值。 */
    ensureDeviceId,
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
    const examplePath = path.join(rootDir, 'windows', 'share-file', 'config.example.json');
    let template;
    try {
      const text = typeof globalThis.__CX_EMBEDDED_CONFIG_EXAMPLE__ === 'string'
        ? globalThis.__CX_EMBEDDED_CONFIG_EXAMPLE__
        : await fs.readFile(examplePath, 'utf8');
      template = JSON.parse(text);
    } catch {
      template = {};
    }
    const config = normalizeConfig(template);
    await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    logger(`[config] 已创建默认配置 ${filePath}，请检查 clientPath`);
    return true;
  }
}
