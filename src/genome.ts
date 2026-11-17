import { createHash } from 'node:crypto';
import { extractNodeStyle, getGenomePages, relativeMetrics } from './vendor/genome.js';
import { makeCursor, readCursor } from './pagination.js';
import { layoutHints } from './semantic.js';
import { nativeLayout } from './native-layout.js';
import { applyComplexStyle } from './complex-style.js';
import { imageFills } from './image-fills.js';
import { MoonvyError } from './errors.js';
import type { Genome, GenomeNode, SelectionOptions } from './types.js';

export interface Entry {
  node: GenomeNode;
  parent: Entry | null;
  frame: GenomeNode;
  hidden: boolean;
  index: number;
  end: number;
  depth: number;
}
const idOf = (node: GenomeNode) => String(node.id ?? node.nodeId ?? '');
const childrenOf = (node: GenomeNode): GenomeNode[] => Array.isArray(node.children) ? node.children : [];
const documents = new WeakMap<Genome, DesignDocument>();
export function getDocument(genome: Genome) {
  let doc = documents.get(genome);
  if (!doc) { doc = new DesignDocument(genome); documents.set(genome, doc); }
  return doc;
}

export class DesignDocument {
  readonly roots: Entry[] = [];
  readonly entries: Entry[] = [];
  readonly revision: string;
  readonly sourceBytes: number;
  private byNode = new Map<GenomeNode, Entry>();
  private byId = new Map<string, Entry[]>();
  private byShortId = new Map<string, Entry[]>();
  private styles = new WeakMap<Entry, Map<string, Record<string, any>>>();
  constructor(readonly genome: Genome) {
    const serialized = JSON.stringify(genome);
    this.sourceBytes = Buffer.byteLength(serialized);
    this.revision = createHash('sha256').update(serialized).digest('hex');
    const pages: GenomeNode[] = getGenomePages(genome);
    if (pages.some(node => !node || typeof node !== 'object' || Array.isArray(node))) throw new MoonvyError('INVALID_GENOME', 'Genome contains an invalid page.');
    const roots: Entry[] = pages.map(node => ({ node, parent: null, frame: node, hidden: node.visible === false || node.hidden === true, index: 0, end: 0, depth: 0 }));
    this.roots = roots;
    const queue: Array<{ entry: Entry; exit?: boolean }> = roots.toReversed().map(entry => ({ entry }));
    const visited = new Set<GenomeNode>();
    while (queue.length) {
      const { entry, exit } = queue.pop()!;
      if (exit) { entry.end = this.entries.length; continue; }
      if (!entry.node || typeof entry.node !== 'object' || visited.has(entry.node)) throw new MoonvyError('INVALID_GENOME', 'Invalid or repeated node in Genome.');
      visited.add(entry.node);
      entry.index = this.entries.length;
      this.entries.push(entry); this.byNode.set(entry.node, entry);
      const id = idOf(entry.node), shortId = id.split(';').at(-1)!;
      const exactEntries = this.byId.get(id) ?? []; exactEntries.push(entry); this.byId.set(id, exactEntries);
      const shortEntries = this.byShortId.get(shortId) ?? []; shortEntries.push(entry); this.byShortId.set(shortId, shortEntries);
      if (this.entries.length > 200_000) throw new MoonvyError('SIZE_LIMIT', 'Genome contains too many nodes.');
      queue.push({ entry, exit: true });
      for (const node of childrenOf(entry.node).toReversed()) queue.push({ entry: { node, parent: entry, frame: entry.frame, hidden: entry.hidden || node?.visible === false || node?.hidden === true, index: 0, end: 0, depth: entry.depth + 1 } });
    }
  }

  select(nodeId: string): Entry {
    const exact = this.byId.get(nodeId) ?? [];
    if (exact.length === 1) return exact[0];
    const shortId = nodeId.split(';').at(-1)!;
    const candidates = exact.length ? exact : this.byShortId.get(shortId) ?? [];
    if (candidates.length === 1) return candidates[0];
    throw new MoonvyError(candidates.length ? 'AMBIGUOUS_NODE' : 'NODE_NOT_FOUND', candidates.length ? 'Node ID is ambiguous; use a complete ID.' : `Node ${nodeId} was not found.`, {
      candidates: candidates.slice(0, 50).map(e => idOf(e.node)), candidateCount: candidates.length,
      frames: this.frames().slice(0, 50), frameCount: this.roots.length,
    });
  }

