import { gunzipSync, inflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import type { Genome, GenomeNode, RequestOptions } from './types.js';
import { getDocument, type DesignDocument } from './genome.js';
import { MoonvyError } from './errors.js';
import { Diagnostics, type Stage } from './diagnostics.js';

export function parseMoonvyUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new MoonvyError('INVALID_URL', 'Invalid Moonvy URL.'); }
  if (url.protocol !== 'https:' || (url.hostname !== 'moonvy.com' && !url.hostname.endsWith('.moonvy.com')) || url.username || url.password || url.port) {
    throw new MoonvyError('INVALID_URL', 'Expected an HTTPS Moonvy URL without credentials or custom port.');
  }
  const parts = url.pathname.match(/^\/project\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/);
  if (!parts) throw new MoonvyError('INVALID_URL', 'Expected /project/:projectId/:dirId/:fileId.');
  const decode = (part?: string) => {
    if (!part) return null;
    let decoded: string;
    try { decoded = decodeURIComponent(part); } catch { throw new MoonvyError('INVALID_URL', 'Invalid URL encoding.'); }
    if (!/^[\w:;-]+$/.test(decoded)) throw new MoonvyError('INVALID_URL', 'Invalid Moonvy identifier.');
    return decoded;
  };
  return { projectId: decode(parts[1])!, dirId: decode(parts[2]), fileId: decode(parts[3]), cleanUrl: `${url.origin}${url.pathname}` };
}

export async function readLimited(response: Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new MoonvyError('SIZE_LIMIT', `Response exceeds ${limit} bytes.`);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new MoonvyError('SIZE_LIMIT', `Response exceeds ${limit} bytes.`);
      }
      chunks.push(value);
    }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function decodeGenome(buffer: Buffer, limit: number): Genome {
  if (buffer.length > limit) throw new MoonvyError('SIZE_LIMIT', 'Genome download is too large.');
  let decoded = buffer;
  try {
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) decoded = gunzipSync(buffer, { maxOutputLength: limit });
    else if ((buffer[0] & 0x0f) === 8 && ((buffer[0] << 8) + buffer[1]) % 31 === 0) decoded = inflateSync(buffer, { maxOutputLength: limit });
  } catch { throw new MoonvyError('INVALID_GENOME', 'Genome decompression failed or exceeded the size limit.'); }
  if (decoded.length > limit) throw new MoonvyError('SIZE_LIMIT', 'Decompressed Genome is too large.');
  let genome: Genome;
  try { genome = JSON.parse(decoded.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new MoonvyError('INVALID_GENOME', 'Genome is not valid JSON.'); }
  if (!genome || typeof genome !== 'object' || (!Array.isArray(genome.pages) && !Array.isArray(genome.document?.children))) {
    throw new MoonvyError('INVALID_GENOME', 'Genome has no supported pages or document.children array.');
  }
  return genome;
}

export type DesignData = { ids: ReturnType<typeof parseMoonvyUrl>; node: GenomeNode; genome: Genome; document: DesignDocument; revision: string; version: { id: unknown; updatedAt: unknown; contentHash: string } };
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);

export class MoonvyClient {
  private cache = new Map<string, { expires: number; data: DesignData; bytes: number }>();
  private cacheBytes = 0;
  private pending = new Map<string, { task: Promise<DesignData>; controller: AbortController; waiters: number }>();
  private generation = 0;
  constructor(public readonly config: Config, private readonly fetcher: typeof fetch = fetch, public readonly diagnostics = new Diagnostics()) {}

  clearCache() { this.generation++; this.cache.clear(); this.cacheBytes = 0; this.pending.clear(); }
  cacheStats() { return { entries: this.cache.size, estimatedBytes: this.cacheBytes }; }
  private removeCached(key: string) { const cached = this.cache.get(key); if (cached) this.cacheBytes -= cached.bytes; this.cache.delete(key); }

