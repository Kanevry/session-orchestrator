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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// .mcp.json entrypoint — plugin-root resolution + fail-loud
// (GH Kanevry/session-orchestrator#64)
//
// The bug: `.mcp.json` resolved the plugin root as
//   ${CLAUDE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-$(git rev-parse --show-toplevel)}}
// CODEX_PLUGIN_ROOT is session-orchestrator's OWN compatibility export (set
// only inside hooks/hooks-codex.json command strings), never a variable Codex
// hands to an MCP child — so on Codex the git fallback was the only live layer.
// Launched from $HOME (not a git repo) the substitution yielded "", the path
// became literally "/scripts/mcp-server.sh", and bash exited 127 with 0 bytes
// on stdout. The client reports that as "connection closed: initialize
// response" with nothing to act on.
//
// These tests spawn the REAL command+args read out of .mcp.json (never a
// hand-copied string — a hand-typed copy under a census title is a green tick
// with no coverage) from a NON-git temp dir with every plugin-root variable
// removed from the environment.
//
// The invariant under test is "never silent": the process must either complete
// the handshake or name itself on stderr. Both old failure modes (missing
// script, missing jq) produced 0 bytes on stdout and no product name anywhere.
// ---------------------------------------------------------------------------

const DIAGNOSTIC_MARKER = 'session-orchestrator: cannot locate the plugin root';

/** Env vars every resolution layer consults — removed so the test controls them. */
const PLUGIN_ROOT_VARS = [
  'CLAUDE_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'PLUGIN_ROOT',
  'CURSOR_RULES_DIR',
  'PI_PLUGIN_ROOT',
  'SO_PLATFORM',
];

/**
 * Spawn the MCP server exactly as a client would: the `command` and `args` are
 * read from .mcp.json, so a future edit to that string is exercised here.
 *
 * @param {string} cwd            Working directory for the child.
 * @param {Record<string,string>} [extraEnv] Vars to set (all PLUGIN_ROOT_VARS
 *   are deleted first, then these are applied).
 */
function runMcpJsonEntrypoint(cwd, extraEnv = {}) {
  const raw = readFileSync(join(repoRoot, '.mcp.json'), 'utf8');
  const entry = JSON.parse(raw).mcpServers?.['session-orchestrator'];

  // Vacuum guard: an empty/renamed entry must fail the test, not silently
  // reduce it to spawning nothing.
  expect(entry, '.mcp.json has no mcpServers["session-orchestrator"] entry').toBeTruthy();
  expect(typeof entry.command).toBe('string');
  expect(Array.isArray(entry.args)).toBe(true);
  expect(entry.args.length).toBeGreaterThan(0);

  const env = { ...process.env };
  for (const key of PLUGIN_ROOT_VARS) delete env[key];
  Object.assign(env, extraEnv);

  const input = `${JSON.stringify({ jsonrpc: '2.0', id: 'gh64', method: 'initialize', params: {} })}\n`;
  return spawnSync(entry.command, entry.args, {
    input,
    encoding: 'utf8',
    cwd,
    env,
    timeout: 30_000,
  });
}

/** The core invariant: never 0 bytes on stdout with no named diagnostic on stderr. */
function expectNotSilent(result) {
  const silent = result.stdout.trim() === '' && !result.stderr.includes(DIAGNOSTIC_MARKER);
  expect(
    silent,
    `MCP entrypoint failed silently — stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  ).toBe(false);
}

describe('.mcp.json entrypoint — plugin-root resolution (GH#64)', () => {
  let outsideRepo;

  beforeEach(() => {
    // A temp dir with no git repository anywhere in its ancestry — the
    // reporter's situation (client launched from $HOME).
    outsideRepo = mkdtempSync(join(tmpdir(), 'mcp-no-git-'));
    const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: outsideRepo,
      encoding: 'utf8',
    });
    // Precondition, not an assertion about the fix: if this dir were inside a
    // git tree the test would prove nothing.
    expect(probe.status).not.toBe(0);
  });

  afterEach(() => {
    rmSync(outsideRepo, { recursive: true, force: true });
  });

  it('never fails silently from a non-git cwd with no plugin-root variable set', () => {
    const result = runMcpJsonEntrypoint(outsideRepo);
    expectNotSilent(result);

    if (result.stdout.trim().length > 0) {
      // A resolvable install (npm/npx) — the handshake must be a real one.
      const firstLine = result.stdout.split('\n').find((l) => l.trim().length > 0);
      expect(JSON.parse(firstLine).result.serverInfo.name).toBe('session-orchestrator');
    } else {
      // No install reachable — then the operator gets an actionable diagnostic
      // naming the variable to set, not an opaque "connection closed".
      expect(result.stderr).toContain(DIAGNOSTIC_MARKER);
      expect(result.stderr).toContain('CLAUDE_PLUGIN_ROOT');
      expect(result.stderr).toContain('CODEX_PLUGIN_ROOT');
      expect(result.status).not.toBe(0);
    }
  });

  it("honours Codex's native PLUGIN_ROOT from a non-git cwd", () => {
    // The old args string named CLAUDE_PLUGIN_ROOT and CODEX_PLUGIN_ROOT only;
    // Codex's own variable was absent, so a client that DID export it still
    // fell through to the git fallback and died outside a repo.
    const result = runMcpJsonEntrypoint(outsideRepo, { PLUGIN_ROOT: repoRoot });
    expectNotSilent(result);

    const firstLine = result.stdout.split('\n').find((l) => l.trim().length > 0);
    const parsed = JSON.parse(firstLine);
    expect(parsed.id).toBe('gh64');
    expect(parsed.result.serverInfo.name).toBe('session-orchestrator');
  });

  it('rejects a plugin-root variable pointing at a directory without the server script', () => {
    // Load-bearing for every external user: `git rev-parse --show-toplevel`
    // legitimately returns THEIR project root, which has no
    // scripts/mcp-server.sh. Without the -f guard the entrypoint exec's a
    // nonexistent path and dies with 0 bytes — the GH#64 signature again.
    const result = runMcpJsonEntrypoint(outsideRepo, { CLAUDE_PLUGIN_ROOT: outsideRepo });
    expectNotSilent(result);

    if (result.stdout.trim().length === 0) {
      expect(result.stderr).toContain(DIAGNOSTIC_MARKER);
      expect(result.status).not.toBe(0);
    }
  });
});
