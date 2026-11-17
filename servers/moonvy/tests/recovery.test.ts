import { describe, expect, it, vi } from 'vitest';
import { MoonvyClient } from '../src/client.js';
import { designUrl, fixtureConfig, fixtureFetcher, genome } from './fixtures.js';

describe('freshness, bounded retries and cancellation', () => {
  it('retries 429/503 and honors Retry-After without retrying authentication failures', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } })).mockResolvedValueOnce(Response.json({ id: 'ok' }));
    const client = new MoonvyClient({ ...fixtureConfig('/tmp/recovery'), retryBaseMs: 1 }, fetcher);
    expect(await client.api('/anynode/get', {})).toEqual({ id: 'ok' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const forbidden = vi.fn(async () => new Response('', { status: 403 }));
    await expect(new MoonvyClient(fixtureConfig('/tmp/recovery'), forbidden).api('/anynode/get', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it('stops at the retry limit and preserves one overall request deadline', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 500 }));
    const client = new MoonvyClient({ ...fixtureConfig('/tmp/recovery'), retryBaseMs: 1, maxRetries: 1 }, fetcher);
    await expect(client.api('/anynode/get', {})).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const rateLimited = new MoonvyClient({ ...fixtureConfig('/tmp/recovery'), timeoutMs: 10 }, vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '60' } })));
    await expect(rateLimited.api('/anynode/get', {})).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('force-refreshes content and returns the latest design revision', async () => {
    const base = fixtureFetcher(); let changed = false;
    const fetcher = vi.fn(async (input: any, init?: RequestInit) => String(input).includes('/genome') && changed ? Response.json({ ...genome, version: 'new' }) : base(input, init));
    const client = new MoonvyClient(fixtureConfig('/tmp/recovery'), fetcher);
    const first = await client.getDesign(designUrl); changed = true;
    expect((await client.getDesign(designUrl)).revision).toBe(first.revision);
    const refreshed = await client.getDesign(designUrl, { forceRefresh: true });
    expect(refreshed.revision).not.toBe(first.revision);
    expect(refreshed.version.contentHash).toBe(refreshed.document.revision);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('honors the estimated cache byte budget independently of entry count', async () => {
    const fetcher = vi.fn(fixtureFetcher());
    const client = new MoonvyClient({ ...fixtureConfig('/tmp/recovery'), cacheMaxBytes: 1 }, fetcher);
    await client.getDesign(designUrl); await client.getDesign(designUrl);
    expect(client.cacheStats()).toEqual({ entries: 0, estimatedBytes: 0 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('cancels one subscriber without cancelling a coalesced reader', async () => {
    const base = fixtureFetcher(); let release!: () => void, requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (input: any, init?: RequestInit) => {
      if (String(input).includes('/genome')) {
        requestSignal = init?.signal ?? undefined;
        await new Promise<void>((resolve, reject) => { release = resolve; requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true }); });
      }
      return base(input, init);
    });
    const client = new MoonvyClient(fixtureConfig('/tmp/recovery'), fetcher), abort = new AbortController();
    const first = client.getDesign(designUrl, { signal: abort.signal });
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    const second = client.getDesign(designUrl);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    abort.abort(); await firstRejected;
    expect(requestSignal?.aborted).toBe(false);
    release(); expect((await second).genome.pages).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('aborts the underlying request when its last subscriber cancels and never caches it', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: any, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
    }));
    const client = new MoonvyClient(fixtureConfig('/tmp/recovery'), fetcher), abort = new AbortController();
    const promise = client.getDesign(designUrl, { signal: abort.signal });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    abort.abort(); await assertion;
    expect(requestSignal?.aborted).toBe(true);
    expect(client.cacheStats().entries).toBe(0);
  });

  it('cancels a stalled response body at the deadline', async () => {
    let cancelled = false;
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    const client = new MoonvyClient({ ...fixtureConfig('/tmp/recovery'), timeoutMs: 10 }, fetcher);
    await expect(client.api('/anynode/get', {})).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancelled).toBe(true);
  });
});
