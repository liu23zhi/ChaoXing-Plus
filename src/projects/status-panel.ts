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
  avgLatencyMs?: number | null;
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
// 数据来源：抽成可注入的 fetcher，便于接 T-18 的 GET /api/admin/service-status
// ---------------------------------------------------------------------------

export type ServiceStatusBreakdown = {
  upstream: number;
  timeout: number;
  auth: number;
  quota: number;
};

/** 普通状态页公开的搜题接口分桶摘要（不混用全站聚合）。 */
export type SearchEndpointStatus = {
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  successRate: number | null;
  totalRequests: number;
  successRequests: number;
  avgLatencyMs: number | null;
  samples: number;
};

/**
 * 快照的三种**互斥**语义。这是本文件最重要的一条约定。
 *
 * 为什么不能只用一个 snapshot + 空数组表达：
 * - 「还没采到数据」（后端刚重启，`points: []`）与「所有分钟都没请求」在数据层
 *   长得一样，但用户看到的必须是两件完全不同的事（「暂无采样数据」vs 一条灰带）。
 * - 「无权限」（403）连数据都没有，塞进 snapshot 就会渲染出「全部失败」的假象。
 *
 * 所以用 `kind` 区分，渲染层据它决定画什么。**不要**把 403 或空 points
 * 归一化成「一个全 0 的快照」——那正是任务书点名的那个最容易做错的坑。
 */
/**
 * 快照语义。五态互斥，**不能合并**——每种对应完全不同的用户动作。
 *
 * - `ok`：有数据（含「全失败」，那也走 ok）
 * - `empty`：窗口内没有请求（正常夜间）
 * - `no-token`：**前端就知道**没配访问令牌，压根没发请求 → 引导去填令牌
 * - `rejected`：发了请求但被拒（401/403）→ 显示服务端原因（key 失效/被禁用/是脚本令牌）
 * - `forbidden`：**当前无任何产出点**，见下方说明
 *
 * 为什么 `no-token` 与 `rejected` 必须分开：前者是「你还没填」，
 * 后者是「你填了但服务端不接受」——后者可能是 key 失效、被禁用、或绑定了 ScriptID
 * 的脚本令牌（服务端会明说「脚本请求必须使用绑定身份码的运行会话」）。
 * 合并成一个「无权限」会让用户完全无从下手。
 *
 * ## ⚠️ `forbidden` 是死分支（2026-11-14 端到端实测确认）
 *
 * 当前**没有任何代码产出 `kind='forbidden'`**：`status-panel-http.ts` 只产出
 * `no-token` 与 `rejected` 两种「看不了」。检索 `kind: 'forbidden'` 零命中，
 * 只有消费点（渲染层）。
 *
 * 为什么留着而不是删掉：将来接管理员视图时，需要表达「有 key 但角色不足」这一态。
 * 但**它没有被任何用例覆盖到**，改动相关代码时不要假定它已测过。
 *
 * 实测背景（captain 起真实 TIKU 实例打的）：
 * - `GET /api/service-status/summary` 无凭据 → **401**「请重新登录」
 * - 同上 + 非法 Bearer → **401**
 * - 同上 + 真实 access token → **200**（这条路才是 PLUS 实际走的）
 * - `GET /api/admin/service-status` + **有效普通 token** → **401**（不是 403！）
 *
 * 最后一条是关键：`controller.Auth`（`user.go:213-232`）在 `ParseJwtWithClaims` 失败时
 * 直接 401 返回；access token 不是 JWT，所以在 `RequireAdmin` 之前就被 401 拦掉了。
 * ⇒ **不要基于「403 表示权限不足」这种常规假设写分支**，这个服务里 403 在这条链路上
 * 根本到不了。`RequireAdmin` 的 403 只对「合法 JWT 但 role != admin」生效，
 * 而 PLUS 没有登录态，永远拿不到 JWT。
 */
export type ServiceStatusSnapshotKind = 'ok' | 'empty' | 'no-token' | 'rejected' | 'forbidden';

/** `rejected` 的子因由。渲染文案据此分流。 */
export type ServiceStatusAuthProblem = 'unauthorized' | 'forbidden';

