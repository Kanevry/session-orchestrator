#!/usr/bin/env node
/** Opt-in native MCP configuration for an installed Windows plugin. */
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './lib/is-main-module.mjs';

export function configureNativeMcp(pluginRoot, { node = process.execPath, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('This setup is for native Windows only.');
  const root = realpathSync(pluginRoot);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'session-orchestrator') throw new Error('Expected a session-orchestrator plugin directory.');
  const server = path.join(root, 'scripts', 'mcp-server.mjs');
  if (!existsSync(server)) throw new Error('Native MCP server is missing; install the updated package first.');
  const file = path.join(root, '.mcp.json');
  const raw = readFileSync(file, 'utf8');
  const config = JSON.parse(raw);
  const current = config.mcpServers?.['session-orchestrator'];
  if (!current || typeof current !== 'object') throw new Error('Expected session-orchestrator MCP configuration.');
  if (current.command === node && current.args?.length === 1 && current.args[0] === server) {
    return { changed: false, file };
  }
  const backup = `${file}.before-windows-setup`;
  if (existsSync(backup)) throw new Error(`Backup already exists: ${backup}; inspect it before reconfiguring.`);
  config.mcpServers['session-orchestrator'] = { ...current, command: node, args: [server] };
  copyFileSync(file, backup);
  const temporary = `${file}.windows-setup-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
  return { changed: true, file, backup };
}

if (isMainModule(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/windows-setup.mjs <installed-plugin-directory>');
    process.stdout.write(`${JSON.stringify(configureNativeMcp(process.argv[2]))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
