#!/usr/bin/env node
/**
 * Check: every `scripts/**.mjs` path cited in `skills/`, `commands/`,
 * `agents/` and `docs/` either EXISTS or is annotated as deliberately absent
 * (#1176). Extended (#1187) to also cite `scripts/**.sh` and `hooks/**.sh` —
 * see "## Mode" below for why that
 * half is advisory, not blocking. `docs/` joined `SCAN_DIRS` in #1208, after
 * the 22 dead paths it carried at the time (9 `.mjs`, all ADR/reference
 * prose) were annotated — see that section below for the census and why
 * widening the scan root had to wait for the annotation pass, not precede it.
 * #1241 adds blocking repo-rooted `.md` paths quoted as complete inline-code
 * spans, with the same annotations and fence handling. Scan roots stay fixed.
 *
 * ## The runtime-artefact carve-out needs BOTH halves
 *
 * A missing citation is excused as a runtime artefact only when it sits under
 * a harness STATE root ({@link RUNTIME_STATE_PREFIXES}) *and* git ignores it.
 * The git half alone is not the claim it looks like: `.gitignore` also
 * declines to track real local documents (`docs/specs/`, `docs/_private/`) and
 * build output (`coverage/`, `node_modules/`), so "git ignores it" would have
 * silenced a typo in a `docs/specs/…` citation forever — in the very check
 * whose subject is "ships in the tarball, target missing".
 *
 * ## Why
 *
 * Prose is not executed. A skill body that tells the coordinator to run
 * `node scripts/lib/auto-commit.mjs` costs an operator a failed command and a
 * re-derivation of what the file was supposed to do — and nothing in the
 * corpus notices, because a markdown file compiles under every gate. Measured
 * 2026-09-02 @ c3ab480: 237 distinct citations across the (then three) scan
 * roots, 7 of them dead.
 *
 * ## Fences are skipped, and that is most of the answer
 *
 * 4 of those 7 sat inside fenced code blocks — synthetic example paths
 * (`scripts/example.mjs`, `scripts/lib/a.mjs`) in a snippet demonstrating a
 * command's argument shape. A fenced snippet is an illustration of a FORM, not
 * a claim that a file exists, so the shared fence tracker
 * (`./markdown-fences.mjs`, #1181) silences them structurally
 * rather than by allowlist.
 *
 * ## Annotation, and why placement is a rule rather than a convenience
 *
 * A citation in PROSE is a claim. When the claim is deliberate — a planned file
 * behind an issue, a historical path kept for narrative, an inline example —
 * say so on the line:
 *
 *     <!-- path-check: planned #214 -->
 *     <!-- path-check: historical -->
 *     <!-- path-check: example -->
 *
 * The marker is honoured on the SAME line as the citation, or on the line
 * IMMEDIATELY above WHEN THAT LINE CITES NOTHING ITSELF — nowhere else. A line
 * carrying `citation + marker` exempts only that citation; it does not reach
 * down to the next line, which would silently exempt a citation nobody
 * annotated. Two lines above is INERT and the citation
 * still reports, which is pinned by a test. The reason is the rule
 * `recurring-issue-an-exemption-marker-that-only-works-same-line-is-visually-identical-to-one-in-a-comment-block-3bff005.md`
 * in `.claude/rules/`:
 * a marker that reads like an exemption but changes nothing is worse than no
 * marker at all, because the guard then looks wrong instead of the marker
 * looking misplaced. A malformed marker (unknown class, or `planned` without a
 * `#<iid>`) is itself a finding for the same reason — it must never fail silent.
 *
 * ## Mode: BLOCKING for `.mjs` / `.md`, ADVISORY for `.sh` (#1187)
 *
 * Unlike `check-doc-cli-commands.mjs`, the oracle here is the repository's own
 * filesystem, not a locally installed third-party binary — there is no version
 * skew that could red an unrelated commit. So `.mjs` findings are `FAIL:` and
 * the check returns non-zero, EXACTLY as before this module grew a second
 * extension.
 *
 * The `.sh` half of the citation grammar (below) does not get that same
 * severity by default. A #1176 repo-wide grep (`scripts/hooks` prose across
 * `skills/commands/agents/docs/hooks`) found 27 distinct `.sh` citations, 21
 * dead — but at the time only ONE of those 27 sat inside this checker's
 * (then three) scan roots (`skills/contract-version-bump/SKILL.md:134`,
 * itself arguably a cross-repo path — see the dry-run note at
 * `scanSkillScriptPaths`'s `strictSh` option). The other 26 lived in `docs/`,
 * which this checker did not yet scan.
 *
 * #1208 closed that gap in two steps, annotation before widening rather than
 * the reverse: first, a `dirs: ['docs']` re-scan (530 citations, 66 files)
 * found 50 findings — 22 unique dead paths (9 `.mjs`, 15 `.sh`) across
 * 24 (file, path) pairs, concentrated in `docs/adr/*.md` (ADR prose citing
 * not-yet-built modules like `scripts/lib/tool-adapter.mjs`) and
 * `docs/changelog/v2.md` (23 `.sh` citations to the pre-`.mjs`-migration
 * shell scripts, #218/#317 — historical by construction). Every one of the
 * 22 was annotated (`planned #<iid>` for the ADR gaps, `historical` for the
 * changelog, `example` for the one illustrative path in
 * `docs/scope-collision-guard.md`) — zero of them were real defects. Only
 * then did `SCAN_DIRS` gain `'docs'`, so the widening added zero new
 * BLOCKING findings on arrival (re-verify: `scanSkillScriptPaths({
 * pluginRoot, dirs: ['docs'] })` → `ok: true`, `findings: 0`). The wider
 * `hooks/` `.sh` prose census (26 of the 27 `.sh` citations above are outside
 * `SCAN_DIRS` even now, since `hooks/` prose itself is not a scanned root)
 * remains a follow-up for whoever owns those files.
 *
 * A `.sh` finding is therefore `WARN:` by default (visible, never blocking —
 * `ok` and the CLI exit code ignore `severity: 'warn'` findings) and only
 * becomes `FAIL:`/blocking under the `--strict-sh` CLI flag (or
 * `strictSh: true` for `scanSkillScriptPaths()` callers) — flip that default
 * once the dead `.sh` citations this checker CAN see are fixed by their doc
 * owner (BV-004 revisit trigger). `--strict-sh` gained a validate-plugin run
 * surface in #1208 (advisory, non-blocking — see `scripts/validate-plugin.mjs`
 * near its `check-skill-script-paths.mjs` call).
 *
 * @module scripts/lib/validate/check-skill-script-paths
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { enumerateRepoFiles } from './enumerate-repo-files.mjs';
import { forEachLine } from './markdown-fences.mjs';
import { isMainModule } from '../is-main-module.mjs';

/**
 * Documentation roots whose prose is treated as a claim about the repo.
 *
 * `.claude/rules` and `.cursor/rules` joined in #1384 P3. Both are instruction
 * corpora loaded by every session, and both cite repo paths in backticks with
 * exactly the grammar {@link MARKDOWN_CITATION_RE} already judges — but until
 * this widening neither had a gate. The real incident:
 * `.cursor/rules/010-session-workflow.mdc` kept citing `commands/go.md` and
 * `commands/close.md` after `3ebf0e9d` folded those files into their skills,
 * and that surface SHIPS (npm tarball, symlinked into consumer repos by
 * `scripts/cursor-install.mjs`). Same widening, mirrored in
 * `check-skill-links.mjs` § SCAN_DIRS.
 *
 * `rules` and `output-styles` joined in #1384 P3 for the same reason one step
 * further out: both are in `package.json` `files[]`, so both SHIP to every
 * consumer, and neither had a gate. The census that motivated it (whole-repo
 * probe, 2026-09-18 @ 20a4cbff) found 6 dangling citations across them —
 * `output-styles/wave-summary.md` cited `hooks/on-stop.sh` for a file that has
 * been `.mjs` for two migrations, and `rules/opt-in-stack/*` cited
 * consumer-side example paths with no marker.
 *
 * `CHANGELOG.md` stays OUT, and root files are not a scan root at all: a
 * changelog cites the paths a release TOUCHED, so a path deleted afterwards is
 * still a correct historical statement — 88 such hits, all correct by
 * construction. Annotating them would be noise on every future entry.
 */
