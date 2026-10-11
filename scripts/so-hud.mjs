#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { measure } from './lib/so-hud/runtime.mjs';
const exec = promisify(execFile);
const SO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function main(argv, deps = {}) {
  const output = deps.output ?? (s => process.stdout.write(s));
  const error = deps.error ?? (s => process.stderr.write(s));
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, 'repo-root': { type: 'string' }, 'register-root': { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: false }));
    if (values.help) {
      output('so-hud --json [--repo-root <path>] [--register-root]\nRead-only HUD JSON v1. --register-root registers this SO installation (0600).\nDefault repo: git toplevel of cwd. Exit 0: measured; 2: invocation/registration error; 6: repository unavailable.\n');
      return 0;
    }
    if (!values.json && !values['register-root']) throw new Error('--json required');
  } catch { error('so-hud: --json erforderlich; siehe --help\n'); return 2; }
  if (values['register-root']) {
    try {
      const dir = path.join(deps.home ?? os.homedir(), '.config/session-orchestrator/hud');
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      const target = path.join(dir, 'so-root');
      const temp = `${target}.${process.pid}.tmp`;
      try { await fs.writeFile(temp, `${SO_ROOT}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, target); }
      finally { await fs.unlink(temp).catch(() => {}); }
    } catch { error('so-hud: Registrierung fehlgeschlagen\n'); return 2; }
    if (!values.json) return 0;
  }
  let root;
  try {
    root = values['repo-root'] ? path.resolve(values['repo-root']) : (await (deps.exec ?? exec)('git', ['rev-parse', '--show-toplevel'], { timeout: 700 })).stdout.trim();
    if (!root || !(await fs.stat(root)).isDirectory()) throw new Error('missing');
  } catch { error('so-hud: Repo nicht ermittelbar\n'); return 6; }
  try { output(`${JSON.stringify(await (deps.measure ?? measure)(root))}\n`); return 0; }
  catch { error('so-hud: Messung fehlgeschlagen\n'); return 6; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
