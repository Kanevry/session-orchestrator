#!/usr/bin/env node
/**
 * Check: every `scripts/**.mjs` path cited in `skills/`, `commands/` and
 * `agents/` either EXISTS or is annotated as deliberately absent (#1176).
 * Extended (#1187) to also cite `scripts/**.sh` and `hooks/**.sh` — see
 * "## Mode: BLOCKING for `.mjs`, ADVISORY for `.sh`" below for why that half
 * is advisory, not blocking.
 *
 * ## Why
 *
 * Prose is not executed. A skill body that tells the coordinator to run
 * `node scripts/lib/auto-commit.mjs` costs an operator a failed command and a
 * re-derivation of what the file was supposed to do — and nothing in the
 * corpus notices, because a markdown file compiles under every gate. Measured
 * 2026-09-02 @ c3ab480: 237 distinct citations across the three scan roots,
 * 7 of them dead.
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
 * ## Mode: BLOCKING for `.mjs`, ADVISORY for `.sh` (#1187)
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
 * dead — but only ONE of those 27 sits inside this checker's three scan roots
 * (`skills/contract-version-bump/SKILL.md:134`, itself arguably a
 * cross-repo path — see the dry-run note at `scanSkillScriptPaths`'s
 * `strictSh` option). The other 26 live in `docs/`, which this checker does
 * NOT scan and — per this same paragraph's own evidence — MUST NOT start
 * scanning as a side effect of the `.sh` extension: `docs/adr/*.md` alone
 * carries 7 dead `.mjs` citations of its own (all historical/planned ADR
 * prose, e.g. `scripts/lib/tool-adapter.mjs`, `scripts/lib/auto-commit.mjs`),
 * none annotated, all outside this task's edit scope. Widening `SCAN_DIRS` to
 * `docs` would turn those 7 into new BLOCKING findings on a doc surface
 * nobody triaged — the opposite of "the `.mjs` behaviour stays exactly as
 * today". So `SCAN_DIRS` stays `['skills', 'commands', 'agents']`; the wider
 * `docs`/`hooks` prose census is a follow-up for whoever owns those files,
 * not a silent scope change here.
 *
 * A `.sh` finding is therefore `WARN:` by default (visible, never blocking —
 * `ok` and the CLI exit code ignore `severity: 'warn'` findings) and only
 * becomes `FAIL:`/blocking under the `--strict-sh` CLI flag (or
 * `strictSh: true` for `scanSkillScriptPaths()` callers) — flip that default
 * once the dead `.sh` citations this checker CAN see are fixed by their doc
 * owner (BV-004 revisit trigger).
 *
 * @module scripts/lib/validate/check-skill-script-paths
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listRepoFiles } from './repo-files.mjs';
import { forEachLine } from './markdown-fences.mjs';

/** Documentation roots whose prose is treated as a claim about the repo. */
export const SCAN_DIRS = Object.freeze(['skills', 'commands', 'agents']);

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
 * `hooks/**.sh` citations.
 *
 * @param {{pluginRoot: string, dirs?: string[], strictSh?: boolean}} options
 *   `strictSh` (default `false`) promotes a dead `.sh` citation from
 *   `severity: 'warn'` to `severity: 'fail'` — see the module docblock
 *   "Mode: BLOCKING for `.mjs`, ADVISORY for `.sh`" for why the default stays
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
    findings: 0,
    warnings: 0,
  };

  /** @type {string[]} */
  let files;
  try {
    // The git index, never a `readdirSync` walk (#1143): a walk cannot see
    // `.gitignore`, so a worktree under `.claude/worktrees/` or any ignored
    // artefact would enter this census as if it were repository documentation.
    files = listRepoFiles(pluginRoot, { dirs, exts: ['.md'] });
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
      // An illustrative placeholder name needs no marker — see
      // `isPlaceholderCitation`'s docblock for the closed fragment list and
      // its named ceiling.
      if (isPlaceholderCitation(citation.path)) {
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

      // `.mjs` is blocking exactly as before this module grew a `.sh` half.
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
  console.log('--- Check: scripts/*.mjs (+ *.sh) paths cited in skills/commands/agents exist ---');
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
      `  PASS: ${s.citations} script citation(s) in ${s.filesScanned} doc file(s) — ` +
        `${s.existing} exist, ${s.annotated} annotated as deliberately absent, ` +
        `${s.placeholders} placeholder(s)` +
        (s.warnings > 0 ? `, ${s.warnings} advisory .sh warning(s) (see --strict-sh)` : ''),
    );
  }
  console.log('');
  console.log(`Results: ${inspection.ok ? 1 : 0} passed, ${blockingCount} failed`);
  return inspection.ok ? 0 : 1;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
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
