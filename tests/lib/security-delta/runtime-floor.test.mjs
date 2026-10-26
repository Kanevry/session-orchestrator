import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runRuntimeFloorCheck } from '../../../scripts/lib/security-delta/runtime-floor.mjs';
import { dropBlob } from '../../_helpers/git-faults.mjs';

const INDEX_TEXT = readFileSync(join(process.cwd(), 'tests/fixtures/security-delta/runtime/node-index.json'), 'utf8');
const okRequest = async () => ({ ok: true, status: 200, text: async () => INDEX_TEXT, json: async () => JSON.parse(INDEX_TEXT) });

let repo;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

/** Two-commit repo: base has `baseFiles`, head adds/overwrites `headFiles`. */
function makeRepo(baseFiles, headFiles) {
  repo = mkdtempSync(join(tmpdir(), 'secdelta-rt-'));
  git('init', '-q');
  git('config', 'user.email', 'dev@example.org');
  git('config', 'user.name', 'Example');
  const commit = (files, msg) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const base = commit({ 'README.txt': 'x\n', ...baseFiles }, 'base');
  const head = commit(headFiles, 'head');
  return { repoRoot: repo, base, head };
}

describe('runRuntimeFloorCheck', () => {
  it('flags an exact .nvmrc below its major security floor (acceptance: 22.23.3 < v22.23.4)', async () => {
    // Bug caught: floor taken from the newest v22 entry (22.24.0, security:false) instead of the newest security one.
    const r = await runRuntimeFloorCheck({ ...makeRepo({}, { '.nvmrc': '22.23.3\n' }), request: okRequest });
    expect(r.status).toBe('ok');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ class: 'runtime-floor', severity: 'high', ecosystem: 'node', package: 'node', version: '22.23.3', fixedIn: '22.23.4', file: '.nvmrc', introduced: true });
  });

  it('finds a node image in a non-ASCII-named Dockerfile via the tree listing (#1775)', async () => {
    // Bug caught: `git ls-tree` without -z quotes the name ("\303\244pp.dockerfile"), isDockerfile
    // misses it and the check reads skipped/no-node-declaration.
    const range = makeRepo({}, { 'äpp.dockerfile': 'FROM node:22.23.3\n' });
    git('config', 'core.quotePath', 'true');
    const r = await runRuntimeFloorCheck({ ...range, request: okRequest });
    expect(r.status).toBe('ok');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ file: 'äpp.dockerfile', version: '22.23.3' });
  });

  it('does not read an engines.node range as a pin (>=22.0.0 sits below the v22 floor but admits it)', async () => {
    // Bug caught: the range's lower bound compared to the floor — a warning on every close of a repo with an engines range.
    const pkg = JSON.stringify({ name: 'x', engines: { node: '>=22.0.0' } });
    const r = await runRuntimeFloorCheck({ ...makeRepo({}, { 'package.json': pkg }), request: okRequest });
    expect(r).toMatchObject({ status: 'not-measurable', reason: 'range', findings: [] });
  });

  it('reports lts/* as not-measurable (acceptance), never as clean', async () => {
    const r = await runRuntimeFloorCheck({ ...makeRepo({}, { '.nvmrc': 'lts/*\n' }), request: okRequest });
    expect(r).toMatchObject({ status: 'not-measurable', reason: 'lts-alias', findings: [] });
  });

  it('degrades with unchecked on a network failure instead of reading as clean', async () => {
    const failing = async () => {
      throw new Error('getaddrinfo ENOTFOUND nodejs.org');
    };
    const r = await runRuntimeFloorCheck({ ...makeRepo({}, { '.nvmrc': '22.23.3\n' }), request: failing });
    expect(r).toMatchObject({ status: 'degraded', reason: 'network', unchecked: 1, findings: [] });
  });

  it('marks an unchanged below-floor declaration as not introduced and never fetches past the deadline', async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return okRequest();
    };
    const range = makeRepo({ '.nvmrc': '22.23.3\n' }, { 'other.txt': 'y\n' });
    const r = await runRuntimeFloorCheck({ ...range, request: counting });
    expect(r.findings[0]).toMatchObject({ fixedIn: '22.23.4', introduced: false });

    const late = await runRuntimeFloorCheck({ ...range, request: counting, deadlineAt: Date.now() - 1 });
    expect(late).toMatchObject({ status: 'degraded', reason: 'timeout', unchecked: 1 });
    expect(calls).toBe(1);
  });

  it('counts a declaration file git cannot read as unchecked, not as absent (#1774)', async () => {
    // Bug caught: an unreadable .node-version read as "no declaration", so the run said ok.
    const range = makeRepo({}, { '.nvmrc': '22\n', '.node-version': 'v22\n' });
    dropBlob(repo, range.head, '.node-version');
    const r = await runRuntimeFloorCheck({ ...range, request: okRequest });
    expect(r).toMatchObject({ status: 'degraded', reason: 'unreadable', checked: 1, unchecked: 1 });
  });

  it('reports a finding as introduced when the base declaration cannot be read (#1774)', async () => {
    // Bug caught: an unreadable base read as "line already there", so a version below the floor counted as pre-existing.
    const range = makeRepo({ '.nvmrc': '22.23.3\n' }, { '.nvmrc': '22.23.3\n# pinned\n' });
    dropBlob(repo, range.base, '.nvmrc');
    const r = await runRuntimeFloorCheck({ ...range, request: okRequest });
    expect(r).toMatchObject({ status: 'degraded', reason: 'unreadable', checked: 1, unchecked: 1 });
    expect(r.findings[0]).toMatchObject({ fixedIn: '22.23.4', introduced: true });
  });
});
