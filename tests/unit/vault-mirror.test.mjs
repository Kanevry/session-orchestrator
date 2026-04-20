import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// vault-mirror emits relative paths using the runtime's path.sep, so normalize
// to forward slashes in assertions for Windows portability (Unix no-op).
const forwardSlashes = (p) => (p ?? '').replaceAll(sep, '/');
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const MIRROR = resolve(process.cwd(), 'scripts/vault-mirror.mjs');

const VALID_LEARNING = JSON.stringify({
  id: 'a1b2c3d4-0001-4000-8000-000000000001',
  type: 'architectural',
  subject: 'cross-repo-deep-session',
  insight: 'Prefer explicit contracts over implicit coupling',
  evidence: 'Three modules broke when shared util changed without notice',
  confidence: 0.9,
  source_session: 'session-2026-04-13',
  created_at: '2026-04-13T10:00:00Z',
  expires_at: '2027-04-13T10:00:00Z',
});

const VALID_SESSION = JSON.stringify({
  session_id: 'session-2026-04-13',
  session_type: 'feature',
  platform: 'claude-code',
  started_at: '2026-04-13T08:00:00Z',
  completed_at: '2026-04-13T10:00:00Z',
  duration_seconds: 7200,
  total_waves: 3,
  total_agents: 6,
  total_files_changed: 12,
  agent_summary: { complete: 5, partial: 1, failed: 0, spiral: 0 },
  waves: [
    { wave: 1, role: 'Planning', agent_count: 1, files_changed: 2, quality: 'ok' },
    { wave: 2, role: 'Implementation', agent_count: 3, files_changed: 8, quality: 'ok' },
    { wave: 3, role: 'QA', agent_count: 2, files_changed: 2, quality: 'ok' },
  ],
  effectiveness: { planned_issues: 3, completed: 3, carryover: 0, emergent: 1, completion_rate: 1.0 },
});

function runMirror(args) {
  return spawnSync('node', [MIRROR, ...args], { encoding: 'utf8' });
}

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'vault-mirror-test-'));
}

