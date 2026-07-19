/**
 * bold-block-header-adoption.test.mjs — cross-parser regression for the shared
 * bold-tolerant `matchBlockHeader` adoption (#830).
 *
 * Two guarantees per representative parser in the subset:
 *   1. BOLD-HEADER regression: a bold-bullet `- **<key>:**` header ENTERS the
 *      block (pre-#830 the strict `/^<key>:\s*$/` silently missed it → defaults).
 *      Each case sets a NON-default value that only surfaces if the block is
 *      entered, so the assertion bites.
 *   2. NEGATIVE-LOCK: a header line carrying an INLINE COMMENT still fails the
 *      match → the whole block is skipped → all-defaults (the documented
 *      custom-phases / eval gotcha stays broken-by-design).
 *
 * Plus the indent-anchored nested sub-block guard (memory) which is DELIBERATELY
 * NOT bold-tolerant and must keep requiring the plain `  <sub>:` form.
 *
 * In-process only (PSA-006 / validate-config-exit-code learning): every assertion
 * calls the parser directly, never a CLI exit code. Expected values are literals.
 */

import { describe, it, expect } from 'vitest';
import { _parseConfigProtection } from '@lib/config/config-protection.mjs';
import { _parseCustomPhases } from '@lib/config/custom-phases.mjs';
import { _parseEval } from '@lib/config/eval.mjs';
import { _parseMemory } from '@lib/config/memory.mjs';
import { _parseEvolve, _parseEvolveDecay } from '@lib/config/evolve.mjs';
import { _parseWaveReviewers } from '@lib/config/wave-reviewers.mjs';
import { _parsePersonaGateWave } from '@lib/config/persona-gate-wave.mjs';

// ---------------------------------------------------------------------------
// config-protection — block-header parser fn (NOT the dead allow-config line)
// ---------------------------------------------------------------------------

describe('config-protection bold-header adoption', () => {
  it('enters the block via a bold-bullet header (non-default enabled/mode surface)', () => {
    const content = ['- **config-protection:**', '  enabled: false', '  mode: strict', ''].join('\n');
    expect(_parseConfigProtection(content)).toEqual({ enabled: false, mode: 'strict' });
  });

  it('negative-lock: inline comment on the header line yields all-defaults', () => {
    const content = ['config-protection:  # note', '  enabled: false', '  mode: strict', ''].join('\n');
    expect(_parseConfigProtection(content)).toEqual({ enabled: true, mode: 'warn' });
  });
});

// ---------------------------------------------------------------------------
// custom-phases — list block
// ---------------------------------------------------------------------------

