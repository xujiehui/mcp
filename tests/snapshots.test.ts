import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MoonvyClient } from '../src/client.js';
import { DesignDocument } from '../src/genome.js';
import { SnapshotStore, designDiff } from '../src/snapshots.js';
import { designUrl, fixtureConfig, fixtureFetcher, genome } from './fixtures.js';

describe('persistent bounded snapshots and semantic diffs', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'moonvy-snapshots-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  it('persists by opaque ID across restart, reuses revisions and rejects cross-design/path reads', async () => {
    const config = fixtureConfig(directory), client = new MoonvyClient(config, fixtureFetcher());
    const source = await client.getDesign(designUrl), store = new SnapshotStore(config), first = await store.save(source, 'Before edits');
    expect((await store.save(source)).id).toBe(first.id);
    const restarted = new SnapshotStore(config);
    expect((await restarted.list(designUrl))[0]).toMatchObject({ id: first.id, revision: source.revision, label: 'Before edits' });
    const saved = await restarted.load(designUrl, first.id);
    expect(saved.document.frames()).toEqual(source.document.frames());
    await expect(restarted.load(designUrl + '-other', first.id)).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
    await expect(restarted.load(designUrl, '../../etc/passwd')).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
    await writeFile(join(config.snapshotDir, `${first.id}.gz`), 'corrupt');
    await expect(restarted.load(designUrl, first.id)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  });
  it('evicts within count/TTL quotas and removes orphaned snapshot blobs', async () => {
    const config = { ...fixtureConfig(directory), snapshotMaxEntries: 1 }, client = new MoonvyClient(config, fixtureFetcher());
    const data = await client.getDesign(designUrl), store = new SnapshotStore(config);
    const first = await store.save(data);
    const second = await store.save({ ...data, revision: 'b'.repeat(64) });
    expect((await store.list(designUrl)).map(r => r.id)).toEqual([second.id]);
    expect(await readdir(config.snapshotDir)).not.toContain(`${first.id}.gz`);
    await writeFile(join(config.snapshotDir, '00000000-0000-0000-0000-000000000000.gz'), 'orphan');
    await store.list(designUrl);
    expect(await readdir(config.snapshotDir)).not.toContain('00000000-0000-0000-0000-000000000000.gz');
    const expired = new SnapshotStore({ ...config, snapshotTtlMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 5)); expect(await expired.list(designUrl)).toEqual([]);
  });
  it('reports additions/deletions/reparenting/style/text/assets and excludes hidden subtrees', () => {
    const old = structuredClone(genome), next = structuredClone(genome);
    const children = next.pages![0].children!;
    children[0].textbox.text = 'Changed'; children[2].rect.x += 1; children[3].fills = [{ type: 'color', color: { r: 1, g: 0, b: 0 } }];
    children[1].fills.push({ type: 'image', imageHash: 'second' });
    next.pages![1].children!.push(children.splice(3, 1)[0]);
    next.pages![1].children!.splice(0, 1);
    next.pages![1].children!.push({ id: 'new', rect: { w: 1, h: 1 } });
    next.variables = { all: {} };
    const diff = designDiff(new DesignDocument(old), new DesignDocument(next));
    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: '1:2', textChanged: true }), expect.objectContaining({ nodeId: '1:3', assetsChanged: true }),
      expect.objectContaining({ nodeId: '1:6', moved: true, styleChanged: true, previousParentId: '1:1', parentId: '2:1' }),
      expect.objectContaining({ nodeId: '2:2', kind: 'deleted' }), expect.objectContaining({ nodeId: 'new', kind: 'added' }),
    ]));
    expect(diff.changes.some(c => c.nodeId === '1:4')).toBe(false);
    expect(diff.variablesChanged).toBe(true);
    expect(designDiff(new DesignDocument(old), new DesignDocument(old)).changes).toEqual([]);
    expect(designDiff(new DesignDocument(old), new DesignDocument(next), '2:1').changes.some(c => c.nodeId === '1:6' && c.scopeChanged)).toBe(true);
  });
});
