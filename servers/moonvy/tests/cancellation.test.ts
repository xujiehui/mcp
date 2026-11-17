import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../src/http.js';
import { createServer, createServices } from '../src/server.js';
import { designUrl, fixtureConfig, fixtureFetcher } from './fixtures.js';

describe('MCP cancellation reaches upstream work', () => {
  let directory: string, listener: Server | undefined;
  const clients: Client[] = [];
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'moonvy-cancel-')); });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    if (listener) await new Promise<void>(resolve => { listener!.close(() => resolve()); listener!.closeAllConnections(); });
    listener = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  function stalled() {
    let signal: AbortSignal | undefined, release: (() => void) | undefined;
    const base = fixtureFetcher();
    const fetcher = vi.fn(async (input: any, init?: RequestInit) => {
      if (String(input).includes('/genome')) {
        signal = init?.signal ?? undefined;
        await new Promise<void>((resolve, reject) => { release = resolve; signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }); });
      }
      return base(input, init);
    });
    return { fetcher, get signal() { return signal; }, release: () => release!() };
  }

  async function httpClients(services: ReturnType<typeof createServices>, count: number) {
    const app = createHttpApp(services);
    listener = await new Promise<Server>((resolve, reject) => { const server = app.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve(server)); });
    const address = listener.address();
    const endpoint = new URL(`http://127.0.0.1:${typeof address === 'object' ? address!.port : 0}/mcp`);
    for (let index = 0; index < count; index++) {
      const client = new Client({ name: `cancel-http-${index}`, version: '1' });
      clients.push(client); await client.connect(new StreamableHTTPClientTransport(endpoint));
    }
    return clients;
  }

  it('forwards protocol cancellation of an individual call', async () => {
    const upstream = stalled(), services = createServices(fixtureConfig(directory), upstream.fetcher);
    const [local, remote] = InMemoryTransport.createLinkedPair();
    const server = createServer(services), client = new Client({ name: 'cancel-protocol', version: '1' });
    clients.push(client); await server.connect(remote); await client.connect(local);
    const abort = new AbortController();
    const outcome = client.callTool({ name: 'moonvy_get_metadata', arguments: { url: designUrl } }, undefined, { signal: abort.signal }).then(() => null, error => error);
    await vi.waitFor(() => expect(upstream.signal).toBeDefined());
    abort.abort(); expect(await outcome).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(upstream.signal?.aborted).toBe(true));
    expect(services.client.cacheStats().entries).toBe(0);
  });

  it('aborts upstream work when the last HTTP client disconnects', async () => {
    const upstream = stalled(), services = createServices(fixtureConfig(directory), upstream.fetcher);
    const [client] = await httpClients(services, 1);
    const outcome = client.callTool({ name: 'moonvy_get_metadata', arguments: { url: designUrl } }).then(() => null, error => error);
    await vi.waitFor(() => expect(upstream.signal).toBeDefined());
    await client.close(); expect(await outcome).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(upstream.signal?.aborted).toBe(true));
    expect(services.client.cacheStats().entries).toBe(0);
  });

  it('keeps a coalesced HTTP read alive when only one client disconnects', async () => {
    const upstream = stalled(), services = createServices(fixtureConfig(directory), upstream.fetcher);
    const reads = vi.spyOn(services.client, 'getDesign');
    const [first, second] = await httpClients(services, 2);
    const one = first.callTool({ name: 'moonvy_get_metadata', arguments: { url: designUrl } }).then(() => null, error => error);
    const two = second.callTool({ name: 'moonvy_get_metadata', arguments: { url: designUrl } });
    await vi.waitFor(() => { expect(reads).toHaveBeenCalledTimes(2); expect(upstream.signal).toBeDefined(); });
    await first.close(); expect(await one).toBeInstanceOf(Error);
    expect(upstream.signal?.aborted).toBe(false);
    upstream.release();
    const result = await two;
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as any).frames).toHaveLength(2);
    expect(upstream.fetcher).toHaveBeenCalledTimes(2);
  });
});
