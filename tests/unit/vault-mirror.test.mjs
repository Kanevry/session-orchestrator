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

  // ── --strict-schema flag (Issue #249 follow-up) ──────────────────────────
  describe('--strict-schema', () => {
    it('exits 1 and emits strict-schema-abort when any entry is skipped-invalid', () => {
      const vaultDir = tmp();
      const invalidEntry = JSON.stringify({
        id: 'a1b2c3d4-0001-4000-8000-000000000002',
        type: 'architectural',
        subject: 'strict-schema-probe',
        // insight missing → skipped-invalid
        evidence: 'evidence',
        confidence: 0.9,
        source_session: 'session-2026-04-24',
        created_at: '2026-04-24T10:00:00Z',
      });
      const sourceFile = writeJsonl(vaultDir, invalidEntry);

      const result = runMirror([
        '--vault-dir', vaultDir,
        '--source', sourceFile,
        '--kind', 'learning',
        '--strict-schema',
      ]);

      expect(result.status).toBe(1);
      const outLines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
      expect(outLines[0].action).toBe('skipped-invalid');
      const abort = outLines[outLines.length - 1];
      expect(abort.action).toBe('strict-schema-abort');
      expect(abort.skipped).toBe(1);
      expect(abort.kind).toBe('learning');
      expect(result.stderr).toContain('strict-schema');
    });

    it('exits 0 when all entries pass validation (flag is no-op)', () => {
      const vaultDir = tmp();
      const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);

      const result = runMirror([
        '--vault-dir', vaultDir,
        '--source', sourceFile,
        '--kind', 'learning',
        '--strict-schema',
      ]);

      expect(result.status).toBe(0);
      // No strict-schema-abort line on clean runs
      const stdout = result.stdout.trim();
      expect(stdout).not.toMatch(/strict-schema-abort/);
    });

    it('default behavior (no --strict-schema) still exits 0 on skipped-invalid', () => {
      const vaultDir = tmp();
      const invalidEntry = JSON.stringify({
        id: 'a1b2c3d4-0001-4000-8000-000000000003',
        type: 'architectural',
        subject: 'lenient-default-probe',
        evidence: 'e',
        confidence: 0.9,
        source_session: 'session-2026-04-24',
        created_at: '2026-04-24T10:00:00Z',
      });
      const sourceFile = writeJsonl(vaultDir, invalidEntry);

      const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim()).action).toBe('skipped-invalid');
    });
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

  // ── source_session sanitisation (regression: corrupted "[object" upstream) ──

  it('source_session with YAML-breaking chars is sanitised in tags line', () => {
    // Regression: 3 learnings on 2026-04-23 had source_session="[object" (an
    // upstream evolve-skill bug coerced an Object to String). Without the
    // subjectToSlug guard, the tags line emitted `source/[object]` which is
    // invalid YAML flow-array syntax (unbalanced bracket). Verify the slugger
    // strips the bracket and produces a valid tag.
    const entry = JSON.stringify({
      id: 'a1b2c3d4-0001-4000-8000-000000000099',
      type: 'architectural',
      subject: 'broken-source-session-recovery',
      insight: 'Prefer explicit contracts',
      evidence: 'Probe entry for sanitisation',
      confidence: 0.5,
      source_session: '[object',
      created_at: '2026-04-23T18:19:24Z',
      expires_at: '2026-05-23T00:00:00Z',
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, entry);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);

    const md = readFileSync(
      join(vaultDir, '40-learnings', 'broken-source-session-recovery.md'),
      'utf8',
    );
    // Tags line must be valid YAML: no '[' or ']' inside source/ segment
    expect(md).toMatch(/^tags: \[learning\/architectural, status\/draft, source\/object\]$/m);
    expect(md).not.toContain('source/[object');
  });

  it('source_session that sanitises to empty falls back to "unknown"', () => {
    // If subjectToSlug strips everything, sourceTag must default to a
    // schema-valid placeholder rather than emitting `source/`.
    const entry = JSON.stringify({
      id: 'a1b2c3d4-0001-4000-8000-000000000098',
      type: 'architectural',
      subject: 'empty-source-session-recovery',
      insight: 'Prefer explicit contracts',
      evidence: 'Probe entry for fallback',
      confidence: 0.5,
      source_session: '!!!@@###',
      created_at: '2026-04-23T18:19:24Z',
      expires_at: '2026-05-23T00:00:00Z',
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, entry);

    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);

    const md = readFileSync(
      join(vaultDir, '40-learnings', 'empty-source-session-recovery.md'),
      'utf8',
    );
    expect(md).toMatch(/^tags: \[learning\/architectural, status\/draft, source\/unknown\]$/m);
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

  it('session_id with uppercase: sanitised via subjectToSlug (lowercased), no fallback to uuid prefix', () => {
    // session_id "A1B2C3D4-0001-4000-8000-000000000001" → not a valid slug (uppercase)
    // The fallback path runs subjectToSlug first, which lowercases. The lowercased form
    // is a valid slug, so the full lowercased id becomes the basename. Pre-2026-04 the
    // fallback truncated to session-<first8 uppercase>; the new behaviour preserves
    // information instead of truncating.
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
    // Use readdirSync to check actual on-disk casing (existsSync is case-insensitive on macOS APFS)
    const files = readdirSync(join(vaultDir, '50-sessions'));
    expect(files).toContain('a1b2c3d4-0001-4000-8000-000000000001.md');
    expect(files).not.toContain('A1B2C3D4-0001-4000-8000-000000000001.md');
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

  // ── v2 schema: learning with id/text/scope/first_seen ─────────────────────
  // Producer schema introduced in S69+ (id is a kebab slug, no UUID, no subject/insight/evidence).
  // Regression guard for the bug where `subjectToSlug(undefined)` crashed with exit 2 on the
  // first v2 line, halting all subsequent processing.

  const VALID_LEARNING_V2 = JSON.stringify({
    id: 's69-compose-pids-cross-validation',
    type: 'gotcha',
    scope: 'infrastructure/docker-compose',
    first_seen: '2026-04-19',
    confidence: 0.85,
    decay: 0.05,
    text: 'docker-compose v2 cross-validates top-level pids_limit against deploy.resources.limits.pids.',
  });

  it('v2 learning: created action with slug derived from id', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING_V2);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);

    expect(result.status).toBe(0);
    const line = JSON.parse(result.stdout.trim());
    expect(line.action).toBe('created');
    expect(forwardSlashes(line.path)).toBe('40-learnings/s69-compose-pids-cross-validation.md');

    const content = readFileSync(join(vaultDir, '40-learnings', 's69-compose-pids-cross-validation.md'), 'utf8');
    expect(content).toContain('_generator: session-orchestrator-vault-mirror@1');
    expect(content).toContain('type: learning');
    expect(content).toContain('docker-compose v2 cross-validates');
    expect(content).toContain('scope/docker-compose');
  });

  it('v2 learning: idempotent re-run returns skipped-noop', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING_V2);

    runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    const second = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout.trim()).action).toBe('skipped-noop');
  });

  it('mixed v1+v2 learnings in same JSONL: both create, no crash (regression guard)', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING + '\n' + VALID_LEARNING_V2);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.action === 'created')).toBe(true);
    expect(existsSync(join(vaultDir, '40-learnings', 'cross-repo-deep-session.md'))).toBe(true);
    expect(existsSync(join(vaultDir, '40-learnings', 's69-compose-pids-cross-validation.md'))).toBe(true);
  });

  it('v2 learning missing required field "scope": skipped-invalid (no crash)', () => {
    const invalid = JSON.stringify({
      id: 's69-something',
      type: 'gotcha',
      first_seen: '2026-04-19',
      confidence: 0.5,
      text: 'some insight',
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, invalid);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).action).toBe('skipped-invalid');
  });

  it('learning with no id and no subject: skipped-invalid (no crash)', () => {
    // Pre-fix this would crash on subjectToSlug(undefined).includes('/').
    const invalid = JSON.stringify({ type: 'gotcha', confidence: 0.5 });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, invalid);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).action).toBe('skipped-invalid');
  });

  // ── v2 schema: session with files_changed/issues_closed (no total_agents) ─

  const VALID_SESSION_V2 = JSON.stringify({
    session_id: 'main-2026-04-19-0608',
    session_type: 'deep',
    started_at: '2026-04-19T06:08:00Z',
    completed_at: '2026-04-19T06:35:00Z',
    duration_seconds: 1968,
    branch: 'main',
    planned_issues: 1,
    waves: [
      { wave: 1, role: 'Discovery', agents: 4, dispatch: 'parallel', duration_s: 180, agents_done: 4, agents_partial: 0, agents_failed: 0 },
      { wave: 2, role: 'Impl-Core', agents: 5, dispatch: 'coordinator-inline', duration_s: 480, agents_done: 5, agents_partial: 0, agents_failed: 0 },
    ],
    issues_closed: [44],
    issues_created: [179, 181, 'products/eventdrop-render-service#23'],
    files_changed: 7,
    effectiveness: { completion_rate: 1.0, carryover: 0 },
    notes: 'Test note body.',
  });

  it('v2 session: created action with content derived from waves/files_changed', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_SESSION_V2);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'session']);

    expect(result.status).toBe(0);
    const line = JSON.parse(result.stdout.trim());
    expect(line.action).toBe('created');
    expect(forwardSlashes(line.path)).toBe('50-sessions/main-2026-04-19-0608.md');

    const content = readFileSync(join(vaultDir, '50-sessions', 'main-2026-04-19-0608.md'), 'utf8');
    expect(content).toContain('Agents:** 9'); // sum of 4 + 5
    expect(content).toContain('Files changed:** 7');
    expect(content).toContain('Branch:** main');
    expect(content).toContain('| 1 | Discovery | 4 | parallel');
    expect(content).toContain('Issues closed:** 44');
    expect(content).toContain('## Notes');
  });

  it('session_id with slashes: sanitised via subjectToSlug, no slash leaks into basename', () => {
    // Pre-fix: session_id "feat/opus-4-7-phase-2-2026-04-17" would crash with ENOENT
    // because the fallback only stripped hyphens, leaving the slash intact.
    const entry = JSON.stringify({
      session_id: 'feat/opus-4-7-phase-2-2026-04-17-0800',
      session_type: 'feature',
      platform: 'claude-code',
      started_at: '2026-04-17T08:00:00Z',
      completed_at: '2026-04-17T09:00:00Z',
      duration_seconds: 3600,
      total_waves: 1,
      total_agents: 1,
      total_files_changed: 1,
      agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
      waves: [{ wave: 1, role: 'X', agent_count: 1, files_changed: 1, quality: 'ok' }],
      effectiveness: { planned_issues: 1, completed: 1, carryover: 0, emergent: 0, completion_rate: 1.0 },
    });
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, entry);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'session']);
    expect(result.status).toBe(0);
    const line = JSON.parse(result.stdout.trim());
    expect(line.action).toBe('created');
    // Last path segment of the slashy id is what subjectToSlug picks up
    expect(forwardSlashes(line.path)).toBe('50-sessions/opus-4-7-phase-2-2026-04-17-0800.md');
  });

  it('mixed v1+v2 sessions in same JSONL: both create, no skipped-invalid', () => {
    const vaultDir = tmp();
    const sourceFile = writeJsonl(vaultDir, VALID_SESSION + '\n' + VALID_SESSION_V2);
    const result = runMirror(['--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'session']);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.action === 'created')).toBe(true);
  });
});

