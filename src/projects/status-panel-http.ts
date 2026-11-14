/**
 * 状态页的 HTTP 取数适配层。
 *
 * 为什么单独一个文件而不是塞进 status-panel.ts：
 * 1. `status-panel.ts` 是**纯渲染 + 归一化**模块，不碰任何 I/O，可以被抽取到最小运行时里
 *    单独执行（既有回归就是这么测的）。把 `fetch` 混进去会让那份抽取式回归直接 ReferenceError。
 * 2. 请求通道在两端不同（扩展端 / Windows CEF75），适配层是唯一需要分端的地方。
 *
 * 本模块只做三件事：拼 URL、发请求、把 HTTP 状态翻译成 fetcher 的三种语义。
 * 字段归一化仍在 `status-panel.ts` 的 `normalizeServiceStatusSnapshot`。
 */

import {
  SERVICE_STATUS_ENDPOINT,
  createNoTokenServiceStatusSnapshot,
  createRejectedServiceStatusSnapshot,
  normalizeServiceStatusSnapshot,
  type ServiceStatusFetcher,
  type ServiceStatusSnapshot
} from './status-panel.js';

/**
 * 请求通道签名：给一个绝对 URL，返回已解析的 JSON。
 *
 * 失败时**必须**把 HTTP 状态码挂在 error 的 `status` 上（下方 `readHttpStatus` 依赖它），
 * 否则 403 与「网络不通」会被混成同一件事。
 */
export type ServiceStatusRequester = (url: string, init?: RequestInit) => Promise<unknown>;

/** 状态页取数的超时。状态页是旁路展示，不值得为它长时间占住连接。 */
export const SERVICE_STATUS_REQUEST_TIMEOUT_MS = 8000;

/** 从任意错误对象上尽力取 HTTP 状态码。 */
export function readHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const record = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [record.status, record.statusCode, record.response?.status]) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

/**
 * 把 baseurl 与端点拼成绝对 URL。
 *
 * `endpoint` 显式由调用方传入（**不依赖默认常量**）：将来 baseurl 规则变化时，
 * 依赖默认值会让请求静默打到别处而不是报错。
 */
export function buildServiceStatusUrl(baseurl: string, endpoint: string): string {
  const normalizedBase = String(baseurl ?? '').trim().replace(/\/+$/, '');
  const normalizedEndpoint = String(endpoint ?? '').trim();
  if (!normalizedBase || !normalizedEndpoint) {
    return '';
  }
  const path = normalizedEndpoint.startsWith('/') ? normalizedEndpoint : `/${normalizedEndpoint}`;
  return `${normalizedBase}${path}`;
}

export type ServiceStatusHttpFetcherOptions = {
  /**
   * 固定 baseurl（原有形态，保留向后兼容）。
   *
   * ⚠️ 它是**建 fetcher 那一刻**的快照。若用户在面板里改了题库地址，
   * 这个值不会跟着变 —— 而那正是 2026-11-15 用户报的缺陷：
   * 「改了题库设置里的 URL，状态 TAB 依旧请求默认 URL」。
   * 需要跟随最新配置时请用 `getBaseurl`。
   */
  baseurl?: string;
  /**
   * 每次取数时**现读**的 baseurl。与 `baseurl` 二选一，同时给时本字段优先。
   *
   * 为什么要有它而不是只靠「保存后重建 fetcher」：重建依赖「保存路径只有一处」。
   * 将来若出现第二个写入口（导入配置、多标签页同步、后台下发），
   * 漏掉重建就会静默回到旧地址 —— 而那种缺陷在状态页只表现为「数据看着像旧的」，
   * 极难发现。让 fetcher 每次读最新值，从结构上消除这个接缝。
   *
   * 两个都不给时按空串处理，交给下面 `if (!url) return null` 的既有静默分支 ——
   * **不能抛异常**：那会让状态页整块崩掉，而它只是旁路展示。
   */
  getBaseurl?: () => string;
  /** 显式端点。默认值只用于「不知道新路径」的兜底，正常调用必须传。 */
  endpoint?: string;
  requester: ServiceStatusRequester;
  timeoutMs?: number;
  /**
   * tikuAdapter 访问令牌。摘要端点用 `controller.AuthOrAccessToken` 鉴权：
   * 带 `Authorization: Bearer <key>` 才会走 access-token 分支，
   * 不带会回退到登录 JWT 分支 → 401。
   */
  accessKey?: string;
  /**
   * 只在 `kind === 'forbidden'` 时被调用（用于界面提示或埋点）。
   * **不用于弹全局错误** —— 状态页取数失败不能干扰答题。
   */
  onForbidden?: () => void;
  /** 401：没配 key 或 key 无效。与 403 分开，用户动作不同。 */
  onUnauthorized?: () => void;
  /** 同上，非 401/403 的失败。调用方应保持静默（最多写调试日志）。 */
  onError?: (error: unknown) => void;
};

/**
 * 构造真实的 HTTP fetcher。
 *
 * 语义映射（这是本任务的核心）：
 * - `200` + `retained > 0` → `kind:'ok'`，带真实 points
 * - `200` + `retained === 0`（或 points 为空）→ `kind:'empty'`，**不补 0 桶**
 * - `403` → `kind:'forbidden'`（**不是**空图、**不是**「全部失败」）
 * - 其它失败 → 返回 `null`（fetcher 契约里的「本次没拿到」），由
 *   `refreshServiceStatusSnapshot` 保留旧快照
 *
 * 注意这里**不抛错**：抛错与返回 null 在 refresh 里行为相同（都保留旧快照），
 * 但返回 null 让我们能顺带回调 `onError` 而不制造未捕获的 rejection。
 */
