/**
 * tests/_helpers/git-faults.mjs — two git failures a test cannot get from a healthy host.
 *
 * Code that reads files with `git show <ref>:<path>` must tell "path absent" apart
 * from every other failure (#1774): only the first may read as an empty file.
 *
 * - dropBlob: deletes the loose object of one blob. The path stays in the tree,
 *   so `git diff` and `git ls-tree` still list it, but `git show` fails with
 *   "unable to read" — a real git error that is not "path absent".
 * - withTranslatedGit: git prints German only where its de catalogue is
 *   installed, so a locale test against the host's git is skipped on most hosts
 *   (the former `skipIf(!GERMAN_GIT)` case). This puts a fake `git` first on
 *   PATH: under any LC_ALL other than C every `show` fails with git's German
 *   "path absent" wording; every other call runs the real git. A caller that
 *   passes LC_ALL=C therefore reaches the real git, a caller that does not gets
 *   the German text. POSIX only (installScriptCli, see executable-fixture.mjs).
 */

import { accessSync, chmodSync, constants, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { installScriptCli, SCRIPT_CLI_SUPPORTED } from './executable-fixture.mjs';
import { fixtureGit, makeTmpDir, removeTree } from './tmp-fixture.mjs';

/**
 * Make `<ref>:<file>` unreadable in the repo at `repoDir` by deleting its loose object.
 * @param {string} repoDir  non-bare repository root
 * @param {string} ref
 * @param {string} file     repo-relative path
 */
export function dropBlob(repoDir, ref, file) {
  const sha = fixtureGit(['-C', repoDir, 'rev-parse', `${ref}:${file}`]).trim();
  const object = join(repoDir, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  chmodSync(object, 0o644); // git writes objects read-only; win32 refuses to delete those
  rmSync(object);
}

/** Whether withTranslatedGit can run here. */
export const TRANSLATED_GIT_SUPPORTED = SCRIPT_CLI_SUPPORTED;

/** The first executable `git` on the current PATH. */
function realGit() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  throw new Error('git-faults: no git on PATH');
}

const FAKE_GIT = `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (process.env.LC_ALL !== 'C' && args.includes('show')) {
  process.stderr.write("fatal: Pfad 'x' existiert nicht in 'base'\\n");
  process.exit(128);
}
const r = spawnSync(process.env.SO_TEST_REAL_GIT, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`;

/**
 * Run `fn` with a German-speaking fake git first on PATH and LC_ALL/LANG set to German.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withTranslatedGit(fn) {
  const binDir = makeTmpDir('so-translated-git-');
  const keys = ['PATH', 'LC_ALL', 'LANG', 'SO_TEST_REAL_GIT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    installScriptCli(binDir, 'git', FAKE_GIT);
    process.env.SO_TEST_REAL_GIT = realGit();
    process.env.PATH = `${binDir}${delimiter}${saved.PATH ?? ''}`;
    process.env.LC_ALL = 'de_DE.UTF-8';
    process.env.LANG = 'de_DE.UTF-8';
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    removeTree(binDir);
  }
}
