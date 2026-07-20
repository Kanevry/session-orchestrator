// Regression tests for scripts/mcp-server.sh JSON-RPC id handling (issue #650).
//
// The bug: respond()/respond_error() printf-interpolated a bare `$id` extracted
// with `jq -r '.id // empty'`. A JSON-RPC string id like "foo" lost its quotes
// and produced invalid JSON (`"id":foo`), and an absent id became an empty
// string (`"id":,`). JSON-RPC 2.0 permits string ids, so the server must
// re-encode the id as valid JSON. These tests spawn the real shell server,
// feed one request line on stdin, and assert the emitted stdout line is valid
// JSON with the id preserved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive repoRoot portably from this file's location (tests/unit/ -> repo root).
// No hardcoded home path — the owner-leakage CI gate blocks absolute home paths.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const serverScript = join('scripts', 'mcp-server.sh');
const serverScriptAbs = join(repoRoot, serverScript);

/**
 * Spawn the MCP server, feed a single JSON-RPC request line on stdin, and
 * return the first stdout line (the response).
 *
 * @param {object} requestObj
 * @param {string} [cwd] — defaults to repoRoot; pass a temp repo dir to run
 *   the server against a controlled fixture instead of the real repo's own
 *   .orchestrator/metrics/sessions.jsonl.
 */
function runServer(requestObj, cwd = repoRoot) {
  const input = `${JSON.stringify(requestObj)}\n`;
  const result = spawnSync('bash', [serverScriptAbs], {
    input,
    encoding: 'utf8',
    cwd,
  });
  const firstLine = result.stdout.split('\n').find((l) => l.trim().length > 0);
  return { result, firstLine };
}

describe('mcp-server.sh JSON-RPC id handling (#650)', () => {
  it('preserves a string id as a quoted JSON string', () => {
    // The regression case: on the old code this emitted invalid bare `id:foo`,
    // so JSON.parse threw and .id !== "foo".
    const { firstLine } = runServer({
      jsonrpc: '2.0',
      id: 'foo',
      method: 'initialize',
      params: {},
    });
    const parsed = JSON.parse(firstLine);
    expect(parsed.id).toBe('foo');
    expect(parsed.jsonrpc).toBe('2.0');
  });

  it('preserves a numeric id as a JSON number', () => {
    const { firstLine } = runServer({
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
      params: {},
    });
    const parsed = JSON.parse(firstLine);
    expect(parsed.id).toBe(7);
  });

  it('emits valid JSON for a string-id response', () => {
    const { firstLine } = runServer({
      jsonrpc: '2.0',
      id: 'foo',
      method: 'initialize',
      params: {},
    });
    expect(() => JSON.parse(firstLine)).not.toThrow();
  });

  it('emits valid JSON for a numeric-id response', () => {
    const { firstLine } = runServer({
      jsonrpc: '2.0',
      id: 7,
      method: 'initialize',
      params: {},
    });
    expect(() => JSON.parse(firstLine)).not.toThrow();
  });

  it('encodes a missing id as literal null in an error response', () => {
    const { firstLine } = runServer({
      jsonrpc: '2.0',
      method: 'bogus/method',
      params: {},
    });
    const parsed = JSON.parse(firstLine);
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(-32601);
  });
});

// ---------------------------------------------------------------------------
// session_metrics tool — torn-write tolerance (regression: jq must not abort
// the whole sessions.jsonl stream at the first unparseable line).
//
// tool_session_metrics() filters out `status: 'abandoned'` phantom stubs via
// `jq -R -c 'fromjson? | select(.status != "abandoned")'` BEFORE taking the
// last-5 tail. sessions.jsonl is append-only from multiple writers, so a torn
// (unparseable) line anywhere in the file must not make the tool report
// "No metrics found (file is empty)" on a ledger that plainly is not empty.
// ---------------------------------------------------------------------------

describe('mcp-server.sh session_metrics — torn-write tolerance', () => {
  let tmpRepo;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'mcp-server-metrics-'));
    // Minimal git init so `git rev-parse --show-toplevel` resolves inside
    // the fixture repo instead of falling through to the real repo root.
    spawnSync('git', ['init', '-q'], { cwd: tmpRepo, encoding: 'utf8' });
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('returns both real sessions when a malformed line sits between them, excluding the abandoned stub', () => {
    const metricsDir = join(tmpRepo, '.orchestrator', 'metrics');
    mkdirSync(metricsDir, { recursive: true });

    // Fixture order: [real, abandoned, NOT-JSON, real] — a torn write in the
    // middle of the ledger, exactly the append-only-multi-writer case that
    // matters. Neutral invented session ids only (no real names).
    const lines = [
      JSON.stringify({ session_id: 'session-alpha-001', status: 'ok' }),
      JSON.stringify({ session_id: 'session-ghost-999', status: 'abandoned' }),
      'NOT JSON',
      JSON.stringify({ session_id: 'session-beta-002', status: 'ok' }),
    ];
    writeFileSync(join(metricsDir, 'sessions.jsonl'), lines.join('\n') + '\n', 'utf8');

    const { firstLine } = runServer(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'session_metrics', arguments: {} },
      },
      tmpRepo,
    );

    const parsed = JSON.parse(firstLine);
    const text = parsed.result.content[0].text;

    // Specific content assertions — NOT a bare toBeTruthy(), which would pass
    // even on the broken (stream-aborted, empty-result) behaviour.
    expect(text).toContain('session-alpha-001');
    expect(text).toContain('session-beta-002');
    expect(text).not.toContain('session-ghost-999');
    expect(text).not.toBe('No metrics found (file is empty)');
  });
});