export type ServiceStatusSnapshot = {
  /** 该快照代表哪种语义。见 {@link ServiceStatusSnapshotKind}。 */
  kind: ServiceStatusSnapshotKind;
  /**
   * 服务端权威开关：窗口内是否有可用于计算成功率的请求。
   *
   * `true` + `successRate === 0` = **全失败**（必须显示最差档，不是「暂无数据」）；
   * `false` = 窗口内没有请求（正常夜间）；
   * `null` = 后端没给这个字段（admin 端点 / 旧响应），此时靠 `retained` 回退判断。
   */
  successRateAvailable: boolean | null;
  /** 仅 `kind === 'rejected'` 时有意义：区分 401（配令牌）与 403（找管理员）。 */
  authProblem?: ServiceStatusAuthProblem;
  /**
   * 仅 `kind === 'rejected'` 时有意义：**服务端返回的原始 message**。
   *
   * 必须原样显示给用户 —— 像「脚本请求必须使用绑定身份码的运行会话」这种原因
   * 只有服务端知道，前端统一成「无权限」就把真正的指引丢了。
   */
  serverMessage?: string;
  /** `healthy` | `degraded` | `down` | `unknown`，未知值按「无数据」渲染。 */
  status: string;
  /** 最近 5 分钟成功率（0..1）。 */
  successRate: number | null;
  avgLatencyMs: number | null;
  totalRequests: number;
  failedRequests: number;
  breakdown: ServiceStatusBreakdown;
  /**
   * 24 小时逐 5 分钟**原始样本**（后端给的是逐分钟点，这里是未聚合的 minute 点）。
   * 聚合到 288 格由 {@link buildServiceStatusBuckets} 负责。
   *
   * `kind === 'empty'` 时**必须**是空数组，绝不能填 288/1440 个 0。
   */
  buckets: ServiceStatusSample[];
  /** 最近 60 分钟逐分钟样本（用于「最近每分钟」列表，最新在前由渲染层排序）。 */
  minuteSamples: ServiceStatusSample[];
  /**
   * 后端已采到的点数（`retained`）。**判断「有没有数据」用这个字段，不要用
   * `buckets.length` 反推** —— 接口明确给出了语义字段，反推是脆弱的重复推导。
   */
  retained: number;
  /** 缓冲容量（`capacity`，当前 1440）。 */
  capacity: number;
  /**
   * 采样起点（ms）。后端给的是 ISO 字符串 `restartedAt`，这里已 parse 成毫秒。
   * 用于显示「数据自 <时间> 起」。无法 parse 时为 `null`（不显示，而不是显示 1970）。
   */
  restartedAtMs: number | null;
  updatedAt: number;
  /** 新版摘要端点的搜题专属分桶。缺失时必须显示无数据，不能回退成全站状态。 */
  search?: SearchEndpointStatus | null;
  /** 独立搜题分钟序列；null/缺失表示旧服务未提供或历史请求失败，[]表示尚无采样。 */
  searchHistory?: ServiceStatusSample[] | null;
  searchHistoryTiming?: { asOfMs: number | null; restartMs: number | null; latestMs: number | null };
  searchSummaryAsOfMs?: number | null;
  searchSummaryWindowMinutes?: number;
};

export type ServiceStatusFetchOptions = { now: number };

/** 一次拉取。失败请抛错——调用方会保留旧快照并降级显示，不会清空。 */
export type ServiceStatusFetcher = (options: ServiceStatusFetchOptions) => Promise<ServiceStatusSnapshot | null>;

/**
 * 普通用户可用的**摘要**端点（`controller.AuthOrAccessToken`）。
 *
 * 为什么不用 `/admin/service-status`：那条是 `RequireAdmin` + 带逐分钟 `points`，
 * 定位是「运维可见信息」——「什么时段多少请求、成功多少、平均延迟」是运营情报，
 * 不该开给每个持 key 的用户。摘要端点只给聚合数字。
 */
export const SERVICE_STATUS_ENDPOINT = '/api/service-status/summary';
export const SERVICE_STATUS_SERIES_ENDPOINT = '/api/service-status/series';

/**
 * 管理员端点（`RequireAdmin` + 逐分钟 points）。
 *
 * 当前**不接**——PLUS 没有管理员登录态。保留常量是为了将来做管理员视图时不用再找
 * 一次路径；也用来在注释里说明「为什么不能拿它给普通用户用」。
 */
export const SERVICE_STATUS_ADMIN_ENDPOINT = '/api/admin/service-status';

/**
 * `points[].minute` 是「Unix 时间戳 / 60」（`internal/service/service_status.go:37`）。
 * 换算成毫秒要 ×60（得到秒）×1000。
 */
const SERVICE_STATUS_MINUTE_UNIT_MS = 60 * 1000;

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 后端 `points[]`（逐分钟点）→ 内部样本。
 *
 * 后端字段是 `minute`（Unix 秒 / 60）、`totalRequests`、`successRequests`
 * （`internal/service/service_status.go:35-51`），必须按它换算，否则整条色带错位。
 * 同时保留旧字段名兼容（`startMs`/`requests`/`succeeded`），
 * 因为测试与 fixture 走的是内部命名。
 */
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
    // `minute` 是「Unix 秒 / 60」，×60000 才是毫秒。
    const minute = toFiniteNumber(record.minute);
    const startMs = minute !== null
      ? minute * SERVICE_STATUS_MINUTE_UNIT_MS
      : toFiniteNumber(record.startMs ?? record.start_ms ?? record.ts);
    const requests = toFiniteNumber(record.totalRequests ?? record.requests ?? record.total);
    if (startMs === null || requests === null) {
      continue;
    }
    const succeeded = toFiniteNumber(record.successRequests ?? record.succeeded ?? record.success);
    samples.push({ startMs, requests, succeeded: succeeded ?? 0 });
  }
  // 后端 `Points()` 已按时间升序，但保险起见排一遍：色带位置必须单调。
  samples.sort((left, right) => left.startMs - right.startMs);
  return samples;
}

function parseSearchHistory(value: unknown): ServiceStatusSample[] | null {
  if (!Array.isArray(value) || value.length > STATUS_WINDOW_MS / 60_000) return null;
  const byMinute = new Set<number>();
  const samples: ServiceStatusSample[] = [];
  for (const raw of value) {
    const point = asRecord(raw);
    if (!point) return null;
    const { minute, totalRequests, successRequests, avgLatencyMs } = point;
    const safe = (field: unknown): field is number => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
    if (!safe(minute) || !safe(totalRequests) || !safe(successRequests) ||
      successRequests > totalRequests || byMinute.has(minute) || minute * 60_000 > 8.64e15 ||
      (avgLatencyMs !== undefined && !safe(avgLatencyMs))) return null;
    byMinute.add(minute);
    samples.push({ startMs: minute * 60_000, requests: totalRequests, succeeded: successRequests,
      avgLatencyMs: safe(avgLatencyMs) ? avgLatencyMs : null });
  }
  return samples;
}

function parseHistoryTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  return parseIsoToMs(value);
}

/** ISO 字符串 → 毫秒。解析失败返回 null（渲染层据此不显示「自 1970 起」）。 */
function parseIsoToMs(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSearchEndpointStatus(payload: Record<string, unknown>, requireVerifiedSearch: boolean): SearchEndpointStatus | null {
  const endpoints = asRecord(payload.endpoints); // Never borrow a nested admin summary.
  const search = asRecord(endpoints?.search);
  if (!search) return null;
  if (requireVerifiedSearch) {
    const { totalRequests, successRequests, avgLatencyMs, samples } = search;
    const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (!count(totalRequests) || !count(successRequests) || !count(avgLatencyMs) || !count(samples) ||
      successRequests > totalRequests || (totalRequests > 0 && samples === 0)) return null;
  }

  const totalRequests = Math.max(0, toFiniteNumber(search.totalRequests ?? search.total_requests) ?? 0);
  const successRequests = Math.min(totalRequests, Math.max(0, toFiniteNumber(search.successRequests ?? search.success_requests) ?? 0));
  const samples = Math.max(0, toFiniteNumber(search.samples) ?? 0);
  const successRate = totalRequests > 0 ? successRequests / totalRequests : null;
  let status: SearchEndpointStatus['status'] = 'unknown';
  if (samples > 0 && successRate !== null) {
    status = successRate >= 0.95 ? 'healthy' : successRate >= 0.7 ? 'degraded' : 'down';
  }

  return {
    status,
    successRate,
    totalRequests,
    successRequests,
    // The backend uses zero for an empty bucket; present that as unknown latency.
    avgLatencyMs: totalRequests > 0
      ? Math.max(0, toFiniteNumber(search.avgLatencyMs ?? search.avg_latency_ms) ?? 0)
      : null,
    samples
  };
}

/**
 * 后端响应 → 内部快照。
 *
 * 响应结构（`internal/controller/service_status.go:17-26`）：
 * ```
 * { schemaVersion, status, windowMinutes, points[], summary{}, capacity, retained, restartedAt }
 * ```
 * 现在有两个数据源，**语义判定优先用服务端权威字段**：
 *
 * 1. **摘要端点**（`/api/service-status/summary`，普通用户可用）：
 *    `{ schemaVersion, status, successRate, successRateAvailable, totalRequests,
 *       successRequests, failedRequests, avgLatencyMs, windowMinutes, retained,
 *       capacity, restartedAt }` —— **没有 points**。
 * 2. **admin 端点**（`/api/admin/service-status`，仅管理员）：带 `points[]`。
 *
 * 判定顺序（缺一不可）：
 * - `successRateAvailable === false` → `kind='empty'`（窗口内没有请求）
 * - `successRateAvailable === true`  → `kind='ok'`，**哪怕 successRate 是 0**
 * - 没有该字段时（admin 端点 / 旧响应）回退到 `retained === 0` 与点数
 * - 401/403 → 由 {@link createHttpServiceStatusFetcher} 产出 `kind='forbidden'`
 *
 * ⚠️ 为什么必须有 `successRateAvailable`：只给 `successRate: 0` 时前端无法区分
 * 「全失败」（要报警）与「没请求」（正常夜间）。这两个都必须能正确表达。
 */
export function normalizeServiceStatusSnapshot(raw: unknown, requireVerifiedSearch = false): ServiceStatusSnapshot | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const payload = asRecord(record.data) ?? record;
  const summary = asRecord(payload.summary) ?? {};
  const breakdownRecord = asRecord(summary.breakdown) ?? asRecord(payload.breakdown) ?? {};
  const search = normalizeSearchEndpointStatus(payload, requireVerifiedSearch);
  const searchWindow = payload.windowMinutes;

  const successRate = toFiniteNumber(summary.successRate ?? payload.successRate ?? payload.success_rate);
  const samples = normalizeSamples(payload.points ?? payload.buckets ?? payload.history);
  const retainedRaw = toFiniteNumber(payload.retained);
  // `retained` 是接口给出的语义字段；缺失时（旧/裁剪过的响应）才回退到点数。
  const retained = retainedRaw === null ? samples.length : Math.max(0, Math.round(retainedRaw));

  // 服务端权威开关。三态取值：true / false / undefined（字段不存在）。
  const availableRaw = payload.successRateAvailable ?? payload.success_rate_available;
  const successRateAvailable = typeof availableRaw === 'boolean'
    ? availableRaw
    // 兼容：字符串 "true"/"false" 也算（防御后端 JSON 化差异）。
    : typeof availableRaw === 'string' && /^(true|false)$/i.test(availableRaw.trim())
      ? availableRaw.trim().toLowerCase() === 'true'
      : undefined;

  // ⚠️ 这里是本任务最容易做错的一处：`points: []` 表示「还没采到数据」，
  // **不是**「所有分钟都没请求」。绝不能把它补成 1440/288 个 0 ——
  // 那会让整条色带渲染成深灰「全部失败」，用户会以为服务挂了。
  //
  // 有 `successRateAvailable` 时**以它为准**：`true` 且 successRate=0 是「全失败」，
  // 必须落 ok（走最差档配色并报警感），不能因为 0 就当成「没数据」。
  const isEmpty = successRateAvailable !== undefined
    ? successRateAvailable === false
    : retained === 0 || samples.length === 0;

  return {
    kind: isEmpty ? 'empty' : 'ok',
    successRateAvailable: successRateAvailable ?? null,
    status: String(summary.status ?? payload.status ?? '').trim(),
    successRate: successRate === null ? null : Math.min(1, Math.max(0, successRate)),
    avgLatencyMs: toFiniteNumber(summary.avgLatencyMs ?? summary.avg_latency_ms ?? payload.avgLatencyMs ?? payload.avg_latency_ms),
    totalRequests: toFiniteNumber(summary.totalRequests ?? summary.total_requests ?? payload.totalRequests ?? payload.total_requests) ?? 0,
    failedRequests: toFiniteNumber(summary.failedRequests ?? summary.failed_requests ?? payload.failedRequests ?? payload.failed_requests) ?? 0,
    breakdown: {
      upstream: toFiniteNumber(breakdownRecord.upstream) ?? 0,
      timeout: toFiniteNumber(breakdownRecord.timeout) ?? 0,
      auth: toFiniteNumber(breakdownRecord.auth) ?? 0,
      quota: toFiniteNumber(breakdownRecord.quota) ?? 0
    },
    // 空快照必须是空数组，不是 288/1440 个 0。
    buckets: isEmpty ? [] : samples,
    minuteSamples: isEmpty ? [] : samples,
    retained,
    capacity: toFiniteNumber(payload.capacity) ?? 0,
    restartedAtMs: parseIsoToMs(payload.restartedAt ?? payload.restarted_at),
    updatedAt: toFiniteNumber(payload.updatedAt ?? payload.updated_at ?? payload.ts) ?? Date.now(),
    search,
    searchSummaryAsOfMs: parseHistoryTime(payload.asOf),
    searchSummaryWindowMinutes: typeof searchWindow === 'number' && Number.isSafeInteger(searchWindow) && searchWindow > 0 && searchWindow <= 1440
      ? searchWindow : undefined,
    // points 是全站序列，不能用它为搜题接口补历史；当前窗口空也不丢失旧时段请求。
    searchHistory: parseSearchHistory(payload.searchPoints),
    searchHistoryTiming: Object.prototype.hasOwnProperty.call(payload, 'asOf') ? {
      asOfMs: parseHistoryTime(payload.asOf), restartMs: parseHistoryTime(payload.restartedAt),
      latestMs: parseHistoryTime(payload.latestSampleAt)
    } : undefined
  };
}

