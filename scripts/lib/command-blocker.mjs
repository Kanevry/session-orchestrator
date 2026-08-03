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

/** Unquoted characters that terminate a here-doc delimiter word. */
const WORD_END_CHARS = new Set([';', '|', '&', '<', '>', '(', ')', '\n']);

/**
 * Read ONE shell word starting at `i`, resolving quotes and backslash escapes to
 * the logical value bash would pass. Used only for a here-doc DELIMITER
 * (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`), which is syntax rather than an
 * argument and therefore never becomes a token of its own.
 *
 * @param {string} command
 * @param {number} i
 * @returns {{ value: string, end: number }}
 */
function readDelimiterWord(command, i) {
  let value = '';
  let state = 'normal';
  while (i < command.length) {
    const ch = command[i];
    if (state === 'single') {
      if (ch === "'") { state = 'normal'; i++; continue; }
      value += ch; i++; continue;
    }
    if (state === 'double') {
      if (ch === '"') { state = 'normal'; i++; continue; }
      if (ch === '\\' && i + 1 < command.length) { value += command[i + 1]; i += 2; continue; }
      value += ch; i++; continue;
    }
    if (/\s/.test(ch) || WORD_END_CHARS.has(ch)) break;
    if (ch === '\\' && i + 1 < command.length) { value += command[i + 1]; i += 2; continue; }
    if (ch === "'") { state = 'single'; i++; continue; }
    if (ch === '"') { state = 'double'; i++; continue; }
    value += ch; i++;
  }
  return { value, end: i };
}

/**
 * Read a here-doc BODY starting at `from` (the first character after the newline
 * that opened it) up to — and excluding — its terminator line.
 *
 * `terminated` is false when the delimiter line never arrived. That is NOT a
 * body — it is a malformed command (or, more often, a `<<` that was never a
 * here-doc operator at all), and the caller MUST NOT emit the swallowed text as
 * an inert quoted token. See the `terminated === false` branch in
 * {@link tokenizeCommand}.
 *
 * @param {string} command
 * @param {number} from
 * @param {string} delim
 * @param {boolean} stripTabs — `<<-` form: leading tabs are ignored on every line
 * @returns {{ body: string, end: number, terminated: boolean }} end = index just past the terminator line
 */
function readHeredocBody(command, from, delim, stripTabs) {
  const lines = [];
  let i = from;
  while (i < command.length) {
    let lineEnd = command.indexOf('\n', i);
    if (lineEnd === -1) lineEnd = command.length;
    const raw = command.slice(i, lineEnd);
    const line = stripTabs ? raw.replace(/^\t+/, '') : raw;
    i = lineEnd + 1;
    if (line === delim) {
      return { body: lines.join('\n'), end: Math.min(i, command.length), terminated: true };
    }
    lines.push(line);
  }
  // Terminator never arrived. The caller decides what to do; it is NOT a body.
  return { body: lines.join('\n'), end: command.length, terminated: false };
}