describe('custom-phases bold-header adoption', () => {
  it('enters the list block via a bold-bullet header and parses one record', () => {
    const content = [
      '- **custom-phases:**',
      '  - name: archive-x',
      '    command: node scripts/x.mjs',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([
      { name: 'archive-x', when: 'session-end', command: 'node scripts/x.mjs', mode: 'warn', review: null },
    ]);
  });

  it('negative-lock: inline comment on the header line yields an empty list', () => {
    const content = [
      'custom-phases:  # opt-in phases',
      '  - name: archive-x',
      '    command: node scripts/x.mjs',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// eval — scalar block
// ---------------------------------------------------------------------------

describe('eval bold-header adoption', () => {
  it('enters the block via a bold-bullet header (non-default fields surface)', () => {
    const content = ['- **eval:**', '  enabled: true', '  judge: haiku', ''].join('\n');
    expect(_parseEval(content)).toEqual({
      enabled: true,
      mode: 'warn',
      judge: 'haiku',
      report: 'html',
      handle: null,
    });
  });

  it('negative-lock: inline comment on the header line yields all-defaults', () => {
    const content = ['eval:  # opt-in', '  enabled: true', '  judge: haiku', ''].join('\n');
    expect(_parseEval(content)).toEqual({
      enabled: false,
      mode: 'warn',
      judge: 'off',
      report: 'html',
      handle: null,
    });
  });
});

// ---------------------------------------------------------------------------
// memory — top-level bold tolerance + indent-anchored nested sub-blocks stay plain
// ---------------------------------------------------------------------------

describe('memory bold-header adoption', () => {
  it('enters the top-level block via a bold-bullet header; plain nested sub-block parses', () => {
    const content = ['- **memory:**', '  proposals:', '    quota-per-wave: 9', ''].join('\n');
    expect(_parseMemory(content).proposals['quota-per-wave']).toBe(9);
  });

  it('nested sub-block header is NOT bold-tolerant — a bold `proposals:` is ignored, quota stays default', () => {
    // The nested `proposals:` detection is indent-anchored (`/^\s{2}proposals:\s*$/`)
    // and deliberately NOT converted, so a bold nested header never enters the
    // sub-block and quota-per-wave keeps its default of 5.
    const content = ['memory:', '  **proposals:**', '    quota-per-wave: 9', ''].join('\n');
    expect(_parseMemory(content).proposals['quota-per-wave']).toBe(5);
  });

  it('negative-lock: inline comment on the top-level header yields all-defaults', () => {
    const content = ['memory:  # tuning', '  proposals:', '    quota-per-wave: 9', ''].join('\n');
    expect(_parseMemory(content)).toEqual({
      banner: { enabled: true },
      proposals: { enabled: true, 'quota-per-wave': 5, 'confidence-floor': 0.5 },
    });
  });
});

// ---------------------------------------------------------------------------
// evolve — BOTH sites (_parseEvolve line ~78, _parseEvolveDecay line ~262)
// ---------------------------------------------------------------------------

describe('evolve bold-header adoption — both parser sites', () => {
  it('_parseEvolve enters the block via a bold-bullet header and parses one extra-source', () => {
    const content = [
      '- **evolve:**',
      '  extra-sources:',
      '    - path: eval/reports/latest.json',
      '',
    ].join('\n');
    expect(_parseEvolve(content)).toEqual([
      { path: 'eval/reports/latest.json', kind: 'regression-flags', 'learning-type': 'domain-regression' },
    ]);
  });

  it('_parseEvolveDecay enters the block via a bold-bullet header (non-default half-life surfaces)', () => {
    const content = ['- **evolve:**', '  decay-half-life-days: 45', ''].join('\n');
    expect(_parseEvolveDecay(content)['half-life-days']).toBe(45);
  });

  it('negative-lock: inline comment on the header line yields defaults for both sites', () => {
    const content = [
      'evolve:  # extra sources',
      '  extra-sources:',
      '    - path: eval/reports/latest.json',
      '  decay-half-life-days: 45',
      '',
    ].join('\n');
    expect(_parseEvolve(content)).toEqual([]);
    expect(_parseEvolveDecay(content)).toEqual({ enabled: true, 'half-life-days': 90, 'floor-factor': 0.1 });
  });
});

// ---------------------------------------------------------------------------
// dynamic path — wave-reviewers + persona-gate-wave (was `new RegExp(\`^${key}:...\`)`)
// ---------------------------------------------------------------------------

describe('wave-reviewers bold-header adoption (dynamic-key path)', () => {
  it('enters the block via a bold-bullet header (non-default enabled/mode surface)', () => {
    const content = ['- **wave-reviewers:**', '  enabled: true', '  mode: strict', ''].join('\n');
    expect(_parseWaveReviewers(content)).toEqual({
      enabled: true,
      reviewers: [],
      mode: 'strict',
      deprecated: false,
    });
  });

  it('negative-lock: inline comment on the header line yields all-defaults', () => {
    const content = ['wave-reviewers:  # audits', '  enabled: true', '  mode: strict', ''].join('\n');
    expect(_parseWaveReviewers(content)).toEqual({
      enabled: false,
      reviewers: [],
      mode: 'warn',
      deprecated: false,
    });
  });
});

describe('persona-gate-wave bold-header adoption (dynamic-key path)', () => {
  it('enters the block via a bold-bullet header — returns a non-null object with enabled true', () => {
    const content = ['- **persona-gate-wave:**', '  enabled: true', ''].join('\n');
    const parsed = _parsePersonaGateWave(content);
    expect(parsed).not.toBeNull();
    expect(parsed.enabled).toBe(true);
  });

  it('negative-lock: inline comment on the header line leaves the block absent (null)', () => {
    const content = ['persona-gate-wave:  # opt-in', '  enabled: true', ''].join('\n');
    expect(_parsePersonaGateWave(content)).toBeNull();
  });
});
