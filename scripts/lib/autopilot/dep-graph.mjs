// scripts/lib/autopilot/dep-graph.mjs
//
// Issue dependency graph + topological-sort scheduler for autopilot --multi-story.
// Pure data layer — no I/O, no shell. Powers nextReady() lookups during multi-story
// pipeline scheduling per docs/prd/2026-05-07-autopilot-phase-d.md.
//
// Substrate: ADR-364 thin-slice MVP. Issue selection criterion: `status:ready` label
// only (OPEN-1 decision in PRD). Cross-loop wait semantics use commit-based deps
// (OPEN-4), but this module is pure-graph and doesn't enforce wait policy — the
// worktree-pipeline driver is responsible for that.

/**
 * @fileoverview Pure topological-sort dependency graph for GitLab/GitHub issues.
 *
 * Handles `blocks`/`blocked-by` relations between issues and exposes scheduling
 * helpers for the `--multi-story` autopilot mode. All functions are pure data
 * transformations with no I/O side effects.
 *
 * References:
 *   - ADR-364 thin-slice MVP
 *   - docs/prd/2026-05-07-autopilot-phase-d.md
 */

/**
 * @typedef {object} Issue
 * @property {number} iid         - Issue IID/number
 * @property {string[]} blocks    - Array of iids (as strings or numbers) this issue blocks
 * @property {string[]} blockedBy - Array of iids (as strings or numbers) blocking this issue
 * @property {string[]} labels    - Issue labels (e.g., ["status:ready"])
 * @property {string}  title      - Issue title (for diagnostics)
 */

/**
 * @typedef {object} DepGraph
 * @property {Map<number, Issue>}         nodes   - All known issues keyed by iid
 * @property {Map<number, Set<number>>}   edges   - iid → set of iids it blocks (outgoing)
 * @property {Map<number, Set<number>>}   reverse - iid → set of iids blocking it (incoming)
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a raw iid value (string or number) to a number, or return null if
 * the value is not a valid finite integer.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function toIid(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/**
 * Safely coerce a field that should be an array of iids.
 * Returns an empty array when the field is null/undefined/non-array.
 *
 * @param {unknown} field
 * @returns {number[]}
 */
function normalizeIidArray(field) {
  if (!Array.isArray(field)) return [];
  return field.map(toIid).filter((n) => n !== null);
}

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

/**
 * Build a DepGraph from an array of issues.
 *
 * Reconciles both directions of the blocks/blockedBy relationship:
 * - If A.blocks includes B's iid, then B.blockedBy is extended to include A.
 * - If A.blockedBy includes B's iid, then B.blocks is extended to include A.
 *
 * Issues referenced in blocks/blockedBy that are not present in the input
 * array are silently ignored after emitting a `console.warn`. The graph will
 * only contain nodes for issues present in the `issues` parameter.
 *
 * @param {Issue[]} issues - Flat array of issues to build the graph from.
 * @returns {DepGraph}
 */