/**
 * Hand-rolled quote-aware command lexer.
 *
 * Splits a command string into tokens on UNQUOTED whitespace, tracking quote
 * state and backslash escapes. Each token records whether ANY of its characters
 * originated inside quotes (`quoted: true`). Quote characters and the escaping
 * backslash are consumed (not part of the token text), so the returned token text
 * is the logical argument value a shell would pass.
 *
 * This is deliberately NOT node:util.parseArgs — parseArgs operates on an already-
 * tokenized argv array and does not lex raw shell strings with quote semantics.
 * No new npm dependency is introduced (hook hot-path constraint).
 *
 * Notes / scope (sufficient for the guard, not a full POSIX shell parser):
 *   - Single quotes: literal, no escapes inside (POSIX).
 *   - Double quotes: backslash escapes the next char.
 *   - ANSI-C quotes `$'…'`: like single quotes but `\` escapes the next char, so
 *     `$'a\'b'` is ONE token `a'b` (#965). Whitespace-only bodies (`$'\t'`) never
 *     reach here — normalizeShellWhitespaceExpansions folded them to a space first.
 *   - Outside quotes: backslash escapes the next char (incl. whitespace → same token).
 *   - A token that mixes quoted + unquoted runs (e.g. foo"bar") is `quoted: true`
 *     because part of it came from a quoted run — conservative for the guard.
 *
 * ## Comments, here-docs and redirects (#965)
 *
 * Before #965 the lexer knew none of these, and one apostrophe in ordinary
 * English prose (`# don't`) left it stuck in "single" for the rest of the input:
 * everything downstream collapsed into a single `quoted: true` token whose verb
 * resolved to `#`, so NO rule matched. That was a measured, complete bypass of
 * 8 of the 9 `block`-severity rules — `# don't\nrm -rf src/` was ALLOWED.
 *
 *   - `#` that STARTS a word outside quotes begins a comment running to
 *     end-of-line. The comment text produces no tokens: a comment is not a
 *     command, so `ls -la # rm -rf src/` no longer matches (deliberate, tested).
 *   - `<<EOF` / `<<'EOF'` / `<<-EOF` bodies are DATA, not command text. The body
 *     becomes ONE token with `quoted: true`, which routes it into the existing
 *     quoted-payload guard (#641) rather than a second rule: inert for
 *     `cat <<EOF`, still matched for `bash <<EOF` because `bash` is in
 *     SHELL_EXEC_INTERPRETERS. The delimiter word itself is syntax and emits no
 *     token; the `<<` operator does.
 *
 *     TWO gates keep that inert-body path from swallowing real command text —
 *     both are load-bearing, and each catches inputs the other misses (#970):
 *
 *     1. **Operator position.** `<<` is only a here-doc when it is a REDIRECT.
 *        Inside arithmetic it is the left-shift operator, so `arithDepth`
 *        tracks `$((`/`((` … `))` and the branch is skipped while depth > 0.
 *        A delimiter word immediately followed by `)` is likewise rejected.
 *        Without this, `echo $((1<<2))` opened a phantom here-doc whose
 *        delimiter was the fragment `2`, and everything after the next newline
 *        became one inert `quoted: true` token under the verb `echo`.
 *     2. **Terminator required.** When the delimiter line never arrives, the
 *        swallowed text is NOT data — it is either a malformed command or, far
 *        more often, proof that gate 1 mis-read the `<<` (`let x=1<<2`, an
 *        indented `EOF` without `<<-`). The body is then NOT emitted as an
 *        inert token: lexing resumes at the body's first character so the text
 *        is read as the commands it is. That is the conservative direction —
 *        the unterminated-QUOTE path may fail open (a wedged lexer that blocks
 *        every Bash call is worse than a missed enforcement), but a body that
 *        swallowed real commands may not.
 *   - Redirect operators (`>`, `>>`, `>|`, `N>`, `<`, `<<<`) become standalone
 *     tokens so a consumer can tell a redirect target apart from an argument.
 *     NOTE for consumers: the redirect TARGET is still emitted as an ordinary
 *     token — dropping it here would have silently changed rm-allowlist verdicts
 *     from a module that cannot see the allowlist. `&>` deliberately lexes as the
 *     existing `&` operator followed by `>`, preserving today's segment split (and
 *     with it `rm -rf /tmp/x &> log` staying ALLOWED); the `;`/`|`/`&` branch runs
 *     first and is never shadowed.
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
  let state = 'normal';    // 'normal' | 'single' | 'double' | 'ansi'
  let arithDepth = 0;      // open `$((` / `((` levels — inside them `<<` is a shift
  const pendingHeredocs = [];

  const flush = () => {
    if (started) {
      tokens.push({ text, quoted: sawQuote });
      text = '';
      started = false;
      sawQuote = false;
    }
  };

  // A leading all-digit word is the fd of a redirect (`2> log`), not an argument.
  // Returns the digits to prefix onto the operator token; flushes otherwise.
  const takeFdPrefix = () => {
    if (started && !sawQuote && /^\d+$/.test(text)) {
      const digits = text;
      text = '';
      started = false;
      return digits;
    }
    flush();
    return '';
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (state === 'single') {
      if (ch === "'") { state = 'normal'; continue; }
      text += ch; started = true; sawQuote = true;
      continue;
    }

    if (state === 'double' || state === 'ansi') {
      if (ch === (state === 'double' ? '"' : "'")) { state = 'normal'; continue; }
      if (ch === '\\' && i + 1 < command.length) {
        const next = command[i + 1];
        // In double / ANSI-C quotes, backslash escapes the next char; keep it
        // simple and take that char literally (this is what makes `$'a\'b'`
        // one token instead of an unbalanced quote — #965).
        text += next; started = true; sawQuote = true; i++;
        continue;
      }
      text += ch; started = true; sawQuote = true;
      continue;
    }

    // state === 'normal'

    // A `#` in WORD position comments out the rest of the line. Leave the newline
    // itself for the heredoc/whitespace handling below.
    if (ch === '#' && !started) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }

    // A newline with here-docs pending: their bodies start here and are DATA —
    // but ONLY while each one actually finds its terminator (gate 2, #970). The
    // first unterminated body abandons here-doc mode: `j` still points at that
    // body's first character, so lexing resumes there and the text is read as
    // the commands it is instead of collapsing into one inert quoted token.
    if (ch === '\n' && pendingHeredocs.length > 0) {
      flush();
      let j = i + 1;
      while (pendingHeredocs.length > 0) {
        const { delim, stripTabs } = pendingHeredocs.shift();
        const { body, end, terminated } = readHeredocBody(command, j, delim, stripTabs);
        if (!terminated) { pendingHeredocs.length = 0; break; }
        if (body.length > 0) tokens.push({ text: body, quoted: true });
        j = end;
      }
      i = j - 1;
      continue;
    }

    if (ch === "'") { state = 'single'; started = true; continue; }
    if (ch === '"') { state = 'double'; started = true; continue; }
    if (ch === '$' && command[i + 1] === "'") { state = 'ansi'; started = true; i++; continue; }

    // Arithmetic context (gate 1, #970). `$((`/`((` open a level, `))` closes
    // one. The characters are still appended verbatim — the ONLY effect is that
    // the here-doc branch below stands down while depth > 0, because there `<<`
    // is the left-shift operator, not a redirect.
    if (ch === '$' && command[i + 1] === '(' && command[i + 2] === '(') {
      arithDepth++; text += '$(('; started = true; i += 2;
      continue;
    }
    if (ch === '(' && command[i + 1] === '(' && !started) {
      arithDepth++; text += '(('; started = true; i++;
      continue;
    }
    if (arithDepth > 0 && ch === ')' && command[i + 1] === ')') {
      arithDepth--; text += '))'; started = true; i++;
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) {
      text += command[i + 1]; started = true; i++;
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }

    // Unquoted shell control operators become standalone tokens so chain-splitting
    // and per-segment verb detection work even without surrounding whitespace
    // (e.g. `/tmp/x;rm -rf src/`). Recognised: ; && || | & — longest match first.
    // MUST stay ahead of the redirect branch: `&>` keeps splitting on `&` exactly
    // as it does today (#965 Risk C — otherwise `rm -rf /tmp/x &> log` would flip
    // from allow to deny).
    if (ch === ';' || ch === '|' || ch === '&') {
      flush();
      let op = ch;
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) { op = ch + ch; i++; }
      tokens.push({ text: op, quoted: false });
      continue;
    }

    // Here-doc `<<WORD` / `<<-WORD` — the body is skipped at the next newline.
    // `<<<` is a here-STRING (an ordinary argument follows), not a here-doc.
    // `arithDepth === 0` is gate 1 (#970): inside `$(( … ))` this `<<` is a
    // left shift. A delimiter word butted against `)` (`$((1<<2))` reads `2`,
    // stopping at the paren) is rejected for the same reason — belt-and-braces
    // for an arithmetic form the depth counter did not see. Both fall THROUGH
    // to the redirect branch below, which emits `<<` as a plain operator token.
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && arithDepth === 0) {
      let j = i + 2;
      let stripTabs = false;
      if (command[j] === '-') { stripTabs = true; j++; }
      while (command[j] === ' ' || command[j] === '\t') j++;
      const { value, end } = readDelimiterWord(command, j);
      if (value && command[end] !== ')') {
        const fd = takeFdPrefix();
        tokens.push({ text: `${fd}<<${stripTabs ? '-' : ''}`, quoted: false });
        pendingHeredocs.push({ delim: value, stripTabs });
        i = Math.max(end, j) - 1;
        continue;
      }
    }

    // Redirect operators as standalone tokens: > >> >| N> < << <<<
    if (ch === '>' || ch === '<') {
      const fd = takeFdPrefix();
      let op = fd + ch;
      let j = i + 1;
      if (command[j] === ch) { op += ch; j++; if (ch === '<' && command[j] === '<') { op += ch; j++; } }
      else if (ch === '>' && command[j] === '|') { op += '|'; j++; }
      tokens.push({ text: op, quoted: false });
      i = j - 1;
      continue;
    }

    text += ch; started = true;
  }

  // Unterminated quote → flush whatever accumulated (mark quoted so the guard treats
  // the dangling text conservatively). Deliberately fail-OPEN in the lexer: a wedged
  // guard that blocks every Bash call is strictly worse than a missed enforcement.
  if (state !== 'normal') sawQuote = true;
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
 * Transparent command prefixes: wrappers that execute another command, so the
 * verb that matters sits behind them. Deliberately the SAME set this repo
 * already enumerates in `hooks/pre-bash-sessions-ledger-guard.mjs`
 * (`VERB_PREFIXES`) — a diverging second copy is the defect class this list is
 * being aligned to fix — plus `timeout`, which additionally carries a duration
 * operand.
 *
 * Why it matters here (#970): the here-doc design's safety argument is that a
 * body fed to an interpreter still matches, because `bash` is in
 * SHELL_EXEC_INTERPRETERS. That only holds when `bash` is the RESOLVED verb, so
 * `sudo bash <<EOF … EOF` used to allow what `env bash <<EOF … EOF` denied.
 */
