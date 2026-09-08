/**
 * Tests for scripts/lib/validate/check-skill-script-paths.mjs (#1176).
 *
 * Every case names the concrete defect it catches; the live repo is only ever
 * used for the CLI contract (exit 0), never as a fixture — a test that pinned
 * the live corpus would pin its defect state and punish the repair.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  classifyAnnotation,
  extractCitations,
  isPlaceholderCitation,
  scanSkillScriptPaths,
  SCAN_DIRS,
} from '../../../scripts/lib/validate/check-skill-script-paths.mjs';
import { fixtureGitSpawn, makeTmpDir, removeTree } from '../../_helpers/tmp-fixture.mjs';

const repoRoot = process.cwd();
const checkScript = path.join(repoRoot, 'scripts/lib/validate/check-skill-script-paths.mjs');

/**
 * A throwaway plugin root holding one skill doc plus the script files named.
 *
 * @param {string} body markdown for `skills/demo/SKILL.md`
 * @param {string[]} [existingScripts] repo-relative script paths to create
 * @returns {string} absolute fixture root
 */
function fixtureRoot(body, existingScripts = []) {
  const root = makeTmpDir('skill-script-paths-');
  mkdirSync(path.join(root, 'skills/demo'), { recursive: true });
  writeFileSync(path.join(root, 'skills/demo/SKILL.md'), body);
  for (const relative of existingScripts) {
    mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    writeFileSync(path.join(root, relative), 'export const x = 1;\n');
  }
  return root;
}

/** @param {string} body @param {string[]} [scripts] @param {{strictSh?: boolean}} [opts] */
function scanFixture(body, scripts = [], opts = {}) {
  const root = fixtureRoot(body, scripts);
  try {
    return scanSkillScriptPaths({ pluginRoot: root, ...opts });
  } finally {
    removeTree(root);
  }
}

describe('SCAN_DIRS', () => {
  it('includes docs (#1208 — the checker now scans ADR/reference prose too)', () => {
    // Pins the flip: a regression here would silently narrow the scan back to
    // skills/commands/agents and stop catching dead citations in docs/*.md.
    expect(SCAN_DIRS).toContain('docs');
  });
});

