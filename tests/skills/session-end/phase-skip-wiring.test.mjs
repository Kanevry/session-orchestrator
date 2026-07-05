/**
 * tests/skills/session-end/phase-skip-wiring.test.mjs
 *
 * Spec-wiring suite for the Issue #724 session-end diet:
 *   - SKILL.md wires the Phase 3.6.x skip-plan dispatcher (planTailPhases).
 *   - The six tail procedures moved verbatim into phase-3-6-tail.md.
 *   - The abort/BLOCK gates (A=2.3, C=3.2, E=vault, F=drift) became
 *     warn + carryover + continue (no more "Abort close" / hard block).
 *   - The Phase 0.6 skill-invocation self-report (C4) is present.
 *
 * File-content assertions only — no production code executed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const dir = join(ROOT, 'skills', 'session-end');
const SKILL = join(dir, 'SKILL.md');
const TAIL = join(dir, 'phase-3-6-tail.md');
const DOCS = join(dir, 'phase-3-2-docs-verification.md');
const VAULT = join(dir, 'vault-operations.md');
const DRIFT = join(dir, 'drift-operations.md');

let skill, tail, docs, vault, drift;
beforeAll(() => {
  skill = readFileSync(SKILL, 'utf8');
  tail = readFileSync(TAIL, 'utf8');
  docs = readFileSync(DOCS, 'utf8');
  vault = readFileSync(VAULT, 'utf8');
  drift = readFileSync(DRIFT, 'utf8');
});

/** Slice a section from `start` heading up to the next `end` heading. */
function section(content, start, end) {
  const a = content.indexOf(start);
  const b = end ? content.indexOf(end, a + 1) : content.length;
  return a === -1 ? '' : content.slice(a, b === -1 ? content.length : b);
}

// ---------------------------------------------------------------------------
// A — dispatcher wiring in SKILL.md
// ---------------------------------------------------------------------------

describe('A — Phase 3.6.x skip-plan dispatcher wiring', () => {
  it('SKILL.md has the dispatcher heading and invokes planTailPhases', () => {
    expect(skill).toContain('### Phase 3.6.x Tail — Mechanical Skip-Plan (#724)');
    expect(skill).toContain('planTailPhases');
    expect(skill).toContain('scripts/lib/session-end/phase-skip.mjs');
  });

  it('SKILL.md instructs running only run:true phases and emitting skippedReport', () => {
    expect(skill).toContain('run: true');
    expect(skill).toContain('skippedReport');
  });

  it('SKILL.md no longer inlines the six tail procedure headings', () => {
    for (const h of [
      '### 3.6.3 Memory Proposals Collection',
      '### 3.6.4 Expired-Learnings Sweep',
      '### 3.6.5 Auto-Dream Dispatch',
      '### 3.6.6 Skill-Applied Judge',
      '### 3.6.7 Auto-Dialectic Dispatch',
      '### 3.6.8 Reconciliation Rule Proposals',
    ]) {
      expect(skill).not.toContain(h);
    }
  });

  it('Sub-File Reference table points at phase-3-6-tail.md and phase-skip.mjs', () => {
    expect(skill).toContain('`phase-3-6-tail.md`');
    expect(skill).toContain('`scripts/lib/session-end/phase-skip.mjs`');
    // the old (inline) rows are gone
    expect(skill).not.toContain('(inline) Phase 3.6.3');
  });
});

// ---------------------------------------------------------------------------
// B — the six procedures live in phase-3-6-tail.md, unabridged
// ---------------------------------------------------------------------------

describe('B — phase-3-6-tail.md holds all six procedures', () => {
  it('the sub-file exists', () => {
    expect(existsSync(TAIL)).toBe(true);
  });

  it('contains all six phase headers', () => {
    for (const h of ['### 3.6.3', '### 3.6.4', '### 3.6.5', '### 3.6.6', '### 3.6.7', '### 3.6.8']) {
      expect(tail).toContain(h + ' ');
    }
  });

  it('preserves the load-bearing API references from the moved procedures', () => {
    // A representative signal per phase — proves the bodies moved, not just headers.
    expect(tail).toContain('collectProposals');
    expect(tail).toContain('clearProposalsJsonl');
    expect(tail).toContain('sweep-expired-learnings');
    expect(tail).toContain('shouldDispatchAutoDream');
    expect(tail).toContain('runSkillJudge');
    expect(tail).toContain('shouldDispatchAutoDialectic');
    expect(tail).toContain('runReconcile');
    expect(tail).toContain('writeApprovedRules');
  });
});

