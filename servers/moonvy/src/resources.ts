import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

export type ResourceMode = 'text' | 'blob';
export interface BinaryAsset { uri: string; mimeType: string; blob: string }

export function assetByteLength(asset: BinaryAsset) {
  return asset.blob.length * 3 / 4 - (asset.blob.endsWith('==') ? 2 : asset.blob.endsWith('=') ? 1 : 0);
}

export function resourceMimeType(mimeType: string, bytes: number, mode: ResourceMode, inlineLimit: number) {
  return mode === 'blob' || mimeType === 'image/svg+xml' && bytes <= inlineLimit ? mimeType : 'application/json';
}

export function readableAsset(asset: BinaryAsset, id: string, mode: ResourceMode, inlineLimit: number): ReadResourceResult['contents'][number] {
  if (mode === 'blob') return asset;
  const bytes = assetByteLength(asset);
  if (asset.mimeType === 'image/svg+xml' && bytes <= inlineLimit) {
    try {
      return { uri: asset.uri, mimeType: asset.mimeType, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(asset.blob, 'base64')) };
    } catch { /* Keep undecodable files available through byte reads. */ }
  }
  return { uri: asset.uri, mimeType: 'application/json', text: JSON.stringify({
    assetId: id, mimeType: asset.mimeType, bytes,
    description: 'Saved asset. Use the indicated tool to preview an image or read exact bytes without a binary resources/read response.',
    readTool: { name: 'moonvy_read_asset', arguments: { assetId: id } },
    byteReadTool: { name: 'moonvy_read_asset', arguments: { assetId: id, format: 'base64', offset: 0 } },
  }) };
}