describe('vault-mirror CLI', () => {
  let dirs = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    dirs = [];
  });

  function tmp() {
    const d = makeTmpDir();
    dirs.push(d);
    return d;
  }

  function writeJsonl(dir, content) {
    const p = join(dir, 'source.jsonl');
    writeFileSync(p, content + '\n', 'utf8');
    return p;
  }

  it('exits 1 and prints usage when --vault-dir is missing', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror(['--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  it('exits 0 with no stdout output when source file is empty', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, '');
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('happy-path create: session entry produces created action and writes file', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_SESSION);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'session']);

    expect(result.status).toBe(0);
    const line = JSON.parse(result.stdout.trim());
    expect(line.action).toBe('created');
    expect(line.kind).toBe('session');
    expect(line.id).toBe('session-2026-04-13');
    expect(forwardSlashes(line.path)).toBe('50-sessions/session-2026-04-13.md');

    const filePath = join(vaultDir, '50-sessions', 'session-2026-04-13.md');
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('_generator: session-orchestrator-vault-mirror@1');
    expect(content).toContain('type: session');
  });

  it('idempotent re-run: second invocation returns skipped-noop', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    // First run — create
    const first = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout.trim()).action).toBe('created');

    // Second run — idempotent
    const second = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout.trim()).action).toBe('skipped-noop');
  });

  it('hand-written protection: file without _generator is left unchanged', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    const learningsDir = join(vaultDir, '40-learnings');
    mkdirSync(learningsDir, { recursive: true });
    const targetFile = join(learningsDir, 'cross-repo-deep-session.md');
    const handWrittenContent = [
      '---',
      'id: cross-repo-deep-session',
      'type: learning',
      'title: Manual Entry',
      'status: draft',
      'created: 2026-01-01',
      'updated: 2026-01-01',
      'tags: [learning/manual]',
      '---',
      '',
      'HAND WRITTEN DO NOT TOUCH',
    ].join('\n');
    writeFileSync(targetFile, handWrittenContent, 'utf8');

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).action).toBe('skipped-handwritten');
    expect(readFileSync(targetFile, 'utf8')).toBe(handWrittenContent);
  });

  it('skipped-invalid: entry missing required field emits skipped-invalid and exits 0', () => {
    const vaultDir = tmp();
    // Learning entry without the required 'insight' field
    const invalidEntry = JSON.stringify({
      id: 'a1b2c3d4-0001-4000-8000-000000000001',
      type: 'architectural',
      subject: 'cross-repo-deep-session',
      evidence: 'some evidence',
      confidence: 0.9,
      source_session: 'session-2026-04-13',
      created_at: '2026-04-13T10:00:00Z',
    });
    const sourceFile = writeJsonl(vaultDir, invalidEntry);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).action).toBe('skipped-invalid');
  });

  it('exits 2 when vault-dir does not exist', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror(['--vault-dir', '/nonexistent/path/99999', '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('vault-dir not found');
  });

  it('happy-path create: learning entry produces created action at 40-learnings path', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);

    expect(result.status).toBe(0);
    const line = JSON.parse(result.stdout.trim());
    expect(line.action).toBe('created');
    expect(forwardSlashes(line.path)).toBe('40-learnings/cross-repo-deep-session.md');
  });

  // ── Hand-written protection (additional coverage) ─────────────────────────

  it('hand-written protection: exits 0 when pre-existing file has no _generator', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    writeFileSync(
      join(vaultDir, '40-learnings', 'cross-repo-deep-session.md'),
      [
        '---',
        'id: cross-repo-deep-session',
        'type: learning',
        'title: Manual Entry',
        'status: draft',
        'created: 2026-01-01',
        'updated: 2026-01-01',
        'tags: [learning/manual]',
        '---',
        '',
        'HAND WRITTEN DO NOT TOUCH',
      ].join('\n'),
      'utf8',
    );

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
  });

  it('hand-written protection: file body still contains sentinel text after run', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const targetFile = join(vaultDir, '40-learnings', 'cross-repo-deep-session.md');

    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    writeFileSync(
      targetFile,
      [
        '---',
        'id: cross-repo-deep-session',
        'type: learning',
        'title: Manual Entry',
        'status: draft',
        'created: 2026-01-01',
        'updated: 2026-01-01',
        'tags: [learning/manual]',
        '---',
        '',
        'HAND WRITTEN DO NOT TOUCH',
      ].join('\n'),
      'utf8',
    );

    runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);

    expect(readFileSync(targetFile, 'utf8')).toContain('HAND WRITTEN DO NOT TOUCH');
  });

  it('hand-written protection: original content preserved byte-for-byte', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const targetFile = join(vaultDir, '40-learnings', 'cross-repo-deep-session.md');

    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    const originalContent = [
      '---',
      'id: cross-repo-deep-session',
      'type: learning',
      'title: Manual Entry',
      'status: draft',
      'created: 2026-01-01',
      'updated: 2026-01-01',
      'tags: [learning/manual]',
      '---',
      '',
      'HAND WRITTEN DO NOT TOUCH',
    ].join('\n');
    writeFileSync(targetFile, originalContent, 'utf8');

    runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);

    expect(readFileSync(targetFile, 'utf8')).toBe(originalContent);
  });

  // ── Slug collision + UUID disambiguation ──────────────────────────────────

  it('collision disambiguation: both files exist after run', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    writeFileSync(
      join(vaultDir, '40-learnings', 'cross-repo-deep-session.md'),
      [
        '---',
        'id: unrelated-learning-id',
        'type: learning',
        'title: Existing note with different id',
        'status: verified',
        'created: 2026-01-01',
        'updated: 2026-01-01',
        'tags: [learning/architectural]',
        '_generator: session-orchestrator-vault-mirror@1',
        '---',
        '',
        'This file belongs to a different entry.',
      ].join('\n'),
      'utf8',
    );

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(existsSync(join(vaultDir, '40-learnings', 'cross-repo-deep-session.md'))).toBe(true);
    expect(existsSync(join(vaultDir, '40-learnings', 'cross-repo-deep-session-a1b2c3d4.md'))).toBe(true);
  });

  it('collision disambiguation: original file is unchanged after run', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const origFile = join(vaultDir, '40-learnings', 'cross-repo-deep-session.md');

    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    const origContent = [
      '---',
      'id: unrelated-learning-id',
      'type: learning',
      'title: Existing note with different id',
      'status: verified',
      'created: 2026-01-01',
      'updated: 2026-01-01',
      'tags: [learning/architectural]',
      '_generator: session-orchestrator-vault-mirror@1',
      '---',
      '',
      'This file belongs to a different entry.',
    ].join('\n');
    writeFileSync(origFile, origContent, 'utf8');

    runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);

    expect(readFileSync(origFile, 'utf8')).toBe(origContent);
  });

  it('collision disambiguation: stdout action is skipped-collision-resolved', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    writeFileSync(
      join(vaultDir, '40-learnings', 'cross-repo-deep-session.md'),
      [
        '---',
        'id: unrelated-learning-id',
        'type: learning',
        'title: Existing note with different id',
        'status: verified',
        'created: 2026-01-01',
        'updated: 2026-01-01',
        'tags: [learning/architectural]',
        '_generator: session-orchestrator-vault-mirror@1',
        '---',
        '',
        'This file belongs to a different entry.',
      ].join('\n'),
      'utf8',
    );

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).action).toBe('skipped-collision-resolved');
  });

  it('collision disambiguation: disambiguated slug uses first-8-chars of uuid', () => {
    // id "a1b2c3d4-0001-4000-8000-000000000001" → stripped hyphens → "a1b2c3d4" prefix
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    writeFileSync(
      join(vaultDir, '40-learnings', 'cross-repo-deep-session.md'),
      [
        '---',
        'id: unrelated-learning-id',
        'type: learning',
        'title: Existing note with different id',
        'status: verified',
        'created: 2026-01-01',
        'updated: 2026-01-01',
        'tags: [learning/architectural]',
        '_generator: session-orchestrator-vault-mirror@1',
        '---',
        '',
        'This file belongs to a different entry.',
      ].join('\n'),
      'utf8',
    );

    runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);

    expect(existsSync(join(vaultDir, '40-learnings', 'cross-repo-deep-session-a1b2c3d4.md'))).toBe(true);
  });

  // ── Malformed JSONL → exit 1 ──────────────────────────────────────────────

  it('malformed JSONL: exit code is 1', () => {
    const vaultDir = tmp();
    // One valid line then a truncated/broken JSON line
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING + '\n{"id":\n');

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(1);
  });

  it('malformed JSONL: stderr contains an error message', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING + '\n{"id":\n');

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  });

  // ── Dry-run mode ──────────────────────────────────────────────────────────

  it('dry-run: exits 0 with --dry-run flag', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning', '--dry-run']);
    expect(result.status).toBe(0);
  });

  it('dry-run: no .md files written under 40-learnings/', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning', '--dry-run']);

    const learningsDir = join(vaultDir, '40-learnings');
    if (existsSync(learningsDir)) {
      const mdFiles = readdirSync(learningsDir).filter((f) => f.endsWith('.md'));
      expect(mdFiles.length).toBe(0);
    } else {
      // Directory not created at all is also acceptable
      expect(existsSync(learningsDir)).toBe(false);
    }
  });

  it('dry-run: stdout still reports a JSON action line', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    // Must be parseable JSON with an action field
    const line = JSON.parse(result.stdout.trim());
    expect(typeof line.action).toBe('string');
  });

  // ── Slug derivation edge cases ────────────────────────────────────────────

  it('slug: subject with slashes collapses to last segment', () => {
    // "libs/node/cross-repo" → last segment "cross-repo"
    const entry = JSON.stringify({
      id: 'a1b2c3d4-0001-4000-8000-000000000001',
      type: 'architectural',
      subject: 'libs/node/cross-repo',
      insight: 'Prefer explicit contracts',
      evidence: 'Three modules broke',
      confidence: 0.9,
      source_session: 'session-2026-04-13',
      created_at: '2026-04-13T10:00:00Z',
      expires_at: '2027-04-13T10:00:00Z',
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, entry);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(existsSync(join(vaultDir, '40-learnings', 'cross-repo.md'))).toBe(true);
  });

  it('slug: invalid slug (all special chars) falls back to learning-<first8-uuid>', () => {
    // "!!!@@###" → empty after stripping → fallback: learning-a1b2c3d4
    const entry = JSON.stringify({
      id: 'a1b2c3d4-0001-4000-8000-000000000001',
      type: 'architectural',
      subject: '!!!@@###',
      insight: 'Prefer explicit contracts',
      evidence: 'Three modules broke',
      confidence: 0.9,
      source_session: 'session-2026-04-13',
      created_at: '2026-04-13T10:00:00Z',
      expires_at: '2027-04-13T10:00:00Z',
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, entry);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(existsSync(join(vaultDir, '40-learnings', 'learning-a1b2c3d4.md'))).toBe(true);
  });

  it('slug: dots and underscores in subject are replaced with hyphens', () => {
    // "use.strict_mode" → "use-strict-mode"
    const entry = JSON.stringify({
      id: 'a1b2c3d4-0001-4000-8000-000000000001',
      type: 'architectural',
      subject: 'use.strict_mode',
      insight: 'Prefer explicit contracts',
      evidence: 'Three modules broke',
      confidence: 0.9,
      source_session: 'session-2026-04-13',
      created_at: '2026-04-13T10:00:00Z',
      expires_at: '2027-04-13T10:00:00Z',
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, entry);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(existsSync(join(vaultDir, '40-learnings', 'use-strict-mode.md'))).toBe(true);
  });

  it('slug: spaces in subject are stripped (not converted to hyphens)', () => {
    // "hello world" → "helloworld" (spaces are not in [a-z0-9-])
    const entry = JSON.stringify({
      id: 'a1b2c3d4-0001-4000-8000-000000000001',
      type: 'architectural',
      subject: 'hello world',
      insight: 'Prefer explicit contracts',
      evidence: 'Three modules broke',
      confidence: 0.9,
      source_session: 'session-2026-04-13',
      created_at: '2026-04-13T10:00:00Z',
      expires_at: '2027-04-13T10:00:00Z',
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, entry);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(existsSync(join(vaultDir, '40-learnings', 'helloworld.md'))).toBe(true);
  });

  // ── Session entry missing agent_summary → skipped-invalid ─────────────────

  it('session entry missing agent_summary emits skipped-invalid', () => {
    const invalidSession = JSON.stringify({
      session_id: 'session-2026-04-13',
      session_type: 'feature',
      platform: 'claude-code',
      started_at: '2026-04-13T08:00:00Z',
      completed_at: '2026-04-13T10:00:00Z',
      duration_seconds: 7200,
      total_waves: 3,
      total_agents: 6,
      total_files_changed: 12,
      waves: [{ wave: 1, role: 'Planning', agent_count: 1, files_changed: 2, quality: 'ok' }],
      effectiveness: {
        planned_issues: 3,
        completed: 3,
        carryover: 0,
        emergent: 1,
        completion_rate: 1.0,
      },
      // agent_summary intentionally omitted
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, invalidSession);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'session']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).action).toBe('skipped-invalid');
  });

  // ── Dry-run mkdir guard ────────────────────────────────────────────────────

  it('dry-run does not create target directory', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

    expect(existsSync(join(vaultDir, '40-learnings'))).toBe(false);

    runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning', '--dry-run']);

    expect(existsSync(join(vaultDir, '40-learnings'))).toBe(false);
  });

  // ── session_id special-char fallback ──────────────────────────────────────

  it('session_id with uppercase uses slug fallback session-<first8>', () => {
    // session_id "A1B2C3D4-0001-4000-8000-000000000001" → not a valid slug (uppercase)
    const entry = JSON.stringify({
      session_id: 'A1B2C3D4-0001-4000-8000-000000000001',
      session_type: 'feature',
      platform: 'claude-code',
      started_at: '2026-04-13T08:00:00Z',
      completed_at: '2026-04-13T10:00:00Z',
      duration_seconds: 7200,
      total_waves: 3,
      total_agents: 6,
      total_files_changed: 12,
      agent_summary: { complete: 5, partial: 1, failed: 0, spiral: 0 },
      waves: [{ wave: 1, role: 'Planning', agent_count: 1, files_changed: 2, quality: 'ok' }],
      effectiveness: {
        planned_issues: 3,
        completed: 3,
        carryover: 0,
        emergent: 1,
        completion_rate: 1.0,
      },
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, entry);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'session']);
    expect(result.status).toBe(0);
    // Must NOT be the literal uppercase session_id as filename
    expect(existsSync(join(vaultDir, '50-sessions', 'A1B2C3D4-0001-4000-8000-000000000001.md'))).toBe(false);
    // Fallback file must exist
    expect(existsSync(join(vaultDir, '50-sessions', 'session-A1B2C3D4.md'))).toBe(true);
  });

  // ── CLI argument validation (additional) ──────────────────────────────────

  it('missing --source: exits 1', () => {
    const vaultDir = tmp();
    const result = runMirror(['--vault-dir', vaultDir, '--kind', 'learning']);
    expect(result.status).toBe(1);
  });

  it('invalid --kind value: exits 1', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'unknown']);
    expect(result.status).toBe(1);
  });

  it('non-existent source file: exits 2', () => {
    const vaultDir = tmp();
    const result = runMirror(['--vault-dir', vaultDir, '--source', '/nonexistent/99999.jsonl', '--kind', 'learning']);
    expect(result.status).toBe(2);
  });
});
