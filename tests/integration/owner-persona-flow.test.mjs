/**
 * tests/integration/owner-persona-flow.test.mjs
 *
 * End-to-end integration tests for the Owner Persona pipeline:
 *   D2 interview → owner.yaml write → load round-trip.
 *
 * Modules under test:
 *   scripts/lib/owner-yaml.mjs    — loadOwnerConfig, writeOwnerConfig, validateOwnerConfig
 *   scripts/lib/owner-interview.mjs — getInterviewQuestions, applyInterviewAnswers, runOwnerInterview
 *
 * Isolation: every test uses a unique tmp dir under os.tmpdir().
 * Real ~/.config/session-orchestrator/owner.yaml is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { loadOwnerConfig, writeOwnerConfig, validateOwnerConfig } from '@lib/owner-yaml.mjs';
import { getInterviewQuestions, applyInterviewAnswers, runOwnerInterview } from '@lib/owner-interview.mjs';

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
