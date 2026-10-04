import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureNativeMcp } from '../../scripts/windows-setup.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'so windows space-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'session-orchestrator' }));
  const source = new URL('../../scripts/mcp-server.mjs', import.meta.url).href;
  // Execute the real implementation through a fixture path containing spaces.
  writeFileSync(path.join(root, 'scripts/mcp-server.mjs'), `import { serve } from ${JSON.stringify(source)}; await serve();`);
  const original = JSON.stringify({ mcpServers: {
    'session-orchestrator': { command: 'bash', args: ['-c', 'exit 99'], env: { KEEP: 'yes' } },
    other: { command: 'untouched' },
  } });
  writeFileSync(path.join(root, '.mcp.json'), original);
  return { root, original };
}
describe('native Windows MCP opt-in', () => {
  it('backs up exact input, preserves other servers, and starts MCP without a shell', () => {
    const { root, original } = fixture();
    const result = configureNativeMcp(root, { platform: 'win32' });
    expect(readFileSync(result.backup, 'utf8')).toBe(original);
    const config = JSON.parse(readFileSync(result.file, 'utf8'));
    expect(config.mcpServers.other).toEqual({ command: 'untouched' });
    const server = config.mcpServers['session-orchestrator'];
    expect(server.env).toEqual({ KEEP: 'yes' });
    const probe = spawnSync(server.command, server.args, {
      input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\r\n', encoding: 'utf8', timeout: 10000,
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout).result.tools.map((tool) => tool.name)).toEqual(['session_config', 'session_metrics']);
    expect(configureNativeMcp(root, { platform: 'win32' }).changed).toBe(false);
  });
  it('refuses a different package or a non-Windows host before changing configuration', () => {
    const { root, original } = fixture();
    expect(() => configureNativeMcp(root, { platform: 'linux' })).toThrow('Windows');
    writeFileSync(path.join(root, 'package.json'), '{"name":"other"}');
    expect(() => configureNativeMcp(root, { platform: 'win32' })).toThrow('session-orchestrator');
    expect(readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(original);
  });
});
