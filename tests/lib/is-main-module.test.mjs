import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { isMainModule } from '../../scripts/lib/is-main-module.mjs';

const SELF = fileURLToPath(import.meta.url);
const dirs = [];
function tmp() {
  const d = mkdtempSync(path.join(tmpdir(), 'so-is-main-'));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('isMainModule', () => {
  // The incident: Node resolves import.meta.url to the REALPATH while argv[1] is
  // the path as typed, so every hand-written string compare is false when the
  // script is reached through a symlink — main() never runs and the process
  // still exits 0. A raw `argv1 === fileURLToPath(url)` fails this case.
  it('is true when the script is invoked through a symlink', () => {
    const d = tmp();
    const link = path.join(d, 'link-to-self.mjs');
    symlinkSync(SELF, link);

    expect(isMainModule(import.meta.url, link)).toBe(true);
    // the pre-#1371 idiom, asserted wrong on the same inputs
    expect(import.meta.url === pathToFileURL(link).href).toBe(false);
  });

  // End-to-end through a real child process: the guard must fire when Node
  // itself is handed the symlink, which is the shape the shims in
  // node_modules/.bin and ~/.claude/plugins actually take.
  it('fires main() when node is handed a symlink to the module', () => {
    const d = tmp();
    const real = path.join(d, 'real-cli.mjs');
    const helper = pathToFileURL(
      path.join(path.dirname(SELF), '..', '..', 'scripts', 'lib', 'is-main-module.mjs'),
    ).href;
    writeFileSync(
      real,
      `import { isMainModule } from ${JSON.stringify(helper)};\n` +
        "if (isMainModule(import.meta.url)) process.stdout.write('RAN');\n",
    );
    const link = path.join(d, 'shim.mjs');
    symlinkSync(real, link);

    const out = execFileSync(process.execPath, [link], { encoding: 'utf8' });
    expect(out).toBe('RAN');
  });

  // The #1371 sweep replaced 50 hand-written guards, and its RUNTIME effect was
  // proven for 0 REAL scripts: every proof used a synthetic one-liner. The shape
  // that matters in production is `~/.claude/plugins/<name>` — a SYMLINK to the
  // repo root — where the old idiom is false, main() never runs, nothing is
  // printed and the process still exits 0. Every caller reads that as success.
  it('a swept repo CLI still prints its output when spawned through a symlinked plugin root', () => {
    const repoRoot = path.resolve(path.dirname(SELF), '..', '..');
    const link = path.join(tmp(), 'plugin');
    symlinkSync(repoRoot, link);
    const viaLink = path.join(link, 'scripts', 'session-shape.mjs');
    const real = path.join(repoRoot, 'scripts', 'session-shape.mjs');

    const out = execFileSync(
      process.execPath,
      [viaLink, '--repo-root', repoRoot, '--session-type', 'deep', '--no-event'],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(out).totalWaves).toBeGreaterThan(0);

    // ...and the pre-#1371 idiom answers the opposite on the SAME invocation:
    // Node resolves the module URL to the realpath, argv[1] stays the path as
    // typed. That difference IS the bug this guard exists for.
    expect(pathToFileURL(real).href === pathToFileURL(viaLink).href).toBe(false);
    expect(isMainModule(pathToFileURL(real).href, viaLink)).toBe(true);
  });

  it('is false for a different file', () => {
    const d = tmp();
    const other = path.join(d, 'other.mjs');
    writeFileSync(other, '// not the caller\n');
    expect(isMainModule(import.meta.url, other)).toBe(false);
  });

  // `node -e "import(...)"`, the REPL and some dynamic-import contexts leave
  // argv[1] undefined; pathToFileURL(undefined) THROWS there, which turned the
  // guard from "returns false" into "the import itself is a hard error".
  it('is false — never throwing — when argv[1] is undefined', () => {
    expect(() => isMainModule(import.meta.url, undefined)).not.toThrow();
    expect(isMainModule(import.meta.url, undefined)).toBe(false);
    expect(isMainModule(import.meta.url, '')).toBe(false);
  });

  // realpathSync throws on a path that no longer exists. An entry guard must
  // never be the thing that crashes an import, so it degrades to a raw compare.
  it('falls back to a raw compare when realpath fails', () => {
    const d = tmp();
    const missing = path.join(d, 'deleted.mjs');
    expect(isMainModule(import.meta.url, missing)).toBe(false);
    // same non-existent path on both sides → the fallback still matches
    expect(isMainModule(pathToFileURL(missing).href, missing)).toBe(true);
  });
});