  frames() {
    return this.roots.map(({ node }) => ({ id: idOf(node), name: String(node.name ?? ''), type: String(node.type ?? ''),
      width: Number(node.rect?.w ?? node.rect?.width ?? node.frame?.width ?? 0),
      height: Number(node.rect?.h ?? node.rect?.height ?? node.frame?.height ?? 0), childCount: childrenOf(node).length }));
  }

  style(entry: Entry, options: SelectionOptions = {}): Record<string, any> {
    const key = `${options.cssUnit ?? 'px'}:${options.cssLayout ?? 'absolute'}`;
    const cached = this.styles.get(entry)?.get(key);
    if (cached) return cached;
    const frameWidth = Number(entry.frame.rect?.w ?? entry.frame.rect?.width ?? entry.frame.frame?.width ?? 0);
    if (options.cssUnit === 'rpx' && !(frameWidth > 0)) throw new MoonvyError('INVALID_UNITS', 'rpx requires a positive artboard width.');
    const style: Record<string, any> = extractNodeStyle(this.genome, entry.node, entry.parent?.node ?? null, {
      cssUnit: options.cssUnit ?? 'px', artboardWidth: frameWidth,
    });
    const segments = entry.node.textbox?.segments;
    const warnings: string[] = [];
    if (Array.isArray(segments)) {
      style.richTextSegments = segments;
      if (segments.length > 1) warnings.push('CSS typography summarizes the first text segment. Use richTextSegments for per-run overrides, links and decoration.');
    }
    if (style.fills.some((fill: string) => fill.startsWith('image:'))) warnings.push('Image fills require downloaded assets; CSS cannot reproduce the image layers until resource URLs are resolved.');
    if (style.fillDetails.some((fill: any) => !fill.css)) warnings.push('Unsupported fill types are retained with source parameters in fillDetails; they are omitted from CSS.');
    if (style.borders.some((border: any) => !border.css)) warnings.push('Unsupported strokes are retained with source parameters in borders; invalid CSS borders are omitted.');
    const composedStrokes = style.borders.length > 1 && style.borders.every((border: any) => border.width != null && /^(#|rgba?\()/.test(border.color ?? '') && border.style === 'solid' && ['inside', 'outside', 'center'].includes(border.position));
    if (style.borders.length > 1 && !composedStrokes) warnings.push('CSS cannot compose these strokes exactly; the first stroke is summarized and all source borders are retained.');
    if (!composedStrokes && style.borders.some((border: any) => border.position && border.position !== 'inside')) warnings.push('CSS border does not reproduce outside/center stroke alignment; source alignment is retained in borders.');
    if (style.effects.some((effect: any) => !String(effect.type).toLowerCase().includes('shadow') && !['filterBlur', 'filterBackdropBlur'].includes(effect.type))) warnings.push('Non-shadow effects with unsupported types are retained as source parameters and are not reproduced by CSS.');
    if (style.typography?.letterSpacingUnit && !['px', '%', 'em', 'rem', 'auto'].includes(style.typography.letterSpacingUnit)) warnings.push('Unsupported letter-spacing unit is retained; CSS letterSpacing is omitted.');
    if (style.typography?.lineHeightUnit && !['px', '%', 'em', 'rem', 'number', 'auto'].includes(style.typography.lineHeightUnit)) warnings.push('Unsupported line-height unit is retained; CSS lineHeight is omitted.');
    if (String(style.typography?.color ?? '').includes('gradient(') || String(style.typography?.color ?? '').startsWith('image:')) warnings.push('Gradient/image text fills are retained in typography; CSS color is omitted and requires a separate text-fill implementation.');
    if (style.clipContent === true) style.css.overflow = 'hidden';
    style.layoutHints = layoutHints(this, entry, style.units);
    style.sourceConstraints = { constraints: entry.node.constraints ?? null, layoutMode: entry.node.layoutMode ?? null, layout: entry.node.layout ?? null, autoLayout: entry.node.autoLayout ?? null };
    style.nativeLayout = nativeLayout(this.genome, entry, style.units);
    style.geometry = { coordinateSpace: style.layout.coordinateSpace, sourceTransform: entry.node.relativeTransform ?? entry.node.transform ?? null, sourceRotation: entry.node.rotation ?? null };
    const matrix = entry.node.relativeTransform;
    if (Array.isArray(matrix) && matrix.length === 2 && matrix.every((row: any) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite))) {
      const [[a, c, x], [b, d, y]] = matrix;
      const length = (value: number) => `${Math.round(value * style.units.scale * 10000) / 10000}${style.units.cssUnit}`;
      Object.assign(style.layout, { relativeX: x, relativeY: y, coordinateSpace: 'parent', right: entry.parent ? this.layout(entry.parent).width - x - style.layout.width : null, bottom: entry.parent ? this.layout(entry.parent).height - y - style.layout.height : null });
      Object.assign(style.css, { left: length(x), top: length(y), transform: `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`, transformOrigin: '0 0' });
      if (![a, d].every(v => v === 1) || b !== 0 || c !== 0) warnings.push('Relative transform is preserved. Verify whether rect dimensions describe local size or transformed bounds against the source design.');
    } else if (entry.node.rotation) warnings.push('Standalone source rotation is retained in geometry; its coordinate convention is not established.');
    applyComplexStyle(entry.node, style, warnings);
    if (style.nativeLayout) {
      warnings.push(...style.nativeLayout.warnings);
      style.responsiveCss = { ...style.css, ...style.nativeLayout.css };
      if (style.nativeLayout.flowChild) {
        delete style.responsiveCss.left; delete style.responsiveCss.top;
        if (style.nativeLayout.sizing.fillsParentMainAxis) delete style.responsiveCss[entry.parent?.node.autoLayout?.direction === 'VERTICAL' ? 'height' : 'width'];
        if (style.nativeLayout.sizing.fillsParentCrossAxis) delete style.responsiveCss[entry.parent?.node.autoLayout?.direction === 'VERTICAL' ? 'width' : 'height'];
      }
      if (options.cssLayout === 'auto' && style.nativeLayout.supported) { style.geometryCss = style.css; style.css = style.responsiveCss; }
    }
    if (warnings.length) style.warnings = warnings;
    const cache = this.styles.get(entry) ?? new Map(); cache.set(key, style); this.styles.set(entry, cache);
    return style;
  }

  layout(entry: Entry): Record<string, any> {
    const layout = relativeMetrics(entry.node, entry.parent?.node ?? null);
    const matrix = entry.node.relativeTransform;
    if (Array.isArray(matrix) && matrix.length === 2 && matrix.every((row: any) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite))) {
      const x = matrix[0][2], y = matrix[1][2];
      Object.assign(layout, { relativeX: x, relativeY: y, coordinateSpace: 'parent', right: entry.parent ? Number(entry.parent.node.rect?.w ?? entry.parent.node.rect?.width ?? entry.parent.node.frame?.width ?? 0) - x - layout.width : null, bottom: entry.parent ? Number(entry.parent.node.rect?.h ?? entry.parent.node.rect?.height ?? entry.parent.node.frame?.height ?? 0) - y - layout.height : null });
    }
    return layout;
  }