// ── Auto-commit (#31) ─────────────────────────────────────────────────────────

describe('vault-mirror auto-commit (#31)', () => {
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

  function gitInit(vaultDir) {
    spawnSync('git', ['-C', vaultDir, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vaultDir, 'config', 'user.email', 'test@example.com'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vaultDir, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vaultDir, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf8' });
    // Initial commit so HEAD exists
    writeFileSync(join(vaultDir, '.gitkeep'), '', 'utf8');
    spawnSync('git', ['-C', vaultDir, 'add', '.gitkeep'], { encoding: 'utf8' });
    spawnSync('git', ['-C', vaultDir, 'commit', '-q', '-m', 'init'], { encoding: 'utf8' });
  }

  function gitLog(vaultDir) {
    const r = spawnSync('git', ['-C', vaultDir, 'log', '--oneline'], { encoding: 'utf8' });
    return r.stdout.trim().split('\n').filter(Boolean);
  }

  function gitStatus(vaultDir) {
    const r = spawnSync('git', ['-C', vaultDir, 'status', '--porcelain'], { encoding: 'utf8' });
    return r.stdout.trim().split('\n').filter(Boolean);
  }

  it('happy path: writes one mirror file and creates an auto-commit with subject', () => {
    const vaultDir = tmp();
    gitInit(vaultDir);
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror([
      '--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning',
      '--session-id', 'test-session-001',
    ]);

    expect(result.status).toBe(0);
    const actions = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const commitAction = actions.find((a) => a.action === 'auto-commit-created');
    expect(commitAction).toBeDefined();
    expect(commitAction.subject).toBe('chore(vault): mirror test-session-001 — 1 learnings + 0 sessions');
    expect(commitAction.learnings).toBe(1);
    expect(commitAction.sessions).toBe(0);

    // History: init + auto-commit = 2
    expect(gitLog(vaultDir)).toHaveLength(2);
    // Mirror dirs are clean post-commit (source.jsonl in vaultDir root is untracked but irrelevant)
    const cached = spawnSync('git', ['-C', vaultDir, 'diff', '--cached', '--name-only', '--', '40-learnings', '50-sessions'], { encoding: 'utf8' });
    expect(cached.stdout.trim()).toBe('');
  });

  it('mismatch: handwritten file in 40-learnings/ unstages and skips commit', () => {
    const vaultDir = tmp();
    gitInit(vaultDir);
    // Plant a non-mirror file in 40-learnings/
    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    writeFileSync(join(vaultDir, '40-learnings', 'handwritten.md'), '---\ntitle: by hand\n---\n\nNo generator marker here.\n', 'utf8');

    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror([
      '--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning',
      '--session-id', 'mismatch-session',
    ]);

    expect(result.status).toBe(0);
    const actions = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const skip = actions.find((a) => a.action === 'auto-commit-skipped');
    expect(skip).toBeDefined();
    expect(skip.reason).toBe('non-mirror-staged-changes');
    expect(skip.offenders).toEqual(expect.arrayContaining([forwardSlashes('40-learnings/handwritten.md')]));

    // No new commit: only init
    expect(gitLog(vaultDir)).toHaveLength(1);
    // Verify nothing was staged for commit (the unstage path worked)
    const cached = spawnSync('git', ['-C', vaultDir, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
    expect(cached.stdout.trim()).toBe('');
    // Handwritten file still on disk, untouched
    expect(existsSync(join(vaultDir, '40-learnings', 'handwritten.md'))).toBe(true);
  });

  it('idempotent no-op: empty input produces no commit and no-staged-changes action', () => {
    const vaultDir = tmp();
    gitInit(vaultDir);
    const sourceFile = writeJsonl(vaultDir, '');
    const result = runMirror([
      '--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning',
      '--session-id', 'noop-session',
    ]);

    expect(result.status).toBe(0);
    // 40-learnings/50-sessions don't exist → no-mirror-dirs OR no-staged-changes (depending)
    const actions = result.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const skipReasons = actions.filter((a) => a.action === 'auto-commit-skipped' || a.action === 'auto-commit-noop')
      .map((a) => a.reason);
    expect(skipReasons.some((r) => r === 'no-mirror-dirs' || r === 'no-staged-changes')).toBe(true);
    expect(gitLog(vaultDir)).toHaveLength(1);
  });

  it('--dry-run skips auto-commit entirely (no writes, no commits)', () => {
    const vaultDir = tmp();
    gitInit(vaultDir);
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror([
      '--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning',
      '--session-id', 'dry-session', '--dry-run',
    ]);

    expect(result.status).toBe(0);
    const actions = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(actions.find((a) => a.action === 'auto-commit-created')).toBeUndefined();
    expect(actions.find((a) => a.action?.startsWith('auto-commit-'))).toBeUndefined();
    expect(gitLog(vaultDir)).toHaveLength(1);
  });

  it('--no-commit writes artifacts but skips commit entirely', () => {
    const vaultDir = tmp();
    gitInit(vaultDir);
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror([
      '--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning',
      '--session-id', 'no-commit-session', '--no-commit',
    ]);

    expect(result.status).toBe(0);
    const actions = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(actions.find((a) => a.action === 'created')).toBeDefined();
    expect(actions.find((a) => a.action?.startsWith('auto-commit-'))).toBeUndefined();
    // Mirror file written but uncommitted
    expect(gitLog(vaultDir)).toHaveLength(1);
    expect(gitStatus(vaultDir).length).toBeGreaterThan(0);
  });

  it('vault without 40-learnings/ or 50-sessions/ dirs reports no-mirror-dirs and no commit', () => {
    const vaultDir = tmp();
    gitInit(vaultDir);
    const sourceFile = writeJsonl(vaultDir, '');
    const result = runMirror([
      '--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning',
      '--session-id', 'empty-vault-session',
    ]);

    expect(result.status).toBe(0);
    const actions = result.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const skip = actions.find((a) => a.action === 'auto-commit-skipped' && a.reason === 'no-mirror-dirs');
    expect(skip).toBeDefined();
    expect(gitLog(vaultDir)).toHaveLength(1);
  });

  it('backlog catchup: 2 pre-existing untracked mirror files plus 1 new file all commit together', () => {
    const vaultDir = tmp();
    gitInit(vaultDir);
    // Plant 2 pre-existing generator-tagged untracked files
    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    writeFileSync(
      join(vaultDir, '40-learnings', 'old-1.md'),
      `---\n_generator: ${'session-orchestrator-vault-mirror@1'}\nid: old-1\n---\n\nOld backlog 1.\n`,
      'utf8',
    );
    mkdirSync(join(vaultDir, '50-sessions'), { recursive: true });
    writeFileSync(
      join(vaultDir, '50-sessions', 'old-2.md'),
      `---\n_generator: ${'session-orchestrator-vault-mirror@1'}\nid: old-2\n---\n\nOld backlog 2.\n`,
      'utf8',
    );

    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror([
      '--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning',
      '--session-id', 'catchup-session',
    ]);

    expect(result.status).toBe(0);
    const actions = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const commit = actions.find((a) => a.action === 'auto-commit-created');
    expect(commit).toBeDefined();
    expect(commit.subject).toBe('chore(vault): mirror catchup-session — 2 learnings + 1 sessions');
    expect(commit.files).toBe(3);
    // source.jsonl lives in vaultDir root (not 40-learnings/ or 50-sessions/) so it
    // remains untracked — that's expected. Only assert mirror dirs are clean.
    const cached = spawnSync('git', ['-C', vaultDir, 'diff', '--cached', '--name-only', '--', '40-learnings', '50-sessions'], { encoding: 'utf8' });
    expect(cached.stdout.trim()).toBe('');
  });

  it('non-git vault directory reports not-a-git-repo and exits cleanly', () => {
    const vaultDir = tmp();
    // Intentionally NO gitInit
    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });
    const sourceFile = writeJsonl(vaultDir, VALID_LEARNING);
    const result = runMirror([
      '--vault-dir', vaultDir, '--source', sourceFile, '--kind', 'learning',
      '--session-id', 'no-git-session',
    ]);

    expect(result.status).toBe(0);
    const actions = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(actions.find((a) => a.action === 'auto-commit-skipped' && a.reason === 'not-a-git-repo')).toBeDefined();
  });
});
