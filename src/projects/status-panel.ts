/**
 * 面板「状态」页：最近 24 小时服务健康度。
 *
 * 三条**不可协商**的设计约束（上一版设计被用户否决，改之前先读这里）：
 *
 * 1. **不做横向宽表格**。面板固定 360px（`runtime/panel.ts:73`），任何"时间 + 柱状 +
 *    百分比 + 图标"的宽表格都必然横向溢出，用户要的是纵向滚动。
 * 2. **不加阈值线标记**（118 §4 明确否决）。颜色本身就是严重度尺，在 1.25px 宽的格子
 *    上加小三角既是视觉噪音，又会让每格多一个子节点。
 * 3. **24h 色带保持单行**（118 §3.1）。288 格 × 1.25px 在 1x 屏上渲染成一条渐变色带——
 *    这是用户主动选择的取舍，不要再改成双行网格。
 *
 * 分档口径见 117 §3.1（11 档）与 §3.4（0% 与"无请求"必须与其余档位视觉可分）。
 */

/** 一个统计窗口的原始样本：该窗口内的请求总数与成功数。 */
export type ServiceStatusSample = {
  /** 窗口起始时间（毫秒时间戳）。调用方不必对齐，聚合时会按 5 分钟向下取整。 */
  startMs: number;
  requests: number;
  succeeded: number;
};

/** 聚合后的一个 5 分钟格子。 `successRate` 为 `null` 表示该窗口没有任何请求。 */
export type ServiceStatusBucket = {
  startMs: number;
  requests: number;
  succeeded: number;
  /**
   * `null` = 无请求。
   *
   * 必须与「有请求但全失败（0）」区分：前者是"没人用，不知道好坏"，后者是
   * "用了但全挂"。两者混同会让「凌晨没人用」被误读成「凌晨服务挂了 8 小时」。
   */
  successRate: number | null;
};

export type ServiceStatusTierId =
  | 't100' | 't99' | 't97' | 't95' | 't90'
  | 't80' | 't70' | 't50' | 't30' | 't10' | 't0'
  | 'none';

export type ServiceStatusTier = {
  id: ServiceStatusTierId;
  /** 档位下界（含），百分比 0..100。 */
  minPercent: number;
  /** 档位上界，百分比。**区间语义是半开区间 `[min, max)`**，见 {@link resolveServiceStatusTier}。 */
  maxPercent: number;
  color: string;
  label: string;
};

/** 色带格子数：24h ÷ 5min。用户决定（117 §2.1），不要改回 144。 */
export const STATUS_BUCKET_MINUTES = 5;
export const STATUS_BUCKET_COUNT = 288;
/** 色带行数恒为 1：单行渐变色带（118 §3.1）。 */
export const STATUS_BAND_ROWS = 1;
export const STATUS_BAND_COLUMNS = STATUS_BUCKET_COUNT;
export const STATUS_BUCKET_MS = STATUS_BUCKET_MINUTES * 60 * 1000;
export const STATUS_WINDOW_MS = STATUS_BUCKET_COUNT * STATUS_BUCKET_MS;
/** 「最近每分钟」列表最多显示多少行。 */
export const STATUS_MINUTE_ROW_LIMIT = 60;
/** 列表行高（含间距）：点击色带联动滚动时按它折算 scrollTop，避免依赖 offsetTop 链。 */
export const STATUS_MINUTE_ROW_HEIGHT = 26;

/** 「全部失败」：有请求，且一条都没成功。117 §3.4 要求它精确等于暗红。 */
const TIER_TOTAL_FAILURE: ServiceStatusTier = {
  id: 't0', minPercent: 0, maxPercent: 0, color: '#7f1d1d', label: '全部失败'
};

/** 「全部成功」：一条请求都没失败。纯绿单列一档，否则与 99%~99.9% 无法区分。 */
const TIER_PERFECT: ServiceStatusTier = {
  id: 't100', minPercent: 100, maxPercent: 100, color: '#15803d', label: '全部成功'
};

/**
 * 中间 9 档，按百分比半开区间 `[min, max)` 切。
 *
 * 顺序必须从低到高（`resolveServiceStatusTier` 取第一个命中的），改动顺序会静默改变分档。
 *
 * ⚠️ `t10` 的下界写的是 0，但 `resolveServiceStatusTier` 在进循环前就已把
 * **恰好 0%** 短路成暗红档，所以这一档实际覆盖的是 `(0%, 30%)`。
 * 这样 11 档 = 10 个半开区间 + 1 个"恰好 0%"单点，颜色两两不同；
 * 117 §3.4 要求"暗红精确等于全失败"，若把 (0,10%) 也划进暗红，暗红就失去这个含义。
 */
