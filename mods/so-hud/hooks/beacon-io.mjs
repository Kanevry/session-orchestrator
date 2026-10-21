// Host-only helper: $.fs in build 2.1.296 has no append, rename, chmod or unlink.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// Closed receipt shape: no free-text field, so a command (which can carry a token) never reaches the file —
// argv_sha256 is its only reference. Allowlist via Set, never `in` (that would admit `toString` and friends).
const RECEIPT_KEYS = new Set(['zeit', 'session_id', 'vorgang', 'aktion', 'argv_sha256', 'exit', 'profil', 'ergebnis', 'art']);
const RECEIPT_ENUMS = { vorgang: ['pane-aktion'], aktion: ['aussenwirkung', 'kollision'], profil: ['locker', 'ausgewogen', 'streng'], ergebnis: ['ausgefuehrt', 'abgelehnt', 'verfallen', 'ohne-zeichenflaeche', 'fehler'] };
const validReceipt = (r, id) => r !== null && typeof r === 'object' && !Array.isArray(r)
  && Object.keys(r).every(k => RECEIPT_KEYS.has(k)) && r.session_id === id
  && Object.entries(RECEIPT_ENUMS).every(([k, allowed]) => allowed.includes(r[k]))
  && typeof r.zeit === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(r.zeit) && Number.isFinite(Date.parse(r.zeit))
  && typeof r.argv_sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.argv_sha256)
  && (r.exit === null || Number.isSafeInteger(r.exit))
  && (r.art === undefined || (typeof r.art === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(r.art)));
// A planted symlink (or a foreign-owned directory) at hud/ or hud/beacons/ would otherwise receive our chmod and our
// writes. `uid` is undefined on native Windows (no process.getuid), where only the symlink/directory check applies.
const ownDir = (st, uid) => {
  if (st.isSymbolicLink() || !st.isDirectory() || (uid !== undefined && st.uid !== uid)) throw new Error('not a private directory');
};
async function privateDir(dir, { noFollow, uid }) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (noFollow) {
    // The handle pins the checked inode: a symlink at `dir` fails this open, so check and chmod hit one directory.
    const fh = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
    try { ownDir(await fh.stat(), uid); await fh.chmod(0o700); } finally { await fh.close(); }
    return;
  }
  // No O_NOFOLLOW (native Windows): lstat, then chmod by path. Ceiling: a link swapped in between the two is followed;
  // creating one needs admin or Developer Mode there. Revisit if Node exposes O_NOFOLLOW on Windows.
  ownDir(await fs.lstat(dir), uid);
  await fs.chmod(dir, 0o700);
}
// Ceiling for every path below a checked directory: Node has no openat(), so a process that can rename entries in
// ~/.config/session-orchestrator could swap hud/ between the check and the file open. That is the user's own config
// directory today; revisit if a shared or world-writable parent is ever supported.
export async function beaconIO(action, id, input, { home = os.homedir(), pid = process.ppid, noFollow = constants.O_NOFOLLOW, uid = process.getuid?.() } = {}) {
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
  const hud = path.join(home, '.config/session-orchestrator/hud');
  if (action === 'aktion') {
    if (!validReceipt(input, id)) throw new Error('invalid receipt');
    const line = `${JSON.stringify(input)}\n`;
    if (Buffer.byteLength(line) > 1024) throw new Error('receipt too large');
    await privateDir(hud, { noFollow, uid });
    const file = path.join(hud, 'aktionen.jsonl');
    if (!noFollow) {
      // Without O_NOFOLLOW, refuse a planted link or non-regular file by lstat first. Ceiling: same window as privateDir.
      const st = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (st && (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1)) throw new Error('receipt path is not a regular file');
    }
    // Shared with other writers (owner-inbox): append-only, never read-modify-write; O_NOFOLLOW refuses a planted symlink.
    const fh = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (noFollow || 0), 0o600);
    try {
      // A hard link planted at the path is a second name for a foreign file: refuse it before chmod or write touch it.
      const st = await fh.stat();
      if (!st.isFile() || st.nlink !== 1) throw new Error('receipt path is not a private regular file');
      await fh.chmod(0o600);
      await fh.write(line);
    } finally { await fh.close(); }
    return null;
  }
  const dir = path.join(hud, 'beacons');
  const target = path.join(dir, `${id}.json`);
  if (action === 'remove') {
    // Never unlink through a planted link: check both directories, but create nothing.
    try { for (const d of [hud, dir]) ownDir(await fs.lstat(d), uid); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    await fs.unlink(target).catch(e => { if (e.code !== 'ENOENT') throw e; });
    return null;
  }
  if (action !== 'write' || input?.session_id !== id) throw new Error('invalid action');
  const body = JSON.stringify(input);
  if (Buffer.byteLength(body) > 4096) throw new Error('beacon too large');
  await privateDir(hud, { noFollow, uid });
  await privateDir(dir, { noFollow, uid });
  // `wx` refuses a link planted at the temp name (EEXIST), and rename replaces a link at the target instead of following it.
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
