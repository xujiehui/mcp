import type { GenomeNode } from './types.js';

export function applyComplexStyle(node: GenomeNode, style: Record<string, any>, warnings: string[]) {
  const length = (v: number) => `${Math.round(v * style.units.scale * 10000) / 10000}${style.units.cssUnit}`;
  const t = node.transform;
  if (!node.relativeTransform && t && typeof t === 'object') {
    const transforms: string[] = [];
    const pair = (v: unknown): v is number[] => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
    if (pair(t.translate)) transforms.push(`translate(${t.translate.map(length).join(', ')})`);
    if (Number.isFinite(t.rotate) && t.rotate !== 0) transforms.push(`rotate(${t.rotate}deg)`);
    if (pair(t.scale)) transforms.push(`scale(${t.scale.join(', ')})`);
    if (pair(t.skew)) transforms.push(`skew(${t.skew.map((v: number) => `${v}deg`).join(', ')})`);
    if (transforms.length) {
      style.css.transform = transforms.join(' ');
      warnings.push('Native transforms use source local geometry. Verify transformed bounds and origin against the rendered design.');
    }
    if (Array.isArray(t.origin) && t.origin.length >= 2 && t.origin.slice(0, 2).every(Number.isFinite)) {
      const [x, y, unit = 'px'] = t.origin;
      if (unit === 'px') style.css.transformOrigin = `${length(x)} ${length(y)}`;
      else if (unit === '%') style.css.transformOrigin = `${x}% ${y}%`;
      else warnings.push('Unsupported transform origin unit is retained in geometry.');
    }
    const unknown = Object.keys(t).filter(key => !['translate', 'rotate', 'scale', 'skew', 'origin'].includes(key));
    if (unknown.length) warnings.push(`Unsupported transform fields retained: ${unknown.join(', ')}.`);
  }
  // Per-edge solid inside strokes are representable without flattening mixed widths.
  if (style.borders.length === 1) {
    const border = style.borders[0], widths = border.source.sideWidths;
    if (widths && border.position === 'inside' && /^(#|rgba?\()/.test(border.color ?? '')) {
      delete style.css.border;
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const value = widths[side] ?? 0;
        if (Number.isFinite(value) && value >= 0) style.css[`border${side[0].toUpperCase()}${side.slice(1)}`] = `${length(value)} ${border.style} ${border.color}`;
      }
      style.css.boxSizing = 'border-box';
    }
  }
  for (const [type, cssKey] of [['filterBlur', 'filter'], ['filterBackdropBlur', 'backdropFilter']]) {
    const values = style.effects.filter((e: any) => e.type === type && Number.isFinite(e.source.blur) && e.source.blur >= 0);
    if (values.length) style.css[cssKey] = values.map((e: any) => `blur(${length(e.source.blur)})`).join(' ');
  }
  const mask = node.blend?.isMask === true || node.isMask === true;
  style.compositing = { isMask: mask, maskType: node.maskType ?? null, blend: node.blend ?? null, borderRadiusSmoothing: node.borderRadiusSmoothing ?? null };
  if (mask) warnings.push('This node masks sibling content. CSS geometry alone cannot reproduce the mask; use existing exported assets or implement a verified SVG/CSS mask.');
  if (node.blend?.mode && !['normal', 'passThrough', 'pass-through'].includes(node.blend.mode)) warnings.push('Source blend mode is retained; composite appearance requires verification.');
  if (node.borderRadiusSmoothing) warnings.push('Corner smoothing is retained; CSS border-radius does not reproduce smoothed corners exactly.');
}
