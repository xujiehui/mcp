import { describe, expect, it, vi } from 'vitest';
import { baselineSchema, verifyBaseline, type BaselineStyle } from '../src/baseline.js';
import { MoonvyError } from '../src/errors.js';

const baseline = (nodes: string[][]) => baselineSchema.parse({
  formatVersion: 1, provenance: { kind: 'synthetic', observedAt: '2026-11-17', source: 'hand-authored test expectations' },
  designs: nodes.map((ids, index) => ({ url: `https://moonvy.com/project/test/folder/design-${index}`, samples: ids.map(nodeId => ({ nodeId, css: { color: '#ff0000' } })) })),
});
const red: BaselineStyle = { parentId: null, style: { css: { color: '#ff0000' } } };

describe('baseline verification coverage', () => {
  it('checks later files after a forbidden design and reports incomplete coverage', async () => {
    const input = baseline([['restricted-a', 'restricted-b'], ['accessible']]);
    const readStyle = vi.fn(async () => red);
    const report = await verifyBaseline(input, {
      async prepareDesign(design) { if (design === input.designs[0]) throw new MoonvyError('FORBIDDEN', 'private signed URL'); }, readStyle,
    });
    expect(readStyle.mock.calls).toHaveLength(1);
    expect(report).toMatchObject({ complete: false, passed: false, checks: 1, expectedChecks: 3, skippedChecks: 2, failures: 0,
      designs: { total: 2, attempted: 2, verified: 1, failed: 1, skipped: 0 },
      samples: { total: 3, attempted: 1, verified: 1, failed: 0, skipped: 2 },
      readFailures: [{ design: 1, stage: 'design', code: 'FORBIDDEN' }],
    });
    expect(report.results.map(result => result.status)).toEqual(['read-failed', 'verified']);
    expect(JSON.stringify(report)).not.toContain('private signed URL');
  });

  it('continues after a missing node and retains independent CSS mismatches', async () => {
    const report = await verifyBaseline(baseline([['missing', 'wrong', 'correct']]), {
      async readStyle(_design, nodeId) {
        if (nodeId === 'missing') throw new MoonvyError('NODE_NOT_FOUND', 'missing');
        return nodeId === 'wrong' ? { parentId: null, style: { css: { color: '#0000ff' } } } : red;
      },
    });
    expect(report).toMatchObject({ complete: false, passed: false, checks: 2, expectedChecks: 3, skippedChecks: 1, failures: 1,
      samples: { total: 3, attempted: 3, verified: 2, failed: 1, skipped: 0 },
      readFailures: [{ design: 1, nodeId: 'missing', stage: 'sample', code: 'NODE_NOT_FOUND' }],
      differences: [{ design: 1, nodeId: 'wrong', field: 'css.color', expected: '#ff0000', actual: '#0000ff' }],
    });
    expect(report.results[0].status).toBe('partial');
  });

  it.each(['AUTH_EXPIRED', 'AUTH_REQUIRED'])('stops further requests on %s and never passes zero checks', async (code) => {
    const prepareDesign = vi.fn(async () => { throw new MoonvyError(code, 'authentication failed'); });
    const readStyle = vi.fn(async () => red);
    const report = await verifyBaseline(baseline([['a'], ['b', 'c']]), { prepareDesign, readStyle });
    expect(prepareDesign).toHaveBeenCalledTimes(1); expect(readStyle).not.toHaveBeenCalled();
    expect(report).toMatchObject({ complete: false, passed: false, checks: 0, skippedChecks: 3,
      designs: { total: 2, attempted: 1, verified: 0, failed: 1, skipped: 1 },
      samples: { total: 3, attempted: 0, verified: 0, failed: 0, skipped: 3 },
    });
    expect(report.results[1].status).toBe('skipped');
  });

  it('also stops authentication failures during node reads', async () => {
    const readStyle = vi.fn(async (_design, nodeId) => {
      if (nodeId === 'expired') throw new MoonvyError('AUTH_EXPIRED', 'expired');
      return red;
    });
    const report = await verifyBaseline(baseline([['ok', 'expired', 'skip'], ['also-skip']]), { readStyle });
    expect(readStyle).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ complete: false, passed: false, checks: 1,
      samples: { total: 4, attempted: 2, verified: 1, failed: 1, skipped: 2 } });
  });

  it('distinguishes a fully compared mismatch from a successful verification', async () => {
    const input = baseline([['a']]);
    const pass = await verifyBaseline(input, { async readStyle() { return red; } });
    expect(pass).toMatchObject({ complete: true, passed: true, checks: 1, failures: 0, skippedChecks: 0 });
    input.designs[0].samples[0].css!.color = '#000000';
    const mismatch = await verifyBaseline(input, { async readStyle() { return red; } });
    expect(mismatch).toMatchObject({ complete: true, passed: false, checks: 1, failures: 1, skippedChecks: 0 });
  });

  it('checks relative ancestor coordinates while isolating a cyclic node tree', async () => {
    const input = baseline([['child', 'cycle']]);
    for (const sample of input.designs[0].samples) sample.canvasPosition = [30, 50];
    const reader = vi.fn(async (_design, nodeId): Promise<BaselineStyle> => {
      if (nodeId === 'frame') return { ...red, style: { ...red.style, layout: { relativeX: 1000, relativeY: 1000 } } };
      return { parentId: nodeId === 'cycle' ? 'cycle' : nodeId === 'group' ? 'frame' : 'group',
        style: { ...red.style, units: { scale: 2 }, layout: { relativeX: nodeId === 'group' ? 10 : 5, relativeY: nodeId === 'group' ? 20 : 5 } } };
    });
    const report = await verifyBaseline(input, { readStyle: reader });
    expect(report).toMatchObject({ checks: 3, failures: 0, skippedChecks: 3, complete: false,
      readFailures: [{ nodeId: 'cycle', code: 'INVALID_PARENT_TREE' }] });
    expect(reader.mock.calls.filter(([, id]) => id === 'cycle')).toHaveLength(1);
  });
});
