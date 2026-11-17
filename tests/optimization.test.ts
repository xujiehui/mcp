import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DesignDocument, getDocument } from '../src/genome.js';
import { baselineSchema, compareBaselineSample } from '../src/baseline.js';
import { genome } from './fixtures.js';

describe('style precision and independent baselines', () => {
  it('checks hand-authored expectations for percent spacing, inner shadows, runs and multiple fills/strokes', async () => {
    const doc = new DesignDocument(JSON.parse(await readFile('baselines/synthetic-genome.json', 'utf8')));
    const baseline = baselineSchema.parse(JSON.parse(await readFile('baselines/synthetic.json', 'utf8')));
    for (const sample of baseline.designs[0].samples) {
      const entry = doc.select(sample.nodeId), style = doc.style(entry, { cssUnit: 'rpx' });
      expect(compareBaselineSample(style, sample, [style.layout.relativeX * 2, style.layout.relativeY * 2])).toEqual([]);
    }
    const style = doc.style(doc.select('text'));
    expect(style.css.letterSpacing).toBe('0.1em');
    expect(style.textRuns[1].css.fontFamily).toBe('Inter');
    expect(style.textRuns[1].css).not.toHaveProperty('width');
    expect(style.textRuns[1].css).not.toHaveProperty('position');
    expect(style.textRuns[1].css).not.toHaveProperty('opacity');
    const wrong = { ...baseline.designs[0].samples[0], css: { letterSpacing: '10px' } };
    expect(compareBaselineSample(style, wrong)).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'css.letterSpacing' })]));
  });

  it('retains the upstream panel observations as independently sourced real expectations', async () => {
    const baseline = baselineSchema.parse(JSON.parse(await readFile('baselines/upstream-panel.json', 'utf8')));
    expect(baseline.provenance.kind).toBe('moonvy-panel');
    expect(baseline.provenance.source).toContain('0021b2b1');
    expect(baseline.designs).toHaveLength(4);
    expect(baseline.designs.flatMap(design => design.samples)).toHaveLength(10);
    expect(baseline.designs[0].samples[0].css?.background).toContain('192.34% 97.67%');
  });

  it('keeps zero/negative percentage spacing in em, px in source units, unknown units explicit', () => {
    for (const [value, unit, expected] of [[0, 'per', '0em'], [-5, '%', '-0.05em'], [2, 'px', '4rpx'], [0.2, 'em', '0.2em'], [10, 'pt', undefined]] as const) {
      const node = { id: 't', type: 'text', rect: { w: 375 }, textbox: { text: 'x', segments: [{ letterSpacing: { value, unit } }] } };
      const doc = new DesignDocument({ pages: [node] }), style = doc.style(doc.select('t'), { cssUnit: 'rpx' });
      expect(style.css.letterSpacing).toBe(expected);
      if (unit === 'pt') expect(style.warnings.join(' ')).toContain('Unsupported letter-spacing');
      expect(style.css.fontSize).toBeUndefined();
    }
  });

  it('does not invent rich-text ranges and includes all runs in typography tokens', () => {
    const doc = new DesignDocument(genome), entry = doc.select('1:2');
    expect(doc.style(entry).textRuns.every((run: any) => !run.rangeKnown)).toBe(true);
    expect(doc.tokens([entry]).fontSizes).toEqual([16, 20]);
  });

  it('converts fractional artboard ratios without early rounding', () => {
    const doc = new DesignDocument({ pages: [{ id: 'web', rect: { w: 1440, h: 900 }, children: [{ id: 'child', rect: { w: 100, h: 20 } }] }] });
    const frame = doc.style(doc.select('web'), { cssUnit: 'rpx' });
    expect(frame.css.width).toBe('750rpx');
    expect(frame.units.scale).toBe(750 / 1440);
    expect(doc.style(doc.select('child'), { cssUnit: 'rpx' }).css.width).toBe('52.0833rpx');
  });

  it('retains unsupported text fill data without emitting invalid CSS color', () => {
    const doc = new DesignDocument({ pages: [{ id: 't', type: 'text', rect: { w: 375 }, textbox: { text: 'x', segments: [{ fills: [{ type: 'image', imageHash: 'photo' }], lineHeight: { value: 10, unit: 'pt' } }] } }] });
    const style = doc.style(doc.select('t'));
    expect(style.typography.color).toBe('image:photo');
    expect(style.css).not.toHaveProperty('color');
    expect(style.css).not.toHaveProperty('lineHeight');
    expect(style.warnings.join(' ')).toContain('text fills');
    expect(style.warnings.join(' ')).toContain('line-height');
  });

  it('retains unsupported fills, strokes and effects without fabricating CSS or shadow tokens', () => {
    const stops = [{ position: 0, color: { r: 1, g: 0, b: 0 } }, { position: 1, color: { r: 0, g: 0, b: 1 } }];
    const fill = { type: 'gradient', gradient: { type: 'diamond', stops, customHandle: [1, 2] } };
    const stroke = { w: 2, fill: { type: 'gradient', gradient: { type: 'linear', angle: 90, stops } }, dashOffset: 3 };
    const effect = { type: 'backgroundBlur', radius: 8, intensity: 0.5 };
    const doc = new DesignDocument({ pages: [{ id: 'unsupported', rect: { w: 375, h: 100 }, fills: [fill], strokes: [stroke], effects: [effect] }] });
    const entry = doc.select('unsupported'), style = doc.style(entry);
    expect(style.fillDetails[0]).toMatchObject({ css: null, source: fill });
    expect(style.borders[0]).toMatchObject({ css: null, source: stroke });
    expect(style.effects[0]).toMatchObject({ css: null, source: effect });
    expect(style.css).not.toHaveProperty('background');
    expect(style.css).not.toHaveProperty('border');
    expect(style.css).not.toHaveProperty('boxShadow');
    expect(doc.tokens([entry]).shadows).toEqual([]);
    expect(style.warnings.join(' ')).toMatch(/Unsupported fill/);
    expect(style.warnings.join(' ')).toMatch(/Unsupported strokes/);
    expect(style.warnings.join(' ')).toMatch(/Non-shadow effects/);
  });

  it('preserves explicit transforms consistently across metadata and styles', () => {
    const doc = new DesignDocument({ pages: [{ id: 'f', type: 'artboard', rect: { w: 375, h: 100 }, children: [{ id: 'n', rect: { x: 90, y: 90, w: 10, h: 20 }, relativeTransform: [[0, -1, 5], [1, 0, 6]] }] }] });
    const entry = doc.select('n'), style = doc.style(entry, { cssUnit: 'rpx' });
    expect(style.css).toMatchObject({ left: '10rpx', top: '12rpx', transform: 'matrix(0, 1, -1, 0, 0, 0)', transformOrigin: '0 0' });
    expect(doc.tree({ nodeId: 'n' }, false).tree[0]).toMatchObject({ relativeX: 5, relativeY: 6 });
    expect(style.geometry.sourceTransform).toEqual([[0, -1, 5], [1, 0, 6]]);
    expect(style.warnings.join(' ')).toContain('transformed bounds');
  });

  it('respects explicit parent-local overflow instead of guessing from containment', () => {
    const doc = new DesignDocument({ pages: [{ id: 'f', type: 'artboard', rect: { w: 375 }, children: [{ id: 'g', rect: { x: 20, y: 30, w: 100, h: 100 }, children: [{ id: 'c', coordinateSpace: 'parent', rect: { x: -5, y: 10, w: 20, h: 20 } }] }] }] });
    expect(doc.style(doc.select('c')).layout.relativeX).toBe(-5);
  });
});

