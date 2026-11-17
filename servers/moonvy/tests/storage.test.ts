import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetRepository } from '../src/storage.js';
import { AssetStore } from '../src/assets.js';
import { MoonvyClient } from '../src/client.js';
import { ComponentMapStore, resolveComponent } from '../src/components.js';
import { designUrl, fixtureConfig, fixtureFetcher, png } from './fixtures.js';

describe('persistent assets and component mappings', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'moonvy-storage-')); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

  it('keeps opaque resource IDs across restart and deduplicates bytes by content', async () => {
    const config = fixtureConfig(directory), repository = new AssetRepository(config);
    const source = { name: 'Photo', nodeId: '1:3', type: 'image' as const, key: 'design/1:3' };
    const first = await repository.save(png, 'image/png', '.png', source);
    const again = await repository.save(png, 'image/png', '.png', source);
    const alias = await repository.save(png, 'image/png', '.png', { ...source, nodeId: '1:4', key: 'design/1:4' });
    expect(again.id).toBe(first.id);
    expect(alias.path).toBe(first.path);
    expect(alias.id).not.toBe(first.id);
    const restarted = new AssetRepository(config);
    expect(Buffer.from((await restarted.read(first.id)).blob, 'base64')).toEqual(png);
    expect(await restarted.prune()).toMatchObject({ blobs: 1, records: 2, bytes: png.length });
    expect((await readdir(directory)).filter(name => name.endsWith('.png'))).toHaveLength(1);
  });

  it('expires records and deletes orphaned managed files without touching unrelated files', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const repository = new AssetRepository({ ...fixtureConfig(directory), assetTtlMs: 10 });
    const asset = await repository.save(Buffer.from('asset'), 'application/octet-stream', '.bin', { name: 'a', nodeId: 'a', type: 'file', key: 'a' });
    await writeFile(join(directory, 'keep.txt'), 'user file');
    clock.mockReturnValue(2000);
    expect(await repository.prune()).toEqual({ records: 0, blobs: 0, bytes: 0 });
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('user file');
    await expect(repository.read(asset.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('evicts least-recently-used content to honor disk quota and rejects oversized blobs', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const repository = new AssetRepository({ ...fixtureConfig(directory), assetMaxBytes: 10 });
    const first = await repository.save(Buffer.from('aaaaaa'), 'application/octet-stream', '.bin', { name: 'a', nodeId: 'a', type: 'file', key: 'a' });
    clock.mockReturnValue(2000);
    const second = await repository.save(Buffer.from('bbbbbb'), 'application/octet-stream', '.bin', { name: 'b', nodeId: 'b', type: 'file', key: 'b' });
    await expect(repository.read(first.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(Buffer.from((await repository.read(second.id)).blob, 'base64').toString()).toBe('bbbbbb');
    expect((await repository.prune()).bytes).toBe(6);
    await expect(repository.save(Buffer.alloc(11), 'application/octet-stream', '.bin', { name: 'large', nodeId: 'c', type: 'file', key: 'c' })).rejects.toMatchObject({ code: 'ASSET_QUOTA' });
  });

  it('serializes two repository instances and verifies persisted content integrity', async () => {
    const config = fixtureConfig(directory), one = new AssetRepository(config), two = new AssetRepository(config);
    const source = { name: 'a', nodeId: 'a', type: 'file' as const, key: 'a' };
    const [first, second] = await Promise.all([one.save(png, 'image/png', '.png', source), two.save(png, 'image/png', '.png', source)]);
    expect(first.id).toBe(second.id);
    await writeFile(first.path, Buffer.alloc(png.length));
    await expect(two.read(first.id)).rejects.toMatchObject({ code: 'INVALID_ASSET' });
    expect((await one.save(png, 'image/png', '.png', source)).id).toBe(first.id);
    expect(Buffer.from((await two.read(first.id)).blob, 'base64')).toEqual(png);
  });

  it('applies reduced quotas during cleanup and discards records for missing blobs', async () => {
    const config = fixtureConfig(directory), repository = new AssetRepository(config);
    const first = await repository.save(Buffer.from('aaaaaa'), 'application/octet-stream', '.bin', { name: 'a', nodeId: 'a', type: 'file', key: 'a' });
    const second = await repository.save(Buffer.from('bbbbbb'), 'application/octet-stream', '.bin', { name: 'b', nodeId: 'b', type: 'file', key: 'b' });
    expect((await new AssetRepository({ ...config, assetMaxBytes: 6 }).prune()).bytes).toBe(6);
    await expect(repository.read(first.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await rm(second.path);
    expect(await repository.prune()).toEqual({ records: 0, blobs: 0, bytes: 0 });
  });

  it('bounds manifest count even when every resource references the same content', async () => {
    const repository = new AssetRepository(fixtureConfig(directory));
    const source = { name: 'a', nodeId: 'a', type: 'file' as const, key: 'a' };
    const original = await repository.save(png, 'image/png', '.png', source);
    const record = JSON.parse(await readFile(join(directory, '.index', `${original.id}.json`), 'utf8'));
    const ids = Array.from({ length: 2047 }, () => randomUUID());
    // Seed manifests directly to exercise the cap without quadratic download setup.
    for (let start = 0; start < ids.length; start += 64) await Promise.all(ids.slice(start, start + 64).map(id => writeFile(join(directory, '.index', `${id}.json`), JSON.stringify({ ...record, id, sourceKey: id }))));
    const saved = await repository.save(png, 'image/png', '.png', { ...source, key: 'new-source' });
    expect(await repository.prune()).toMatchObject({ records: 2048, blobs: 1, bytes: png.length });
    expect(Buffer.from((await repository.read(saved.id)).blob, 'base64')).toEqual(png);
  }, 15_000);

  it('derives resource paths rather than trusting edited manifest paths', async () => {
    const repository = new AssetRepository(fixtureConfig(directory));
    const asset = await repository.save(png, 'image/png', '.png', { name: 'a', nodeId: 'a', type: 'file', key: 'a' });
    const manifest = join(directory, '.index', `${asset.id}.json`), record = JSON.parse(await readFile(manifest, 'utf8'));
    record.path = '/etc/passwd';
    await writeFile(manifest, JSON.stringify(record));
    expect(Buffer.from((await repository.read(asset.id)).blob, 'base64')).toEqual(png);
    record.file = '../../etc/passwd'; await writeFile(manifest, JSON.stringify(record));
    await expect(repository.read(asset.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('refreshes expired signed asset URLs only once and reuses parsed document indexes', async () => {
    const base = fixtureFetcher(); let snapshotCalls = 0, designCalls = 0;
    const fetcher = vi.fn(async (input: any, init?: RequestInit) => {
      if (String(input).endsWith('/anynode/get')) designCalls++;
      if (String(input).includes('/snapshot')) { snapshotCalls++; if (snapshotCalls === 1) return new Response('', { status: 403 }); }
      return base(input, init);
    });
    const client = new MoonvyClient(fixtureConfig(directory), fetcher), assets = new AssetStore(client);
    const result = await assets.screenshot(designUrl, '1:1');
    expect(result.metadata.available).toBe(true);
    expect(designCalls).toBe(2); expect(snapshotCalls).toBe(2);
    const document = (await client.getDesign(designUrl)).document;
    expect((await client.getDesign(designUrl)).document).toBe(document);
  });

  it('merges, persists and scopes component mappings while preserving instance linkage', async () => {
    const path = join(directory, 'components.json'), store = new ComponentMapStore(path);
    expect(await store.get(designUrl)).toEqual([]);
    const mapping = { nodeId: '1:6', componentName: 'Button', importPath: '@/components/Button', framework: 'react' };
    await store.set(designUrl, [mapping]);
    await store.set(designUrl, [{ ...mapping, nodeId: '1:3', componentName: 'Image' }]);
    expect(await new ComponentMapStore(path).get(designUrl)).toHaveLength(2);
    expect(await store.get(designUrl.replace('/design', '/other'))).toEqual([]);
    expect(resolveComponent({ id: 'instance', mainComponentId: '1:6' }, [mapping])).toMatchObject({ componentName: 'Button', matchedBy: 'sourceComponentId' });
    await store.set(designUrl, [], true); expect(await store.get(designUrl)).toEqual([]);
  });

  it('preserves concurrent component map writes from independent store instances', async () => {
    const path = join(directory, 'components.json'), one = new ComponentMapStore(path), two = new ComponentMapStore(path);
    await Promise.all([
      one.set(designUrl, [{ nodeId: 'a', componentName: 'A', importPath: '@/A' }]),
      two.set(designUrl, [{ nodeId: 'b', componentName: 'B', importPath: '@/B' }]),
    ]);
    expect((await one.get(designUrl)).map(mapping => mapping.nodeId).sort()).toEqual(['a', 'b']);
    const abort = AbortSignal.abort();
    await expect(two.set(designUrl, [], true, abort)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await one.get(designUrl)).toHaveLength(2);
  });
});
