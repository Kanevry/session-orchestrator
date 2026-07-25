/**
 * vcs-create-matcher.mjs — shared `gh` / `glab` create-command matcher for
 * PreToolUse Bash hooks.
 *
 * Extracted from `hooks/pre-bash-templates-first.mjs` (#519) so the
 * issue-budget hook (`hooks/pre-bash-issue-budget.mjs`) reuses the SAME
 * regex + argument-boundary semantics instead of maintaining a second,
 * silently-diverging copy. Both hooks share the PreToolUse Bash matcher and
 * run sequentially, so a divergence here would mean one hook gates a command
 * the other waves through.
 *
 * ZERO IMPORTS by design — a clean leaf so any hook can adopt it without
 * pulling the scripts/lib layer in.
 *
 * LOAD-BEARING semantics (contract, mirrors the pre-#-extraction behaviour):
 *   MATCH:    `gh|glab` + `pr|mr|issue` + `create|new`, anchored at start with
 *             optional leading whitespace, word-boundary on the trailing edge
 *             (so `created` / `news` do NOT match).
 *   NO MATCH: edit operations (`gh pr edit`, `glab mr edit`) — deliberately
 *             out of scope per the #519 PRD § 2 Out-of-Scope.
 */

/**
 * Matches the canonical `gh` / `glab` issue/PR/MR creation invocations.
 * Anchored at start (^) with optional leading whitespace to catch indented
 * shell snippets. Word-boundary at the end avoids false positives on tokens
 * like `created` or `news`.
 */
export const CREATE_REGEX = /^\s*(gh|glab)\s+(pr|mr|issue)\s+(create|new)\b/;

/**
 * Parse a shell command into its VCS-create shape.
 *
 * @param {string} command
 * @returns {{ host: 'github'|'gitlab', kind: 'pr'|'mr'|'issue', verb: 'create'|'new' } | null}
 *   `null` when the command is not a `gh`/`glab` create/new invocation.
 */
export function matchVcsCreate(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const m = command.match(CREATE_REGEX);
  if (!m) return null;
  return {
    host: m[1] === 'gh' ? 'github' : 'gitlab',
    kind: /** @type {'pr'|'mr'|'issue'} */ (m[2]),
    verb: /** @type {'create'|'new'} */ (m[3]),
  };
}

/**
 * Determine which host the command targets. `gh` → "github", `glab` → "gitlab".
 * Thin wrapper kept for call-site readability in pre-bash-templates-first.mjs.
 *
 * @param {string} command
 * @returns {"github"|"gitlab"|null}
 */
export function resolveHost(command) {
  return matchVcsCreate(command)?.host ?? null;
}

/**
 * True when the command creates an ISSUE specifically (not a PR/MR).
 * The issue-budget cap counts issues only — PR/MR creation is not the
 * runaway-volume problem the cap exists to bound.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isIssueCreate(command) {
  return matchVcsCreate(command)?.kind === 'issue';
}

/**
 * True when the command starts with any of the bypass patterns. Bypass match
 * is a prefix check with a word/EOL boundary on the trailing edge — this
 * prevents trivial bypass via prefix-inclusion (e.g. a policy entry
 * "gh issue create --label bot" must not match "gh issue create --label botanical").
 *
 * @param {string} command
 * @param {string[]} bypassPatterns
 * @returns {boolean}
 */
export function matchesBypass(command, bypassPatterns) {
  if (typeof command !== 'string') return false;
  if (!Array.isArray(bypassPatterns) || bypassPatterns.length === 0) {
    return false;
  }
  const stripped = command.replace(/^\s+/, '');
  for (const pat of bypassPatterns) {
    if (typeof pat !== 'string' || pat.length === 0) continue;
    const patStripped = pat.replace(/^\s+/, '');
    if (!stripped.startsWith(patStripped)) continue;
    // Boundary check: next character must be whitespace, EOL, or absent.
    const nextChar = stripped.charAt(patStripped.length);
    if (nextChar === '' || /\s/.test(nextChar)) return true;
  }
  return false;
}

/**
 * Best-effort extraction of the `--title` value from a create command, for
 * human-readable overflow bookkeeping. Handles `--title "x"`, `--title 'x'`,
 * `--title=x` and the bare unquoted form. Returns `null` when no title flag
 * is present.
 *
 * Deliberately NOT a shell parser: the value is only ever used as a display
 * label in an overflow record, never re-executed.
 *
 * @param {string} command
 * @returns {string|null}
 */
export function extractTitle(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const m =
    command.match(/--title[=\s]+"((?:[^"\\]|\\.)*)"/) ??
    command.match(/--title[=\s]+'([^']*)'/) ??
    command.match(/--title[=\s]+(\S+)/);
  if (!m) return null;
  return m[1].replace(/\\(["\\])/g, '$1').trim() || null;
}
