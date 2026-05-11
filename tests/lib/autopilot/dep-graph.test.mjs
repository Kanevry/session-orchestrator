/**
 * tests/lib/autopilot/dep-graph.test.mjs
 *
 * Unit tests for scripts/lib/autopilot/dep-graph.mjs
 * Covers: buildGraph, topologicalSort, nextReady, detectCycles
 * Created in ADR-364 thin-slice Phase D (W4 Q1).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildGraph,
  topologicalSort,
  nextReady,
  detectCycles,
} from '../../../scripts/lib/autopilot/dep-graph.mjs';

// ---------------------------------------------------------------------------
// Helpers — build typed Issue objects for use in table rows.
// ---------------------------------------------------------------------------

function issue(iid, { blocks = [], blockedBy = [], labels = [], title = '' } = {}) {
  return { iid, blocks, blockedBy, labels, title };
}

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

describe('buildGraph', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('empty array → nodes.size 0, edges.size 0, reverse.size 0', () => {
    const g = buildGraph([]);
    expect(g.nodes.size).toBe(0);
    expect(g.edges.size).toBe(0);
    expect(g.reverse.size).toBe(0);
  });

  it('single issue with no relations → 1 node, edges set is empty', () => {
    const g = buildGraph([issue(7, { labels: ['status:ready'] })]);
    expect(g.nodes.size).toBe(1);
    expect(g.edges.get(7).size).toBe(0);
    expect(g.reverse.get(7).size).toBe(0);
  });

  it('bi-directional reconciliation: blocks edge populates both edges and reverse', () => {
    const g = buildGraph([
      issue(1, { blocks: [2] }),
      issue(2),
    ]);
    // forward edge: 1 → 2
    expect(g.edges.get(1).has(2)).toBe(true);
    // reverse edge: 2 is blocked by 1
    expect(g.reverse.get(2).has(1)).toBe(true);
    // no back-edge on the other side
    expect(g.edges.get(2).has(1)).toBe(false);
    expect(g.reverse.get(1).has(2)).toBe(false);
  });

  it('missing reference (iid 99 not in array) → no throw, node not added, console.warn fired', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let g;
    expect(() => {
      g = buildGraph([issue(1, { blocks: [99] })]);
    }).not.toThrow();
    expect(g.nodes.size).toBe(1);
    expect(g.nodes.has(99)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('null/undefined blocks and blockedBy fields → treated as empty arrays, no throw', () => {
    const g = buildGraph([
      { iid: 3, blocks: null, blockedBy: undefined, labels: null, title: null },
    ]);
    expect(g.nodes.size).toBe(1);
    expect(g.edges.get(3).size).toBe(0);
    expect(g.reverse.get(3).size).toBe(0);
  });

  it('duplicate iid in input → last entry wins, only 1 node', () => {
    const g = buildGraph([
      issue(5, { labels: ['status:ready'] }),
      issue(5, { labels: ['status:blocked'] }),
    ]);
    expect(g.nodes.size).toBe(1);
    // The second entry (status:blocked) should win
    expect(g.nodes.get(5).labels).toEqual(['status:blocked']);
  });
});

// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------

describe('topologicalSort', () => {
  it('empty graph → { order: [], cycles: [] }', () => {
    const g = buildGraph([]);
    const result = topologicalSort(g);
    expect(result.order).toEqual([]);
    expect(result.cycles).toEqual([]);
  });

  it('linear chain 1→2→3 → order is [1, 2, 3]', () => {
    const g = buildGraph([
      issue(1, { blocks: [2] }),
      issue(2, { blocks: [3] }),
      issue(3),
    ]);
    const { order, cycles } = topologicalSort(g);
    expect(order).toEqual([1, 2, 3]);
    expect(cycles).toEqual([]);
  });

  it('diamond 1→{2,3}→4 → order [1, 2, 3, 4] with ascending tiebreak on middle nodes', () => {
    const g = buildGraph([
      issue(1, { blocks: [2, 3] }),
      issue(2, { blocks: [4] }),
      issue(3, { blocks: [4] }),
      issue(4),
    ]);
    const { order, cycles } = topologicalSort(g);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(cycles).toEqual([]);
  });

  it('cycle 2↔3 with acyclic 1 and 4 → order [1, 4], cycles [[2, 3]]', () => {
    const g = buildGraph([
      issue(1),
      issue(2, { blocks: [3] }),
      issue(3, { blocks: [2] }),
      issue(4),
    ]);
    const { order, cycles } = topologicalSort(g);
    expect(order).toEqual([1, 4]);
    expect(cycles).toEqual([[2, 3]]);
  });

  it('disconnected components (no edges) → all iids appear in order, sorted ascending', () => {
    const g = buildGraph([issue(10), issue(5), issue(1)]);
    const { order, cycles } = topologicalSort(g);
    expect(order).toEqual([1, 5, 10]);
    expect(cycles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// nextReady
// ---------------------------------------------------------------------------

describe('nextReady', () => {
  it('root nodes with status:ready, empty inFlight and completed → all returned sorted by iid', () => {
    const g = buildGraph([
      issue(3, { labels: ['status:ready'] }),
      issue(1, { labels: ['status:ready'] }),
      issue(2, { labels: ['status:ready'] }),
    ]);
    const result = nextReady(g, new Set(), new Set());
    expect(result.map((i) => i.iid)).toEqual([1, 2, 3]);
  });

  it('issues without status:ready label are filtered out', () => {
    const g = buildGraph([
      issue(1, { labels: ['status:ready'] }),
      issue(2, { labels: ['status:in-progress'] }),
      issue(3, { labels: [] }),
    ]);
    const result = nextReady(g, new Set(), new Set());
    expect(result.map((i) => i.iid)).toEqual([1]);
  });

  it('issue in inFlight is excluded; issue in completed is excluded', () => {
    const g = buildGraph([
      issue(1, { labels: ['status:ready'] }),
      issue(2, { labels: ['status:ready'] }),
      issue(3, { labels: ['status:ready'] }),
    ]);
    const result = nextReady(g, new Set([2]), new Set([3]));
    expect(result.map((i) => i.iid)).toEqual([1]);
  });

  it('issue whose blockedBy is not all-completed → excluded', () => {
    const g = buildGraph([
      issue(1, { blocks: [2], labels: ['status:ready'] }),
      issue(2, { labels: ['status:ready'] }),
    ]);
    // iid 1 is not yet completed, so iid 2 must be excluded
    const result = nextReady(g, new Set(), new Set());
    expect(result.map((i) => i.iid)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

describe('detectCycles', () => {
  it('acyclic graph → []', () => {
    const g = buildGraph([
      issue(1, { blocks: [2] }),
      issue(2, { blocks: [3] }),
      issue(3),
    ]);
    expect(detectCycles(g)).toEqual([]);
  });

  it('simple 2-cycle → [[a, b]] sorted ascending', () => {
    const g = buildGraph([
      issue(1, { blocks: [2] }),
      issue(2, { blocks: [1] }),
    ]);
    expect(detectCycles(g)).toEqual([[1, 2]]);
  });

  it('3-cycle → [[a, b, c]] sorted ascending', () => {
    const g = buildGraph([
      issue(1, { blocks: [2] }),
      issue(2, { blocks: [3] }),
      issue(3, { blocks: [1] }),
    ]);
    expect(detectCycles(g)).toEqual([[1, 2, 3]]);
  });

  it('two independent cycles → 2-element array, sorted by minimum iid of each cycle', () => {
    const g = buildGraph([
      issue(1, { blocks: [2] }),
      issue(2, { blocks: [1] }),
      issue(3, { blocks: [4] }),
      issue(4, { blocks: [3] }),
    ]);
    const cycles = detectCycles(g);
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toEqual([1, 2]);
    expect(cycles[1]).toEqual([3, 4]);
  });
});
