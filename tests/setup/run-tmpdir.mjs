/**
 * #1646: test files that `mkdtemp` under `$TMPDIR` and do not clean up on
 * every path left 73,036 entries older than 24 h on the offload host
 * (2026-10-16); every gate run there added more. Same design as the
 * coordinator repo's fix (lead-session-orchestrator !339):
 *
 * - setup creates ONE run directory under the current tmpdir and points
 *   `TMPDIR` at it. Workers fork after globalSetup and inherit it, so every
 *   `os.tmpdir()` in a worker or in a child it spawns lands inside.
 * - teardown names the prefixes of whatever is left on stderr — the warning
 *   is how a test that forgot its own cleanup gets found — then removes only
 *   that run directory and restores `TMPDIR`. Nothing outside the directory
 *   created here is ever deleted.
 * - #1613: on win32 `os.tmpdir()` reads `TEMP`/`TMP`, not `TMPDIR`, so those
 *   are redirected too. If `os.tmpdir()` still does not resolve to the run
 *   directory, teardown says "not measured" — silence would read as 0 leftovers.
 *
 * Must stay FIRST in `globalSetup`, so the validator run and every setup file
 * already see the redirected tmpdir.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WIN32_KEYS = ['TEMP', 'TMP'];
let previous;
let runDir;
let measured;

export function setup() {
  const keys = process.platform === 'win32' ? ['TMPDIR', ...WIN32_KEYS] : ['TMPDIR'];
  previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  runDir = mkdtempSync(path.join(tmpdir(), 'so-vitest-'));
  // macOS hands out TMPDIR with a trailing separator; keep the platform shape
  // so `${TMPDIR}name` concatenations still resolve inside the run directory.
  process.env.TMPDIR = previous.TMPDIR?.endsWith(path.sep) ? runDir + path.sep : runDir;
  for (const key of keys.slice(1)) process.env[key] = runDir;
  measured = path.resolve(tmpdir()) === path.resolve(runDir);
}

export function teardown() {
  if (runDir === undefined) return;
  try {
    if (!measured) {
      process.stderr.write(`#1646: test leftovers not measured — os.tmpdir() does not resolve to the run directory on ${process.platform}\n`);
      return;
    }
    // The setup-file guards (vault-guard, host-alias-guard, …) derive ONE
    // shared directory per run as `<prefix><ppid>` — the ppid of every worker
    // is this main process. They are run-scoped by design and go with runDir;
    // only per-test leftovers are a finding.
    // `node-compile*` is Node's own compile cache, created by every spawned
    // npm/npx — not a test's directory.
    const runScoped = `-${process.pid}`;
    const leftovers = readdirSync(runDir).filter((name) => !name.endsWith(runScoped) && !name.startsWith('node-compile'));
    if (leftovers.length > 0) {
      const byPrefix = new Map();
      for (const name of leftovers) {
        const prefix = name.replace(/[-.][^-.]*$/, '') || name;
        byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
      }
      const list = [...byPrefix]
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `${p} (${n})`)
        .join(', ');
      process.stderr.write(`#1646: ${leftovers.length} test leftovers in TMPDIR not cleaned up: ${list}\n`);
    }
  } finally {
    // Restore first: on win32 rmSync can still throw EBUSY/EPERM after its
    // retries (open handles, scanners), and that must not strand the env.
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const dir = runDir;
    runDir = undefined;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
