// frontmatter-block.mjs — Extract the leading `---`-fenced YAML block from a Markdown file.
//
// SHARED: THE EXTRACTION. NOT SHARED: THE RULES.
//
// This module owns exactly one thing — finding the frontmatter block's byte range and
// handing back its text. It deliberately owns NOTHING about what a valid frontmatter
// contains. Do not grow it into a validator, and do not "unify" the callers' rules
// against it: the three frontmatter checkers in this directory disagree on purpose.
//
//   * check-agents.mjs   BANS  `description: >` — the agent loader cannot read a folded
//                              block scalar, so the form is a live defect for agents/*.md.
//   * check-skills.mjs   ALLOWS `description: >` — for SKILL.md the sign is REVERSED: the
//                              folded scalar is the only form that makes the `: `
//                              collision inside an unquoted description structurally
//                              impossible. Measured 2026-08-15: 23 of 46 SKILL.md files
//                              use it, and porting the agent ban here would red 35 of 46.
//   * check-commands.mjs has its own, narrower field contract again (`argument-hint`).
//
// Those divergences are the product requirement, not drift. What WAS drift is this
// function: it stood verbatim in check-skills.mjs and check-commands.mjs, so the next
// change to the block format (a BOM, a new delimiter tolerance) would have been made in
// one copy and one gate would have started accepting what the other rejects — with no
// test able to see it, because each gate tested its own copy.
//
// BEHAVIOUR IS PINNED, NOT ASPIRATIONAL. tests/lib/validate/frontmatter-block.test.mjs
// documents what the body does today, including the two sharp edges below. Both are
// intentional records of the status quo, NOT endorsements — changing either is a
// behaviour change under two gates at once and needs its own task, not a drive-by edit.
//
//   1. CRLF input is handled: the split is `/\r?\n/`, so a CRLF file's first line
//      compares equal to '---' and the returned yamlText is LF-normalised.
//   2. A line that is exactly `---` INSIDE the block (e.g. an unindented `---` inside a
//      multi-line string) terminates the block early. Only a column-0, whitespace-free
//      `---` does this; an indented `  ---` is ordinary content.

/**
 * Extract the YAML frontmatter block delimited by the leading `---` fence.
 *
 * The opening fence must be the very first line of the file. The closing fence is the
 * first subsequent line equal to `---`. Line endings may be LF or CRLF; the returned
 * text is always LF-joined.
 *
 * @param {string} content - full file text
 * @returns {{ ok: true, yamlText: string } | { ok: false, diagnostic: string }}
 *   On success, `yamlText` is the block's inner text with no fences (empty string for an
 *   empty block). On failure, `diagnostic` is a caller-printable reason and there is no
 *   `yamlText` — callers must not fall through to a parse.
 */
export function extractInitialFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { ok: false, diagnostic: 'missing YAML frontmatter opening delimiter' };
  }

  const closingDelimiter = lines.indexOf('---', 1);
  if (closingDelimiter === -1) {
    return { ok: false, diagnostic: 'missing YAML frontmatter closing delimiter' };
  }

  return { ok: true, yamlText: lines.slice(1, closingDelimiter).join('\n') };
}
