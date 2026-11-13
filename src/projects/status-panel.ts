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
 * - `GET /adapter-service/service-status/summary` 无凭据 → **401**「请重新登录」
 * - 同上 + 非法 Bearer → **401**
 * - 同上 + 真实 access token → **200**（这条路才是 PLUS 实际走的）
 * - `GET /adapter-service/admin/service-status` + **有效普通 token** → **401**（不是 403！）
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
export const SERVICE_STATUS_ENDPOINT = '/adapter-service/service-status/summary';

/**
 * 管理员端点（`RequireAdmin` + 逐分钟 points）。
 *
 * 当前**不接**——PLUS 没有管理员登录态。保留常量是为了将来做管理员视图时不用再找
 * 一次路径；也用来在注释里说明「为什么不能拿它给普通用户用」。
 */
export const SERVICE_STATUS_ADMIN_ENDPOINT = '/adapter-service/admin/service-status';

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

/** ISO 字符串 → 毫秒。解析失败返回 null（渲染层据此不显示「自 1970 起」）。 */
function parseIsoToMs(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
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
 * 1. **摘要端点**（`/adapter-service/service-status/summary`，普通用户可用）：
 *    `{ schemaVersion, status, successRate, successRateAvailable, totalRequests,
 *       successRequests, failedRequests, avgLatencyMs, windowMinutes, retained,
 *       capacity, restartedAt }` —— **没有 points**。
 * 2. **admin 端点**（`/adapter-service/admin/service-status`，仅管理员）：带 `points[]`。
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
export function normalizeServiceStatusSnapshot(raw: unknown): ServiceStatusSnapshot | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const payload = asRecord(record.data) ?? record;
  const summary = asRecord(payload.summary) ?? {};
  const breakdownRecord = asRecord(summary.breakdown) ?? asRecord(payload.breakdown) ?? {};

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
    updatedAt: toFiniteNumber(payload.updatedAt ?? payload.updated_at ?? payload.ts) ?? Date.now()
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

/**
 * 底部那行「数据自 X 起」。
 *
 * 三种 kind 各说各的，**不能**统一成「数据自 <updatedAt> 起」——
 * `updatedAt` 只说明「什么时候拉的」，而 `restartedAtMs` 才是「曲线真正的起点」。
 * 后端重启后 points 为空，此时用户最需要知道的是「采样从这个时刻开始」，
 * 所以优先用 `restartedAtMs`。
 */
function serviceStatusSourceText(snapshot: ServiceStatusSnapshot | null): string {
  if (!snapshot) {
    return '尚未取到服务状态数据。';
  }
  // 注意：`kind === 'forbidden'` 当前**没有任何产出点**（见类型定义处的说明），
  // 这里是防御性分支，不要以为它被测过。
  if (snapshot.kind === 'forbidden') {
    return '服务状态不可用（该身份无法读取）。';
  }
  const since = snapshot.restartedAtMs !== null ? formatServiceStatusClock(snapshot.restartedAtMs) : '';
  if (snapshot.kind === 'empty') {
    return since ? `暂无采样数据（服务自 ${since} 起）` : '暂无采样数据（服务刚重启）';
  }
  return since ? `数据自 ${since} 起` : `数据更新于 ${formatServiceStatusClock(snapshot.updatedAt)}`;
}

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
    serviceStatusSourceText(snapshot)
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
 * 状态页主体。**按 `kind` 分三种形态**，这是本任务的核心：
 * - `forbidden`：只渲染「看不了」说明，**不建色带、不建列表**（`cells === 0`）。
 *   文案按 `authProblem` 分流：401 →「请先配置访问令牌」，403 →「令牌无权查看」。
 *   让权限问题渲染成「全部失败」是最容易犯的错。
 * - `empty`：只渲染「暂无采样数据」+ 自某时刻起，同样**不建色带**（`cells === 0`）。
 *   绝不把空数组补成 288/1440 个 0 桶。
 * - `ok`：摘要数字 +（有 points 时）逐分钟曲线。
 *
 * ## 关于曲线（队长裁决方案 1 的后果）
 *
 * 普通用户走 `/adapter-service/service-status/summary`，该端点**不返回 points**，
 * 所以非管理员看到的是**纯摘要**：状态、成功率、请求总数、失败数、延迟、
 * 采样起点、采样点数/容量。**没有逐分钟曲线，也没有 288 格色带。**
 *
 * 只有响应里**确实带了 points**（即 admin 端点）时才画曲线 —— 这样同一套渲染
 * 既能服务普通用户，也能在将来给管理员复用，且不会伪造出「有曲线」的假象。
 * 界面用 `[data-cx-status-mode]` 标明是 `summary` 还是 `detail`，不靠用户猜。
 *
 * 返回的元素不依赖任何 common.ts 符号，可以被单独抽取执行。
 */
export function createStatusPanelSection(options: ServiceStatusPanelOptions): HTMLElement {
  const theme = options.theme;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const snapshot = options.snapshot ?? null;

  const container = el('div');
  container.dataset.cxStatusPanel = 'true';
  container.dataset.cxStatusKind = snapshot ? snapshot.kind : 'none';
  container.style.display = 'grid';
  container.style.gap = '12px';
  container.style.minWidth = '0';
  container.style.maxWidth = '100%';
  container.style.boxSizing = 'border-box';

  const summaryCard = createSummaryCard(snapshot, theme, options.onRequestRefresh);

  // 压根没配令牌：引导去配置，没有任何图表。
  if (snapshot?.kind === 'no-token') {
    container.append(summaryCard, createStatusNoticeCard(
      theme,
      '未配置访问令牌',
      '状态数据需要通过访问令牌读取。请在面板「题库配置」里填写 tikuAdapter 访问令牌后点「立即刷新」。',
      'no-token'
    ));
    return container;
  }

  // 发了请求但被拒：**优先显示服务端原话**，只有拿不到时才回退通用文案。
  if (snapshot?.kind === 'rejected' || snapshot?.kind === 'forbidden') {
    const serverMessage = String(snapshot.serverMessage ?? '').trim();
    const forbidden = snapshot.authProblem === 'forbidden';
    container.append(summaryCard, createStatusNoticeCard(
      theme,
      forbidden ? '无权查看' : '令牌未通过验证',
      serverMessage
        // 服务端给了原因就直接用它 —— 前端猜不出「这是脚本令牌」之类的原因。
        ? serverMessage
        : forbidden
          ? '当前访问令牌有效，但服务端拒绝提供状态数据。请联系管理员确认该令牌的权限。'
          : '访问令牌未通过服务端验证。请到面板「题库配置」检查令牌是否正确、是否已被停用。',
      forbidden ? 'forbidden' : 'rejected'
    ));
    return container;
  }

  // 尚无采样：说明 + 「自某时刻起」，同样不画格子。
  if (snapshot?.kind === 'empty') {
    const since = snapshot.restartedAtMs !== null ? formatServiceStatusClock(snapshot.restartedAtMs) : '';
    container.append(summaryCard, createStatusNoticeCard(
      theme,
      '暂无采样数据',
      since
        ? `服务自 ${since} 起开始采样，窗口内还没有产生请求。稍后刷新即可看到数据。`
        : '服务刚开始采样，窗口内还没有产生请求。稍后刷新即可看到数据。',
      'empty'
    ));
    return container;
  }

  // 有数据：先看有没有逐分钟点。有才画曲线，没有就只给摘要卡片。
  const hasSeries = (snapshot?.buckets.length ?? 0) > 0;
  container.dataset.cxStatusMode = hasSeries ? 'detail' : 'summary';
  if (!hasSeries) {
    container.append(summaryCard, createStatusMetricsCard(snapshot, theme));
    return container;
  }

  const buckets = buildServiceStatusBuckets(snapshot?.buckets ?? [], now);
  // 先建列表，色带点击要引用它的滚动函数；再按「状态 → 色带 → 列表」的视觉顺序挂载。
  const minuteList = createMinuteList(snapshot, theme);
  container.append(
    summaryCard,
    createDayBand(buckets, theme, minuteList.scrollTo),
    minuteList.element
  );
  return container;
}

/** 非「有数据」形态的说明卡片。刻意不含任何 `[data-cx-status-cell]`。 */
function createStatusNoticeCard(
  theme: ServiceStatusPanelTheme,
  title: string,
  detail: string,
  kind: 'empty' | 'no-token' | 'rejected' | 'forbidden'
): HTMLElement {
  const card = createSectionCard(theme);
  card.dataset.cxStatusNotice = kind;
  card.append(createSectionTitle(theme, title), createHintLine(theme, detail));
  return card;
}

/**
 * 摘要卡片：**纯数字，没有曲线**。
 *
 * 这是普通用户看到的形态（summary 端点不给 points）。四项聚合指标 + 采样说明。
 * 用 2 列网格而不是表格：360px 宽下 2 列刚好，4 列会挤成不可读。
 * 每个数字都带单位与口径说明，避免用户把「窗口内请求数」读成「累计」。
 */
function createStatusMetricsCard(
  snapshot: ServiceStatusSnapshot | null,
  theme: ServiceStatusPanelTheme
): HTMLElement {
  const card = createSectionCard(theme);
  card.dataset.cxStatusMetrics = 'true';
  card.append(createSectionTitle(theme, '当前窗口摘要'));

  const successText = snapshot && snapshot.successRateAvailable === false
    ? '窗口内无请求'
    : formatServiceStatusPercent(snapshot?.successRate ?? null);

  const avgLatencyText = snapshot?.avgLatencyMs === null || snapshot?.avgLatencyMs === undefined
    ? '未知'
    : `${Math.round(snapshot.avgLatencyMs)}ms`;

  const metrics: Array<[string, string]> = [
    ['成功率', successText],
    ['平均延迟', avgLatencyText],
    ['请求总数', snapshot ? String(snapshot.totalRequests) : '—'],
    ['失败请求', snapshot ? String(snapshot.failedRequests) : '—']
  ];

  const grid = el('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
  grid.style.gap = '8px';
  grid.style.minWidth = '0';

  for (const [label, value] of metrics) {
    const item = el('div');
    item.style.display = 'grid';
    item.style.gap = '2px';
    item.style.padding = '8px 10px';
    item.style.borderRadius = '10px';
    item.style.background = theme.surface;
    item.style.border = `1px solid ${theme.border}`;
    item.style.minWidth = '0';
    item.dataset.cxStatusMetric = label;

    const labelNode = el('div');
    labelNode.textContent = label;
    labelNode.style.fontSize = '11px';
    labelNode.style.color = theme.subtle;
    labelNode.style.whiteSpace = 'nowrap';

    const valueNode = el('div');
    valueNode.textContent = value;
    valueNode.style.fontSize = '15px';
    valueNode.style.fontWeight = '800';
    valueNode.style.color = theme.text;
    valueNode.style.minWidth = '0';
    valueNode.style.overflow = 'hidden';
    valueNode.style.textOverflow = 'ellipsis';
    valueNode.style.whiteSpace = 'nowrap';

    item.append(labelNode, valueNode);
    grid.append(item);
  }
  card.append(grid);

  // 采样口径：告诉用户这是「最近 5 分钟窗口」的数字，不是累计值。
  const retainedText = snapshot && snapshot.capacity > 0
    ? `已采样 ${snapshot.retained}/${snapshot.capacity} 个分钟点`
    : snapshot ? `已采样 ${snapshot.retained} 个分钟点` : '';
  card.append(createHintLine(
    theme,
    retainedText
      ? `成功率与请求数来自最近 5 分钟窗口；${retainedText}。`
      : '成功率与请求数来自最近 5 分钟窗口。'
  ));
  card.append(createHintLine(theme, '这是摘要视图，不含逐分钟曲线（普通账号不返回分钟明细）。'));
  return card;
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
