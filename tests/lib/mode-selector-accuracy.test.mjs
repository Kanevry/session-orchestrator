import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  recordAccuracy,
  buildSubject,
  LEARNING_TYPE,
  INITIAL_CONFIDENCE,
  DEFAULT_EXPIRY_DAYS,
} from '@lib/mode-selector-accuracy.mjs';

let tmp;
let learningsPath;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'mode-acc-'));
  learningsPath = path.join(tmp, 'learnings.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SESSION_ID = 'main-2026-04-25-0815';
const NOW_MS = Date.parse('2026-04-25T08:15:00Z');

describe('buildSubject', () => {
  it('formats agreement: "<mode>-selected-vs-<mode>"', () => {
    expect(buildSubject('feature', 'feature')).toBe('feature-selected-vs-feature');
  });
  it('formats override: "<recommended>-selected-vs-<chosen>"', () => {
    expect(buildSubject('feature', 'deep')).toBe('feature-selected-vs-deep');
  });
});

describe('recordAccuracy — type taxonomy registration', () => {
  it('exports LEARNING_TYPE = "mode-selector-accuracy"', () => {
    expect(LEARNING_TYPE).toBe('mode-selector-accuracy');
  });
  it('exports INITIAL_CONFIDENCE = 0.5', () => {
    expect(INITIAL_CONFIDENCE).toBe(0.5);
  });
  it('exports DEFAULT_EXPIRY_DAYS = 30', () => {
    expect(DEFAULT_EXPIRY_DAYS).toBe(30);
  });
});

describe('recordAccuracy — happy paths', () => {
  it('agreement write produces valid learning at confidence 0.5', async () => {
    const r = await recordAccuracy({
      recommended: 'feature',
      chosen: 'feature',
      sessionId: SESSION_ID,
      filePath: learningsPath,
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(true);
    expect(r.entry.type).toBe(LEARNING_TYPE);
    expect(r.entry.subject).toBe('feature-selected-vs-feature');
    expect(r.entry.confidence).toBe(0.5);
    expect(r.entry.source_session).toBe(SESSION_ID);
    expect(r.entry.evidence).toEqual([
      'main-2026-04-25-0815: recommended=feature chosen=feature',
    ]);
    expect(r.entry.insight).toMatch(/confirmed/i);
    // expires_at = created_at + 30d
    const expectedExpiry = new Date(NOW_MS + 30 * 86_400_000).toISOString();
    expect(r.entry.expires_at).toBe(expectedExpiry);
  });

  it('override write encodes insight as "overrode"', async () => {
    const r = await recordAccuracy({
      recommended: 'feature',
      chosen: 'deep',
      sessionId: SESSION_ID,
      filePath: learningsPath,
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(true);
    expect(r.entry.subject).toBe('feature-selected-vs-deep');
    expect(r.entry.insight).toMatch(/overrode/i);
  });

  it('write actually persists JSONL line', async () => {
    await recordAccuracy({
      recommended: 'feature',
      chosen: 'feature',
      sessionId: SESSION_ID,
      filePath: learningsPath,
      nowMs: NOW_MS,
    });
    expect(existsSync(learningsPath)).toBe(true);
    const lines = readFileSync(learningsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe(LEARNING_TYPE);
  });

  it('respects custom confidence override', async () => {
    const r = await recordAccuracy({
      recommended: 'feature',
      chosen: 'feature',
      sessionId: SESSION_ID,
      filePath: learningsPath,
      nowMs: NOW_MS,
      confidence: 0.8,
    });
    expect(r.entry.confidence).toBe(0.8);
  });
});

describe('recordAccuracy — graceful no-ops', () => {
  it('recommended=null → {ok: false, reason: no-recommendation}', async () => {
    const r = await recordAccuracy({
      recommended: null,
      chosen: 'feature',
      sessionId: SESSION_ID,
      filePath: learningsPath,
    });
    expect(r).toEqual({ ok: false, reason: 'no-recommendation' });
    expect(existsSync(learningsPath)).toBe(false);
  });

  it('recommended="" → {ok: false, reason: no-recommendation}', async () => {
    const r = await recordAccuracy({
      recommended: '',
      chosen: 'feature',
      sessionId: SESSION_ID,
      filePath: learningsPath,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-recommendation');
  });

  it('chosen non-string → {ok: false, reason: invalid-mode-type}', async () => {
    const r = await recordAccuracy({
      recommended: 'feature',
      chosen: 123,
      sessionId: SESSION_ID,
      filePath: learningsPath,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid-mode-type');
  });

  it('unknown mode → {ok: false, reason: unknown-mode}', async () => {
    const r = await recordAccuracy({
      recommended: 'feature',
      chosen: 'martian-mode',
      sessionId: SESSION_ID,
      filePath: learningsPath,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown-mode');
  });

  it('missing sessionId → {ok: false, reason: missing-session-id}', async () => {
    const r = await recordAccuracy({
      recommended: 'feature',
      chosen: 'feature',
      sessionId: '',
      filePath: learningsPath,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing-session-id');
  });
});

describe('recordAccuracy — multiple writes accumulate', () => {
  it('two distinct (recommended, chosen) pairs land at distinct subjects', async () => {
    await recordAccuracy({
      recommended: 'feature',
      chosen: 'feature',
      sessionId: SESSION_ID,
      filePath: learningsPath,
      nowMs: NOW_MS,
    });
    await recordAccuracy({
      recommended: 'feature',
      chosen: 'deep',
      sessionId: SESSION_ID,
      filePath: learningsPath,
      nowMs: NOW_MS + 1000,
    });
    const lines = readFileSync(learningsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const subjects = lines.map((l) => JSON.parse(l).subject);
    expect(subjects).toEqual([
      'feature-selected-vs-feature',
      'feature-selected-vs-deep',
    ]);
  });
});