export const SERVICE_STATUS_RANGE_TIERS: readonly ServiceStatusTier[] = [
  { id: 't10', minPercent: 0, maxPercent: 30, color: '#dc2626', label: '几乎全失败' },
  { id: 't30', minPercent: 30, maxPercent: 50, color: '#ea580c', label: '严重异常' },
  { id: 't50', minPercent: 50, maxPercent: 70, color: '#f97316', label: '明显异常' },
  { id: 't70', minPercent: 70, maxPercent: 80, color: '#f59e0b', label: '轻度降级' },
  { id: 't80', minPercent: 80, maxPercent: 90, color: '#eab308', label: '偶发失败' },
  { id: 't90', minPercent: 90, maxPercent: 95, color: '#a3e635', label: '基本正常' },
  { id: 't95', minPercent: 95, maxPercent: 97, color: '#65a30d', label: '接近正常' },
  { id: 't97', minPercent: 97, maxPercent: 99, color: '#22c55e', label: '良好' },
  { id: 't99', minPercent: 99, maxPercent: 100, color: '#16a34a', label: '优秀' }
];

/**
 * 「无数据」档：该窗口没有请求。
 *
 * 用浅灰 `#d1d5db` 而不是暗红 `#7f1d1d` —— 两者在视觉上必须完全可分（116 §1.4 的红框），
 * 否则用户会把「凌晨没人用」当成「凌晨服务挂了」。
 */
export const SERVICE_STATUS_NO_DATA_TIER: ServiceStatusTier = {
  id: 'none', minPercent: 0, maxPercent: 0, color: '#d1d5db', label: '无数据'
};

/**
 * 11 档完整列表，**从差到好**（顺序即严重度）。
 *
 * 11 档 + 无数据 = 12 种状态，正好是 117 §3.2 认定的"人眼可辨上限"。
 * 加档前先读那一条：超过 12 档用户看两个格子分不出差别。
 */
export const SERVICE_STATUS_TIERS: readonly ServiceStatusTier[] = [
  TIER_TOTAL_FAILURE,
  ...SERVICE_STATUS_RANGE_TIERS,
  TIER_PERFECT
];

/** 图例顺序：从好到差，与色带阅读方向一致。 */
export const SERVICE_STATUS_LEGEND: readonly ServiceStatusTier[] = [
  ...[...SERVICE_STATUS_TIERS].reverse(),
  SERVICE_STATUS_NO_DATA_TIER
];

/**
 * 成功率（0..1）→ 档位。
 *
 * 分档语义（这是本文件唯一有意义的业务逻辑，唯一的行为断言点在这里）：
 * - `null` / 非有限数       → 无数据档（浅灰）
 * - 恰好 `0`（有请求且全失败）→ 暗红
 * - `0 < x < 30%`           → 红
 * - 中间 9 档按 `[min, max)` 半开区间
 * - 恰好 `100%`             → 纯绿
 *
 * 边界一律是 `percent >= min && percent < max`：把 `<` 改成 `<=` 会让边界值
 * 落到更差的那一档（30% 会被当成"几乎全失败"），所以边界用例必须钉死。
 */
export function resolveServiceStatusTier(successRate: number | null | undefined): ServiceStatusTier {
  if (successRate === null || successRate === undefined) {
    return SERVICE_STATUS_NO_DATA_TIER;
  }
  if (!Number.isFinite(successRate)) {
    return SERVICE_STATUS_NO_DATA_TIER;
  }
  const percent = Math.min(100, Math.max(0, Number(successRate) * 100));
  if (percent === 100) {
    return TIER_PERFECT;
  }
  if (percent === 0) {
    return TIER_TOTAL_FAILURE;
  }
  for (const tier of SERVICE_STATUS_RANGE_TIERS) {
    if (percent >= tier.minPercent && percent < tier.maxPercent) {
      return tier;
    }
  }
  // 理论上不可达（区间已覆盖 (0,100)），兜底成最差档而不是抛错：
  // 状态页渲染失败会让整块面板变成错误页，比颜色不准严重得多。
  return TIER_TOTAL_FAILURE;
}

/** 成功率 → 展示文案。`100%` 不写小数，`99.9%` 保留一位。 */
export function formatServiceStatusPercent(successRate: number | null | undefined): string {
  if (successRate === null || successRate === undefined || !Number.isFinite(successRate)) {
    return '无数据';
  }
  const percent = Math.min(100, Math.max(0, Number(successRate) * 100));
  const text = percent === 0 || percent === 100 ? String(Math.round(percent)) : percent.toFixed(1);
  return `${text}%`;
}

