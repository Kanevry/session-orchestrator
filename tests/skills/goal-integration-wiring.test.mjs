import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

const sessionEndSkill = readFileSync(
  path.join(repoRoot, 'skills', 'session-end', 'SKILL.md'),
  'utf8',
);
const planVerification = readFileSync(
  path.join(repoRoot, 'skills', 'session-end', 'plan-verification.md'),
  'utf8',
);
const waveLoopMd = readFileSync(
  path.join(repoRoot, 'skills', 'wave-executor', 'wave-loop.md'),
  'utf8',
);
const waveExecutorSkill = readFileSync(
  path.join(repoRoot, 'skills', 'wave-executor', 'SKILL.md'),
  'utf8',
);
const configTemplate = readFileSync(
  path.join(repoRoot, 'docs', 'session-config-template.md'),
  'utf8',
);
const claudeMd = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');

// --- Section extraction (scoped assertions per seam) -------------------------

// Seam A: session-end SKILL.md §1.3a — between "### 1.3a" and the next "### 1.4".
const seamAMatch = sessionEndSkill.match(
  /### 1\.3a Optional \/goal Backlog-Drain[\s\S]+?(?=\n### 1\.4)/,
);
const seamA = seamAMatch ? seamAMatch[0] : '';

// Seam B: wave-loop.md ##### /goal Continuation Anchor — between the "#####"
// heading and the next "##### STATE.md Deviation" heading.
const seamBMatch = waveLoopMd.match(
  /##### \/goal Continuation Anchor[\s\S]+?(?=\n##### STATE\.md Deviation)/,
);
const seamB = seamBMatch ? seamBMatch[0] : '';