/**
 * 「发了请求但被拒」快照（401/403）。
 *
 * 落 `kind='rejected'`（渲染层不画任何图表），并**原样带上服务端 message**。
 *
 * 为什么必须带 message：服务端会说「脚本请求必须使用绑定身份码的运行会话」
 * 这类**只有服务端才知道**的原因（用户配的 adapter key 若绑定 ScriptID 就会被拒，
 * 见 `search_account_config.go:272-273`）。前端猜不出 key 类型，也不该猜 ——
 * 把原话透出来，用户才知道该换哪种令牌。没有 message 时才回退到按状态码的通用文案。
 */
export function createRejectedServiceStatusSnapshot(
  authProblem: ServiceStatusAuthProblem = 'unauthorized',
  serverMessage: string = ''
): ServiceStatusSnapshot {
  return {
    kind: 'rejected',
    authProblem,
    serverMessage: String(serverMessage ?? '').trim(),
    successRateAvailable: null,
    status: 'unknown',
    successRate: null,
    avgLatencyMs: null,
    totalRequests: 0,
    failedRequests: 0,
    breakdown: { upstream: 0, timeout: 0, auth: 0, quota: 0 },
    buckets: [],
    minuteSamples: [],
    retained: 0,
    capacity: 0,
    restartedAtMs: null,
    updatedAt: Date.now()
  };
}

/**
 * 「压根没配令牌」快照：**前端就知道**，不需要发请求。
 *
 * 与 `rejected` 分开是因为用户动作完全不同：
 * - no-token → 「去题库配置填令牌」
 * - rejected → 「你填了但服务端不接受，原因见服务端 message」
 *
 * 合并会让没填令牌的用户去研究服务端配置，反之亦然。
 */
export function createNoTokenServiceStatusSnapshot(): ServiceStatusSnapshot {
  return {
    kind: 'no-token',
    successRateAvailable: null,
    status: 'unknown',
    successRate: null,
    avgLatencyMs: null,
    totalRequests: 0,
    failedRequests: 0,
    breakdown: { upstream: 0, timeout: 0, auth: 0, quota: 0 },
    buckets: [],
    minuteSamples: [],
    retained: 0,
    capacity: 0,
    restartedAtMs: null,
    updatedAt: Date.now()
  };
}

/**
 * 兼容旧名：等价于「被拒且原因是 403」。
 * @deprecated 用 {@link createRejectedServiceStatusSnapshot}。
 */
export function createForbiddenServiceStatusSnapshot(
  authProblem: ServiceStatusAuthProblem = 'forbidden'
): ServiceStatusSnapshot {
  return createRejectedServiceStatusSnapshot(authProblem);
}

/** 请求结果：区分「拿到数据」与「无权限」。非 403 的错误仍然抛，走「保留旧快照」路径。 */
export type ServiceStatusHttpResult =
  | { ok: true; body: unknown }
  | { ok: false; forbidden: true; status: number };

