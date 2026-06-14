/**
 * skill-evolution.test.mjs — Unit + integration tests for
 * scripts/lib/config/skill-evolution.mjs (Epic #643, issue #646 C1-config).
 *
 * Mirrors the style of tests/lib/config/auto-dream.test.mjs.
 *
 * Covers:
 *  - All defaults when block is absent or empty
 *  - Full valid block: all three keys parsed exactly
 *  - Each accepted autonomy enum value (off / advisory / autonomous-gated)
 *  - Invalid autonomy → falls back to 'off' without throwing (R3 safety-critical default-off)
 *  - evidence-floor out-of-range / non-numeric → falls back to 0.5
 *  - judge parsing: on/true → true; off/false/absent → false
 *  - Inline comment stripping, CRLF tolerance, quoted values, block-boundary detection
 *  - parseSessionConfig integration (3-edit wiring proof)
 *  - R2 parity invariant: `skill-evolution:` MUST NOT appear as a column-0 key
 *    inside the `## Session Config` block of docs/session-config-template.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { _parseSkillEvolution } from '@lib/config/skill-evolution.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

const DEFAULTS = {
  autonomy: 'off',
  'evidence-floor': 0.5,
  judge: false,
  'judge-budget-tokens': 8000,
};

// ---------------------------------------------------------------------------
// Unit: _parseSkillEvolution
// ---------------------------------------------------------------------------

describe('_parseSkillEvolution — defaults (block absent or empty)', () => {
  it('returns all defaults on empty string', () => {
    expect(_parseSkillEvolution('')).toEqual(DEFAULTS);
  });

  it('returns all defaults when the skill-evolution block is absent', () => {
    const content = 'persistence: true\nenforcement: warn\n';
    expect(_parseSkillEvolution(content)).toEqual(DEFAULTS);
  });

  it('returns all defaults when block is present but contains no key-value lines', () => {
    // Block header exists; all children are blank lines only.
    const content = 'skill-evolution:\n\n\nnext-section:\n';
    expect(_parseSkillEvolution(content)).toEqual(DEFAULTS);
  });
});

describe('_parseSkillEvolution — valid full block', () => {
  it('parses all three keys from a fully specified block', () => {
    const content = [
      'skill-evolution:',
      '  autonomy: autonomous-gated',
      '  evidence-floor: 0.8',
      '  judge: on',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content)).toEqual({
      autonomy: 'autonomous-gated',
      'evidence-floor': 0.8,
      judge: true,
      'judge-budget-tokens': 8000,
    });
  });
});

describe('_parseSkillEvolution — autonomy enum acceptance', () => {
  it('accepts autonomy: off', () => {
    const content = 'skill-evolution:\n  autonomy: off\n';
    expect(_parseSkillEvolution(content).autonomy).toBe('off');
  });

  it('accepts autonomy: advisory', () => {
    const content = 'skill-evolution:\n  autonomy: advisory\n';
    expect(_parseSkillEvolution(content).autonomy).toBe('advisory');
  });

  it('accepts autonomy: autonomous-gated', () => {
    const content = 'skill-evolution:\n  autonomy: autonomous-gated\n';
    expect(_parseSkillEvolution(content).autonomy).toBe('autonomous-gated');
  });

  it('normalises autonomy to lowercase before comparing (OFF → off)', () => {
    // The parser calls .toLowerCase() so "OFF" is identical to "off".
    const content = 'skill-evolution:\n  autonomy: OFF\n';
    expect(_parseSkillEvolution(content).autonomy).toBe('off');
  });
});

describe('_parseSkillEvolution — R3 safety-critical default-off invariant', () => {
  // R3: invalid autonomy values MUST fall back to 'off', never throw.
  // This is the safety-critical invariant that prevents an unknown value from
  // accidentally enabling autonomous edits.

  it('falls back to "off" when autonomy has an unknown value — never throws', () => {
    const content = 'skill-evolution:\n  autonomy: bogus\n';
    // Must not throw:
    const result = _parseSkillEvolution(content);
    expect(result.autonomy).toBe('off');
  });

  it('falls back to "off" when autonomy is empty', () => {
    const content = 'skill-evolution:\n  autonomy:\n';
    expect(_parseSkillEvolution(content).autonomy).toBe('off');
  });

  it('falls back to "off" when autonomy value is a partial match (e.g. "auto")', () => {
    // "auto" is not in the allowed list; must not be accepted as a prefix match.
    const content = 'skill-evolution:\n  autonomy: auto\n';
    expect(_parseSkillEvolution(content).autonomy).toBe('off');
  });
});

describe('_parseSkillEvolution — evidence-floor validation', () => {
  it('parses a valid mid-range value (0.8)', () => {
    const content = 'skill-evolution:\n  evidence-floor: 0.8\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.8);
  });

  it('accepts boundary low 0.0', () => {
    const content = 'skill-evolution:\n  evidence-floor: 0.0\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.0);
  });

  it('accepts integer 0 (boundary low as integer)', () => {
    const content = 'skill-evolution:\n  evidence-floor: 0\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0);
  });

  it('accepts boundary high 1.0', () => {
    const content = 'skill-evolution:\n  evidence-floor: 1.0\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(1.0);
  });

  it('accepts integer 1 (boundary high as integer)', () => {
    const content = 'skill-evolution:\n  evidence-floor: 1\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(1);
  });

  it('falls back to 0.5 when value is above 1.0', () => {
    const content = 'skill-evolution:\n  evidence-floor: 1.5\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.5);
  });

  it('falls back to 0.5 when value is negative (regex rejects leading "-")', () => {
    // The /^\d+(\.\d+)?$/ regex rejects a leading minus sign.
    const content = 'skill-evolution:\n  evidence-floor: -0.1\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.5);
  });

  it('falls back to 0.5 when value is non-numeric (string "high")', () => {
    const content = 'skill-evolution:\n  evidence-floor: high\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.5);
  });

  it('falls back to 0.5 when value is empty', () => {
    const content = 'skill-evolution:\n  evidence-floor:\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.5);
  });

  it('falls back to 0.5 for scientific notation (not matched by the regex)', () => {
    // "1e-1" == 0.1, but the parser regex /^\d+(\.\d+)?$/ excludes it.
    const content = 'skill-evolution:\n  evidence-floor: 1e-1\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.5);
  });
});

describe('_parseSkillEvolution — judge boolean parsing', () => {
  it('parses judge: on → true', () => {
    const content = 'skill-evolution:\n  judge: on\n';
    expect(_parseSkillEvolution(content).judge).toBe(true);
  });

  it('parses judge: true → true', () => {
    const content = 'skill-evolution:\n  judge: true\n';
    expect(_parseSkillEvolution(content).judge).toBe(true);
  });

  it('parses judge: off → false', () => {
    const content = 'skill-evolution:\n  judge: off\n';
    expect(_parseSkillEvolution(content).judge).toBe(false);
  });

  it('parses judge: false → false', () => {
    const content = 'skill-evolution:\n  judge: false\n';
    expect(_parseSkillEvolution(content).judge).toBe(false);
  });

  it('returns judge: false when judge key is absent from the block', () => {
    // Only autonomy and evidence-floor present; judge must default to false.
    const content = [
      'skill-evolution:',
      '  autonomy: advisory',
      '  evidence-floor: 0.7',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content).judge).toBe(false);
  });

  it('normalises ON (uppercase) → true', () => {
    const content = 'skill-evolution:\n  judge: ON\n';
    expect(_parseSkillEvolution(content).judge).toBe(true);
  });

  it('normalises TRUE (uppercase) → true', () => {
    const content = 'skill-evolution:\n  judge: TRUE\n';
    expect(_parseSkillEvolution(content).judge).toBe(true);
  });
});

describe('_parseSkillEvolution — inline comments, CRLF, and quoted values', () => {
  it('strips inline YAML comments before parsing autonomy', () => {
    const content = [
      'skill-evolution:',
      '  autonomy: advisory  # enable review mode',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content).autonomy).toBe('advisory');
  });

  it('strips inline YAML comments before parsing evidence-floor', () => {
    const content = [
      'skill-evolution:',
      '  evidence-floor: 0.75  # raise the bar',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.75);
  });

  it('strips inline YAML comments before parsing judge', () => {
    const content = [
      'skill-evolution:',
      '  judge: on  # opt-in LLM judge',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content).judge).toBe(true);
  });

  it('handles CRLF line endings correctly', () => {
    const content = 'skill-evolution:\r\n  autonomy: advisory\r\n  evidence-floor: 0.6\r\n  judge: on\r\n';
    expect(_parseSkillEvolution(content)).toEqual({
      autonomy: 'advisory',
      'evidence-floor': 0.6,
      judge: true,
      'judge-budget-tokens': 8000,
    });
  });

  it('strips double quotes from autonomy value', () => {
    const content = 'skill-evolution:\n  autonomy: "autonomous-gated"\n';
    expect(_parseSkillEvolution(content).autonomy).toBe('autonomous-gated');
  });

  it('strips single quotes from autonomy value', () => {
    const content = "skill-evolution:\n  autonomy: 'advisory'\n";
    expect(_parseSkillEvolution(content).autonomy).toBe('advisory');
  });

  it('strips double quotes from evidence-floor value', () => {
    const content = 'skill-evolution:\n  evidence-floor: "0.9"\n';
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.9);
  });
});

describe('_parseSkillEvolution — block boundary detection', () => {
  it('stops at the next column-0 non-indented key', () => {
    // `evidence-floor: 0.9` under `other-section:` must NOT leak into skill-evolution.
    const content = [
      'skill-evolution:',
      '  autonomy: advisory',
      '  evidence-floor: 0.3',
      'other-section:',
      '  evidence-floor: 0.9',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content)['evidence-floor']).toBe(0.3);
  });

  it('ignores skill-evolution-like text outside the block header', () => {
    const content = [
      'persistence: true',
      'enforcement: warn',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content)).toEqual(DEFAULTS);
  });

  it('does not match an indented skill-evolution: header (nested under another key)', () => {
    // Only column-0 `skill-evolution:` starts the block.
    const content = [
      'other:',
      '  skill-evolution:',
      '    autonomy: advisory',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content)).toEqual(DEFAULTS);
  });

  it('ignores unknown keys inside the block', () => {
    const content = [
      'skill-evolution:',
      '  unknown-key: foobar',
      '  autonomy: advisory',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content).autonomy).toBe('advisory');
  });

  it('reads keys that appear later in the block (all fields populated)', () => {
    // Verify all three parsed values survive when positioned at the end.
    const content = [
      'skill-evolution:',
      '  unknown-first: value',
      '  autonomy: autonomous-gated',
      '  evidence-floor: 0.95',
      '  judge: true',
      '',
    ].join('\n');
    expect(_parseSkillEvolution(content)).toEqual({
      autonomy: 'autonomous-gated',
      'evidence-floor': 0.95,
      judge: true,
      'judge-budget-tokens': 8000,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: parseSessionConfig wiring (3-edit proof)
// ---------------------------------------------------------------------------

describe('parseSessionConfig integration — skill-evolution wiring', () => {
  it('returns defaults when the skill-evolution block is absent', () => {
    const content = [
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      '',
    ].join('\n');
    const result = parseSessionConfig(content);
    // FALSIFICATION: if _parseSkillEvolution were not wired into config.mjs, or
    // the key were missing from the returned object, this would be undefined.
    expect(result['skill-evolution']).toEqual({
      autonomy: 'off',
      'evidence-floor': 0.5,
      judge: false,
      'judge-budget-tokens': 8000,
    });
  });

  it('surfaces parsed values when a full skill-evolution block is present', () => {
    const content = [
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      'skill-evolution:',
      '  autonomy: autonomous-gated',
      '  evidence-floor: 0.8',
      '  judge: on',
      '',
    ].join('\n');
    const result = parseSessionConfig(content);
    // FALSIFICATION: a bug in the 3-edit wiring (parse call, local variable, or
    // return-key) would leave autonomy as 'off' or the object absent.
    expect(result['skill-evolution']).toEqual({
      autonomy: 'autonomous-gated',
      'evidence-floor': 0.8,
      judge: true,
      'judge-budget-tokens': 8000,
    });
  });

  it('surfaces advisory mode with default evidence-floor and judge=false', () => {
    const content = [
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      'skill-evolution:',
      '  autonomy: advisory',
      '',
    ].join('\n');
    const result = parseSessionConfig(content);
    expect(result['skill-evolution']).toEqual({
      autonomy: 'advisory',
      'evidence-floor': 0.5,
      judge: false,
      'judge-budget-tokens': 8000,
    });
  });
});

// ---------------------------------------------------------------------------
// R2 parity invariant: `skill-evolution:` must NOT be a column-0 key inside
// the ## Session Config block of docs/session-config-template.md.
//
// Adding it there would cause portfolio-wide drift-check hard-fails on repos
// that have not yet adopted the feature. See Issue #646 and the "Parity-exempt
// section" notice in session-config-template.md.
// ---------------------------------------------------------------------------

describe('R2 parity invariant — session-config-template.md', () => {
  it('does not contain "skill-evolution:" as a column-0 key inside the ## Session Config block', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const templatePath = join(__dirname, '../../../docs/session-config-template.md');
    const templateContent = readFileSync(templatePath, 'utf8');

    const lines = templateContent.split(/\r?\n/);

    // Extract lines that are inside the ## Session Config block.
    // The block starts at the line matching /^## Session Config/ and ends at
    // the next H2 (^## ) that is NOT "## Session Config".
    let inBlock = false;
    const blockLines = [];
    for (const line of lines) {
      if (/^## Session Config/.test(line)) {
        inBlock = true;
        continue;
      }
      if (inBlock && /^## /.test(line)) {
        // Another H2 — block ends here.
        break;
      }
      if (inBlock) {
        blockLines.push(line);
      }
    }

    // Assert block was found (guards against template rename breaking the test).
    expect(blockLines.length).toBeGreaterThan(0);

    // No column-0 `skill-evolution:` key should appear inside the block.
    const violations = blockLines.filter(l => /^skill-evolution:/.test(l));
    // FALSIFICATION: if `skill-evolution:` were added as a column-0 key inside
    // the block, this assertion would fail — surfacing the portfolio-breakage risk
    // before it lands in a release.
    expect(violations).toHaveLength(0);
  });
});
