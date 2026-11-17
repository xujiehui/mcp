import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseMoonvyUrl, type DesignData } from './client.js';
import { getDocument, type DesignDocument, type Entry } from './genome.js';
import { MoonvyError, redact } from './errors.js';
import { withFileLock } from './file-lock.js';
import type { Config } from './config.js';
import type { Genome } from './types.js';

interface Snapshot { id: string; design: string; revision: string; createdAt: number; label: string; bytes: number; nodes: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function designKey(url: string) { const ids = parseMoonvyUrl(url); return digest(`${ids.projectId}/${ids.fileId ?? ids.dirId}`); }
const stable = (v: any): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

export class SnapshotStore {
  constructor(private readonly config: Config) {}
  private path(id: string, extension: string) {
    if (!uuid.test(id)) throw new MoonvyError('SNAPSHOT_NOT_FOUND', 'Invalid snapshot ID.');
    return join(this.config.snapshotDir, `${id}.${extension}`);
  }
  private lock<T>(operation: () => Promise<T>, signal?: AbortSignal) { return withFileLock(join(this.config.snapshotDir, '.lock'), operation, signal); }
  private async bytes(path: string, limit: number) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) throw new MoonvyError('SIZE_LIMIT', 'Snapshot exceeds storage limit.'); return await handle.readFile(); }
    finally { await handle.close(); }
  }
  private async records() {
    const records: Snapshot[] = [];
    for (const file of await readdir(this.config.snapshotDir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const id = file.slice(0, -5);
      if (!uuid.test(id)) continue;
      try {
        const data = JSON.parse((await this.bytes(this.path(id, 'json'), 8192)).toString());
        if (data.id !== id || !/^[0-9a-f]{64}$/.test(data.design) || !/^[0-9a-f]{64}$/.test(data.revision) || !Number.isSafeInteger(data.createdAt) || !Number.isSafeInteger(data.bytes) || data.bytes < 0 || typeof data.label !== 'string') continue;
        if (data.createdAt + this.config.snapshotTtlMs <= Date.now()) { await this.remove(data); continue; }
        records.push(data);
      } catch (e: any) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError) && !(e instanceof MoonvyError)) throw e; }
    }
    const retained = new Set(records.map(record => record.id));
    for (const file of await readdir(this.config.snapshotDir)) if (/^[0-9a-f-]{36}\.gz$/.test(file) && !retained.has(file.slice(0, -3))) await unlink(join(this.config.snapshotDir, file)).catch(() => {});
    return records.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  private async remove(record: Snapshot) { await unlink(this.path(record.id, 'json')).catch(() => {}); await unlink(this.path(record.id, 'gz')).catch(() => {}); }
  async list(url: string, signal?: AbortSignal) { return this.lock(async () => (await this.records()).filter(record => record.design === designKey(url)).map(({ design, ...record }) => record), signal); }
  async save(data: DesignData, label = '', signal?: AbortSignal) {
    const genome = redact(data.genome, [this.config.token]);
    const source = JSON.stringify(genome);
    if (Buffer.byteLength(source) > this.config.maxGenomeBytes) throw new MoonvyError('SIZE_LIMIT', 'Snapshot source exceeds Genome limit.');
    const buffer = gzipSync(source);
    if (buffer.length > this.config.snapshotMaxBytes) throw new MoonvyError('SNAPSHOT_QUOTA', 'Snapshot exceeds storage quota.');
    return this.lock(async () => {
      const records = await this.records(), design = designKey(data.ids.cleanUrl);
      const existing = records.find(record => record.design === design && record.revision === data.revision);
      if (existing) { const { design, ...result } = existing; return { ...result, reused: true }; }
      let total = records.reduce((sum, record) => sum + record.bytes, 0);
      while (records.length >= this.config.snapshotMaxEntries || total + buffer.length > this.config.snapshotMaxBytes) {
        const oldest = records.pop(); if (!oldest) throw new MoonvyError('SNAPSHOT_QUOTA', 'Snapshot quota exhausted.');
        await this.remove(oldest); total -= oldest.bytes;
      }
      const id = randomUUID(), record: Snapshot = { id, design, revision: data.revision, createdAt: Date.now(), label: label.slice(0, 200), bytes: buffer.length, nodes: data.document.entries.length };
      const temporary = this.path(id, 'tmp');
      try {
        await writeFile(temporary, buffer, { mode: 0o600, flag: 'wx' }); await rename(temporary, this.path(id, 'gz'));
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); await rename(temporary, this.path(id, 'json'));
      } finally { await unlink(temporary).catch(() => {}); }
      const { design: _design, ...result } = record; return { ...result, reused: false };
    }, signal);
  }
  async load(url: string, id: string, signal?: AbortSignal) {
    return this.lock(async () => {
      const record = (await this.records()).find(record => record.id === id && record.design === designKey(url));
      if (!record) throw new MoonvyError('SNAPSHOT_NOT_FOUND', 'Snapshot is unavailable for this design (missing, expired or evicted).');
      try {
        const buffer = await this.bytes(this.path(id, 'gz'), this.config.snapshotMaxBytes);
        if (buffer.length !== record.bytes) throw new Error('Snapshot size mismatch');
        const genome: Genome = JSON.parse(gunzipSync(buffer, { maxOutputLength: this.config.maxGenomeBytes }).toString());
        return { record, document: getDocument(genome) };
      } catch { throw new MoonvyError('INVALID_SNAPSHOT', 'Saved snapshot is corrupt or exceeds limits.'); }
    }, signal);
  }
}

