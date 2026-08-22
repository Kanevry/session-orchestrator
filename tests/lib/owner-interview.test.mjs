/**
 * tests/lib/owner-interview.test.mjs
 *
 * Unit tests for scripts/lib/owner-interview.mjs.
 * Covers: getInterviewQuestions, applyInterviewAnswers, runOwnerInterview.
 *
 * getDefaults() is mocked to return a non-empty name so writeOwnerConfig
 * validation passes — the production code comment explicitly says
 * "bootstrap caller sets name after interview if needed", so the module
 * itself always starts from the empty-name default.
 *
 * All disk writes are redirected to a per-test tmpdir via the `path` option —
 * no real ~/.config files are ever created or modified.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mock getDefaults so owner.name is non-empty (validation guard requires it).
// The real code intentionally leaves name='' for the coordinator to fill in;
// our tests provide a fixture name so we can exercise the write path.
// ---------------------------------------------------------------------------

vi.mock('@lib/owner-yaml.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    getDefaults: () => ({
      owner: { name: 'TestOwner', language: 'en' },
      tone: { style: 'neutral', tonality: '' },
      efficiency: { 'output-level': 'full', preamble: 'minimal' },
      'hardware-sharing': { enabled: false, 'hash-salt': '' },
    }),
  };
});

import {
  getInterviewQuestions,
  applyInterviewAnswers,
  optionValue,
  runOwnerInterview,
} from '@lib/owner-interview.mjs';

// ---------------------------------------------------------------------------
// Per-test tmpdir — owner.yaml writes go here, never to ~/.config
// ---------------------------------------------------------------------------

let sandbox;
let ownerYamlPath;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'owner-interview-test-'));
  ownerYamlPath = join(sandbox, 'owner.yaml');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getInterviewQuestions
// ---------------------------------------------------------------------------

describe('getInterviewQuestions', () => {
  it('returns exactly 5 questions', () => {
    expect(getInterviewQuestions()).toHaveLength(5);
  });

  it('each question has the required AUQ-compatible shape', () => {
    const questions = getInterviewQuestions();
    for (const q of questions) {
      expect(typeof q.question).toBe('string');
      expect(typeof q.header).toBe('string');
      expect(Array.isArray(q.options)).toBe(true);
      expect(q.options.length).toBeGreaterThan(0);
      expect(typeof q.multiSelect).toBe('boolean');
      expect(q.multiSelect).toBe(false);
    }
  });

  // Labels are read by the operator; optionValue(label) is what reaches owner.yaml.
  // The two used to be one string, so asserting on the raw label pinned the stored
  // value by accident. Assert the resolution — that is the property a reworded
  // label can silently break.
  it('first question covers language selection with de and en options', () => {
    const first = getInterviewQuestions()[0];
    const values = first.options.map((o) => optionValue(o.label));
    expect(values).toContain('de');
    expect(values).toContain('en');
  });

  it('second question covers tone style with direct, neutral, friendly options', () => {
    const second = getInterviewQuestions()[1];
    const values = second.options.map((o) => optionValue(o.label));
    expect(values).toContain('direct');
    expect(values).toContain('neutral');
    expect(values).toContain('friendly');
  });

  it('fifth question covers hardware-sharing consent with Yes/No/Preview options', () => {
    const fifth = getInterviewQuestions()[4];
    const values = fifth.options.map((o) => optionValue(o.label));
    expect(values).toContain('Yes');
    expect(values).toContain('No');
    expect(values).toContain('Preview');
  });

  // The AskUserQuestion header field is truncated at 12 characters by the tool
  // itself. All five headers used to run 32–48 characters, so every one of them
  // reached the operator as the same useless stub "Owner Interv".
  it('keeps every header inside the 12-character limit the tool truncates at', () => {
    const tooLong = getInterviewQuestions()
      .map((q) => q.header)
      .filter((h) => [...h].length > 12);
    expect(tooLong).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Label ←→ stored value (the split that let the labels be rewritten at all)
// ---------------------------------------------------------------------------

describe('option label → stored config value', () => {
  // The regression this file exists to prevent: applyInterviewAnswers() matches
  // the answer against closed enums and falls back to a default on any miss, so a
  // label that carries display text the resolver does not strip is written to
  // owner.yaml as the WRONG value — silently, with no error anywhere.
  it('writes the enum value, not the label, when the label carries (Recommended)', () => {
    const filePath = ownerYamlPath;
    const result = applyInterviewAnswers(
      ['de', 'direct (Recommended)', 'full (Recommended)', 'minimal (Recommended)', 'No (Recommended)'],
      { path: filePath },
    );

    expect(result.ok).toBe(true);
    const written = readFileSync(filePath, 'utf8');
    expect(written).toContain('style: direct');
    expect(written).toContain('output-level: full');
    expect(written).toContain('preamble: minimal');
  });

  it('resolves every shipped option label to a value the enums accept', () => {
    // Fails the moment a label is reworded into something applyInterviewAnswers
    // would silently swap for a default.
    const accepted = [
      ['de', 'en', 'other'],
      ['direct', 'neutral', 'friendly'],
      ['lite', 'full', 'ultra'],
      ['minimal', 'verbose'],
      ['Yes', 'No', 'Preview'],
    ];
    const resolved = getInterviewQuestions().map((q) => q.options.map((o) => optionValue(o.label)));
    resolved.forEach((values, i) => {
      values.forEach((v) => expect(accepted[i]).toContain(v));
    });
  });

  it('leaves a label without a marker exactly as it is', () => {
    expect(optionValue('autonomous-gated')).toBe('autonomous-gated');
    expect(optionValue('advisory')).toBe('advisory');
  });

  it('returns an empty string for a non-string label instead of throwing', () => {
    expect(optionValue(null)).toBe('');
    expect(optionValue(undefined)).toBe('');
    expect(optionValue(42)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// applyInterviewAnswers — happy path
// ---------------------------------------------------------------------------

describe('applyInterviewAnswers — happy path', () => {
  it('writes owner.yaml when all 5 valid answers are provided', () => {
    const answers = ['de', 'direct', 'full', 'minimal', 'No'];
    const result = applyInterviewAnswers(answers, { path: ownerYamlPath });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(existsSync(ownerYamlPath)).toBe(true);
  });

  it('written file contains the correct language from answers', () => {
    const answers = ['de', 'neutral', 'lite', 'verbose', 'No'];
    applyInterviewAnswers(answers, { path: ownerYamlPath });

    const content = readFileSync(ownerYamlPath, 'utf8');
    expect(content).toContain('language: de');
  });

  it('written file contains the correct tone style from answers', () => {
    const answers = ['en', 'direct', 'ultra', 'minimal', 'No'];
    applyInterviewAnswers(answers, { path: ownerYamlPath });

    const content = readFileSync(ownerYamlPath, 'utf8');
    expect(content).toContain('style: direct');
  });

  it('hardware-sharing enabled=true when answer is Yes and hash-salt is non-empty', () => {
    const answers = ['en', 'neutral', 'full', 'minimal', 'Yes'];
    const result = applyInterviewAnswers(answers, { path: ownerYamlPath });

    expect(result.ok).toBe(true);
    const content = readFileSync(ownerYamlPath, 'utf8');
    expect(content).toContain('enabled: true');
    // hash-salt must be non-empty (64-char hex)
    const saltMatch = content.match(/hash-salt:\s*(\S+)/);
    expect(saltMatch).not.toBeNull();
    expect(saltMatch[1].replace(/['"]/g, '').length).toBeGreaterThan(10);
  });

  it('hardware-sharing enabled=false when answer is No', () => {
    const answers = ['en', 'neutral', 'full', 'minimal', 'No'];
    applyInterviewAnswers(answers, { path: ownerYamlPath });

    const content = readFileSync(ownerYamlPath, 'utf8');
    expect(content).toContain('enabled: false');
  });
});

// ---------------------------------------------------------------------------
// applyInterviewAnswers — invalid inputs fall back to defaults
// ---------------------------------------------------------------------------

describe('applyInterviewAnswers — invalid values fall back to defaults', () => {
  it('unknown language falls back to en (written successfully)', () => {
    const answers = ['klingon', 'neutral', 'full', 'minimal', 'No'];
    const result = applyInterviewAnswers(answers, { path: ownerYamlPath });
    // applyInterviewAnswers coerces invalid language to 'en' and writes successfully
    expect(result.ok).toBe(true);
    const content = readFileSync(ownerYamlPath, 'utf8');
    expect(content).toContain('language: en');
  });

  it('unknown tone style falls back to neutral (written successfully)', () => {
    const answers = ['en', 'aggressive', 'full', 'minimal', 'No'];
    const result = applyInterviewAnswers(answers, { path: ownerYamlPath });
    expect(result.ok).toBe(true);
    const content = readFileSync(ownerYamlPath, 'utf8');
    expect(content).toContain('style: neutral');
  });

  it('unknown output-level falls back to full (written successfully)', () => {
    const answers = ['en', 'neutral', 'turbo', 'minimal', 'No'];
    const result = applyInterviewAnswers(answers, { path: ownerYamlPath });
    expect(result.ok).toBe(true);
    const content = readFileSync(ownerYamlPath, 'utf8');
    // YAML serializes 'output-level' with quotes around the key
    expect(content).toContain('output-level');
    expect(content).toContain('full');
  });

  it('returns error when answers array has fewer than 5 items', () => {
    const result = applyInterviewAnswers(['en', 'neutral', 'full'], { path: ownerYamlPath });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('5 answers');
  });

  it('returns error when answers argument is not an array', () => {
    const result = applyInterviewAnswers('not-an-array', { path: ownerYamlPath });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns path in result regardless of success or failure', () => {
    const result = applyInterviewAnswers([], { path: ownerYamlPath });
    expect(result.path).toBe(ownerYamlPath);
  });
});

// ---------------------------------------------------------------------------
// runOwnerInterview — skipIfExists behaviour
// ---------------------------------------------------------------------------

describe('runOwnerInterview — skipIfExists', () => {
  it('returns status=skipped when owner.yaml exists and skipIfExists=true (default)', () => {
    writeFileSync(ownerYamlPath, 'owner:\n  name: Ada\n  language: en\n', 'utf8');

    const result = runOwnerInterview({ skipIfExists: true, path: ownerYamlPath });

    expect(result.status).toBe('skipped');
    expect(result.questions).toBeNull();
    expect(result.config).toBeNull();
  });

  it('returns status=pending with questions when owner.yaml does not exist', () => {
    const result = runOwnerInterview({ skipIfExists: true, path: ownerYamlPath });

    expect(result.status).toBe('pending');
    expect(Array.isArray(result.questions)).toBe(true);
    expect(result.questions).toHaveLength(5);
    expect(result.path).toBe(ownerYamlPath);
  });

  it('returns status=pending even when file exists and skipIfExists=false', () => {
    writeFileSync(ownerYamlPath, 'owner:\n  name: Ada\n  language: en\n', 'utf8');

    const result = runOwnerInterview({ skipIfExists: false, path: ownerYamlPath });

    expect(result.status).toBe('pending');
  });

  it('returns path in the result object pointing to the configured yaml location', () => {
    const result = runOwnerInterview({ path: ownerYamlPath });
    expect(result.path).toBe(ownerYamlPath);
  });
});

// ---------------------------------------------------------------------------
// runOwnerInterview — force (--owner-reset) archives existing file
// ---------------------------------------------------------------------------

describe('runOwnerInterview — force archives existing yaml', () => {
  it('archives existing owner.yaml to a timestamped backup when force=true', () => {
    writeFileSync(ownerYamlPath, 'owner:\n  name: Ada\n', 'utf8');

    const result = runOwnerInterview({ force: true, path: ownerYamlPath });

    expect(result.status).toBe('pending');

    // A timestamped backup file should now exist in the same directory
    const backupFiles = readdirSync(sandbox).filter((f) => f.includes('owner.yaml.bak-'));
    expect(backupFiles.length).toBe(1);
  });

  it('returns pending status after archiving (coordinator must supply answers)', () => {
    writeFileSync(ownerYamlPath, 'owner:\n  name: Ada\n', 'utf8');

    const result = runOwnerInterview({ force: true, path: ownerYamlPath });

    // force=true archives but still returns pending — coordinator must supply answers
    expect(result.status).toBe('pending');
    expect(Array.isArray(result.questions)).toBe(true);
  });

  it('does not archive when file does not exist and force=true', () => {
    // File doesn't exist — nothing to archive, but should still return pending
    const result = runOwnerInterview({ force: true, path: ownerYamlPath });
    expect(result.status).toBe('pending');

    // No backup files should exist
    const backupFiles = readdirSync(sandbox).filter((f) => f.includes('owner.yaml.bak-'));
    expect(backupFiles.length).toBe(0);
  });
});
