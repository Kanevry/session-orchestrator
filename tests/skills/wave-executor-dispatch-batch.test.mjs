/**
 * tests/skills/wave-executor-dispatch-batch.test.mjs
 *
 * Regression-guard tests for the #724 small-batch dispatch default + fail-loud
 * Dispatch Verification protocol. Fleet evidence (conf 1.0, 5 sessions) showed
 * large single-message multi-dispatch drops Agent() calls SILENTLY; the repo now
 * mandates small batches of 3–4 calls per message + a post-dispatch verification.
 *
 * These are content-presence / content-absence assertions against the LIVE skill
 * and doc files — they fail if the contract wording is removed or silently
 * reverted to the old single-message mandate. No subprocess spawning, no mocks
 * (per .claude/rules/testing.md: hardcoded literals, behaviour = "the contract
 * text is present / the reverted text is absent", so a real regression turns them
 * red — see the fake-regression note at the bottom of this file).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WAVE_LOOP_MD = join(REPO_ROOT, 'skills/wave-executor/wave-loop.md');
const SKILL_MD = join(REPO_ROOT, 'skills/wave-executor/SKILL.md');
const CONFIG_REF_MD = join(REPO_ROOT, 'docs/session-config-reference.md');
const SESSION_PLAN_MD = join(REPO_ROOT, 'skills/session-plan/SKILL.md');

let waveLoop;
let skill;
let configRef;
let sessionPlan;

/**
 * Extract the §1 "Dispatch Agents" core block — from the "### 1. Dispatch Agents"
 * heading up to (but excluding) the "#### Dispatch Verification" subheading. This
 * is the narrow window where the OLD single-message mandate lived, so the absence
 * assertion (b) is scoped here rather than to the whole file (the file legitimately
 * mentions "single-message fan-out" elsewhere as a negation).
 */
function dispatchCoreBlock(text) {
  const start = text.indexOf('### 1. Dispatch Agents');
  const end = text.indexOf('#### Dispatch Verification');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('could not locate §1 Dispatch core block boundaries in wave-loop.md');
  }
  return text.slice(start, end);
}

beforeAll(() => {
  waveLoop = readFileSync(WAVE_LOOP_MD, 'utf8');
  skill = readFileSync(SKILL_MD, 'utf8');
  configRef = readFileSync(CONFIG_REF_MD, 'utf8');
  sessionPlan = readFileSync(SESSION_PLAN_MD, 'utf8');
});

// ── (a) Small-batch default anchored in wave-loop.md §1 ──────────────────────

describe('#724 small-batch dispatch default (wave-loop.md §1)', () => {
  it('mandates SMALL BATCHES of 3–4 Agent() calls per message', () => {
    // The load-bearing default. If the batch-size wording is removed, coordinators
    // revert to large single-message fan-outs and the silent-drop class returns.
    expect(waveLoop).toContain('SMALL BATCHES');
    expect(waveLoop).toMatch(/SMALL BATCHES of 3.4 Agent\(\) calls per message/);
  });

  it('FORBIDS large single-message fan-outs (>4) with the conf-1.0 rationale', () => {
    // The prohibition + evidence citation is the "why" the default exists. Both
    // the FORBIDDEN marker and the conf-1.0 evidence must survive edits.
    expect(waveLoop).toMatch(/fan-outs \(>4 Agent\(\) calls in one message\) are \*\*FORBIDDEN\*\*/);
    expect(waveLoop).toContain('conf 1.0, 5 sessions');
    expect(waveLoop).toContain('drop Agent() calls SILENTLY');
  });

  it('cites the fleet-mining spec for the policy rationale', () => {
    expect(waveLoop).toContain('docs/specs/2026-07-02-fleet-mining-followup-grill.md');
  });
});

// ── (b) Old single-message mandate is GONE from the dispatch core block ──────

