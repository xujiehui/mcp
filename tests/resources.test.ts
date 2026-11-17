import { describe, expect, it } from 'vitest';
import { ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetByteLength, readableAsset } from '../src/resources.js';
import { loadConfig } from '../src/config.js';
import { createServer, createServices } from '../src/server.js';
import { png, fixtureConfig, fixtureFetcher } from './fixtures.js';

describe('binary resource client compatibility', () => {
  it('defaults to text metadata with an exact-byte reading tool, without a blob field', () => {
    const asset = { uri: 'moonvy://assets/test', mimeType: 'image/png', blob: png.toString('base64') };
    const result = readableAsset(asset, 'test', 'text', 1024);
    expect(ReadResourceResultSchema.safeParse({ contents: [result] }).success).toBe(true);
    expect(result).not.toHaveProperty('blob');
    expect(JSON.parse((result as any).text)).toMatchObject({ bytes: png.length, readTool: { name: 'moonvy_read_asset', arguments: { assetId: 'test' } } });
    for (let length = 0; length < 9; length++) expect(assetByteLength({ ...asset, blob: Buffer.alloc(length).toString('base64') })).toBe(length);
  });
  it('returns UTF-8 SVG as text and keeps oversized or undecodable files out of inline text', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>月维</title></svg>';
    const asset = { uri: 'moonvy://assets/test', mimeType: 'image/svg+xml', blob: Buffer.from(svg).toString('base64') };
    expect(readableAsset(asset, 'test', 'text', 1024)).toMatchObject({ text: svg, mimeType: 'image/svg+xml' });
    expect(readableAsset(asset, 'test', 'text', 1).mimeType).toBe('application/json');
    expect(readableAsset({ ...asset, blob: Buffer.from([255]).toString('base64') }, 'test', 'text', 1024).mimeType).toBe('application/json');
  });
  it('validates resource modes and keeps binary mode available through the official client', async () => {
    expect(loadConfig({}).resourceMode).toBe('text');
    expect(() => loadConfig({ MOONVY_RESOURCE_MODE: 'invalid' })).toThrow();
    const directory = await mkdtemp(join(tmpdir(), 'moonvy-blob-mode-'));
    const services = createServices({ ...fixtureConfig(directory), resourceMode: 'blob' }, fixtureFetcher());
    const asset = await services.assets.download('https://moonvy.com/project/project/folder/design', { nodeId: '1:3', type: 'image' });
    const server = createServer(services), client = new Client({ name: 'blob-supported', version: '1' });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(remote); await client.connect(local);
      const result = await client.readResource({ uri: asset.uri });
      expect(result.contents[0]).toMatchObject({ mimeType: 'image/png', blob: png.toString('base64') });
    } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
