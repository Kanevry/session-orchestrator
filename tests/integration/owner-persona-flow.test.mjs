/**
 * tests/integration/owner-persona-flow.test.mjs
 *
 * End-to-end integration tests for the Owner Persona pipeline:
 *   D2 interview → owner.yaml write → D3 soul.md slot resolution.
 *
 * Modules under test:
 *   scripts/lib/owner-yaml.mjs    — loadOwnerConfig, writeOwnerConfig, validateOwnerConfig, getDefaults
 *   scripts/lib/owner-interview.mjs — getInterviewQuestions, applyInterviewAnswers, runOwnerInterview
 *   scripts/lib/soul-resolve.mjs  — resolveSoul, loadAndResolveSoul
 *
 * Isolation: every test uses a unique tmp dir under os.tmpdir().
 * Real ~/.config/session-orchestrator/owner.yaml is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { getDefaults, loadOwnerConfig, writeOwnerConfig, validateOwnerConfig } from '@lib/owner-yaml.mjs';
import { getInterviewQuestions, applyInterviewAnswers, runOwnerInterview } from '@lib/owner-interview.mjs';
import { resolveSoul, loadAndResolveSoul } from '@lib/soul-resolve.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute path to the real soul.md template used as the integration fixture. */
const SOUL_MD_PATH = join(
  new URL('../../skills/session-start/soul.md', import.meta.url).pathname,
);

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  // Use randomBytes to guarantee unique dir names across parallel runs
  const suffix = randomBytes(8).toString('hex');
  tmpDir = mkdtempSync(join(tmpdir(), `owner-persona-flow-${suffix}-`));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function ownerYamlPath() {
  return join(tmpDir, 'owner.yaml');
}

// ---------------------------------------------------------------------------
// Test 1: Default-fallback path
// No owner.yaml → loadAndResolveSoul resolves all known slots from getDefaults().
// ---------------------------------------------------------------------------

