#!/usr/bin/env node
/**
 * check-skill-links.mjs — every relative markdown link under an instruction surface must resolve.
 *
 * WHY THIS EXISTS (measured 2026-09-06, session main-2026-09-06-deep-1):
 * The #1157 `references/` splits moved 16 phase blocks out of three oversized skill bodies and
 * verified each move with a sha256 of the moved block plus a full-reconstruction hash. That method
 * proves the CONTENT is unchanged — and is blind by construction to the one defect class a move
 * creates: a relative link whose correctness depends on the file's DEPTH in the tree.
 *
 * Three links broke and no gate saw it. The worst was
 * `skills/session-end/references/phase-3-documentation-updates.md` → `./phase-3-6-tail.md`, which is
 * the dispatcher for the six session-end tail phases (memory proposals, expired-learnings sweep,
 * auto-dream, skill judge, auto-dialectic, reconciliation). From inside `references/` that path
 * resolves one directory too deep; the target sits a level up. A coordinator following the prose
 * would have found nothing there and silently skipped the tail.
 *
 * The existing neighbours cannot cover this: `check-skill-script-paths.mjs` scans only
 * `scripts/**.mjs|.sh` and `hooks/**.sh` TARGETS, and `claude-md-drift-check` counts dead script
 * citations, not intra-surface markdown links. Different predicate, different blind spot.
 *
 * WHAT IT CHECKS
 *   For every `.md` under the scanned surfaces, every inline link `[text](target)` whose target is
 *   relative (not http(s):, not mailto:, not `#anchor`, not an absolute path) must exist on disk,
 *   resolved against the LINKING FILE's own directory. A `#fragment` suffix is stripped before the
 *   existence check — anchors are out of scope (no heading index here); the path half is not.
 *
 * DELIBERATE NON-CHECKS
 *   - Link text, anchors, and http(s) reachability (a network check in a validator is a flake).
 *   - Reference-style links and bare `<...>` autolinks: not used by this repo's instruction files
 *     (measured: 0 occurrences). If one appears, this checker stays silent rather than guessing —
 *     recorded here so the gap is known rather than assumed absent.
 *   - Fenced code blocks AND inline-code spans are skipped: a path inside an example command or
 *     inside backticks is illustrative, not a link. The inline-code carve-out is not cosmetic —
 *     `skills/memory-cleanup/SKILL.md:163` documents the MEMORY.md index FORMAT as
 *     `` `- [Title](file.md) — hook` ``, and without it that literal template is the checker's
 *     only "finding", i.e. the guard's first act would be to demand a doc be made wrong.
 *
 * Exit 0 = every relative link resolves. Exit 1 = at least one does not; each is printed as
 * `file:line target` so it can be fixed without a search.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

/** Surfaces whose markdown is instruction, i.e. read and acted on. */
export const SCAN_DIRS = Object.freeze(['skills', 'commands', 'agents', '.claude/rules']);

/** Path segments that end the walk: vendored or machine-owned trees, never instruction. */
export const PRUNE_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', '.pnpm']);

const SKIP_TARGET = /^(https?:|mailto:|#|\/)/i;
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const INLINE_CODE_RE = /(`+)[^`]*?\1/g;

/**
 * Blank out inline-code spans, preserving column count so a reported line number still lines up.
 * A `[x](y)` inside backticks is quoted TEXT, not a link — see DELIBERATE NON-CHECKS above.
 */
function stripInlineCode(line) {
  return line.replace(INLINE_CODE_RE, (m) => ' '.repeat(m.length));
}

/** Does the path exist? A stat error (ENOENT, ELOOP, EACCES) is a non-resolving link, not a crash. */
function statOk(abs) {
  try { statSync(abs); return true; } catch { return false; }
}

/** Lines inside fenced code blocks — a path in an example is not a link. */
function fencedLineNumbers(text) {
  const fenced = new Set();
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; fenced.add(i + 1); return; }
    if (inFence) fenced.add(i + 1);
  });
  return fenced;
}

/**
 * Markdown files under the scanned surfaces, enumerated from the FILESYSTEM.
 *
 * Deliberately not `git ls-files`: that lists tracked files only, so a brand-new instruction file
 * — the exact moment a split or a new skill lands — is invisible to the sweep until it is staged,
 * and the check would report clean on the tree that carries the defect. This repo has the incident
 * on record (`.claude/rules/measurement-discipline.md` § "A `git grep` drift sweep cannot see
 * untracked files": a release sweep passed, then failed after the commit, from the same working
 * tree with no edit in between). The cost of the filesystem walk is that a gitignored `.md` under
 * these four directories would also be checked — there are none, and one would be a finding worth
 * seeing anyway.
 *
 * @returns {string[]} repo-relative paths, sorted for stable output
 */
export function listMarkdown(repoRoot) {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(repoRoot, dir);
    let entries;
    try { entries = readdirSync(abs, { recursive: true, withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      // parentPath is absolute; make the record repo-relative with POSIX separators.
      const rel = relative(repoRoot, join(e.parentPath ?? abs, e.name));
      const posix = sep === '/' ? rel : rel.split(sep).join('/');
      // Vendored trees are not an instruction surface: `skills/vault-sync/node_modules/` is real
      // and its bundled READMEs link into their own upstream repo layout, which is not ours to fix.
      if (posix.split('/').some((s) => PRUNE_DIRS.has(s))) continue;
      out.push(posix);
    }
  }
  return out.sort();
}

/**
 * @returns {{ok: boolean, checked: number, files: number, findings: Array<{file: string, line: number, target: string}>}}
 */
export function checkSkillLinks(repoRoot = process.cwd()) {
  const findings = [];
  let checked = 0;
  const files = listMarkdown(repoRoot);

  for (const rel of files) {
    const abs = join(repoRoot, rel);
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const fenced = fencedLineNumbers(text);
    const baseDir = dirname(abs);

    text.split('\n').forEach((line, idx) => {
      const lineNo = idx + 1;
      if (fenced.has(lineNo)) return;
      for (const m of stripInlineCode(line).matchAll(LINK_RE)) {
        const raw = m[1];
        if (!raw || SKIP_TARGET.test(raw)) continue;
        const target = raw.split('#')[0];
        if (!target) continue; // pure fragment
        checked += 1;
        const resolved = resolve(baseDir, target);
        // Never let a link escape the repo: an out-of-tree target is a finding, not a pass.
        const inside = !relative(repoRoot, resolved).startsWith('..');
        if (!inside || !statOk(resolved)) findings.push({ file: rel, line: lineNo, target: raw });
      }
    });
  }

  return { ok: findings.length === 0, checked, files: files.length, findings };
}

function main() {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const { ok, checked, files, findings } = checkSkillLinks(repoRoot);
  if (!ok) {
    for (const f of findings) {
      process.stderr.write(`  FAIL: ${f.file}:${f.line} → ${f.target} — relative link does not resolve from this file's directory\n`);
    }
    process.stderr.write(`Results: ${findings.length} unresolved relative link(s) in ${files} markdown file(s) under ${SCAN_DIRS.join(', ')}\n`);
    process.exit(1);
  }
  // Two-space indent: validate-plugin.mjs tallies on /^ {2}(PASS|FAIL):/m.
  process.stdout.write(`  PASS: ${checked} relative link(s) in ${files} markdown file(s) resolve\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