describe('#724 old single-message mandate removed (scoped to §1 dispatch core)', () => {
  it('has no "IN PARALLEL in a SINGLE message" mandate in the dispatch core block', () => {
    const core = dispatchCoreBlock(waveLoop);
    // Absence guard: the former mandate string must not survive anywhere in the
    // core dispatch instructions. A revert would re-introduce this exact phrasing.
    expect(core).not.toMatch(/IN PARALLEL in a SINGLE message/i);
    expect(core).not.toMatch(/dispatch all agents for this wave IN PARALLEL/i);
  });

  it('has no bare "in a SINGLE message" imperative in the dispatch core block', () => {
    const core = dispatchCoreBlock(waveLoop);
    // The uppercase-SINGLE mandate wording specifically; the negated lowercase
    // "single-message fan-out" mention lives OUTSIDE this block (run_in_background
    // paragraph) and is intentionally allowed.
    expect(core).not.toContain('in a SINGLE message');
  });
});

// ── (c) Fail-loud Dispatch Verification step exists ─────────────────────────

describe('#724 Dispatch Verification (fail-loud) protocol', () => {
  it('has the Dispatch Verification heading in wave-loop.md', () => {
    expect(waveLoop).toMatch(/#### Dispatch Verification/);
  });

  it('counts received tool-results against the planned agent list', () => {
    // The core mechanic: compare planned vs received, re-dispatch missing only.
    expect(waveLoop).toContain('count the Agent tool-results received');
    expect(waveLoop).toContain('re-dispatch ONLY the missing agents');
  });

  it('records additive planned/started metrics fields', () => {
    // Additive wave-metrics fields — must appear both in the Verification step and
    // in the metrics-capture bullet so the two stay in sync.
    expect(waveLoop).toContain('agent_count_planned');
    expect(waveLoop).toContain('agent_count_started');
  });
});

// ── (d) Sync surfaces carry the new formulation (no "simultaneously") ────────

describe('#724 sync surfaces updated', () => {
  it('wave-executor/SKILL.md describes small-batch default (not simultaneous fan-out)', () => {
    expect(skill).toContain('small-batch');
    // The former backward-compat line claimed all agents "start simultaneously" —
    // that phrasing is now incorrect for the default and must be gone.
    expect(skill).not.toContain('all agents start simultaneously');
  });

  it('session-config-reference.md describes small-batch default (not single-message)', () => {
    expect(configRef).toContain('small-batch');
    expect(configRef).not.toContain('existing single-message parallel Agent() dispatch');
  });

  it('session-plan/SKILL.md template line uses small batches (not "simultaneously")', () => {
    // The plan template's "Parallel dispatch:" line must no longer promise
    // simultaneous execution — that trains coordinators toward the forbidden pattern.
    expect(sessionPlan).toContain('small batches of 3–4 per message');
    expect(sessionPlan).not.toContain('execute simultaneously via Agent() tool');
  });
});

// ── (e) C4 self-report emit snippet present ─────────────────────────────────

describe('#724 C4 wave-executor self-report emit', () => {
  it('emits a skill-invocation record via appendSkillInvocation', () => {
    expect(waveLoop).toContain('appendSkillInvocation');
    expect(waveLoop).toContain('scripts/lib/skill-invocations-schema.mjs');
  });

  it('records the wave-executor skill as a "selected" event', () => {
    expect(waveLoop).toContain("skill: 'session-orchestrator:wave-executor'");
    expect(waveLoop).toContain("event: 'selected'");
    expect(waveLoop).toContain('.orchestrator/metrics/skill-invocations.jsonl');
  });

  it('is best-effort (try/catch) so a write failure never blocks dispatch', () => {
    // The emit must be swallowed — a telemetry write failure must not abort a wave.
    expect(waveLoop).toMatch(/try \{[\s\S]*appendSkillInvocation[\s\S]*\} catch/);
  });
});

/*
 * Fake-regression rationale (.claude/rules/testing.md § Negative-Assertion
 * Fake-Regression Check): these are content contracts, not mocked behaviour.
 * Manually verified during authoring that reverting wave-loop.md line
 * "Use the **Agent tool** to dispatch this wave's agents in **SMALL BATCHES...**"
 * back to "…IN PARALLEL in a SINGLE message." turns (a) + (b) RED, and deleting
 * the "#### Dispatch Verification" block turns (c) RED. The absence guards in (b)
 * and (d) bite because a revert re-introduces the exact removed strings.
 */
