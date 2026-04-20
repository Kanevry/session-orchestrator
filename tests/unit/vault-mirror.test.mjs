import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
    expect(line.path).toBe('50-sessions/session-2026-04-13.md');

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
    expect(line.path).toBe('40-learnings/cross-repo-deep-session.md');
  });
});
