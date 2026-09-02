#!/usr/bin/env node
/**
 * Check: every `scripts/**.mjs` path cited in `skills/`, `commands/` and
 * `agents/` either EXISTS or is annotated as deliberately absent (#1176).
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
 * ## Mode: BLOCKING
 *
 * Unlike `check-doc-cli-commands.mjs`, the oracle here is the repository's own
 * filesystem, not a locally installed third-party binary — there is no version
 * skew that could red an unrelated commit. So findings are `FAIL:` and the
 * check returns non-zero.
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

/** A cited script path. Deliberately narrow: no spaces, no glob metacharacters. */
const CITATION_RE = /scripts\/[a-zA-Z0-9_/-]*\.mjs/g;

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
 * Census the documentation corpus for dead `scripts/**.mjs` citations.
 *
 * @param {{pluginRoot: string, dirs?: string[]}} options
 * @returns {{ok: boolean, summary: object, findings: {kind: string, file: string, line: number, path: string, annotation: string | null, message: string}[], toolError: boolean}}
 */
export function scanSkillScriptPaths({ pluginRoot, dirs = SCAN_DIRS }) {
  /** @type {{kind: string, file: string, line: number, path: string, annotation: string | null, message: string}[]} */
  const findings = [];
  const summary = { filesScanned: 0, citations: 0, existing: 0, annotated: 0, findings: 0 };

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
      });
    }

    for (const citation of citations) {
      summary.citations += 1;
      if (existsSync(path.join(pluginRoot, citation.path))) {
        summary.existing += 1;
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
      findings.push({
        kind: 'missing-path',
        file: relative,
        line: citation.line,
        path: citation.path,
        annotation: null,
        message:
          `\`${citation.path}\` does not exist — create it, fix the path, or annotate the ` +
          'citation with `<!-- path-check: planned #<iid> | historical | example -->` on this ' +
          'line or the line directly above',
      });
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  summary.findings = findings.length;
  return { ok: findings.length === 0, summary, findings, toolError: false };
}

/**
 * Run the human-readable validator CLI.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = clean, 1 = findings, 2 = tool error
 */
export function runCheckSkillScriptPaths(pluginRoot) {
  console.log('--- Check: scripts/*.mjs paths cited in skills/commands/agents exist ---');
  const inspection = scanSkillScriptPaths({ pluginRoot });

  for (const item of inspection.findings) {
    console.log(`  FAIL: [${item.kind}] ${item.file}:${item.line} ${item.path} — ${item.message}`);
  }
  if (inspection.toolError) {
    console.log('');
    console.log(`Results: 0 passed, ${inspection.findings.length} failed`);
    return 2;
  }

  const s = inspection.summary;
  if (inspection.ok) {
    console.log(
      `  PASS: ${s.citations} script citation(s) in ${s.filesScanned} doc file(s) — ` +
        `${s.existing} exist, ${s.annotated} annotated as deliberately absent`,
    );
  }
  console.log('');
  console.log(`Results: ${inspection.ok ? 1 : 0} passed, ${inspection.findings.length} failed`);
  return inspection.ok ? 0 : 1;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--json');
  const root = path.resolve(args[0] || process.cwd());
  if (process.argv.includes('--json')) {
    const inspection = scanSkillScriptPaths({ pluginRoot: root });
    // Write, THEN set the exit code — `process.exit()` after a large print
    // discards whatever is still queued on an async stdout pipe.
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    process.exitCode = inspection.toolError ? 2 : inspection.ok ? 0 : 1;
  } else {
    process.exitCode = runCheckSkillScriptPaths(root);
  }
}