const VERB_PREFIXES = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'nice', 'timeout']);

/** `timeout 5` / `timeout 1.5m` / `nice 10` — one bare operand, then the verb. */
const DURATION_OPERAND = /^\d+(?:\.\d+)?[smhd]?$/;

/**
 * Resolve the effective argv[0] (the command verb) for a chain segment, skipping
 * leading `VAR=value` env assignments and unwrapping transparent wrapper
 * prefixes (`sudo`, `env …`, `nohup`, `timeout N`, …).
 * Returns the bare program name (basename, no path) or null.
 *
 * Skipping a prefix can only move verb resolution TOWARDS the real command, and
 * a skipped token is either a wrapper name, an option or a duration — never an
 * interpreter — so this cannot turn a match into a miss.
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
  // Unwrap wrapper prefixes that delegate to a real verb.
  while (i < segment.length) {
    const verb = segment[i].text.replace(/^.*\//, ''); // basename
    if (!VERB_PREFIXES.has(verb)) break;
    i++;
    // The wrapper's own options belong to the wrapper, never to the command.
    while (i < segment.length && !segment[i].quoted && segment[i].text.startsWith('-')) i++;
    if (verb === 'env') {
      // env may carry its own VAR=val assignments before the real command
      while (i < segment.length && !segment[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i].text)) {
        i++;
      }
    }
    if ((verb === 'timeout' || verb === 'nice')
      && i < segment.length && !segment[i].quoted && DURATION_OPERAND.test(segment[i].text)) {
      i++;
    }
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