describe('goal-integration wiring (Lever 5 / #636)', () => {
  // --- Seam A: session-end SKILL.md §1.3a -----------------------------------
  describe('Seam A — skills/session-end/SKILL.md §1.3a Backlog-Drain', () => {
    it('the §1.3a section exists and is non-trivial', () => {
      expect(seamAMatch).toBeTruthy();
      expect(seamA.length).toBeGreaterThan(200);
    });

    it('the section regex does NOT match a body that lacks the §1.3a heading', () => {
      // Falsifiability: the extractor must be specific to the real heading, not
      // any "### 1.x" section. A mutated copy with §1.3a removed must not match.
      const mutated = sessionEndSkill.replace(
        '### 1.3a Optional /goal Backlog-Drain',
        '### 1.3a Removed Heading',
      );
      const mutatedMatch = mutated.match(
        /### 1\.3a Optional \/goal Backlog-Drain[\s\S]+?(?=\n### 1\.4)/,
      );
      expect(mutatedMatch).toBeNull();
    });

    it('§1.3a appears AFTER §1.3 Not Started and BEFORE §1.4 Emergent Work', () => {
      const pos13 = sessionEndSkill.indexOf('### 1.3 Not Started Items');
      const pos13a = sessionEndSkill.indexOf(
        '### 1.3a Optional /goal Backlog-Drain',
      );
      const pos14 = sessionEndSkill.indexOf(
        '### 1.4 Emergent Work',
        pos13a,
      );
      expect(pos13).toBeGreaterThan(-1);
      expect(pos13a).toBeGreaterThan(pos13);
      expect(pos14).toBeGreaterThan(pos13a);
    });

    it('gates on goal-integration.enabled: true', () => {
      expect(seamA).toContain('goal-integration.enabled: true');
    });

    it('names the session-end-backlog seam', () => {
      expect(seamA).toContain('session-end-backlog');
    });

    it('cross-references LM-008 for the continuation-vs-judgment contract', () => {
      expect(seamA).toContain('LM-008');
    });

    it('states the one-goal-per-session constraint', () => {
      expect(seamA).toMatch(/[Oo]ne goal per session/);
    });

    it('is advisory-only — never auto-invokes /goal and never blocks the close', () => {
      expect(seamA).toMatch(/never auto-invokes? `?\/goal`?/);
      expect(seamA).toMatch(/never blocks? the close/);
    });

    it('dispatches no agents and raises no AskUserQuestion on this step', () => {
      expect(seamA).not.toMatch(/Agent\(\{/);
      expect(seamA).toMatch(/raises no AskUserQuestion/);
    });

    it('the suggested /goal condition embeds a bound ("or stop after")', () => {
      expect(seamA).toContain('or stop after');
    });
  });

  // --- Seam A mirror: plan-verification.md ----------------------------------
  describe('Seam A mirror — skills/session-end/plan-verification.md', () => {
    it('references §1.3a', () => {
      expect(planVerification).toContain('### 1.3a');
    });

    it('points back to SKILL.md §1.3a as the canonical prose location', () => {
      expect(planVerification).toMatch(
        /SKILL\.md § 1\.3a Optional \/goal Backlog-Drain/,
      );
    });

    it('names the session-end-backlog seam in the mirror pointer', () => {
      expect(planVerification).toContain('session-end-backlog');
    });
  });

  // --- Seam B: wave-loop.md /goal Continuation Anchor -----------------------
  describe('Seam B — skills/wave-executor/wave-loop.md /goal Continuation Anchor', () => {
    it('the Continuation Anchor subsection exists and is non-trivial', () => {
      expect(seamBMatch).toBeTruthy();
      expect(seamB.length).toBeGreaterThan(200);
    });

    it('the section regex does NOT match a body that lacks the anchor heading', () => {
      // Falsifiability: a mutated copy with the anchor heading removed must not match.
      const mutated = waveLoopMd.replace(
        '##### /goal Continuation Anchor',
        '##### Removed Anchor Heading',
      );
      const mutatedMatch = mutated.match(
        /##### \/goal Continuation Anchor[\s\S]+?(?=\n##### STATE\.md Deviation)/,
      );
      expect(mutatedMatch).toBeNull();
    });

    it('appears AFTER #### Auto-Fix Protocol (#521) and BEFORE ##### STATE.md Deviation', () => {
      const posAutoFix = waveLoopMd.indexOf('#### Auto-Fix Protocol (#521)');
      const posAnchor = waveLoopMd.indexOf('##### /goal Continuation Anchor');
      const posDeviation = waveLoopMd.indexOf(
        '##### STATE.md Deviation',
        posAnchor,
      );
      expect(posAutoFix).toBeGreaterThan(-1);
      expect(posAnchor).toBeGreaterThan(posAutoFix);
      expect(posDeviation).toBeGreaterThan(posAnchor);
    });

    it('gates on goal-integration.enabled: true', () => {
      expect(seamB).toContain('goal-integration.enabled: true');
    });

    it('names the inter-wave-fixloop seam', () => {
      expect(seamB).toContain('inter-wave-fixloop');
    });

    it('cross-references LM-008 for the continuation-vs-judgment contract', () => {
      expect(seamB).toContain('LM-008');
    });

    it('states that the hard-abort / diagnostics-bundle path is UNCHANGED', () => {
      expect(seamB).toMatch(/hard-abort.*diagnostics-bundle path.*UNCHANGED/i);
      expect(seamB).toContain('verification-failures');
    });

    it('is advisory-only — never auto-invokes /goal and never blocks progress', () => {
      expect(seamB).toMatch(/never auto-invokes? `?\/goal`?/i);
      expect(seamB).toMatch(/never blocks? forward progress/);
    });

    it('dispatches no agents and raises no AskUserQuestion on this step', () => {
      expect(seamB).not.toMatch(/Agent\(\{/);
      expect(seamB).toMatch(/no AskUserQuestion/);
    });

    it('the suggested /goal condition embeds a bound ("or stop after")', () => {
      expect(seamB).toContain('or stop after');
    });
  });

  // --- Seam B pointer: wave-executor SKILL.md -------------------------------
  describe('Seam B pointer — skills/wave-executor/SKILL.md', () => {
    it('references the /goal Continuation Anchor', () => {
      expect(waveExecutorSkill).toContain('/goal Continuation Anchor');
    });

    it('points to wave-loop.md as the canonical anchor location', () => {
      expect(waveExecutorSkill).toMatch(
        /wave-loop\.md.*\/goal Continuation Anchor/,
      );
    });

    it('names the inter-wave-fixloop seam in the pointer', () => {
      expect(waveExecutorSkill).toContain('inter-wave-fixloop');
    });
  });

  // --- Parity: session-config-template.md ------------------------------------
  describe('Parity — docs/session-config-template.md goal-integration block', () => {
    it('contains a top-level goal-integration: key', () => {
      expect(configTemplate).toMatch(/^goal-integration:/m);
    });

    it('defaults enabled to false', () => {
      expect(configTemplate).toMatch(/goal-integration:[\s\S]*?enabled: false/);
    });

    it('the FIRST enabled: line under goal-integration is false', () => {
      // Q4 gap: the loose [\s\S]*? regex above would still pass if the block
      // said `enabled: true` followed by a stray trailing `enabled: false`.
      const block = configTemplate.match(/^goal-integration:\n(?:[ \t]+.*\n?)+/m)[0];
      expect(block.match(/enabled:\s*(\w+)/)[1]).toBe('false');
    });

    it('lists exactly the two seam names in the seams: list', () => {
      expect(configTemplate).toContain(
        'seams: [session-end-backlog, inter-wave-fixloop]',
      );
    });
  });

  // --- Parity: CLAUDE.md -----------------------------------------------------
  describe('Parity — CLAUDE.md Session Config goal-integration block', () => {
    it('contains a top-level goal-integration: key', () => {
      expect(claudeMd).toMatch(/^goal-integration:/m);
    });

    it('defaults enabled to false', () => {
      expect(claudeMd).toMatch(/goal-integration:[\s\S]*?enabled: false/);
    });

    it('the FIRST enabled: line under goal-integration is false', () => {
      // Q4 gap: see the template variant above — guards the default-off contract.
      const block = claudeMd.match(/^goal-integration:\n(?:[ \t]+.*\n?)+/m)[0];
      expect(block.match(/enabled:\s*(\w+)/)[1]).toBe('false');
    });

    it('lists exactly the two seam names in the seams: list', () => {
      expect(claudeMd).toContain(
        'seams: [session-end-backlog, inter-wave-fixloop]',
      );
    });
  });
});
