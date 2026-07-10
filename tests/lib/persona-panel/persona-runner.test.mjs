/**
 * tests/lib/persona-panel/persona-runner.test.mjs
 *
 * Vitest tests for scripts/lib/persona-panel/persona-runner.mjs (issue #457).
 *
 * Two surfaces under test:
 *   1. buildPersonaPrompt — pure string composer with prompt-injection delimiter.
 *   2. computePromptHash — deterministic, canonicalised sha256 prefix for #459 trend tracking.
 *   3. validatePersonaOutput — async AJV pipeline; uses _clearCompileCache between tests.
 *
 * Test list (11 tests):
 *   buildPersonaPrompt:
 *     1. Wraps evaluation_criteria inside <persona-criteria> … </persona-criteria>
 *     2. Includes target name + content under <target-content> marker
 *     3. Length-cap reminder line references the 4000-char rationale limit
 *   computePromptHash:
 *     4. Same persona spec → same hash (deterministic)
 *     5. Different YAML key order → SAME hash (sorted-key canonicalisation, #459)
 *     6. CRLF body → SAME hash as LF body (LF-normalisation)
 *     7. Different model field → different hash
 *     8. Hash is exactly 16 lowercase hex chars
 *   validatePersonaOutput (no AJV mock needed — real ajv-loader on shipped persona schema):
 *     9. Valid trailing ```json with schema-conformant payload → {ok:true, mode:'validated', value}
 *    10. No fenced json block → {ok:false, mode:'parse-error'}
 *    11. JSON parses but fails schema → {ok:false, mode:'validation-failed'}
 *
 * Falsification check: each test asserts on an observable contract output.
 * Removing the buildPersonaPrompt / computePromptHash / validatePersonaOutput
 * bodies causes assertion failure.
 *
 * Sidecar-write coverage (#492 L3): persona-runner.mjs has NO sidecar-write
 * responsibility — it only builds prompts, hashes them, and validates Agent
 * output. The sidecar-write integration (writeJsonAtomic roundtrip,
 * validator-before-write, no-tmp-leak, concurrent-write, AJV schema validation)
 * is a REAL integration test in tests/lib/persona-panel/sidecar-roundtrip.test.mjs
 * (Tests 1-9), not a docs-grep. The only docs-grep canary is Test 10 there
 * (Q1-LOW-6, SKILL.md mentions validatePathInsideProject). The #492 L3 gap is
 * therefore already closed in sidecar-roundtrip.test.mjs — no assertion is
 * duplicated here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildPersonaPrompt,
  computePromptHash,
  validatePersonaOutput,
  _clearCompileCache,
  _MAX_RATIONALE_CHARS,
} from '../../../scripts/lib/persona-panel/persona-runner.mjs';

// ---------------------------------------------------------------------------
// Reset AJV compile cache between tests (mirrors agent-output-schema pattern)
// ---------------------------------------------------------------------------

beforeEach(() => {
  _clearCompileCache();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const samplePersona = {
  name: 'sample-persona',
  role: 'Domain expert under test',
  tier: 'domain-expert',
  evaluation_criteria: [
    'First criterion to check.',
    'Second criterion: clarity.',
  ],
  output_contract: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail', 'warn'] },
      rationale: { type: 'string' },
    },
    required: ['verdict', 'rationale'],
    additionalProperties: false,
  },
};

const sampleTarget = { name: 'sample-target.md', kind: 'markdown' };

// ---------------------------------------------------------------------------
// _MAX_RATIONALE_CHARS sanity pin
// ---------------------------------------------------------------------------

describe('_MAX_RATIONALE_CHARS', () => {
  it('is exactly 4096 (aligned with sidecar.schema.json rationale.maxLength per #483 LOW-1)', () => {
    expect(_MAX_RATIONALE_CHARS).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// buildPersonaPrompt
// ---------------------------------------------------------------------------

describe('buildPersonaPrompt', () => {
  it('wraps evaluation_criteria inside <persona-criteria> ... </persona-criteria> delimiters (security M1)', () => {
    const prompt = buildPersonaPrompt(samplePersona, sampleTarget, 'body');
    expect(prompt).toContain('<persona-criteria>');
    expect(prompt).toContain('</persona-criteria>');
    // The criterion strings appear inside (not just the tags).
    expect(prompt).toContain('First criterion to check.');
    expect(prompt).toContain('Second criterion: clarity.');
    // Opening tag precedes the criteria; closing tag follows them.
    const open = prompt.indexOf('<persona-criteria>');
    const close = prompt.indexOf('</persona-criteria>');
    const firstCriterionAt = prompt.indexOf('First criterion to check.');
    expect(open).toBeLessThan(firstCriterionAt);
    expect(firstCriterionAt).toBeLessThan(close);
  });

  it('includes target name verbatim and wraps target content in <target-content> markers', () => {
    const targetContent = 'Some markdown body to evaluate.';
    const prompt = buildPersonaPrompt(samplePersona, sampleTarget, targetContent);
    expect(prompt).toContain('Target: sample-target.md');
    expect(prompt).toContain('<target-content>');
    expect(prompt).toContain('</target-content>');
    expect(prompt).toContain(targetContent);
  });

  it('mentions the 4000-character rationale limit somewhere in the output-shape hint', () => {
    const prompt = buildPersonaPrompt(samplePersona, sampleTarget, '');
    expect(prompt).toContain('4000');
  });
});

// ---------------------------------------------------------------------------
// buildPersonaPrompt — groundingMode (#730 Epic H — Grounding-Review-Variante)
// ---------------------------------------------------------------------------

describe('buildPersonaPrompt — groundingMode', () => {
  it('defaults to "off": the 4-arg call with no groundingMode is byte-identical to the 3-arg call', () => {
    const targetContent = 'Some markdown body to evaluate.';
    const threeArg = buildPersonaPrompt(samplePersona, sampleTarget, targetContent);
    const fourArgOff = buildPersonaPrompt(samplePersona, sampleTarget, targetContent, 'off');
    expect(fourArgOff).toBe(threeArg);
    expect(threeArg).not.toContain('<grounding-instruction>');
  });

  it('inserts a <grounding-instruction> block with the re-derive/derived_sources instruction when groundingMode is "re-derive"', () => {
    const targetContent = 'Some markdown body to evaluate.';
    const prompt = buildPersonaPrompt(samplePersona, sampleTarget, targetContent, 're-derive');

    expect(prompt).toContain('<grounding-instruction>');
    expect(prompt).toContain('</grounding-instruction>');
    expect(prompt).toContain('derived_sources');
    expect(prompt).toContain('Read/Grep/Glob');

    // The grounding block must precede the <target-content> OPENING TAG line
    // (instructs BEFORE the agent reads the target, per #730 Epic H spec). The
    // literal string "<target-content>" also appears earlier, inline, inside the
    // intro sentence ("...content inside <target-content>;") — searching for the
    // tag on its own line disambiguates the real block boundary from that mention.
    const groundingAt = prompt.indexOf('<grounding-instruction>');
    const targetContentTagAt = prompt.indexOf('\n<target-content>\n');
    expect(groundingAt).toBeGreaterThan(-1);
    expect(targetContentTagAt).toBeGreaterThan(-1);
    expect(groundingAt).toBeLessThan(targetContentTagAt);
  });

  it('throws a descriptive Error for an unrecognised groundingMode value (fail-fast, mirrors threshold.mjs enum idiom)', () => {
    expect(() => buildPersonaPrompt(samplePersona, sampleTarget, 'body', 'bogus-mode')).toThrow(
      /groundingMode must be one of/,
    );
  });
});

// ---------------------------------------------------------------------------
// computePromptHash
// ---------------------------------------------------------------------------

describe('computePromptHash', () => {
  it('returns the same hash for two structurally identical persona specs (deterministic)', () => {
    const raw = {
      frontmatter: { name: 'p', schema_version: 1, model: 'claude-opus-4-7' },
      body: 'Body line 1\nBody line 2\n',
      model: 'claude-opus-4-7',
    };
    expect(computePromptHash(raw)).toBe(computePromptHash(raw));
  });

  it('returns the SAME hash when frontmatter keys are in different YAML order (sorted-key canonicalisation, #459)', () => {
    const a = {
      frontmatter: { name: 'p', schema_version: 1, model: 'claude-opus-4-7' },
      body: 'Body.\n',
      model: 'claude-opus-4-7',
    };
    const b = {
      // Same keys, different declaration order
      frontmatter: { model: 'claude-opus-4-7', schema_version: 1, name: 'p' },
      body: 'Body.\n',
      model: 'claude-opus-4-7',
    };
    expect(computePromptHash(a)).toBe(computePromptHash(b));
  });

  it('returns the SAME hash for CRLF body and LF body (LF-normalisation)', () => {
    const lf = {
      frontmatter: { name: 'p' },
      body: 'Line one\nLine two\nLine three\n',
      model: 'claude-opus-4-7',
    };
    const crlf = {
      frontmatter: { name: 'p' },
      body: 'Line one\r\nLine two\r\nLine three\r\n',
      model: 'claude-opus-4-7',
    };
    expect(computePromptHash(lf)).toBe(computePromptHash(crlf));
  });

  it('returns a DIFFERENT hash when only the model field changes (model-pin drift detection)', () => {
    const a = {
      frontmatter: { name: 'p' },
      body: 'Body.\n',
      model: 'claude-opus-4-7',
    };
    const b = {
      frontmatter: { name: 'p' },
      body: 'Body.\n',
      model: 'claude-sonnet-4-6',
    };
    expect(computePromptHash(a)).not.toBe(computePromptHash(b));
  });

  it('returns a 16-character lowercase hex string', () => {
    const hash = computePromptHash({
      frontmatter: { name: 'p' },
      body: 'Body.\n',
      model: 'claude-opus-4-7',
    });
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// validatePersonaOutput
// ---------------------------------------------------------------------------

describe('validatePersonaOutput', () => {
  it('returns {ok:true, mode:"validated", value} when JSON parses and conforms to the persona output_contract', async () => {
    const agentOutput = [
      'Some reasoning prose.',
      '',
      '```json',
      '{"verdict": "pass", "rationale": "everything checked out"}',
      '```',
    ].join('\n');

    const result = await validatePersonaOutput(samplePersona, agentOutput);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
    expect(result.value).toEqual({
      verdict: 'pass',
      rationale: 'everything checked out',
    });
  });

  it('returns {ok:false, mode:"parse-error"} when no fenced ```json block is present', async () => {
    const agentOutput = 'Just plain prose with no fenced JSON at all.';

    const result = await validatePersonaOutput(samplePersona, agentOutput);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('parse-error');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns {ok:false, mode:"validation-failed", errors:[...]} when JSON parses but fails the output_contract schema', async () => {
    // verdict "MAYBE" is not in the enum, and "rationale" is missing.
    const agentOutput = [
      'Reasoning.',
      '```json',
      '{"verdict": "MAYBE"}',
      '```',
    ].join('\n');

    const result = await validatePersonaOutput(samplePersona, agentOutput);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validation-failed');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
