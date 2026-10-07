import { it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const root = resolve(import.meta.dirname, '../..');
const dirs = [];
afterEach(() => { while (dirs.length) removeTree(dirs.pop()); });

function runHook(mode, linked = false, tagKind) {
  const dir = makeTmpDir('pre-push-remote-');
  dirs.push(dir);
  const repo = linked ? join(dir, 'Ventures/org/canonical') : join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
  mkdirSync(bin);
  symlinkSync(join(root, 'scripts/lib/pre-push-remote-gate.mjs'), join(repo, 'scripts/lib/pre-push-remote-gate.mjs'));
  writeFileSync(join(repo, 'scripts/run-quality-gate.mjs'), '// existence probe\n');
  writeFileSync(join(repo, 'CLAUDE.md'), '## Session Config\nremote-hosts:\n  - alias: first\n    roles-allowed: [test]\n  - alias: second\n    roles-allowed: [test]\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { 'quality-gate': 'node gate.cjs' } }));
  writeFileSync(join(repo, 'payload.txt'), 'pushed');
  writeFileSync(join(repo, 'gate.cjs'), `
    const fs = require('node:fs');
    fs.appendFileSync(process.env.TRACE, JSON.stringify({ gate: true, remote: process.env.REMOTE,
      payload: fs.readFileSync('payload.txt', 'utf8'), extra: fs.existsSync('untracked.txt'),
      project: process.env.CLAUDE_PROJECT_DIR ?? null }) + '\\n');
    const failed = process.env.MODE === 'fail' && process.env.REMOTE;
    const mode = process.env.MODE;
    const report = { variant: 'full-gate', typecheck: {status:'pass'},
      test: {status:failed ? 'fail' : 'pass'}, lint: {status:'pass'} };
    if (mode.startsWith('stub-')) report.stubbed = { [mode.slice(5)]: {kind:'echo'} };
    if (mode.startsWith('timeout-')) report[mode.slice(8)].timed_out = true;
    if (mode === 'skip') report.typecheck.status = report.lint.status = 'skip';
    console.log(JSON.stringify(report));
    process.exit(failed ? 2 : 0);
  `);
  fixtureGit(['init', '-q', repo]);
  fixtureGit(['-C', repo, 'add', '-A']);
  fixtureGit(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'pushed']);
  const sha = fixtureGit(['-C', repo, 'rev-parse', 'HEAD'], undefined, { encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'payload.txt'), 'later HEAD');
  fixtureGit(['-C', repo, 'add', 'payload.txt']);
  fixtureGit(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'later']);
  let source = repo;
  if (linked) {
    source = join(dir, 'worktrees/different-worktree-name');
    fixtureGit(['-C', repo, 'remote', 'add', 'origin', 'https://example.com/org/canonical.git']);
    fixtureGit(['-C', repo, 'worktree', 'add', '--detach', source, 'HEAD']);
  }
  writeFileSync(join(source, 'payload.txt'), 'dirty');
  writeFileSync(join(source, 'untracked.txt'), 'must not sync');
  const trace = join(dir, 'trace');
  writeFileSync(trace, '');
  // Fake only the external CLI. It executes the actual remote wrapper and npm
  // gate, so the receipt, SHA verification and environment scrub are real.
  writeFileSync(join(bin, 'offload'), `#!/usr/bin/env node
    const { spawnSync } = require('node:child_process');
    const fs = require('node:fs');
    const a = process.argv.slice(2), mode = process.env.MODE;
    const record = {cmd:a[0], host:a[2], tree:a[3]};
    if (a[0] === 'run') {
      record.identity = require('node:path').basename(fs.realpathSync(a[3]));
      record.origin = spawnSync('git', ['remote','get-url','origin'], {cwd:a[3], encoding:'utf8'}).stdout.trim();
    }
    fs.appendFileSync(process.env.TRACE, JSON.stringify(record) + '\\n');
    if (a[0] === 'doctor') process.exit(mode === 'not-ready' ? 2 : 0);
    if (mode === 'transport' || mode === 'next' && a[2] === 'first') process.exit(2);
    if (mode === 'empty') process.exit(0);
    if (mode === 'unknown') process.exit(7);
    if (mode === 'malformed-transport') {
      fs.writeSync(1, 'SO_PRE_PUSH_RESULT={\\n');
      process.exit(4);
    }
    // The real CLI always creates a snapshot commit, even with no source edits.
    spawnSync('git', ['-c','user.name=offload','-c','user.email=offload@localhost',
      '-c','core.hooksPath=/dev/null','commit','--quiet','--allow-empty','-m','sync snapshot'], {cwd:a[3]});
    if (mode === 'extra') fs.writeFileSync(a[3] + '/unexpected-source.mjs', '// not pushed');
    const pos = a.indexOf('--');
    const r = spawnSync(a[pos+1], a.slice(pos+2), {cwd:a[3], env:{...process.env, REMOTE:'1'}, encoding:'utf8'});
    let output = r.stdout ?? '';
    const marker = output.split('\\n').find(line => line.startsWith('SO_PRE_PUSH_RESULT='));
    if (marker && ['wrong-sha', 'wrong-nonce', 'malformed'].includes(mode)) {
      const receipt = JSON.parse(marker.slice('SO_PRE_PUSH_RESULT='.length));
      if (mode === 'wrong-sha') receipt.sha = 'b'.repeat(40);
      if (mode === 'wrong-nonce') receipt.nonce = 'another-run';
      output = output.replace(marker, mode === 'malformed' ? 'SO_PRE_PUSH_RESULT={' :
        'SO_PRE_PUSH_RESULT=' + JSON.stringify(receipt));
    }
    if (mode === 'duplicate') output += marker + '\\n';
    fs.writeSync(1, output);
    fs.writeSync(2, r.stderr ?? '');
    process.exit(r.status ?? 1);
  `, { mode: 0o755 });
  let command = 'sh';
  let args = [join(root, '.husky/pre-push')];
  let input = `refs/heads/x ${sha} refs/heads/x ${'0'.repeat(40)}\n`;
  if (tagKind) {
    const target = tagKind === 'commit' ? sha : fixtureGit(['-C', repo, 'rev-parse', `${sha}:payload.txt`],
      undefined, { encoding: 'utf8' }).trim();
    fixtureGit(['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      'tag', '-a', 'v1.0.0', target, '-m', 'release']);
    const destination = join(dir, 'destination.git');
    fixtureGit(['init', '--bare', '-q', destination]);
    fixtureGit(['-C', source, 'remote', 'add', 'publish-fixture', destination]);
    const hooks = join(dir, 'hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\nexec sh '${join(root, '.husky/pre-push')}' "$@"\n`,
      { mode: 0o755 });
    command = 'git';
    args = ['-c', `core.hooksPath=${hooks}`, 'push', 'publish-fixture', 'v1.0.0'];
    input = undefined;
  }
  const res = spawnSync(command, args, {
    cwd: source, encoding: 'utf8', timeout: 30_000,
    input,
    env: { ...process.env, SKIP_QUALITY_GATE: '', PATH: `${bin}:${process.env.PATH}`,
      TRACE: trace, MODE: mode, CLAUDE_PROJECT_DIR: repo },
  });
  return { res, records: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

// Write-gate: local-only tests cannot catch remote fail-open, wrong-SHA sync,
// or treating offload exit 0 without a completed gate as success. One boundary
// table protects these routes without a test-only production API.
it.each([
  ['pass', 0, ['first'], ['1']],
  ['fail', 1, ['first'], ['1']],
  ['next', 0, ['first', 'second'], ['1']],
  ['transport', 0, ['first', 'second'], [undefined]],
  ['not-ready', 0, [], [undefined]],
  ['empty', 1, ['first'], []],
  ['unknown', 1, ['first'], []],
  ['stub-test', 1, ['first'], ['1']],
  ['stub-typecheck', 1, ['first'], ['1']],
  ['stub-lint', 1, ['first'], ['1']],
  ['skip', 0, ['first'], ['1']],
  ['timeout-test', 1, ['first'], ['1']],
  ['timeout-typecheck', 1, ['first'], ['1']],
  ['timeout-lint', 1, ['first'], ['1']],
  ['wrong-sha', 1, ['first'], ['1']],
  ['wrong-nonce', 1, ['first'], ['1']],
  ['malformed', 1, ['first'], ['1']],
  ['malformed-transport', 1, ['first'], []],
  ['duplicate', 1, ['first'], ['1']],
  ['extra', 1, ['first'], []],
])('remote pre-push route %s verifies pushed content and blocks unverified results',
  { timeout: 40_000 }, (mode, status, hosts, gateRoutes) => {
    const { res, records } = runHook(mode);
    expect(res.status, res.stderr).toBe(status);
    expect(records.filter((r) => r.cmd === 'run').map((r) => r.host)).toEqual(hosts);
    expect(records.filter((r) => r.gate).map((r) => r.remote)).toEqual(gateRoutes);
    expect(records.filter((r) => r.gate).map((r) => [r.payload, r.extra, r.project]))
      .toEqual(gateRoutes.map(() => ['pushed', false, null]));
  });

// The CLI derives canonical identity from a linked worktree's common git-dir,
// but a materialized clone is ordinary: its own basename is the route identity.
it('routes a dirty linked worktree through its canonical repository name and usable origin',
  { timeout: 40_000 }, () => {
    const { res, records } = runHook('pass', true);
    expect(res.status, res.stderr).toBe(0);
    expect(records.filter((r) => r.cmd === 'run').map((r) => [r.identity, r.origin]))
      .toEqual([['canonical', 'https://example.com/org/canonical.git']]);
    expect(records.filter((r) => r.gate).map((r) => [r.payload, r.extra, r.project]))
      .toEqual([['pushed', false, null]]);
  });

// Write-gate: Git supplies annotated tag objects, while a checked-out HEAD is a
// commit. Branch-only cases miss release pushes; exercise real Git stdin and
// protect older target content plus denial of tags with no commit tree.
it.each(['commit', 'blob'])('actual annotated %s tag push gates its target commit or blocks before routing',
  { timeout: 40_000 }, (tagKind) => {
    const { res, records } = runHook('pass', false, tagKind);
    if (tagKind === 'commit') {
      expect(res.status, res.stderr).toBe(0);
      expect(records.filter((r) => r.gate).map((r) => [r.remote, r.payload, r.extra, r.project]))
        .toEqual([['1', 'pushed', false, null]]);
    } else {
      expect(res.status, res.stderr).not.toBe(0);
      expect(res.stderr).toContain('does not resolve to a commit');
      expect(records).toEqual([]);
    }
  });
