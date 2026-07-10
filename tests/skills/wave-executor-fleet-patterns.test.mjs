/**
 * tests/skills/wave-executor-fleet-patterns.test.mjs
 *
 * Regression guard for the #730 fleet-mining orchestration patterns wired
 * into skills/wave-executor/wave-loop.md + SKILL.md this session:
 *   - Contract-Lock Serialization (Pattern A, #730/H1)
 *   - Pre-Dispatch: Path-Cousin-Guard Injection (#730.3)
 *   - Over-delivery capture (step 7 metrics, #730/H4) + Wave History header format
 *   - Reviewer-finding-overridden Deviation format (#730/H5)
 *
 * Style mirrors tests/skills/wave-executor-dispatch-batch.test.mjs
 * (indexOf-bounded region extraction, REPO_ROOT resolution, content-presence
 * assertions against the live skill files — no mocks, no subprocess spawn).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WAVE_LOOP_MD = join(REPO_ROOT, 'skills/wave-executor/wave-loop.md');
const SKILL_MD = join(REPO_ROOT, 'skills/wave-executor/SKILL.md');

let waveLoop;
let skill;

beforeAll(() => {
  waveLoop = readFileSync(WAVE_LOOP_MD, 'utf8');
  skill = readFileSync(SKILL_MD, 'utf8');
});

// NOTE: headings are located via a leading "\n" anchor — "### 2. Review Agent
// Outputs" also appears as an inline backtick cross-reference earlier in the
// file ("proceed to `### 2. Review Agent Outputs`."), which a bare indexOf()
// would match first and truncate the dispatch section far too early.

/** Region between "### 1. Dispatch Agents" and "### 2. Review Agent Outputs". */
function dispatchSection(text) {
  const start = text.indexOf('\n### 1. Dispatch Agents\n');
  const end = text.indexOf('\n### 2. Review Agent Outputs\n');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('could not locate §1 Dispatch Agents section boundaries in wave-loop.md');
  }
  return text.slice(start, end);
}

/** Region between "### 2. Review Agent Outputs" and "### 3. Adapt Plan". */
function reviewSection(text) {
  const start = text.indexOf('\n### 2. Review Agent Outputs\n');
  const end = text.indexOf('\n### 3. Adapt Plan (if needed)\n');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('could not locate §2 Review Agent Outputs section boundaries in wave-loop.md');
  }
  return text.slice(start, end);
}

describe('#730/H1 Contract-Lock Serialization (wave-loop.md §1)', () => {
  it('the Contract-Lock heading sits inside § 1. Dispatch Agents', () => {
    const section = dispatchSection(waveLoop);
    expect(section).toContain('#### Contract-Lock Serialization (Pattern A, #730/H1)');
  });

  it('the Contract-Lock region gates on the contract-lock: true task flag', () => {
    const idx = waveLoop.indexOf('#### Contract-Lock Serialization');
    const idxEnd = waveLoop.indexOf('#### Dispatch Verification', idx);
    const region = waveLoop.slice(idx, idxEnd);
    expect(region).toContain('contract-lock: true');
  });

  it('the Contract-Lock region routes STATUS partial/failed through AskUserQuestion', () => {
    const idx = waveLoop.indexOf('#### Contract-Lock Serialization');
    const idxEnd = waveLoop.indexOf('#### Dispatch Verification', idx);
    const region = waveLoop.slice(idx, idxEnd);
    expect(region).toMatch(/STATUS: partial\/failed/);
    expect(region).toContain('AskUserQuestion');
  });
});

