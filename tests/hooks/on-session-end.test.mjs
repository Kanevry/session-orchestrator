/**
 * tests/hooks/on-session-end.test.mjs
 *
 * Tests for hooks/on-session-end.mjs — SessionEnd hook emitting
 * `orchestrator.session.ended` (Track A, issue #609 / epic #608).
 *
 * Strategy: spawn `node hooks/on-session-end.mjs` with controlled stdin +
 * CLAUDE_PROJECT_DIR, then read the written events.jsonl to verify record shape.
 * Each test gets an isolated tmp project dir so parallel runs cannot interfere.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOOK = path.resolve(import.meta.dirname, '../../hooks/on-session-end.mjs');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-session-end-'));
  tmpDirs.push(dir);
  return dir;
}

/** Seed .orchestrator/current-session.json (as on-session-start.mjs writes it). */
async function seedCurrentSession(projectDir, { sessionId, timestamp }) {
  const dir = path.join(projectDir, '.orchestrator');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'current-session.json'),
    JSON.stringify({ session_id: sessionId, timestamp }),
  );
}

async function runHook({ projectDir, stdin = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function readLastEvent(projectDir) {
  const content = await fs.readFile(path.join(projectDir, EVENTS_REL), 'utf8');
  const lines = content.trim().split('\n').filter((l) => l.length > 0);
  return JSON.parse(lines[lines.length - 1]);
}

describe('on-session-end.mjs — SessionEnd event', { timeout: 15000 }, () => {
  it('exits 0', async () => {
    const dir = await mkProject();
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-1', reason: 'clear' }),
    });
    expect(result.code).toBe(0);
  });

  it('writes event="orchestrator.session.ended" to events.jsonl', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-1', reason: 'clear' }),
    });
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
  });

  it('records reason from stdin', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-1', reason: 'logout' }),
    });
    const record = await readLastEvent(dir);
    expect(record.reason).toBe('logout');
  });

  it('defaults reason to "other" when stdin omits it', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-1' }),
    });
    const record = await readLastEvent(dir);
    expect(record.reason).toBe('other');
  });

  it('records session_id from stdin', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-explicit' }),
    });
    const record = await readLastEvent(dir);
    expect(record.session_id).toBe('sess-explicit');
  });

  it('falls back to current-session.json session_id when stdin omits it', async () => {
    const dir = await mkProject();
    await seedCurrentSession(dir, { sessionId: 'recorded-1', timestamp: new Date(Date.now() - 5000).toISOString() });
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'exit' }),
    });
    const record = await readLastEvent(dir);
    expect(record.session_id).toBe('recorded-1');
  });

  it('computes duration_ms when the ending session is the recorded one', async () => {
    const dir = await mkProject();
    await seedCurrentSession(dir, { sessionId: 'sess-dur', timestamp: new Date(Date.now() - 5000).toISOString() });
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-dur' }),
    });
    const record = await readLastEvent(dir);
    expect(record.duration_ms).toBeGreaterThanOrEqual(4000);
    expect(record.duration_ms).toBeLessThan(60000);
  });

  it('duration_ms is 0 when ending session differs from recorded session', async () => {
    const dir = await mkProject();
    await seedCurrentSession(dir, { sessionId: 'OTHER', timestamp: new Date(Date.now() - 5000).toISOString() });
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-mismatch' }),
    });
    const record = await readLastEvent(dir);
    expect(record.duration_ms).toBe(0);
  });

  it('duration_ms is 0 when no current-session.json exists', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-nofile' }),
    });
    const record = await readLastEvent(dir);
    expect(record.duration_ms).toBe(0);
  });

  it('exits 0 and writes a record even with empty stdin (graceful degradation)', async () => {
    const dir = await mkProject();
    const result = await runHook({ projectDir: dir, stdin: '' });
    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
    expect(record.reason).toBe('other');
  });

  it('record carries an ISO 8601 timestamp', async () => {
    const dir = await mkProject();
    await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-ts' }),
    });
    const record = await readLastEvent(dir);
    expect(typeof record.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
  });

  it('degrades to duration_ms 0 when current-session.json is malformed JSON', async () => {
    const dir = await mkProject();
    const od = path.join(dir, '.orchestrator');
    await fs.mkdir(od, { recursive: true });
    await fs.writeFile(path.join(od, 'current-session.json'), '{ not valid json');
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-x' }),
    });
    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record.event).toBe('orchestrator.session.ended');
    expect(record.session_id).toBe('sess-x');
    expect(record.duration_ms).toBe(0);
  });

  it('degrades to duration_ms 0 when recorded timestamp is a non-string', async () => {
    const dir = await mkProject();
    await seedCurrentSession(dir, { sessionId: 'sess-ts', timestamp: 123456 });
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess-ts' }),
    });
    expect(result.code).toBe(0);
    const record = await readLastEvent(dir);
    expect(record.duration_ms).toBe(0);
  });
});
