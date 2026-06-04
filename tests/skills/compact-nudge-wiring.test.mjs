import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const waveLoopMd = readFileSync(
  path.join(repoRoot, 'skills', 'wave-executor', 'wave-loop.md'),
  'utf8',
);

// Extract the §3c section for scoped assertions
const section3cMatch = waveLoopMd.match(
  /### 3c\. Strategic Compact-Nudge[\s\S]+?(?=\n### 4\.)/,
);

describe('skills/wave-executor/wave-loop.md — §3c Strategic Compact-Nudge (#620)', () => {
  it('§3c subsection exists and is non-empty', () => {
    expect(section3cMatch).toBeTruthy();
    expect(section3cMatch[0].length).toBeGreaterThan(200);
  });

  it('§3c appears AFTER §3b and BEFORE §4 in the document', () => {
    const pos3b = waveLoopMd.indexOf('### 3b. Persona-Gate Hook');
    const pos3c = waveLoopMd.indexOf('### 3c. Strategic Compact-Nudge');
    // Find the first occurrence of "### 4. Progress Update" that comes AFTER §3c
    const pos4 = waveLoopMd.indexOf('### 4. Progress Update', pos3c);
    expect(pos3b).toBeGreaterThan(-1);
    expect(pos3c).toBeGreaterThan(pos3b);
    expect(pos4).toBeGreaterThan(pos3c);
  });

  describe('Gate conditions', () => {
    it('gates on compact-nudge.enabled: true', () => {
      expect(section3cMatch[0]).toMatch(/compact-nudge\.enabled:\s*true/);
    });

    it('gates on compact-nudge.after list', () => {
      expect(section3cMatch[0]).toMatch(/compact-nudge\.after/);
    });

    it('gates on mode !== off', () => {
      expect(section3cMatch[0]).toMatch(/compact-nudge\.mode\s*!==\s*['"]off['"]/);
    });

    it('instructs to skip entirely when gate is false', () => {
      expect(section3cMatch[0]).toMatch(/skip this step entirely/);
    });
  });

  describe('Advisory-only contract', () => {
    it('states the nudge is advisory only — never auto-compacts', () => {
      expect(section3cMatch[0]).toMatch(/[Nn]ever auto-compact/);
    });

    it('coordinator/operator decides — step never dispatches agents', () => {
      expect(section3cMatch[0]).toMatch(/coordinator\/operator decides/i);
      // The step is advisory prose only — no Agent dispatch, no tool invocations
      expect(section3cMatch[0]).not.toMatch(/Agent\(\{/);
      expect(section3cMatch[0]).not.toMatch(/dispatch each/i);
    });

    it('no state-md write, no sidecar on this step', () => {
      expect(section3cMatch[0]).toMatch(/no.*state-md write.*no sidecar/i);
    });

    it('step never blocks forward progress', () => {
      expect(section3cMatch[0]).toMatch(/never blocks forward progress/);
    });
  });

  describe('Decision table', () => {
    it('contains the decision table header', () => {
      expect(section3cMatch[0]).toMatch(/Wave boundary.*completed.*next.*Compact\?/);
    });

    it('Discovery → Impl-Core row recommends Yes', () => {
      expect(section3cMatch[0]).toMatch(/Discovery.*Impl-Core.*Yes/);
    });

    it('Impl-Polish → Quality row recommends No', () => {
      expect(section3cMatch[0]).toMatch(/Impl-Polish.*Quality.*No/);
    });

    it('Quality → Finalization row recommends No', () => {
      expect(section3cMatch[0]).toMatch(/Quality.*Finalization.*No/);
    });

    it('mid-implementation row recommends No', () => {
      expect(section3cMatch[0]).toMatch(/[Mm]id-implementation.*No/);
    });

    it('failed/aborted wave row recommends Yes', () => {
      expect(section3cMatch[0]).toMatch(/FAILED.*aborted.*Yes/i);
    });

    it('unrelated task block row recommends Yes', () => {
      expect(section3cMatch[0]).toMatch(/unrelated task block.*Yes/i);
    });
  });

  describe('Survives vs lost table', () => {
    it('documents what survives compaction', () => {
      expect(section3cMatch[0]).toMatch(/CLAUDE\.md/);
      expect(section3cMatch[0]).toMatch(/STATE\.md/);
      expect(section3cMatch[0]).toMatch(/wave-scope\.json/);
    });

    it('documents what is lost', () => {
      expect(section3cMatch[0]).toMatch(/[Ll]ost/);
      expect(section3cMatch[0]).toMatch(/reasoning|tool-call history/);
    });
  });

  describe('Nudge format', () => {
    it('contains the advisory bullet template with /compact reference', () => {
      expect(section3cMatch[0]).toMatch(/consider \/compact/);
    });

    it('nudge bullet is explicitly labelled advisory only', () => {
      expect(section3cMatch[0]).toMatch(/advisory only/);
    });
  });
});
