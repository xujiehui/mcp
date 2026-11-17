import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServices } from '../src/server.js';
import { designUrl, fixtureConfig, fixtureFetcher, genome, png } from './fixtures.js';

let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
describe('multiple image-fill references', () => {
  it('addresses every visible fill by its source index, preserves transforms, and stores separate resource IDs', async () => {
    directory = await mkdtemp(join(tmpdir(), 'moonvy-fills-'));
    const source = structuredClone(genome), node = source.pages![0].children![1];
    node.fills = [{ type: 'image', imageHash: 'photo', scaleMode: 'CROP', crop: { x: 0.2 }, transform: [[1, 0, 0], [0, 1, 0]] }, { type: 'image', imageHash: 'hidden', visible: false }, { type: 'image', imageHash: 'photo', scaleMode: 'TILE', tile: { scale: 2 } }];
    const services = createServices(fixtureConfig(directory), fixtureFetcher(() => source)), doc = (await services.client.getDesign(designUrl)).document;
    const refs = doc.assetRefs([doc.select('1:3')])[0].images!;
    expect(refs.map(f => f.fillIndex)).toEqual([0, 2]);
    expect(refs[0]).toMatchObject({ mode: 'CROP', crop: { x: 0.2 } });
    expect(refs[1]).toMatchObject({ mode: 'TILE', tile: { scale: 2 } });
    const first = await services.assets.download(designUrl, { nodeId: '1:3', type: 'image', fillIndex: 0 });
    const second = await services.assets.download(designUrl, { nodeId: '1:3', type: 'image', fillIndex: 2 });
    expect(first.id).not.toBe(second.id); expect(first.path).toBe(second.path);
    expect(second).toMatchObject({ fillIndex: 2, referenceId: refs[1].referenceId });
    expect(Buffer.from((await services.assets.read(second.id)).blob, 'base64')).toEqual(png);
    await expect(services.assets.download(designUrl, { nodeId: '1:3', type: 'image', fillIndex: 1 })).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' });
    await expect(services.assets.download(designUrl, { nodeId: '1:3', type: 'slice', fillIndex: 2 })).rejects.toMatchObject({ code: 'INVALID_ASSET' });
  });
});
