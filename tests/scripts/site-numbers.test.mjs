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
 *  2. The CLI runs against the REAL repo root (that is where the census lives and
 *     the only place `git rev-parse HEAD` answers), while the census BASIS is
 *     pinned separately against a synthetic directory tree with hardcoded
 *     expectations. That split is what keeps the fake regression from being
 *     tautological: if `collect()` counted the wrong thing, the synthetic-tree
 *     tests go red even though the fixture and the checker agree with each other.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
  inspectHtml,
  rewrite,
  parseArgs,
  METRIC_IDS,
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
  const res = collect(REPO_ROOT);
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
