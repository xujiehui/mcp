import { z } from 'zod';

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const baselineSchema = z.object({
  formatVersion: z.literal(1),
  provenance: z.object({ kind: z.enum(['moonvy-panel', 'synthetic']), observedAt: z.string(), source: z.string(), notes: z.string().optional() }),
  designs: z.array(z.object({
    url: z.string().url(), cssUnit: z.enum(['px', 'rpx']).default('px'),
    samples: z.array(z.object({ nodeId: z.string().min(1), css: z.record(z.string(), z.string()).optional(), values: z.record(z.string(), scalar).optional(),
      canvasPosition: z.tuple([z.number().finite(), z.number().finite()]).optional(), tolerance: z.number().min(0).max(1).default(0.01),
    }).refine(sample => Boolean(Object.keys(sample.css ?? {}).length || Object.keys(sample.values ?? {}).length || sample.canvasPosition), 'Sample must contain independent expected values.')).min(1).max(1000),
  })).min(1).max(100),
});
export type Baseline = z.infer<typeof baselineSchema>;
export type BaselineSample = Baseline['designs'][number]['samples'][number];
export interface Difference { nodeId: string; field: string; expected: unknown; actual: unknown }

export function compareBaselineSample(style: Record<string, any>, sample: BaselineSample, canvasPosition?: [number, number]): Difference[] {
  const differences: Difference[] = [];
  const compare = (field: string, expected: unknown, actual: unknown) => {
    const equal = typeof expected === 'number' && typeof actual === 'number' ? Number.isFinite(actual) && Math.abs(actual - expected) <= sample.tolerance : expected === actual;
    if (!equal) differences.push({ nodeId: sample.nodeId, field, expected, actual: actual ?? null });
  };
  for (const [key, expected] of Object.entries(sample.css ?? {})) compare(`css.${key}`, expected, style.css?.[key]);
  for (const [path, expected] of Object.entries(sample.values ?? {})) {
    let actual: any = style;
    for (const key of path.split('.')) {
      if (!/^[A-Za-z0-9_]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || actual == null || !Object.hasOwn(actual, key)) { actual = undefined; break; }
      actual = actual[key];
    }
    compare(path, expected, actual);
  }
  sample.canvasPosition?.forEach((expected, index) => compare(`canvasPosition.${index}`, expected, canvasPosition?.[index]));
  return differences;
}

type BaselineDesign = Baseline['designs'][number];
export interface BaselineStyle { parentId: string | null; style: Record<string, any> }
export interface BaselineReader {
  prepareDesign?(design: BaselineDesign): Promise<void>;
  readStyle(design: BaselineDesign, nodeId: string): Promise<BaselineStyle>;
}
interface Counts { total: number; attempted: number; verified: number; failed: number; skipped: number }
interface ReadFailure { design: number; nodeId?: string; stage: 'design' | 'sample'; code: string }
interface DesignVerification {
  design: number;
  status: 'verified' | 'partial' | 'read-failed' | 'skipped';
  samples: Counts;
  checks: number;
  failures: number;
}
const newCounts = (total: number): Counts => ({ total, attempted: 0, verified: 0, failed: 0, skipped: 0 });
const sampleCheckCount = (sample: BaselineSample) => Object.keys(sample.css ?? {}).length + Object.keys(sample.values ?? {}).length + (sample.canvasPosition ? 2 : 0);

/** Compare independent expectations, retaining partial coverage when a file or node is inaccessible. */
export async function verifyBaseline(baseline: Baseline, reader: BaselineReader) {
  const designs = newCounts(baseline.designs.length);
  const samples = newCounts(baseline.designs.reduce((sum, design) => sum + design.samples.length, 0));
  const expectedChecks = baseline.designs.reduce((sum, design) => sum + design.samples.reduce((n, sample) => n + sampleCheckCount(sample), 0), 0);
  const differences: (Difference & { design: number })[] = [];
  const readFailures: ReadFailure[] = [];
  const results: DesignVerification[] = [];
  let checks = 0, authenticationFailed = false;
  const recordFailure = (error: unknown, design: number, nodeId?: string) => {
    const raw = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    // Never expose upstream exception messages, credentials, or signed URLs in a report.
    const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(raw) ? raw : 'READ_FAILED';
    readFailures.push({ design, ...(nodeId ? { nodeId } : {}), stage: nodeId ? 'sample' : 'design', code });
    if (code === 'AUTH_EXPIRED' || code === 'AUTH_REQUIRED') authenticationFailed = true;
  };
  for (const [index, design] of baseline.designs.entries()) {
    const result: DesignVerification = { design: index + 1, status: 'skipped', samples: newCounts(design.samples.length), checks: 0, failures: 0 };
    results.push(result);
    if (authenticationFailed) {
      designs.skipped++; samples.skipped += design.samples.length; result.samples.skipped = design.samples.length;
      continue;
    }
    designs.attempted++;
    try { await reader.prepareDesign?.(design); }
    catch (error) {
      recordFailure(error, index + 1);
      result.status = 'read-failed'; designs.failed++;
      samples.skipped += design.samples.length; result.samples.skipped = design.samples.length;
      continue;
    }
    const styles = new Map<string, Promise<BaselineStyle>>();
    const readStyle = (nodeId: string) => {
      if (!styles.has(nodeId)) styles.set(nodeId, reader.readStyle(design, nodeId));
      return styles.get(nodeId)!;
    };
    for (const sample of design.samples) {
      if (authenticationFailed) { samples.skipped++; result.samples.skipped++; continue; }
      samples.attempted++; result.samples.attempted++;
      try {
        const actual = await readStyle(sample.nodeId);
        let point: [number, number] | undefined;
        if (sample.canvasPosition) {
          point = [0, 0]; let current = actual;
          const visited = new Set([sample.nodeId]);
          while (current.parentId) {
            if (visited.has(current.parentId)) throw Object.assign(new Error(), { code: 'INVALID_PARENT_TREE' });
            visited.add(current.parentId);
            if (current.style.css?.transform) throw Object.assign(new Error(), { code: 'UNSUPPORTED_CANVAS_POSITION' });
            point[0] += current.style.layout.relativeX; point[1] += current.style.layout.relativeY;
            current = await readStyle(current.parentId);
          }
          point = [point[0] * actual.style.units.scale, point[1] * actual.style.units.scale];
        }
        const diff = compareBaselineSample(actual.style, sample, point);
        differences.push(...diff.map(difference => ({ design: index + 1, ...difference })));
        const count = sampleCheckCount(sample);
        checks += count; result.checks += count; result.failures += diff.length;
        samples.verified++; result.samples.verified++;
      } catch (error) {
        recordFailure(error, index + 1, sample.nodeId);
        samples.failed++; result.samples.failed++;
      }
    }
    if (result.samples.verified === design.samples.length) { result.status = 'verified'; designs.verified++; }
    else { result.status = result.samples.verified ? 'partial' : 'read-failed'; designs.failed++; }
  }
  const complete = samples.verified === samples.total;
  return { complete, passed: complete && checks > 0 && differences.length === 0, designs, samples, checks, expectedChecks,
    skippedChecks: expectedChecks - checks, failures: differences.length, readFailures, results, differences };
}
