#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { measure } from './lib/so-hud/runtime.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { parseSessionId } from './lib/session-id.mjs';
const exec = promisify(execFile);
const SO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function main(argv, deps = {}) {
  const output = deps.output ?? (s => process.stdout.write(s));
  const error = deps.error ?? (s => process.stderr.write(s));
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, 'repo-root': { type: 'string' }, 'session-id': { type: 'string' }, 'register-root': { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: false }));
    if (values.help) {
      output('so-hud --json [--repo-root <path>] [--session-id <raw-uuid>] [--register-root]\nRead-only HUD JSON v1. --register-root registers this SO installation (0600).\nDefault repo: git toplevel of cwd. --session-id: the session whose agents are counted, read beside its own session.lock (#1730); without it the id comes from CLAUDE_SESSION_ID/SO_SESSION_ID and agents are read in the repo.\nExit 0: measured; 2: invocation/registration error; 6: repository unavailable.\n');
      return 0;
    }
    if (!values.json && !values['register-root']) throw new Error('--json required');
    if (values['session-id'] !== undefined && parseSessionId(values['session-id'])?.format !== 'uuid') throw new Error('bad --session-id');
  } catch (e) {
    error(e?.message === 'bad --session-id' ? 'so-hud: --session-id braucht eine Roh-UUID; siehe --help\n' : 'so-hud: --json erforderlich; siehe --help\n');
    return 2;
  }
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
    // A session started in a subdirectory measures its working copy: the git toplevel. Not a repo → the given
    // directory itself (never fail the measurement).
    const given = values['repo-root'] ? path.resolve(values['repo-root']) : null;
    const top = await (deps.exec ?? exec)('git', [...(given ? ['-C', given] : []), 'rev-parse', '--show-toplevel'], { timeout: 700 })
      .then(r => r.stdout.trim(), () => '');
    if (!top && !given) throw new Error('missing');
    root = await fs.realpath(top || given);
    // git answers in physical spelling, but the session writes file paths in the spelling it was given, and the
    // collision guard compares those as strings: keep the caller's spelling of the toplevel where it is derivable.
    // Peers are compared physically in collect.mjs. The caller's spelling is used only when it resolves to the
    // physical toplevel: a symlinked last path part (<d>/elsewhere/scripts → <d>/repo/scripts) would otherwise
    // map to <d>/elsewhere, which is not the repository.
    if (given) {
      const sub = path.relative(root, await fs.realpath(given));
      let candidate = null;
      if (sub === '') candidate = given;
      else if (sub !== '..' && !sub.startsWith(`..${path.sep}`) && given.endsWith(`${path.sep}${sub}`)) candidate = given.slice(0, -sub.length - 1);
      if (candidate !== null && await fs.realpath(candidate).catch(() => null) === root) root = candidate;
    }
    if (!(await fs.stat(root)).isDirectory()) throw new Error('missing');
  } catch { error('so-hud: Repo nicht ermittelbar\n'); return 6; }
  try { output(`${JSON.stringify(await (deps.measure ?? measure)(root, { sessionId: values['session-id'] ?? null }))}\n`); return 0; }
  catch { error('so-hud: Messung fehlgeschlagen\n'); return 6; }
}
if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