describe('Default-fallback path (no owner.yaml)', () => {
  it('resolves all {{slot}} references to defaults when no owner.yaml exists', () => {
    // Point ownerConfigPath at a path that does not exist inside our tmp dir
    const nonExistentCfg = join(tmpDir, 'nonexistent.yaml');
    const { resolved, source } = loadAndResolveSoul(SOUL_MD_PATH, { ownerConfigPath: nonExistentCfg });

    // Source should be 'defaults' because file does not exist
    expect(source).toBe('defaults');

    // No {{ }} placeholders should remain in the resolved output
    expect(resolved).not.toMatch(/\{\{/);

    // Default values from getDefaults() must appear in the resolved text
    const defaults = getDefaults();
    expect(resolved).toContain(defaults.tone.style);          // 'neutral'
    expect(resolved).toContain(defaults.efficiency['output-level']); // 'full'
    expect(resolved).toContain(defaults.efficiency.preamble); // 'minimal'
  });
});

// ---------------------------------------------------------------------------
// Test 2: Interview → write → load round-trip
// getInterviewQuestions returns 5 items; simulated answers produce correct field
// values (owner.name is left empty by design — bootstrap caller fills it in).
// The round-trip is exercised via writeOwnerConfig after supplying a name.
// ---------------------------------------------------------------------------

describe('Interview → write → load round-trip', () => {
  it('getInterviewQuestions returns exactly 5 question objects', () => {
    const questions = getInterviewQuestions();
    expect(questions).toHaveLength(5);
    for (const q of questions) {
      expect(typeof q.question).toBe('string');
      expect(typeof q.header).toBe('string');
      expect(Array.isArray(q.options)).toBe(true);
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(typeof q.multiSelect).toBe('boolean');
    }
  });

  it('applyInterviewAnswers fails validation because owner.name is empty (bootstrap fills name)', () => {
    // applyInterviewAnswers intentionally leaves owner.name='' — the bootstrap
    // caller sets the name after the interview. This test documents that contract.
    const tmpPath = ownerYamlPath();
    const result = applyInterviewAnswers(['de', 'direct', 'full', 'minimal', 'No'], { path: tmpPath });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.name'))).toBe(true);
    // File must NOT be created (validation blocked the write)
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('writeOwnerConfig + loadOwnerConfig round-trip preserves all interview-mapped field values', () => {
    const tmpPath = ownerYamlPath();

    // Simulate what the bootstrap does after interview: supply a name + the mapped fields
    const cfg = {
      owner: { name: 'TestUser', language: 'de' },
      tone: { style: 'direct', tonality: '' },
      efficiency: { 'output-level': 'full', preamble: 'minimal' },
      'hardware-sharing': { enabled: false, 'hash-salt': '' },
    };
    const writeResult = writeOwnerConfig(cfg, { path: tmpPath });
    expect(writeResult.written).toBe(true);
    expect(writeResult.errors).toHaveLength(0);

    const loaded = loadOwnerConfig({ path: tmpPath });
    expect(loaded.source).toBe('file');
    expect(loaded.errors).toHaveLength(0);
    expect(loaded.config.owner.language).toBe('de');
    expect(loaded.config.tone.style).toBe('direct');
    expect(loaded.config.efficiency['output-level']).toBe('full');
    expect(loaded.config.efficiency.preamble).toBe('minimal');
    expect(loaded.config['hardware-sharing'].enabled).toBe(false);

    const validation = validateOwnerConfig(loaded.config);
    expect(validation.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Hardware-sharing consent — config round-trip with enabled=true
// applyInterviewAnswers leaves owner.name empty (bootstrap fills it), so we use
// writeOwnerConfig directly to exercise the hash-salt path end-to-end.
// ---------------------------------------------------------------------------

describe('Hardware-sharing consent generates hash-salt', () => {
  it('writeOwnerConfig accepts enabled=true with a 64-char hex hash-salt and round-trips correctly', () => {
    const tmpPath = ownerYamlPath();

    // Generate a salt the same way applyInterviewAnswers does internally
    const hashSalt = randomBytes(32).toString('hex');
    expect(hashSalt).toHaveLength(64);

    const writeResult = writeOwnerConfig(
      {
        owner: { name: 'HwUser', language: 'en' },
        tone: { style: 'neutral', tonality: '' },
        efficiency: { 'output-level': 'full', preamble: 'minimal' },
        'hardware-sharing': { enabled: true, 'hash-salt': hashSalt },
      },
      { path: tmpPath },
    );
    expect(writeResult.written).toBe(true);

    const loaded = loadOwnerConfig({ path: tmpPath });
    expect(loaded.source).toBe('file');

    const hw = loaded.config['hardware-sharing'];
    expect(hw.enabled).toBe(true);
    expect(hw['hash-salt']).toBe(hashSalt);
    expect(/^[0-9a-f]+$/.test(hw['hash-salt'])).toBe(true);
  });

  it('validateOwnerConfig rejects hardware-sharing enabled=true with empty hash-salt', () => {
    // This directly tests the contract that applyInterviewAnswers relies on
    const result = validateOwnerConfig({
      owner: { name: 'x', language: 'en' },
      tone: { style: 'neutral', tonality: '' },
      efficiency: { 'output-level': 'full', preamble: 'minimal' },
      'hardware-sharing': { enabled: true, 'hash-salt': '' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hash-salt'))).toBe(true);
  });

  it('writeOwnerConfig accepts enabled=false with empty hash-salt', () => {
    const tmpPath = ownerYamlPath();
    const writeResult = writeOwnerConfig(
      {
        owner: { name: 'NoHw', language: 'en' },
        tone: { style: 'neutral', tonality: '' },
        efficiency: { 'output-level': 'full', preamble: 'minimal' },
        'hardware-sharing': { enabled: false, 'hash-salt': '' },
      },
      { path: tmpPath },
    );
    expect(writeResult.written).toBe(true);

    const loaded = loadOwnerConfig({ path: tmpPath });
    expect(loaded.config['hardware-sharing'].enabled).toBe(false);
    expect(loaded.config['hardware-sharing']['hash-salt']).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Slot resolution after interview
// Write a custom owner.yaml → resolve soul.md → verify substituted values appear.
// ---------------------------------------------------------------------------

describe('Slot resolution after interview write', () => {
  it('resolves soul.md slots using values from a tmp owner.yaml', () => {
    const tmpPath = ownerYamlPath();

    // Write a known config with non-default values
    const writeResult = writeOwnerConfig(
      {
        owner: { name: 'TestUser', language: 'de' },
        tone: { style: 'direct', tonality: '' },
        efficiency: { 'output-level': 'ultra', preamble: 'minimal' },
        'hardware-sharing': { enabled: false, 'hash-salt': '' },
      },
      { path: tmpPath },
    );
    expect(writeResult.written).toBe(true);

    const { resolved, source } = loadAndResolveSoul(SOUL_MD_PATH, { ownerConfigPath: tmpPath });

    expect(source).toBe('file');

    // Known slot values must appear in the resolved output
    expect(resolved).toContain('direct');
    expect(resolved).toContain('ultra');
    expect(resolved).toContain('minimal');

    // No {{ }} placeholders should remain (all known slots resolved)
    expect(resolved).not.toMatch(/\{\{owner\.language\}\}/);
    expect(resolved).not.toMatch(/\{\{tone\.style\}\}/);
    expect(resolved).not.toMatch(/\{\{efficiency\.output-level\}\}/);
    expect(resolved).not.toMatch(/\{\{efficiency\.preamble\}\}/);
  });

  it('resolveSoul pure function substitutes values from an inline config object', () => {
    const template = 'Style: {{tone.style}}. Level: {{efficiency.output-level}}. Pre: {{efficiency.preamble}}.';
    const ownerConfig = {
      owner: { name: 'x', language: 'de' },
      tone: { style: 'friendly', tonality: '' },
      efficiency: { 'output-level': 'lite', preamble: 'verbose' },
      'hardware-sharing': { enabled: false, 'hash-salt': '' },
    };

    const { resolved, warnings } = resolveSoul(template, ownerConfig);

    expect(resolved).toBe('Style: friendly. Level: lite. Pre: verbose.');
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Force re-interview archives existing yaml
// ---------------------------------------------------------------------------

describe('runOwnerInterview with force=true', () => {
  it('archives existing yaml and returns status=pending with questions', () => {
    const tmpPath = ownerYamlPath();

    // Write initial config so the file exists
    writeOwnerConfig(
      {
        owner: { name: 'Existing', language: 'en' },
        tone: { style: 'neutral', tonality: '' },
        efficiency: { 'output-level': 'full', preamble: 'minimal' },
        'hardware-sharing': { enabled: false, 'hash-salt': '' },
      },
      { path: tmpPath },
    );
    expect(existsSync(tmpPath)).toBe(true);

    const result = runOwnerInterview({ force: true, path: tmpPath });

    expect(result.status).toBe('pending');
    expect(Array.isArray(result.questions)).toBe(true);
    expect(result.questions.length).toBe(5);

    // A .bak-<timestamp> file should have been created in the same directory
    const entries = readdirSync(tmpDir);
    const bakFiles = entries.filter((f) => f.startsWith('owner.yaml.bak-'));
    expect(bakFiles.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 6: skipIfExists default — existing yaml returns skipped, no archive
// ---------------------------------------------------------------------------

describe('runOwnerInterview default (skipIfExists)', () => {
  it('returns status=skipped when owner.yaml exists and no force flag', () => {
    const tmpPath = ownerYamlPath();

    writeOwnerConfig(
      {
        owner: { name: 'Existing', language: 'en' },
        tone: { style: 'neutral', tonality: '' },
        efficiency: { 'output-level': 'full', preamble: 'minimal' },
        'hardware-sharing': { enabled: false, 'hash-salt': '' },
      },
      { path: tmpPath },
    );

    const result = runOwnerInterview({ path: tmpPath });

    expect(result.status).toBe('skipped');
    expect(result.questions).toBeNull();

    // No archive file should be created
    const entries = readdirSync(tmpDir);
    const bakFiles = entries.filter((f) => f.startsWith('owner.yaml.bak-'));
    expect(bakFiles).toHaveLength(0);
  });

  it('returns status=pending when no owner.yaml exists (first-run)', () => {
    const tmpPath = ownerYamlPath();
    // Do not write the file — it must not exist
    expect(existsSync(tmpPath)).toBe(false);

    const result = runOwnerInterview({ path: tmpPath });

    expect(result.status).toBe('pending');
    expect(Array.isArray(result.questions)).toBe(true);
    expect(result.questions.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Test 7: resolveSoul leaves unknown slots in place and emits a warning
// ---------------------------------------------------------------------------

describe('resolveSoul unknown slot handling', () => {
  it('leaves unknown slots in place and records a warning', () => {
    const template = 'Known: {{tone.style}}. Unknown: {{custom.slot}}.';
    const config = getDefaults();

    const { resolved, warnings } = resolveSoul(template, config);

    // Known slot replaced with default
    expect(resolved).toContain('neutral');
    // Unknown slot left verbatim
    expect(resolved).toContain('{{custom.slot}}');
    // Warning emitted for the unknown slot
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('custom.slot');
  });
});

// ---------------------------------------------------------------------------
// Test 8: applyInterviewAnswers error path — wrong number of answers
// ---------------------------------------------------------------------------

describe('applyInterviewAnswers error paths', () => {
  it('returns ok=false when fewer than 5 answers are provided', () => {
    const tmpPath = ownerYamlPath();
    const result = applyInterviewAnswers(['de', 'direct'], { path: tmpPath });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // File must not be created
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('returns ok=false when answers is not an array', () => {
    const tmpPath = ownerYamlPath();
    const result = applyInterviewAnswers(null, { path: tmpPath });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(existsSync(tmpPath)).toBe(false);
  });
});
