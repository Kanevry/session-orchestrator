/**
 * command-blocker.mjs — command-blocking tokenizer + matcher.
 *
 * Split out of scripts/lib/hardening.mjs (concern C). This is the
 * destructive-command guard powering pre-bash-destructive-guard /
 * enforce-commands — security-sensitive; behaviour is preserved EXACTLY.
 * Re-exported by hardening.mjs as a barrel so existing importers keep working
 * unchanged.
 *
 * Layering: hook-safe — pure functions only; no I/O at import time;
 * ESM-pure for fast hook hot-paths. Hooks (under `hooks/`) import from
 * this lib; this lib MUST NOT reverse-import from `hooks/`. Cross-cutting
 * invariant for all exports below — see #554 A2.
 */

/**
 * Shell interpreters whose QUOTED argument text is still executed as a command.
 * When a command segment's argv[0] (or `command <verb>` / `env … <verb>`) is one
 * of these, a blocked pattern found inside a quoted token is NOT inert — it is the
 * payload the interpreter will run. Includes SQL executors (`psql -c "DROP TABLE …"`)
 * and `find` (`find . -exec rm -rf {} \;`).
 *
 * Used by the quoted-payload guard in commandMatchesBlocked (#641).
 */
const SHELL_EXEC_INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh',
  'eval', 'xargs', 'env', 'command',
  'psql', 'mysql', 'sqlite3',
  'find',
]);

function matchIfsWhitespaceExpansion(command, index) {
  if (command.startsWith('${IFS', index)) {
    const end = command.indexOf('}', index + 2);
    if (end !== -1) {
      const body = command.slice(index + 2, end);
      if (body === 'IFS' || /^IFS:-\s*$/.test(body)) return end + 1;
    }
  }

  if (command.startsWith('$IFS', index)) {
    const next = command[index + 4] ?? '';
    if (!/[A-Za-z0-9_]/.test(next)) return index + 4;
  }

  return -1;
}

function isWhitespaceCode(code) {
  return Number.isFinite(code) && /\s/.test(String.fromCharCode(code));
}

function matchAnsiCWhitespaceQuote(command, index) {
  if (!command.startsWith("$'", index)) return -1;

  let i = index + 2;
  let sawWhitespace = false;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") return sawWhitespace ? i + 1 : -1;

    if (ch === '\\') {
      if (i + 1 >= command.length) return -1;
      const next = command[i + 1];

      if (next === 't' || next === 'n' || next === 'r' || next === 'v' || next === 'f') {
        sawWhitespace = true;
        i += 2;
        continue;
      }

      if (next === 'x') {
        const hex = command.slice(i + 2).match(/^[0-9A-Fa-f]{1,2}/)?.[0];
        if (!hex) return -1;
        if (!isWhitespaceCode(Number.parseInt(hex, 16))) return -1;
        sawWhitespace = true;
        i += 2 + hex.length;
        continue;
      }

      if (/^[0-7]$/.test(next)) {
        const octal = command.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
        if (!octal) return -1;
        if (!isWhitespaceCode(Number.parseInt(octal, 8))) return -1;
        sawWhitespace = true;
        i += 1 + octal.length;
        continue;
      }

      if (/\s/.test(next)) {
        sawWhitespace = true;
        i += 2;
        continue;
      }

      return -1;
    }

    if (/\s/.test(ch)) {
      sawWhitespace = true;
      i++;
      continue;
    }

    return -1;
  }

  return -1;
}

function matchShellWhitespaceExpansion(command, index) {
  const ifsEnd = matchIfsWhitespaceExpansion(command, index);
  if (ifsEnd !== -1) return ifsEnd;
  return matchAnsiCWhitespaceQuote(command, index);
}