describe('indexing, projection and pagination', () => {
  it('reuses documents and styles while keeping units/projections independent', () => {
    const doc = getDocument(genome), entry = doc.select('1:6');
    expect(getDocument(genome)).toBe(doc);
    expect(doc.style(entry)).toBe(doc.style(entry));
    expect(doc.style(entry)).not.toBe(doc.style(entry, { cssUnit: 'rpx' }));
    expect(Object.keys(doc.projectStyle(entry, { fields: ['css'] }))).toEqual(['css']);
    expect(doc.projectStyle(entry, { format: 'compact' })).not.toHaveProperty('fillDetails');
    const textEntry = doc.select('1:2');
    expect(doc.projectStyle(textEntry, { maxTextLength: 2 })).toMatchObject({ typography: { text: 'He' }, textTruncated: true });
    expect(doc.style(textEntry).typography.text).toBe('Hello 月维');
  });

  it('paginates all visible nodes without duplicates and detects wrong-scope or stale cursors', () => {
    const doc = new DesignDocument(genome);
    let cursor: string | undefined, ids: string[] = [];
    do {
      const page = doc.tree({ nodeId: '1:1', maxNodes: 2, cursor });
      ids.push(...page.selected.map(entry => entry.node.id!)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(['1:1', '1:2', '1:3', '1:6']);
    const next = doc.tree({ nodeId: '1:1', maxNodes: 1 }).nextCursor!;
    expect(() => doc.tree({ nodeId: '2:1', cursor: next })).toThrow('does not match');
    expect(() => new DesignDocument({ ...genome, version: 'updated' }).tree({ nodeId: '1:1', cursor: next })).toThrow('Design changed');
  });

  it('bounds wide continuation lists and provides paginated direct-child search', () => {
    const doc = new DesignDocument({ pages: [{ id: 'root', children: Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, name: `Child ${i}` })) }] });
    const page = doc.tree({ nodeId: 'root', maxDepth: 0 });
    expect(page.continuationNodeIds).toHaveLength(50);
    expect(page.continuationCount).toBe(300);
    const children = doc.search({ parentId: 'root', limit: 200 });
    expect(children.nodes).toHaveLength(200);
    expect(doc.search({ parentId: 'root', cursor: children.nextCursor! }).nodes).toHaveLength(100);
  });

  it('searches names/text/types case-insensitively and excludes hidden descendants', () => {
    const doc = new DesignDocument(genome);
    expect(doc.search({ query: '月维', types: ['TEXT'] }).nodes.map(node => node.id)).toEqual(['1:2']);
    expect(doc.search({ query: 'photo', nodeId: '1:1' }).nodes.map(node => node.id)).toEqual(['1:3']);
    expect(doc.search({ query: 'hidden' }).total).toBe(0);
    expect(doc.search({ query: 'hidden', includeHidden: true }).total).toBe(2);
  });
});

