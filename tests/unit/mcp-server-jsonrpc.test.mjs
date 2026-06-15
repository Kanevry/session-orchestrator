// Regression tests for scripts/mcp-server.sh JSON-RPC id handling (issue #650).
//
// The bug: respond()/respond_error() printf-interpolated a bare `$id` extracted
// with `jq -r '.id // empty'`. A JSON-RPC string id like "foo" lost its quotes
// and produced invalid JSON (`"id":foo`), and an absent id became an empty
// string (`"id":,`). JSON-RPC 2.0 permits string ids, so the server must
// re-encode the id as valid JSON. These tests spawn the real shell server,
// feed one request line on stdin, and assert the emitted stdout line is valid
// JSON with the id preserved.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive repoRoot portably from this file's location (tests/unit/ -> repo root).
// No hardcoded home path — the owner-leakage CI gate blocks absolute home paths.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const serverScript = join('scripts', 'mcp-server.sh');

/**
 * Spawn the MCP server, feed a single JSON-RPC request line on stdin, and
 * return the first stdout line (the response).
 */
function runServer(requestObj) {
  const input = `${JSON.stringify(requestObj)}\n`;
  const result = spawnSync('bash', [serverScript], {
    input,
    encoding: 'utf8',
    cwd: repoRoot,
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
