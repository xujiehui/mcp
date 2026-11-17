import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseMoonvyUrl } from './client.js';
import { MoonvyError } from './errors.js';
import type { Genome, GenomeNode } from './types.js';
import { withFileLock } from './file-lock.js';

export const componentMappingSchema = z.object({
  nodeId: z.string().min(1).max(512), componentName: z.string().min(1).max(200),
  importPath: z.string().min(1).max(512).regex(/^[^\u0000\r\n]+$/), framework: z.string().min(1).max(50).optional(),
}).strict();
export type ComponentMapping = z.infer<typeof componentMappingSchema>;
const fileSchema = z.object({ version: z.literal(1), mappings: z.array(componentMappingSchema.extend({ design: z.string().min(1).max(1024) })).max(1000) });
type MappingFile = z.infer<typeof fileSchema>;
function designKey(url: string) { const ids = parseMoonvyUrl(url); return `${ids.projectId}/${ids.fileId ?? ids.dirId}`; }

export class ComponentMapStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cached?: { mtime: number; size: number; value: MappingFile };
  constructor(private readonly path: string) {}
  private async load(): Promise<MappingFile> {
    try {
      const info = await stat(this.path);
      if (info.size > 1024 * 1024) throw new MoonvyError('INVALID_COMPONENT_MAP', 'Component map exceeds 1 MiB.');
      if (this.cached?.mtime === info.mtimeMs && this.cached.size === info.size) return this.cached.value;
      const value = fileSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      this.cached = { mtime: info.mtimeMs, size: info.size, value }; return value;
    } catch (error: any) {
      if (error.code === 'ENOENT') return { version: 1, mappings: [] };
      if (error instanceof MoonvyError) throw error;
      throw new MoonvyError('INVALID_COMPONENT_MAP', 'Component map is invalid; check the configured local JSON file.');
    }
  }
  async get(url: string) {
    const design = designKey(url);
    return (await this.load()).mappings.filter(mapping => mapping.design === design).map(({ design, ...mapping }) => mapping);
  }
  async set(url: string, mappings: ComponentMapping[], replace = false, signal?: AbortSignal) {
    const task = this.queue.then(() => withFileLock(`${this.path}.lock`, async () => {
      this.cached = undefined;
      const design = designKey(url), file = await this.load();
      const incoming = mappings.map(mapping => ({ ...componentMappingSchema.parse(mapping), design }));
      const keys = new Set(incoming.map(mapping => mapping.nodeId));
      const value = fileSchema.parse({ version: 1, mappings: [...file.mappings.filter(mapping => mapping.design !== design || (!replace && !keys.has(mapping.nodeId))), ...incoming] });
      if (new Set(value.mappings.map(mapping => `${mapping.design}/${mapping.nodeId}`)).size !== value.mappings.length) throw new MoonvyError('INVALID_COMPONENT_MAP', 'Duplicate node IDs in mappings.');
      const temp = `${this.path}.${randomUUID()}.tmp`;
      const serialized = JSON.stringify(value, null, 2);
      if (Buffer.byteLength(serialized) > 1024 * 1024) throw new MoonvyError('INVALID_COMPONENT_MAP', 'Component map exceeds 1 MiB.');
      try { await writeFile(temp, serialized, { flag: 'wx', mode: 0o600 }); await rename(temp, this.path); }
      finally { await unlink(temp).catch(() => {}); }
      this.cached = undefined;
      return { saved: incoming.length, total: value.mappings.filter(mapping => mapping.design === design).length };
    }, signal));
    this.queue = task.catch(() => {}); return task;
  }
}

export function resolveComponent(node: GenomeNode, mappings: ComponentMapping[]) {
  const id = String(node.id ?? node.nodeId ?? '');
  const sourceId = node.masterId ?? node.mainComponentId ?? node.componentId ?? node.componentKey;
  const mapping = mappings.find(mapping => mapping.nodeId === id) ?? (typeof sourceId === 'string' ? mappings.find(mapping => mapping.nodeId === sourceId) : undefined);
  return mapping ? { ...mapping, matchedBy: mapping.nodeId === id ? 'nodeId' : 'sourceComponentId' } : null;
}

export function componentSemantics(genome: Genome, node: GenomeNode, mappings: ComponentMapping[]) {
  const masterId = node.masterId ?? node.mainComponentId ?? node.componentId ?? node.componentKey;
  const master = typeof masterId === 'string' ? genome.common?.[masterId] : undefined;
  const setId = node.componentSetId ?? master?.componentSetId;
  const set = setId ? genome.common?.[setId] : undefined;
  const mapping = resolveComponent(node, mappings) ?? (master?.id ? resolveComponent({ id: master.id }, mappings) : null);
  if (!masterId && !setId && !['component', 'instance', 'componentSet'].includes(String(node.type)) && !mapping) return null;
  const summary = (value: any) => value ? Object.fromEntries(['id', 'key', 'name', 'desc', 'varsProps', 'componentSetId'].filter(key => key in value).map(key => [key, value[key]])) : null;
  return { nodeId: String(node.id ?? node.nodeId), kind: String(node.type ?? 'unknown'), masterId: masterId ?? null, master: summary(master),
    masterStatus: master ? 'metadata-available' : masterId ? 'unavailable' : 'not-referenced', componentSetId: setId ?? null, componentSet: summary(set),
    variantProperties: node.varsProps ?? node.variantProperties ?? null, instanceProperties: node.componentProperties ?? node.instanceProperties ?? null,
    overrides: node.overrides ?? node.componentOverrides ?? null, mapping,
    note: 'Only supplied metadata is reported. An absent overrides list does not prove that the instance matches its master.' };
}
