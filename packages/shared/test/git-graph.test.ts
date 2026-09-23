import { describe, expect, it } from 'vitest';
import { layoutGraph } from '../src/git-graph.js';

describe('layoutGraph', () => {
  it('keeps a linear history in one lane', () => {
    const rows = layoutGraph([
      { sha: 'c', parents: ['b'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0]).toMatchObject({ incoming: [], outgoing: [{ from: 0, to: 0 }], width: 1 });
    expect(rows[1]).toMatchObject({ incoming: [0], outgoing: [{ from: 0, to: 0 }] });
    expect(rows[2]).toMatchObject({ incoming: [0], outgoing: [] });
  });

  it('opens a lane for a merge parent and joins it back at the fork point', () => {
    // m merges f into b; f and b both come from a.
    const rows = layoutGraph([
      { sha: 'm', parents: ['b', 'f'] },
      { sha: 'f', parents: ['a'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    expect(rows[0]).toMatchObject({ lane: 0, outgoing: [{ from: 0, to: 0 }, { from: 0, to: 1 }], width: 2 });
    expect(rows[1]).toMatchObject({ lane: 1, through: [0], incoming: [1] });
    // f's parent a gets lane 1; b's parent a already has a lane, so b joins it.
    expect(rows[2]).toMatchObject({ lane: 0, through: [1], outgoing: [{ from: 0, to: 1 }] });
    expect(rows[3]).toMatchObject({ lane: 1, incoming: [1] });
  });

  it('puts unrelated tips in separate lanes', () => {
    const rows = layoutGraph([
      { sha: 'x', parents: ['base'] },
      { sha: 'y', parents: ['base'] },
      { sha: 'base', parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    // y's edge bends into the lane that already leads to base.
    expect(rows[1]!.outgoing).toEqual([{ from: 1, to: 0 }]);
    expect(rows[2]!.incoming).toEqual([0]);
  });

  it('caps the number of lanes', () => {
    const tips = Array.from({ length: 10 }, (_, i) => ({ sha: `t${i}`, parents: [`p${i}`] }));
    const rows = layoutGraph(tips, 4);
    expect(Math.max(...rows.map((r) => r.width))).toBeLessThanOrEqual(10);
    expect(rows.every((r) => r.outgoing.every((e) => e.to < 4))).toBe(true);
  });
});