  children(entry: Entry): Entry[] {
    return childrenOf(entry.node).map(node => this.byNode.get(node)!);
  }

  projectStyle(entry: Entry, options: SelectionOptions = {}) {
    const style = this.style(entry, options);
    const keys = options.fields ?? (options.format === 'compact' ? ['css', 'units', 'warnings'] : Object.keys(style));
    const projected = Object.fromEntries(keys.filter(key => key in style).map(key => [key, style[key]]));
    let textTruncated = false;
    const visit = (value: any, key = '', depth = 0): any => {
      if (depth > 20) { textTruncated = true; return { omitted: true }; }
      if (typeof value === 'string' && ['text', 'characters'].includes(key) && value.length > (options.maxTextLength ?? 2048)) { textTruncated = true; return value.slice(0, options.maxTextLength ?? 2048); }
      if (Array.isArray(value)) return value.map(item => visit(item, key, depth + 1));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k, depth + 1)]));
      return value;
    };
    const result = visit(projected);
    if (textTruncated) result.textTruncated = true;
    return result;
  }

  tree(options: SelectionOptions = {}, withStyle = true) {
    const maxDepth = options.maxDepth ?? 4, maxNodes = options.maxNodes ?? 500;
    const roots = options.nodeId ? [this.select(options.nodeId)] : this.roots;
    const scope = { tool: 'tree', nodeId: options.nodeId ?? null, maxDepth, includeHidden: options.includeHidden ?? false };
    const offset = readCursor(options.cursor, this.revision, scope);
    const candidates = roots.flatMap(root => this.entries.slice(root.index, root.end).filter(entry => (options.includeHidden || !entry.hidden) && entry.depth - root.depth <= maxDepth));
    if (offset > candidates.length) throw new MoonvyError('INVALID_CURSOR', 'Cursor offset is outside this result.');
    const selected = candidates.slice(offset, offset + maxNodes);
    const selectedSet = new Set(selected);
    const tree: Array<Record<string, any>> = [], outputs = new Map<Entry, Record<string, any>>();
    const continuation = new Set<string>();
    const omitted = new Set<string>();
    for (const entry of selected) {
      const layout = this.layout(entry);
      const item: Record<string, any> = { id: idOf(entry.node), name: String(entry.node.name ?? ''), type: String(entry.node.type ?? ''), parentId: entry.parent ? idOf(entry.parent.node) : null, ...layout };
      if (withStyle) item.style = this.projectStyle(entry, options);
      const text = entry.node.textbox?.text ?? entry.node.characters ?? entry.node.text;
      if (typeof text === 'string') { item.text = text.slice(0, options.maxTextLength ?? 2048); if (text.length > item.text.length) item.textTruncated = true; }
      const children = childrenOf(entry.node).filter(node => options.includeHidden || !this.byNode.get(node)!.hidden);
      if (children.length) item.childCount = children.length;
      outputs.set(entry, item);
      const parent = entry.parent && outputs.get(entry.parent);
      if (parent) (parent.children ??= []).push(item); else tree.push(item);
      for (const child of children) if (!selectedSet.has(this.byNode.get(child)!)) { omitted.add(idOf(child)); if (continuation.size < 50) continuation.add(idOf(child)); }
    }
    const nextOffset = offset + selected.length;
    if (nextOffset < candidates.length) { omitted.add(idOf(candidates[nextOffset].node)); if (continuation.size < 50) continuation.add(idOf(candidates[nextOffset].node)); }
    return { tree, selected, nodeCount: selected.length, truncated: omitted.size > 0, continuationNodeIds: [...continuation], continuationCount: omitted.size,
      nextCursor: nextOffset < candidates.length ? makeCursor(this.revision, scope, nextOffset) : null, revision: this.revision, maxDepth, maxNodes };
  }

  search(options: { nodeId?: string; parentId?: string; query?: string; types?: string[]; includeHidden?: boolean; cursor?: string; limit?: number }) {
    const root = options.nodeId ? this.select(options.nodeId) : null;
    const scope = { tool: 'search', nodeId: options.nodeId ?? null, parentId: options.parentId ?? null, query: options.query ?? '', types: options.types ?? [], includeHidden: options.includeHidden ?? false };
    const offset = readCursor(options.cursor, this.revision, scope), query = (options.query ?? '').toLocaleLowerCase();
    const types = new Set(options.types?.map(type => type.toLocaleLowerCase()));
    const matches = (root ? this.entries.slice(root.index, root.end) : this.entries).filter(entry => {
      if ((!options.includeHidden && entry.hidden) || (options.parentId && idOf(entry.parent?.node ?? {}) !== options.parentId)) return false;
      if (types.size && !types.has(String(entry.node.type ?? '').toLocaleLowerCase())) return false;
      return !query || [entry.node.name, entry.node.textbox?.text, entry.node.characters, entry.node.text].some(text => typeof text === 'string' && text.toLocaleLowerCase().includes(query));
    });
    if (offset > matches.length) throw new MoonvyError('INVALID_CURSOR', 'Cursor offset is outside this result.');
    const page = matches.slice(offset, offset + (options.limit ?? 100)), nextOffset = offset + page.length;
    return { nodes: page.map(entry => ({ id: idOf(entry.node), name: String(entry.node.name ?? ''), type: String(entry.node.type ?? ''), parentId: entry.parent ? idOf(entry.parent.node) : null,
      ...this.layout(entry), text: String(entry.node.textbox?.text ?? entry.node.characters ?? entry.node.text ?? '').slice(0, 200) })), total: matches.length, revision: this.revision,
      nextCursor: nextOffset < matches.length ? makeCursor(this.revision, scope, nextOffset) : null };
  }

  tokens(entries: Entry[], options: SelectionOptions = {}) {
    const colors = new Set<string>(), gradients = new Set<string>(), fonts = new Set<string>(), fontSizes = new Set<number>(), radii = new Set<number>();
    const fontWeights = new Set<string>(), letterSpacings = new Set<number>();
    const shadows = new Set<string>(), lineHeights = new Map<string, unknown>(), letterSpacingDetails = new Map<string, unknown>(), spacing = new Set<number>();
    const shared = { fillStyles: new Set<string>(), textStyles: new Set<string>() };
    const visible = new Set(entries.map(e => e.node));
    for (const entry of entries) {
      const style = this.style(entry, options);
      const addColor = (value: unknown) => {
        if (typeof value !== 'string' || value.startsWith('image:')) return;
        (value.includes('gradient(') ? gradients : colors).add(value);
      };
      style.fills.forEach(addColor);
      style.borders.forEach((b: any) => addColor(b.color));
      const textStyles = style.textRuns?.length ? style.textRuns.map((run: any) => ({ typography: run.typography, css: run.css })) : style.typography ? [{ typography: style.typography, css: style.css }] : [];
      for (const textStyle of textStyles) {
        const text = textStyle.typography;
        if (!text) continue;
        addColor(text.color);
        if (text.fontFamily) fonts.add(text.fontFamily);
        if (text.fontSize != null) fontSizes.add(text.fontSize);
        if (text.fontWeight != null) fontWeights.add(String(text.fontWeight));
        if (text.letterSpacing != null) {
          if (text.letterSpacingUnit === 'px') letterSpacings.add(text.letterSpacing);
          const value = { value: text.letterSpacing, unit: text.letterSpacingUnit, css: textStyle.css.letterSpacing ?? null };
          letterSpacingDetails.set(JSON.stringify(value), value);
        }
        if (text.lineHeightUnit != null) {
          const value = { value: text.lineHeight, unit: text.lineHeightUnit, css: textStyle.css.lineHeight ?? null };
          lineHeights.set(JSON.stringify(value), value);
        }
      }
      const radius = style.borderRadius;
      for (const value of Array.isArray(radius) ? radius : [radius]) if (typeof value === 'number') radii.add(value);
      for (const effect of style.effects) if (effect.css) shadows.add(effect.css);
      if (entry.node.fillLink) shared.fillStyles.add(entry.node.fillLink);
      if (entry.node.textLink) shared.textStyles.add(entry.node.textLink);
      for (const segment of entry.node.textbox?.segments ?? []) if (segment.textLink) shared.textStyles.add(segment.textLink);
      const children = childrenOf(entry.node).filter(n => visible.has(n)).map(n => this.style(this.byNode.get(n)!, options).layout);
      if (children.length) {
        const positive = (n: number) => { if (n > 0 && Number.isFinite(n)) spacing.add(Math.round(n * 10000) / 10000); };
        positive(Math.min(...children.map(c => c.relativeX)));
        positive(Math.min(...children.map(c => c.relativeY)));
        positive(style.layout.width - Math.max(...children.map(c => c.relativeX + c.width)));
        positive(style.layout.height - Math.max(...children.map(c => c.relativeY + c.height)));
        for (const [axis, size] of [['relativeX', 'width'], ['relativeY', 'height']]) {
          const sorted = [...children].sort((a, b) => a[axis] - b[axis]);
          for (let i = 1; i < sorted.length; i++) positive(sorted[i][axis] - sorted[i - 1][axis] - sorted[i - 1][size]);
        }
      }
    }
    const numeric = (values: Set<number>) => [...values].sort((a, b) => a - b);
    return {
      sourceUnit: 'px', colors: [...colors].sort(), gradients: [...gradients].sort(), fontFamilies: [...fonts].sort(),
      fontSizes: numeric(fontSizes), fontWeights: [...fontWeights].sort(), letterSpacings: numeric(letterSpacings), letterSpacingDetails: [...letterSpacingDetails.values()], radii: numeric(radii), lineHeightDetails: [...lineHeights.values()], shadows: [...shadows].sort(),
      spacing: { source: 'inferred', values: numeric(spacing), unit: 'px' },
      sharedStyles: Object.fromEntries(Object.entries(shared).map(([kind, ids]) => [kind, (this.genome.styles?.[kind] ?? []).filter((s: any) => ids.has(s.id))])),
      coverage: 'returned nodes only',
    };
  }

  assetRefs(entries: Entry[]) {
    return entries.flatMap(({ node }) => {
      const kinds: string[] = [];
      if (node.slices && Object.keys(node.slices).length) kinds.push('slice');
      if (node.snapshot || node.snapshotPreview) kinds.push('snapshot');
      const images = imageFills(this.genome, node);
      if (images.length) kinds.push('image');
      return kinds.length ? [{ nodeId: idOf(node), name: String(node.name ?? ''), types: kinds, ...(images.length ? { images } : {}),
        ...(node.slices ? { sliceVariants: Object.keys(node.slices) } : {}) }] : [];
    });
  }
}