export const SCAN_DIRS = Object.freeze([
  'skills',
  'commands',
  'agents',
  'docs',
  'rules',
  'output-styles',
  '.claude/rules',
  '.cursor/rules',
]);

/**
 * Extensions treated as instruction markdown.
 *
 * `.mdc` is Cursor's own rule extension and is the ONLY reason `.cursor/rules`
 * is scannable at all: every file there is `<nnn>-<name>.mdc`, so a `.md`-only
 * filter would have added the directory to {@link SCAN_DIRS} and enumerated
 * zero files — a widening that looks live and checks nothing. Same constant,
 * same reason, as `check-skill-links.mjs` § MD_EXTENSIONS.
 */
export const MD_EXTENSIONS = Object.freeze(['.md', '.mdc']);

/**
 * A cited script path. One regex, one alternation, reused for every
 * extension rather than a second scanner (#1187): `scripts/**.mjs` (the
 * original, still the only `.mjs` root scanned), `scripts/**.sh` and
 * `hooks/**.sh`. `hooks/**.mjs` is deliberately NOT part of this grammar —
 * the `.mjs` half of the citation surface stays exactly `scripts/`, matching
 * every existing annotation and fence-skip test unchanged.
 */
const CITATION_RE = /scripts\/[a-zA-Z0-9_/-]*\.(?:mjs|sh)|hooks\/[a-zA-Z0-9_/-]*\.sh/g;