describe('scanSkillScriptPaths', () => {
  it('passes a citation whose file exists', () => {
    // Bug: a checker that judged existence wrongly would red the whole corpus.
    const result = scanFixture('Run `scripts/lib/real.mjs` to do the thing.\n', [
      'scripts/lib/real.mjs',
    ]);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary.existing).toBe(1);
  });

  it('reports a missing path cited in prose', () => {
    // THE bug this check exists for: `skills/wave-executor/wave-loop.md` told
    // the coordinator about `scripts/lib/auto-commit.mjs`, which never existed.
    const result = scanFixture('The body lands in `scripts/lib/ghost.mjs` later.\n');
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'missing-path',
      file: 'skills/demo/SKILL.md',
      line: 1,
      path: 'scripts/lib/ghost.mjs',
    });
  });

  it.each([
    {
      label: 'a same-line annotation',
      body: 'Planned as `scripts/lib/ghost.mjs`. <!-- path-check: planned #214 -->\n',
    },
    {
      label: 'an annotation on the line immediately above',
      body: '<!-- path-check: historical -->\nThe old `scripts/lib/ghost.mjs` did this.\n',
    },
  ])('accepts $label', ({ body }) => {
    const result = scanFixture(body);
    expect(result.findings).toEqual([]);
    expect(result.summary.annotated).toBe(1);
  });

  it('treats an annotation two lines above as INERT', () => {
    // Pins the placement rule. A marker that looks like an exemption and grants
    // none makes the guard look wrong instead of the marker look misplaced
    // (.claude/rules/recurring-issue-an-exemption-marker-that-only-works-same-line…).
    const result = scanFixture(
      '<!-- path-check: example -->\n\nThe old `scripts/lib/ghost.mjs` did this.\n',
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe('missing-path');
    expect(result.findings[0].line).toBe(3);
  });

  it("does not let a citation+marker line exempt the NEXT line's citation", () => {
    // The bug (F4, wave-2 review): the line-above lookup fired unconditionally,
    // so a same-line marker — which is that line's own exemption — also covered
    // the line below it. A dead citation written directly under an annotated
    // one was then silently exempt, never annotated by anyone.
    const result = scanFixture(
      'Run `scripts/lib/ghost-a.mjs`. <!-- path-check: historical -->\n' +
        'Run `scripts/lib/ghost-b.mjs`.\n',
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'missing-path',
      line: 2,
      path: 'scripts/lib/ghost-b.mjs',
    });
    // The annotated citation on line 1 stays exempt — the fix narrows the
    // marker's reach, it does not revoke it.
    expect(result.summary.annotated).toBe(1);
  });

  it('ignores a missing path inside a fenced code block', () => {
    // Bug: without fence-skipping, every synthetic example path in a bash
    // snippet (`scripts/example.mjs`) reds the gate and invites an allowlist.
    const result = scanFixture(
      'Example:\n\n```bash\nnode scripts/example.mjs --wave 3\n```\n\nDone.\n',
    );
    expect(result.findings).toEqual([]);
    expect(result.summary.citations).toBe(0);
  });

  // The fence automaton fails OPEN: whatever it wrongly believes to be inside a
  // fence is silently un-checked. Each row names the shape that made it lie.
  it.each([
    {
      label: 'an unclosed fence reported, with the citations it swallowed',
      // LIVE: agents/db-specialist.md carried a stray closing fence that OPENED
      // a block running to EOF — 41 lines invisible, dead citations included.
      body: 'text\n```bash\necho hi\n\ntext scripts/dead-a.mjs here\n',
      expected: [
        { kind: 'unbalanced-fence', line: 2 },
        { kind: 'missing-path', line: 5, path: 'scripts/dead-a.mjs' },
      ],
    },
    {
      label: 'a 3-backtick line as a NON-closer of a 4-backtick fence',
      // CommonMark: a closer needs the same char, length >= opener, no info
      // string. Treating the inner ``` as a closer would expose the snippet's
      // second half as prose and red every example path in it.
      body:
        'Intro.\n\n````\nnode scripts/inside-a.mjs\n```\nnode scripts/inside-b.mjs\n````\n\n' +
        'Then `scripts/dead-outside.mjs`.\n',
      expected: [{ kind: 'missing-path', line: 9, path: 'scripts/dead-outside.mjs' }],
    },
    {
      label: '`~~~` fences',
      body: 'Example:\n~~~\nnode scripts/inside.mjs\n~~~\nProse `scripts/dead.mjs`.\n',
      expected: [{ kind: 'missing-path', line: 5, path: 'scripts/dead.mjs' }],
    },
    {
      label: 'a fence inside a blockquote (fail-CLOSED mirror: a false red)',
      // A quoted fenced example is an illustration, exactly like an unquoted
      // one. Without stripping the `>` chain its paths are read as claims.
      body: '> ```bash\n> node scripts/quoted-example.mjs\n> ```\n',
      expected: [],
    },
  ])('handles $label', ({ body, expected }) => {
    const result = scanFixture(body);
    expect(
      result.findings.map((f) => ({
        kind: f.kind,
        line: f.line,
        ...(f.path !== '-' && { path: f.path }),
      })),
    ).toEqual(expected);
    expect(result.ok).toBe(expected.length === 0);
  });

  // Bug: a malformed marker is inert but reads as an exemption — it must never
  // fail silent, or the citation is silently un-guarded.
  it.each([
    {
      label: '`planned` without a #<iid>',
      body: 'Planned as `scripts/lib/ghost.mjs`. <!-- path-check: planned -->\n',
      annotation: '<!-- path-check: planned -->',
    },
    {
      label: 'an unknown annotation class',
      body: 'Text. <!-- path-check: someday -->\n',
      annotation: '<!-- path-check: someday -->',
    },
  ])('reports $label as a bad annotation', ({ body, annotation }) => {
    const result = scanFixture(body);
    expect(result.findings.map((f) => f.kind)).toEqual(['bad-annotation']);
    expect(result.findings[0].annotation).toBe(annotation);
  });
});

