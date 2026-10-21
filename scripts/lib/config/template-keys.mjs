/**
 * template-keys.mjs — the KNOWN top-level Session Config keys, read from
 * `docs/session-config-template.md`.
 *
 * Two consumers read the same population and must not drift apart:
 *   - `skills/claude-md-drift-check/checker.mjs` Check 6 (session-config-parity)
 *     diffs a repo's local block against the template's blocks;
 *   - `scripts/parse-config.mjs` reports a local top-level key the template
 *     never documents — a typo'd key is otherwise absent from the KV map and
 *     every consumer silently applies its default (#1562).
 *
 * The template carries TWO literal `## Session Config` lines, both inside fenced
 * ```yaml examples: the FIRST is the starter / minimal baseline (the mandatory
 * keys), the LAST is the opt-in baseline (the full key catalog). Check 6
 * classifies mandatory vs opt-in by exactly that order.
 */

import { isSessionConfigHeading, collectTopLevelKeyLines } from './section-extractor.mjs';

/**
 * Extract the YAML block under a `## Session Config` heading from a Markdown
 * document. Tries fenced YAML first (```yaml ... ```) *within the matched
 * heading's own body slice*, then falls back to the raw body up to the next
 * `^## ` heading or EOF.
 *
 * `docs/session-config-template.md` carries TWO literal `## Session Config`
 * lines — both live INSIDE fenced ```yaml example blocks: the starter / "Full
 * minimal baseline" (7 mandatory keys) and the "Full opt-in baseline" (the
 * complete key catalog, a strict superset of the minimal block). By default
 * this function matches the FIRST occurrence (correct for a local CLAUDE.md /
 * AGENTS.md instruction file, which has exactly one real heading). Pass
 * `{ occurrence: 'last' }` to match the LAST occurrence instead — the template
 * call site uses this to reach the opt-in baseline's full key set rather than
 * silently stopping at the 7-key minimal block (issue #785).
 *
 * Returns { body: string, headingLine: number } or null when no heading found.
 *
 * @param {string} content
 * @param {{ occurrence?: 'first'|'last' }} [options]
 * @returns {{ body: string, headingLine: number } | null}
 */
export function extractSessionConfigBlock(content, { occurrence = 'first' } = {}) {
  const lines = content.split('\n');
  const headingIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    // SSOT predicate (#968). The previous local `/^##\s+Session Config\b/`
    // was the loosest JS comparator in the repo: no end anchor and `\s+`
    // instead of a single space, so it accepted `##  Session Config` (two
    // spaces) and `## Session Config Convention` — both of which the runtime
    // parser rejects. The drift-check's whole job is to report on the block
    // the runtime reads, so matching a heading the runtime cannot see made it
    // audit a section that does not exist.
    if (isSessionConfigHeading(lines[i])) headingIdxs.push(i);
  }
  if (headingIdxs.length === 0) return null;

  const targetIdx = occurrence === 'last' ? headingIdxs[headingIdxs.length - 1] : headingIdxs[0];
  const headingLine = targetIdx + 1; // 1-based line number for error reporting

  // Raw body: from the line after the heading up to the next `## ` heading or EOF.
  let endIdx = lines.length;
  for (let i = targetIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { endIdx = i; break; }
  }
  const rawBody = lines.slice(targetIdx + 1, endIdx).join('\n');

  // Prefer a fenced YAML block found anywhere within the raw body slice
  // (tolerates a blank line between the heading and the fence); fall back to
  // the raw body itself when no fence is present.
  const fenced = rawBody.match(/```ya?ml\r?\n([\s\S]*?)\r?\n```/);
  const body = fenced ? fenced[1] : rawBody;

  return { body, headingLine };
}

/**
 * Extract top-level YAML keys from a YAML body. Only column-0 keys are
 * collected (indented keys are children and ignored).
 *
 * Accepts four equivalent forms consumer CLAUDE.md files write a Session
 * Config key in: bare `key:`, Markdown bullet `- key:`, bold `**key:**`
 * (closing bold before the colon), and the bold-bullet consumer shape
 * `- **key:** value` (bold wraps the key AND colon together, closing bold
 * AFTER the colon). Baseline issue #60: the original bare-only regex
 * extracted zero keys from bullet-form local files, so session-config-parity
 * (drift-check Check 6) either false-positived on every mandatory key (local
 * side reads as empty) or, when the TEMPLATE side also used bullet form,
 * passed vacuously (both sides empty, so the diff was always empty). Sibling
 * precedent: `scripts/lib/config/block-header.mjs` recognizes only header
 * lines, not individual key-value pairs — this function is the per-key
 * counterpart.
 *
 * @param {string} body
 * @returns {string[]} keys in document order (duplicates kept)
 */
export function extractTopLevelKeys(body) {
  const keys = [];
  const re = /^(?:-\s+)?(?:\*\*)?([A-Za-z][\w-]*)(?:\*\*)?:/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

/**
 * The known-key union of a Session Config template: every top-level key of its
 * FIRST `## Session Config` block (starter / mandatory) and its LAST one
 * (opt-in catalog).
 *
 * Returns null — "not measurable", never "no keys" — when the template does not
 * carry two DISTINCT blocks. A single block is not a key catalog (the same
 * guard drift-check Check 6 applies before it warns on local keys): diffing a
 * repo against the seven starter keys alone would report every legitimately
 * adopted opt-in key as unknown.
 *
 * @param {string} content - full template document
 * @returns {Set<string> | null}
 */
export function knownTemplateKeys(content) {
  if (typeof content !== 'string') return null;
  const first = extractSessionConfigBlock(content, { occurrence: 'first' });
  const last = extractSessionConfigBlock(content, { occurrence: 'last' });
  if (!first || !last || first.headingLine === last.headingLine) return null;
  return new Set([...extractTopLevelKeys(first.body), ...extractTopLevelKeys(last.body)]);
}

/**
 * The template's starter (mandatory) keys a local instruction file does NOT
 * carry in its `## Session Config` block — the input of `/bootstrap
 * --retroactive` step 6 (#1567).
 *
 * Why not the validator: `parseSessionConfig()` fills every mandatory field
 * with its default, so `validate-config` never sees an ABSENT key; in a pnpm
 * repo without `test-command` the run silently uses `npm test`. Presence is a
 * property of the FILE, so it is read from the file: local keys come from
 * `collectTopLevelKeyLines()` (the lines the runtime reads, all spellings),
 * the mandatory population from the template's FIRST block — the same
 * population drift-check Check 6 calls mandatory.
 *
 * @param {string} localContent - the repo's CLAUDE.md / AGENTS.md
 * @param {string} templateContent - `docs/session-config-template.md`
 * @returns {string[] | null} missing keys in template order; null when the
 *   template has no `## Session Config` block ("not measurable", never "none
 *   missing")
 */
export function missingStarterKeys(localContent, templateContent) {
  if (typeof templateContent !== 'string') return null;
  const starter = extractSessionConfigBlock(templateContent, { occurrence: 'first' });
  if (!starter) return null;
  const present = new Set(collectTopLevelKeyLines(localContent).map(({ key }) => key));
  return [...new Set(extractTopLevelKeys(starter.body))].filter((key) => !present.has(key));
}