/**
 * Normalize common shell whitespace obfuscations into literal spaces before
 * guard parsing. This is intentionally narrow: it recognizes IFS expansions and
 * ANSI-C quotes that decode entirely to whitespace, not arbitrary shell syntax.
 *
 * By default single-quoted text is preserved because the outer shell treats it
 * literally. Callers that inspect shell-interpreter payload strings can opt in
 * to `expandSingleQuoted` because those strings are parsed by a later shell.
 *
 * @param {string} command
 * @param {{ expandSingleQuoted?: boolean, expandDoubleQuoted?: boolean }} [options]
 * @returns {string}
 */
function normalizeShellWhitespaceExpansions(command, options = {}) {
  const expandSingleQuoted = options.expandSingleQuoted === true;
  const expandDoubleQuoted = options.expandDoubleQuoted !== false;

  let out = '';
  let state = 'normal';

  for (let i = 0; i < command.length;) {
    const ch = command[i];

    if (state === 'single') {
      if (ch === "'") { state = 'normal'; out += ch; i++; continue; }
      if (expandSingleQuoted) {
        const end = matchShellWhitespaceExpansion(command, i);
        if (end !== -1) { out += ' '; i = end; continue; }
      }
      out += ch;
      i++;
      continue;
    }

    if (state === 'double') {
      if (ch === '"') { state = 'normal'; out += ch; i++; continue; }
      if (expandDoubleQuoted) {
        const end = matchShellWhitespaceExpansion(command, i);
        if (end !== -1) { out += ' '; i = end; continue; }
      }
      if (ch === '\\' && i + 1 < command.length) {
        out += ch + command[i + 1];
        i += 2;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    const end = matchShellWhitespaceExpansion(command, i);
    if (end !== -1) { out += ' '; i = end; continue; }
    if (ch === '\\' && i + 1 < command.length) {
      out += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'") { state = 'single'; out += ch; i++; continue; }
    if (ch === '"') { state = 'double'; out += ch; i++; continue; }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Hand-rolled quote-aware command lexer.
 *
 * Splits a command string into tokens on UNQUOTED whitespace, tracking single- and
 * double-quote state and backslash escapes. Each token records whether ANY of its
 * characters originated inside quotes (`quoted: true`). Quote characters and the
 * escaping backslash are consumed (not part of the token text), so the returned
 * token text is the logical argument value a shell would pass.
 *
 * This is deliberately NOT node:util.parseArgs — parseArgs operates on an already-
 * tokenized argv array and does not lex raw shell strings with quote semantics.
 * No new npm dependency is introduced (hook hot-path constraint).
 *
 * Notes / scope (sufficient for the guard, not a full POSIX shell parser):
 *   - Single quotes: literal, no escapes inside (POSIX).
 *   - Double quotes: backslash escapes the next char.
 *   - Outside quotes: backslash escapes the next char (incl. whitespace → same token).
 *   - A token that mixes quoted + unquoted runs (e.g. foo"bar") is `quoted: true`
 *     because part of it came from a quoted run — conservative for the guard.
 *
 * @param {string} command
 * @returns {Array<{ text: string, quoted: boolean }>}
 */
export function tokenizeCommand(command) {
  const tokens = [];
  if (typeof command !== 'string' || command.length === 0) return tokens;
  command = normalizeShellWhitespaceExpansions(command);

  let text = '';
  let started = false;     // a token is in progress
  let sawQuote = false;    // any char of the current token came from inside quotes
  let state = 'normal';    // 'normal' | 'single' | 'double'

  const flush = () => {
    if (started) {
      tokens.push({ text, quoted: sawQuote });
      text = '';
      started = false;
      sawQuote = false;
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (state === 'single') {
      if (ch === "'") { state = 'normal'; continue; }
      text += ch; started = true; sawQuote = true;
      continue;
    }

    if (state === 'double') {
      if (ch === '"') { state = 'normal'; continue; }
      if (ch === '\\' && i + 1 < command.length) {
        const next = command[i + 1];
        // In double quotes, backslash only escapes a small set; keep it simple:
        // consume the backslash and take the next char literally.
        text += next; started = true; sawQuote = true; i++;
        continue;
      }
      text += ch; started = true; sawQuote = true;
      continue;
    }

    // state === 'normal'
    if (ch === "'") { state = 'single'; started = true; continue; }
    if (ch === '"') { state = 'double'; started = true; continue; }
    if (ch === '\\' && i + 1 < command.length) {
      text += command[i + 1]; started = true; i++;
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }

    // Unquoted shell control operators become standalone tokens so chain-splitting
    // and per-segment verb detection work even without surrounding whitespace
    // (e.g. `/tmp/x;rm -rf src/`). Recognised: ; && || | & — longest match first.
    if (ch === ';' || ch === '|' || ch === '&') {
      flush();
      let op = ch;
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) { op = ch + ch; i++; }
      tokens.push({ text: op, quoted: false });
      continue;
    }

    text += ch; started = true;
  }

  // Unterminated quote → flush whatever accumulated (mark quoted so the guard treats
  // the dangling text conservatively).
  if (state === 'single' || state === 'double') sawQuote = true;
  flush();

  return tokens;
}

/**
 * Split a tokenized command into chained segments on shell control operators
 * (`;`, `&&`, `||`, `|`, `&`). Only UNQUOTED single-token operators split; an
 * operator that arrived inside quotes stays part of its segment.
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @returns {Array<Array<{ text: string, quoted: boolean }>>}
 */
function splitSegments(tokens) {
  const segments = [];
  let current = [];
  const operators = new Set([';', '&&', '||', '|', '&']);
  for (const tok of tokens) {
    if (!tok.quoted && operators.has(tok.text)) {
      segments.push(current);
      current = [];
      continue;
    }
    current.push(tok);
  }
  segments.push(current);
  return segments.filter((s) => s.length > 0);
}

/**
 * Resolve the effective argv[0] (the command verb) for a chain segment, skipping
 * leading `VAR=value` env assignments and unwrapping `env …`/`command …` prefixes.
 * Returns the bare program name (basename, no path) or null.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @returns {string|null}
 */
function segmentVerb(segment) {
  let i = 0;
  // Skip leading FOO=bar env assignments (unquoted).
  while (i < segment.length && !segment[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i].text)) {
    i++;
  }
  // Unwrap `env [VAR=val …]` and `command` prefixes that delegate to a real verb.
  while (i < segment.length) {
    const raw = segment[i].text;
    const verb = raw.replace(/^.*\//, ''); // basename
    if (verb === 'env') {
      i++;
      // env may carry its own VAR=val assignments before the real command
      while (i < segment.length && !segment[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i].text)) {
        i++;
      }
      continue;
    }
    if (verb === 'command') { i++; continue; }
    break;
  }
  if (i >= segment.length) return null;
  return segment[i].text.replace(/^.*\//, '');
}

/**
 * Build the case-sensitive boundary regex for a blocked pattern. Boundary chars:
 * whitespace + shell operators + quotes. Matches at start/end too.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function boundaryRegex(pattern) {
  const escaped = pattern.replace(/[.*+?|[\](){}\\^$]/g, '\\$&');
  const boundary = '[\\s;|&(){}`\'"]';
  return new RegExp(`(^|${boundary})${escaped}(${boundary}|$)`);
}

/**
 * Test whether a blocked pattern occurs in the raw concatenation of a segment's
 * QUOTED token payloads (with the boundary rule applied per token). Used to decide
 * whether an interpreter segment carries the pattern inside its quoted argument.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {RegExp} re
 * @returns {boolean}
 */
function quotedTokensMatch(segment, re) {
  for (const tok of segment) {
    if (tok.quoted && re.test(normalizeShellWhitespaceExpansions(tok.text, { expandSingleQuoted: true }))) {
      return true;
    }
  }
  return false;
}

/**
 * Test whether a blocked pattern occurs OUTSIDE quoted tokens within a segment.
 * Reconstructs the unquoted skeleton (quoted tokens replaced by a single space
 * placeholder so they cannot bridge an adjacent-token match) and applies the
 * boundary regex.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {RegExp} re
 * @returns {boolean}
 */
function unquotedSegmentMatch(segment, re) {
  const skeleton = segment.map((t) => (t.quoted ? ' ' : t.text)).join(' ');
  return re.test(skeleton);
}

/**
 * Test whether a command string contains a blocked pattern with shell-aware
 * boundaries AND a quoted-payload guard (#641).
 *
 * Verb detection stays boundary-tolerant: a pattern that appears UNQUOTED — including
 * across shell operators (`ls;rm -rf /`, `ls&&rm -rf /`, `(rm -rf /)`, piped into
 * `xargs rm -rf`, prefixed by `FOO=1 …`) — still matches.
 *
 * Quoted-payload guard: a pattern whose ONLY occurrences are wholly inside quoted
 * tokens is treated as inert literal text (no match) UNLESS the enclosing chain
 * segment's verb (argv[0], after skipping env-assignments and unwrapping
 * `env`/`command`) is a shell-exec interpreter (`bash -c "rm -rf /"`,
 * `eval "…"`, `psql -c "DROP TABLE …"`, `find … -exec …`). The guard is applied
 * PER chain segment: a quoted pattern in segment N is judged against segment N's verb.
 *
 * Boundary characters: whitespace, shell operators (`;`, `|`, `&`, `(`, `)`,
 * `{`, `}`, backtick), or string quotes (`'`, `"`). Case-sensitive.
 *
 * @param {string} command — full command string
 * @param {string} pattern — blocked pattern to search for
 * @returns {boolean}
 */
export function commandMatchesBlocked(command, pattern) {
  if (!pattern) return false;
  if (typeof command !== 'string' || command.length === 0) return false;

  const re = boundaryRegex(pattern);
  const normalizedCommand = normalizeShellWhitespaceExpansions(command);
  const payloadNormalizedCommand = normalizeShellWhitespaceExpansions(command, {
    expandSingleQuoted: true,
  });

  // Fast path: if the boundary regex does not match the raw string at all, no
  // tokenization can produce a match. Shell whitespace expansions can create
  // matches, so test the normalized forms rather than the original command.
  if (!re.test(normalizedCommand) && !re.test(payloadNormalizedCommand)) return false;

  const segments = splitSegments(tokenizeCommand(normalizedCommand));

  for (const segment of segments) {
    // 1) Unquoted occurrence anywhere in the segment → always a match.
    if (unquotedSegmentMatch(segment, re)) return true;

    // 2) Quoted occurrence → only a match when the segment verb is an interpreter
    //    that executes its quoted payload.
    if (quotedTokensMatch(segment, re)) {
      const verb = segmentVerb(segment);
      if (verb && SHELL_EXEC_INTERPRETERS.has(verb)) return true;
      // else: inert literal inside quotes for a non-interpreter verb → no match
      // for THIS segment; keep scanning other segments.
    }
  }

  return false;
}

/**
 * Build an actionable suggestion string for a blocked command pattern.
 *
 * @param {string} pattern — the blocked command pattern
 * @returns {string}
 */
export function suggestForCommandBlock(pattern) {
  switch (pattern) {
    case 'rm -rf':
      return 'Destructive deletion is blocked. Move specific files instead or use trash-cli.';
    case 'git push --force':
    case 'git push -f':
      return "Force-push is blocked. Use 'git push --force-with-lease' after coordinator approval.";
    case 'git reset --hard':
      return "Hard reset is blocked. Use 'git reset --soft' or 'git stash' to preserve work.";
    case 'git checkout -- .':
      return 'Whole-tree discard is blocked. Target specific files instead.';
    default:
      return `Blocked command pattern '${pattern}' is not permitted during wave execution.`;
  }
}