describe('#730.3 Pre-Dispatch Path-Cousin-Guard Injection (wave-loop.md §1)', () => {
  it('the Path-Cousin-Guard heading exists in wave-loop.md §1', () => {
    const section = dispatchSection(waveLoop);
    expect(section).toContain('#### Pre-Dispatch: Path-Cousin-Guard Injection (#730.3)');
  });

  it('the Path-Cousin-Guard region emits the <PATH-COUSIN-GUARD> prompt wrapper', () => {
    const idx = waveLoop.indexOf('#### Pre-Dispatch: Path-Cousin-Guard Injection');
    const idxEnd = waveLoop.indexOf('#### Agent-Type Resolution', idx);
    const region = waveLoop.slice(idx, idxEnd);
    expect(region).toContain('<PATH-COUSIN-GUARD>');
  });

  it('the Path-Cousin-Guard region documents the silent-no-op-on-zero-candidates contract', () => {
    const idx = waveLoop.indexOf('#### Pre-Dispatch: Path-Cousin-Guard Injection');
    const idxEnd = waveLoop.indexOf('#### Agent-Type Resolution', idx);
    const region = waveLoop.slice(idx, idxEnd);
    expect(region).toMatch(/0 candidates/);
    expect(region).toMatch(/Never blocks dispatch/);
  });

  it('SKILL.md carries the Path-Cousin-Guard pointer heading', () => {
    expect(skill).toContain('## Path-Cousin-Guard (#730.3)');
  });
});

describe('#730/H4 over-delivery capture (wave-loop.md §2 step 7)', () => {
  it('step 7 records planned_files_count reusing the step 3c value', () => {
    const section = reviewSection(waveLoop);
    expect(section).toContain('`planned_files_count`');
    expect(section).toMatch(/do not recompute/);
  });

  it('step 7 records over_delivery_ratio and omits both fields when grounding-check is false', () => {
    const section = reviewSection(waveLoop);
    expect(section).toContain('`over_delivery_ratio`');
    expect(section).toContain('Omit both fields when `grounding-check: false`');
  });
});

describe('#730/H4 Wave History header over-delivery format (wave-loop.md §3a)', () => {
  it('the Wave History entry format embeds the over-delivery parenthetical', () => {
    const idx = waveLoop.indexOf('### 3a. Post-Wave: Update STATE.md');
    const idxEnd = waveLoop.indexOf('### 3a-bis', idx);
    const region = waveLoop.slice(idx, idxEnd);
    expect(idx).toBeGreaterThan(-1);
    expect(region).toContain('### Wave N — <Role> (planned <P> files → actual <A>, over-delivery <R>)');
  });
});

describe('#730/H5 reviewer-finding-overridden Deviation format (wave-loop.md §2 steps 5/5a)', () => {
  it('appears in BOTH the persona-reviewer (5a) and session-reviewer (5) dispatch steps', () => {
    const section = reviewSection(waveLoop);
    const matches = section.match(/reviewer finding overridden \(not actioned\)/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it('the deviation line is written via appendDeviationOnDisk in both occurrences', () => {
    const section = reviewSection(waveLoop);
    const matches = section.match(/appendDeviationOnDisk\(repoRoot, isoTimestamp, message\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// W4-Q3 GAP-2: the over-delivery Wave-History header is a PROSE CONTRACT
// shared verbatim between the writer (wave-loop.md §3a) and the parser
// (session-end metrics-collection.md). No mechanical parser exists — the
// coordinator parses it — so the IDENTICAL parenthetical template must appear
// in BOTH files. A one-sided rewording silently kills the #730/H4 signal.
// ---------------------------------------------------------------------------

describe('#730/H4 over-delivery header — cross-file prose contract (GAP-2)', () => {
  const HEADER_TEMPLATE = '(planned <P> files → actual <A>, over-delivery <R>)';

  it('the writer side (wave-loop.md §3a) carries the exact template', () => {
    expect(waveLoop).toContain(HEADER_TEMPLATE);
  });

  it('the parser side (session-end metrics-collection.md) carries the byte-identical template', () => {
    const metricsCollection = readFileSync(
      join(REPO_ROOT, 'skills/session-end/metrics-collection.md'),
      'utf8',
    );
    expect(metricsCollection).toContain(HEADER_TEMPLATE);
  });
});