// ---------------------------------------------------------------------------
// C — abort/BLOCK gates → warn + carryover + continue
// ---------------------------------------------------------------------------

describe('C — Gate A (Phase 2.3 strict) → warn + carryover', () => {
  const gateA = () => section(skill, '### 2.3 Vault Staleness Check', '## Phase 2.5:');

  it('no longer offers "Abort close"', () => {
    expect(gateA()).not.toContain('Abort close');
  });

  it('no longer BLOCKs the close', () => {
    expect(gateA()).not.toContain('BLOCK the close');
  });

  it('offers a carryover default and keeps the Override-and-close option', () => {
    const s = gateA();
    expect(s.toLowerCase()).toContain('carryover');
    expect(s).toContain('Override and close');
    expect(s).toContain('AskUserQuestion');
  });
});

describe('C — Gate C (Phase 3.2 docs strict) → warn + carryover', () => {
  it('no longer offers "Abort close"', () => {
    expect(docs).not.toContain('Abort close');
    expect(docs).not.toContain('Abort — close');
  });

  it('offers a carryover default and keeps Override', () => {
    expect(docs.toLowerCase()).toContain('carryover');
    expect(docs).toContain('Warn + carryover and close');
    expect(docs).toContain('Override —');
  });
});

describe('C — Gate E (vault-operations mode:hard) → warn + carryover', () => {
  it('no longer BLOCKs the session close', () => {
    expect(vault).not.toContain('BLOCK the session close');
  });
  it('files a carryover issue instead', () => {
    expect(vault.toLowerCase()).toContain('carryover');
    expect(vault).toContain('priority:high');
  });
});

describe('C — Gate F (drift-operations mode:hard) → warn + carryover', () => {
  it('no longer BLOCKs the session close', () => {
    expect(drift).not.toContain('BLOCK session close');
    expect(drift).not.toContain('BLOCK the session close');
  });
  it('files a carryover issue instead', () => {
    expect(drift.toLowerCase()).toContain('carryover');
    expect(drift).toContain('priority:high');
  });

  it('does not describe hard drift-check mode as blocking', () => {
    expect(drift).not.toContain('would have blocked');
    expect(drift).not.toContain('hard mode, blocking');
  });

  it('maps drift-check flags for checks 5-9 to checker skip args', () => {
    const mappings = [
      ['check-command-count', '--skip-command-count'],
      ['check-session-config-parity', '--skip-session-config-parity'],
      ['check-vault-dir-parity', '--skip-vault-dir-parity'],
      ['check-generated-rule-staleness', '--skip-generated-rule-staleness'],
      ['check-rule-scoping', '--skip-rule-scoping'],
    ];
    for (const [configKey, skipArg] of mappings) {
      expect(drift).toContain(configKey);
      expect(drift).toContain(skipArg);
    }
  });
});

// ---------------------------------------------------------------------------
// D — Gate B (custom-phases mode:hard) is only AUGMENTED, block kept
// ---------------------------------------------------------------------------

describe('D — Gate B (Phase 2.5 custom-phases) keeps its operator contract', () => {
  const gateB = () => section(skill, '## Phase 2.5: Custom Phases', '## Phase 3: Documentation Updates');

  it('still BLOCKs on a hard-mode non-zero exit (operator-declared contract)', () => {
    expect(gateB()).toContain('BLOCK the close');
  });

  it('ADDS a warn + carryover escape-hatch option', () => {
    expect(gateB()).toContain('Warn + carryover and close');
  });
});

// ---------------------------------------------------------------------------
// E — Phase 0.6 skill-invocation self-report (C4)
// ---------------------------------------------------------------------------

describe('E — Phase 0.6 skill-invocation self-report emit (C4)', () => {
  it('has the Phase 0.6 heading', () => {
    expect(skill).toContain('## Phase 0.6: Skill-Invocation Self-Report');
  });

  it('emits via appendSkillInvocation with the session-end skill name and selected event', () => {
    expect(skill).toContain('appendSkillInvocation');
    expect(skill).toContain('scripts/lib/skill-invocations-schema.mjs');
    expect(skill).toContain("skill: 'session-orchestrator:session-end'");
    expect(skill).toContain("event: 'selected'");
  });

  it('is wrapped in a silent try/catch so it never blocks the close', () => {
    const s = section(skill, '## Phase 0.6', '## Phase 1:');
    expect(s).toContain('try {');
    expect(s).toContain('} catch');
  });
});