describe('scanSkillScriptPaths — .sh extension (#1187)', () => {
  it('reports a dead .sh citation as WARN by default (never blocking)', () => {
    // THE bug this extension exists for: a `.sh` citation could rot exactly
    // like a `.mjs` one, but this checker never looked. Non-strict mode must
    // surface the finding without turning `ok` false — the corpus this
    // checker can see has one such citation today and validate-plugin must
    // stay green until its doc owner fixes it (see the module docblock).
    const result = scanFixture('Run `scripts/ghost.sh` to do the thing.\n');
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'missing-path',
      path: 'scripts/ghost.sh',
      severity: 'warn',
    });
    expect(result.summary.warnings).toBe(1);
  });

  it('promotes the same dead .sh citation to FAIL under strictSh: true', () => {
    const result = scanFixture('Run `scripts/ghost.sh` to do the thing.\n', [], { strictSh: true });
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'missing-path',
      path: 'scripts/ghost.sh',
      severity: 'fail',
    });
  });

  it('reports a dead hooks/**.sh citation (the alternation covers both roots)', () => {
    const result = scanFixture('See `hooks/ghost.sh` for the guard.\n');
    expect(result.ok).toBe(true);
    expect(result.findings[0]).toMatchObject({ path: 'hooks/ghost.sh', severity: 'warn' });
  });

  it('does NOT treat a hooks/**.mjs citation as a citation at all', () => {
    // The `.mjs` half of the grammar stays scripts/-only — unchanged from
    // before this extension. A `hooks/*.mjs` mention (the 6 "likely
    // hook-development examples" from the #1176 census) must not even enter
    // the citation count, dead or not.
    const result = scanFixture('See `hooks/example.mjs` for the guard.\n');
    expect(result.findings).toEqual([]);
    expect(result.summary.citations).toBe(0);
  });

  it('passes an existing .sh citation exactly like an existing .mjs one', () => {
    const result = scanFixture('Run `scripts/real.sh` to do the thing.\n', ['scripts/real.sh']);
    expect(result.findings).toEqual([]);
    expect(result.summary.existing).toBe(1);
  });

  it('ignores a missing .sh path inside a fenced code block', () => {
    const result = scanFixture(
      'Example:\n\n```bash\nbash scripts/example-runner.sh --wave 3\n```\n\nDone.\n',
    );
    expect(result.findings).toEqual([]);
    expect(result.summary.citations).toBe(0);
  });

  it('does not report an example.sh placeholder', () => {
    const result = scanFixture('Run `scripts/example.sh` to see the shape.\n');
    expect(result.findings).toEqual([]);
    expect(result.summary.placeholders).toBe(1);
  });

  it('does not report a .sh path with a path-check: example marker', () => {
    const result = scanFixture(
      'Planned as `scripts/lib/ghost.sh`. <!-- path-check: example -->\n',
    );
    expect(result.findings).toEqual([]);
    expect(result.summary.annotated).toBe(1);
  });
});

describe('repo-rooted Markdown citations (#1241)', () => {
  it('blocks a planted dead Markdown citation through both CLI outputs', () => {
    // Bug: dead Markdown pointers were invisible, including real names that
    // happen to contain a script-placeholder fragment such as "bar".
    const root = fixtureRoot('Read `docs/barrier-rollout.md:12:18#phase`.\n');
    try {
      const human = spawnSync('node', [checkScript, root], { encoding: 'utf8' });
      const json = spawnSync('node', [checkScript, root, '--json'], { encoding: 'utf8' });
      expect(human.status).toBe(1);
      expect(human.stdout).toContain('  FAIL: [missing-path] skills/demo/SKILL.md:1 docs/barrier-rollout.md');
      expect(json.status).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: false,
        findings: [{ kind: 'missing-path', line: 1, path: 'docs/barrier-rollout.md', severity: 'fail' }],
      });
    } finally {
      removeTree(root);
    }
  });

  it('resolves line ranges and anchors against the file, including hidden roots', () => {
    // Bug: checking a citation suffix as part of its filename falsely rejects
    // a real target; script-placeholder names must still count as existing.
    const result = scanFixture(
      '`docs/my-guide.md#phase` and `docs/my-guide.md:12#phase`\n' +
      '`docs/my-guide.md:12:18` and ``.claude/rules/foobar.md:12-18#phase``\n',
      ['docs/my-guide.md', '.claude/rules/foobar.md'],
    );
    expect(result.findings).toEqual([]);
    expect(result.summary.existing).toBe(4);
  });

  it('requires annotations for examples and keeps each marker with its own cited line', () => {
    // Bug: adding Markdown extraction without adding it to citedLines lets a
    // Markdown marker exempt the next script; the reverse must also stay closed.
    const result = scanFixture(
      '`docs/old.md` <!-- path-check: historical -->\n' +
      '`scripts/dead.mjs`\n' +
      '<!-- path-check: planned #1241 -->\n`docs/future.md`\n' +
      '`scripts/old.mjs` <!-- path-check: historical -->\n' +
      '`docs/foo.md`\n' +
      '`docs/my-example.md` <!-- path-check: example -->\n',
    );
    expect(result.findings.map(({ line, path: citedPath, severity }) => ({ line, path: citedPath, severity }))).toEqual([
      { line: 2, path: 'scripts/dead.mjs', severity: 'fail' },
      { line: 6, path: 'docs/foo.md', severity: 'fail' },
    ]);
    expect(result.summary.annotated).toBe(4);
    expect(result.summary.placeholders).toBe(0);
  });

  it('collects only a complete repo-rooted path inside an inline span outside fences', () => {
    // Bug: a substring scan invents citations inside commands, URLs, absolute
    // paths and skill-relative references; a separate scanner loses fences.
    const { citations } = extractCitations([
      '`https://example.test/docs/dead.md` `/tmp/docs/dead.md` `cat docs/dead.md`',
      '`references/phase.md` docs/bare.md ``use `docs/nested.md` here``',
      '> ~~~', '> `docs/fenced.md`', '> ~~~',
      '`skills/demo/SKILL.md` and `.github/PULL_REQUEST_TEMPLATE.md`',
    ]);
    expect(citations).toEqual([
      { line: 6, path: 'skills/demo/SKILL.md' },
      { line: 6, path: '.github/PULL_REQUEST_TEMPLATE.md' },
    ]);
  });

  it('reports a Markdown citation hidden behind an unclosed fence', () => {
    // Bug: the recovery collector must also see Markdown, or an unmatched
    // opener still hides the very pointers this extension is meant to check.
    const result = scanFixture('```\n`docs/swallowed.md`\n');
    expect(result.findings.map(({ kind, line, path: citedPath }) => ({ kind, line, path: citedPath }))).toEqual([
      { kind: 'unbalanced-fence', line: 1, path: '-' },
      { kind: 'missing-path', line: 2, path: 'docs/swallowed.md' },
    ]);
  });
});

