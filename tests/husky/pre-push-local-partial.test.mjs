import { it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

// #1642: when no remote host could run the gate (router exit 10), an origin MR
// branch takes the local PARTIAL gate instead of the full suite on this host.
// Bugs this catches: the full suite still runs locally on an origin branch; a red
// partial run lets the push through; main, the mirror or a missing merge-base take
// the partial route instead of the full gate.
const root = resolve(import.meta.dirname, '../..');
const dirs = [];
afterEach(() => { while (dirs.length) removeTree(dirs.pop()); });

const commit = (repo, msg) => fixtureGit(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
  'commit', '-qm', msg]);

function runHook({ remote = 'origin', remoteRef = 'refs/heads/feature', base = true, testExit = 0, lintExit = 0,
  alsoMain = false, deleteFile = false } = {}) {
  const dir = makeTmpDir('pre-push-partial-');
  dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
  for (const name of ['pre-push-remote-gate.mjs', 'pre-push-local-partial.mjs']) {
    symlinkSync(join(root, 'scripts/lib', name), join(repo, 'scripts/lib', name));
  }
  writeFileSync(join(repo, 'scripts/run-quality-gate.mjs'), '// existence probe\n');
  // No remote-hosts block: the router finds no route and returns 10.
  writeFileSync(join(repo, 'CLAUDE.md'), '## Session Config\npersistence: false\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { 'quality-gate': 'node gate.cjs' } }));
  writeFileSync(join(repo, 'gate.cjs'),
    "require('node:fs').appendFileSync(process.env.TRACE, JSON.stringify({ tool: 'full-gate' }) + '\\n');\n");
  writeFileSync(join(repo, 'lib.mjs'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'old.mjs'), 'export const b = 1;\n');
  writeFileSync(join(repo, '\u00e4.mjs'), 'export const c = 1;\n');
  fixtureGit(['init', '-q', repo]);
  fixtureGit(['-C', repo, 'add', '-A']);
  commit(repo, 'base');
  if (base) fixtureGit(['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  fixtureGit(['-C', repo, 'remote', 'add', 'origin', 'https://gitlab.example.org/org/repo.git']);
  fixtureGit(['-C', repo, 'remote', 'add', 'github', 'https://github.com/org/repo.git']);
  writeFileSync(join(repo, 'lib.mjs'), 'export const a = 2;\n');
  fixtureGit(['-C', repo, 'add', 'lib.mjs']);
  if (deleteFile) fixtureGit(['-C', repo, 'rm', '-q', deleteFile === true ? 'old.mjs' : deleteFile]);
  commit(repo, 'change');
  const sha = fixtureGit(['-C', repo, 'rev-parse', 'HEAD'], undefined, { encoding: 'utf8' }).trim();
  // Fake only the two tools; they record the files they were handed.
  mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true });
  for (const [tool, code] of [['eslint', lintExit], ['vitest', testExit]]) {
    writeFileSync(join(repo, 'node_modules/.bin', tool), `
      require('node:fs').appendFileSync(process.env.TRACE,
        JSON.stringify({ tool: '${tool}', args: process.argv.slice(2) }) + '\\n');
      process.exit(${code});
    `);
  }
  const trace = join(dir, 'trace');
  writeFileSync(trace, '');
  const url = remote === 'github' ? 'https://github.com/org/repo.git' : 'https://gitlab.example.org/org/repo.git';
  const res = spawnSync('sh', ['-e', join(root, '.husky/pre-push'), remote, url], {
    cwd: repo, encoding: 'utf8', timeout: 30_000,
    // alsoMain: git does not order the lines by the command line; a later line can name main.
    input: `refs/heads/feature ${sha} ${remoteRef} ${'0'.repeat(40)}\n` +
      (alsoMain ? `refs/heads/feature ${sha} refs/heads/main ${'0'.repeat(40)}\n` : ''),
    env: { ...process.env, SKIP_QUALITY_GATE: '', SO_GATE_HOSTS: '', TRACE: trace, CLAUDE_PROJECT_DIR: repo },
  });
  return { res, records: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

it.each([
  ['origin MR branch, partial green', {}, 0, ['eslint', 'vitest']],
  ['origin MR branch, partial red', { testExit: 1 }, 1, ['eslint', 'vitest']],
  ['direct push to main', { remoteRef: 'refs/heads/main' }, 0, ['full-gate']],
  ['GitHub mirror', { remote: 'github' }, 0, ['full-gate']],
  ['no merge-base with origin/main', { base: false }, 0, ['full-gate']],
  ['origin MR branch, eslint red', { lintExit: 1 }, 1, ['eslint', 'vitest']],
  ['MR branch plus main in the same push', { alsoMain: true }, 0, ['full-gate']],
  ['a source file deleted', { deleteFile: true }, 0, ['full-gate']],
  // git quotes non-ASCII paths unless core.quotePath=false; the suffix test then misses them.
  ['a non-ASCII source file deleted', { deleteFile: '\u00e4.mjs' }, 0, ['full-gate']],
])('exit-10 fallback: %s', { timeout: 40_000 }, (_name, opts, status, tools) => {
  const { res, records } = runHook(opts);
  expect(res.status, res.stderr).toBe(status);
  expect(records.map((r) => r.tool)).toEqual(tools);
  if (tools[0] === 'eslint') {
    expect(records.map((r) => r.args.at(-1))).toEqual(['lib.mjs', 'lib.mjs']);
    expect(records[1].args.slice(0, 2)).toEqual(['related', '--run']);
  }
});
