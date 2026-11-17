import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MoonvyError } from './errors.js';

export type Stage = 'moonvy-api' | 'asset-download' | 'genome-download' | 'genome-decode' | 'genome-index' | 'tool';
interface Phase { stage: Stage; elapsedMs: number; code?: string }
export interface Trace { requestId: string; tool: string; startedAt: string; elapsedMs: number; status: 'running' | 'success' | 'error'; code?: string; phases: Phase[]; phasesDropped: number }
const elapsed = (start: number) => Math.round((performance.now() - start) * 100) / 100;
const codeOf = (error: unknown) => error instanceof MoonvyError ? error.code : 'INTERNAL_ERROR';

/** Process-local observations contain only operation names, timestamps and error codes. */
export class Diagnostics {
  private context = new AsyncLocalStorage<Trace>();
  private inProgress = new WeakMap<Trace, Stage[]>();
  private recent: Trace[] = [];
  private total = 0;
  private failed = 0;
  private active = 0;
  private started = performance.now();
  constructor(private readonly capacity = 100) {}

  async run<T>(tool: string, operation: (trace: Trace) => Promise<T>): Promise<T> {
    const trace: Trace = { requestId: randomUUID(), tool, startedAt: new Date().toISOString(), elapsedMs: 0, status: 'running', phases: [], phasesDropped: 0 };
    const start = performance.now(); this.total++; this.active++;
    return this.context.run(trace, async () => {
      try {
        const result = await operation(trace);
        const response = result as { isError?: boolean; structuredContent?: { code?: string } };
        trace.status = response?.isError ? 'error' : 'success';
        if (trace.status === 'error') trace.code = response.structuredContent?.code ?? 'INTERNAL_ERROR';
        return result;
      } catch (error) { trace.status = 'error'; trace.code = codeOf(error); throw error; }
      finally {
        trace.elapsedMs = elapsed(start); this.active--; if (trace.status === 'error') this.failed++;
        this.recent.push(trace); if (this.recent.length > this.capacity) this.recent.shift();
      }
    });
  }

  private record(stage: Stage, start: number, error?: unknown) {
    const trace = this.context.getStore();
    if (error instanceof MoonvyError && !error.stage) error.stage = stage;
    if (!trace) return;
    if (trace.phases.length >= 64) { trace.phasesDropped++; return; }
    trace.phases.push({ stage, elapsedMs: elapsed(start), ...(error ? { code: codeOf(error) } : {}) });
  }
  currentStage(): Stage | undefined { const trace = this.context.getStore(); return trace ? this.inProgress.get(trace)?.at(-1) ?? trace.phases.at(-1)?.stage : undefined; }
  async phase<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const trace = this.context.getStore(), active = trace ? this.inProgress.get(trace) ?? [] : [];
    if (trace) { active.push(stage); this.inProgress.set(trace, active); }
    try { const result = await operation(); this.record(stage, start); return result; }
    catch (error) { this.record(stage, start, error); throw error; }
    finally { const index = active.lastIndexOf(stage); if (index >= 0) active.splice(index, 1); }
  }
  phaseSync<T>(stage: Stage, operation: () => T): T {
    const start = performance.now();
    try { const result = operation(); this.record(stage, start); return result; }
    catch (error) { this.record(stage, start, error); throw error; }
  }
  snapshot(limit = 10) {
    return { uptimeMs: elapsed(this.started), totalCalls: this.total, failedCalls: this.failed, activeCalls: this.active,
      retained: this.recent.length, capacity: this.capacity, recent: structuredClone(limit > 0 ? this.recent.slice(-limit) : []) };
  }
}

export function errorAdvice(code: string) {
  const actions: Record<string, string> = {
    AUTH_REQUIRED: '在服务进程的本机环境或 .env 配置 MOONVY_TOKEN，然后重启服务。',
    AUTH_EXPIRED: '在 Moonvy 重新登录并更新本机 Token，然后重启服务；不要在聊天中发送 Token。',
    FORBIDDEN: '检查当前账号是否有目标项目/文件权限；若是素材下载阶段，可刷新设计以更新签名 URL。',
    TIMEOUT: '检查 Moonvy 网络连通性；缩小读取范围，必要时调整 MOONVY_TIMEOUT_MS。',
    NETWORK_ERROR: '检查到 Moonvy API/CDN 的 DNS、代理和 HTTPS 连接，然后重试。',
    RATE_LIMITED: '稍后重试，减少并发读取；服务已按 Retry-After 进行有限重试。',
    UPSTREAM_ERROR: '上游服务异常；稍后重试，持续发生时记录调用编号和失败阶段。',
    INVALID_RESPONSE: 'Moonvy API 返回了不兼容结构；提供脱敏后的调用编号和阶段以检查适配层。',
    INVALID_GENOME: 'Genome 结构或压缩内容无法解析；检查源文件版本与解析器兼容性。',
    SIZE_LIMIT: '缩小素材或设计范围，检查配置的下载、解压和图片大小上限。',
    NODE_NOT_FOUND: '先搜索或读取元数据，使用返回的完整节点 ID，并确认文件链接正确。',
    AMBIGUOUS_NODE: '使用错误详情中的完整节点 ID，避免短 ID 指向多个实例。',
    STALE_CURSOR: '设计已更新，从新版本第一页重新读取。',
    RESPONSE_TOO_LARGE: '选择 compact、减少 fields 或 maxTextLength，或提高 maxBytes。',
    CANCELLED: '调用已取消；需要结果时发起新的调用。',
    ASSET_UNAVAILABLE: '该节点没有所请求的已有素材；先查看素材引用和可用变体。',
  };
  return { retryable: ['TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED', 'UPSTREAM_ERROR'].includes(code),
    suggestedAction: actions[code] ?? '核对输入参数和服务版本，通过 moonvy_diagnose 查看脱敏诊断记录。' };
}
