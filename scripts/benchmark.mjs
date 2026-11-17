#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { DesignDocument } from '../dist/genome.js';

// Synthetic CPU benchmark only: no network, credentials or claims about real files.
const count = 20_000, reads = 2000;
const genome = { pages: [{ id: 'root', type: 'artboard', rect: { w: 1440, h: 900 }, children: Array.from({ length: count }, (_, index) => ({
  id: `n${index}`, type: 'rectangle', name: `Layer ${index}`, rect: { x: index % 100 * 12, y: Math.floor(index / 100) * 12, w: 10, h: 10 },
  borderRadius: 2, fills: [{ type: 'color', color: { r: 0.2, g: 0.4, b: 1 } }],
})) }] };
const timed = fn => { const start = performance.now(); const value = fn(); return { value, ms: Math.round((performance.now() - start) * 100) / 100 }; };
const { value: doc, ms: parseMs } = timed(() => new DesignDocument(genome));
const ids = Array.from({ length: reads }, (_, index) => `n${(index * 7919) % count}`);
const indexed = timed(() => ids.map(id => doc.select(id)));
const linear = timed(() => ids.map(id => doc.entries.find(entry => entry.node.id === id)));
assert.deepEqual(indexed.value, linear.value);
const cold = timed(() => indexed.value.map(entry => doc.style(entry)));
const cached = timed(() => indexed.value.map(entry => doc.style(entry)));
assert.ok(cold.value.every((style, index) => style === cached.value[index]));
const bytes = format => Buffer.byteLength(JSON.stringify(doc.tree({ nodeId: 'root', maxNodes: 500, format }, true).tree));
console.log(JSON.stringify({
  provenance: 'synthetic', nodes: count + 1, reads, parseMs,
  lookupMs: { indexed: indexed.ms, equivalentLinearScan: linear.ms }, styleMs: { cold: cold.ms, cached: cached.ms },
  subtreeJsonBytes: { full: bytes('full'), compact: bytes('compact') },
  note: 'One local run; measures CPU and subtree JSON only, not upstream latency or complete MCP response bytes.',
}, null, 2));
