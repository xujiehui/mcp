import { createHash } from 'node:crypto';
import { colorToCss } from './vendor/genome.js';
import type { Entry } from './genome.js';
import type { Genome } from './types.js';

type ObjectMap = Record<string, any>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const mapOf = (v: unknown): ObjectMap => Array.isArray(v) ? Object.fromEntries(v.filter(x => x?.id).map(x => [x.id, x])) : v && typeof v === 'object' ? v : {};
const aliasId = (v: any): string | undefined => v && typeof v === 'object' && typeof v.id === 'string' ? v.id : undefined;
const cssName = (id: string) => `--mv-${hash(id)}`;

export function variableDefs(genome: Genome, entries: Entry[], options: { modes?: Record<string, string>; includeUnbound?: boolean; exportFormat?: 'structured' | 'css' | 'json' } = {}) {
  const all = mapOf(genome.variables?.all), collections = mapOf(genome.variables?.collections);
  const bindings: Array<{ nodeId: string; path: string; variableId: string; modes: Record<string, string> }> = [];
  const used = new Set<string>();
  const inheritedModes = (entry: Entry) => {
    const ancestors: Entry[] = []; for (let e: Entry | null = entry; e; e = e.parent) ancestors.unshift(e);
    return Object.assign({}, ...ancestors.map(e => e.node._resolvedVariableModes ?? {}), options.modes ?? {}) as Record<string, string>;
  };
  for (const entry of entries) {
    const modes = inheritedModes(entry);
    const walk = (value: any, path: string, depth: number) => {
      if (!value || typeof value !== 'object' || depth > 20) return;
      if (typeof value.variableId === 'string') { used.add(value.variableId); bindings.push({ nodeId: String(entry.node.id ?? entry.node.nodeId), path, variableId: value.variableId, modes }); }
      for (const [key, child] of Object.entries(value)) if (!['children', 'masterInfo', 'componentSetInfo', 'snapshot', 'snapshotPreview'].includes(key)) walk(child, path ? `${path}.${key}` : key, depth + 1);
    };
    walk(entry.node, '', 0);
  }
  if (options.includeUnbound) Object.keys(all).forEach(id => used.add(id));
  // Include transitive aliases for every mode, including references that cannot be resolved.
  const queue = [...used];
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > 20_000) break;
    for (const value of Object.values(all[queue[index]]?.valuesByMode ?? {})) {
      const alias = aliasId(value); if (alias && !used.has(alias)) { used.add(alias); queue.push(alias); }
    }
  }
  const resolve = (id: string, modes: Record<string, string>, requestedMode?: string, chain: string[] = []): any => {
    if (chain.includes(id)) return { status: 'cycle', chain: [...chain, id] };
    if (chain.length >= 64) return { status: 'depth-limit', chain };
    const variable = all[id];
    if (!variable) return { status: 'missing-variable', variableId: id, chain };
    const collection = collections[variable.collectionId];
    const modeId = requestedMode ?? modes[variable.collectionId] ?? collection?.defaultModeId;
    const values = variable.valuesByMode ?? {};
    let actualMode = modeId, fallback = false;
    if (!Object.hasOwn(values, actualMode)) { actualMode = collection?.defaultModeId; fallback = true; }
    if (!Object.hasOwn(values, actualMode)) return { status: 'missing-mode', variableId: id, requestedMode: modeId ?? null };
    const raw = values[actualMode], alias = aliasId(raw);
    if (alias) return { ...resolve(alias, { ...modes, [variable.collectionId]: actualMode }, undefined, [...chain, id]), aliasId: alias, modeId: actualMode, fallback };
    return { status: 'resolved', value: raw, modeId: actualMode, fallback, chain: [...chain, id] };
  };
  const selectedCollections = new Set<string>();
  const definitions = [...used].sort().map(id => {
    const raw = all[id];
    if (!raw) return { id, status: 'missing-variable' };
    selectedCollections.add(raw.collectionId);
    return { ...raw, id, cssName: cssName(id), status: 'available', resolutions: Object.fromEntries(Object.keys(raw.valuesByMode ?? {}).map(mode => [mode, resolve(id, options.modes ?? {}, mode)])) };
  });
  const resolvedBindings = bindings.map(binding => ({ ...binding, resolution: resolve(binding.variableId, binding.modes) }));
  const modes = [...selectedCollections].filter(id => collections[id]).sort().map(id => ({ ...collections[id], id, modeSelectors: Object.fromEntries(Object.keys(mapOf(collections[id].modes)).map(mode => [mode, `${hash(id)}-${hash(mode)}`])) }));
  const data = { scope: options.includeUnbound ? 'file-including-unbound' : 'returned-nodes-and-alias-dependencies', definitions, collections: modes, bindings: resolvedBindings,
    numericUnit: 'number', warnings: ['Numeric variables have no assumed length unit. Bindings and extracted length tokens specify their usage. Missing references and alias cycles are reported without substitution.'] };
  if (options.exportFormat === 'json') return { ...data, export: { mimeType: 'application/json', text: JSON.stringify(data, null, 2) } };
  if (options.exportFormat === 'css') {
    const cssValue = (variable: any, value: any, resolution: any) => {
      if (resolution.status !== 'resolved') return null;
      const alias = aliasId(value); if (alias) return `var(${cssName(alias)})`;
      if (variable.resolvedType === 'COLOR') return colorToCss(value);
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'boolean') return value ? '1' : '0';
      if (typeof value === 'string') return JSON.stringify(value).replace(/[<>\u0000-\u001f]/g, c => `\\${c.charCodeAt(0).toString(16)} `);
      return null;
    };
    const blocks: string[] = [], defaults: string[] = [];
    for (const collection of modes) for (const [modeId, selector] of Object.entries(collection.modeSelectors)) {
      const lines: string[] = [];
      for (const id of [...used].sort()) {
        const v = all[id]; if (!v || v.collectionId !== collection.id) continue;
        const resolution = resolve(id, options.modes ?? {}, modeId);
        const value = cssValue(v, v.valuesByMode?.[resolution.modeId], resolution);
        if (value != null) lines.push(`  ${cssName(id)}: ${value};`);
      }
      if (modeId === (options.modes?.[collection.id] ?? collection.defaultModeId)) defaults.push(...lines);
      blocks.push(`[data-moonvy-mode~="${selector}"] {\n${lines.join('\n')}\n}`);
    }
    return { ...data, export: { mimeType: 'text/css', text: [':root {', ...defaults, '}', ...blocks].join('\n') } };
  }
  return data;
}
