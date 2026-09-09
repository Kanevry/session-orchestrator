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
 * asserted. Since 2026-09-09 the wave table is CODE (`scripts/lib/session-shape.mjs`);
 * this file checks the prose→code seam and the plan item that carries the
 * exception's two markers, extracted as data.
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

const { resolveSessionShape } = await import('@lib/session-shape.mjs');

describe('ultradeep 7-wave shape — prose cites the shape, the shape carries the table', () => {
  // Since 2026-09-09 the wave table lives in scripts/lib/session-shape.mjs
  // (tests/lib/session-shape.test.mjs pins its numbers). What THIS file now
  // guards is the seam: session-plan must route the coordinator to that
  // resolver for the ultradeep profile, and the resolver must still produce
  // the Synthesis-Gate the empty-role exception below protects. If either
  // half regresses, a 7-wave plan silently becomes something else.
  it('§ Role-to-Wave Mapping routes to scripts/session-shape.mjs with the --profile ultradeep flag', () => {
    const section = SKILL.slice(SKILL.indexOf('### Role-to-Wave Mapping'), SKILL.indexOf('**Empty roles:**'));
    expect(section).toContain('scripts/session-shape.mjs');
    expect(section).toContain('--profile ultradeep');
    // No second table may compete with the resolver: a 2-column W1=…,W7=… row is the retired form.
    expect(tableRows(section).find((c) => c.length === 2 && /W1\s*=/.test(c[1]))).toBeUndefined();
  });

  it('the resolver yields exactly 7 waves with a coordinator-direct, zero-agent Synthesis-Gate at wave 2', () => {
    const shape = resolveSessionShape({ sessionType: 'deep', profile: 'ultradeep', waves: 5, agentsPerWave: 6 });
    expect(shape.totalWaves).toBe(7);
    expect(shape.waves.map((w) => w.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(shape.waves[1]).toMatchObject({ role: 'Synthesis-Gate', coordinatorDirect: true, agentCap: 0 });
    for (const n of [1, 3, 4, 5, 7]) expect(shape.waves[n - 1].agentCap).toBeGreaterThan(0);
    expect(shape.waves[6].role).toBe('Release/Finalization');
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
