// Host-only helper: $.fs in build 2.1.296 has no rename, chmod or unlink.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
export async function beaconIO(action, id, input, { home = os.homedir(), pid = process.ppid } = {}) {
  if (action === 'identity') return { pid };
  if (action === 'alive') {
    const alive = [];
    for (const p of input ?? []) {
      if (!Number.isSafeInteger(p) || p <= 0) continue;
      try { process.kill(p, 0); alive.push(p); } catch (e) { if (e.code === 'EPERM') alive.push(p); }
    }
    return alive;
  }
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id ?? '')) throw new Error('invalid session');
  const dir = path.join(home, '.config/session-orchestrator/hud/beacons');
  const target = path.join(dir, `${id}.json`);
  if (action === 'remove') { await fs.unlink(target).catch(e => { if (e.code !== 'ENOENT') throw e; }); return null; }
  if (action !== 'write' || input?.session_id !== id) throw new Error('invalid action');
  const body = JSON.stringify(input);
  if (Buffer.byteLength(body) > 4096) throw new Error('beacon too large');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, body, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, target);
  } finally { await fs.unlink(temp).catch(() => {}); }
  return null;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new Error('input too large'); }
    const out = await beaconIO(process.argv[2], process.argv[3], input ? JSON.parse(input) : null);
    process.stdout.write(JSON.stringify(out));
  } catch { process.stderr.write('so-hud: beacon I/O failed\n'); process.exitCode = 2; }
}
