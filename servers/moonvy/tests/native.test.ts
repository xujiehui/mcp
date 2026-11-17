import { describe, expect, it } from 'vitest';
import { DesignDocument } from '../src/genome.js';
import { variableDefs } from '../src/variables.js';
import { componentSemantics } from '../src/components.js';

describe('native Moonvy auto-layout', () => {
  it('preserves geometry while offering Hug/Fill/wrap and scaled padding/gaps', () => {
    const doc = new DesignDocument({ genomeVer: 1.9, pages: [{ id: 'f', rect: { w: 375, h: 100 }, autoLayout: {
      isAutoLayoutContainer: true, direction: 'HORIZONTAL', mainAxisSize: 'FIXED', crossAxisSize: 'AUTO', mainAxisGap: 12, crossAxisGap: 8, padding: [1, 2, 3, 4], wrap: 'WRAP', mainAxisAlignItems: 'SPACE_BETWEEN', crossAxisAlignItems: 'STRETCH',
    }, children: [{ id: 'c', rect: { x: 10, y: 20, w: 80, h: 40 }, autoLayout: { position: 'AUTO', grow: 1 } }, { id: 'a', rect: { x: 30, y: 0, w: 10, h: 10 }, autoLayout: { position: 'ABSOLUTE', grow: 1 } }] }] });
    const frame = doc.style(doc.select('f'), { cssUnit: 'rpx' });
    expect(frame.css).toMatchObject({ width: '750rpx', height: '200rpx' });
    expect(frame.responsiveCss).toMatchObject({ display: 'inline-flex', height: 'fit-content', rowGap: '16rpx', columnGap: '24rpx', padding: '2rpx 4rpx 6rpx 8rpx', flexWrap: 'wrap', justifyContent: 'space-between' });
    const child = doc.style(doc.select('c'), { cssLayout: 'auto' });
    expect(child.css).toMatchObject({ position: 'relative', flexGrow: '1', flexBasis: '0' });
    expect(child.css).not.toHaveProperty('left'); expect(child.css).not.toHaveProperty('width'); expect(child.css).not.toHaveProperty('height');
    expect(child.geometryCss).toMatchObject({ width: '80px', left: '10px', top: '20px' });
    expect(child.layout.width).toBe(80);
    expect(doc.style(doc.select('a'), { cssLayout: 'auto' }).css.position).toBe('absolute');
    expect(doc.style(doc.select('c')).css.position).toBe('absolute');
  });
  it('adapts old padding order and avoids pretending unsupported/negative layouts are flex', () => {
    const doc = new DesignDocument({ genomeVer: 1.4, pages: [{ id: 'f', rect: { w: 375 }, autoLayout: { isAutoLayoutContainer: true, direction: 'GRID', padding: [4, 1, 2, 3], mainAxisGap: -5 } }] });
    const style = doc.style(doc.select('f'), { cssLayout: 'auto' });
    expect(style.nativeLayout).toMatchObject({ supported: false, css: { padding: '1px 2px 3px 4px' } });
    expect(style.css).not.toHaveProperty('display');
  });
  it('converts native rotation, per-edge strokes and blur, retaining mask limitations', () => {
    const doc = new DesignDocument({ pages: [{ id: 'f', rect: { w: 375 }, transform: { translate: [1, 2], rotate: 90, scale: [1, -1], origin: [50, 50, '%'] }, blend: { isMask: true },
      strokes: [{ w: 'figma.mixed', align: 'inside', sideWidths: { bottom: 1 }, fills: [{ type: 'color', color: { r: 1, g: 0, b: 0 } }] }],
      effects: [{ type: 'filterBlur', blur: 4 }, { type: 'filterBackdropBlur', blur: 8 }] }] });
    const style = doc.style(doc.select('f'), { cssUnit: 'rpx' });
    expect(style.css).toMatchObject({ transform: 'translate(2rpx, 4rpx) rotate(90deg) scale(1, -1)', transformOrigin: '50% 50%', borderBottom: '2rpx solid #ff0000', filter: 'blur(8rpx)', backdropFilter: 'blur(16rpx)' });
    expect(style.compositing.isMask).toBe(true); expect(style.warnings.join(' ')).toContain('masks sibling');
  });
});

