import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureNativeMcp } from '../../scripts/windows-setup.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(relative = 'plugins/cache/session-orchestrator/version') {
  const base = mkdtempSync(path.join(tmpdir(), 'so windows space-'));
  roots.push(base);
  const root = path.join(base, relative);
  mkdirSync(root, { recursive: true });
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
  // Bug #1523: package-name validation alone allowed writes to a checkout or a lookalike cache.
  it.each(['checkout', 'plugins/cache-lookalike/session-orchestrator'])('refuses %s without writing config or backup', (relative) => {
    const { root, original } = fixture(relative);
    expect(() => configureNativeMcp(root, { platform: 'win32' })).toThrow('plugins/cache');
    expect(readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(original);
    expect(existsSync(path.join(root, '.mcp.json.before-windows-setup'))).toBe(false);
  });
  it.each(['file', 'directory'])('refuses a .git %s even inside the cache before writing', (kind) => {
    const { root, original } = fixture();
    const createGit = { file: () => writeFileSync(path.join(root, '.git'), 'gitdir: elsewhere'),
      directory: () => mkdirSync(path.join(root, '.git')) };
    createGit[kind]();
    expect(() => configureNativeMcp(root, { platform: 'win32' })).toThrow('Git checkout');
    expect(readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(original);
    expect(existsSync(path.join(root, '.mcp.json.before-windows-setup'))).toBe(false);
  });
  it('refuses a cache symlink escaping to a non-cache target (#1523)', () => {
    const { root, original } = fixture('outside');
    const alias = path.join(path.dirname(root), 'plugins/cache/alias');
    mkdirSync(path.dirname(alias), { recursive: true });
    symlinkSync(root, alias, 'junction');
    expect(() => configureNativeMcp(alias, { platform: 'win32' })).toThrow('plugins/cache');
    expect(readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(original);
    expect(existsSync(path.join(root, '.mcp.json.before-windows-setup'))).toBe(false);
  });
  it('checks the target guard before the idempotent success branch (#1523)', () => {
    const { root } = fixture();
    configureNativeMcp(root, { platform: 'win32' });
    const config = readFileSync(path.join(root, '.mcp.json'), 'utf8');
    const backup = readFileSync(path.join(root, '.mcp.json.before-windows-setup'), 'utf8');
    writeFileSync(path.join(root, '.git'), 'gitdir: elsewhere');
    expect(() => configureNativeMcp(root, { platform: 'win32' })).toThrow('Git checkout');
    expect(readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe(config);
    expect(readFileSync(path.join(root, '.mcp.json.before-windows-setup'), 'utf8')).toBe(backup);
  });

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
