#!/usr/bin/env node
import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SERVER_VERSION } from '../dist/version.js';

dotenv({ quiet: true });
const client = new Client({ name: 'moonvy-client-probe', version: SERVER_VERSION });
const report = { client: 'official-typescript-sdk', applicationCompatibility: 'not-verified', checks: {} };
try {
  const { values } = parseArgs({ options: { transport: { type: 'string', default: 'stdio' }, endpoint: { type: 'string' }, url: { type: 'string' }, cancel: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('verify:client -- [--transport stdio|http] [--endpoint <MCP URL>] [--url <Moonvy URL>] [--cancel]\nHTTP bearer: MOONVY_MCP_BEARER (local environment only). URL defaults to MOONVY_VERIFY_URL.'); process.exit(0); }
  if (!['stdio', 'http'].includes(values.transport)) throw new Error('INVALID_TRANSPORT');
  const url = values.url || process.env.MOONVY_VERIFY_URL;
  if (!url) throw new Error('VERIFY_URL_REQUIRED');
  const transport = values.transport === 'http' ? new StreamableHTTPClientTransport(new URL(values.endpoint || 'http://127.0.0.1:3333/mcp'), {
    requestInit: process.env.MOONVY_MCP_BEARER ? { headers: { authorization: `Bearer ${process.env.MOONVY_MCP_BEARER}` } } : undefined,
  }) : new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
    env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && (k.startsWith('MOONVY_') || k === 'DOTENV_CONFIG_PATH'))), stderr: 'inherit' });
  await client.connect(transport);
  report.transport = values.transport; report.server = client.getServerVersion(); report.checks.initialize = true;
  const { tools } = await client.listTools(); report.checks.tools = tools.length;
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    if (result.isError) throw new Error(`${name}:${result.structuredContent?.code || 'FAILED'}`);
    return result;
  };
  const diagnostic = (await call('moonvy_diagnose')).structuredContent;
  report.upstream = diagnostic.server;
  let designUrl = url;
  const ids = (await call('moonvy_parse_url', { url })).structuredContent;
  if (!ids.fileId) {
    const listing = (await call('moonvy_list_pages', { url, limit: 20, maxApiPages: 10 })).structuredContent;
    const file = listing.nodes.find(n => !['any', 'dir', 'directory', 'folder'].includes(String(n.type).toLowerCase()));
    if (!file) throw new Error('READABLE_DESIGN_REQUIRED');
    designUrl = file.url;
  }
  const metadata = (await call('moonvy_get_metadata', { url: designUrl, forceRefresh: true })).structuredContent;
  if (!metadata.frames.length) throw new Error('EMPTY_DESIGN');
  const nodeId = metadata.frames[0].id;
  const context = await call('moonvy_get_design_context', { url: designUrl, nodeId, maxDepth: 10, maxNodes: 2000, maxBytes: 1048576 });
  report.checks.context = { nodes: context.structuredContent.nodeCount, responseBytes: Buffer.byteLength(JSON.stringify(context)), paginated: Boolean(context.structuredContent.nextCursor) };
  const screenshot = await call('moonvy_get_screenshot', { url: designUrl, nodeId });
  report.checks.image = screenshot.structuredContent.available ? (screenshot.content.some(c => c.type === 'image' && Buffer.from(c.data, 'base64').length === screenshot.structuredContent.bytes) ? 'passed' : 'invalid') : 'unavailable-in-source';
  if (report.checks.image === 'invalid') throw new Error('INVALID_IMAGE_CONTENT');
  const asset = context.structuredContent.assets[0];
  if (asset) {
    const request = { nodeId: asset.nodeId, type: asset.types[0] };
    const downloaded = (await call('moonvy_download_assets', { url: designUrl, assets: [request] })).structuredContent.results[0];
    if (!downloaded.success) throw new Error(`ASSET:${downloaded.error.code}`);
    const resource = await client.readResource({ uri: downloaded.uri });
    report.checks.resource = { mimeType: resource.contents[0].mimeType, binary: 'blob' in resource.contents[0] };
    const chunks = []; let offset = 0;
    do {
      const chunk = (await call('moonvy_read_asset', { assetId: downloaded.id, format: 'base64', offset })).structuredContent;
      chunks.push(Buffer.from(chunk.data, 'base64')); offset = chunk.nextOffset;
    } while (offset !== null);
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== downloaded.bytes) throw new Error('BYTE_READ_LENGTH_MISMATCH');
    report.checks.byteRead = { bytes: bytes.length, chunks: chunks.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    if (downloaded.bytes <= diagnostic.limits.maxImageBytes && /^image\//.test(downloaded.mimeType)) {
      const preview = await call('moonvy_read_asset', { assetId: downloaded.id });
      const image = preview.content.find(c => c.type === 'image');
      if (image && !Buffer.from(image.data, 'base64').equals(bytes)) throw new Error('PREVIEW_BYTE_MISMATCH');
      report.checks.assetPreview = image ? 'image-bytes-match' : 'text';
    }
  } else report.checks.resource = 'unavailable-in-returned-subtree';
  if (values.cancel) {
    const abort = new AbortController();
    const pending = client.callTool({ name: 'moonvy_get_metadata', arguments: { url: designUrl, forceRefresh: true } }, undefined, { signal: abort.signal }).then(() => false, () => true);
    abort.abort();
    if (values.transport === 'http') await client.close();
    report.checks.cancel = { clientObserved: await pending, serverStopped: 'covered-by-mock-tests-not-observed-by-this-probe' };
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error && /^[A-Za-z0-9_:-]+$/.test(error.message) ? error.message : 'CLIENT_PROBE_FAILED';
  process.exitCode = 1;
} finally { await client.close(); }
console.log(JSON.stringify(report));
