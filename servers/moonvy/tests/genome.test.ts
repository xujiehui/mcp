import { describe, expect, it } from 'vitest';
import { DesignDocument } from '../src/genome.js';
import { genome } from './fixtures.js';

describe('Genome selection and CSS', () => {
  it('uses exact IDs, accepts unambiguous instance IDs, rejects suffix matches and ambiguity', () => {
    const doc = new DesignDocument({ pages: [{ id: '4:12' }, { id: '4:112' }, { id: 'a;5:1' }, { id: 'b;5:1' }] });
    expect(doc.select('4:12').node.id).toBe('4:12');
    expect(doc.select('instance;4:12').node.id).toBe('4:12');
    expect(() => doc.select('12')).toThrow('not found');
    expect(() => doc.select('5:1')).toThrow('ambiguous');
    expect(doc.select('a;5:1').node.id).toBe('a;5:1');
  });

  it('defaults to px, keeps artboard-local positions and scales all CSS lengths on demand', () => {
    const doc = new DesignDocument(genome), button = doc.select('1:6');
    const px = doc.style(button), rpx = doc.style(button, { cssUnit: 'rpx' });
    expect(px.layout.relativeX).toBe(16);
    expect(px.layout.right).toBe(259);
    expect(px.css.width).toBe('100px');
    expect(px.css.boxSizing).toBe('border-box');
    expect(rpx.css.width).toBe('200rpx');
    expect(rpx.css.borderRadius).toBe('16rpx');
    expect(rpx.css.boxShadow).toContain('0rpx 8rpx 11.6rpx 0rpx');
    expect(rpx.layout.width).toBe(100);
    expect(doc.style(button).css.width).toBe('100px');
  });

  it('normalizes canvas coordinates relative to nested parents', () => {
    const doc = new DesignDocument({ pages: [{ id: 'p', type: 'artboard', rect: { x: 500, y: 100, w: 375, h: 812 }, children: [
      { id: 'g', type: 'group', rect: { x: 20, y: 30, w: 200, h: 100 }, children: [{ id: 'c', rect: { x: 30, y: 50, w: 20, h: 10 } }] },
    ] }] });
    expect(doc.style(doc.select('c')).layout).toMatchObject({ relativeX: 10, relativeY: 20, right: 170, bottom: 70 });
  });

  it('keeps percent/auto line heights, linked typography and rich text segments', () => {
    const doc = new DesignDocument(genome);
    const title = doc.style(doc.select('1:2'), { cssUnit: 'rpx' });
    expect(title.css.lineHeight).toBe('150%');
    expect(title.css.fontFamily).toBe('Inter');
    expect(title.css.fontSize).toBe('32rpx');
    expect(title.richTextSegments).toHaveLength(2);
    expect(title.warnings).toHaveLength(1);
    expect(doc.style(doc.select('2:2')).css.lineHeight).toBe('24px');
    const auto = new DesignDocument({ pages: [{ id: 'a', type: 'text', rect: { w: 375 }, textbox: { text: 'a', segments: [{ lineHeight: { unit: 'auto' } }] } }] });
    expect(auto.style(auto.select('a')).css.lineHeight).toBe('normal');
  });

  it('calculates gradient geometry and does not scale percentages', () => {
    const fill = { type: 'gradient', gradient: { type: 'linear', from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, aspect: { x: 0, y: 1 }, stops: [{ position: 0, color: { r: 1, g: 0, b: 0 } }, { position: 1, color: { r: 0, g: 0, b: 1 } }] } };
    const doc = new DesignDocument({ pages: [{ id: 'a', rect: { w: 375, h: 100 }, fills: [fill] }] });
    expect(doc.style(doc.select('a')).css.background).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)');
    expect(doc.style(doc.select('a'), { cssUnit: 'rpx' }).css.background).toBe(doc.style(doc.select('a')).css.background);
  });

  it('excludes hidden subtrees, limits depth/count and exposes continuation IDs', () => {
    const doc = new DesignDocument(genome);
    const tree = doc.tree({ nodeId: '1:1' });
    expect(tree.selected.map(e => e.node.id)).not.toContain('1:5');
    expect(doc.tree({ nodeId: '1:4' }).nodeCount).toBe(0);
    expect(doc.tree({ nodeId: '1:4', includeHidden: true }).nodeCount).toBe(2);
    expect(doc.tree({ nodeId: '1:1', maxDepth: 0 })).toMatchObject({ nodeCount: 1, truncated: true });
    expect(doc.tree({ nodeId: '1:1', maxNodes: 2 }).continuationNodeIds).toContain('1:3');
    expect(doc.tree({ nodeId: '1:2', maxNodes: 1 }).truncated).toBe(false);
  });

  it('scopes tokens and assets to returned nodes and labels inferred spacing', () => {
    const doc = new DesignDocument(genome);
    const { selected } = doc.tree({ nodeId: '1:6' });
    const tokens = doc.tokens(selected);
    expect(tokens.colors).toEqual(['#000000', '#3366ff']);
    expect(tokens.sharedStyles.fillStyles).toHaveLength(1);
    expect(tokens.sharedStyles.textStyles).toHaveLength(0);
    expect(tokens.spacing.source).toBe('inferred');
    expect(doc.assetRefs(selected)).toEqual([]);
    expect(doc.assetRefs(doc.tree({ nodeId: '1:3' }).selected)[0].types).toEqual(['slice', 'image']);
  });
});
