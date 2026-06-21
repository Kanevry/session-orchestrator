/**
 * writer.test.mjs — Unit tests for scripts/lib/reconcile/writer.mjs (FA3 #696).
 *
 * Covers:
 *   - Happy path: approved rule written atomically to .claude/rules/<slug>.md
 *   - Rejected proposal archived to .orchestrator/reconcile.rejected.log (JSONL)
 *   - PATH TRAVERSAL (mandatory): path escaping .claude/rules/ is rejected and
 *     the file outside the guard zone must not be created (errors[] populated).
 *   - Empty inputs: no approved + no rejected → { written:0, archived:0, errors:[] }
 *
 * ALL disk I/O targets a unique per-test temp dir under os.tmpdir().
 * The real .claude/rules/ and .orchestrator/ are NEVER touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeApprovedRules } from '../../../scripts/lib/reconcile/writer.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'reconcile-writer-'));
  // Pre-create .claude/rules/ so path validation passes for approved items
  mkdirSync(join(tmpDir, '.claude', 'rules'), { recursive: true });
  // Pre-create .orchestrator/ so lock acquisition + rejected log can write
  mkdirSync(join(tmpDir, '.orchestrator'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path — writes an approved rule file
// ---------------------------------------------------------------------------

describe('writeApprovedRules — approved rule write', () => {
  it('writes an approved rule to .claude/rules/<slug>.md with exact content', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'test-rule',
          path: '.claude/rules/test-rule.md',
          content: '# Test Rule\n\nThis is the rule body.\n',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
      sessionId: 'session-test-001',
    });

    expect(result.written).toBe(1);
    expect(result.archived).toBe(0);
    expect(result.errors).toEqual([]);

    const destPath = join(tmpDir, '.claude', 'rules', 'test-rule.md');
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf8')).toBe('# Test Rule\n\nThis is the rule body.\n');
  });

  it('returns written count equal to the number of approved items when multiple are provided', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'rule-alpha',
          path: '.claude/rules/rule-alpha.md',
          content: '# Alpha\n',
        },
        {
          slug: 'rule-beta',
          path: '.claude/rules/rule-beta.md',
          content: '# Beta\n',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(2);
    expect(result.errors).toEqual([]);

    expect(existsSync(join(tmpDir, '.claude', 'rules', 'rule-alpha.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'rule-beta.md'))).toBe(true);
    expect(readFileSync(join(tmpDir, '.claude', 'rules', 'rule-alpha.md'), 'utf8')).toBe('# Alpha\n');
    expect(readFileSync(join(tmpDir, '.claude', 'rules', 'rule-beta.md'), 'utf8')).toBe('# Beta\n');
  });
});

// ---------------------------------------------------------------------------
// Rejected proposal archived to JSONL log
// ---------------------------------------------------------------------------

describe('writeApprovedRules — rejected proposal archive', () => {
  it('appends a JSONL line to .orchestrator/reconcile.rejected.log with _rejected_reason + _rejected_at', async () => {
    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        {
          learningKey: 'fragile-pattern/some-rule',
          type: 'fragile-pattern',
          reason: 'user-declined',
          status: 'rejected',
        },
      ],
      repoRoot: tmpDir,
      sessionId: 'session-test-002',
    });

    expect(result.written).toBe(0);
    expect(result.archived).toBe(1);
    expect(result.errors).toEqual([]);

    const logPath = join(tmpDir, '.orchestrator', 'reconcile.rejected.log');
    expect(existsSync(logPath)).toBe(true);

    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record._rejected_reason).toBe('user-declined');
    expect(typeof record._rejected_at).toBe('string');
    // _rejected_at must be a valid ISO 8601 timestamp
    expect(new Date(record._rejected_at).toISOString()).toBe(record._rejected_at);
    expect(record.learningKey).toBe('fragile-pattern/some-rule');
    expect(record.type).toBe('fragile-pattern');
  });

  it('uses "user-declined" as _rejected_reason when item.reason is absent', async () => {
    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        {
          learningKey: 'anti-pattern/no-reason',
          type: 'anti-pattern',
          status: 'rejected',
          // note: no `reason` field
        },
      ],
      repoRoot: tmpDir,
    });

    expect(result.archived).toBe(1);
    expect(result.errors).toEqual([]);

    const logPath = join(tmpDir, '.orchestrator', 'reconcile.rejected.log');
    const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(record._rejected_reason).toBe('user-declined');
  });

  it('archives multiple rejected items as separate JSONL lines', async () => {
    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        { learningKey: 'frag/a', type: 'fragile-pattern', reason: 'low-confidence', status: 'rejected' },
        { learningKey: 'frag/b', type: 'recurring-issue', reason: 'user-declined', status: 'rejected' },
      ],
      repoRoot: tmpDir,
    });

    expect(result.archived).toBe(2);
    expect(result.errors).toEqual([]);

    const logPath = join(tmpDir, '.orchestrator', 'reconcile.rejected.log');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first._rejected_reason).toBe('low-confidence');
    expect(second._rejected_reason).toBe('user-declined');
  });
});

// ---------------------------------------------------------------------------
// PATH TRAVERSAL — mandatory security test
// ---------------------------------------------------------------------------

describe('writeApprovedRules — path traversal (MANDATORY security test)', () => {
  it('rejects a path escaping .claude/rules/ via ../ traversal and does not write the file', async () => {
    const evilRelPath = '.claude/rules/../../evil.md';
    const evilAbsPath = join(tmpDir, 'evil.md');

    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'evil',
          path: evilRelPath,
          content: 'PWNED',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    // The traversal attempt must be blocked — nothing written
    expect(result.written).toBe(0);
    // An error must be collected (not silently dropped)
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    // The evil file must NOT exist outside .claude/rules/
    expect(existsSync(evilAbsPath)).toBe(false);
  });

  it('rejects an absolute path pointing outside the repo', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'abs-escape',
          path: '/tmp/injected-rule.md',
          content: 'INJECTED',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a path inside .claude/ but outside .claude/rules/', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'settings-escape',
          path: '.claude/settings.json',
          content: '{}',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(tmpDir, '.claude', 'settings.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty inputs — zero-work fast path
// ---------------------------------------------------------------------------

describe('writeApprovedRules — empty inputs', () => {
  it('returns { written:0, archived:0, errors:[] } when both approved and rejected are empty', async () => {
    const result = await writeApprovedRules({
      approved: [],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result).toEqual({ written: 0, archived: 0, errors: [] });
  });

  it('returns { written:0, archived:0, errors:[] } when approved and rejected are omitted / undefined', async () => {
    const result = await writeApprovedRules({
      approved: undefined,
      rejected: undefined,
      repoRoot: tmpDir,
    });

    // approved and rejected both coerce to [] → both empty → fast-path
    expect(result).toEqual({ written: 0, archived: 0, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// Error collection — approved item missing content
// ---------------------------------------------------------------------------

describe('writeApprovedRules — error collection (non-fatal)', () => {
  it('collects an error for an approved item with no content and still returns written:0', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'no-content',
          path: '.claude/rules/no-content.md',
          // content deliberately omitted
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'no-content.md'))).toBe(false);
  });

  it('collects an error for an approved item missing path and does not throw', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'no-path',
          // path deliberately omitted
          content: '# some content',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});
