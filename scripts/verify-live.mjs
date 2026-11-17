#!/usr/bin/env node
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SERVER_VERSION } from '../dist/version.js';

const input = process.argv.slice(2).find(value => !value.startsWith('--')) ?? process.env.MOONVY_VERIFY_URL;
if (!input || !process.env.MOONVY_TOKEN) {
  console.error('Usage: npm run verify:live -- <Moonvy project/directory/design URL> [--download]\nConfigure MOONVY_TOKEN locally first.');
  process.exit(1);
}
const client = new Client({ name: 'moonvy-live-verification', version: SERVER_VERSION });
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  if (result.isError) throw new Error(`${name}: ${result.structuredContent?.code ?? 'FAILED'}`);
  return result.structuredContent;
}
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && (key.startsWith('MOONVY_') || key === 'DOTENV_CONFIG_PATH')));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))], env, stderr: 'inherit' }));
  const ids = await call('moonvy_parse_url', { url: input });
  let url = input;
  if (!ids.fileId) {
    const listing = await call('moonvy_list_pages', { url });
    console.log(`List: ${listing.nodes.length} items; truncated=${listing.truncated}`);
    const candidates = listing.nodes.filter(item => !['any', 'dir', 'directory', 'folder'].includes(String(item.type).toLowerCase()));
    let found = false;
    for (const item of candidates.slice(0, 20)) {
      try { await call('moonvy_get_metadata', { url: item.url }); url = item.url; found = true; break; } catch { /* Skip non-design files. */ }
    }
    if (!found) throw new Error('No readable design found. Pass a concrete design file URL.');
  }
  const metadata = await call('moonvy_get_metadata', { url, forceRefresh: true });
  if (!metadata.frames.length) throw new Error('Design has no frames.');
  const nodeId = metadata.frames[0].id;
  console.log(`Metadata: ${metadata.frames.length} frames`);
  const context = await call('moonvy_get_design_context', { url, nodeId });
  console.log(`Context: ${context.nodeCount} nodes; truncated=${context.truncated}`);
  await call('moonvy_get_node_style', { url, nodeId });
  await call('moonvy_get_variable_defs', { url, nodeId });
  let screenshot = await call('moonvy_get_screenshot', { url, nodeId });
  if (!screenshot.available && screenshot.filePreviewAvailable) screenshot = await call('moonvy_get_screenshot', { url });
  console.log(`Screenshot: ${screenshot.available ? screenshot.sourceType : 'unavailable in upstream design'}`);
  if (process.argv.includes('--download') && context.assets.length) {
    const asset = context.assets[0];
    const result = await call('moonvy_download_assets', { url, assets: [{ nodeId: asset.nodeId, type: asset.types[0] }] });
    if (!result.results[0].success) throw new Error(`Asset download: ${result.results[0].error.code}`);
    await client.readResource({ uri: result.results[0].uri });
    const chunk = await call('moonvy_read_asset', { assetId: result.results[0].id, format: 'base64', length: 1024 });
    if (chunk.encoding !== 'base64') throw new Error('Asset byte read: unexpected encoding');
    console.log('Asset download and resource read: OK');
  }
  console.log('Live verification completed.');
} catch (error) {
  // Error messages here contain operation names/codes only, never upstream bodies.
  console.error(error instanceof Error ? error.message : 'Live verification failed.');
  process.exitCode = 1;
} finally { await client.close(); }