export function buildGraph(issues) {
  /** @type {Map<number, Issue>} */
  const nodes = new Map();
  /** @type {Map<number, Set<number>>} */
  const edges = new Map();
  /** @type {Map<number, Set<number>>} */
  const reverse = new Map();

  if (!Array.isArray(issues) || issues.length === 0) {
    return { nodes, edges, reverse };
  }

  // First pass: intern all issues, normalizing iid arrays defensively.
  for (const raw of issues) {
    const iid = toIid(raw?.iid);
    if (iid === null) {
      console.warn('[dep-graph] buildGraph: skipping issue with invalid iid', raw);
      continue;
    }
    /** @type {Issue} */
    const issue = {
      iid,
      blocks: normalizeIidArray(raw.blocks),
      blockedBy: normalizeIidArray(raw.blockedBy),
      labels: Array.isArray(raw.labels) ? [...raw.labels] : [],
      title: typeof raw.title === 'string' ? raw.title : String(raw.title ?? ''),
    };
    nodes.set(iid, issue);
    edges.set(iid, new Set());
    reverse.set(iid, new Set());
  }

  // Second pass: reconcile both directions and populate edge maps.
  // We first collect all declared relations, then validate both ends exist.
  // Collect raw declarations: [blocker, blocked] pairs.
  /** @type {Array<[number, number]>} */
  const declared = [];

  for (const issue of nodes.values()) {
    for (const target of issue.blocks) {
      declared.push([issue.iid, target]);
    }
    for (const source of issue.blockedBy) {
      declared.push([source, issue.iid]);
    }
  }

  // Deduplicate and validate, then write into edge maps and normalised Issue fields.
  const seen = new Set();
  for (const [blocker, blocked] of declared) {
    const key = `${blocker}:${blocked}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (blocker === blocked) {
      console.warn(`[dep-graph] buildGraph: self-loop on iid ${blocker} ignored`);
      continue;
    }

    const blockerNode = nodes.get(blocker);
    const blockedNode = nodes.get(blocked);

    if (!blockerNode) {
      console.warn(`[dep-graph] buildGraph: iid ${blocker} referenced but not in issues array — ignored`);
      continue;
    }
    if (!blockedNode) {
      console.warn(`[dep-graph] buildGraph: iid ${blocked} referenced but not in issues array — ignored`);
      continue;
    }

    // Sync normalised arrays on the Issue objects.
    if (!blockerNode.blocks.includes(blocked)) blockerNode.blocks.push(blocked);
    if (!blockedNode.blockedBy.includes(blocker)) blockedNode.blockedBy.push(blocker);

    // Populate edge maps.
    edges.get(blocker).add(blocked);
    reverse.get(blocked).add(blocker);
  }

  return { nodes, edges, reverse };
}

// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------

/**
 * Perform a topological sort on the graph using Kahn's BFS algorithm.
 *
 * Tie-breaking between nodes at the same depth is resolved by ascending iid
 * (stable, deterministic output).
 *
 * When cycles are present, the `order` array contains only the nodes NOT
 * involved in any cycle (processed in topological order). The `cycles` array
 * contains each cycle as an array of iid numbers.
 *
 * @param {DepGraph} graph
 * @returns {{ order: number[], cycles: number[][] }}
 */
export function topologicalSort(graph) {
  const { nodes, edges, reverse } = graph;

  if (nodes.size === 0) {
    return { order: [], cycles: [] };
  }

  // Build a mutable in-degree map.
  /** @type {Map<number, number>} */
  const inDegree = new Map();
  for (const iid of nodes.keys()) {
    inDegree.set(iid, reverse.get(iid)?.size ?? 0);
  }

  // Seed the queue with all zero-in-degree nodes, sorted by ascending iid.
  /** @type {number[]} */
  const queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([iid]) => iid)
    .sort((a, b) => a - b);

  /** @type {number[]} */
  const order = [];

  while (queue.length > 0) {
    // Dequeue the smallest iid (queue is always kept sorted).
    const iid = queue.shift();
    order.push(iid);

    // Decrement in-degree for all nodes this iid blocks.
    const neighbours = [...(edges.get(iid) ?? [])].sort((a, b) => a - b);
    for (const neighbour of neighbours) {
      const newDeg = (inDegree.get(neighbour) ?? 0) - 1;
      inDegree.set(neighbour, newDeg);
      if (newDeg === 0) {
        // Insert in sorted position to maintain ascending-iid stability.
        insertSorted(queue, neighbour);
      }
    }
  }

  // Any node not in `order` is part of a cycle.
  const inOrderSet = new Set(order);
  const cycleNodes = [...nodes.keys()].filter((iid) => !inOrderSet.has(iid));

  const cycles = cycleNodes.length > 0 ? detectCyclesFromNodes(graph, cycleNodes) : [];

  return { order, cycles };
}

/**
 * Insert `value` into a sorted array (ascending) in-place using binary search.
 *
 * @param {number[]} arr
 * @param {number} value
 */
function insertSorted(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

/**
 * Detect all strongly-connected components (SCCs) of size > 1 using an
 * iterative implementation of Tarjan's SCC algorithm.
 *
 * Returns each cycle as an array of iid numbers (members of the SCC),
 * sorted by ascending iid within each cycle. The outer array is sorted by
 * the minimum iid of each cycle (ascending).
 *
 * @param {DepGraph} graph
 * @returns {number[][]}
 */
export function detectCycles(graph) {
  return detectCyclesFromNodes(graph, [...graph.nodes.keys()]);
}

/**
 * Internal: run Tarjan's iterative SCC algorithm over a subset of nodes
 * (or all nodes). Only SCCs of size > 1 are returned (true cycles).
 *
 * @param {DepGraph} graph
 * @param {number[]} nodeSubset - iids to consider
 * @returns {number[][]}
 */
function detectCyclesFromNodes(graph, nodeSubset) {
  const { edges } = graph;

  let index = 0;
  /** @type {Map<number, number>} */
  const indices = new Map();
  /** @type {Map<number, number>} */
  const lowlink = new Map();
  /** @type {Set<number>} */
  const onStack = new Set();
  /** @type {number[]} */
  const stack = [];
  /** @type {number[][]} */
  const sccs = [];

  // Only process nodes in the subset.
  const subsetSet = new Set(nodeSubset);

  /**
   * Iterative Tarjan's SCC for a single root node.
   *
   * @param {number} root
   */
  function strongconnect(root) {
    // Explicit call-stack frames to avoid recursion limits.
    // Each frame: { iid, neighbourIter, parentIid }
    /** @type {Array<{ iid: number, neighbours: number[], ni: number }>} */
    const callStack = [];

    function visit(iid) {
      indices.set(iid, index);
      lowlink.set(iid, index);
      index++;
      stack.push(iid);
      onStack.add(iid);

      const neighbours = [...(edges.get(iid) ?? [])]
        .filter((n) => subsetSet.has(n))
        .sort((a, b) => a - b);
      callStack.push({ iid, neighbours, ni: 0 });
    }

    visit(root);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const { iid, neighbours } = frame;

      if (frame.ni < neighbours.length) {
        const w = neighbours[frame.ni++];
        if (!indices.has(w)) {
          visit(w);
        } else if (onStack.has(w)) {
          lowlink.set(iid, Math.min(lowlink.get(iid), indices.get(w)));
        }
      } else {
        // Pop frame.
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1];
          lowlink.set(
            parent.iid,
            Math.min(lowlink.get(parent.iid), lowlink.get(iid))
          );
        }
        // Check if this iid is an SCC root.
        if (lowlink.get(iid) === indices.get(iid)) {
          const scc = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            scc.push(w);
          } while (w !== iid);
          if (scc.length > 1) {
            sccs.push(scc.sort((a, b) => a - b));
          }
        }
      }
    }
  }

  for (const iid of nodeSubset) {
    if (!indices.has(iid)) {
      strongconnect(iid);
    }
  }

  // Sort by minimum iid in each SCC ascending.
  sccs.sort((a, b) => Math.min(...a) - Math.min(...b));
  return sccs;
}

// ---------------------------------------------------------------------------
// nextReady
// ---------------------------------------------------------------------------

/**
 * Return the set of issues that are ready to be started next.
 *
 * An issue is considered ready when ALL of the following hold:
 *   1. It is NOT in `inFlight` (already being processed).
 *   2. It is NOT in `completed` (already done).
 *   3. Every iid in its `blockedBy` list is present in `completed`.
 *   4. It carries the label `"status:ready"`.
 *
 * The returned array is sorted by ascending iid.
 *
 * @param {DepGraph}      graph     - The dependency graph.
 * @param {Set<number>}   inFlight  - iids currently being processed.
 * @param {Set<number>}   completed - iids that have finished successfully.
 * @returns {Issue[]}
 */
export function nextReady(graph, inFlight, completed) {
  const safeInFlight = inFlight instanceof Set ? inFlight : new Set();
  const safeCompleted = completed instanceof Set ? completed : new Set();

  /** @type {Issue[]} */
  const ready = [];

  for (const [iid, issue] of graph.nodes) {
    if (safeInFlight.has(iid)) continue;
    if (safeCompleted.has(iid)) continue;

    // All blockers must be completed.
    const blockers = Array.isArray(issue.blockedBy) ? issue.blockedBy : [];
    const allBlockersCompleted = blockers.every((b) => safeCompleted.has(b));
    if (!allBlockersCompleted) continue;

    // Must carry status:ready label.
    if (!Array.isArray(issue.labels) || !issue.labels.includes('status:ready')) continue;

    ready.push(issue);
  }

  return ready.sort((a, b) => a.iid - b.iid);
}
