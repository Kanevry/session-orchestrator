import { matchBlockHeader } from './block-header.mjs';
import { preprocessBlockLines } from './block-preprocess.mjs';

/**
 * gate.mjs — Parser for the top-level `gate:` YAML block
 * (PRD `docs/prd/2026-09-20-prozessgruppen-kill-und-waisen-waechter.md` §4 A3,
 * Epic #1425 / issue #1432).
 *
 * Holds the wall-clock ceiling for GATE PATH B — the
 * `scripts/run-quality-gate.mjs` → `scripts/lib/gates/gate-*.mjs` route, which
 * had NO timeout at all before #1425 A3. Path A (`scripts/lib/quality-gate.mjs`)
 * keeps its own `SO_GATE_TIMEOUT_MS` operator override; this block sets the
 * COMMITTED default for path B so both paths may run equally long.
 *
 * Precedence in `run-quality-gate.mjs`: `SO_GATE_TIMEOUT_MS` (operator, wins) >
 * this committed value > `DEFAULT_GATE_TIMEOUT_MS` (900 000).
 *
 * Tolerant parser: malformed values silently fall back to the default.
 *
 * Returns `{ 'timeout-path-b-ms': number }`.
 */

/** 900 000 ms (15 min) — same ceiling as `GATE_TIMEOUT_MS` on path A (PRD §4). */
const DEFAULT_TIMEOUT_PATH_B_MS = 900_000;

/**
 * Parse the top-level `gate:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * @param {string} content — full file contents
 * @returns {{'timeout-path-b-ms': number}}
 */
export function _parseGate(content) {
  let timeoutPathBMs = DEFAULT_TIMEOUT_PATH_B_MS;

  const lines = preprocessBlockLines(content);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'gate')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    if (k === 'timeout-path-b-ms') {
      // A zero or negative ceiling would kill every command instantly — the
      // failure mode is worse than the uncapped state this key exists to fix,
      // so it falls back to the default rather than being honoured.
      if (/^-?\d+$/.test(v)) {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) timeoutPathBMs = n;
      }
    }
  }

  return { 'timeout-path-b-ms': timeoutPathBMs };
}
