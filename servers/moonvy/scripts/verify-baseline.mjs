#!/usr/bin/env node
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { baselineSchema, verifyBaseline } from '../dist/baseline.js';
import { DesignDocument } from '../dist/genome.js';
import { MoonvyError, redact } from '../dist/errors.js';
import { SERVER_VERSION } from '../dist/version.js';

let client;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { genome: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('verify:baseline -- <baseline.json> [--genome <offline-genome.json>]'); process.exit(0); }
  const baseline = baselineSchema.parse(JSON.parse(await readFile(positionals[0] ?? new URL('../baselines/upstream-panel.json', import.meta.url), 'utf8')));
  let offline;
  if (values.genome) {
    if (baseline.designs.length !== 1) throw new Error('Offline mode requires a single-design baseline.');
    offline = new DesignDocument(JSON.parse(await readFile(values.genome, 'utf8')));
  } else {
    if (!process.env.MOONVY_TOKEN) throw new Error('MOONVY_TOKEN is missing; online baseline is NOT verified.');
    client = new Client({ name: 'moonvy-baseline-verifier', version: SERVER_VERSION });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && (key.startsWith('MOONVY_') || key === 'DOTENV_CONFIG_PATH')));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))], env, stderr: 'inherit' }));
  }
  const { differences, ...report } = await verifyBaseline(baseline, {
    async prepareDesign(design) {
      if (!client) return;
      const result = await client.callTool({ name: 'moonvy_get_metadata', arguments: { url: design.url, forceRefresh: true } }, undefined, { timeout: 180_000 });
      if (result.isError) throw new MoonvyError(result.structuredContent?.code ?? 'READ_FAILED', 'Design read failed.');
    },
    async readStyle(design, nodeId) {
      if (offline) {
        const entry = offline.select(nodeId);
        return { parentId: entry.parent?.node.id ?? null, style: offline.style(entry, { cssUnit: design.cssUnit }) };
      }
      const result = await client.callTool({ name: 'moonvy_get_node_style', arguments: { url: design.url, nodeId, cssUnit: design.cssUnit, maxBytes: 1024 * 1024 } }, undefined, { timeout: 180_000 });
      if (result.isError) throw new MoonvyError(result.structuredContent?.code ?? 'READ_FAILED', 'Style read failed.');
      return result.structuredContent;
    }
  });
  for (const difference of differences) console.error(JSON.stringify(redact(difference, [process.env.MOONVY_TOKEN ?? ''])));
  console.log(JSON.stringify({ mode: offline ? 'offline' : 'online', provenance: baseline.provenance.kind, ...report }));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  console.error(redact(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Invalid baseline file or verification failure.', [process.env.MOONVY_TOKEN ?? '']));
  process.exitCode = 1;
} finally { await client?.close(); }
