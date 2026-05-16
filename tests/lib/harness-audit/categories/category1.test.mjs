/**
 * tests/lib/harness-audit/categories/category1.test.mjs
 *
 * Unit tests for scripts/lib/harness-audit/categories/category1.mjs
 * Category 1: Session Discipline
 *
 * Checks exercised:
 *   c1.1 state-md-present
 *   c1.2 sessions-jsonl-growth
 *   c1.3 learnings-jsonl-nonempty
 *   c1.4 orchestrator-layout
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCategory1 } from '@lib/harness-audit/categories/category1.mjs';
import { _resetWarnFlags } from '@lib/harness-audit/categories/helpers.mjs';

/**
 * Write a file, creating intermediate directories as needed.
 */
function scaffold(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('category1 — Session Discipline', () => {
  let d;

  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'cat1-'));
    _resetWarnFlags();
  });

  afterEach(() => {
    rmSync(d, { recursive: true, force: true });
  });

  it('returns an array of checks (floor: at least 3)', () => {
    // Minimal fixture — just enough to run without crashing
    const checks = runCategory1(d);
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(3);
    expect(checks.length).toBeLessThanOrEqual(20);
  });

  describe('happy path — all checks PASS', () => {
    it('all checks pass when a well-formed fixture repo is provided', () => {
      // c1.1: valid .claude/STATE.md with required frontmatter
      scaffold(d, '.claude/STATE.md', [
        '---',
        'schema-version: 1',
        'status: active',
        'session-type: deep',
        '---',
        '# State',
      ].join('\n'));

      // c1.2: sessions.jsonl with ≥2 valid lines
      scaffold(d, '.orchestrator/metrics/sessions.jsonl', [
        JSON.stringify({ session_id: 's1', session_type: 'deep', started_at: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ session_id: 's2', session_type: 'fast', started_at: '2026-01-02T00:00:00Z' }),
      ].join('\n') + '\n');

      // c1.3: learnings.jsonl with ≥1 valid line
      scaffold(d, '.orchestrator/metrics/learnings.jsonl',
        JSON.stringify({ type: 'pattern', subject: 'test', confidence: 0.9 }) + '\n');

      // c1.4: orchestrator layout directories
      mkdirSync(join(d, '.orchestrator/policy'), { recursive: true });
      writeFileSync(join(d, '.orchestrator/bootstrap.lock'), 'version: 3.4.0\n', 'utf8');

      const checks = runCategory1(d);
      const failed = checks.filter((c) => c.status === 'fail');
      expect(failed).toHaveLength(0);

      const passed = checks.filter((c) => c.status === 'pass');
      expect(passed.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('c1.1 state-md-present', () => {
    it('fails when STATE.md is completely absent', () => {
      // Provide other files so only state-md-present is the culprit
      scaffold(d, '.orchestrator/metrics/sessions.jsonl', [
        JSON.stringify({ session_id: 's1', session_type: 'deep', started_at: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ session_id: 's2', session_type: 'fast', started_at: '2026-01-02T00:00:00Z' }),
      ].join('\n'));
      scaffold(d, '.orchestrator/metrics/learnings.jsonl',
        JSON.stringify({ type: 'pattern', subject: 'test', confidence: 0.9 }) + '\n');
      mkdirSync(join(d, '.orchestrator/policy'), { recursive: true });
      writeFileSync(join(d, '.orchestrator/bootstrap.lock'), 'version: 3.4.0\n', 'utf8');

      const checks = runCategory1(d);
      const stateMdCheck = checks.find((c) => c.check_id === 'state-md-present');
      expect(stateMdCheck).toBeDefined();
      expect(stateMdCheck.status).toBe('fail');
      expect(stateMdCheck.evidence.hasYaml).toBe(false);
    });

    it('fails when STATE.md exists but lacks required frontmatter fields', () => {
      // Missing session-type field
      scaffold(d, '.claude/STATE.md', [
        '---',
        'schema-version: 1',
        'status: active',
        '---',
        '# State',
      ].join('\n'));

      const checks = runCategory1(d);
      const stateMdCheck = checks.find((c) => c.check_id === 'state-md-present');
      expect(stateMdCheck).toBeDefined();
      expect(stateMdCheck.status).toBe('fail');
    });
  });

  describe('c1.2 sessions-jsonl-growth', () => {
    it('fails when sessions.jsonl has only one entry (need ≥2)', () => {
      scaffold(d, '.claude/STATE.md', [
        '---',
        'schema-version: 1',
        'status: active',
        'session-type: deep',
        '---',
      ].join('\n'));
      scaffold(d, '.orchestrator/metrics/sessions.jsonl',
        JSON.stringify({ session_id: 's1', session_type: 'deep', started_at: '2026-01-01T00:00:00Z' }) + '\n');

      const checks = runCategory1(d);
      const check = checks.find((c) => c.check_id === 'sessions-jsonl-growth');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.lineCount).toBe(1);
    });

    it('fails when sessions.jsonl is missing', () => {
      const checks = runCategory1(d);
      const check = checks.find((c) => c.check_id === 'sessions-jsonl-growth');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.lineCount).toBe(0);
    });
  });

  describe('c1.3 learnings-jsonl-nonempty', () => {
    it('fails when learnings.jsonl is missing entirely', () => {
      const checks = runCategory1(d);
      const check = checks.find((c) => c.check_id === 'learnings-jsonl-nonempty');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.lineCount).toBe(0);
    });

    it('passes when learnings.jsonl has at least one well-formed entry', () => {
      scaffold(d, '.claude/STATE.md', [
        '---',
        'schema-version: 1',
        'status: active',
        'session-type: deep',
        '---',
      ].join('\n'));
      scaffold(d, '.orchestrator/metrics/sessions.jsonl', [
        JSON.stringify({ session_id: 's1', session_type: 'deep', started_at: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ session_id: 's2', session_type: 'fast', started_at: '2026-01-02T00:00:00Z' }),
      ].join('\n'));
      scaffold(d, '.orchestrator/metrics/learnings.jsonl',
        JSON.stringify({ type: 'pattern', subject: 'subject-a', confidence: 0.85 }) + '\n');
      mkdirSync(join(d, '.orchestrator/policy'), { recursive: true });
      writeFileSync(join(d, '.orchestrator/bootstrap.lock'), 'version: 3.4.0\n', 'utf8');

      const checks = runCategory1(d);
      const check = checks.find((c) => c.check_id === 'learnings-jsonl-nonempty');
      expect(check).toBeDefined();
      expect(check.status).toBe('pass');
      expect(check.evidence.validLines).toBeGreaterThanOrEqual(1);
    });
  });

  describe('c1.4 orchestrator-layout', () => {
    it('fails when .orchestrator/bootstrap.lock is missing', () => {
      // Provide the directory but not the lock file
      mkdirSync(join(d, '.orchestrator/policy'), { recursive: true });
      mkdirSync(join(d, '.orchestrator/metrics'), { recursive: true });

      const checks = runCategory1(d);
      const check = checks.find((c) => c.check_id === 'orchestrator-layout');
      expect(check).toBeDefined();
      expect(check.status).toBe('fail');
      expect(check.evidence.missingPaths).toContain('.orchestrator/bootstrap.lock');
    });
  });
});