describe('isPlaceholderCitation', () => {
  it.each([
    ['scripts/example.sh', true],
    ['hooks/my-hook.sh', true],
    ['scripts/<name>.sh', true],
    ['scripts/lib/foo.mjs', true],
    ['hooks/bar.sh', true],
    ['scripts/lib/placeholder.mjs', true],
    ['scripts/lib/real-thing.mjs', false],
    ['hooks/enforce-scope.sh', false],
  ])('classifies %s as placeholder=%s', (citedPath, expected) => {
    expect(isPlaceholderCitation(citedPath)).toBe(expected);
  });
});

describe('extractCitations', () => {
  it('collects every citation on one line and skips fenced ones', () => {
    const { citations } = extractCitations([
      'a `scripts/lib/bar.mjs` and `scripts/lib/foo/bar.mjs`',
      '```',
      'scripts/fenced.mjs',
      '```',
    ]);
    expect(citations).toEqual([
      { line: 1, path: 'scripts/lib/bar.mjs' },
      { line: 1, path: 'scripts/lib/foo/bar.mjs' },
    ]);
  });

  it.each([
    { label: 'a balanced body', lines: ['a', '```', 'scripts/x.mjs', '```', 'b'], opener: null },
    { label: 'an unclosed fence', lines: ['a', '```bash', 'echo hi'], opener: { line: 2 } },
    {
      label: 'a 3-backtick non-closer of a 4-backtick fence',
      lines: ['````', 'echo hi', '```', 'echo ho'],
      opener: { line: 1 },
    },
  ])('reports the open-at-EOF opener for $label', ({ lines, opener }) => {
    expect(extractCitations(lines).unbalancedFence).toEqual(opener);
  });
});

describe('classifyAnnotation', () => {
  it('accepts the three documented classes and rejects everything else', () => {
    expect(classifyAnnotation('historical').ok).toBe(true);
    expect(classifyAnnotation('example').ok).toBe(true);
    expect(classifyAnnotation('planned #214').ok).toBe(true);
    expect(classifyAnnotation('planned').ok).toBe(false);
    expect(classifyAnnotation('planned #abc').ok).toBe(false);
    expect(classifyAnnotation('').ok).toBe(false);
  });
});

