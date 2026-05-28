/**
 * tests/scripts/compute-grounding-injection.test.mjs
 *
 * Behavioural test for scripts/compute-grounding-injection.sh's event emission
 * (issue #611). The shell now routes its grounding event through
 * scripts/emit-event.mjs → emitEvent() instead of a hand-rolled `jq >> file`.
 *
 * The test drives the shell as a REAL subprocess with a fully-populated fixture
 * (events.jsonl with a matching stagnation entry, sessions.jsonl, an in-scope
 * candidate file, PERSISTENCE=true) and asserts the emitted record:
 *   - has event == "orchestrator.grounding.injected" (the dotted rename), and
 *   - carries the consumer-visible payload fields
 *     session, wave, agent, file, lines, grounding_capped, plus the
 *     emitEvent-generated `timestamp`.
 *
 * Guarded: skips if jq is unavailable (the shell no-ops without it).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'compute-grounding-injection.sh');

const HAS_JQ = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'grounding-inject-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a complete fixture that drives the shell to emit exactly one grounding
 * event for `targetFile`, then run it.
 *
 * @returns {{ status: number, stdout: string, eventsPath: string }}
 */
function runWithFixture() {
  const sessionId = 'main-2026-05-28-session-1';

  // sessions.jsonl — one entry so LAST_SESSIONS contains our session_id.
  const sessionsPath = join(tmpDir, 'sessions.jsonl');
  writeFileSync(sessionsPath, JSON.stringify({ session_id: sessionId }) + '\n', 'utf8');

  // The candidate file must exist + be readable (the shell skips otherwise).
  const targetFile = join(tmpDir, 'flaky-module.mjs');
  writeFileSync(targetFile, 'line 1\nline 2\nline 3\n', 'utf8');

  // events.jsonl — a stagnation_detected / edit-format-friction entry whose
  // .session is in LAST_SESSIONS and .file is the candidate. This is the input
  // the shell matches on; the grounding event is APPENDED to the same file.
  const eventsPath = join(tmpDir, 'events.jsonl');
  const seed = {
    timestamp: '2026-05-28T10:00:00Z',
    event: 'stagnation_detected',
    error_class: 'edit-format-friction',
    session: sessionId,
    file: targetFile,
  };
  writeFileSync(eventsPath, JSON.stringify(seed) + '\n', 'utf8');

  const res = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MAX_FILES: '5',
      EVENTS_JSONL: eventsPath,
      SESSIONS_JSONL: sessionsPath,
      AGENT_FILES: targetFile, // literal in-scope match
      PERSISTENCE: 'true',
      SESSION_ID: sessionId,
      WAVE: '3',
      AGENT_TYPE: 'code-implementer',
    },
  });

  return { stdout: res, eventsPath, targetFile, sessionId };
}

describe('compute-grounding-injection.sh — event emission (#611)', () => {
  it.skipIf(!HAS_JQ)('emits an orchestrator.grounding.injected record with the expected payload', () => {
    const { stdout, eventsPath, targetFile, sessionId } = runWithFixture();

    // The GROUNDING block is printed to stdout (proves the file was selected).
    expect(stdout).toContain(`## GROUNDING — ${targetFile}`);

    // The events.jsonl now has 2 lines: the seed + the appended grounding event.
    const lines = readFileSync(eventsPath, 'utf8').trim().split('\n').filter((l) => l.length > 0);
    const records = lines.map((l) => JSON.parse(l));

    const grounding = records.find((r) => r.event === 'orchestrator.grounding.injected');
    expect(grounding).toBeDefined();

    // Dotted rename — NOT the legacy bare name.
    expect(grounding.event).toBe('orchestrator.grounding.injected');
    expect(records.some((r) => r.event === 'grounding_injected')).toBe(false);

    // Consumer-visible payload fields preserved.
    expect(grounding.session).toBe(sessionId);
    expect(grounding.wave).toBe(3);
    expect(grounding.agent).toBe('code-implementer');
    expect(grounding.file).toBe(targetFile);
    expect(grounding.lines).toBe(3);
    expect(grounding.grounding_capped).toBe(false);

    // emitEvent() supplies the canonical timestamp (the shell drops its own $ts).
    expect(grounding.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it.skipIf(!HAS_JQ)('does not emit when PERSISTENCE is not "true"', () => {
    const sessionId = 'main-2026-05-28-session-1';
    const sessionsPath = join(tmpDir, 'sessions.jsonl');
    writeFileSync(sessionsPath, JSON.stringify({ session_id: sessionId }) + '\n', 'utf8');
    const targetFile = join(tmpDir, 'flaky.mjs');
    writeFileSync(targetFile, 'a\nb\n', 'utf8');
    const eventsPath = join(tmpDir, 'events.jsonl');
    writeFileSync(
      eventsPath,
      JSON.stringify({
        timestamp: '2026-05-28T10:00:00Z',
        event: 'stagnation_detected',
        error_class: 'edit-format-friction',
        session: sessionId,
        file: targetFile,
      }) + '\n',
      'utf8',
    );

    execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MAX_FILES: '5',
        EVENTS_JSONL: eventsPath,
        SESSIONS_JSONL: sessionsPath,
        AGENT_FILES: targetFile,
        PERSISTENCE: 'false', // disabled — no event should be appended
        SESSION_ID: sessionId,
        WAVE: '3',
        AGENT_TYPE: 'code-implementer',
      },
    });

    const records = readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    // Only the seed remains — no grounding event appended.
    expect(records).toHaveLength(1);
    expect(records[0].event).toBe('stagnation_detected');
  });
});
