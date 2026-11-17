import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { AssetType } from './assets.js';
import { MoonvyError } from './errors.js';
import { withFileLock } from './file-lock.js';

export interface StoredAsset { id: string; uri: string; path: string; name: string; mimeType: string; bytes: number; nodeId: string; type: AssetType; expiresAt: number }
interface RecordData extends StoredAsset { digest: string; file: string; sourceKey: string; accessedAt: number }
const uuid = /^[0-9a-f-]{36}$/;
const blobName = /^[0-9a-f]{64}\.(png|jpg|webp|gif|svg|pdf|bin)$/;

export class AssetRepository {
  constructor(private readonly config: Config) {}
  private get indexDir() { return join(this.config.assetDir, '.index'); }
  private manifest(id: string) { return join(this.indexDir, `${id}.json`); }
  private public(record: RecordData): StoredAsset { const { digest, file, sourceKey, accessedAt, ...publicRecord } = record; return publicRecord; }

  private async locked<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withFileLock(join(this.indexDir, '.lock'), fn, signal);
  }

  private valid(value: any, id: string): value is RecordData {
    return value && value.id === id && uuid.test(id) && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest) &&
      typeof value.file === 'string' && blobName.test(value.file) && value.file.startsWith(`${value.digest}.`) &&
      typeof value.name === 'string' && typeof value.nodeId === 'string' && ['slice', 'image', 'snapshot', 'file'].includes(value.type) &&
      typeof value.mimeType === 'string' && typeof value.sourceKey === 'string' && Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
      Number.isFinite(value.expiresAt) && Number.isFinite(value.accessedAt);
  }

  private async load(id: string): Promise<RecordData | null> {
    if (!uuid.test(id)) return null;
    try {
      const path = this.manifest(id);
      if ((await stat(path)).size > 16_384) return null;
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!this.valid(value, id)) return null;
      // Paths and URIs are derived from validated IDs, never accepted from disk.
      return { ...value, path: join(this.config.assetDir, value.file), uri: `moonvy://assets/${id}` };
    } catch (error: any) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }

  private async persist(record: RecordData) {
    const temporary = join(this.indexDir, `${record.id}.${randomUUID()}.tmp`);
    try { await usingFile(temporary, JSON.stringify(record)); await rename(temporary, this.manifest(record.id)); }
    finally { await unlink(temporary).catch(() => {}); }
  }

  private async collect(): Promise<RecordData[]> {
    const records: RecordData[] = [];
    for (const file of await readdir(this.indexDir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const record = await this.load(file.slice(0, -5));
      const blob = record ? await lstat(record.path).catch(() => null) : null;
      if (!record || record.expiresAt <= Date.now() || !blob?.isFile()) await unlink(join(this.indexDir, file)).catch(() => {});
      else records.push(record);
    }
    const referenced = new Set(records.map(record => record.file));
    for (const file of await readdir(this.config.assetDir)) if (blobName.test(file) && !referenced.has(file)) await unlink(join(this.config.assetDir, file)).catch(() => {});
    return records;
  }

  private async enforceQuota(records: RecordData[], reserved?: { file: string; bytes: number; id?: string }) {
    const groups = new Map<string, RecordData[]>();
    for (const record of records) { const group = groups.get(record.file) ?? []; group.push(record); groups.set(record.file, group); }
    let used = [...groups.values()].reduce((bytes, group) => bytes + group[0].bytes, 0);
    const extra = reserved && !groups.has(reserved.file) ? reserved.bytes : 0;
    const remove = async (record: RecordData) => {
      await unlink(this.manifest(record.id)).catch(() => {}); records.splice(records.indexOf(record), 1);
      const group = groups.get(record.file)!; group.splice(group.indexOf(record), 1);
      if (!group.length) {
        groups.delete(record.file); used -= record.bytes;
        if (record.file !== reserved?.file) await unlink(record.path).catch(() => {});
      }
    };
    const ordered = [...groups].sort((a, b) => Math.max(...a[1].map(r => r.accessedAt)) - Math.max(...b[1].map(r => r.accessedAt)));
    for (const [file, group] of ordered) {
      if (used + extra <= this.config.assetMaxBytes) break;
      if (file !== reserved?.file) for (const record of [...group]) await remove(record);
    }
    const maxRecords = 2048 - (reserved && !reserved.id ? 1 : 0);
    for (const record of [...records].sort((a, b) => a.accessedAt - b.accessedAt)) {
      if (records.length <= maxRecords) break;
      if (record.id !== reserved?.id) await remove(record);
    }
    if (used + extra > this.config.assetMaxBytes) throw new MoonvyError('ASSET_QUOTA', 'Asset storage quota is exhausted.');
  }

  async prune(signal?: AbortSignal) {
    return this.locked(async () => {
      const records = await this.collect(); await this.enforceQuota(records);
      const blobs = new Map(records.map(record => [record.file, record.bytes]));
      return { records: records.length, blobs: blobs.size, bytes: [...blobs.values()].reduce((a, b) => a + b, 0) };
    }, signal);
  }

  async save(buffer: Buffer, mimeType: string, extension: string, source: { name: string; nodeId: string; type: AssetType; key: string }, signal?: AbortSignal): Promise<StoredAsset> {
    if (buffer.length > this.config.maxAssetBytes || buffer.length > this.config.assetMaxBytes) throw new MoonvyError('ASSET_QUOTA', 'Asset exceeds the configured file or storage quota.');
    return this.locked(async () => {
      const records = await this.collect();
      const digest = createHash('sha256').update(buffer).digest('hex');
      const file = `${digest}${extension}`;
      if (!blobName.test(file)) throw new MoonvyError('INVALID_ASSET', 'Unsupported storage extension.');
      const sourceKey = createHash('sha256').update(source.key).digest('hex');
      let record = records.find(record => record.digest === digest && record.sourceKey === sourceKey);
      await this.enforceQuota(records, { file, bytes: buffer.length, id: record?.id });
      const path = join(this.config.assetDir, file);
      let intact = false;
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
      if (existing) {
        try {
          const info = await existing.stat();
          intact = info.isFile() && info.size === buffer.length && createHash('sha256').update(await existing.readFile()).digest('hex') === digest;
        } finally { await existing.close(); }
      }
      if (!intact) {
        const temporary = join(this.indexDir, `${randomUUID()}.tmp`);
        try { await usingFile(temporary, buffer); await rename(temporary, path); }
        finally { await unlink(temporary).catch(() => {}); }
      }
      const now = Date.now(), id = record?.id ?? randomUUID();
      record = { id, uri: `moonvy://assets/${id}`, path, file, digest, sourceKey, name: source.name.slice(0, 1000), nodeId: source.nodeId, type: source.type,
        mimeType, bytes: buffer.length, expiresAt: now + this.config.assetTtlMs, accessedAt: now };
      await this.persist(record);
      return this.public(record);
    }, signal);
  }

  async read(id: string, signal?: AbortSignal) {
    return this.locked(async () => {
      const record = await this.load(id);
      if (!record || record.expiresAt <= Date.now()) { await this.collect(); throw new MoonvyError('RESOURCE_NOT_FOUND', 'Unknown or expired asset ID; download the asset again.'); }
      const handle = await open(record.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
      if (!handle) throw new MoonvyError('RESOURCE_NOT_FOUND', 'Saved asset is missing; download it again.');
      let buffer: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > this.config.maxAssetBytes) throw new MoonvyError('SIZE_LIMIT', 'Saved asset exceeds the size limit.');
        buffer = await handle.readFile();
      } finally { await handle.close(); }
      if (buffer.length !== record.bytes || createHash('sha256').update(buffer).digest('hex') !== record.digest) throw new MoonvyError('INVALID_ASSET', 'Saved asset content failed integrity verification.');
      record.accessedAt = Date.now(); await this.persist(record);
      return { uri: record.uri, mimeType: record.mimeType, blob: buffer.toString('base64') };
    }, signal);
  }
}

async function usingFile(path: string, data: string | Buffer) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}
