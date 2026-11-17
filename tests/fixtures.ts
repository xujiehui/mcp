import { gzipSync } from 'node:zlib';
import type { Genome } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { join } from 'node:path';

export const designUrl = 'https://moonvy.com/project/project/folder/design';
export const folderUrl = 'https://moonvy.com/project/project/folder';
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
export const genome: Genome = {
  genomeVer: 1,
  pages: [
    { id: '1:1', type: 'artboard', name: 'Mobile', rect: { x: 100, y: 200, w: 375, h: 812 }, snapshot: 'frame-snapshot', children: [
      { id: '1:2', type: 'text', name: 'Title', rect: { x: 16, y: 20, w: 180, h: 24 }, textLink: 'body', textbox: { text: 'Hello 月维', segments: [{ fontSize: 16, lineHeight: { value: 150, unit: 'per' } }, { fontSize: 20, underline: true }] } },
      { id: '1:3', type: 'rectangle', name: 'Photo', rect: { x: 16, y: 60, w: 200, h: 100 }, fills: [{ type: 'image', imageHash: 'photo' }], slices: { svg: { id: 'photo-svg' }, base: { id: 'photo' } } },
      { id: '1:4', type: 'group', name: 'Hidden', hidden: true, rect: { x: 0, y: 0, w: 100, h: 100 }, children: [
        { id: '1:5', type: 'rectangle', name: 'Hidden child', rect: { x: 0, y: 0, w: 10, h: 10 }, fills: [{ type: 'color', color: { r: 1, g: 0, b: 1 } }] },
      ] },
      { id: '1:6', type: 'rectangle', name: 'Button', rect: { x: 16, y: 200, w: 100, h: 40 }, fillLink: 'brand', borderRadius: 8, strokes: [{ w: 1, align: 'inside', fill: { color: { r: 0, g: 0, b: 0 } } }], effects: [{ type: 'shadow', offset: { x: 0, y: 4 }, radius: 5.8, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.2 } }] },
    ] },
    { id: '2:1', type: 'artboard', name: 'Web', rect: { x: 600, y: 0, w: 1440, h: 900 }, children: [
      { id: '2:2', type: 'text', name: 'Web text', rect: { x: 10, y: 10, w: 100, h: 24 }, textbox: { text: 'Web', segments: [{ fontSize: 14, lineHeight: { value: 24, unit: 'px' } }] } },
    ] },
  ],
  styles: { fillStyles: [{ id: 'brand', name: 'Brand', data: [{ type: 'color', color: { r: 0.2, g: 0.4, b: 1 } }] }], textStyles: [{ id: 'body', name: 'Body', data: { fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14, fontWeight: 400 } }] },
};

export function fixtureConfig(assetDir: string) {
  return { ...loadConfig({}), token: 'local-test-secret', assetDir, componentMapPath: join(assetDir, 'components.json'), snapshotDir: join(assetDir, 'snapshots') };
}

export function fixtureFetcher(readGenome: () => Genome | Promise<Genome> = () => genome): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/anynode/list')) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { items: body.pageIndex === 0 ? [{ id: 'design', name: 'Demo', type: 'design', parentId: 'folder' }] : [], hasMore: false } });
    }
    if (url.endsWith('/anynode/get')) return json({ data: { id: 'design', name: 'Demo', files: { genome: { url: 'https://fs.moonvy.com/genome?signature=hidden' } }, preview: { large: 'https://fs.moonvy.com/preview?signature=hidden' }, meta: { assets: { 'frame-snapshot': 'https://fs.moonvy.com/snapshot?signature=hidden', photo: 'https://fs.moonvy.com/photo', 'photo-svg': 'https://fs.moonvy.com/photo.svg' } } } });
    if (url.includes('/genome')) return new Response(gzipSync(JSON.stringify(await readGenome())));
    if (url.includes('/photo.svg')) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>', { headers: { 'content-type': 'image/svg+xml' } });
    if (/\/(preview|snapshot|photo)(\?|$)/.test(url)) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}
