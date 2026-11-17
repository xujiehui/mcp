import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, createServices } from '../src/server.js';
import { Diagnostics } from '../src/diagnostics.js';
import { MoonvyError } from '../src/errors.js';
import { SERVER_VERSION } from '../src/version.js';
import { designUrl, fixtureConfig, fixtureFetcher } from './fixtures.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function connect(fetcher: typeof fetch = fixtureFetcher(), config: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'moonvy-diagnose-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const services = createServices({ ...fixtureConfig(directory), ...config }, fetcher), server = createServer(services);
  const client = new Client({ name: 'diagnostic-client', version: 'test' }), [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote); await client.connect(local); cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })).structuredContent as any;
  return { services, client, call };
}

describe('bounded redacted diagnostics', () => {
  it('reports the running version/client/resource mode without validating an untested token', async () => {
    const fetcher = vi.fn(fixtureFetcher()), { call } = await connect(fetcher);
    const data = await call('moonvy_diagnose');
    expect(data.server).toMatchObject({ version: SERVER_VERSION, transport: 'stdio', resourceMode: 'text' });
    expect(data.client).toEqual({ name: 'diagnostic-client', version: 'test' });
    expect(data.credentialStatus).toEqual({ configured: true, validation: 'not-tested' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([['', 200, 'AUTH_REQUIRED'], ['configured', 401, 'AUTH_EXPIRED'], ['configured', 403, 'FORBIDDEN']])('distinguishes credentials and permissions (%s/%s)', async (token, status, code) => {
    const fetcher = vi.fn(async () => new Response('', { status }));
    const { call } = await connect(fetcher, { token, maxRetries: 0 });
    const error = await call('moonvy_get_metadata', { url: designUrl });
    expect(error).toMatchObject({ code, stage: 'moonvy-api', requestId: expect.any(String), suggestedAction: expect.any(String), retryable: false });
    const diagnostic = await call('moonvy_diagnose', { requestId: error.requestId });
    expect(diagnostic.observations.recent).toHaveLength(1);
    expect(diagnostic.observations.recent[0]).toMatchObject({ requestId: error.requestId, code, tool: 'moonvy_get_metadata' });
    expect(JSON.stringify(diagnostic)).not.toContain('local-test-secret');
    if (!token) expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['download', 'decode', 'index'])('identifies the %s failure stage', async stage => {
    const base = fixtureFetcher();
    const fetcher = (async (input: any, init?: RequestInit) => String(input).includes('/genome') ? stage === 'download' ? new Response('', { status: 403 }) : stage === 'decode' ? new Response('invalid-json') : Response.json({ pages: [null] }) : base(input, init)) as typeof fetch;
    const { call } = await connect(fetcher);
    const data = await call('moonvy_get_metadata', { url: designUrl });
    expect(data.stage).toBe(`genome-${stage}`);
    expect(JSON.stringify(data)).not.toMatch(/signature=|local-test-secret/);
  });
  it('freshly probes file access and does not infer file permission from directory access', async () => {
    const { call, services } = await connect();
    await services.client.getDesign(designUrl);
    const file = await call('moonvy_diagnose', { url: designUrl });
    expect(file.probe).toMatchObject({ scope: 'design-file', status: 'readable', genomeReadable: true });
    const directory = await call('moonvy_diagnose', { url: 'https://moonvy.com/project/project/folder' });
    expect(directory.probe).toMatchObject({ scope: 'project-or-directory', filePermissions: 'not-tested' });
    expect((await call('moonvy_diagnose', { recentLimit: 0 })).observations.recent).toEqual([]);
  });
  it('retains the failure stage when the overall tool deadline expires', async () => {
    const fetcher = (async (_: any, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))) as typeof fetch;
    const { call } = await connect(fetcher, { timeoutMs: 20, maxRetries: 0 });
    expect(await call('moonvy_get_metadata', { url: designUrl })).toMatchObject({ code: 'TIMEOUT', stage: 'moonvy-api', retryable: true });
  });
  it('isolates concurrent traces, bounds history and phases, and never stores error messages', async () => {
    const d = new Diagnostics(2);
    await Promise.all(['one', 'two'].map(name => d.run(name, async () => {
      await d.phase('moonvy-api', async () => { await Promise.resolve(); });
      if (name === 'one') await expect(d.phase('genome-decode', async () => { throw new MoonvyError('INVALID_GENOME', 'private?signature=secret'); })).rejects.toThrow();
      return {};
    })));
    const first = d.snapshot();
    expect(first.recent.find(t => t.tool === 'one')!.phases.map(p => p.stage)).toEqual(['moonvy-api', 'genome-decode']);
    expect(first.recent.find(t => t.tool === 'two')!.phases.map(p => p.stage)).toEqual(['moonvy-api']);
    await d.run('three', async () => { for (let i = 0; i < 100; i++) d.phaseSync('tool', () => 1); return { isError: true, structuredContent: { code: 'TIMEOUT' } }; });
    const last = d.snapshot();
    expect(last).toMatchObject({ totalCalls: 3, failedCalls: 1, activeCalls: 0, retained: 2 });
    expect(last.recent.at(-1)).toMatchObject({ phasesDropped: 36, status: 'error', code: 'TIMEOUT' });
    expect(JSON.stringify(last)).not.toContain('secret');
    first.recent[0].tool = 'mutated'; expect(d.snapshot().recent[0].tool).not.toBe('mutated');
  });
});
