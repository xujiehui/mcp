import { deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { decodeGenome, MoonvyClient, parseMoonvyUrl, readLimited } from '../src/client.js';
import { redact } from '../src/errors.js';
import { designUrl, fixtureConfig, fixtureFetcher, genome } from './fixtures.js';

describe('Moonvy API adapter', () => {
  it('parses project/directory/file links and rejects unrelated or malformed URLs', () => {
    expect(parseMoonvyUrl(`${designUrl}?signature=secret`)).toMatchObject({ projectId: 'project', dirId: 'folder', fileId: 'design', cleanUrl: designUrl });
    expect(parseMoonvyUrl('https://moonvy.com/project/p').fileId).toBeNull();
    for (const url of ['http://moonvy.com/project/p', 'https://evilmoonvy.com/project/p', 'https://moonvy.com/project/%2F', 'https://moonvy.com/project/%zz', 'https://a:b@moonvy.com/project/p', 'https://moonvy.com/project/p/d/f/extra']) expect(() => parseMoonvyUrl(url)).toThrow();
  });

  it('decodes plain JSON, BOM, gzip and deflate with expansion limits', () => {
    const data = Buffer.from(JSON.stringify(genome));
    for (const encoded of [data, Buffer.from(`\ufeff${data.toString()}`), gzipSync(data), deflateSync(data)]) expect(decodeGenome(encoded, 100_000).pages).toHaveLength(2);
    expect(() => decodeGenome(gzipSync(Buffer.from(' '.repeat(10000))), 100)).toThrow('size limit');
    expect(() => decodeGenome(Buffer.from('{}'), 100)).toThrow('no supported pages');
    expect(() => decodeGenome(Buffer.from('invalid'), 100)).toThrow('valid JSON');
  });

  it('enforces streamed and declared byte limits', async () => {
    await expect(readLimited(new Response('12345'), 4)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(readLimited(new Response('x', { headers: { 'content-length': '100' } }), 4)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
  });

  it('handles authentication, permission failures and malformed HTTP-200 errors', async () => {
    for (const status of [401, 403, 500]) {
      const client = new MoonvyClient(fixtureConfig('/tmp/assets'), vi.fn(async () => new Response('secret upstream response', { status })));
      await expect(client.getDesign(designUrl)).rejects.toMatchObject({ code: status === 401 ? 'AUTH_EXPIRED' : status === 403 ? 'FORBIDDEN' : 'UPSTREAM_ERROR' });
    }
    const malformed = new MoonvyClient(fixtureConfig('/tmp/assets'), vi.fn(async () => new Response('not JSON')));
    await expect(malformed.getDesign(designUrl)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const logical = new MoonvyClient(fixtureConfig('/tmp/assets'), vi.fn(async () => Response.json({ code: 403, message: 'secret' })));
    await expect(logical.getDesign(designUrl)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const missing = new MoonvyClient({ ...fixtureConfig('/tmp/assets'), token: '' });
    await expect(missing.getDesign(designUrl)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('times out requests and does not forward credentials to file endpoints', async () => {
    const timeout = new MoonvyClient({ ...fixtureConfig('/tmp/assets'), timeoutMs: 10 }, vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    await expect(timeout.getDesign(designUrl)).rejects.toMatchObject({ code: 'TIMEOUT' });
    const fetcher = vi.fn(fixtureFetcher());
    await new MoonvyClient(fixtureConfig('/tmp/assets'), fetcher).getDesign(designUrl);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer local-test-secret' });
    expect(fetcher.mock.calls[1][1]?.headers).toBeUndefined();
  });

  it('caches, coalesces, expires, evicts and clears design data', async () => {
    const fetcher = vi.fn(fixtureFetcher());
    const client = new MoonvyClient({ ...fixtureConfig('/tmp/assets'), cacheMaxEntries: 1, cacheTtlMs: 10 }, fetcher);
    await Promise.all([client.getDesign(designUrl), client.getDesign(designUrl)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await client.getDesign(designUrl); expect(fetcher).toHaveBeenCalledTimes(2);
    await client.getDesign(designUrl.replace('/design', '/other')); expect(fetcher).toHaveBeenCalledTimes(4);
    await client.getDesign(designUrl); expect(fetcher).toHaveBeenCalledTimes(6);
    client.clearCache(); await client.getDesign(designUrl); expect(fetcher).toHaveBeenCalledTimes(8);
    await new Promise(resolve => setTimeout(resolve, 15));
    await client.getDesign(designUrl); expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it('recurses directories, deduplicates pages and reports limits or repeated pagination', async () => {
    const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ data: { items: body.id === 'folder' ? [{ id: 'design', type: 'design' }] : [{ id: 'folder', type: 'folder' }], hasMore: false } });
    });
    const client = new MoonvyClient(fixtureConfig('/tmp/assets'), fetcher);
    const result = await client.listPages('https://moonvy.com/project/project');
    expect(result.nodes).toHaveLength(2); expect(result.truncated).toBe(false);
    expect((await client.listPages('https://moonvy.com/project/project', 1)).truncated).toBe(true);
    expect((await client.listPages('https://moonvy.com/project/project', 10, 1)).truncated).toBe(true);
    const repeated = new MoonvyClient(fixtureConfig('/tmp/assets'), vi.fn(async () => Response.json({ items: [{ id: 'same', type: 'design' }] })));
    expect(await repeated.listPages('https://moonvy.com/project/project')).toMatchObject({ apiPages: 2, truncated: true });
    const invalid = new MoonvyClient(fixtureConfig('/tmp/assets'), vi.fn(async () => Response.json({ data: {} })));
    await expect(invalid.listPages('https://moonvy.com/project/p')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('redacts arbitrary configured tokens, JWTs, headers and signed URLs', () => {
    const value = redact({ token: 'abc', url: 'https://u:p@fs.moonvy.com/a?signature=secret#x', message: 'failed local-test-secret Bearer example-secret' }, ['local-test-secret']);
    expect(JSON.stringify(value)).not.toMatch(/signature|local-test-secret|example-secret|u:p/);
    expect(value).toMatchObject({ token: '[REDACTED]', url: 'https://fs.moonvy.com/a' });
  });
});
