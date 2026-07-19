import { matchBlockHeader } from './block-header.mjs';

/**
 * eval.mjs — Parser for the top-level `eval:` YAML block (#809, Epic #803).
 *
 * Drives the /eval skill (Session-Prozess-Eval, Standard v1 evaluation harness —
 * PRD docs/prd/2026-07-16-aiat-llm-eval.md §S6). The /eval skill itself lands in
 * a later wave; this parser only surfaces the opt-in config the skill will read.
 *
 * Returns { enabled, mode, judge, report, handle }.
 * Fail-fast ONLY on unknown mode/judge/report enum values (mirrors
 * dialectic.mjs's `model` handling). `enabled` silently defaults to/collapses
 * to false on any non-"true" value (docs-orchestrator.mjs precedent — no
 * throw, no warn). `handle` trims and collapses an empty string to null.
 *
 * PARSER GOTCHA (learning conf 0.9 — mirrors custom-phases.mjs / dialectic.mjs):
 * the `eval:` key-line itself MUST NOT carry an inline comment. The block-open
 * matcher is the shared `matchBlockHeader(line, 'eval')` (block-header.mjs) — it
 * tolerates the bold-bullet `- **eval:**` rendering (#830) but a trailing
 * `# comment` on the header line STILL fails the match, so the block is never
 * entered and ALL defaults apply
 * silently (no error, no warning surfaced anywhere). Sub-key lines tolerate
 * inline comments fine (stripped via `replace(/\s*#.*$/, '')` below, same as
 * every other block parser in this directory).
 *
 * Consumer: skills/eval/SKILL.md (follow-up wave), scripts/lib/config.mjs.
 */

const ALLOWED_MODE = new Set(['warn', 'off']);
// opus intentionally omitted: deliberate cost ceiling for an advisory judge (judge.mjs::ALLOWED_MODELS still permits opus for direct module use).
const ALLOWED_JUDGE = new Set(['off', 'haiku', 'sonnet']);
const ALLOWED_REPORT = new Set(['html', 'none']);

/**
 * Parse the top-level `eval:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled: false
 *   mode:    'warn'   (warn | off)
 *   judge:   'off'    (off | haiku | sonnet)
 *   report:  'html'   (html | none)
 *   handle:  null     (optional string; absent/empty → null)
 *
 * Throws if `mode`, `judge`, or `report` is present but not one of its
 * documented enum values.
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, mode: string, judge: string, report: string, handle: string|null }}
 */
export function _parseEval(content) {
  const defaults = { enabled: false, mode: 'warn', judge: 'off', report: 'html', handle: null };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'eval')) inBlock = true;
      continue;
    }
    // Stop at next column-0 non-empty line (sibling top-level key or heading)
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let enabled = false;
  let mode = 'warn';
  let judge = 'off';
  let report = 'html';
  let handle = null;

  for (const rawLine of blockLines) {
    // Strip inline comments and trailing whitespace (sub-key lines only —
    // the key-line's own comment restriction is enforced by the regex above).
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        enabled = v.toLowerCase() === 'true';
        break;

      case 'mode': {
        const lower = v.toLowerCase();
        if (!ALLOWED_MODE.has(lower)) {
          throw new Error(`eval.mode must be warn|off, got '${v}'`);
        }
        mode = lower;
        break;
      }

      case 'judge': {
        const lower = v.toLowerCase();
        if (!ALLOWED_JUDGE.has(lower)) {
          throw new Error(`eval.judge must be off|haiku|sonnet, got '${v}'`);
        }
        judge = lower;
        break;
      }

      case 'report': {
        const lower = v.toLowerCase();
        if (!ALLOWED_REPORT.has(lower)) {
          throw new Error(`eval.report must be html|none, got '${v}'`);
        }
        report = lower;
        break;
      }

      case 'handle':
        handle = v.trim() === '' ? null : v.trim();
        break;
    }
  }

  return { enabled, mode, judge, report, handle };
}
