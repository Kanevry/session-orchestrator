/**
 * tests/skills/session-plan/ultradeep-wave-shape.test.mjs
 *
 * The 7-wave `session-profile: ultradeep` shape in
 * `skills/session-plan/SKILL.md`, and the one rule that can silently delete it.
 *
 * THE BUG THIS CATCHES (TV-001): Step 2's empty-role rule ("If a role has 0
 * tasks, skip its wave entirely") removes the Synthesis-Gate. The gate is the
 * one wave whose PURPOSE is to dispatch zero agents — the coordinator
 * consolidates wave 1 and asks a blocking AskUserQuestion before any code is
 * written. Under the unqualified rule its `agents: 0` reads as "empty", the
 * wave is dropped, and a 7-wave ultradeep plan silently becomes a 6-wave plan
 * that never stops to ask. Nothing errors; the plan simply looks smaller.
 * (PRD docs/prd/2026-09-06-ultradeep-session-profile.md AC-2 / AC-4.)
 *
 * NOT A PROSE PIN (`.claude/rules/test-value.md` TV-002c). No sentence is
 * asserted. Three STRUCTURES are extracted and compared as data: the
 * Role-to-Wave table row, the per-wave agent-count table, and the plan item
 * that carries the exception's two markers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SKILL = readFileSync(path.join(REPO_ROOT, 'skills/session-plan/SKILL.md'), 'utf8');

/** Every `| a | b | … |` row of the document, as arrays of trimmed cells. */
function tableRows(text) {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('|') && l.trim().endsWith('|'))
    .map((l) => l.trim().slice(1, -1).split('|').map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^-{2,}$/.test(c.replace(/:/g, ''))));
}

/** `W1=Role, W2=Other (note, note)` → { 1: 'Role', 2: 'Other' } */
function parseWaveMapping(cell) {
  const out = {};
  for (const part of cell.split(/,\s*(?=W\d+\s*=)/)) {
    const m = part.match(/^W(\d+)\s*=\s*(.+)$/);
    if (!m) continue;
    out[Number(m[1])] = m[2].replace(/\s*\(.*$/, '').trim();
  }
  return out;
}

/** Key/value pairs of the first fenced block after `marker`, `- ` bullets stripped. */
function planItemAfter(text, marker) {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const fence = text.slice(idx).match(/```[a-z]*\n([\s\S]*?)\n```/);
  if (!fence) return null;
  const out = {};
  for (const raw of fence[1].split('\n')) {
    const line = raw.replace(/^\s*-\s*/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

const ultradeepRow = tableRows(SKILL).find(
  (cells) => cells.length === 2 && cells[0].includes('ultradeep')
);

describe('ultradeep 7-wave shape (skills/session-plan/SKILL.md)', () => {
  it('the Role-to-Wave table carries a row keyed on the profile', () => {
    expect(ultradeepRow).toBeDefined();
    expect(ultradeepRow[0]).toContain('session-profile');
  });

  it('maps exactly 7 waves, with the Synthesis-Gate at wave 2', () => {
    const mapping = parseWaveMapping(ultradeepRow[1]);
    expect(Object.keys(mapping).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(mapping[2]).toBe('Synthesis-Gate');
    expect(mapping[7]).toBe('Release/Finalization');
  });

  it('declares the wave-2 cell with BOTH markers the exception keys on', () => {
    // Either marker alone is not enough: `agents: 0` without
    // `coordinator-direct: true` is exactly what the empty-role rule deletes.
    const waveTwoCell = ultradeepRow[1].split(/,\s*(?=W\d+\s*=)/)[1];
    expect(waveTwoCell).toMatch(/coordinator-direct.*true/);
    expect(waveTwoCell).toMatch(/agents.*0/);
  });

  it('the per-wave agent-count table sizes wave 2 at zero and the others above zero', () => {
    const counts = {};
    for (const cells of tableRows(SKILL)) {
      if (cells.length !== 4) continue;
      const wave = Number(cells[0]);
      if (!Number.isInteger(wave) || wave < 1 || wave > 7) continue;
      counts[wave] = { role: cells[1], agents: cells[2] };
    }
    expect(Object.keys(counts).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(counts[2].role).toBe('Synthesis-Gate');
    expect(counts[2].agents).toMatch(/^0\b/);
    // Every other wave dispatches somebody — a table where the gate is not the
    // singular zero would mean the zero carries no information.
    for (const w of [1, 3, 4, 5, 7]) expect(counts[w].agents).not.toMatch(/^0\b/);
  });
});

describe('empty-role rule — the coordinator-direct exception', () => {
  it('states the exception inside the empty-role rule, not somewhere else', () => {
    const ruleIdx = SKILL.indexOf('**Empty roles:**');
    const exceptionIdx = SKILL.indexOf('coordinator-direct: true` is NEVER removed');
    expect(ruleIdx).toBeGreaterThan(-1);
    expect(exceptionIdx).toBeGreaterThan(ruleIdx);
    // …and before the next section, so it cannot drift away from the rule it
    // qualifies. A reader who stops at the rule must not miss it.
    const nextHeading = SKILL.indexOf('\n### ', ruleIdx);
    expect(exceptionIdx).toBeLessThan(nextHeading);
  });

  it('shows the exempt plan item with the marker AND the zero-agent declaration', () => {
    const item = planItemAfter(SKILL.slice(SKILL.indexOf('**Empty roles:**')), 'coordinator-direct');
    expect(item).toEqual({
      wave: '2',
      role: 'Synthesis-Gate',
      'coordinator-direct': 'true',
      agents: '0',
    });
  });
});