/** 毫秒时间戳 → `HH:mm`（本地时区）。 */
export function formatServiceStatusClock(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * 把「现在」向下对齐到 5 分钟边界，作为 24h 窗口的右端。
 *
 * 为什么要对齐：不对齐的话每次渲染的格子起点都在漂，色带上同一段故障会左右抖动；
 * 对齐后同一个 5 分钟内的多次渲染得到完全相同的 288 个格子。
 */
export function alignServiceStatusWindowEnd(nowMs: number): number {
  const value = Number.isFinite(nowMs) ? Number(nowMs) : 0;
  return Math.floor(value / STATUS_BUCKET_MS) * STATUS_BUCKET_MS;
}

/**
 * 第 `index` 格（0..287）的起始时间。
 *
 * 这就是 288 格 → 24h 的映射算式，别在别处重算：
 * ```
 * endMs        = floor(now / 300000) * 300000
 * windowStart  = endMs - 288 * 300000        // 24 小时前
 * cellStart(i) = windowStart + i * 300000    // i=0 → 24h 前；i=287 → 最近 5 分钟
 * cellEnd(i)   = cellStart(i) + 300000
 * ```
 */
export function resolveServiceStatusBucketStart(nowMs: number, index: number): number {
  return alignServiceStatusWindowEnd(nowMs) - STATUS_WINDOW_MS + index * STATUS_BUCKET_MS;
}

/**
 * 逐样本 → 恒定 288 格。
 *
 * 三条必须遵守的规则：
 * 1. **恒定 288 格**：窗口外（更早或未来）的样本直接丢弃，格子数不随数据变化，
 *    否则色带长度会变，点击联动与"哪一格对应几点"全部错位。
 * 2. **同格样本累加**：成功数 / 请求数分别累加，成功率最后统一算，
 *    这样得到的是**加权平均**（成功总数 ÷ 请求总数），不是各分钟的简单平均。
 * 3. 无请求的格子 `successRate` 必须是 `null`，不能填 0。
 */
export function buildServiceStatusBuckets(
  samples: readonly ServiceStatusSample[],
  nowMs: number
): ServiceStatusBucket[] {
  const windowStart = alignServiceStatusWindowEnd(nowMs) - STATUS_WINDOW_MS;
  const buckets: ServiceStatusBucket[] = [];
  for (let index = 0; index < STATUS_BUCKET_COUNT; index += 1) {
    buckets.push({
      startMs: windowStart + index * STATUS_BUCKET_MS,
      requests: 0,
      succeeded: 0,
      successRate: null
    });
  }

  const byStart = new Map<number, ServiceStatusBucket>();
  for (const bucket of buckets) {
    byStart.set(bucket.startMs, bucket);
  }

  for (const sample of samples) {
    if (!sample || !Number.isFinite(sample.startMs)) {
      continue;
    }
    const aligned = Math.floor(Number(sample.startMs) / STATUS_BUCKET_MS) * STATUS_BUCKET_MS;
    const bucket = byStart.get(aligned);
    if (!bucket) {
      continue;
    }
    const requests = Number(sample.requests);
    const succeeded = Number(sample.succeeded);
    if (!Number.isFinite(requests) || requests <= 0) {
      continue;
    }
    bucket.requests += requests;
    bucket.succeeded += Number.isFinite(succeeded) ? Math.max(0, succeeded) : 0;
  }

  for (const bucket of buckets) {
    bucket.successRate = bucket.requests > 0 ? bucket.succeeded / bucket.requests : null;
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// 数据来源：抽成可注入的 fetcher，便于接 T-18 的 GET /adapter-service/admin/service-status
// ---------------------------------------------------------------------------

export type ServiceStatusBreakdown = {
  upstream: number;
  timeout: number;
  auth: number;
  quota: number;
};

export type ServiceStatusSnapshot = {
  /** `healthy` | `degraded` | `down`，未知值按「无数据」渲染。 */
  status: string;
  /** 最近 5 分钟成功率（0..1）。 */
  successRate: number | null;
  avgLatencyMs: number | null;
  totalRequests: number;
  failedRequests: number;
  breakdown: ServiceStatusBreakdown;
  /** 24 小时逐 5 分钟样本。 */
  buckets: ServiceStatusSample[];
  /** 最近 60 分钟逐分钟样本（用于「最近每分钟」列表，最新在前由渲染层排序）。 */
  minuteSamples: ServiceStatusSample[];
  updatedAt: number;
};

export type ServiceStatusFetchOptions = { now: number };

/** 一次拉取。失败请抛错——调用方会保留旧快照并降级显示，不会清空。 */
export type ServiceStatusFetcher = (options: ServiceStatusFetchOptions) => Promise<ServiceStatusSnapshot | null>;

/** T-18 的后端端点（尚未合并，先按约定写死在这里，接上后只需换 fetcher）。 */
export const SERVICE_STATUS_ENDPOINT = '/adapter-service/admin/service-status';

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeSamples(value: unknown): ServiceStatusSample[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const samples: ServiceStatusSample[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const startMs = toFiniteNumber(record.startMs ?? record.start_ms ?? record.ts);
    const requests = toFiniteNumber(record.requests ?? record.total);
    if (startMs === null || requests === null) {
      continue;
    }
    const succeeded = toFiniteNumber(record.succeeded ?? record.success);
    samples.push({ startMs, requests, succeeded: succeeded ?? 0 });
  }
  return samples;
}

/**
 * 后端响应 → 内部快照。字段名同时接受 camelCase 与 snake_case，
 * 因为 T-18 的响应结构尚未定稿；未知/缺失字段一律降级为 0 / null，不抛错。
 */
export function normalizeServiceStatusSnapshot(raw: unknown): ServiceStatusSnapshot | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const payload = asRecord(record.data) ?? record;
  const breakdownRecord = asRecord(payload.breakdown) ?? {};
  const successRate = toFiniteNumber(payload.successRate ?? payload.success_rate);
  return {
    status: String(payload.status ?? '').trim(),
    successRate: successRate === null ? null : Math.min(1, Math.max(0, successRate)),
    avgLatencyMs: toFiniteNumber(payload.avgLatencyMs ?? payload.avg_latency_ms),
    totalRequests: toFiniteNumber(payload.totalRequests ?? payload.total_requests) ?? 0,
    failedRequests: toFiniteNumber(payload.failedRequests ?? payload.failed_requests) ?? 0,
    breakdown: {
      upstream: toFiniteNumber(breakdownRecord.upstream) ?? 0,
      timeout: toFiniteNumber(breakdownRecord.timeout) ?? 0,
      auth: toFiniteNumber(breakdownRecord.auth) ?? 0,
      quota: toFiniteNumber(breakdownRecord.quota) ?? 0
    },
    buckets: normalizeSamples(payload.buckets ?? payload.history),
    minuteSamples: normalizeSamples(payload.minuteSamples ?? payload.minute_samples ?? payload.minutes),
    updatedAt: toFiniteNumber(payload.updatedAt ?? payload.updated_at ?? payload.ts) ?? 0
  };
}

/** 用注入的请求函数构造 fetcher：T-18 合并后只需 `setServiceStatusFetcher(createHttpServiceStatusFetcher(...))`。 */
export function createHttpServiceStatusFetcher(
  request: (endpoint: string) => Promise<unknown>,
  endpoint: string = SERVICE_STATUS_ENDPOINT
): ServiceStatusFetcher {
  return async () => normalizeServiceStatusSnapshot(await request(endpoint));
}

/**
 * 固定 fixture：T-18 的接口没合并前用它开工。
 *
 * 刻意包含三种形态，方便肉眼验收：夜间无请求（灰）、一段全失败（暗红）、
 * 一段部分失败（橙/黄），以及大量全成功（绿）。
 */
export function createFixtureServiceStatusSnapshot(nowMs: number = Date.now()): ServiceStatusSnapshot {
  const windowStart = alignServiceStatusWindowEnd(nowMs) - STATUS_WINDOW_MS;
  const buckets: ServiceStatusSample[] = [];
  for (let index = 0; index < STATUS_BUCKET_COUNT; index += 1) {
    const startMs = windowStart + index * STATUS_BUCKET_MS;
    if (index < 96) {
      // 00:00~08:00 无请求
      buckets.push({ startMs, requests: 0, succeeded: 0 });
    } else if (index >= 192 && index < 198) {
      // 一段完全不可用
      buckets.push({ startMs, requests: 25, succeeded: 0 });
    } else if (index >= 198 && index < 204) {
      // 恢复期：约 60%
      buckets.push({ startMs, requests: 30, succeeded: 18 });
    } else if (index >= 240 && index < 246) {
      // 轻微抖动：约 97%
      buckets.push({ startMs, requests: 32, succeeded: 31 });
    } else {
      buckets.push({ startMs, requests: 30 + (index % 7), succeeded: 30 + (index % 7) });
    }
  }

  const minuteSamples: ServiceStatusSample[] = [];
  const minuteAlignedNow = Math.floor(nowMs / 60000) * 60000;
  for (let index = 0; index < STATUS_MINUTE_ROW_LIMIT; index += 1) {
    const startMs = minuteAlignedNow - index * 60000;
    if (index === 0) {
      minuteSamples.push({ startMs, requests: 0, succeeded: 0 });
    } else if (index === 3) {
      minuteSamples.push({ startMs, requests: 38, succeeded: 0 });
    } else if (index === 4) {
      minuteSamples.push({ startMs, requests: 38, succeeded: 5 });
    } else {
      const requests = 20 + (index % 9);
      minuteSamples.push({ startMs, requests, succeeded: requests });
    }
  }

  return {
    status: 'healthy',
    successRate: 0.992,
    avgLatencyMs: 234,
    totalRequests: 1240,
    failedRequests: 10,
    breakdown: { upstream: 8, timeout: 2, auth: 0, quota: 0 },
    buckets,
    minuteSamples,
    updatedAt: nowMs
  };
}

let serviceStatusFetcher: ServiceStatusFetcher = async (options) => createFixtureServiceStatusSnapshot(options.now);
let cachedServiceStatusSnapshot: ServiceStatusSnapshot | null = null;
let serviceStatusRefreshPromise: Promise<ServiceStatusSnapshot | null> | null = null;

export function setServiceStatusFetcher(fetcher: ServiceStatusFetcher): void {
  serviceStatusFetcher = fetcher;
}

export function getServiceStatusFetcher(): ServiceStatusFetcher {
  return serviceStatusFetcher;
}

export function readCachedServiceStatusSnapshot(): ServiceStatusSnapshot | null {
  return cachedServiceStatusSnapshot;
}

export function setCachedServiceStatusSnapshot(snapshot: ServiceStatusSnapshot | null): void {
  cachedServiceStatusSnapshot = snapshot;
}

/**
 * 拉一次并写入缓存。并发调用共享同一个 Promise（避免首屏连发两次）。
 *
 * 失败**不清缓存**：状态页显示一份旧数据比显示空白有用得多，`updatedAt` 会说明它有多旧。
 */
export function refreshServiceStatusSnapshot(
  options: Partial<ServiceStatusFetchOptions> = {}
): Promise<ServiceStatusSnapshot | null> {
  if (serviceStatusRefreshPromise) {
    return serviceStatusRefreshPromise;
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  serviceStatusRefreshPromise = (async () => {
    try {
      const snapshot = await serviceStatusFetcher({ now });
      if (snapshot) {
        cachedServiceStatusSnapshot = snapshot;
      }
      return cachedServiceStatusSnapshot;
    } catch {
      return cachedServiceStatusSnapshot;
    } finally {
      serviceStatusRefreshPromise = null;
    }
  })();
  return serviceStatusRefreshPromise;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 渲染只需要用到这些主题色，单独定义避免 status-panel 依赖 common.ts 的完整 palette。 */
export type ServiceStatusPanelTheme = {
  surfaceStrong: string;
  surface: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  subtle: string;
  primaryDeep: string;
  successFg: string;
  warningFg: string;
  dangerFg: string;
};

export type ServiceStatusPanelOptions = {
  theme: ServiceStatusPanelTheme;
  snapshot?: ServiceStatusSnapshot | null;
  now?: number;
  /** 「立即刷新」的入口。缺省时按钮置灰并写明原因，不留死按钮。 */
  onRequestRefresh?: () => void;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag);
}

function createSectionCard(theme: ServiceStatusPanelTheme) {
  const card = el('div');
  card.style.display = 'grid';
  card.style.gap = '10px';
  card.style.padding = '12px';
  card.style.borderRadius = '14px';
  card.style.background = theme.surfaceStrong;
  card.style.border = `1px solid ${theme.border}`;
  // 所有区块都必须能收缩：状态页在 360px 面板里，任何子节点撑宽都会横向溢出。
  card.style.minWidth = '0';
  card.style.maxWidth = '100%';
  card.style.boxSizing = 'border-box';
  return card;
}

function createSectionTitle(theme: ServiceStatusPanelTheme, text: string) {
  const title = el('div');
  title.textContent = text;
  title.style.fontSize = '13px';
  title.style.fontWeight = '800';
  title.style.lineHeight = '1.4';
  title.style.color = theme.text;
  title.style.minWidth = '0';
  return title;
}

function createHintLine(theme: ServiceStatusPanelTheme, text: string) {
  const line = el('div');
  line.textContent = text;
  line.style.fontSize = '12px';
  line.style.lineHeight = '1.6';
  line.style.color = theme.subtle;
  line.style.minWidth = '0';
  line.style.whiteSpace = 'normal';
  line.style.overflowWrap = 'anywhere';
  line.style.wordBreak = 'break-word';
  return line;
}

type StatusTone = { color: string; text: string };

function resolveStatusTone(snapshot: ServiceStatusSnapshot | null, theme: ServiceStatusPanelTheme): StatusTone {
  const status = String(snapshot?.status ?? '').trim().toLowerCase();
  if (status === 'healthy') return { color: theme.successFg, text: '正常' };
  if (status === 'degraded') return { color: theme.warningFg, text: '降级' };
  if (status === 'down') return { color: theme.dangerFg, text: '异常' };
  return { color: theme.muted, text: '无数据' };
}

function createSummaryCard(
  snapshot: ServiceStatusSnapshot | null,
  theme: ServiceStatusPanelTheme,
  onRequestRefresh: (() => void) | undefined
) {
  const card = createSectionCard(theme);
  card.dataset.cxStatusSummary = 'true';

  const tone = resolveStatusTone(snapshot, theme);
  const headRow = el('div');
  headRow.style.display = 'flex';
  headRow.style.alignItems = 'center';
  headRow.style.gap = '8px';
  headRow.style.minWidth = '0';

  const dot = el('span');
  dot.style.display = 'inline-block';
  dot.style.width = '9px';
  dot.style.height = '9px';
  dot.style.borderRadius = '999px';
  dot.style.background = tone.color;
  dot.style.flex = '0 0 auto';
  dot.dataset.cxStatusDot = tone.text;

  const label = el('div');
  label.textContent = tone.text;
  label.style.fontSize = '14px';
  label.style.fontWeight = '800';
  label.style.lineHeight = '1.4';
  label.style.color = tone.color;
  label.style.minWidth = '0';

  headRow.append(dot, label);
  card.append(headRow);

  const rateText = snapshot
    ? `成功率 ${formatServiceStatusPercent(snapshot.successRate)}  ·  延迟 ${snapshot.avgLatencyMs === null ? '未知' : `${snapshot.avgLatencyMs}ms`}`
    : '还没有拉到服务状态数据。';
  card.append(createHintLine(theme, rateText));

  if (snapshot) {
    card.append(createHintLine(theme, `最近 5 分钟 · ${snapshot.totalRequests} 次请求 · 失败 ${snapshot.failedRequests} 次`));
    const parts = [
      ['上游超时', snapshot.breakdown.upstream],
      ['鉴权失败', snapshot.breakdown.auth],
      ['配额耗尽', snapshot.breakdown.quota],
      ['其他失败', snapshot.breakdown.timeout]
    ] as const;
    const breakdownText = parts
      .filter(([, value]) => value > 0)
      .map(([name, value]) => `${name} ${value}`)
      .join(' · ');
    card.append(createHintLine(theme, breakdownText ? `失败分类（1h）：${breakdownText}` : '失败分类（1h）：无失败'));
  }

  const footer = el('div');
  footer.style.display = 'flex';
  footer.style.alignItems = 'center';
  footer.style.justifyContent = 'space-between';
  footer.style.gap = '8px';
  footer.style.minWidth = '0';
  footer.style.flexWrap = 'wrap';

  const updated = createHintLine(
    theme,
    snapshot && snapshot.updatedAt > 0
      ? `数据自 ${formatServiceStatusClock(snapshot.updatedAt)} 起`
      : '数据来源：固定样例（后端接口未接入）'
  );
  footer.append(updated);

  const refresh = el('button');
  refresh.type = 'button';
  refresh.textContent = '立即刷新';
  refresh.style.minHeight = '28px';
  refresh.style.padding = '0 10px';
  refresh.style.borderRadius = '9px';
  refresh.style.border = `1px solid ${theme.borderStrong}`;
  refresh.style.background = theme.surface;
  refresh.style.color = onRequestRefresh ? theme.primaryDeep : theme.muted;
  refresh.style.cursor = onRequestRefresh ? 'pointer' : 'default';
  refresh.style.fontSize = '12px';
  refresh.style.fontWeight = '700';
  refresh.disabled = !onRequestRefresh;
  if (!onRequestRefresh) {
    refresh.title = '状态页刷新入口未接线';
  }
  refresh.onclick = () => {
    if (onRequestRefresh) onRequestRefresh();
  };
  footer.append(refresh);

  card.append(footer);
  return card;
}

type MinuteList = { element: HTMLElement; scrollTo: (startMs: number) => void };

function createMinuteList(snapshot: ServiceStatusSnapshot | null, theme: ServiceStatusPanelTheme): MinuteList {
  const card = createSectionCard(theme);
  card.append(createSectionTitle(theme, '最近每分钟（最新在上）'));

  const list = el('div');
  list.dataset.cxStatusMinutes = 'true';
  list.style.display = 'grid';
  list.style.gap = '4px';
  // position:relative 是 `scrollTo` 用 offsetTop 的前提：没有它，行的 offsetParent
  // 会落到更外层（面板 root），offsetTop 变成相对整页的坐标，滚动位置直接算飞。
  list.style.position = 'relative';
  list.style.maxHeight = '190px';
  list.style.overflowY = 'auto';
  list.style.overflowX = 'hidden';
  list.style.overscrollBehavior = 'contain';
  list.style.scrollbarWidth = 'thin';
  list.style.minWidth = '0';
  list.style.maxWidth = '100%';

  const rows = (snapshot?.minuteSamples ?? [])
    .map((sample) => ({
      startMs: sample.startMs,
      requests: Math.max(0, Number(sample.requests) || 0),
      succeeded: Math.max(0, Number(sample.succeeded) || 0)
    }))
    .sort((left, right) => right.startMs - left.startMs)
    .slice(0, STATUS_MINUTE_ROW_LIMIT)
    .map((sample) => ({
      ...sample,
      successRate: sample.requests > 0 ? sample.succeeded / sample.requests : null
    }));

  if (rows.length === 0) {
    list.append(createHintLine(theme, '暂无逐分钟数据。'));
    card.append(list);
    return { element: card, scrollTo: () => undefined };
  }

  rows.forEach((row) => {
    const tier = resolveServiceStatusTier(row.successRate);
    const item = el('div');
    // 三列定宽 + 一列可收缩：`minmax(0, 1fr)` 是防止长文本把行撑宽的关键。
    item.style.display = 'grid';
    item.style.gridTemplateColumns = '42px 10px minmax(0, 1fr)';
    item.style.alignItems = 'center';
    item.style.gap = '6px';
    item.style.minHeight = `${STATUS_MINUTE_ROW_HEIGHT - 4}px`;
    item.style.minWidth = '0';
    item.dataset.cxStatusMinute = String(row.startMs);
    item.dataset.cxStatusTier = tier.id;

    const clock = el('span');
    clock.textContent = formatServiceStatusClock(row.startMs);
    clock.style.fontSize = '12px';
    clock.style.color = theme.muted;

    const swatch = el('span');
    swatch.style.display = 'inline-block';
    swatch.style.width = '10px';
    swatch.style.height = '10px';
    swatch.style.borderRadius = '3px';
    swatch.style.background = tier.color;

    const detail = el('span');
    detail.textContent = `${formatServiceStatusPercent(row.successRate)}  ·  ${row.requests} 次`;
    detail.style.fontSize = '12px';
    detail.style.color = theme.text;
    detail.style.minWidth = '0';
    detail.style.overflow = 'hidden';
    detail.style.textOverflow = 'ellipsis';
    detail.style.whiteSpace = 'nowrap';

    item.append(clock, swatch, detail);
    list.append(item);
  });

  card.append(list);

  const scrollTo = (startMs: number) => {
    const index = rows.findIndex((row) => row.startMs <= startMs);
    const target = index >= 0 ? index : rows.length - 1;
    try {
      // 优先用真实元素偏移：行高由内容与字体决定，不是常量。
      // 早先按 `STATUS_MINUTE_ROW_HEIGHT` 折算会随字号/折行累积误差，实测滚到第 53 行
      // 而不是第 59 行（60 行列表，行高 22px + 间距 4px 时折算值必然偏小）。
      const targetNode = list.children[target] as HTMLElement | undefined;
      const offset = targetNode?.offsetTop;
      list.scrollTop = typeof offset === 'number' && Number.isFinite(offset) && offset >= 0
        ? offset
        : Math.max(0, target * STATUS_MINUTE_ROW_HEIGHT);
    } catch {
      // 无布局环境（测试沙箱）下滚动失败不影响其它功能。
    }
  };

  return { element: card, scrollTo };
}

function createDayBand(
  buckets: readonly ServiceStatusBucket[],
  theme: ServiceStatusPanelTheme,
  scrollToMinute: (startMs: number) => void
) {
  const card = createSectionCard(theme);
  card.dataset.cxStatusDayBand = 'true';
  card.append(createSectionTitle(theme, '24 小时预览'));

  const band = el('div');
  band.dataset.cxStatusBand = 'true';
  band.setAttribute('role', 'img');
  band.setAttribute('aria-label', `最近 24 小时成功率色带，共 ${STATUS_BUCKET_COUNT} 格，每格 ${STATUS_BUCKET_MINUTES} 分钟`);
  band.style.display = 'flex';
  // 单行（118 §3.1）：行数恒为 1，不要再改成双行网格。
  band.style.flexWrap = 'nowrap';
  band.style.width = '100%';
  band.style.maxWidth = '100%';
  band.style.height = '26px';
  band.style.borderRadius = '6px';
  band.style.overflow = 'hidden';
  band.style.boxSizing = 'border-box';
  band.style.background = SERVICE_STATUS_NO_DATA_TIER.color;
  band.dataset.cxStatusBandRows = String(STATUS_BAND_ROWS);

  for (let index = 0; index < STATUS_BUCKET_COUNT; index += 1) {
    const bucket = buckets[index];
    const tier = resolveServiceStatusTier(bucket ? bucket.successRate : null);
    const cell = el('div');
    cell.dataset.cxStatusCell = String(index);
    cell.dataset.cxStatusTier = tier.id;
    cell.dataset.cxStatusStart = String(bucket ? bucket.startMs : 0);
    // flex-basis 0 + min-width 0：288 格等分容器宽度，任何一格都不会把父级撑宽。
    cell.style.flex = '1 1 0';
    cell.style.width = '0';
    cell.style.minWidth = '0';
    cell.style.height = '100%';
    cell.style.background = tier.color;
    // 不加阈值线标记（118 §4）：格子内保持零子节点，只有颜色。
    cell.title = bucket
      ? `${formatServiceStatusClock(bucket.startMs)} · 成功率 ${formatServiceStatusPercent(bucket.successRate)} · ${bucket.requests} 次请求`
      : '无数据';
    cell.onclick = () => {
      scrollToMinute(bucket ? bucket.startMs : 0);
    };
    band.append(cell);
  }

  card.append(band);

  const axis = el('div');
  axis.style.display = 'flex';
  axis.style.justifyContent = 'space-between';
  axis.style.gap = '4px';
  axis.style.minWidth = '0';
  const firstStart = buckets.length > 0 ? buckets[0].startMs : 0;
  const middleStart = buckets.length > 0 ? buckets[Math.floor(STATUS_BUCKET_COUNT / 2)].startMs : 0;
  const lastStart = buckets.length > 0 ? buckets[buckets.length - 1].startMs : 0;
  for (const text of [
    formatServiceStatusClock(firstStart),
    formatServiceStatusClock(middleStart),
    `现在 ${formatServiceStatusClock(lastStart + STATUS_BUCKET_MS)}`
  ]) {
    const tick = el('span');
    tick.textContent = text;
    tick.style.fontSize = '11px';
    tick.style.color = theme.subtle;
    tick.style.whiteSpace = 'nowrap';
    axis.append(tick);
  }
  card.append(axis);

  // 图例：固定 3 列网格（12 项 → 4 行）。用 grid 而不是 flex-wrap，
  // 每项宽度由列宽封顶，360px 下无论文案多长都不会横向溢出。
  const legend = el('div');
  legend.dataset.cxStatusLegend = 'true';
  legend.style.display = 'grid';
  legend.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
  legend.style.gap = '4px 6px';
  legend.style.minWidth = '0';
  for (const tier of SERVICE_STATUS_LEGEND) {
    const item = el('div');
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.gap = '5px';
    item.style.minWidth = '0';
    item.dataset.cxStatusLegendTier = tier.id;

    const swatch = el('span');
    swatch.style.display = 'inline-block';
    swatch.style.width = '9px';
    swatch.style.height = '9px';
    swatch.style.borderRadius = '2px';
    swatch.style.flex = '0 0 auto';
    swatch.style.background = tier.color;

    const text = el('span');
    text.textContent = tier.label;
    text.style.fontSize = '11px';
    text.style.color = theme.muted;
    text.style.minWidth = '0';
    text.style.overflow = 'hidden';
    text.style.textOverflow = 'ellipsis';
    text.style.whiteSpace = 'nowrap';

    item.append(swatch, text);
    legend.append(item);
  }
  card.append(legend);

  card.append(createHintLine(theme, '每格 5 分钟；悬停看具体值，点击跳到对应分钟。无数据格是灰色，不是最低档。'));
  return card;
}

/**
 * 状态页主体：三个区块纵向排列（当前状态 / 24 小时预览 / 最近每分钟）。
 *
 * 返回的元素不依赖任何 common.ts 符号，可以被单独抽取执行。
 */
export function createStatusPanelSection(options: ServiceStatusPanelOptions): HTMLElement {
  const theme = options.theme;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const snapshot = options.snapshot ?? null;
  const buckets = buildServiceStatusBuckets(snapshot?.buckets ?? [], now);

  const container = el('div');
  container.dataset.cxStatusPanel = 'true';
  container.style.display = 'grid';
  container.style.gap = '12px';
  container.style.minWidth = '0';
  container.style.maxWidth = '100%';
  container.style.boxSizing = 'border-box';

  // 先建列表，色带点击要引用它的滚动函数；再按「状态 → 色带 → 列表」的视觉顺序挂载。
  const minuteList = createMinuteList(snapshot, theme);
  container.append(
    createSummaryCard(snapshot, theme, options.onRequestRefresh),
    createDayBand(buckets, theme, minuteList.scrollTo),
    minuteList.element
  );
  return container;
}

/** 状态页在被裁掉的端（或数据源异常）时的占位说明。 */
export function createStatusPanelUnavailableView(theme: ServiceStatusPanelTheme, reason: string): HTMLElement {
  const container = el('div');
  container.dataset.cxStatusPanel = 'unavailable';
  container.style.display = 'grid';
  container.style.gap = '8px';
  container.style.padding = '14px';
  container.style.borderRadius = '14px';
  container.style.background = theme.surfaceStrong;
  container.style.border = `1px dashed ${theme.borderStrong}`;
  container.style.minWidth = '0';
  container.style.maxWidth = '100%';
  container.style.boxSizing = 'border-box';
  container.append(createSectionTitle(theme, '服务状态不可用'), createHintLine(theme, reason));
  return container;
}