/**
 * 用注入的请求函数构造 fetcher。
 *
 * `request` 由调用方提供（宿主侧既有封装），本模块不直接碰 `fetch`，
 * 这样 Windows/CEF75 与扩展端可以各用自己的通道。
 *
 * 403 → `kind='forbidden'`（**不是**空图、**不是**「全部失败」）；
 * 其它失败 → 抛错，由 {@link refreshServiceStatusSnapshot} 保留旧快照。
 */
export function createHttpServiceStatusFetcher(
  request: (endpoint: string) => Promise<unknown>,
  endpoint: string = SERVICE_STATUS_ENDPOINT
): ServiceStatusFetcher {
  return async () => {
    let raw: unknown;
    try {
      raw = await request(endpoint);
    } catch (error) {
      const status = Number((error as { status?: unknown } | undefined)?.status);
      if (status === 403) {
        return createForbiddenServiceStatusSnapshot();
      }
      throw error;
    }
    const result = raw as Partial<ServiceStatusHttpResult> | undefined;
    if (result && result.ok === false && result.forbidden === true) {
      return createForbiddenServiceStatusSnapshot();
    }
    return normalizeServiceStatusSnapshot(result && result.ok === true ? result.body : raw);
  };
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
    kind: 'ok',
    successRateAvailable: true,
    status: 'healthy',
    successRate: 0.992,
    avgLatencyMs: 234,
    totalRequests: 1240,
    failedRequests: 10,
    breakdown: { upstream: 8, timeout: 2, auth: 0, quota: 0 },
    buckets,
    minuteSamples,
    retained: STATUS_BUCKET_COUNT,
    capacity: 1440,
    restartedAtMs: windowStart,
    updatedAt: nowMs,
    searchHistory: buckets,
    search: {
      status: 'healthy',
      successRate: 0.992,
      totalRequests: 1240,
      successRequests: 1230,
      avgLatencyMs: 234,
      samples: 5
    }
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
  // 「看不了」优先于一切：它既不是异常也不是无数据，必须有自己的文案，
  // 否则用户会把权限问题读成「服务挂了」。
  if (snapshot?.kind === 'no-token') {
    return { color: theme.muted, text: '未配置访问令牌' };
  }
  if (snapshot?.kind === 'rejected') {
    return {
      color: theme.muted,
      text: snapshot.authProblem === 'forbidden' ? '无权查看' : '令牌未通过验证'
    };
  }
  // 防御性分支：`kind === 'forbidden'` 当前无产出点，保留给将来的管理员视图。
  if (snapshot?.kind === 'forbidden') {
    return { color: theme.muted, text: '无权查看' };
  }
  const status = String(snapshot?.status ?? '').trim().toLowerCase();
  if (status === 'healthy') return { color: theme.successFg, text: '正常' };
  if (status === 'degraded') return { color: theme.warningFg, text: '降级' };
  if (status === 'down') return { color: theme.dangerFg, text: '异常' };
  return { color: theme.muted, text: '无数据' };
}

function describeRecentSearchIdle(snapshot: ServiceStatusSnapshot | null, windowMinutes: number): string {
  const at = snapshot?.searchSummaryAsOfMs;
  const seriesAt = snapshot?.searchHistoryTiming?.asOfMs;
  // Samples span the entire retained day; that counter alone cannot prove
  // current coverage. Compare only the independently anchored search series.
  if (at == null || seriesAt == null || seriesAt < at || !snapshot?.searchHistory) {
    return '最近窗口的搜题采样覆盖未知。';
  }
  const last = Math.floor(at / HISTORY_MINUTE_MS) * HISTORY_MINUTE_MS;
  const first = last - (windowMinutes - 1) * HISTORY_MINUTE_MS;
  const observed = snapshot.searchHistory.filter(point => point.startMs >= first && point.startMs <= last);
  if (!observed.length) return '最近窗口暂无搜题采样。';
  if (observed.some(point => point.requests !== 0)) return '最新搜题序列与摘要时点不同，请以对应时段明细为准。';
  return observed.length === windowMinutes ? '最近采样窗口内没有搜题请求。' : '最近窗口覆盖不足；已采样分钟没有搜题请求。';
}

