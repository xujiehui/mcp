import { AssetRepository, type StoredAsset } from './storage.js';
import { parseMoonvyUrl, type MoonvyClient } from './client.js';
import { type DesignDocument, type Entry } from './genome.js';
import { MoonvyError } from './errors.js';
import type { Genome, GenomeNode, RequestOptions } from './types.js';
import { imageFills } from './image-fills.js';

export type AssetType = 'slice' | 'snapshot' | 'image' | 'file';
export interface AssetRequest { nodeId?: string; type?: AssetType; format?: string; fillIndex?: number }
interface RemoteAsset { url: string; type: AssetType; nodeId: string; name: string; fillIndex?: number; referenceId?: string }
export type { StoredAsset } from './storage.js';
const idOf = (node: GenomeNode) => String(node.id ?? node.nodeId ?? '');
const hashOf = (value: any): string | undefined => typeof value === 'string' ? value : value?.id ?? value?.hash;

function resolveHash(meta: GenomeNode, genome: Genome, hash: string) {
  const value = meta.meta?.assets?.[hash] ?? genome.images?.[hash]?.url;
  return typeof value === 'string' ? value : value?.url ?? `https://fs.moonvy.com/${encodeURIComponent(hash)}`;
}

function layerAsset(meta: GenomeNode, doc: DesignDocument, entry: Entry, request: AssetRequest): RemoteAsset {
  const node = entry.node;
  const type = request.type ?? (node.slices && Object.keys(node.slices).length ? 'slice' : node.snapshot || node.snapshotPreview ? 'snapshot' : 'image');
  let hash: string | undefined;
  let fillReference: { fillIndex: number; referenceId: string } | undefined;
  if (request.fillIndex !== undefined && type !== 'image') throw new MoonvyError('INVALID_ASSET', 'fillIndex only applies to image assets.');
  if (type === 'slice') {
    const slices = node.slices ?? {};
    const variant = request.format ? slices[request.format] : slices.svg ?? slices.base ?? slices.max ?? Object.values(slices)[0];
    if (!variant) throw new MoonvyError('ASSET_UNAVAILABLE', `Requested slice variant is unavailable. Available: ${Object.keys(slices).join(', ')}`);
    hash = hashOf(variant);
  } else if (type === 'snapshot') hash = hashOf(node.snapshot ?? node.snapshotPreview);
  else if (type === 'image') {
    const fills = imageFills(doc.genome, node);
    const fill = request.fillIndex === undefined ? fills[0] : fills.find(f => f.fillIndex === request.fillIndex);
    hash = fill?.imageHash ?? undefined;
    if (fill) fillReference = { fillIndex: fill.fillIndex, referenceId: fill.referenceId };
  } else throw new MoonvyError('ASSET_UNAVAILABLE', 'file assets belong to the design file; omit nodeId.');
  if (!hash) throw new MoonvyError('ASSET_UNAVAILABLE', `Node does not expose a ${type} asset.`);
  return { url: resolveHash(meta, doc.genome, hash), type, nodeId: idOf(node), name: String(node.name ?? 'asset'), ...fillReference };
}

export function imageMime(buffer: Buffer): string | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}

export class AssetStore {
  private readonly repository: AssetRepository;
  constructor(private readonly client: MoonvyClient) { this.repository = new AssetRepository(client.config); }
  prune(signal?: AbortSignal) { return this.repository.prune(signal); }

  private async resolve(url: string, request: AssetRequest, options: RequestOptions = {}): Promise<RemoteAsset> {
    const data = await this.client.getDesign(url, options);
    const doc = data.document;
    if (request.fillIndex !== undefined && !request.nodeId) throw new MoonvyError('INVALID_ASSET', 'Image fill selection requires nodeId.');
    if (request.nodeId) return layerAsset(data.node, doc, doc.select(request.nodeId), request);
    const type = request.type ?? 'file';
    const assetUrl = type === 'snapshot' ? data.node.preview?.large ?? data.node.preview?.normal : type === 'file' ? data.node.files?.file?.url ?? data.node.preview?.large ?? data.node.preview?.normal : undefined;
    if (!assetUrl) throw new MoonvyError('ASSET_UNAVAILABLE', 'Design has no requested file asset or preview.');
    return { url: assetUrl, type, nodeId: String(data.node.id ?? data.ids.fileId ?? data.ids.dirId), name: String(data.node.name ?? 'design') };
  }

