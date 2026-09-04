import { matchBlockHeader } from './block-header.mjs';
import { findUnterminatedComment, preprocessBlockLines, preprocessBlockLinesNoDash } from './block-preprocess.mjs';
import { isSessionConfigHeading } from './section-extractor.mjs';

/**
 * config-protection.mjs — Parser for the top-level `config-protection:` YAML
 * block (ecc-analysis / issue #622).
 *
 * Drives the PreToolUse Edit|Write guard that intercepts edits to a small
 * allow-list of quality-gate config files (eslint / vitest / tsconfig /
 * prettier / commitlint / gitleaks) and WARNs — or, in `strict` mode, blocks —
 * when an edit LOOSENS a gate (threshold lowered, disable/ignore directive
 * added, rule removed, gitleaks allowlist widened, tsconfig strictness
 * relaxed). The edit-tool analogue of the test-the-mock gate-cheating
 * anti-pattern. First-time creation, tightening, and neutral edits are always
 * allowed. A `allow-config-weakening: true` Session Config line bypasses the
 * guard for the session (mirrors `allow-destructive-ops`).
 *
 * Returns `{ enabled, mode }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `hooks/config-protection.mjs`.
 */

/** Valid `mode` values. Unknown values fall back to the default. */
const VALID_MODES = new Set(['warn', 'strict']);
const DEFAULT_MODE = 'warn';

/**
 * Parse the top-level `config-protection:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary (mirrors the other
 * config parsers in this directory — tolerant, defaults-on-malformed).
 *
 * Defaults:
 *   enabled: true
 *   mode:    'warn'   (warn → stderr + event + exit 0; strict → block, exit 2)
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, mode: 'warn'|'strict' }}
 */
export function _parseConfigProtection(content) {
  const defaults = {
    enabled: true,
    mode: DEFAULT_MODE,
  };

  if (typeof content !== 'string' || content.length === 0) return defaults;

  const lines = preprocessBlockLines(content);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'config-protection')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let cpEnabled = true;
  let cpMode = DEFAULT_MODE;

  for (const rawLine of blockLines) {
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
        // Default is true → only flip to false on explicit "false".
        cpEnabled = v.toLowerCase() !== 'false';
        break;
      case 'mode': {
        const lower = v.toLowerCase();
        cpMode = VALID_MODES.has(lower) ? lower : DEFAULT_MODE;
        break;
      }
    }
  }

  return {
    enabled: cpEnabled,
    mode: cpMode,
  };
}

/**
 * Detect the per-session bypass `allow-config-weakening: true`. This is a
 * top-level Session Config line (NOT inside the `config-protection:` block),
 * mirroring `allow-destructive-ops`. Line-scoped within the `## Session Config`
 * section, exactly like `pre-bash-destructive-guard.mjs`'s bypass scan.
 *
 * @param {string} content — full file contents
 * @returns {boolean} true when the bypass is explicitly set to `true`
 */
export function _isConfigWeakeningAllowed(content) {
  if (typeof content !== 'string' || content.length === 0) return false;

  // HTML-comment stripping ONLY (`preprocessBlockLinesNoDash`), never the full
  // `preprocessBlockLines`: bold-subkey normalisation would make
  // `- **allow-config-weakening:** true` arm the bypass, and
  // `tests/lib/config/config-protection.test.mjs` pins the opposite — only the
  // plain form is the supported bypass. Fail-closed beats markdown tolerance there.
  // The comment strip is the OTHER direction and is mandatory (W4/F1): with a raw
  // `content.split(/\r?\n/)` a COMMENTED-OUT `<!--\nallow-config-weakening: true\n-->`
  // inside `## Session Config` ARMED the bypass — commenting a key out is the most
  // ordinary way to disable it and must never enable it (same class as #1162a).
  //
  // UNTERMINATED `<!--` — the fail-closed direction INVERTS for a bypass scan.
  // `stripHtmlCommentBlocks` returns the lines UNFILTERED when a comment is never
  // closed, which is right for a block PARSER (nothing may silently vanish) and
  // wrong here: it hands the commented-out bypass line straight back and re-arms
  // the guard's own off switch. For this scan "I cannot tell where the comments
  // end" must mean NOT ARMED — the bypass is opt-in, so refusing to grant it is
  // the safe reading in every ambiguous document.
  if (findUnterminatedComment(content.split(/\r?\n/)) !== null) return false;

  const lines = preprocessBlockLinesNoDash(content);
  let inConfig = false;
  for (const line of lines) {
    if (isSessionConfigHeading(line)) { inConfig = true; continue; }
    if (inConfig && /^## /.test(line)) break;
    if (inConfig) {
      const m = line.match(/^\s*(?:-\s+\*\*)?allow-config-weakening(?::\*\*)?\s*:\s*(\S+)/);
      if (m && m[1].toLowerCase() === 'true') return true;
    }
  }
  return false;
}
