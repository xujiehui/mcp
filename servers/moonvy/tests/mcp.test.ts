import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServices, type Services } from '../src/server.js';
import { createHttpApp } from '../src/http.js';
import { designUrl, fixtureConfig, fixtureFetcher, genome, png } from './fixtures.js';

describe('official MCP client interoperability', () => {
  let listener: Server, endpoint: string, directory: string, genomeFile: string, services: Services;
  const clients: Client[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'moonvy-mcp-test-'));
    genomeFile = join(directory, 'genome.json');
    await writeFile(genomeFile, JSON.stringify(genome));
    services = createServices(fixtureConfig(join(directory, 'http')), fixtureFetcher(async () => JSON.parse(await readFile(genomeFile, 'utf8'))));
    const app = createHttpApp(services);
    listener = await new Promise<Server>((resolve, reject) => { const server = app.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve(server)); });
    const address = listener.address();
    endpoint = `http://127.0.0.1:${typeof address === 'object' ? address!.port : 0}/mcp`;
    const stdio = new Client({ name: 'test-stdio', version: '1' });
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('tests/stdio-fixture.ts')], env: { ...process.env as Record<string, string>, MOCK_ASSET_DIR: join(directory, 'stdio'), MOCK_GENOME_FILE: genomeFile }, stderr: 'pipe' }));
    const http = new Client({ name: 'test-http', version: '1' });
    await http.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    clients.push(stdio, http);
  }, 20_000);
  afterAll(async () => {
    await Promise.all(clients.map(c => c.close()));
    if (listener) await new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('discovers all nineteen tools on stdio and HTTP', async () => {
    for (const client of clients) {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(19);
      expect(tools.map(t => t.name)).toContain('moonvy_get_design_context');
    }
  });

  it('returns equivalent business results across both transports', async () => {
    for (const [name, args] of [
      ['moonvy_parse_url', { url: designUrl }],
      ['moonvy_list_pages', { url: designUrl }],
      ['moonvy_get_metadata', { url: designUrl }],
      ['moonvy_get_metadata', { url: designUrl, nodeId: '1:1', maxDepth: 0 }],
      ['moonvy_get_design_context', { url: designUrl, nodeId: '1:1', cssUnit: 'rpx' }],
      ['moonvy_get_variable_defs', { url: designUrl, nodeId: '1:6' }],
      ['moonvy_get_node_style', { url: designUrl, nodeId: '1:2' }],
      ['moonvy_search_nodes', { url: designUrl, query: '月维', types: ['text'] }],
      ['moonvy_get_node_styles', { url: designUrl, nodeIds: ['1:2', 'missing', '1:6'], fields: ['css', 'units'] }],
      ['moonvy_get_component_map', { url: designUrl }],
      ['moonvy_clear_cache', {}],
    ] as const) {
      const results = await Promise.all(clients.map(c => c.callTool({ name, arguments: args })));
      expect(results[0]).toEqual(results[1]);
      expect(results[0].isError).not.toBe(true);
      expect(JSON.stringify(results[0])).not.toContain('signature=');
    }
  });

  it('exposes diagnostics and persists/diffs source changes through both transports', async () => {
    for (const [index, client] of clients.entries()) {
      const diagnostic = await client.callTool({ name: 'moonvy_diagnose', arguments: {} });
      expect(diagnostic.structuredContent).toMatchObject({ server: { version: '0.3.0', transport: index === 0 ? 'stdio' : 'http', resourceMode: 'text' } });
      const saved = await client.callTool({ name: 'moonvy_save_snapshot', arguments: { url: designUrl, label: 'Original', forceRefresh: true } });
      expect(saved.isError).not.toBe(true);
      const snapshotId = (saved.structuredContent as any).id;
      const listed = await client.callTool({ name: 'moonvy_list_snapshots', arguments: { url: designUrl } });
      expect((listed.structuredContent as any).snapshots.some((s: any) => s.id === snapshotId)).toBe(true);
      const updated = structuredClone(genome);
      updated.pages![0].children![0].textbox.text = 'Updated source';
      updated.pages![0].children![1].fills.push({ type: 'image', imageHash: 'extra-image' });
      await writeFile(genomeFile, JSON.stringify(updated));
      try {
        const args = { url: designUrl, snapshotId, limit: 1, format: 'compact' };
        const first = await client.callTool({ name: 'moonvy_diff', arguments: { ...args, forceRefresh: true } });
        expect(first.isError).not.toBe(true);
        expect((first.structuredContent as any).totalChanges).toBe(2);
        expect((first.structuredContent as any).changes[0]).toMatchObject({ nodeId: '1:2', textChanged: true, context: { style: { css: expect.any(Object) } } });
        const cursor = (first.structuredContent as any).nextCursor;
        const next = await client.callTool({ name: 'moonvy_diff', arguments: { ...args, cursor } });
        expect((next.structuredContent as any).changes[0]).toMatchObject({ nodeId: '1:3', assetsChanged: true });
        await writeFile(genomeFile, JSON.stringify({ ...updated, version: 'later' }));
        const stale = await client.callTool({ name: 'moonvy_diff', arguments: { ...args, cursor, forceRefresh: true } });
        expect(stale.structuredContent).toMatchObject({ code: 'STALE_CURSOR' });
      } finally {
        await writeFile(genomeFile, JSON.stringify(genome));
        await client.callTool({ name: 'moonvy_clear_cache', arguments: {} });
      }
    }
  });

  it('projects smaller styles, searches pages and reports individual batch errors', async () => {
    for (const client of clients) {
      const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { url: designUrl, ...args } });
      const full = await call('moonvy_get_node_style', { nodeId: '1:2' });
      const compact = await call('moonvy_get_node_style', { nodeId: '1:2', format: 'compact' });
      expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(full)));
      const selected = await call('moonvy_get_node_style', { nodeId: '1:2', fields: ['css'] });
      expect(Object.keys((selected.structuredContent as any).style)).toEqual(['css']);
      const first = await call('moonvy_search_nodes', { nodeId: '1:1', parentId: '1:1', limit: 1 });
      const next = await call('moonvy_search_nodes', { nodeId: '1:1', parentId: '1:1', cursor: (first.structuredContent as any).nextCursor });
      expect((first.structuredContent as any).nodes.map((node: any) => node.id)).toEqual(['1:2']);
      expect((next.structuredContent as any).nodes.map((node: any) => node.id)).toEqual(['1:3', '1:6']);
      const batch = await call('moonvy_get_node_styles', { nodeIds: ['1:6', 'missing', '1:2'], fields: ['css'] });
      expect((batch.structuredContent as any).results.map((item: any) => item.success)).toEqual([true, false, true]);
      expect((batch.structuredContent as any).results[1].error.code).toBe('NODE_NOT_FOUND');
    }
  });

  it('enforces complete result byte budgets while paging without lost nodes and rejects stale cursors', async () => {
    const wide = { version: 'budget-1', pages: [{ id: 'root', type: 'artboard', rect: { w: 375, h: 1000 }, children: Array.from({ length: 40 }, (_, index) => ({
      id: `child-${index}`, type: 'text', name: `Layer ${index}`, rect: { x: 0, y: index * 20, w: 100, h: 20 }, textbox: { text: '分页文本'.repeat(20), segments: [{ fontSize: 14 }] },
    })) }] };
    await writeFile(genomeFile, JSON.stringify(wide));
    const args = { url: designUrl, nodeId: 'root', maxDepth: 1, maxNodes: 41, maxBytes: 4096, format: 'compact', includeTokens: false, includeAssets: false, maxTextLength: 10 };
    const continuations: string[] = [];
    try {
      for (const client of clients) {
        let cursor: string | undefined, ids: string[] = [];
        do {
          const response = await client.callTool({ name: 'moonvy_get_design_context', arguments: { ...args, cursor, forceRefresh: !cursor } });
          expect(response.isError).not.toBe(true);
          expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(4096);
          const page = response.structuredContent as any;
          const visit = (nodes: any[]) => { for (const node of nodes) { ids.push(node.id); visit(node.children ?? []); } };
          visit(page.tree); cursor = page.nextCursor ?? undefined;
          if (continuations.length < clients.length && ids.length === page.nodeCount) continuations.push(page.nextCursor);
        } while (cursor);
        expect(ids).toEqual(['root', ...wide.pages[0].children.map(child => child.id)]);
      }
      await writeFile(genomeFile, JSON.stringify({ ...wide, version: 'budget-2' }));
      for (const [index, client] of clients.entries()) {
        const response = await client.callTool({ name: 'moonvy_get_design_context', arguments: { ...args, cursor: continuations[index], forceRefresh: true } });
        expect(response.isError).toBe(true);
        expect(response.structuredContent).toMatchObject({ code: 'STALE_CURSOR' });
      }
    } finally {
      await writeFile(genomeFile, JSON.stringify(genome));
      for (const client of clients) await client.callTool({ name: 'moonvy_clear_cache', arguments: {} });
    }
  });

  it('persists local component mappings, reuses them in context and clears one design', async () => {
    for (const client of clients) {
      const mapping = { nodeId: '1:6', componentName: 'Button', importPath: '@/components/Button', framework: 'react' };
      const saved = await client.callTool({ name: 'moonvy_set_component_map', arguments: { url: designUrl, mappings: [mapping] } });
      expect(saved.structuredContent).toEqual({ saved: 1, total: 1 });
      const read = await client.callTool({ name: 'moonvy_get_component_map', arguments: { url: designUrl } });
      expect(read.structuredContent).toEqual({ mappings: [mapping] });
      const context = await client.callTool({ name: 'moonvy_get_design_context', arguments: { url: designUrl, nodeId: '1:6' } });
      expect((context.structuredContent as any).componentMappings).toEqual([{ nodeId: '1:6', component: { ...mapping, matchedBy: 'nodeId' } }]);
      const cleared = await client.callTool({ name: 'moonvy_set_component_map', arguments: { url: designUrl, mappings: [], replace: true } });
      expect(cleared.structuredContent).toEqual({ saved: 0, total: 0 });
    }
  });

  it('returns real MCP images and explicit unavailable snapshot metadata', async () => {
    for (const client of clients) {
      for (const args of [{ url: designUrl }, { url: designUrl, nodeId: '1:1' }]) {
        const result = await client.callTool({ name: 'moonvy_get_screenshot', arguments: args });
        const image = (result.content as any[]).find(c => c.type === 'image');
        expect(image.mimeType).toBe('image/png');
        expect(Buffer.from(image.data, 'base64')).toEqual(png);
      }
      const unavailable = await client.callTool({ name: 'moonvy_get_screenshot', arguments: { url: designUrl, nodeId: '1:2' } });
      expect(unavailable.structuredContent).toMatchObject({ available: false, availableAncestor: { nodeId: '1:1' } });
      expect((unavailable.content as any[]).some(c => c.type === 'image')).toBe(false);
    }
  });

  it('downloads partial batches and reads client-compatible resources and images by opaque ID on either transport', async () => {
    for (const client of clients) {
      const result = await client.callTool({ name: 'moonvy_download_assets', arguments: { url: designUrl, assets: [
        { nodeId: '1:3', type: 'image' }, { nodeId: '1:3', type: 'slice', format: 'svg' },
        { nodeId: '1:3', type: 'slice', format: 'pdf' }, { nodeId: 'missing', type: 'image' },
      ] } });
      const records = (result.structuredContent as any).results;
      expect(records.map((r: any) => r.success)).toEqual([true, true, false, false]);
      expect(records[0].path).toContain(directory);
      const links = (result.content as any[]).filter(c => c.type === 'resource_link');
      expect(links).toHaveLength(2);
      const resource = await client.readResource({ uri: links[0].uri });
      expect(resource.contents[0]).not.toHaveProperty('blob');
      expect(resource.contents[0].mimeType).toBe('application/json');
      const manifest = JSON.parse((resource.contents[0] as any).text);
      expect(manifest).toMatchObject({ assetId: records[0].id, mimeType: 'image/png', bytes: png.length });
      expect(links[0].mimeType).toBe('application/json');
      const preview = await client.callTool(manifest.readTool);
      expect(preview.isError).not.toBe(true);
      const image = (preview.content as any[]).find(item => item.type === 'image');
      expect(Buffer.from(image.data, 'base64')).toEqual(png);
      const svg = (await client.readResource({ uri: links[1].uri })).contents[0];
      expect(svg.mimeType).toBe('image/svg+xml');
      expect(svg).toHaveProperty('text', expect.stringContaining('<svg'));
      expect(svg).not.toHaveProperty('blob');
      const svgPreview = await client.callTool({ name: 'moonvy_read_asset', arguments: { assetId: records[1].id } });
      expect((svgPreview.content as any[]).some(item => item.type === 'text' && item.text.includes('<svg'))).toBe(true);
      const chunks: Buffer[] = []; let offset: number | null = 0;
      do {
        const page = await client.callTool({ name: 'moonvy_read_asset', arguments: { assetId: records[0].id, format: 'base64', offset, length: 11 } });
        expect(page.isError).not.toBe(true);
        const data = page.structuredContent as any;
        chunks.push(Buffer.from(data.data, 'base64')); offset = data.nextOffset;
      } while (offset !== null);
      expect(Buffer.concat(chunks)).toEqual(png);
      const invalidOffset = await client.callTool({ name: 'moonvy_read_asset', arguments: { assetId: records[0].id, format: 'base64', offset: png.length + 1 } });
      expect(invalidOffset.structuredContent).toMatchObject({ code: 'INVALID_OFFSET' });
      const path = await client.callTool({ name: 'moonvy_read_asset', arguments: { assetId: '/etc/passwd' } });
      expect(path.isError).toBe(true);
      await expect(client.readResource({ uri: 'moonvy://assets/../../etc/passwd' })).rejects.toThrow();
      if (client === clients[1]) {
        const restarted = createServices(services.client.config, fixtureFetcher());
        expect(Buffer.from((await restarted.assets.read(links[0].uri.split('/').at(-1))).blob, 'base64')).toEqual(png);
      }
      const usage = await client.callTool({ name: 'moonvy_cleanup_assets', arguments: {} });
      expect(usage.structuredContent).toMatchObject({ records: 2, blobs: 2 });
    }
  });

  it('reports invalid nodes and rejects schema violations without leaking credentials', async () => {
    for (const client of clients) {
      const result = await client.callTool({ name: 'moonvy_get_node_style', arguments: { url: designUrl, nodeId: 'missing' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: 'NODE_NOT_FOUND' });
      expect(JSON.stringify(result)).not.toContain('local-test-secret');
      const invalid = await client.callTool({ name: 'moonvy_get_design_context', arguments: { url: designUrl, maxNodes: 0 } });
      expect(invalid.isError).toBe(true);
    }
  });

  it('rejects hostile Host/Origin, malformed JSON and unsupported HTTP methods', async () => {
    const hostileHost = await new Promise<number>((resolve, reject) => {
      const req = request(endpoint, { method: 'POST', headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    expect(hostileHost).toBe(403);
    expect((await fetch(endpoint, { method: 'POST', headers: { origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status).toBe(400);
    expect((await fetch(endpoint)).status).toBe(405);
  });
});
