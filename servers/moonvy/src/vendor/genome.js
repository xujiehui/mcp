// Adapted from Cc-Zzh1/moonvy-ui-mcp @ 0021b2b1 (MIT); see THIRD_PARTY_NOTICES.md.
const DEFAULT_MAX_NODES = 2_000;
const DEFAULT_RPX_BASE_WIDTH = 750;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tidyNumber(value, precision = 4) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const factor = 10 ** precision;
  return Math.round(number * factor) / factor;
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))]
    .sort((a, b) => a - b);
}

function uniqueSortedStrings(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function getRect(node) {
  const rect = node?.rect ?? node?.frame ?? {};
  return {
    x: tidyNumber(rect.x) ?? 0,
    y: tidyNumber(rect.y) ?? 0,
    width: tidyNumber(rect.w ?? rect.width) ?? 0,
    height: tidyNumber(rect.h ?? rect.height) ?? 0,
  };
}

function containsNode(root, target) {
  if (!root || !target) return false;
  if (root === target || String(root.id ?? '') === String(target.id ?? '')) return true;
  return (root.children ?? []).some((child) => containsNode(child, target));
}

function containingPage(genome, node) {
  const pages = getGenomePages(genome);
  if (!node) return pages[0] ?? null;
  return pages.find((page) => containsNode(page, node)) ?? pages[0] ?? null;
}

export function inferDesignUnits(genome, node = null, options = {}) {
  const configuredUnit = String(options.cssUnit ?? 'px').trim().toLowerCase();
  const page = options.artboardWidth == null ? containingPage(genome, node) : null;
  const frameWidth = options.artboardWidth ?? getRect(page).width;
  const configuredBase = finiteNumber(options.rpxBaseWidth ?? 750);
  const rpxBaseWidth = configuredBase && configuredBase > 0 ? configuredBase : DEFAULT_RPX_BASE_WIDTH;
  const cssUnit = configuredUnit === 'px'
    ? 'px'
    : configuredUnit === 'rpx' || (configuredUnit === 'auto' && frameWidth > 0 && frameWidth <= rpxBaseWidth)
      ? 'rpx'
      : 'px';
  const configuredScale = null;
  const scale = cssUnit === 'rpx'
    ? configuredScale && configuredScale > 0
      ? configuredScale
      : frameWidth > 0
        ? rpxBaseWidth / frameWidth
        : 2
    : 1;
  return {
    sourceUnit: 'px',
    cssUnit,
    scale,
    relation: `1px = ${tidyNumber(scale)}${cssUnit}`,
    strategy: configuredUnit === 'auto' ? 'auto-from-artboard-width' : 'configured',
    artboardWidth: frameWidth || null,
    rpxBaseWidth: cssUnit === 'rpx' ? rpxBaseWidth : null,
  };
}

function cssNumber(value, units) {
  const number = finiteNumber(value);
  return number === null ? null : tidyNumber(number * (units?.scale ?? 1));
}

function cssLength(value, units) {
  const number = cssNumber(value, units);
  return number === null ? null : `${number}${units?.cssUnit ?? 'px'}`;
}

function rgbaChannels(color = {}) {
  let r = finiteNumber(color.r) ?? 0;
  let g = finiteNumber(color.g) ?? 0;
  let b = finiteNumber(color.b) ?? 0;
  const normalized = r <= 1 && g <= 1 && b <= 1;
  if (normalized) {
    r *= 255;
    g *= 255;
    b *= 255;
  }
  return {
    r: Math.max(0, Math.min(255, Math.round(r))),
    g: Math.max(0, Math.min(255, Math.round(g))),
    b: Math.max(0, Math.min(255, Math.round(b))),
    a: Math.max(0, Math.min(1, finiteNumber(color.a ?? color.alpha) ?? 1)),
  };
}

export function colorToCss(color, opacity = 1) {
  if (!color || typeof color !== 'object') return null;
  const channels = rgbaChannels(color);
  const alpha = Math.max(0, Math.min(1, channels.a * (finiteNumber(opacity) ?? 1)));
  if (alpha < 0.9999) {
    return `rgba(${channels.r}, ${channels.g}, ${channels.b}, ${tidyNumber(alpha)})`;
  }
  return `#${[channels.r, channels.g, channels.b]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function gradientStopToCss(stop, fillOpacity = 1, cssPosition = undefined) {
  const color = colorToCss(stop?.color ?? stop, (finiteNumber(stop?.opacity) ?? 1) * (finiteNumber(fillOpacity) ?? 1));
  const rawPosition = stop?.position ?? stop?.offset;
  const position = cssPosition === undefined
    ? rawPosition == null ? null : finiteNumber(rawPosition)
    : cssPosition;
  return [color, position === null ? null : `${tidyNumber(cssPosition === undefined ? position * (position <= 1 ? 100 : 1) : position, 2)}%`]
    .filter(Boolean)
    .join(' ');
}

function gradientPoint(point) {
  if (point?.x == null || point?.y == null) return null;
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  return x === null || y === null ? null : { x, y };
}

// Moonvy's CSS encoder projects normalized handles onto the CSS gradient line
// of a unit square, not the node's pixel-sized rectangle.
function linearGradientGeometry(gradient) {
  if (gradient.onlyAngle) return null;
  const from = gradientPoint(gradient.from);
  const to = gradientPoint(gradient.to);
  const aspect = gradientPoint(gradient.aspect);
  if (!from || !to || !aspect) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const cross = dx * (aspect.y - from.y) - dy * (aspect.x - from.x);
  if (distance < 1e-10 || Math.abs(cross) < 1e-10) return null;
  let angle = Math.atan2(from.y - aspect.y, from.x - aspect.x) * 180 / Math.PI;
  if (cross > 0) angle -= 180;
  angle = (angle + 360) % 360;
  const radians = angle * Math.PI / 180;
  const direction = { x: Math.sin(radians), y: -Math.cos(radians) };
  const length = Math.abs(direction.x) + Math.abs(direction.y);
  const start = { x: 0.5 - direction.x * length / 2, y: 0.5 - direction.y * length / 2 };
  const offset = ((from.x - start.x) * direction.x + (from.y - start.y) * direction.y) / length;
  return { angle: tidyNumber(angle, 2), offset, scale: distance / length };
}

function fillToCss(fill) {
  if (!fill || fill.visible === false) return null;
  const opacity = fill.opacity ?? 1;
  const gradient = fill.gradient ?? fill;
  const stops = gradient.stops ?? gradient.gradientStops ?? gradient.colors;
  if (Array.isArray(stops) && stops.length > 0) {
    const kind = String(gradient.type ?? fill.gradientType ?? fill.type ?? '').toLowerCase();
    if (kind && kind !== 'gradient' && !kind.includes('linear') && !kind.includes('radial')) return null;
    const prefix = kind.includes('radial') ? 'radial-gradient' : 'linear-gradient';
    const angle = finiteNumber(gradient.angle ?? gradient.degree ?? fill.angle ?? fill.degree);
    const geometry = prefix === 'linear-gradient' ? linearGradientGeometry(gradient) : null;
    const cssAngle = geometry?.angle ?? angle;
    let head = prefix === 'linear-gradient' && cssAngle !== null ? `${tidyNumber(cssAngle, 2)}deg, ` : '';
    if (prefix === 'radial-gradient') {
      const from = gradientPoint(gradient.from);
      const to = gradientPoint(gradient.to);
      const aspect = gradientPoint(gradient.aspect);
      if (from) {
        let size = 'circle';
        if (to && aspect) {
          const points = [from, to, aspect];
          const width = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
          const height = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));
          size = `${tidyNumber(width * 100, 2)}% ${tidyNumber(height * 100, 2)}%`;
        }
        head = `${size} at ${tidyNumber(from.x * 100, 2)}% ${tidyNumber(from.y * 100, 2)}%, `;
      }
    }
    const cssStops = stops.map((stop) => {
      const rawPosition = stop?.position ?? stop?.offset;
      const position = rawPosition == null ? null : finiteNumber(rawPosition);
      // Native Genome stops are ratios, including values outside [0, 1].
      const cssPosition = position === null ? null : geometry
        ? (position * geometry.scale + geometry.offset) * 100
        : fill.gradient ? position * 100 : undefined;
      return gradientStopToCss(stop, opacity, cssPosition);
    });
    return `${prefix}(${head}${cssStops.filter(Boolean).join(', ')})`;
  }

  if (fill.type === 'color' || fill.color) return colorToCss(fill.color ?? fill, opacity);

  if (fill.type === 'image' || fill.imageHash || fill.hash) {
    return `image:${fill.imageHash ?? fill.hash ?? fill.id ?? 'unknown'}`;
  }
  return null;
}

function normalizeFillDetail(fill) {
  const css = fillToCss(fill);
  const gradient = fill?.gradient ?? fill;
  const stops = gradient?.stops ?? gradient?.gradientStops ?? gradient?.colors;
  if (Array.isArray(stops) && stops.length > 0) {
    return {
      type: String(gradient.type ?? fill.type ?? 'gradient'),
      opacity: tidyNumber(fill.opacity ?? 1),
      css,
      gradient: {
        type: String(gradient.type ?? fill.gradientType ?? 'linear'),
        stops: stops.map((stop) => ({
          color: colorToCss(stop?.color ?? stop, (finiteNumber(stop?.opacity) ?? 1) * (finiteNumber(fill.opacity) ?? 1)),
          position: tidyNumber(stop?.position ?? stop?.offset),
        })),
        from: gradient.from ?? null,
        to: gradient.to ?? null,
        aspect: gradient.aspect ?? null,
        angle: tidyNumber(gradient.angle ?? gradient.degree),
        onlyAngle: gradient.onlyAngle ?? null,
      },
    };
  }
  if (fill?.type === 'image' || fill?.imageHash || fill?.hash) {
    return { type: 'image', opacity: tidyNumber(fill.opacity ?? 1), css, imageHash: fill.imageHash ?? fill.hash ?? fill.id ?? null };
  }
  return { type: String(fill?.type ?? 'color'), opacity: tidyNumber(fill?.opacity ?? 1), css };
}

function resolveLinkedFills(genome, node) {
  if (Array.isArray(node?.fills) && node.fills.length > 0) return node.fills;
  if (!node?.fillLink) return [];
  const linked = (genome?.styles?.fillStyles ?? []).find((style) => style.id === node.fillLink);
  return linked?.data ?? linked?.fills ?? [];
}

function normalizeRadius(radius) {
  if (Array.isArray(radius)) return radius.map((value) => tidyNumber(value));
  if (radius && typeof radius === 'object') {
    const values = [radius.topLeft, radius.topRight, radius.bottomRight, radius.bottomLeft]
      .map((value) => tidyNumber(value));
    return values.some((value) => value !== null) ? values : null;
  }
  return tidyNumber(radius);
}

function normalizeLineHeight(raw) {
  const rawUnit = typeof raw === 'object' && raw !== null ? raw.unit : null;
  const value = typeof raw === 'object' && raw !== null ? raw.value : raw;
  if (value === 'auto' || value === 'normal' || rawUnit === 'auto') return { value: null, unit: 'auto' };
  if (value == null || value === '') return { value: null, unit: null };
  const number = tidyNumber(value);
  if (number === null) return { value: null, unit: null };
  const unit = String(rawUnit ?? 'px').toLowerCase();
  return {
    value: number,
    unit: ['per', 'percent', 'percentage', '%'].includes(unit) ? '%'
      : ['pixel', 'pixels', 'px'].includes(unit) ? 'px' : unit,
  };
}

function lineHeightToCss(text, units) {
  if (text.lineHeightUnit === 'auto') return 'normal';
  if (text.lineHeight == null) return undefined;
  if (text.lineHeightUnit === '%') return `${text.lineHeight}%`;
  if (text.lineHeightUnit === 'number') return String(text.lineHeight);
  if (text.lineHeightUnit === 'em' || text.lineHeightUnit === 'rem') return `${text.lineHeight}${text.lineHeightUnit}`;
  if (text.lineHeightUnit == null || text.lineHeightUnit === 'px') return cssLength(text.lineHeight, units);
  return undefined;
}

function extractTypography(node, genome, segment = node?.textbox?.segments?.[0] ?? {}) {
  const linkedId = segment.textLink ?? node?.textLink;
  const linked = (genome?.styles?.textStyles ?? []).find((style) => style.id === linkedId);
  const linkedData = linked?.data ?? linked ?? {};
  const source = { ...linkedData, ...segment };
  const fills = source.fills ?? source.fill ? (source.fills ?? [source.fill]) : [];
  const lineHeight = normalizeLineHeight(source.lineHeight);
  const letterSpacing = normalizeLineHeight(source.letterSpacing);
  const text = node?.textbox?.text ?? node?.characters ?? node?.text ?? null;

  if (!text && Object.keys(source).length === 0) return null;
  return {
    text,
    fontFamily: source.fontName?.family ?? source.fontFamily ?? null,
    fontStyle: source.fontName?.style ?? source.fontStyle ?? null,
    fontSize: tidyNumber(source.fontSize),
    fontWeight: source.fontWeight ?? null,
    lineHeight: lineHeight.value,
    lineHeightUnit: lineHeight.unit,
    letterSpacing: letterSpacing.value,
    letterSpacingUnit: letterSpacing.unit,
    underline: source.underline === true || String(source.textDecoration).toLowerCase() === 'underline',
    strikethrough: source.strikethrough === true || ['strikethrough', 'line-through'].includes(String(source.textDecoration).toLowerCase()),
    link: source.hyperlink?.value ?? source.link ?? null,
    textAlign: source.textAlign ?? node?.textbox?.align ?? null,
    color: fills.length > 0 ? fillToCss(fills[0]) : null,
  };
}

function extractBorders(node, units) {
  const strokes = node?.strokes ?? node?.borders ?? [];
  if (!Array.isArray(strokes)) return [];
  return strokes
    .filter((stroke) => stroke?.visible !== false)
    .map((stroke) => {
      const strokeFill = (stroke.fills ?? []).find((fill) => fill?.visible !== false) ?? stroke.fill ?? stroke;
      const width = tidyNumber(stroke.w ?? stroke.width ?? node?.strokeWidth ?? node?.borderWidth);
      const color = fillToCss(strokeFill);
      const style = stroke.style ?? (Array.isArray(stroke.dash) && stroke.dash.length > 0 ? 'dashed' : 'solid');
      const cssWidth = cssNumber(width, units);
      return {
        color,
        width,
        unit: units.sourceUnit,
        cssWidth,
        cssUnit: units.cssUnit,
        position: stroke.align ?? stroke.position ?? node?.strokeAlign ?? null,
        style,
        source: stroke,
        css: cssWidth !== null && /^(#|rgba?\()/.test(color ?? '') && ['solid', 'dashed', 'dotted', 'double', 'none'].includes(style) ? `${cssWidth}${units.cssUnit} ${style} ${color}` : null,
      };
    });
}

function extractEffects(node, units) {
  const effects = node?.effects ?? node?.shadows ?? [];
  if (!Array.isArray(effects)) return [];
  return effects
    .filter((effect) => effect?.visible !== false)
    .map((effect) => {
      const color = colorToCss(effect.color, effect.opacity ?? 1);
      const offsetX = tidyNumber(effect.offset?.x ?? effect.offsetX ?? effect.x) ?? 0;
      const offsetY = tidyNumber(effect.offset?.y ?? effect.offsetY ?? effect.y) ?? 0;
      const blur = tidyNumber(effect.radius ?? effect.blur) ?? 0;
      const spread = tidyNumber(effect.spread) ?? 0;
      return {
        type: effect.type ?? 'shadow',
        inset: String(effect.type ?? '').toLowerCase().replace(/[_-]/g, '').includes('inner') || effect.inset === true,
        color,
        offsetX,
        offsetY,
        blur,
        spread,
        unit: units.sourceUnit,
        cssUnit: units.cssUnit,
        cssScale: units.scale,
        source: effect,
        css: String(effect.type ?? 'shadow').toLowerCase().includes('shadow') ? [offsetX, offsetY, blur, spread]
          .map((value) => cssLength(value, units))
          .concat(color ?? 'rgba(0, 0, 0, 0.2)')
          .concat(String(effect.type ?? '').toLowerCase().replace(/[_-]/g, '').includes('inner') || effect.inset === true ? ['inset'] : [])
          .join(' ') : null,
      };
    });
}

export function relativeMetrics(node, parent) {
  const rect = getRect(node);
  if (!parent) return { ...rect, relativeX: 0, relativeY: 0, coordinateSpace: 'canvas', unit: 'px' };
  const parentRect = getRect(parent);
  const subtractedX = rect.x - parentRect.x;
  const subtractedY = rect.y - parentRect.y;
  const tolerance = 0.01;
  const localFits = rect.x >= -tolerance
    && rect.y >= -tolerance
    && rect.x + rect.width <= parentRect.width + tolerance
    && rect.y + rect.height <= parentRect.height + tolerance;
  const subtractedFits = subtractedX >= -tolerance
    && subtractedY >= -tolerance
    && subtractedX + rect.width <= parentRect.width + tolerance
    && subtractedY + rect.height <= parentRect.height + tolerance;
  const parentStartsLocalSpace = String(parent?.type ?? '').toLowerCase() === 'artboard' || parent?.isFrame === true;
  const useLocalRect = node.coordinateSpace === 'parent' || (node.coordinateSpace !== 'canvas' && (parentStartsLocalSpace || (localFits && !subtractedFits)));
  const relativeX = useLocalRect ? rect.x : subtractedX;
  const relativeY = useLocalRect ? rect.y : subtractedY;
  return {
    ...rect,
    relativeX: tidyNumber(relativeX),
    relativeY: tidyNumber(relativeY),
    right: tidyNumber(parentRect.width - relativeX - rect.width),
    bottom: tidyNumber(parentRect.height - relativeY - rect.height),
    coordinateSpace: useLocalRect ? 'parent' : 'canvas',
    unit: 'px',
  };
}

/** @param {any} genome @param {any} node @param {any} parent @param {any} options */
export function extractNodeStyle(genome, node, parent = null, options = {}) {
  const fills = resolveLinkedFills(genome, node).filter((fill) => fill?.visible !== false);
  const fillValues = fills.map(fillToCss).filter(Boolean);
  const fillDetails = fills.map((fill) => ({ ...normalizeFillDetail(fill), source: fill }));
  const typography = extractTypography(node, genome);
  const opacity = tidyNumber(node?.blend?.opacity ?? node?.opacity ?? 1);
  const units = inferDesignUnits(genome, node, options);
  const style = {
    units,
    layout: relativeMetrics(node, parent),
    fills: fillValues,
    fillDetails,
    background: node?.type === 'text' ? null : (fillValues[0] ?? null),
    opacity,
    borderRadius: normalizeRadius(node?.borderRadius ?? node?.cornerRadius ?? node?.radii),
    borders: extractBorders(node, units),
    effects: extractEffects(node, units),
    typography,
    visible: node?.visible !== false && node?.hidden !== true,
    clipContent: node?.clipContent ?? node?.clipsContent ?? null,
  };
  style.css = styleToCss(style);
  const segments = node?.textbox?.segments;
  if (Array.isArray(segments)) style.textRuns = segments.map((segment) => {
    const typography = extractTypography(node, genome, segment);
    const start = segment.start ?? segment.from ?? segment.range?.start;
    const end = segment.end ?? segment.to ?? segment.range?.end;
    return {
      start: Number.isInteger(start) ? start : null,
      end: Number.isInteger(end) ? end : null,
      rangeKnown: Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start,
      typography,
      css: styleToCss({ typography, units }),
    };
  });
  return style;
}

export function styleToCss(style) {
  const css = {};
  const layout = style?.layout ?? {};
  const units = style?.units ?? { cssUnit: 'px', scale: 1 };
  if (layout.width != null) css.width = cssLength(layout.width, units);
  if (layout.height != null) css.height = cssLength(layout.height, units);
  if (layout.relativeX != null) css.left = cssLength(layout.relativeX, units);
  if (layout.relativeY != null) css.top = cssLength(layout.relativeY, units);
  if (style.layout) css.position = 'absolute';
  if (style?.background && !String(style.background).startsWith('image:')) {
    const fills = style.fills ?? [style.background];
    if (fills.every((fill) => !String(fill).startsWith('image:'))) {
      css.background = fills.map((fill, index) => index < fills.length - 1 && !String(fill).includes('gradient(') ? `linear-gradient(${fill}, ${fill})` : fill).join(', ');
    } else css.background = style.background;
  }
  if (style?.opacity != null && style?.opacity !== 1) css.opacity = String(style.opacity);
  const radius = style?.borderRadius;
  if (Array.isArray(radius)) css.borderRadius = radius.map((value) => cssLength(value ?? 0, units)).join(' ');
  else if (radius !== null && radius !== undefined) css.borderRadius = cssLength(radius, units);
  const border = style?.borders?.[0];
  if (border?.css) {
    css.border = border.css;
    if (border.position === 'inside') css.boxSizing = 'border-box';
  }
  if (style?.effects?.length) {
    css.boxShadow = style.effects
      .filter((effect) => String(effect.type).toLowerCase().includes('shadow'))
      .map((effect) => effect.css)
      .join(', ') || undefined;
  }
  if (style?.borders?.length > 1 && style.borders.every((b) => b.width != null && /^(#|rgba?\()/.test(b.color ?? '') && b.style === 'solid' && ['inside', 'outside', 'center'].includes(b.position))) {
    delete css.border;
    const shadows = style.borders.flatMap((b) => {
      const shadow = (width, inset) => `0${units.cssUnit} 0${units.cssUnit} 0${units.cssUnit} ${cssLength(width, units)} ${b.color}${inset ? ' inset' : ''}`;
      return b.position === 'center' ? [shadow(b.width / 2, true), shadow(b.width / 2, false)] : [shadow(b.width, b.position === 'inside')];
    });
    if (css.boxShadow) shadows.push(css.boxShadow);
    css.boxShadow = shadows.join(', ');
  }
  const text = style?.typography;
  if (text) {
    if (text.color && !String(text.color).includes('gradient(') && !String(text.color).startsWith('image:')) css.color = text.color;
    if (text.fontFamily) css.fontFamily = text.fontFamily;
    if (text.fontSize !== null) css.fontSize = cssLength(text.fontSize, units);
    if (text.fontWeight != null) css.fontWeight = String(text.fontWeight);
    if (/italic|oblique/i.test(text.fontStyle ?? '')) css.fontStyle = /oblique/i.test(text.fontStyle) ? 'oblique' : 'italic';
    css.lineHeight = lineHeightToCss(text, units);
    if (text.letterSpacing != null) {
      if (text.letterSpacingUnit === '%') css.letterSpacing = `${tidyNumber(text.letterSpacing / 100)}em`;
      else if (text.letterSpacingUnit === 'em' || text.letterSpacingUnit === 'rem') css.letterSpacing = `${text.letterSpacing}${text.letterSpacingUnit}`;
      else if (text.letterSpacingUnit == null || text.letterSpacingUnit === 'px') css.letterSpacing = cssLength(text.letterSpacing, units);
    }
    if (text.underline || text.strikethrough) css.textDecorationLine = [text.underline && 'underline', text.strikethrough && 'line-through'].filter(Boolean).join(' ');
    if (text.textAlign) css.textAlign = text.textAlign;
  }
  return Object.fromEntries(Object.entries(css).filter(([, value]) => value !== undefined));
}

export function getGenomePages(genome) {
  if (Array.isArray(genome?.pages)) return genome.pages;
  if (Array.isArray(genome?.document?.children)) return genome.document.children;
  return [];
}