function createSearchStatusCard(
  snapshot: ServiceStatusSnapshot | null,
  theme: ServiceStatusPanelTheme,
  onRequestRefresh: (() => void) | undefined
): HTMLElement {
  const card = createSectionCard(theme);
  card.dataset.cxStatusSearch = 'true';
  card.append(createSectionTitle(theme, '搜题接口'));

  const search = snapshot?.search ?? null;
  let tone: StatusTone;
  if (snapshot?.kind === 'no-token' || snapshot?.kind === 'rejected' || snapshot?.kind === 'forbidden') {
    tone = resolveStatusTone(snapshot, theme);
  } else if (!search || search.samples === 0 || search.status === 'unknown') {
    tone = { color: theme.muted, text: '无数据' };
  } else if (search.status === 'healthy') {
    tone = { color: theme.successFg, text: '正常' };
  } else if (search.status === 'degraded') {
    tone = { color: theme.warningFg, text: '降级' };
  } else {
    tone = { color: theme.dangerFg, text: '异常' };
  }

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

  if (snapshot?.kind === 'no-token') {
    card.append(createHintLine(theme, '状态数据需要通过访问令牌读取。请在「题库配置」里填写 tikuAdapter 访问令牌后刷新。'));
  } else if (snapshot?.kind === 'rejected' || snapshot?.kind === 'forbidden') {
    const serverMessage = String(snapshot.serverMessage ?? '').trim();
    card.append(createHintLine(theme, serverMessage || (snapshot.authProblem === 'forbidden'
      ? '当前访问令牌无权读取状态数据，请联系管理员确认权限。'
      : '访问令牌未通过服务端验证，请检查题库配置中的令牌。')));
  } else if (!search) {
    card.append(createHintLine(theme, '当前服务暂未提供搜题接口统计，请更新题库服务后重试。'));
  } else if (search.samples === 0) {
    card.append(createHintLine(theme, '尚未采集到搜题接口状态数据。'));
  } else if (search.totalRequests === 0) {
    card.append(createHintLine(theme, describeRecentSearchIdle(snapshot, snapshot?.searchSummaryWindowMinutes ?? 5)));
  } else {
    const latency = search.avgLatencyMs === null ? '未知' : `${Math.round(search.avgLatencyMs)}ms`;
    card.append(createHintLine(theme, `成功率 ${formatServiceStatusPercent(search.successRate)} · 平均延迟 ${latency}`));
    card.append(createHintLine(theme, `最近 ${snapshot?.searchSummaryWindowMinutes ?? 5} 分钟 · ${search.successRequests} 次成功 / ${search.totalRequests} 次请求`));
  }

  const footer = el('div');
  footer.style.display = 'flex';
  footer.style.alignItems = 'center';
  footer.style.justifyContent = 'space-between';
  footer.style.gap = '8px';
  footer.style.minWidth = '0';
  footer.style.flexWrap = 'wrap';
  footer.append(createHintLine(theme, snapshot
    ? snapshot.searchSummaryAsOfMs != null ? '服务器统计截至 ' + historyTime(snapshot.searchSummaryAsOfMs, true) + '（北京时间）'
      : '本机读取时间 ' + historyTime(snapshot.updatedAt, true) + '（北京时间）'
    : '尚未取到搜题接口状态数据。'));

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
  if (!onRequestRefresh) refresh.title = '状态页刷新入口未接线';
  refresh.onclick = () => onRequestRefresh?.();
  footer.append(refresh);
  card.append(footer);
  return card;
}

type SearchHistoryBucket = ServiceStatusBucket & { points: ServiceStatusSample[] };
type SearchHistoryView = {
  available: boolean;
  serverClock: boolean;
  asOfMs: number;
  restartMs: number | null;
  latestMs: number | null;
  buckets: SearchHistoryBucket[];
};

const HISTORY_MINUTE_MS = 60_000;
const shanghaiDateTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function historyTime(ms: number, seconds = false): string {
  const value = shanghaiDateTime.format(ms);
  return seconds ? value : value.slice(0, -3);
}

function buildSearchHistoryView(snapshot: ServiceStatusSnapshot | null, fallbackNow: number): SearchHistoryView {
  const timing = snapshot?.searchHistoryTiming;
  const history = snapshot?.searchHistory;
  const available = Array.isArray(history) && timing?.asOfMs !== null;
  const asOfMs = timing?.asOfMs ?? fallbackNow;
  const restartMs = timing?.restartMs ?? null;
  const latestMs = available && timing?.latestMs != null && timing.latestMs <= asOfMs &&
    (restartMs === null || timing.latestMs >= restartMs) ? timing.latestMs : null;
  const currentMinute = Math.floor(asOfMs / HISTORY_MINUTE_MS) * HISTORY_MINUTE_MS;
  // Use the exact provider minute window. Its newest five minutes are also
  // the summary window; re-aligning to clock multiples of five drops data.
  const start = currentMinute + HISTORY_MINUTE_MS - STATUS_WINDOW_MS;
  const generationStart = restartMs !== null ? Math.floor(restartMs / HISTORY_MINUTE_MS) * HISTORY_MINUTE_MS : start;
  const buckets: SearchHistoryBucket[] = Array.from({ length: STATUS_BUCKET_COUNT }, (_, index) => ({
    startMs: start + index * STATUS_BUCKET_MS, points: [], requests: 0, succeeded: 0, successRate: null
  }));
  if (available) {
    for (const point of history) {
      if (point.startMs < Math.max(start, generationStart) || point.startMs > currentMinute) continue;
      const bucket = buckets[Math.floor((point.startMs - start) / STATUS_BUCKET_MS)];
      bucket.points.push(point);
      bucket.requests += point.requests;
      bucket.succeeded += point.succeeded;
    }
  }
  for (const bucket of buckets) {
    if (bucket.requests > 0) bucket.successRate = bucket.succeeded / bucket.requests;
  }
  return { available, serverClock: typeof timing?.asOfMs === 'number', asOfMs, restartMs, latestMs, buckets };
}

function searchHistoryLabel(view: SearchHistoryView, bucket: SearchHistoryBucket): string {
  if (!view.available) return '历史暂不可用';
  if (!bucket.points.length) return '暂无采样';
  if (!bucket.requests) return '已采样无请求';
  if (!bucket.succeeded) return '全失败';
  return bucket.succeeded === bucket.requests ? '全部成功' : '部分失败';
}

function searchHistoryInterval(view: SearchHistoryView, bucket: SearchHistoryBucket): string {
  return historyTime(bucket.startMs) + ' – ' + historyTime(Math.min(view.asOfMs, bucket.startMs + STATUS_BUCKET_MS));
}

let searchHistoryId = 0;

