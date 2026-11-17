import type { Genome, GenomeNode } from './types.js';

export function imageFills(genome: Genome, node: GenomeNode) {
  const fills = node.fills?.length ? node.fills : (genome.styles?.fillStyles ?? []).find((s: any) => s.id === node.fillLink)?.data ?? [];
  return (Array.isArray(fills) ? fills : []).flatMap((fill: any, fillIndex: number) => {
    if (!fill || fill.visible === false || !(fill.type === 'image' || fill.imageHash)) return [];
    const imageHash = fill.imageHash ?? fill.hash ?? fill.id;
    return [{ referenceId: `${String(node.id ?? node.nodeId)}:image-fill:${fillIndex}`, fillIndex, imageHash: typeof imageHash === 'string' ? imageHash : null,
      source: node.fills?.length ? 'node' : 'shared-fill-style', fillLink: node.fillLink ?? null,
      mode: fill.scaleMode ?? fill.imageScaleMode ?? fill.image?.mode ?? null, opacity: fill.opacity ?? 1,
      crop: fill.crop ?? null, tile: fill.tile ?? null, transform: fill.imageTransform ?? fill.transform ?? null, raw: fill }];
  });
}