/**
 * A complete inline-code span, including spans delimited by multiple backticks.
 * Consume the outer span before judging its content, so a quoted command that
 * contains backticks cannot donate a nested path-looking substring.
 */
const INLINE_CODE_RE = /(?<!`)(`+)(.+?)(?<!`)\1(?!`)/g;

/**
 * #1241's bounded grammar: a literal repo-rooted .md path, optionally followed
 * by :line, :line:end / :line-end, and #anchor. Only the file is checked.
 * URLs, commands, absolute paths, skill-relative references/, variables and
 * globs are outside this grammar. Matching is line-local; revisit if the
 * instruction corpus adopts multiline path spans or another target root.
 */
const MARKDOWN_CITATION_RE = /^((?:docs|skills|commands|agents|templates|rules|scripts|hooks|tests|\.(?:claude|codex|cursor|pi|orchestrator|gitlab|github))\/[a-zA-Z0-9_./-]+\.md)(?::\d+(?:[:-]\d+)?)?(?:#[^\s`]+)?$/;

/**
 * Filename fragments that mark a citation as an ILLUSTRATIVE placeholder —
 * `scripts/example.sh`, `hooks/my-hook.sh`, `scripts/<name>.sh` — rather than
 * a claim that a real file exists. Checked only for a citation that already
 * failed `existsSync` (a real file is never suppressed by this list, no
 * matter what it's named). Recognised automatically, with no marker needed,
 * because #1176 found 6 such `hooks/*.mjs` example names in hook-development
 * prose (`hooks/example.mjs`, `guard.mjs`, `my-hook.mjs`, …) that would
 * otherwise all need a hand-written `<!-- path-check: example -->` on every
 * occurrence.
 *
 * Ceiling (BV-004): exactly these six fragments, case-insensitive substring
 * match. A REAL path that happens to contain one of them (`scripts/lib/
 * foobar-report.mjs`, `hooks/my-guard.sh`) is indistinguishable from a
 * placeholder by this heuristic and would be silently swallowed if it were
 * ever cited before being created. Revisit by shrinking this list (never
 * growing it further) the moment that collision is observed for real — the
 * escape hatch until then is the same `<!-- path-check: planned #<iid> -->`
 * marker every other deliberate citation already uses.
 */
const PLACEHOLDER_FRAGMENTS = Object.freeze(['example', 'my-', '<', 'placeholder', 'foo', 'bar']);

/**
 * Is `citedPath` an illustrative placeholder name rather than a real path?
 *
 * @param {string} citedPath
 * @returns {boolean}
 */
export function isPlaceholderCitation(citedPath) {
  const lower = citedPath.toLowerCase();
  return PLACEHOLDER_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * The per-harness STATE roots. A missing citation may be excused as a runtime
 * artefact ONLY from inside one of these — and only when git also ignores it
 * (see {@link isRuntimeArtifact}).
 *
 * Each is a harness's own session-state directory: `.orchestrator/` (this
 * plugin's ledgers, locks and metrics), plus the four harness mirrors that
 * carry a per-session `STATE.md` / `wave-scope.json` / `filescopes/` —
 * `.claude/`, `.codex/`, `.cursor/` (all three gitignored file-by-file in this
 * repo's `.gitignore`) and `.pi/` (`skills/_shared/platform-tools.md` § Pi;
 * absent from this checkout, listed so the Pi harness is covered wherever the
 * plugin is installed).
 *
 * Ceiling (BV-004): exactly these five prefixes, and ONLY in conjunction with
 * the git test. `.gitignore` here also declines to track real, hand-authored
 * documents that simply do not ship (`docs/specs/`, `docs/_private/`) and
 * whole build outputs (`coverage/`, `node_modules/`) — a typo in a
 * `docs/specs/…` citation is a defect this check exists to catch, so those
 * must keep REPORTING. Revisit when a harness adds a sixth state root, or
 * when a state root stops being a dot-directory at the repo root.
 */
export const RUNTIME_STATE_PREFIXES = Object.freeze([
  '.orchestrator/',
  '.claude/',
  '.codex/',
  '.cursor/',
  '.pi/',
]);

/**
 * Does `citedPath` live under a harness state root?
 *
 * Necessary but NOT sufficient for the runtime-artefact carve-out — the git
 * test in {@link gitIgnoredPaths} is the second half. `.claude/rules/x.md` is
 * under a state root and TRACKED, so it still reports.
 *
 * @param {string} citedPath repo-relative POSIX path
 * @returns {boolean}
 */
export function isRuntimeStatePath(citedPath) {
  return RUNTIME_STATE_PREFIXES.some((prefix) => citedPath.startsWith(prefix));
}

/**
 * Which of `candidates` git IGNORES — one half of the runtime-artefact test
 * (the other is {@link isRuntimeStatePath}).
 *
 * The rules corpora widened into by #1384 P3 cite paths that never exist in a
 * checkout and are not supposed to: `.cursor/STATE.md`, `.orchestrator/…`
 * ledgers, per-session state files. Rather than a hand-kept name list (which
 * would rot the moment a new ledger is added, and which nothing measures), the
 * test is MECHANICAL and matches the repo's own definition: a path the
 * repository declines to track, which does not exist, is by construction
 * written at runtime — so there is nothing for a citation gate to catch.
 *
 * That predicate alone is too wide, which is why the prefix half exists: "git
 * ignores it" and "it is written at runtime" are not the same claim. Measured
 * 2026-09-18, `gitIgnoredPaths` matched `docs/specs/foo.md`,
 * `docs/_private/x.md`, `coverage/report.md` and `node_modules/x/y.mjs` just
 * as readily as `.orchestrator/metrics/events.jsonl` — real local documents
 * whose dead citations this check must still report.
 *
 * ONE `git check-ignore --stdin` for the whole run, never one per path: the
 * corpus carries hundreds of citations and a per-path spawn would dominate the
 * check's runtime.
 *
 * Fails OPEN toward REPORTING (the safe direction here): a missing `git`, a
 * non-git root, or exit 128 yields an empty set, so every absent citation is
 * still reported and no real defect is suppressed by a tooling failure. Exit 1
 * means "none of them are ignored" and is NOT an error.
 *
 * @param {string} repoRoot absolute repo root
 * @param {string[]} candidates repo-relative POSIX paths (already known absent)
 * @returns {Set<string>} the subset git ignores
 */
export function gitIgnoredPaths(repoRoot, candidates) {
  const unique = [...new Set(candidates)].filter((p) => p.length > 0 && !p.includes('\n'));
  if (unique.length === 0) return new Set();
  let stdout;
  try {
    stdout = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: repoRoot,
      input: `${unique.join('\n')}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    // Exit 1 = nothing matched, and git still wrote (empty) stdout. Anything
    // else (128, ENOENT, non-git root) leaves `stdout` undefined → empty set.
    if (error?.status !== 1) return new Set();
    stdout = typeof error.stdout === 'string' ? error.stdout : '';
  }
  return new Set(
    String(stdout)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/** The annotation marker, in any of its three classes. */
const ANNOTATION_RE = /<!--\s*path-check:\s*([^>]*?)\s*-->/;

/**
 * Judge one annotation payload.
 *
 * @param {string} payload the text between `path-check:` and `-->`
 * @returns {{ok: boolean, class: string}}
 */
export function classifyAnnotation(payload) {
  const text = payload.trim();
  if (text === 'historical' || text === 'example') return { ok: true, class: text };
  const planned = text.match(/^planned\s+#(\d+)$/);
  if (planned) return { ok: true, class: `planned #${planned[1]}` };
  return { ok: false, class: text };
}

/**
 * Split a markdown body into citations and annotations, both OUTSIDE fences.
 *
 * The fence automaton is `./markdown-fences.mjs` (#1181 — one tracker
 * shared with `check-doc-cli-commands.mjs` and
 * `check-vcs-repo-flag.mjs`): a fence opens on ``` / ~~~ with an optional
 * info string and closes on the same character, at least as long, with no
 * info string.
 *
 * Two properties are load-bearing because the automaton fails OPEN:
 *
 * 1. A fence that never closes swallows the whole rest of the file. That is a
 *    doc defect in its own right (`unbalanced-fence`), so it is REPORTED —
 *    and the swallowed tail is re-read as prose, so a dead citation hiding
 *    behind the unmatched opener still surfaces instead of being silenced by
 *    the very defect that made it invisible. Measured on
 *    `agents/db-specialist.md`, where a stray closing fence opened a block
 *    that ran to EOF and blinded the last 41 lines.
 * 2. A fence inside a blockquote (`> ```) is a fence. Without stripping the
 *    `>` chain first, a quoted fenced example is read as prose and its
 *    illustrative paths are reported — a false red, the fail-CLOSED mirror of
 *    the same blind spot.
 *
 * @param {string[]} lines body split on `\n`
 * @returns {{citations: {line: number, path: string}[], annotations: Map<number, {ok: boolean, class: string, raw: string}>, unbalancedFence: {line: number} | null}}
 */
export function extractCitations(lines) {
  /** @type {{line: number, path: string}[]} */
  const citations = [];
  /** @type {Map<number, {ok: boolean, class: string, raw: string}>} */
  const annotations = new Map();

  /**
   * Read one line as prose.
   *
   * @param {string} raw the line
   * @param {number} lineNumber its 1-based position
   */
  const collect = (raw, lineNumber) => {
    const annotation = raw.match(ANNOTATION_RE);
    if (annotation) {
      annotations.set(lineNumber, { ...classifyAnnotation(annotation[1]), raw: annotation[0] });
    }
    for (const hit of raw.matchAll(CITATION_RE)) {
      citations.push({ line: lineNumber, path: hit[0] });
    }
    for (const span of raw.matchAll(INLINE_CODE_RE)) {
      const hit = span[2].match(MARKDOWN_CITATION_RE);
      if (hit) citations.push({ line: lineNumber, path: hit[1] });
    }
  };

  // A blockquoted fence is still a fence — the shared tracker strips the `>`
  // chain before detection so the quoted example's body stays fenced.
  const { unbalancedFenceLine } = forEachLine(
    lines.join('\n'),
    (raw, { lineNumber, inFence }) => {
      if (inFence) return;
      collect(raw, lineNumber);
    },
    { stripBlockquotes: true },
  );

  if (unbalancedFenceLine === null) return { citations, annotations, unbalancedFence: null };

  // EOF with the fence still open: never swallow silently. Re-read the tail as
  // prose so the citations the defect hid are reported alongside it.
  for (let index = unbalancedFenceLine; index < lines.length; index += 1) collect(lines[index], index + 1);
  return { citations, annotations, unbalancedFence: { line: unbalancedFenceLine } };
}

/**
 * Census the documentation corpus for dead `scripts/**.mjs`/`.sh` and
 * `hooks/**.sh` citations, plus repo-rooted `.md` inline-code paths.
 *
 * @param {{pluginRoot: string, dirs?: string[], strictSh?: boolean}} options
 *   `strictSh` (default `false`) promotes a dead `.sh` citation from
 *   `severity: 'warn'` to `severity: 'fail'` — see the module docblock
 *   "Mode" for why the default stays
 *   advisory in this release.
 * @returns {{ok: boolean, summary: object, findings: {kind: string, file: string, line: number, path: string, annotation: string | null, message: string, severity: 'fail' | 'warn'}[], toolError: boolean}}
 */
export function scanSkillScriptPaths({ pluginRoot, dirs = SCAN_DIRS, strictSh = false }) {
  /** @type {{kind: string, file: string, line: number, path: string, annotation: string | null, message: string, severity: 'fail' | 'warn'}[]} */
  const findings = [];
  const summary = {
    filesScanned: 0,
    citations: 0,
    existing: 0,
    annotated: 0,
    placeholders: 0,
    runtimeArtifacts: 0,
    findings: 0,
    warnings: 0,
  };

  /**
   * Citations that are absent AND unannotated — judged only after the corpus
   * loop, when the single `git check-ignore` call can separate a dead
   * reference from a path written at runtime.
   *
   * @type {{file: string, citation: {line: number, path: string}}[]}
   */
  const pending = [];

  /** @type {string[]} */
  let files;
  try {
    // The population is "exists in this repo, tracked or not" (#1248) — NOT
    // "is versioned". A doc that cites a dead script is a defect the moment it
    // is written; the bare git index cannot see it until it is staged, so the
    // check reported clean on the exact tree carrying the bug (measured: an
    // untracked `skills/zz-probe/SKILL.md` → `1 passed, 0 failed` before
    // `git add -A`, `0 passed, 1 failed` after). `enumerateRepoFiles` still
    // honours `.gitignore`, so the #1143 exposure a bare `readdirSync` walk
    // would reintroduce (a worktree under `.claude/worktrees/`, gitignored
    // `docs/specs/*.md`) stays closed — see that module's header.
    files = enumerateRepoFiles({ repoRoot: pluginRoot, dirs, exts: MD_EXTENSIONS });
  } catch (error) {
    findings.push({
      kind: 'tool-error',
      file: '-',
      line: 0,
      path: '-',
      annotation: null,
      message: `cannot enumerate the scan corpus: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'fail',
    });
    return { ok: false, summary, findings, toolError: true };
  }

  for (const absolute of files) {
    const relative = path.relative(pluginRoot, absolute);
    /** @type {string} */
    let body;
    try {
      body = readFileSync(absolute, 'utf8');
    } catch (error) {
      findings.push({
        kind: 'tool-error',
        file: relative,
        line: 0,
        path: '-',
        annotation: null,
        message: `cannot read: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'fail',
      });
      return { ok: false, summary, findings, toolError: true };
    }
    summary.filesScanned += 1;

    const { citations, annotations, unbalancedFence } = extractCitations(body.split('\n'));
    if (unbalancedFence) {
      findings.push({
        kind: 'unbalanced-fence',
        file: relative,
        line: unbalancedFence.line,
        path: '-',
        annotation: null,
        message:
          'a code fence opens here and never closes — every line below it is invisible to this ' +
          'check (a fence closes only with the same character, at least as long, and no info ' +
          'string); close it or remove the stray marker',
        severity: 'fail',
      });
    }
    // Which lines carry a citation of their own. A marker that sits on such a
    // line is that citation's OWN exemption and must not also reach downward.
    const citedLines = new Set(citations.map((c) => c.line));

    // A malformed marker is reported wherever it stands, even with nothing to
    // exempt: it reads as an exemption and grants none.
    for (const [line, annotation] of annotations) {
      if (annotation.ok) continue;
      findings.push({
        kind: 'bad-annotation',
        file: relative,
        line,
        path: '-',
        annotation: annotation.raw,
        message:
          `malformed marker \`${annotation.raw}\` — expected \`path-check: planned #<iid>\`, ` +
          '`path-check: historical` or `path-check: example`',
        severity: 'fail',
      });
    }

    for (const citation of citations) {
      summary.citations += 1;
      if (existsSync(path.join(pluginRoot, citation.path))) {
        summary.existing += 1;
        continue;
      }
      // A script placeholder name needs no marker — see
      // `isPlaceholderCitation`'s docblock for the closed fragment list and
      // its named ceiling. Markdown examples require explicit annotations:
      // a real missing docs/foobar.md must not disappear because of its name.
      if (path.extname(citation.path) !== '.md' && isPlaceholderCitation(citation.path)) {
        summary.placeholders += 1;
        continue;
      }
      // Same line, or the line immediately above — and the line above only
      // when it carries NO citation itself. A `citation + marker` line is one
      // self-contained exemption; letting it also cover the next line silently
      // exempts a dead citation nobody ever annotated (the live shape at
      // skills/wave-executor/wave-loop.md's `example` marker).
      const above = citedLines.has(citation.line - 1)
        ? undefined
        : annotations.get(citation.line - 1);
      const marker = annotations.get(citation.line) ?? above;
      if (marker?.ok) {
        summary.annotated += 1;
        continue;
      }
      if (marker && !marker.ok) continue; // already reported as bad-annotation

      // Deferred, not reported yet: the runtime-artefact test below needs ONE
      // `git check-ignore` for the whole corpus, not one per citation.
      pending.push({ file: relative, citation });
    }
  }

  // BOTH halves, never one: under a harness state root AND untracked by git.
  // Only state-root candidates are even offered to git, so the subprocess
  // shrinks to the paths that could possibly qualify.
  const ignored = gitIgnoredPaths(
    pluginRoot,
    pending.map((p) => p.citation.path).filter(isRuntimeStatePath),
  );

  for (const { file: relative, citation } of pending) {
    if (isRuntimeStatePath(citation.path) && ignored.has(citation.path)) {
      summary.runtimeArtifacts += 1;
      continue;
    }
    // `.mjs` and `.md` are blocking.
    // `.sh` is advisory (`warn`) unless the caller opted into `strictSh`.
    const isSh = path.extname(citation.path) === '.sh';
    const severity = isSh && !strictSh ? 'warn' : 'fail';
    if (severity === 'warn') summary.warnings += 1;
    findings.push({
      kind: 'missing-path',
      file: relative,
      line: citation.line,
      path: citation.path,
      annotation: null,
      message:
        (isSh
          ? severity === 'warn'
            ? `\`${citation.path}\` does not exist (advisory — .sh citations do not block ` +
              'validate-plugin until re-run with --strict-sh; see #1187) — '
            : `\`${citation.path}\` does not exist (--strict-sh) — `
          : `\`${citation.path}\` does not exist — `) +
        'create it, fix the path, or annotate the citation with ' +
        '`<!-- path-check: planned #<iid> | historical | example -->` on this line or the ' +
        'line directly above',
      severity,
    });
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  summary.findings = findings.length;
  const blocking = findings.filter((f) => f.severity !== 'warn');
  return { ok: blocking.length === 0, summary, findings, toolError: false };
}

/**
 * Run the human-readable validator CLI.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = clean, 1 = findings, 2 = tool error
 */
export function runCheckSkillScriptPaths(pluginRoot, { strictSh = false } = {}) {
  console.log('--- Check: script and Markdown paths cited in skills/commands/agents/docs exist ---');
  const inspection = scanSkillScriptPaths({ pluginRoot, strictSh });

  for (const item of inspection.findings) {
    // A `warn`-severity finding (a `.sh` citation, non-strict mode) is
    // reported for visibility but must NOT print as `  FAIL:` — the
    // validate-plugin aggregator counts failures by that exact 2-space
    // prefix (`scripts/validate-plugin.mjs`'s `runCheck()`), so a `WARN:`
    // line is how this check stays advisory end-to-end.
    const label = item.severity === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  ${label}: [${item.kind}] ${item.file}:${item.line} ${item.path} — ${item.message}`);
  }
  if (inspection.toolError) {
    console.log('');
    console.log(`Results: 0 passed, ${inspection.findings.length} failed`);
    return 2;
  }

  const s = inspection.summary;
  const blockingCount = inspection.findings.filter((f) => f.severity !== 'warn').length;
  if (inspection.ok) {
    console.log(
      `  PASS: ${s.citations} file citation(s) in ${s.filesScanned} doc file(s) — ` +
        `${s.existing} exist, ${s.annotated} annotated as deliberately absent, ` +
        `${s.placeholders} placeholder(s)` +
        (s.warnings > 0 ? `, ${s.warnings} advisory .sh warning(s) (see --strict-sh)` : ''),
    );
  }
  console.log('');
  console.log(`Results: ${inspection.ok ? 1 : 0} passed, ${blockingCount} failed`);
  return inspection.ok ? 0 : 1;
}

const isMain =isMainModule(import.meta.url);
if (isMain) {
  const strictSh = process.argv.includes('--strict-sh');
  const args = process.argv.slice(2).filter((arg) => arg !== '--json' && arg !== '--strict-sh');
  const root = path.resolve(args[0] || process.cwd());
  if (process.argv.includes('--json')) {
    const inspection = scanSkillScriptPaths({ pluginRoot: root, strictSh });
    // Write, THEN set the exit code — `process.exit()` after a large print
    // discards whatever is still queued on an async stdout pipe.
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    process.exitCode = inspection.toolError ? 2 : inspection.ok ? 0 : 1;
  } else {
    process.exitCode = runCheckSkillScriptPaths(root, { strictSh });
  }
}