function createSearchHistoryBand(snapshot: ServiceStatusSnapshot | null, theme: ServiceStatusPanelTheme, nowMs: number): HTMLElement {
  const card = createSectionCard(theme);
  card.dataset.cxStatusHistory = 'search';
  card.append(createSectionTitle(theme, '最近 24 小时'));
  const view = buildSearchHistoryView(snapshot, nowMs);
  const { buckets } = view;
  const last = buckets.length - 1;
  const zoomId = 'cx-search-history-' + (++searchHistoryId);
  const band = el('button');
  band.type = 'button';
  band.dataset.cxStatusBand = 'search';
  band.setAttribute('aria-label', '查看最近24小时搜题状态放大层，使用方向键和 Home 或 End 选择时段');
  band.setAttribute('aria-controls', zoomId);
  band.setAttribute('aria-describedby', zoomId + '-detail');
  band.setAttribute('aria-expanded', 'false');
  Object.assign(band.style, {
    display: 'flex', flexWrap: 'nowrap', width: '100%', minWidth: '0',
    height: '44px', alignItems: 'center', border: '0', borderRadius: '6px',
    padding: '0', background: 'transparent', cursor: 'zoom-in', outlineOffset: '3px'
  });

  const detail = createHintLine(theme, '');
  detail.id = zoomId + '-detail';
  detail.dataset.cxStatusBucketDetail = 'true';
  detail.setAttribute('role', 'status');
  detail.setAttribute('aria-live', 'polite');

  const layer = el('section');
  layer.id = zoomId;
  layer.hidden = true;
  layer.dataset.cxStatusZoom = 'true';
  layer.setAttribute('aria-label', '放大时段与分钟样本');
  Object.assign(layer.style, {
    minWidth: '0', maxWidth: '100%', boxSizing: 'border-box',
    border: '1px solid ' + theme.border, borderRadius: '8px', padding: '8px', overflowWrap: 'anywhere'
  });
  const zoomHeading = createSectionTitle(theme, '放大时段');
  const axisText = createHintLine(theme, '');
  const zoomSummary = createHintLine(theme, '');
  const navigation = el('div');
  Object.assign(navigation.style, { display: 'flex', justifyContent: 'space-between', gap: '4px', flexWrap: 'wrap' });
  const zoomButton = (label: string): HTMLButtonElement => {
    const button = el('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      minHeight: '44px', minWidth: '0', border: '1px solid ' + theme.border,
      borderRadius: '6px', padding: '4px 6px', background: theme.surface, color: theme.text, font: 'inherit',
      fontSize: '12px', cursor: 'pointer'
    });
    return button;
  };
  const previous = zoomButton('上一时段');
  const next = zoomButton('下一时段');
  const closeButton = zoomButton('收起');
  navigation.append(previous, next, closeButton);
  const choices = el('div');
  Object.assign(choices.style, { display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: '3px' });
  const choiceButtons = Array.from({ length: 5 }, () => zoomButton(''));
  choices.append(...choiceButtons);
  const minuteRows = Array.from({ length: 5 }, () => createHintLine(theme, ''));
  const minutes = el('div');
  minutes.setAttribute('aria-label', '真实分钟观测');
  minutes.append(...minuteRows);
  layer.append(zoomHeading, axisText, navigation, choices, zoomSummary, minutes);

  let selected = last;
  let openedBy: 'hover' | 'focus' | 'click' | null = null;
  let restoringFocus = false;
  const choose = (index: number) => {
    selected = Math.min(last, Math.max(0, index));
    const bucket = buckets[selected];
    const interval = searchHistoryInterval(view, bucket);
    const summary = searchHistoryLabel(view, bucket);
    const ratio = bucket.requests > 0
      ? ' · 成功率 ' + formatServiceStatusPercent(bucket.successRate) + ' · ' + bucket.requests + ' 次请求'
      : '';
    const eligible = Math.min(5, Math.floor((view.asOfMs - bucket.startMs) / HISTORY_MINUTE_MS) + 1);
    const beforeRestart = (at: number) => view.restartMs !== null &&
      at < Math.floor(view.restartMs / HISTORY_MINUTE_MS) * HISTORY_MINUTE_MS;
    const expected = Array.from({ length: eligible }, (_, i) => bucket.startMs + i * HISTORY_MINUTE_MS)
      .filter(at => !beforeRestart(at)).length;
    const incomplete = view.available && bucket.points.length > 0 && bucket.points.length < expected
      ? ' · 覆盖不足' : '';
    detail.textContent = interval + ' · ' + summary + ratio + incomplete;
    if (!openedBy) return;
    axisText.textContent = view.serverClock
      ? '北京时间（UTC+8） · 近 5 自然分钟一格 · 截至 ' + historyTime(view.asOfMs, true)
      : '北京时间（UTC+8） · 服务未提供服务器时钟，暂按本机时点定位';
    const relativeStart = Math.min(last - 4, Math.max(0, selected - 2));
    for (let i = 0; i < choiceButtons.length; i++) {
      const slot = relativeStart + i;
      const choice = buckets[slot];
      const button = choiceButtons[i];
      button.textContent = historyTime(choice.startMs).slice(-5);
      button.setAttribute('aria-label', searchHistoryInterval(view, choice) + ' · ' + searchHistoryLabel(view, choice));
      button.setAttribute('aria-pressed', String(slot === selected));
      button.style.background = slot === selected ? theme.surfaceStrong : theme.surface;
      button.style.borderBottom = '4px solid ' + resolveServiceStatusTier(choice.successRate).color;
      button.onclick = () => choose(slot);
    }
    previous.disabled = selected === 0;
    next.disabled = selected === last;
    const generation = view.restartMs === null ? '' : ' · 重启采样自 ' + historyTime(view.restartMs, true);
    const coverage = !view.available ? '' : expected === 0 ? ' · 重启前暂无采样'
      : ' · 已采样 ' + bucket.points.length + '/' + expected + ' 分钟';
    zoomSummary.textContent = detail.textContent + coverage + generation;
    for (let i = 0; i < minuteRows.length; i++) {
      const at = bucket.startMs + i * HISTORY_MINUTE_MS;
      const point = bucket.points.find(item => item.startMs === at);
      const row = minuteRows[i];
      row.hidden = i >= eligible || !view.available;
      const label = !point ? (beforeRestart(at) ? '重启前 · 暂无采样' : '暂无采样')
        : !point.requests ? '已采样无请求 · 0 次请求'
        : (point.succeeded === 0 ? '全失败' : point.succeeded === point.requests ? '全部成功' : '部分失败')
          + ' · ' + point.succeeded + ' 次成功 / ' + point.requests + ' 次请求'
          + (point.avgLatencyMs == null ? '' : ' · ' + point.avgLatencyMs + ' 毫秒');
      row.textContent = row.hidden ? '' : historyTime(at) + ' · ' + label;
    }
  };
  const open = (cause: 'hover' | 'focus' | 'click') => {
    openedBy = cause;
    layer.hidden = false;
    band.setAttribute('aria-expanded', 'true');
    choose(selected);
  };
  const close = (returnFocus = false) => {
    openedBy = null;
    layer.hidden = true;
    band.setAttribute('aria-expanded', 'false');
    if (returnFocus) {
      restoringFocus = true;
      band.focus?.();
      restoringFocus = false;
    }
  };
  previous.onclick = () => choose(selected - 1);
  next.onclick = () => choose(selected + 1);
  closeButton.onclick = () => close(true);
  band.onfocus = () => {
    if (!restoringFocus && band.matches?.(':focus-visible')) open('focus');
  };
  band.onpointerenter = event => {
    if (event.pointerType === 'mouse' && !openedBy) open('hover');
  };
  card.onpointerleave = event => {
    if (event.pointerType === 'mouse' && openedBy === 'hover') close();
  };
  card.addEventListener?.('focusout', (event: FocusEvent) => {
    if (openedBy === 'focus' && !card.contains?.(event.relatedTarget as Node | null)) close();
  });
  band.onclick = () => { if (openedBy) close(); else open('click'); };
  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index];
    const cell = el('span');
    cell.dataset.cxStatusBucket = String(index);
    cell.dataset.cxStatusCoverage = bucket.points.length ? (bucket.requests ? 'traffic' : 'idle') : 'unknown';
    cell.style.flex = '1 1 0';
    cell.style.minWidth = '0';
    cell.style.height = '18px';
    cell.style.background = resolveServiceStatusTier(bucket.successRate).color;
    cell.title = searchHistoryInterval(view, bucket) + ' · ' + searchHistoryLabel(view, bucket);
    cell.setAttribute('aria-hidden', 'true');
    cell.onpointerenter = event => { if (event.pointerType === 'mouse') choose(index); };
    band.append(cell);
  }
  band.onkeydown = event => {
    let index = selected;
    if (event.key === 'ArrowLeft') index -= 1;
    else if (event.key === 'ArrowRight') index += 1;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = last;
    else return;
    event.preventDefault();
    choose(index);
  };
  card.onkeydown = event => {
    if (event.key === 'Escape' && openedBy) close(layer.contains?.(event.target as Node | null));
  };
  choose(selected);

  const axis = el('div');
  axis.style.display = 'flex';
  axis.style.justifyContent = 'space-between';
  axis.append(createHintLine(theme, historyTime(buckets[0].startMs)), createHintLine(theme, historyTime(view.asOfMs)));
  card.append(band, axis, detail, layer);
  card.append(createHintLine(theme, '灰色可表示暂无采样或已采样无请求，请查看放大时段明细。'));
  if (view.latestMs !== null) card.append(createHintLine(theme, '最新搜题采样：' + historyTime(view.latestMs, true)));
  return card;
}

