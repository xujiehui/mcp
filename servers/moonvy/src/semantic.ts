import type { DesignDocument, Entry } from './genome.js';

// Hints never replace source geometry. Unsupported/ambiguous layouts remain unknown.
export function layoutHints(doc: DesignDocument, entry: Entry, units: { scale: number; cssUnit: string }) {
  const node = entry.node;
  const length = (value: number) => `${Math.round(value * units.scale * 10000) / 10000}${units.cssUnit}`;
  const mode = String(node.layoutMode ?? '').toUpperCase();
  if (['HORIZONTAL', 'VERTICAL'].includes(mode)) {
    const css: Record<string, string> = { display: 'flex', flexDirection: mode === 'HORIZONTAL' ? 'row' : 'column' };
    if (Number.isFinite(node.itemSpacing) && node.itemSpacing >= 0) css.gap = length(node.itemSpacing);
    for (const key of ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']) if (Number.isFinite(node[key]) && node[key] >= 0) css[key] = length(node[key]);
    const alignment: Record<string, string> = { MIN: 'flex-start', MAX: 'flex-end', CENTER: 'center', SPACE_BETWEEN: 'space-between', BASELINE: 'baseline' };
    if (alignment[node.primaryAxisAlignItems] && node.primaryAxisAlignItems !== 'BASELINE') css.justifyContent = alignment[node.primaryAxisAlignItems];
    if (alignment[node.counterAxisAlignItems] && node.counterAxisAlignItems !== 'SPACE_BETWEEN') css.alignItems = alignment[node.counterAxisAlignItems];
    return { source: 'provided', confidence: 'high', strategy: `flex-${css.flexDirection}`, css };
  }
  const children = doc.children(entry).filter(child => !child.hidden);
  if (children.length < 2 || children.length > 1000 || children.some(({ node }) => node.rotation || node.relativeTransform || node.transform)) return null;
  const rects = children.map(child => {
    const rect = doc.layout(child);
    return { id: String(child.node.id ?? child.node.nodeId), x: rect.relativeX, y: rect.relativeY, width: rect.width, height: rect.height };
  });
  if (rects.some(rect => ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0)) return null;
  const uniform = (values: number[]) => values.length > 0 && Math.max(...values) - Math.min(...values) <= 1;
  const axes: Array<{ strategy: string; gap: number; nodeOrder: string[]; css: Record<string, string> }> = [];
  for (const horizontal of [true, false]) {
    const axis = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height';
    const cross = horizontal ? 'y' : 'x', crossSize = horizontal ? 'height' : 'width';
    const sorted = [...rects].sort((a, b) => a[axis] - b[axis]);
    const gaps = sorted.slice(1).map((rect, i) => rect[axis] - sorted[i][axis] - sorted[i][size]);
    if (gaps.every(gap => gap >= 0) && uniform(gaps) && uniform(sorted.map(rect => rect[cross] + rect[crossSize] / 2))) {
      const gap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      axes.push({ strategy: horizontal ? 'flex-row' : 'flex-column', gap, nodeOrder: sorted.map(rect => rect.id), css: { display: 'flex', flexDirection: horizontal ? 'row' : 'column', alignItems: 'center', gap: length(gap) } });
    }
  }
  if (axes.length === 1) return { source: 'inferred', confidence: 'medium', ...axes[0], evidence: 'Visible untransformed siblings have aligned centers and uniform non-negative gaps.' };
  const rows: typeof rects[] = [];
  for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find(row => Math.abs(row[0].y - rect.y) <= 1);
    if (row) row.push(rect); else rows.push([rect]);
  }
  if (rows.length > 1 && rows[0].length > 1 && rows.every(row => row.length === rows[0].length)) {
    rows.forEach(row => row.sort((a, b) => a.x - b.x));
    const horizontalGaps = rows.flatMap(row => row.slice(1).map((rect, i) => rect.x - row[i].x - row[i].width));
    const verticalGaps = rows.slice(1).map((row, i) => row[0].y - Math.max(...rows[i].map(rect => rect.y + rect.height)));
    if (uniform(rects.map(rect => rect.width)) && uniform(rects.map(rect => rect.height)) && uniform(horizontalGaps) && uniform(verticalGaps) && [...horizontalGaps, ...verticalGaps].every(gap => gap >= 0) && rows.every(row => row.every((rect, i) => Math.abs(rect.x - rows[0][i].x) <= 1))) {
      return { source: 'inferred', confidence: 'medium', strategy: 'grid', nodeOrder: rows.flatMap(row => row.map(rect => rect.id)), evidence: 'Equal-size visible siblings form aligned rows and columns with uniform gaps.', css: { display: 'grid', gridTemplateColumns: `repeat(${rows[0].length}, ${length(rects[0].width)})`, columnGap: length(horizontalGaps[0]), rowGap: length(verticalGaps[0]) } };
    }
  }
  return null;
}
