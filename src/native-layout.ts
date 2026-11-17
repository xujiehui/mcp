import type { Entry } from './genome.js';
import type { Genome } from './types.js';

/** Moonvy Genome adapter. Geometry stays in source px; this is an explicit CSS alternative. */
export function nativeLayout(genome: Genome, entry: Entry, units: { scale: number; cssUnit: string }) {
  const source = entry.node.autoLayout;
  if (!source || typeof source !== 'object') return null;
  const parent = entry.parent?.node.autoLayout;
  const css: Record<string, string> = {}, warnings: string[] = [];
  const length = (v: number) => `${Math.round(v * units.scale * 10000) / 10000}${units.cssUnit}`;
  const align: Record<string, string> = { MIN: 'flex-start', MAX: 'flex-end', CENTER: 'center', SPACE_BETWEEN: 'space-between', SPACE_AROUND: 'space-around', STRETCH: 'stretch', BASELINE: 'baseline' };
  const container = source.isAutoLayoutContainer === true;
  const flowChild = parent?.isAutoLayoutContainer === true && source.position === 'AUTO';
  const horizontal = source.direction === 'HORIZONTAL';
  const supported = !container || ['HORIZONTAL', 'VERTICAL'].includes(source.direction);
  if (container && supported) {
    css.display = source.mainAxisSize === 'AUTO' || source.crossAxisSize === 'AUTO' ? 'inline-flex' : 'flex';
    css.flexDirection = horizontal ? 'row' : 'column';
    if (align[source.mainAxisAlignItems]) css.justifyContent = align[source.mainAxisAlignItems];
    if (align[source.crossAxisAlignItems]) css.alignItems = align[source.crossAxisAlignItems];
    if (align[source.crossAxisAlignContent]) css.alignContent = align[source.crossAxisAlignContent];
    if (source.wrap === 'WRAP') css.flexWrap = 'wrap';
    // Gaps follow CSS row/column axes; percentages and alignment are not lengths.
    const main = source.mainAxisGap, cross = source.crossAxisGap;
    if (Number.isFinite(main) && main >= 0) css[horizontal ? 'columnGap' : 'rowGap'] = length(main);
    if (Number.isFinite(cross) && cross >= 0) css[horizontal ? 'rowGap' : 'columnGap'] = length(cross);
    if (main < 0 || cross < 0) warnings.push('Negative native gaps overlap layers; CSS gap cannot reproduce them.');
    if (source.mainAxisSize === 'AUTO') css[horizontal ? 'width' : 'height'] = 'fit-content';
    if (source.crossAxisSize === 'AUTO') css[horizontal ? 'height' : 'width'] = 'fit-content';
    if (source.mainAxisSize === 'FIXED' || source.crossAxisSize === 'FIXED') css.flexShrink = '0';
  } else if (container) warnings.push(`Native layout direction ${String(source.direction)} is retained; this adapter currently supports horizontal/vertical flex.`);
  if (source.isBorderBox === true) css.boxSizing = 'border-box';
  let padding = source.padding;
  // The Moonvy frontend corrects pre-1.5 padding from LTRB to TRBL.
  if (Array.isArray(padding) && padding.length === 4) {
    if (Number(genome.genomeVer) < 1.5 && !genome._isFixed) padding = [padding[1], padding[2], padding[3], padding[0]];
    if (padding.every((v: number) => Number.isFinite(v) && v >= 0)) css.padding = padding.map(length).join(' ');
    else warnings.push('Invalid native padding retained without CSS conversion.');
  } else if (Number.isFinite(padding) && padding >= 0) css.padding = length(padding);
  if (flowChild) {
    css.position = 'relative';
    css.flexShrink ??= '0';
    if (Number.isFinite(source.grow) && source.grow > 0) {
      css.flexGrow = String(source.grow);
      css.flexBasis = '0';
      css[parent.direction === 'VERTICAL' ? 'minHeight' : 'minWidth'] = '0';
    }
    if (source.alignSelf && align[source.alignSelf]) css.alignSelf = align[source.alignSelf];
  }
  const sizing = (axis: 'main' | 'cross') => {
    const size = source[`${axis}AxisSize`];
    return size === 'AUTO' ? 'hug' : size === 'FIXED' ? 'fixed' : size ?? 'unspecified';
  };
  return { source: 'moonvy-autoLayout', container, supported, flowChild, sizing: { main: sizing('main'), cross: sizing('cross'),
    fillsParentMainAxis: flowChild && source.grow > 0, fillsParentCrossAxis: flowChild && (source.alignSelf === 'STRETCH' || parent.crossAxisAlignItems === 'STRETCH') },
    paddingOrder: 'top-right-bottom-left', css, raw: source, warnings };
}