/**
 * PLUS 普通状态页只显示搜题接口的状态与公开分桶摘要。
 * 全站指标可能被 health-check / 管理页等其他请求稀释，不可作为搜题状态的回退值；
 * admin points 也不在这个用户界面展示。
 */
export function createStatusPanelSection(options: ServiceStatusPanelOptions): HTMLElement {
  const theme = options.theme;
  const snapshot = options.snapshot ?? null;

  const container = el('div');
  container.dataset.cxStatusPanel = 'true';
  container.dataset.cxStatusKind = snapshot ? snapshot.kind : 'none';
  container.style.display = 'grid';
  container.style.gap = '12px';
  container.style.minWidth = '0';
  container.style.maxWidth = '100%';
  container.style.boxSizing = 'border-box';

  // 普通用户页面只展示 public summary 内的搜题接口分桶；不以全站指标作为回退。
  container.dataset.cxStatusMode = 'search';
  container.append(createSearchStatusCard(snapshot, theme, options.onRequestRefresh));
  if (snapshot?.searchHistory !== undefined
    && (snapshot.searchHistory !== null || snapshot.search !== null)
    && !['no-token', 'rejected', 'forbidden'].includes(snapshot?.kind ?? '')) {
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    container.append(createSearchHistoryBand(snapshot, theme, now));
  }
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
