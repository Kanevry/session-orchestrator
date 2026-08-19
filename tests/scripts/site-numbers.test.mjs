/**
 * site-numbers.test.mjs — tests for scripts/site-numbers.mjs
 *
 * Every test below names the bug it catches (`.claude/rules/test-value.md` TV-001).
 * The centrepiece is the FAKE REGRESSION: a green `--check` proves nothing about
 * a guard that has never bitten (`.claude/rules/testing.md` § Negative-Assertion),
 * so one test plants a wrong number and observes exit 1 on the same fixture that
 * was green a moment earlier.
 *
 * Two hermeticity rules, both deliberate:
 *
 *  1. NO test ever reads or writes the real `site/` files. Every HTML fixture is
 *     written fresh into a `mkdtemp` directory; `--site <tmpdir>` points the CLI
 *     at it. The real page is concurrently authored elsewhere, and a byte-copy of
 *     it would couple this suite to whether THAT file happens to be current —
 *     which is not the contract under test here.
 *
 *     THREE named exceptions, all read-only, all because the claim under test IS
 *     about the shipped files and would be vacuous against a copy:
 *
 *       a. The tracked census snapshot `site/_census.json`. Two tests open it —
 *          the public-schema pin (it is SERVED, so a stray debug field would
 *          ship) and the proof that a `--write --site <tmpdir>` run does not
 *          reach back into it. Neither looks at a single number, so neither
 *          couples to whether the file is current; and the second one would be
 *          untestable against a copy, because "the real file was not touched" is
 *          the claim.
 *       b. The real pages AND that snapshot together — see "page and receipt".
 *          That test compares the two SHIPPED artefacts with EACH OTHER and
 *          never with the repository, so it stays green while both go stale
 *          together and goes red only when they were written by different runs.
 *       c. The real pages alone — see "no hand-maintained version literal". It
 *          asserts the ABSENCE of a literal class in the shipped markup, which a
 *          fixture cannot claim anything about: a fixture is green by
 *          construction because the test author wrote it. It reads no number off
 *          the pages, so it too is freshness-blind.
 *  2. The CLI runs against the REAL repo root (that is where the census lives and
 *     the only place `git rev-parse HEAD` answers), while the census BASIS is
 *     pinned separately against a synthetic directory tree with hardcoded
 *     expectations. That split is what keeps the fake regression from being
 *     tautological: if `collect()` counted the wrong thing, the synthetic-tree
 *     tests go red even though the fixture and the checker agree with each other.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  collect,
  countSkills,
  countCommands,
  countAgents,
  countHookFiles,
  countTestFiles,
  countJsonlEntries,
  readPackageVersion,
  headRef,
  censusPath,
  readCensusSnapshot,
  writeCensusSnapshot,
  listHtmlFiles,
  inspectHtml,
  rewrite,
  SPAN_RE,
  parseArgs,
  METRIC_IDS,
  CENSUS_SCHEMA,
} from '../../scripts/site-numbers.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'site-numbers.mjs');

const tmpDirs = [];
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Run the CLI against the real repo root with an isolated site directory. */
function run(args, { root = REPO_ROOT } = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, root, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * A site fixture shaped like the real proof block: mixed attribute order, a
 * provenance sentence, and one metric repeated in a second page.
 * `overrides` replaces individual cell values to plant a defect.
 */
function writeSiteFixture(values, overrides = {}) {
  const dir = mkTmp('site-numbers-');
  const site = join(dir, 'site');
  mkdirSync(join(site, 'guide'), { recursive: true });
  const v = { ...values, ...overrides };
  const cell = (metric, extra = 'class="num"') =>
    `<span ${extra} data-metric="${metric}">${v[metric]}</span>`;
  writeFileSync(
    join(site, 'index.html'),
    [
      '<!doctype html><html><body>',
      `<p>Counted on ${cell('counted-at', 'class="mono-num"')} at commit ${cell('counted-sha', 'class="mono-num"')}.</p>`,
      '<div class="proof-grid">',
      `  <div class="proof-cell">${cell('version')}<span class="proof-l">current release</span></div>`,
      `  <div class="proof-cell">${cell('skills')}<span class="proof-l">skills</span></div>`,
      `  <div class="proof-cell">${cell('commands')}<span class="proof-l">slash commands</span></div>`,
      `  <div class="proof-cell">${cell('agents')}<span class="proof-l">typed sub-agents</span></div>`,
      // attribute order deliberately inverted here — data-metric BEFORE class
      `  <div class="proof-cell"><span data-metric="hooks" class="num">${v.hooks}</span><span class="proof-l">hook files</span></div>`,
      `  <div class="proof-cell">${cell('tests')}<span class="proof-l">test files</span></div>`,
      `  <div class="proof-cell">${cell('sessions')}<span class="proof-l">sessions</span></div>`,
      `  <div class="proof-cell">${cell('learnings')}<span class="proof-l">learnings</span></div>`,
      '</div></body></html>',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(site, 'guide', 'index.html'),
    `<!doctype html><html><body><p>Version ${cell('version')}</p></body></html>`,
    'utf8',
  );
  return site;
}

let current;
beforeAll(() => {
  // check-untracked-test-deps:ignore — the ledger read is real but no longer fatal:
  // `sessions`/`learnings` fall back to the tracked `site/_census.json`, measured 31/31
  // in a clone with no `.orchestrator/metrics/` at all (#1081). The R2 rule detects the
  // structural dependency; this line records why its consequence is gone.
  const res = collect(REPO_ROOT); // check-untracked-test-deps:ignore
  expect(res.missing).toEqual([]); // the real repo must be measurable, else every test below is meaningless
  current = res.values;
});

describe('fake regression — the guard must go RED on a wrong number', () => {
  it('is green on a fixture built from the live census', () => {
    const site = writeSiteFixture(current);
    const res = run(['--check', '--site', site]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('metric cell(s) current');
  });

  /**
   * BUG CAUGHT: a `--check` that cannot fail — a SPAN_RE that never matches, a
   * comparison that always holds, or an exit code hardcoded to 0. Each of those
   * leaves the green test above passing forever while the page rots, which is
   * the exact failure mode this script was written to end.
   */
  it('exits 1 and names the metric when one cell is wrong', () => {
    const site = writeSiteFixture(current, { sessions: '210' });
    const res = run(['--check', '--site', site]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain(`sessions: page says "210", repo says "${current.sessions}"`);
  });

  /**
   * BUG CAUGHT: --check reporting drift for a cell that is correct. A guard that
   * cries wolf on a current page gets switched off, which is the same outcome as
   * having no guard.
   */
  it('reports exactly the one wrong cell, not its neighbours', () => {
    const site = writeSiteFixture(current, { tests: '556' });
    const res = run(['--check', '--json', '--site', site]);
    const env = JSON.parse(res.stdout);
    expect(env.driftCount).toBe(1);
    expect(env.files.flatMap((f) => f.drift).map((d) => d.metric)).toEqual(['tests']);
  });
});

describe('--write', () => {
  /**
   * BUG CAUGHT: a writer that replaces the wrong capture group — clobbering
   * `class="num"`, dropping the `data-metric` attribute, or swallowing the
   * sibling label span. Also pins idempotency: a --write that leaves drift
   * behind would make the build alternate between red and green.
   */
  it('rewrites stale cells, preserves attributes, and leaves --check green', () => {
    const site = writeSiteFixture(current, { sessions: '210', tests: '556', version: 'v0.0.0' });
    const wrote = run(['--write', '--site', site]);
    expect(wrote.code).toBe(0);

    const html = readFileSync(join(site, 'index.html'), 'utf8');
    expect(html).toContain(`<span data-metric="hooks" class="num">${current.hooks}</span>`);
    expect(html).toContain(`<span class="num" data-metric="sessions">${current.sessions}</span>`);
    expect(html).toContain('<span class="proof-l">sessions</span>');

    const after = run(['--check', '--site', site]);
    expect(after.code).toBe(0);
  });

  /**
   * BUG CAUGHT: the named silent-failure class — a generator that matches
   * nothing, writes nothing, and reports success. Without this the whole
   * build step degrades to a no-op the moment the markup contract is dropped
   * from the page, and nobody finds out.
   */
  it('exits 1 when no data-metric span exists anywhere', () => {
    const dir = mkTmp('site-numbers-nospan-');
    const site = join(dir, 'site');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<html><body><span class="num">46</span></body></html>', 'utf8');

    const res = run(['--write', '--site', site]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('the markup contract is missing');
  });

  /**
   * BUG CAUGHT: silently ignoring an unrecognised data-metric. A typo'd
   * `data-metric="skils"` would otherwise leave that cell hand-maintained
   * forever while --check reported the page as fully current.
   */
  it('exits 1 on an unknown metric id and leaves the file untouched', () => {
    const dir = mkTmp('site-numbers-unknown-');
    const site = join(dir, 'site');
    mkdirSync(site, { recursive: true });
    const file = join(site, 'index.html');
    const before = '<html><span class="num" data-metric="skils">46</span></html>';
    writeFileSync(file, before, 'utf8');

    const res = run(['--write', '--site', site]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('unknown data-metric "skils"');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('provenance stamps are warn-only', () => {
  /**
   * BUG CAUGHT: treating counted-at / counted-sha as drift. They are claims
   * about the PAST, so they would go stale on every commit and every midnight —
   * turning --check permanently red, which trains everyone to ignore it. The
   * inverse bug (never surfacing them at all) is caught by the stderr assertion.
   */
  it('does not fail --check when only the date and sha lag behind', () => {
    const site = writeSiteFixture(current, { 'counted-at': '2026-08-03', 'counted-sha': 'd2de3ca' });
    const res = run(['--check', '--site', site]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('stale');
    expect(res.stderr).toContain('counted-sha');
  });

  it('--write refreshes them', () => {
    const site = writeSiteFixture(current, { 'counted-at': '2026-08-03', 'counted-sha': 'd2de3ca' });
    run(['--write', '--site', site]);
    const html = readFileSync(join(site, 'index.html'), 'utf8');
    expect(html).toContain(`data-metric="counted-sha">${current['counted-sha']}<`);
    expect(html).not.toContain('d2de3ca');
  });
});

describe('census basis', () => {
  /**
   * BUG CAUGHT: counting the wrong thing. This is not hypothetical — the brief
   * that commissioned this script claimed 47 skills by counting the bare
   * directories under `skills/`, which includes `_shared/` (a support dir with no
   * SKILL.md). The canonical census is 46. The same class of error hides in
   * `agents/AGENTS.md` (an authoring spec, not an agent) and in test files
   * nested below the first level of `tests/`.
   */
  function synthRepo() {
    const root = mkTmp('site-numbers-synth-');
    mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(root, 'skills', 'beta'), { recursive: true });
    mkdirSync(join(root, 'skills', '_shared'), { recursive: true }); // no SKILL.md → not a skill
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '# a', 'utf8');
    writeFileSync(join(root, 'skills', 'beta', 'SKILL.md'), '# b', 'utf8');
    writeFileSync(join(root, 'skills', '_shared', 'notes.md'), '# shared helper', 'utf8');

    mkdirSync(join(root, 'commands'), { recursive: true });
    writeFileSync(join(root, 'commands', 'go.md'), 'x', 'utf8');
    writeFileSync(join(root, 'commands', 'README.txt'), 'not a command', 'utf8');

    mkdirSync(join(root, 'agents'), { recursive: true });
    writeFileSync(join(root, 'agents', 'code-implementer.md'), 'x', 'utf8');
    writeFileSync(join(root, 'agents', 'test-writer.md'), 'x', 'utf8');
    writeFileSync(join(root, 'agents', 'AGENTS.md'), 'authoring spec, not an agent', 'utf8');

    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'on-stop.mjs'), 'x', 'utf8');
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{}', 'utf8');

    mkdirSync(join(root, 'tests', 'deep', 'deeper'), { recursive: true });
    writeFileSync(join(root, 'tests', 'a.test.mjs'), 'x', 'utf8');
    writeFileSync(join(root, 'tests', 'deep', 'deeper', 'b.test.mjs'), 'x', 'utf8');
    writeFileSync(join(root, 'tests', 'deep', 'helper.mjs'), 'not a test file', 'utf8');
    return root;
  }

  it('counts skills by SKILL.md presence, not by directory', () => {
    expect(countSkills(synthRepo())).toBe(2);
  });

  it('excludes agents/AGENTS.md and non-.md files from the surface counts', () => {
    const root = synthRepo();
    expect(countAgents(root)).toBe(2);
    expect(countCommands(root)).toBe(1);
  });

  it('counts hook .mjs files on disk and test files at any nesting depth', () => {
    const root = synthRepo();
    expect(countHookFiles(root)).toBe(1); // hooks.json is not a hook file
    expect(countTestFiles(root)).toBe(2); // includes tests/deep/deeper/, excludes helper.mjs
  });

  /**
   * BUG CAUGHT: an off-by-one that flips with an invisible trailing byte.
   * `wc -l` counts newlines, so the same ledger reports N or N-1 depending on
   * whether the last record ends with "\n" — and the ledger is appended to by a
   * different writer than the one reading it here.
   */
  it('counts JSONL entries independent of the trailing newline, flagging corrupt lines', () => {
    const root = mkTmp('site-numbers-jsonl-');
    writeFileSync(join(root, 'with.jsonl'), '{"a":1}\n{"b":2}\n', 'utf8');
    writeFileSync(join(root, 'without.jsonl'), '{"a":1}\n{"b":2}', 'utf8');
    writeFileSync(join(root, 'broken.jsonl'), '{"a":1}\nnot json\n', 'utf8');

    expect(countJsonlEntries(join(root, 'with.jsonl'))).toEqual({ entries: 2, malformed: 0 });
    expect(countJsonlEntries(join(root, 'without.jsonl'))).toEqual({ entries: 2, malformed: 0 });
    expect(countJsonlEntries(join(root, 'broken.jsonl'))).toEqual({ entries: 2, malformed: 1 });
    expect(countJsonlEntries(join(root, 'absent.jsonl'))).toBeNull();
  });
});

describe('CLI contract', () => {
  /**
   * BUG CAUGHT: diagnostics on stdout. `--json` is the machine surface; one
   * stray console.log of an error message makes `jq` / JSON.parse fail on
   * exactly the runs a consumer most needs to parse (`.claude/rules/cli-design.md`).
   */
  it('keeps stdout parseable JSON while errors go to stderr', () => {
    const dir = mkTmp('site-numbers-streams-');
    const site = join(dir, 'site');
    mkdirSync(site, { recursive: true });
    writeFileSync(
      join(site, 'index.html'),
      `<html><span data-metric="skills">${current.skills}</span><span data-metric="nope">1</span></html>`,
      'utf8',
    );

    const res = run(['--check', '--json', '--site', site]);
    expect(res.code).toBe(1);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(JSON.parse(res.stdout).contractViolations).toBe(1);
    expect(res.stderr).toContain('unknown data-metric "nope"');
  });

  /**
   * BUG CAUGHT: publishing a partial census. A root without the repo's surfaces
   * must not yield "0 skills" written onto the page — a plausible-looking number
   * is worse than a loud failure.
   */
  it('exits 2 rather than writing zeros when the census inputs are absent', () => {
    const root = mkTmp('site-numbers-noroot-');
    const site = join(root, 'site');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<html><span data-metric="skills">46</span></html>', 'utf8');

    const res = run(['--check', '--site', site], { root });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('refusing to publish a partial census');
  });

  it('rejects contradictory and unknown flags with exit 2', () => {
    expect(run(['--check', '--write']).code).toBe(2);
    expect(run(['--bogus']).code).toBe(2);
    expect(parseArgs(['--check', '--write']).error).toMatch(/mutually exclusive/);
    expect(parseArgs(['--site']).error).toMatch(/requires a directory path/);
  });

  it('defaults to the read-only mode so a bare invocation never edits the site', () => {
    const args = parseArgs([]);
    expect(args.check).toBe(true);
    expect(args.write).toBe(false);
  });

  it('--help and --version answer on stdout with exit 0', () => {
    const help = run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(METRIC_IDS.join(', '));
    expect(help.stderr).toBe('');

    const version = run(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('markup handling', () => {
  /**
   * BUG CAUGHT: a regex rigid about attribute order or quote style. The real
   * page mixes `class="num" data-metric="x"` and `data-metric="x" class="num"`;
   * a writer that only handles one order silently skips half the cells.
   */
  it('reads metric cells regardless of attribute order or quote style', () => {
    const html =
      `<span class="num" data-metric="skills">1</span>` +
      `<span data-metric='hooks' class="num">2</span>` +
      `<span data-metric="tests" >3</span>`;
    const spans = inspectHtml(html, { skills: '1', hooks: '9', tests: '3' });
    expect(spans.map((s) => s.metric)).toEqual(['skills', 'hooks', 'tests']);
    expect(spans.filter((s) => s.drift).map((s) => s.metric)).toEqual(['hooks']);
  });

  /**
   * BUG CAUGHT: rewriting a cell that contains nested markup, which would
   * destroy page structure. Such a cell is a contract violation to report, never
   * something to overwrite.
   */
  it('flags a cell containing markup and refuses to rewrite it', () => {
    const html = '<span class="num" data-metric="skills"><b>46</b></span>';
    const [span] = inspectHtml(html, { skills: '99' });
    expect(span.malformed).toBe(true);
    expect(rewrite(html, { skills: '99' })).toEqual({ html, replaced: 0, spans: 1, rejected: 0 });
  });
});

// ---------------------------------------------------------------------------
// Safe-value allowlist
//
// The bug this catches: `rewrite()` guarded the OLD cell content against `<>`
// but never the NEW value. Eleven metrics are digits or hex by construction,
// but `version` is whatever package.json says, and readPackageVersion only
// checks "non-empty string". A crafted version literal could close the span and
// open a tag. The precondition is write access to package.json — in this repo's
// trust model already full access — so this is defence in depth. It is still
// worth pinning, because the guard is invisible: nothing else fails if someone
// deletes it.
// ---------------------------------------------------------------------------

describe('safe-value allowlist', () => {
  const cell = '<span class="num" data-metric="version">3.20.0</span>';

  it('writes an ordinary version', () => {
    const r = rewrite(cell, { version: '3.21.0' });
    expect(r.replaced).toBe(1);
    expect(r.rejected).toBe(0);
    expect(r.html).toContain('>3.21.0<');
  });

  it('accepts the shapes real versions actually take', () => {
    for (const v of ['3.20.0', '3.20.0-rc.1', '3.20.0+codex.20260731000000', '1.0.0-beta_2']) {
      expect(rewrite(cell, { version: v }).rejected, v).toBe(0);
    }
  });

  it('refuses a value that would close the span and open a tag', () => {
    const r = rewrite(cell, { version: '3.20.0"></span><script>alert(1)</script>' });
    expect(r.rejected).toBe(1);
    expect(r.replaced).toBe(0);
    expect(r.html).toBe(cell); // byte-identical: nothing was written
  });

  it('refuses angle brackets, quotes and whitespace individually', () => {
    for (const v of ['3.20<b>', '3.20"x', "3.20'x", '3.20 0', '3.20\n0']) {
      const r = rewrite(cell, { version: v });
      expect(r.rejected, JSON.stringify(v)).toBe(1);
      expect(r.html, JSON.stringify(v)).toBe(cell);
    }
  });
});

// ---------------------------------------------------------------------------
// The census snapshot (site/_census.json)
//
// THE BUG THAT MOTIVATED ALL OF THIS: `beforeAll` above calls
// `collect(REPO_ROOT)` and asserts `missing` is empty. Two of the thirteen
// metrics read `.orchestrator/metrics/{sessions,learnings}.jsonl`, which
// `.gitignore` keeps out of every clone. On a developer's machine the ledgers
// exist and the assertion holds; in CI they do not and it throws — and a throw
// in a top-level `beforeAll` takes the WHOLE FILE with it in vitest, so the
// pipeline reported "23 tests | 23 skipped", not "1 failed". Five pipelines were
// red on this. The fix is a tracked snapshot the three clone-absent metrics fall
// back to; these tests pin the fallback's precedence, its narrowness, and the
// fact that it never writes where it must not.
// ---------------------------------------------------------------------------

/** Two JSONL records; the count is deliberately not the snapshot's number. */
const LEDGER = '{"a":1}\n{"b":2}\n{"c":3}\n';

/**
 * A synthetic repository complete enough for all thirteen metrics — the CLI's
 * "wrong root" guard is unforgiving, so a partial tree only ever proves exit 2.
 *
 * @param {object} [o]
 * @param {string[]} [o.omit]     surfaces to leave out ('skills', 'ledgers', …)
 * @param {object|null} [o.snapshot]  `metrics` map written to site/_census.json
 * @param {boolean} [o.page]      write site/index.html with a cell per metric
 */
function synthFullRepo({ omit = [], snapshot = null, page = false } = {}) {
  const root = mkTmp('site-numbers-full-');
  const has = (k) => !omit.includes(k);
  const put = (rel, body) => {
    const abs = join(root, ...rel);
    mkdirSync(join(root, ...rel.slice(0, -1)), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  };

  put(['package.json'], JSON.stringify({ name: 'synth', version: '9.9.9' }));
  if (has('skills')) put(['skills', 'alpha', 'SKILL.md'], '# a');
  if (has('commands')) put(['commands', 'go.md'], 'x');
  if (has('agents')) put(['agents', 'code-implementer.md'], 'x');
  if (has('hooks')) put(['hooks', 'on-stop.mjs'], 'x');
  if (has('tests')) put(['tests', 'a.test.mjs'], 'x');
  if (has('rules')) put(['.claude', 'rules', 'development.md'], '# rules');
  if (has('blocked')) put(['.orchestrator', 'policy', 'blocked-commands.json'], '[{"a":1},{"b":2}]');
  if (has('ledgers')) {
    put(['.orchestrator', 'metrics', 'sessions.jsonl'], LEDGER);
    put(['.orchestrator', 'metrics', 'learnings.jsonl'], LEDGER);
  }

  mkdirSync(join(root, 'site'), { recursive: true });
  if (snapshot) put(['site', '_census.json'], JSON.stringify({ $schema: CENSUS_SCHEMA, metrics: snapshot }));
  if (page) {
    put(
      ['site', 'index.html'],
      `<!doctype html><html><body>${METRIC_IDS.map(
        (id) => `<span class="num" data-metric="${id}">PLACEHOLDER</span>`,
      ).join('\n')}</body></html>`,
    );
  }
  return root;
}

/** Every metric answered by the snapshot — used to prove the fallback is NOT blanket. */
function fullSnapshot() {
  return Object.fromEntries(METRIC_IDS.map((id) => [id, id === 'counted-sha' ? 'deadbee' : '999']));
}

describe('census snapshot — fallback for the metrics a clone does not carry', () => {
  /**
   * BUG CAUGHT: the live CI regression itself. Without this test the fix is
   * unpinned — someone drops `snapshotFallback` from the table, every local run
   * stays green because the ledgers are on disk here, and the next fresh clone
   * takes the whole file down again with 23 skipped tests.
   */
  it('measures a clone-shaped tree (no ledgers) when the snapshot supplies them', () => {
    const root = synthFullRepo({ omit: ['ledgers'], snapshot: fullSnapshot() });
    const res = collect(root);

    expect(res.missing).toEqual([]);
    expect(res.values.sessions).toBe('999');
    expect(res.values.learnings).toBe('999');
    expect(res.fromSnapshot).toEqual(['sessions', 'learnings', 'counted-sha']);
  });

  /**
   * BUG CAUGHT: an implementation that reads the snapshot FIRST, or memoises the
   * live value into it. Either one freezes the page on the numbers of the last
   * release while the repository moves on — which is the hand-maintained
   * derived number this whole script exists to abolish, just stored in JSON.
   */
  it('prefers the live ledger over the snapshot when both exist', () => {
    const root = synthFullRepo({ snapshot: fullSnapshot() });

    // The ledger carries 3 records; the snapshot claims 999.
    const res = collect(root);
    expect(res.values.sessions).toBe('3');
    expect(res.values.learnings).toBe('3');
    expect(res.fromSnapshot).not.toContain('sessions');
    expect(res.fromSnapshot).not.toContain('learnings');
  });

  /**
   * BUG CAUGHT: a BLANKET fallback. With one, any directory holding a copied
   * `site/_census.json` answers all thirteen metrics and exits 0 — the "wrong
   * root" guard ("is this the repository root?") stops biting, and a census of
   * a directory that is not this repository ships as if it had been measured.
   * The ten tracked-input metrics must stay loud however complete the snapshot.
   */
  it('does not let the snapshot answer a metric whose input is tracked', () => {
    const root = synthFullRepo({ omit: ['skills'], snapshot: fullSnapshot(), page: true });

    const res = collect(root);
    expect(res.missing).toEqual(['skills']);
    expect(res.values.skills).toBeUndefined();

    const cli = run(['--check', '--site', join(root, 'site')], { root });
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain('refusing to publish a partial census');
    expect(cli.stderr).toContain('could not measure skills');
  });

  /**
   * BUG CAUGHT: `counted-sha` is null in a tarball / `docker COPY` build (the
   * tree without `.git`), which before the fallback made the whole census a hard
   * exit 2 — a build that carries every file it needs, refusing to build.
   */
  it('survives a tree without .git as long as the snapshot carries the sha', () => {
    const root = synthFullRepo({ snapshot: { 'counted-sha': 'deadbee' } });
    expect(headRef(root)).toBeNull(); // precondition: no ancestor git repo, else this proves nothing

    const res = collect(root);
    expect(res.missing).toEqual([]);
    expect(res.values['counted-sha']).toBe('deadbee');
    expect(res.fromSnapshot).toEqual(['counted-sha']);
  });
});

describe('census snapshot — writing it', () => {
  /**
   * BUG CAUGHT: deriving the snapshot from a SECOND `collect()`. The two
   * measurements can disagree inside one run — `counted-at` flips at midnight
   * and any ledger appended to between them shifts — which publishes a page and
   * a receipt that contradict each other. The receipt is the page's evidence, so
   * a contradiction is worse than either number being stale.
   */
  it('writes the snapshot from the same measurement as the HTML cells', () => {
    const root = synthFullRepo({ snapshot: { 'counted-sha': 'deadbee' }, page: true });

    const res = run(['--write'], { root });
    expect(res.code).toBe(0);

    const snap = readCensusSnapshot(root);
    const html = readFileSync(join(root, 'site', 'index.html'), 'utf8');
    expect(html).not.toContain('PLACEHOLDER');
    for (const id of METRIC_IDS) {
      expect(html, id).toContain(`data-metric="${id}">${snap[id]}</span>`);
    }
    expect(snap.sessions).toBe('3'); // the live ledger, not the fixture's snapshot
    expect(snap['counted-sha']).toBe('deadbee'); // no .git here → the snapshot's own sha survives
  });

  /**
   * BUG CAUGHT: a root-anchored write that ignores `--site`. Every fixture test
   * in this file runs `--write --site <tmpdir>` against the REAL repo root
   * (that is where the census lives), so a snapshot writer keyed on the root
   * alone would rewrite the repository's own `site/_census.json` on every test
   * run — dirtying the working tree from a test suite and tripping
   * release.mjs's clean-tree preflight for reasons nobody would connect to
   * vitest.
   */
  it('leaves the repository census untouched when --site points elsewhere', () => {
    // check-untracked-test-deps:ignore — R2 is closure-based and cannot tell which export
    // of a module reads what: `censusPath()` only joins a path to the TRACKED
    // site/_census.json, but it ships in the same module whose closure names the ledger.
    const real = censusPath(REPO_ROOT); // check-untracked-test-deps:ignore
    expect(existsSync(real), `${real} is tracked and must exist`).toBe(true);
    const before = readFileSync(real, 'utf8');
    const beforeMtime = statSync(real).mtimeMs;

    const site = writeSiteFixture(current, { sessions: '210' });
    const res = run(['--write', '--site', site]);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('_census.json');

    expect(readFileSync(real, 'utf8')).toBe(before);
    expect(statSync(real).mtimeMs).toBe(beforeMtime);
  });

  /**
   * BUG CAUGHT: a later "debug" field — the ledger path, the cwd, a hostname —
   * added to the snapshot. `vercel.json` serves `site/` verbatim, so this file
   * is PUBLIC: anything written into it ships to the internet without a second
   * decision. The key set is asserted against METRIC_IDS rather than a count,
   * per `.claude/rules/testing.md` (no exact-count pins on a growing set).
   */
  it('ships exactly the frozen metric ids and no filesystem paths', () => {
    // check-untracked-test-deps:ignore — same closure-precision limit as above: this reads
    // the TRACKED site/_census.json, not the ledger.
    const raw = JSON.parse(readFileSync(censusPath(REPO_ROOT), 'utf8')); // check-untracked-test-deps:ignore

    expect(Object.keys(raw)).toEqual(['$schema', 'metrics']);
    expect(raw.$schema).toBe(CENSUS_SCHEMA);
    expect(Object.keys(raw.metrics)).toEqual([...METRIC_IDS]);
    for (const [id, v] of Object.entries(raw.metrics)) {
      expect(typeof v, id).toBe('string');
      expect(v, id).not.toMatch(/\//); // a path (or a URL) would betray the build host
    }
  });
});

describe('a known metric with no computed value', () => {
  /**
   * BUG CAUGHT: the quietest failure in the file. `inspectHtml` set
   * `expected = null` for a KNOWN id absent from `values`, so `differs` was
   * false; `rewrite` returned the cell byte-identical without counting it; and
   * `main` printed "N metric cell(s) current" over a number nobody had measured.
   * It was unreachable only because the exit-2 partial-census guard fired first
   * — and that guard is exactly what the snapshot fallback softens. So the state
   * must be a contract violation, not a silent skip.
   */
  it('is reported as a contract violation, not as a current cell', () => {
    const html = '<span class="num" data-metric="sessions">210</span>';
    const [span] = inspectHtml(html, { skills: '46' });

    expect(span.known).toBe(true);
    expect(span.unresolved).toBe(true);
    expect(span.drift).toBe(false); // NOT drift — which is precisely why it needs its own flag
    expect(span.stale).toBe(false);
    expect(rewrite(html, { skills: '46' }).replaced).toBe(0); // and the stale number stays on the page
  });
});

// ---------------------------------------------------------------------------
// The page and its receipt
// ---------------------------------------------------------------------------

describe('page and receipt — the two served artefacts must agree', () => {
  /**
   * BUG CAUGHT: `site/index.html` and `site/_census.json` committed from
   * DIFFERENT `--write` runs. Both are tracked and both are served publicly
   * (`vercel.json` `outputDirectory: "site"`), so a reader who opens
   * `/_census.json` beside the page is reading the machine receipt for the
   * numbers above it. On 2026-08-19 the two disagreed: the page said 252
   * sessions / 135 learnings stamped `6fa214d`, the receipt said 253 / 140
   * stamped `6f6bf58` — two provenance stamps for one "Measured" block.
   *
   * WHY IT COULD HAPPEN, and why a test is the right catcher: `--write` writes
   * both from ONE measurement (that invariant is already pinned, in "writes the
   * snapshot from the same measurement as the HTML cells"), but NOTHING made
   * them travel together afterwards. `release.mjs --set-version` even prints
   * "commit BOTH" — prose, addressed to whoever is reading. This is that
   * sentence made mechanical.
   *
   * WHY THIS IS NOT A FRESHNESS GATE — the thing `release.mjs` explicitly
   * refuses to put in CI, because `sessions` and `learnings` grow every session
   * and such a gate would be permanently red: this test never consults the
   * repository. It compares two COMMITTED files with each other. Both stale by
   * the same measurement is GREEN here; only a split between them is red. That
   * is why it can be a hard test rather than a warning.
   */
  it('every metric cell on every shipped page equals the receipt', () => {
    // check-untracked-test-deps:ignore — both reads are of TRACKED files under site/;
    // the R2 rule flags the module's closure, not which export reads what.
    const snapshot = readCensusSnapshot(REPO_ROOT); // check-untracked-test-deps:ignore
    expect(snapshot, 'site/_census.json must be readable and census-shaped').not.toBe(null);

    const pages = listHtmlFiles(join(REPO_ROOT, 'site'));
    expect(pages, 'site/ must exist').not.toBe(null);

    const mismatched = [];
    const violations = [];
    let cells = 0;

    for (const abs of pages) {
      const rel = abs.slice(REPO_ROOT.length);
      for (const span of inspectHtml(readFileSync(abs, 'utf8'), snapshot)) {
        cells += 1;
        if (!span.known || span.malformed || span.unresolved) {
          violations.push({ file: rel, line: span.line, metric: span.metric });
          continue;
        }
        // BOTH flags. `counted-at`/`counted-sha` are provenance, so a divergence
        // sets `stale` and not `drift` — and the divergence that actually
        // shipped was in `counted-sha`. Asserting on `drift` alone would have
        // been green against the very state this test exists to forbid.
        if (span.drift || span.stale) {
          mismatched.push({ file: rel, line: span.line, metric: span.metric, page: span.actual.trim(), receipt: span.expected });
        }
      }
    }

    expect(violations).toEqual([]);
    expect(mismatched).toEqual([]);
    // Floor, not a pin (`.claude/rules/testing.md` § Dynamic Artifact Counts):
    // the page's proof block grows. Zero cells would mean the loop asserted
    // nothing at all, which is the shape this whole file is built against.
    expect(cells).toBeGreaterThanOrEqual(8);
  });
});

describe('no hand-maintained version literal on a shipped page', () => {
  /**
   * BUG CAUGHT: `site/guide/index.html` shipped `<b>v3.20.0</b>` in its header
   * as a HARD LITERAL, months after the home page had moved every version it
   * shows into `data-metric="version"` cells that `--write` fills. Nothing wrote
   * the guide page, so the release that cut 3.21.0 would have published an
   * install guide announcing 3.20.0 — a wrong version on the one page whose job
   * is "here is how to install the thing you just downloaded", and wrong in the
   * direction a reader can check in one command.
   *
   * WHY THIS IS NOT A PROSE PIN (`.claude/rules/test-value.md` TV-002c): it
   * asserts the ABSENCE of a class of literals in generated markup, never the
   * presence of a sentence. Rewrite every word on both pages and it stays green;
   * re-introduce one hand-maintained version number and it goes red.
   *
   * TWO nets, because a version reaches a page in two shapes:
   *   A. `vX.Y.Z` — how this project writes a release everywhere (brand, git
   *      tags, CHANGELOG headings). Measured over every `.html` under `site/` on
   *      2026-08-19: after this fix, zero outside cells. It is safe to be strict
   *      because the two other triples on the pages carry no `v` — the WCAG
   *      success-criterion number `1.4.11` and the engine range `>=24.0.0`.
   *   B. the CURRENT `package.json` version as a bare substring — catches the
   *      un-prefixed form ("version 3.21.0") at the moment it is INTRODUCED,
   *      which is precisely when it equals package.json and lands in a diff.
   *
   * Neither net reads a number OFF the page, so this test is freshness-blind:
   * a page whose cells are stale is the other test's business, not this one's.
   *
   * THE ONE EXCEPTION is a dated historical record — "re-checked against v3.20.0
   * on 2026-08-19" — marked in the markup with `site-numbers:historical`. It must
   * stay a literal: a release that bumped the version while the date stood still
   * would fabricate a verification nobody ran. The marker is what keeps this
   * test general instead of naming that one line, which WOULD be a prose pin.
   */
  const HISTORICAL_MARKER = 'site-numbers:historical';

  it('carries every version it shows in a data-metric cell, or marked historical', () => {
    // Every read below is of a TRACKED file under site/ plus package.json; the
    // rule fires on the module CLOSURE, not on what this test actually opens.
    // The exemptions are the two same-line markers — a marker in a comment
    // BLOCK is inert (measured 2026-08-19: removing this comment leaves
    // validate-plugin at 172/0; removing the marker on the readPackageVersion
    // line drops it to 171/2), so do not add one here and assume it counts.
    const pages = listHtmlFiles(join(REPO_ROOT, 'site')); // check-untracked-test-deps:ignore
    expect(pages, 'site/ must exist').not.toBe(null);
    expect(pages.length, 'at least the home page and the guide ship').toBeGreaterThanOrEqual(2);

    const currentVersion = readPackageVersion(REPO_ROOT); // check-untracked-test-deps:ignore
    expect(currentVersion, 'package.json must carry a version, else net B asserts nothing').toMatch(
      /^\d+\.\d+\.\d+/,
    );

    const offenders = [];
    for (const abs of pages) {
      const rel = abs.slice(REPO_ROOT.length);
      const html = readFileSync(abs, 'utf8');
      // Blank out each metric cell while PRESERVING newlines, so line numbers in
      // a failure message still point at the real line. A number inside a cell
      // is the mechanism working, not the defect.
      const masked = html.replace(SPAN_RE, (whole) => whole.replace(/[^\n]/g, ' '));
      masked.split('\n').forEach((line, i) => {
        if (line.includes(HISTORICAL_MARKER)) return;
        for (const m of line.matchAll(/v\d+\.\d+\.\d+/g)) {
          offenders.push({ file: rel, line: i + 1, literal: m[0], net: 'v-prefixed release' });
        }
        if (line.includes(currentVersion)) {
          offenders.push({ file: rel, line: i + 1, literal: currentVersion, net: 'current package version' });
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The safe-value allowlist, at the census write
// ---------------------------------------------------------------------------

describe('safe-value allowlist — the served census, not just the served page', () => {
  /**
   * BUG CAUGHT: three of the thirteen metrics reached the PUBLIC
   * `site/_census.json` unvetted. `SAFE_VALUE_RE` was applied only inside
   * `rewrite()`, and `rewrite()` only ever sees a metric that has a
   * `data-metric` span. Measured on 2026-08-19 against the real page:
   *
   *   grep -o 'data-metric="[^"]*"' site/index.html | sort -u | wc -l   -> 10
   *   node -e '…METRIC_IDS.length'                                      -> 13
   *
   * leaving `rules`, `rules-generated` and `blocked-commands` written by
   * `String(values[id])` with no check at all — while the file's own header
   * promises "no paths, no hostnames, no cwd" for the WHOLE file. All three are
   * counters today, so the gap was defence-in-depth rather than a live hole;
   * the promise is still made per file, so the check belongs per file.
   */
  it('refuses to write a census value carrying a path, and writes no file at all', () => {
    const root = mkTmp('site-numbers-census-unsafe-');
    mkdirSync(join(root, 'site'), { recursive: true });

    const res = writeCensusSnapshot(root, { skills: '46', rules: '../../etc/passwd' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unsafe-value');
    expect(res.error).toContain('rules');
    // Not "the bad key was dropped" — nothing was written. A census silently
    // missing one id stops answering that metric in every fresh clone.
    expect(existsSync(censusPath(root))).toBe(false);
  });

  /**
   * BUG CAUGHT: the gap end-to-end, through `main()`, for a metric with NO span.
   * The page here deliberately omits the `version` cell, so `rewrite()` never
   * inspects that value and `rejected` stays 0 — which is exactly the state in
   * which the old code shipped it into the receipt. The run must exit 2 (the
   * caller's existing error path) and leave the previous receipt untouched.
   */
  it('exits 2 when an unvetted value would reach the census through a metric with no span', () => {
    // The snapshot supplies `counted-sha` only — a synthetic tree has no `.git`,
    // and without it the run dies on the partial-census guard before ever
    // reaching the write. It doubles as the "previous receipt" this run must not
    // corrupt.
    const root = synthFullRepo({ snapshot: { 'counted-sha': 'deadbee' } });
    const before = readFileSync(censusPath(root), 'utf8');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'synth', version: '../../etc/passwd' }), 'utf8');
    writeFileSync(
      join(root, 'site', 'index.html'),
      `<!doctype html><html><body>${METRIC_IDS.filter((id) => id !== 'version')
        .map((id) => `<span class="num" data-metric="${id}">PLACEHOLDER</span>`)
        .join('\n')}</body></html>`,
      'utf8',
    );

    const res = run(['--write'], { root });

    expect(res.code).toBe(2);
    expect(res.stderr).toContain('safe-value allowlist');
    expect(res.stderr).toContain('version');
    // Byte-identical: the run refused, it did not half-write.
    expect(readFileSync(censusPath(root), 'utf8')).toBe(before);
  });
});