describe('native variables and components', () => {
  const source = { pages: [{ id: 'f', _resolvedVariableModes: { c: 'dark' }, children: [{ id: 'n', varBind: { fills: { variableId: 'alias' }, opacity: { variableId: 'number' }, missing: { variableId: 'gone' }, cycle: { variableId: 'loop' } } }] }], variables: {
    collections: { c: { id: 'c', name: 'Theme', defaultModeId: 'light', modes: { light: { name: 'Light' }, dark: { name: 'Dark' } } } },
    all: { color: { name: 'Color', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { light: { r: 255, g: 255, b: 255 }, dark: { r: 0, g: 0, b: 0 } } },
      alias: { name: 'Alias', collectionId: 'c', resolvedType: 'COLOR', valuesByMode: { light: { id: 'color' }, dark: { id: 'color' } } }, number: { collectionId: 'c', resolvedType: 'FLOAT', valuesByMode: { light: 0.5, dark: 0.8 } },
      loop: { collectionId: 'c', valuesByMode: { light: { id: 'loop2' }, dark: { id: 'loop2' } } }, loop2: { collectionId: 'c', valuesByMode: { light: { id: 'loop' }, dark: { id: 'loop' } } },
      unused: { collectionId: 'c', valuesByMode: { light: 9 } } },
  } };
  it('scopes definitions, includes alias dependencies and inherits selected themes', () => {
    const doc = new DesignDocument(source), result = variableDefs(source, [doc.select('n')]);
    expect(result.definitions.map(v => v.id)).toEqual(['alias', 'color', 'gone', 'loop', 'loop2', 'number']);
    expect(result.bindings.find(b => b.variableId === 'alias')!.resolution).toMatchObject({ status: 'resolved', modeId: 'dark', value: { r: 0, g: 0, b: 0 } });
    expect(result.bindings.find(b => b.variableId === 'gone')!.resolution.status).toBe('missing-variable');
    expect(result.bindings.find(b => b.variableId === 'loop')!.resolution.status).toBe('cycle');
    const override = variableDefs(source, [doc.select('n')], { modes: { c: 'light' } });
    expect(override.bindings[0].resolution.value).toEqual({ r: 255, g: 255, b: 255 });
  });
  it('exports theme CSS and lossless JSON while leaving unitless numbers unitless', () => {
    const doc = new DesignDocument(source), entries = [doc.select('n')];
    const css = variableDefs(source, entries, { exportFormat: 'css' }) as any;
    expect(css.export.text).toMatch(/:root \{/); expect(css.export.text).toContain('var(--mv-');
    expect(css.export.text).toContain('#ffffff'); expect(css.export.text).toContain('#000000'); expect(css.export.text).toContain(': 0.8;');
    expect(css.export.text).not.toContain('0.8px');
    const json = variableDefs(source, entries, { includeUnbound: true, exportFormat: 'json' }) as any;
    expect(JSON.parse(json.export.text).definitions.some((v: any) => v.id === 'unused')).toBe(true);
  });
  it('reports native masters, sets and supplied variants with existing mappings', () => {
    const g = { common: { key: { id: 'master', key: 'key', name: 'State=On', varsProps: { State: 'On' }, componentSetId: 'set' }, set: { id: 'set-node', name: 'Button' } } };
    const data = componentSemantics(g, { id: 'instance', type: 'instance', masterId: 'key', varsProps: { State: 'On' }, overrides: [{ path: 'text', value: 'ok' }] }, [{ nodeId: 'master', componentName: 'Button', importPath: '@/Button' }]);
    expect(data).toMatchObject({ masterStatus: 'metadata-available', componentSet: { name: 'Button' }, variantProperties: { State: 'On' }, mapping: { componentName: 'Button' }, overrides: [{ path: 'text', value: 'ok' }] });
    expect(componentSemantics({}, { id: 'n', masterId: 'unavailable' }, [])!.masterStatus).toBe('unavailable');
  });
});
