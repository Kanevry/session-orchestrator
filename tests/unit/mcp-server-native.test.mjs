import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { handleLine, readSessionConfig, readSessionMetrics } from '../../scripts/mcp-server.mjs';

const server = fileURLToPath(new URL('../../scripts/mcp-server.mjs', import.meta.url));
let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'so mcp native ')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function ledger(text, dir = '.orchestrator') {
  const folder = join(root, dir, 'metrics');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'sessions.jsonl'), text);
}
function call(name, id = 0) {
  return handleLine(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }), {
    cwd: root, resolveRoot: () => root,
  });
}

describe('native MCP Windows transport', () => {
  it('keeps synthetic completed records out of the measured last-five window', () => {
    const measured = { session_id: 'measured', session_type: 'deep' };
    const stub = { session_id: 'stub', status: 'completed', session_type: 'unknown', _synthetic: true };
    ledger([measured, stub].map((record) => JSON.stringify(record)).join('\n'));
    const output = readSessionMetrics(root);
    expect(output).toContain(JSON.stringify(measured));
    expect(output).not.toContain(JSON.stringify(stub));
  });
  it('reads the main ledger from a linked worktree and keeps nonsynthetic legacy sessions', () => {
    const worktree = join(root, 'worktree');
    const gitDir = join(root, '.git', 'worktrees', 'worktree');
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    const legacy = { session_id: 'legacy', session_type: 'deep', status: 'abandoned' };
    ledger(JSON.stringify(legacy));
    expect(readSessionMetrics(worktree)).toContain(JSON.stringify(legacy));
  });
  it('initializes and lists both tools without bash or jq on PATH; recovers after bad JSON and ignores notifications', { timeout: 40_000 }, () => {
    const child = spawnSync(process.execPath, [server], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: root, Path: root },
      input: '{broken}\r\n'
        + '{"jsonrpc":"2.0","method":"notifications/initialized"}\r\n'
        + JSON.stringify({ jsonrpc: '2.0', id: 'init quoted "', method: 'initialize' }) + '\r\n'
        + '{"jsonrpc":"2.0","id":0,"method":"tools/list"}\r\n',
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 'init quoted "', result: {
        protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'session-orchestrator', version: '2.0.0' },
      } },
      { jsonrpc: '2.0', id: 0, result: { tools: [
        { name: 'session_config', description: 'Reads Session Config section from the project instruction file (CLAUDE.md or AGENTS.md alias)',
          inputSchema: { type: 'object', properties: {}, required: [] } },
        { name: 'session_metrics', description: 'Reads the last 5 MEASURED session metrics entries from .orchestrator/metrics/sessions.jsonl (unmeasured records excluded)',
          inputSchema: { type: 'object', properties: {}, required: [] } },
      ] } },
    ]);
  });

  it.each(['null', '[]', '42', '{"jsonrpc":"2.0","id":{},"method":"initialize"}'])(
    'returns invalid request for %s without crashing', (line) => {
      expect(handleLine(line)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    },
  );

  it('extracts raw CRLF config via AGENTS alias in a path containing spaces', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '');
    writeFileSync(join(root, 'AGENTS.md'), '# Project\r\n## Session Config\r\nwaves: 5\r\n# keep comment\r\n## Other\r\nsecret: no\r\n');
    expect(call('session_config')).toEqual({ jsonrpc: '2.0', id: 0,
      result: { content: [{ type: 'text', text: 'waves: 5\r\n# keep comment\r' }] } });
  });

  it('prefers nonempty CLAUDE.md and does not accept decorated config headings', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '## Session Config <!-- note -->\nwaves: 1\n');
    writeFileSync(join(root, 'AGENTS.md'), '## Session Config\nwaves: 2\n');
    expect(readSessionConfig(root)).toBe(`No '## Session Config' section found in ${join(root, 'CLAUDE.md')}`);
  });

  it('filters abandoned and malformed records before the last-five window and reports partial token coverage', () => {
    ledger('{"session_id":"old","session_type":"deep"}\n{"session_id":"a","session_type":"deep","total_token_input":90}\n'
      + '{broken\nnull\n42\n[]\n{"session_id":"b","session_type":"deep"}\n{"session_id":"c","session_type":"deep"}\n'
      + '{"session_id":"d","session_type":"deep"}\n{"session_id":"e","session_type":"deep"}\n'
      + '{"session_id":"stub1","status":"abandoned","_synthetic":true}\n{"session_id":"stub2","status":"abandoned","_synthetic":true}\n');
    expect(call('session_metrics').result.content[0].text).toBe(
      '{"session_id":"a","session_type":"deep","total_token_input":90}\n{"session_id":"b","session_type":"deep"}\n{"session_id":"c","session_type":"deep"}\n'
      + '{"session_id":"d","session_type":"deep"}\n{"session_id":"e","session_type":"deep"}\n\nunmeasured records excluded: 2\n\n--- token summary ---\n'
      + 'tokens: 90 in / ? out (coverage: 0 subagents) ⚠ partial — subagent token data missing; total is not a reliable cost estimate [session: a]',
    );
  });

  it('reports stubs-only ledger distinctly from an empty file', () => {
    ledger('{"session_id":"stub","status":"abandoned","_synthetic":true}\n{bad');
    expect(readSessionMetrics(root)).toBe('No measured sessions (unmeasured records excluded: 1)');
  });

  it('falls back to legacy metrics and uses the latest token-bearing session', () => {
    ledger('{"total_waves":1,"total_token_input":99}\n{"session_id":"latest","session_type":"deep","total_token_output":20,"subagents_with_tokens":2}\n', '.claude');
    expect(readSessionMetrics(root)).toBe('{"total_waves":1,"total_token_input":99}\n'
      + '{"session_id":"latest","session_type":"deep","total_token_output":20,"subagents_with_tokens":2}\n\nunmeasured records excluded: 0\n\n--- token summary ---\n'
      + 'tokens: ? in / 20 out (coverage: 2 subagents) [session: latest]');
  });

  it('returns the existing no-repository tool result when git fails', { timeout: 40_000 }, () => {
    // TMPDIR can itself live inside a repository. Limit Git's parent search
    // only in this child, keeping the real resolver and tool error path.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { handleLine, resolveProjectRoot } from ${JSON.stringify(new URL('../../scripts/mcp-server.mjs', import.meta.url).href)};
      process.stdout.write(JSON.stringify({
        root: resolveProjectRoot(),
        response: handleLine('{"jsonrpc":"2.0","id":null,"method":"tools/call","params":{"name":"session_config"}}'),
      }));
    `], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      root: null,
      response: { jsonrpc: '2.0', id: null, result: { content: [{ type: 'text', text: 'Error: not inside a git repository' }] } },
    });
  });

  it('returns an actionable error for unknown tools with a string request id', () => {
    expect(call('missing', 'call-1')).toEqual({ jsonrpc: '2.0', id: 'call-1', error: { code: -32602, message: 'Unknown tool: missing' } });
  });
});