describe('layout semantics', () => {
  it('uses provided layout before inference and labels geometry-derived row/grid suggestions', () => {
    const supplied = new DesignDocument({ pages: [{ id: 'f', rect: { w: 375 }, layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingLeft: 12 }] });
    expect(supplied.style(supplied.select('f'), { cssUnit: 'rpx' }).layoutHints).toMatchObject({ source: 'provided', confidence: 'high', css: { display: 'flex', gap: '16rpx', paddingLeft: '24rpx' } });
    for (const [count, strategy] of [[2, 'flex-row'], [4, 'grid']] as const) {
      const doc = new DesignDocument({ pages: [{ id: 'f', rect: { w: 375 }, children: Array.from({ length: count }, (_, i) => ({ id: String(i), rect: { x: (i % 2) * 30, y: Math.floor(i / 2) * 30, w: 20, h: 20 } })) }] });
      expect(doc.style(doc.select('f')).layoutHints).toMatchObject({ source: 'inferred', confidence: 'medium', strategy });
      expect(doc.style(doc.select('f')).css.position).toBe('absolute');
    }
  });
  it('avoids layout claims for overlapping siblings', () => {
    const doc = new DesignDocument({ pages: [{ id: 'f', children: [{ id: 'a', rect: { w: 20, h: 20 } }, { id: 'b', rect: { x: 5, y: 5, w: 20, h: 20 } }] }] });
    expect(doc.style(doc.select('f')).layoutHints).toBeNull();
  });

  it('infers from normalized coordinates and returns visual node order for code generation', () => {
    const doc = new DesignDocument({ pages: [{ id: 'f', type: 'artboard', rect: { w: 375 }, children: [{
      id: 'g', rect: { x: 20, y: 30, w: 100, h: 100 }, children: [
        { id: 'right', coordinateSpace: 'parent', rect: { x: 30, y: 0, w: 20, h: 20 } },
        { id: 'left', coordinateSpace: 'canvas', rect: { x: 20, y: 30, w: 20, h: 20 } },
      ],
    }] }] });
    expect(doc.style(doc.select('g')).layoutHints).toMatchObject({ strategy: 'flex-row', source: 'inferred', nodeOrder: ['left', 'right'], css: { gap: '10px' } });
  });
});