  async download(url: string, request: AssetRequest, options: RequestOptions = {}): Promise<StoredAsset & { fillIndex?: number; referenceId?: string }> {
    let remote = await this.resolve(url, request, options);
    let binary;
    try { binary = await this.client.fetchBinary(remote.url, this.client.config.maxAssetBytes, options); }
    catch (error) {
      if (!(error instanceof MoonvyError) || !['FORBIDDEN', 'AUTH_EXPIRED'].includes(error.code)) throw error;
      remote = await this.resolve(url, request, { ...options, forceRefresh: true });
      binary = await this.client.fetchBinary(remote.url, this.client.config.maxAssetBytes, options);
    }
    const { buffer, contentType } = binary;
    const sniffed = imageMime(buffer);
    const text = buffer.subarray(0, 1024).toString('utf8').trim();
    const mimeType = sniffed ?? (/<svg[\s>]/i.test(text) ? 'image/svg+xml' : buffer.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : 'application/octet-stream');
    if (contentType === 'text/html') throw new MoonvyError('INVALID_ASSET', 'Asset endpoint returned HTML.');
    const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'application/pdf': '.pdf' } as Record<string, string>)[mimeType] ?? '.bin';
    const saved = await this.repository.save(buffer, mimeType, extension, { name: remote.name, nodeId: remote.nodeId, type: remote.type, key: JSON.stringify({ design: dataKey(url), nodeId: remote.nodeId, type: remote.type, format: request.format ?? null, fillIndex: remote.fillIndex ?? null }) }, options.signal);
    return { ...saved, ...(remote.fillIndex !== undefined ? { fillIndex: remote.fillIndex, referenceId: remote.referenceId } : {}) };
  }

  read(id: string, signal?: AbortSignal) { return this.repository.read(id, signal); }

  async screenshot(url: string, nodeId?: string, options: RequestOptions = {}, refreshOnExpiry = true): Promise<{ metadata: Record<string, unknown>; image?: { type: 'image'; mimeType: string; data: string } }> {
    const data = await this.client.getDesign(url, options);
    const doc = data.document;
    let remote: RemoteAsset;
    if (nodeId) {
      const entry = doc.select(nodeId);
      if (!entry.node.snapshot && !entry.node.snapshotPreview) {
        let ancestor = entry.parent;
        while (ancestor && !ancestor.node.snapshot && !ancestor.node.snapshotPreview) ancestor = ancestor.parent;
        return { metadata: { available: false, requestedNodeId: nodeId, reason: 'No snapshot for this node. No ancestor image was substituted.',
          availableAncestor: ancestor ? { nodeId: idOf(ancestor.node), name: String(ancestor.node.name ?? '') } : null,
          filePreviewAvailable: Boolean(data.node.preview?.large ?? data.node.preview?.normal) } };
      }
      remote = layerAsset(data.node, doc, entry, { type: 'snapshot' });
    } else remote = await this.resolve(url, { type: 'snapshot' }, options);
    let buffer: Buffer;
    try { ({ buffer } = await this.client.fetchBinary(remote.url, this.client.config.maxImageBytes, options)); }
    catch (error) {
      if (refreshOnExpiry && error instanceof MoonvyError && ['FORBIDDEN', 'AUTH_EXPIRED'].includes(error.code)) return this.screenshot(url, nodeId, { ...options, forceRefresh: true }, false);
      throw error;
    }
    const mimeType = imageMime(buffer);
    if (!mimeType) throw new MoonvyError('UNSUPPORTED_IMAGE', 'Snapshot is not a supported PNG, JPEG, WebP or GIF image.');
    return { metadata: { available: true, requestedNodeId: nodeId ?? null, sourceNodeId: remote.nodeId, sourceType: nodeId ? 'node-snapshot' : 'file-preview', bytes: buffer.length },
      image: { type: 'image' as const, mimeType, data: buffer.toString('base64') } };
  }
}

function dataKey(url: string) { const ids = parseMoonvyUrl(url); return `${ids.projectId}/${ids.fileId ?? ids.dirId}`; }