function nodeRecords(doc: DesignDocument) {
  const records = new Map<string, { entry: Entry; parentId: string | null; order: number; geometry: string; style: string; assets: string; text: string; component: string }>();
  const orders = new Map<Entry | null, number>();
  for (const entry of doc.entries) {
    const n = entry.node, id = String(n.id ?? n.nodeId ?? '');
    if (!id || records.has(id)) throw new MoonvyError('AMBIGUOUS_NODE', 'Version diff requires unique non-empty node IDs.');
    const { layout, geometry, sourceConstraints, nativeLayout, layoutHints, responsiveCss, geometryCss, css, ...style } = doc.style(entry);
    const styleHashValue = { ...style, ...(style.typography ? { typography: { ...style.typography, text: undefined } } : {}) };
    const order = orders.get(entry.parent) ?? 0; orders.set(entry.parent, order + 1);
    records.set(id, { entry, parentId: entry.parent ? String(entry.parent.node.id ?? entry.parent.node.nodeId) : null,
      order,
      geometry: stable({ rect: n.rect ?? n.frame, transform: n.transform, relativeTransform: n.relativeTransform, rotation: n.rotation, constraints: n.constraints, autoLayout: n.autoLayout }),
      style: digest(stable(redact(styleHashValue))), assets: digest(stable(redact({ slices: n.slices, snapshot: n.snapshot, snapshotPreview: n.snapshotPreview, images: doc.assetRefs([entry]).map(ref => ({ types: ref.types, images: ref.images })) }))),
      text: stable(n.textbox ?? n.characters ?? n.text ?? null),
      component: stable({ masterId: n.masterId, varsProps: n.varsProps, overrides: n.overrides, componentProperties: n.componentProperties }) });
  }
  return records;
}
export function designDiff(before: DesignDocument, after: DesignDocument, nodeId?: string, includeHidden = false) {
  const old = nodeRecords(before), current = nodeRecords(after);
  let scopeFound = false;
  const scope = (doc: DesignDocument, records: ReturnType<typeof nodeRecords>) => {
    let root: Entry | undefined;
    if (nodeId) { try { root = doc.select(nodeId); scopeFound = true; } catch (error) { if (!(error instanceof MoonvyError) || error.code !== 'NODE_NOT_FOUND') throw error; } }
    return new Set([...records].filter(([, r]) => (includeHidden || !r.entry.hidden) && (!nodeId || root && r.entry.index >= root.index && r.entry.index < root.end)).map(([id]) => id));
  };
  const oldScope = scope(before, old), currentScope = scope(after, current), changes: Array<Record<string, any>> = [];
  if (nodeId && !scopeFound) throw new MoonvyError('NODE_NOT_FOUND', 'Selected node is absent from both design versions.');
  for (const id of new Set([...oldScope, ...currentScope])) {
    const a = old.get(id), b = current.get(id), was = oldScope.has(id), is = currentScope.has(id);
    if (!was && !is) continue;
    if (!a || !b) { changes.push({ nodeId: id, kind: a ? 'deleted' : 'added', parentId: (b ?? a)!.parentId }); continue; }
    const changed = {
      moved: a.parentId !== b.parentId || a.order !== b.order || a.geometry !== b.geometry,
      styleChanged: a.style !== b.style, assetsChanged: a.assets !== b.assets, textChanged: a.text !== b.text,
      componentChanged: a.component !== b.component, visibilityChanged: a.entry.hidden !== b.entry.hidden, scopeChanged: was !== is,
    };
    if (Object.values(changed).some(Boolean)) changes.push({ nodeId: id, kind: 'modified', ...changed, parentId: b.parentId, previousParentId: a.parentId });
  }
  return { changes, variablesChanged: stable(before.genome.variables ?? {}) !== stable(after.genome.variables ?? {}), current };
}