describe('CLI contract against the live repo', () => {
  it('exits 0 — the corpus is clean', () => {
    const result = spawnSync('node', [checkScript, repoRoot], { encoding: 'utf8' });
    expect(result.stdout).toContain('Results: 1 passed, 0 failed');
    expect(result.status).toBe(0);
  });

  it('--json emits a parseable envelope with ok:true', () => {
    const result = spawnSync('node', [checkScript, repoRoot, '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.toolError).toBe(false);
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  it('census: the automaton ends OUTSIDE a fence for every scanned doc file', () => {
    // The blind spot this pins is invisible by construction — an unclosed fence
    // hides the rest of a file, and today nothing dead happens to sit there. If
    // it silently returns, a future dead citation is un-checked, not reported.
    const inspection = scanSkillScriptPaths({ pluginRoot: repoRoot });
    expect(inspection.findings.filter((f) => f.kind === 'unbalanced-fence')).toEqual([]);
    expect(inspection.summary.filesScanned).toBeGreaterThan(100);
  });

  it('--strict-sh flips a dead .sh citation to a blocking exit code', () => {
    // A FIXTURE, deliberately — never the live repo. The live corpus already
    // carries one dead `.sh` citation this checker CAN see (tracked in
    // OUT-OF-SCOPE), so a live-repo assertion of `status: 1` here would pin
    // that defect and go red the moment its doc owner fixes it — exactly the
    // anti-pattern this file's own header warns against.
    const root = fixtureRoot('Run `scripts/ghost.sh` please.\n');
    try {
      const nonStrict = spawnSync('node', [checkScript, root], { encoding: 'utf8' });
      expect(nonStrict.status).toBe(0);
      const strict = spawnSync('node', [checkScript, root, '--strict-sh'], { encoding: 'utf8' });
      expect(strict.status).toBe(1);
      expect(strict.stdout).toContain('FAIL:');
    } finally {
      removeTree(root);
    }
  });
});

// ---------------------------------------------------------------------------
// #1248 — an UNTRACKED doc with a dead citation must FAIL
// ---------------------------------------------------------------------------

/**
 * THE BUG (measured in a clone, Wave-1 D6 2026-09-06): an untracked
 * `skills/zz-probe/SKILL.md` citing `scripts/does-not-exist.mjs` reported
 * `1 passed, 0 failed` BEFORE `git add -A` and `0 passed, 1 failed` AFTER —
 * same tree, same defect, no edit in between. The enumeration ran off the git
 * index, so the file most likely to carry a fresh defect (a skill just
 * written) was structurally invisible.
 *
 * The fixtures above are non-git tmpdirs, which take the enumerator's WALK
 * path and could never have caught this; these two cases `git init` on
 * purpose so the primary (`git ls-files`) path is the one under test.
 */
describe('#1248 — enumeration must see untracked files', () => {
  const gitRoots = [];

  /** Hermetic, maintenance-free git — see `tests/_helpers/tmp-fixture.mjs` header. */
  const git = (cwd, args) => fixtureGitSpawn(args, cwd);

  /** A git repo whose ONLY committed doc is clean; the defective doc is added but never staged. */
  function gitFixtureRoot() {
    const root = makeTmpDir('skill-script-paths-git-');
    gitRoots.push(root);
    mkdirSync(path.join(root, 'skills/tracked'), { recursive: true });
    writeFileSync(path.join(root, 'skills/tracked/SKILL.md'), 'Nothing cited here.\n');
    git(root, ['init', '-q']);
    git(root, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', 'skills/tracked/SKILL.md']);
    git(root, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
    return root;
  }

  afterEach(() => {
    for (const root of gitRoots.splice(0)) {
      removeTree(root);
    }
  });

  it('FAILS on an untracked SKILL.md citing a non-existent script — without ever `git add`-ing it', () => {
    const root = gitFixtureRoot();
    mkdirSync(path.join(root, 'skills/zz-probe'), { recursive: true });
    writeFileSync(
      path.join(root, 'skills/zz-probe/SKILL.md'),
      'Run `node scripts/does-not-exist.mjs` to do the thing.\n',
    );

    const result = scanSkillScriptPaths({ pluginRoot: root });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.path)).toContain('scripts/does-not-exist.mjs');

    const cli = spawnSync('node', [checkScript, root], { encoding: 'utf8' });
    expect(cli.status).toBe(1);
    // Proof the file really is untracked: staging is what USED to be required.
    expect(git(root, ['status', '--porcelain', '--untracked-files=all']).stdout).toContain(
      '?? skills/zz-probe/SKILL.md',
    );
  });

  it('still ignores a GITIGNORED doc — the walk-based repair would have counted it (#1143)', () => {
    const root = gitFixtureRoot();
    writeFileSync(path.join(root, '.gitignore'), 'skills/private/\n');
    mkdirSync(path.join(root, 'skills/private'), { recursive: true });
    writeFileSync(
      path.join(root, 'skills/private/SKILL.md'),
      'Run `node scripts/also-missing.mjs`.\n',
    );

    const result = scanSkillScriptPaths({ pluginRoot: root });
    expect(result.findings.map((f) => f.path)).not.toContain('scripts/also-missing.mjs');
    expect(result.ok).toBe(true);
  });
});