  private async request(url: string, init: RequestInit, limit: number, options: RequestOptions = {}) {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    for (let attempt = 0; ; attempt++) {
      try {
        signal.throwIfAborted();
        const response = await this.fetcher(url, { ...init, signal, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel();
          const code = response.status === 401 ? 'AUTH_EXPIRED' : response.status === 403 ? 'FORBIDDEN' : response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR';
          const error = new MoonvyError(code, `Moonvy returned HTTP ${response.status}.`);
          if ((response.status === 429 || response.status >= 500) && attempt < this.config.maxRetries) {
            const raw = response.headers.get('retry-after');
            const retryAfter = raw == null ? null : /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
            const wait = retryAfter != null && Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : this.config.retryBaseMs * 2 ** attempt;
            if (wait > this.config.timeoutMs) throw error;
            await delay(wait, undefined, { signal }); continue;
          }
          throw error;
        }
        return { buffer: await readLimited(response, limit, signal), contentType: (response.headers.get('content-type') || '').split(';')[0] };
      } catch (error) {
        if (options.signal?.aborted) throw new MoonvyError('CANCELLED', 'Moonvy request was cancelled.');
        if (signal.aborted) throw new MoonvyError('TIMEOUT', 'Moonvy request deadline exceeded.');
        if (error instanceof MoonvyError) throw error;
        if (attempt < this.config.maxRetries) { await delay(this.config.retryBaseMs * 2 ** attempt, undefined, { signal }).catch(() => {}); continue; }
        throw new MoonvyError('NETWORK_ERROR', 'Moonvy request failed.');
      }
    }
  }

  async api(path: string, body: unknown, options: RequestOptions = {}): Promise<any> {
    return this.diagnostics.phase('moonvy-api', () => this.apiRequest(path, body, options));
  }

  private async apiRequest(path: string, body: unknown, options: RequestOptions): Promise<any> {
    if (!this.config.token) throw new MoonvyError('AUTH_REQUIRED', 'Configure MOONVY_TOKEN in your local environment or .env.');
    const { buffer } = await this.request(`${this.config.apiBase}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.token}` }, body: JSON.stringify(body),
    }, this.config.maxGenomeBytes, options);
    let result: any;
    try { result = JSON.parse(buffer.toString('utf8')); } catch { throw new MoonvyError('INVALID_RESPONSE', 'Moonvy API returned non-JSON data.'); }
    if (!result || typeof result !== 'object') throw new MoonvyError('INVALID_RESPONSE', 'Moonvy API returned an invalid response.');
    if (result.success === false || result.error || (result.code !== undefined && ![0, 200, '0', '200', 'OK', 'ok'].includes(result.code))) {
      const code = String(result.code ?? result.error?.code);
      throw new MoonvyError(code === '401' ? 'AUTH_EXPIRED' : code === '403' ? 'FORBIDDEN' : 'UPSTREAM_ERROR', 'Moonvy API reported an error.');
    }
    return result;
  }

  async fetchBinary(url: string, limit = this.config.maxAssetBytes, options: RequestOptions = {}, stage: Stage = 'asset-download') {
    return this.diagnostics.phase(stage, () => this.fetchBytes(url, limit, options));
  }

  private async fetchBytes(url: string, limit: number, options: RequestOptions) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new MoonvyError('INVALID_ASSET', 'Invalid upstream asset URL.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new MoonvyError('INVALID_ASSET', 'Upstream assets must use HTTPS without URL credentials.');
    // No Moonvy Authorization header is forwarded to file/CDN endpoints.
    return this.request(parsed.toString(), {}, limit, options);
  }

  async fetchNode(projectId: string, id: string, options: RequestOptions = {}): Promise<GenomeNode> {
    const result = await this.api('/anynode/get', { projectId, id, lv: 'full' }, options);
    const candidates = [result, result.data, result.result, result.data?.data, result.result?.data, result.node, result.data?.node].filter(object);
    const node = candidates.find(v => v.files || v.file || v.preview || v.meta) ?? candidates.find(v => v.id || v.nodeId);
    if (!node) throw new MoonvyError('INVALID_RESPONSE', 'Moonvy response contains no design node.');
    return node;
  }

  async getDesign(url: string, options: RequestOptions = {}): Promise<DesignData> {
    if (options.signal?.aborted) throw new MoonvyError('CANCELLED', 'Moonvy request was cancelled.');
    const ids = parseMoonvyUrl(url);
    const id = ids.fileId ?? ids.dirId;
    if (!id) throw new MoonvyError('DESIGN_REQUIRED', 'Select a design file using moonvy_list_pages first.');
    const key = `${ids.projectId}/${id}`;
    const cached = this.cache.get(key);
    if (!options.forceRefresh && cached && cached.expires > Date.now()) {
      this.cache.delete(key); this.cache.set(key, cached); return cached.data;
    }
    this.removeCached(key);
    let pending = this.pending.get(key);
    if (!pending) {
    const generation = this.generation;
    const controller = new AbortController();
    const task = (async () => {
      const node = await this.fetchNode(ids.projectId, id, { signal: controller.signal });
      const genomeUrl = node.files?.genome?.url ?? node.file?.genome?.url;
      if (typeof genomeUrl !== 'string') throw new MoonvyError('DESIGN_REQUIRED', 'Selected item has no Genome; it may be a folder. Use moonvy_list_pages.');
      const { buffer } = await this.fetchBinary(genomeUrl, this.config.maxGenomeBytes, { signal: controller.signal }, 'genome-download');
      const genome = this.diagnostics.phaseSync('genome-decode', () => decodeGenome(buffer, this.config.maxGenomeBytes));
      const document = this.diagnostics.phaseSync('genome-index', () => getDocument(genome));
      const data = { ids, node, genome, document, revision: document.revision,
        version: { id: node.versionId ?? node.versionLastNo ?? null, updatedAt: node.updatedAt ?? node.updated_at ?? node.updateTime ?? null, contentHash: document.revision } };
      const bytes = document.sourceBytes * 4 + document.entries.length * 256 + Buffer.byteLength(JSON.stringify(node));
      if (generation === this.generation && !controller.signal.aborted && bytes <= this.config.cacheMaxBytes) {
        for (const [k, v] of this.cache) if (v.expires <= Date.now()) this.removeCached(k);
        while (this.cache.size >= this.config.cacheMaxEntries || this.cacheBytes + bytes > this.config.cacheMaxBytes) this.removeCached(this.cache.keys().next().value!);
        this.cache.set(key, { expires: Date.now() + this.config.cacheTtlMs, data, bytes }); this.cacheBytes += bytes;
      }
      return data;
    })();
    pending = { task, controller, waiters: 0 };
    this.pending.set(key, pending);
    void task.finally(() => { if (this.pending.get(key)?.task === task) this.pending.delete(key); }).catch(() => {});
    }
    const shared = pending;
    shared.waiters++;
    return new Promise<DesignData>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown, data?: DesignData) => {
        if (finished) return; finished = true;
        options.signal?.removeEventListener('abort', abort);
        shared.waiters--;
        if (shared.waiters === 0 && error instanceof MoonvyError && error.code === 'CANCELLED') { shared.controller.abort(); if (this.pending.get(key) === shared) this.pending.delete(key); }
        if (error) reject(error); else resolve(data!);
      };
      const abort = () => finish(new MoonvyError('CANCELLED', 'Moonvy request was cancelled.'));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      shared.task.then(data => finish(undefined, data), error => finish(error));
    });
  }

  async listPages(url: string, limit = 500, maxApiPages = 50, options: RequestOptions = {}) {
    const ids = parseMoonvyUrl(url);
    const queue: Array<string | null> = [ids.dirId];
    const queued = new Set(queue);
    const seen = new Set<string>();
    const nodes: Array<Record<string, unknown>> = [];
    let apiPages = 0, truncated = false;
    outer: while (queue.length) {
      const scope = queue.shift();
      for (let pageIndex = 0; ; pageIndex++) {
        if (apiPages >= maxApiPages) { truncated = true; break outer; }
        const result = await this.api('/anynode/list', { projectId: ids.projectId, ...(scope ? { id: scope } : {}), pageIndex }, options);
        apiPages++;
        const containers = [result, result.data, result.result].filter(v => v != null);
        const items = containers.flatMap(v => [v, v.list, v.items, v.records, v.rows]).find(Array.isArray);
        if (!items) throw new MoonvyError('INVALID_RESPONSE', 'Moonvy list response has no items array.');
        if (!items.length) break;
        let newItems = 0;
        for (const item of items) {
          const id = String(item.id ?? item.nodeId ?? item.fileId ?? item._id ?? item.uuid ?? '');
          if (!id || seen.has(id)) continue;
          if (nodes.length >= limit) { truncated = true; break outer; }
          seen.add(id); newItems++;
          const type = String(item.type ?? item.nodeType ?? item.kind ?? item.fileType ?? '');
          const parentId = String(item.parentId ?? item.pid ?? item.dirId ?? scope ?? '');
          nodes.push({ id, name: String(item.name ?? item.title ?? ''), type, parentId: parentId || null,
            url: `https://moonvy.com/project/${encodeURIComponent(ids.projectId)}/${parentId && parentId !== id ? `${encodeURIComponent(parentId)}/` : ''}${encodeURIComponent(id)}` });
          if (['dir', 'directory', 'folder', 'any'].includes(type.toLowerCase()) && !queued.has(id)) { queued.add(id); queue.push(id); }
        }
        const terminal = containers.some(v => v.hasMore === false || v.hasNext === false ||
          (Number.isFinite(Number(v.totalPages ?? v.pageCount)) && pageIndex + 1 >= Number(v.totalPages ?? v.pageCount)) ||
          (Number(v.pageSize ?? v.limit) > 0 && items.length < Number(v.pageSize ?? v.limit)));
        if (terminal) break;
        if (!newItems) { truncated = true; break; }
      }
    }
    return { nodes, truncated, apiPages };
  }
}