/**
 * 从 options 里解析本次请求要用的 baseurl。
 *
 * 优先级：`getBaseurl()` > `baseurl` > 空串。
 *
 * `getBaseurl` 抛异常时**回退到 baseurl**（而不是把异常抛给调用方）：
 * 状态页是旁路展示，配置读取函数若因为 storage 损坏之类的原因抛错，
 * 让整个状态页崩掉远不如退回快照值。这与「取数失败保留旧快照」是同一条纪律。
 */
function resolveOptionsBaseUrl(options: ServiceStatusHttpFetcherOptions): string {
  if (typeof options.getBaseurl === 'function') {
    try {
      const dynamic = options.getBaseurl();
      if (typeof dynamic === 'string' && dynamic.trim()) {
        return dynamic;
      }
    } catch {
      // 读最新配置失败 → 退回下面的一次性快照值。
    }
  }
  return typeof options.baseurl === 'string' ? options.baseurl : '';
}

export function createServiceStatusHttpFetcher(options: ServiceStatusHttpFetcherOptions): ServiceStatusFetcher {
  const endpoint = String(options.endpoint ?? SERVICE_STATUS_ENDPOINT).trim();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : SERVICE_STATUS_REQUEST_TIMEOUT_MS;

  return async (): Promise<ServiceStatusSnapshot | null> => {
    // 每次取数都重新解析（getBaseurl 存在时），这样用户改了题库地址立即生效。
    const url = buildServiceStatusUrl(resolveOptionsBaseUrl(options), endpoint);
    if (!url) {
      // 没配置 baseurl：不是错误，是「还没设置题库地址」。静默返回 null。
      return null;
    }

    const accessKey = String(options.accessKey ?? '').trim();
    // 连 key 都没有 → 前端就知道结果，**不发请求**。
    // 与「发了请求被拒」分开：用户动作完全相反（去填令牌 vs 看服务端原因）。
    if (!accessKey) {
      return createNoTokenServiceStatusSnapshot();
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

    try {
      const raw = await options.requester(url, {
        method: 'GET',
        // 状态接口是 `Cache-Control: no-store`；这里显式声明避免中间层缓存。
        cache: 'no-store',
        // AuthOrAccessToken 只在带 Authorization 时才走 access-token 分支；
        // 不带会回退到登录 JWT 分支 → 401「请重新登录」。
        headers: { Authorization: `Bearer ${accessKey}` },
        signal: controller?.signal
      });
      const snapshot = normalizeServiceStatusSnapshot(raw);
      return snapshot;
    } catch (error) {
      // 401 与 403 必须分开：两者用户要做的事完全不同。
      //   401 = key 无效/被禁用/是脚本令牌 → 看服务端原因，可能要换令牌
      //   403 = 身份不够 → 找管理员
      // **同时把服务端 message 原样带上**：像「脚本请求必须使用绑定身份码的运行会话」
      // 这种原因只有服务端知道，统一文案会把真正的指引丢掉。
      const status = readHttpStatus(error);
      const serverMessage = readServerMessage(error);
      if (status === 401) {
        options.onUnauthorized?.();
        return createRejectedServiceStatusSnapshot('unauthorized', serverMessage);
      }
      if (status === 403) {
        options.onForbidden?.();
        return createRejectedServiceStatusSnapshot('forbidden', serverMessage);
      }
      options.onError?.(error);
      return null;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
}

/**
 * 从错误对象上取**服务端返回的 message**。取不到就返回空串。
 *
 * ⚠️ 刻意**不读** `error.message`：那是本地构造的技术措辞（`HTTP 403`、
 * `service-status HTTP 401`），不是服务端原话。把它当用户文案透出去，
 * 用户看到的就是「HTTP 403」这种毫无指引的东西（实测踩到这个坑）。
 * 只认两个来源：显式挂在 error 上的 `serverMessage`，或 `body.message`。
 */
export function readServerMessage(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const record = error as { serverMessage?: unknown; body?: unknown };
  const direct = String(record.serverMessage ?? '').trim();
  if (direct) {
    return direct;
  }
  // body 可能是对象，也可能是已 parse 的 JSON。
  const body = record.body;
  const bodyRecord = body && typeof body === 'object' ? (body as { message?: unknown }) : undefined;
  return String(bodyRecord?.message ?? '').trim();
}

/**
 * 默认 requester：直接用 `fetch`。
 *
 * 只在这里出现 `fetch` —— 其余模块一律通过注入拿数据，便于两端替换与测试替身。
 *
 * 非 2xx 时把**状态码**与**服务端 message 原文**都挂到 error 上。
 * 后者是刻意保留的：服务端会说「脚本请求必须使用绑定身份码的运行会话」这类
 * **只有服务端才知道**的原因，前端猜不出来、也不该猜。统一成「无权限」会把
 * 用户真正需要的指引丢掉。
 */
export const fetchServiceStatusRequester: ServiceStatusRequester = async (url, init) => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const error = new Error(`service-status HTTP ${response.status}`) as Error & {
      status?: number;
      serverMessage?: string;
      body?: unknown;
    };
    error.status = response.status;
    // 尽量读 body 里的 message。读不到就留空，由上层回退到通用文案。
    try {
      const text = await response.text();
      if (text) {
        let parsed: unknown = undefined;
        try {
          parsed = JSON.parse(text);
        } catch {
          // 非 JSON：只有当它短到像一句话时才当 message 用。
          error.serverMessage = text.length <= 200 ? text.trim() : '';
        }
        if (parsed !== undefined) {
          error.body = parsed;
          const message = (parsed as { message?: unknown })?.message;
          if (typeof message === 'string') {
            error.serverMessage = message.trim();
          }
        }
      }
    } catch {
      // body 读取失败不影响错误分类。
    }
    throw error;
  }
  return response.json();
};
