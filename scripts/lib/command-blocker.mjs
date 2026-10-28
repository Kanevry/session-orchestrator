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

// Deliberately import-lean (hook hot path): node:path is the ONLY import —
// pure string manipulation, no I/O. Do not add further imports here.
import path from 'node:path';

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
  // `su -c 'payload'` executes its quoted payload as a shell command (#982).
  // Deliberately an interpreter, NOT a WRAPPER_UNWRAP entry: unwrapping `su`
  // would resolve past it and could only loosen the quoted-payload guard.
  'su',
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
        // Line continuation inside SINGLE quotes (#992). The OUTER shell keeps
        // `\<LF>` literal here — but under `expandSingleQuoted` the caller is
        // looking at a string a LATER shell parses, and that inner shell joins
        // the lines. Measured: `bash -c 'set -- rm -rf\<LF>/; …'` → argv
        // `[rm][-rf/]`, i.e. the continuation is gone by the time the inner
        // shell splits words. Gated on the flag for exactly that reason: the
        // default (outer-shell) reading must keep the pair, or a literal
        // `printf 'a\<LF>b'` would be misread.
        if (ch === '\\' && command[i + 1] === '\n') { i += 2; continue; }
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
        // Line continuation inside DOUBLE quotes (#992). bash removes the pair
        // here exactly as it does unquoted — measured `set -- "rm -rf\<LF>/"`
        // → argv `[rm -rf/]`, the two characters leave no trace. Keeping them
        // was the #981 scope cut ("no verdict there depends on it"); one did:
        // commandMatchesBlocked's fast path tests this string, so
        // `bash -c "git push \<LF>--force origin main"` never reached the lexer
        // and the force-push was ALLOWED while the unquoted spelling denied.
        if (command[i + 1] === '\n') { i += 2; continue; }
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
      // Line continuation (#981): bash JOINS the two lines, so the pair must
      // disappear here too — not only in the lexer. commandMatchesBlocked's
      // fast path tests this normalized string and bails out before any
      // tokenization; its invariant ("if the regex cannot match the raw string,
      // no tokenization can produce a match") is FALSE while a continuation is
      // still present, because eliding it JOINS text that the regex then spans.
      // Measured: `git push \<LF>--force origin main` never reached the lexer —
      // the fast path returned false and the force-push was ALLOWED.
      // All three states elide now (#992). The #981 claim that "no verdict
      // depends on" the quoted branches was false: the fast path above tests
      // this very string, so a continuation surviving inside quotes bailed the
      // whole match out. See the `single` / `double` branches for their gating
      // (single only under `expandSingleQuoted` — there the INNER shell joins).
      if (command[i + 1] === '\n') { i += 2; continue; }
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

/** Single-character ANSI-C escapes (bash `$'…'`). */
const ANSI_C_SIMPLE = new Map([
  ['a', '\x07'], ['b', '\b'], ['e', '\x1b'], ['E', '\x1b'], ['f', '\f'], ['n', '\n'],
  ['r', '\r'], ['t', '\t'], ['v', '\v'], ['\\', '\\'], ["'", "'"], ['"', '"'], ['?', '?'],
]);

/**
 * Decode ONE backslash escape inside a bash ANSI-C quote `$'…'` (#1832),
 * `command[i] === '\\'`. Grammar measured with bash 5 (2026-10-27,
 * `printf '[%s]'` probes): `\a \b \e \E \f \n \r \t \v \\ \' \" \?`; octal
 * `\nnn` (1–3 digits); `\xHH` (1–2 hex); `\uHHHH` (1–4 hex) and
 * `\UHHHHHHHH` (1–8 hex); `\cX` = `X & 0x1f` (`\c?` = 0x7f). An escape bash
 * does not know — `\q`, `\8`, `\x`/`\u` without a digit, a trailing `\c` —
 * keeps its backslash (`$'\q'` → `\q`). A decoded NUL ends the word's text in
 * bash (C strings: `$'a\0b'` → `a`); it is returned as `nul` and the caller
 * drops the rest of the quote.
 * Ceiling (BV-004): text of the SAME word after the closing quote
 * (`$'re\0'set`) is kept although bash drops it — over-match only, it can
 * add a pattern word, never hide one. Revisit trigger: a false DENY report.
 *
 * @param {string} command
 * @param {number} i - index of the backslash
 * @returns {{ text: string, end: number, nul?: true }} `end` is the index after the escape
 */
function decodeAnsiCEscape(command, i) {
  const next = command[i + 1];
  const simple = ANSI_C_SIMPLE.get(next);
  if (simple !== undefined) return { text: simple, end: i + 2 };
  const codeAt = (re, from, radix) => {
    const digits = command.slice(from).match(re)?.[0];
    return digits ? { code: Number.parseInt(digits, radix), end: from + digits.length } : null;
  };
  let hit = null;
  if (/[0-7]/.test(next)) hit = codeAt(/^[0-7]{1,3}/, i + 1, 8);
  else if (next === 'x') hit = codeAt(/^[0-9A-Fa-f]{1,2}/, i + 2, 16);
  else if (next === 'u') hit = codeAt(/^[0-9A-Fa-f]{1,4}/, i + 2, 16);
  else if (next === 'U') hit = codeAt(/^[0-9A-Fa-f]{1,8}/, i + 2, 16);
  else if (next === 'c' && i + 2 < command.length && command[i + 2] !== "'") {
    const x = command[i + 2];
    hit = { code: x === '?' ? 0x7f : x.toUpperCase().charCodeAt(0) & 0x1f, end: i + 3 };
  }
  if (hit === null) return { text: `\\${next}`, end: i + 2 };
  // Octal is ONE byte (value & 0xFF): `\400` is NUL, `\501` is `A` (bash 5.3,
  // measured 2026-10-27 — `$'reset\400'` is `reset`). `\x` has at most two
  // digits, so it cannot exceed a byte.
  const code = /[0-7]/.test(next) ? hit.code & 0xff : hit.code;
  if (code === 0) return { text: '', end: hit.end, nul: true };
  // `\U` at or above 0x80000000 encodes to NOTHING in bash (`$'r\UFFFFFFFF s'`
  // → `rs`); every other value at or above 0x80 encodes to non-ASCII bytes,
  // which no pattern word contains — U+FFFD stands in for the ones JS cannot
  // represent (surrogates, above U+10FFFF).
  if (code >= 0x80000000) return { text: '', end: hit.end };
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return { text: '\ufffd', end: hit.end };
  return { text: String.fromCodePoint(code), end: hit.end };
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
 *   - Outside quotes: backslash escapes the next char (incl. whitespace → same token),
 *     EXCEPT before a newline: that is a line continuation and both characters
 *     are removed, exactly as bash joins the lines (#981 — see the branch).
 *   - An unquoted newline that is neither continued nor part of a here-doc body
 *     is a command SEPARATOR and emits `{ text: ';', quoted: false,
 *     operator: 'newline' }` (#981). See the branch for why the text is `;`.
 *   - A token that mixes quoted + unquoted runs (e.g. foo"bar") is `quoted: true`
 *     because part of it came from a quoted run — conservative for the guard.
 *   - Redirect operators (#983) are emitted as standalone tokens carrying a
 *     `redirect` field: `{ fd: number|null, mode: 'truncate'|'append'|'read'|
 *     'dup'|'heredoc'|'herestring' }`. Recognised (longest-match-first, BEFORE
 *     the chain-operator branch so `&>` wins over `&`): `&>>`, `&>`, `>|`,
 *     `>>`, `>`, `<<<`, `<<`, `<`, and the fd-prefixed forms `N>`, `N>>`,
 *     `N>&M`; fd close/move `>&-`, `N>&-`, `N>&M-` and input dup/close
 *     `<&N`, `<&-`, `N<&M`, `N<&-` lex as ONE `dup` token with no operand
 *     word (#1830); `>&`/`<&`/`>>&` with a quoted, blank-separated or file
 *     operand are resolved by resolveFdOperandRedirects (#1832); a glued
 *     `{name}` before an operator is a named fd (`redirect.fdName`, #1832) (fd digits are consumed from the in-progress token, so
 *     `2>/dev/null` lexes as fd-2 redirect + `/dev/null` operand instead of
 *     one glued token). The `redirect` field appears ONLY on redirect tokens —
 *     ordinary tokens keep the exact `{ text, quoted }` shape.
 *   - zsh clobber forms (#1795) lex as ONE redirect token in canonical text:
 *     `>!`/`N>!` → `>|`/`N>|` (truncate), `>>|`/`>>!`/`N>>|` → `>>`/`N>>`
 *     (append), `>&|`/`>&!`/`&>|`/`&>!` → `&>` and `>>&|`/`>>&!`/`&>>|`/`&>>!`
 *     → `&>>` — the exact token `&>`/`&>>` already produce, so every consumer
 *     that handles those handles these unchanged. A fd prefix before an
 *     `&`-form is dropped (the form writes both streams anyway). `!` is read as
 *     the suffix in EITHER shell: in bash `>!f` writes a file `!f`, in zsh `f`;
 *     a guard that reports `f` still sees the write in the same directory,
 *     while not reading the suffix lost the target outright (fail-closed for
 *     write detection). Fd duplication `>&2`, `2>&1`, `>&-` and the filename
 *     form `>& WORD` are unchanged.
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
 *     from a module that cannot see the allowlist. `&>` / `&>>` lex as ONE redirect
 *     token (#983, see the redirect branch — it runs BEFORE the `;`/`|`/`&` branch),
 *     so `rm -rf /tmp/x &> CLAUDE.md` stays one segment and its target is seen.
 *
 * ## Subshells and command substitutions (#1667)
 *
 * Before #1667 `(`, `$(`, `)` and backticks were word characters, so
 * `true && (rm -rf X)` resolved the verb `(rm` and every verb- or target-based
 * check (path-delete denylist, rm allowlist, issue budget, staging fence)
 * missed X. The ledger guard had fixed this in its own scanner (#1665); the
 * shared lexer now carries it for every consumer:
 *   - An unquoted `(` at WORD START opens a subshell: it and its `)` become
 *     `{ text: ';', operator: 'subshell' }` separators, the body stays in place.
 *   - `$( … )`, backticks (unquoted AND inside double quotes) and process
 *     substitution `<( … )` / `>( … )` are WORDS whose body runs as a command:
 *     the outer word keeps the RAW source text (`$(pwd)/x` stays one operand,
 *     so no outer word boundary moves) and the body's tokens are HOISTED to the
 *     end of the stream behind a `{ text: ';', operator: 'substitution' }`.
 *   - Unchanged on purpose: `$((`/`((` arithmetic, a mid-word `(` (`f()`,
 *     `arr=(…)`, whose `)` stays word text), an unmatched `)`, the parens of a
 *     case HEAD (`(a)` patterns), quoted/escaped parens, `{`/`}` (brace groups
 *     were already split by COMMAND_POSITION_KEYWORDS), here-doc bodies.
 *   - A case pattern's closing `)` is followed by a `{ text: ';', operator:
 *     'case-pattern' }` separator, so an arm's first command (`a) rm x;;`)
 *     heads its own segment; in an arm body `(` opens a subshell again.
 *   - Fail direction: an unclosed substitution is closed at end of input and
 *     STILL hoisted (verb visible). Past MAX_TOKENIZER_NESTING an unquoted
 *     opener degrades to a plain separator (verb visible); a double-quoted one
 *     stays literal text there.
 *
 * ## Per-part quote provenance (`parts`, #1795)
 *
 * Every WORD token (the ones built from source characters) carries
 * `parts: Array<{ text, quote }>` — its text split into maximal runs of one
 * quote context, with `parts.map((p) => p.text).join('') === text`. `quote`:
 *   - `none`    unquoted: expands `$`, `~` (leading), globs, backticks
 *   - `double`  inside `"…"`: expands `$` and backticks, not `~` or globs
 *   - `single`  inside `'…'`: literal
 *   - `ansi-c`  inside `$'…'`: literal (escapes already decoded)
 *   - `escape`  one backslash-escaped character (outside quotes, or inside
 *               `"…"` / `$'…'`): literal — kept apart so `\$PWD` and `"\$x"`
 *               do not read as expanding.
 * So `"$PWD"/x` → `[{ '$PWD', double }, { '/x', none }]`, `'$PWD/x'` →
 * `[{ '$PWD/x', single }]`, `~/x` → `[{ '~/x', none }]`, `"~"/x` →
 * `[{ '~', double }, { '/x', none }]`. The raw text of a `$( … )` / backtick
 * substitution spliced into its outer word is one part with the outer context
 * (`none`, or `double` inside `"…"`). An empty quote pair adds no part.
 * ABSENT on non-word tokens: operators/separators, redirect tokens, here-doc
 * bodies. Purely additive: `parts` is a NON-ENUMERABLE own property, so
 * `JSON.stringify`, deep equality and `Object.keys` see exactly the pre-#1795
 * token (the documented `{ text, quoted }` shape of an ordinary word). Read it
 * from the token object itself — a spread copy (`{ ...tok }`) or
 * `structuredClone` drops it.
 *
 * @param {string} command
 * @returns {Array<{ text: string, quoted: boolean, redirect?: { fd: number|null, mode: string }, braceLead?: number, operator?: string, parts?: Array<{ text: string, quote: 'none'|'double'|'single'|'ansi-c'|'escape' }> }>}
 */
/** Unquoted chain-operator texts — a word after one of them is in command position. */
const CHAIN_OPERATOR_TEXTS = new Set([';', '&&', '||', '|', '&']);

/**
 * Reserved words that are followed by a COMMAND (#1671): a word after one of
 * them — itself in command position — is in command position too. The opener
 * half of COMMAND_POSITION_KEYWORDS (closers like `fi`/`done` end a command, so
 * `fi case` is no case) plus `time`, which bash parses as a pipeline prefix.
 * `(` is absent on purpose: since #1667 the lexer emits it as a separator.
 */
const COMMAND_POSITION_OPENERS = new Set([
  '{', '!', 'if', 'elif', 'then', 'else', 'while', 'until', 'do', 'time', 'coproc',
]);

/**
 * A zsh noclobber-override suffix after a write redirect (#1795): `>|`, `>!`,
 * `>>|`, `>>!`, `>&|`, `>&!`, `&>|`, `&>!` (and the `>>&` / `&>>` append
 * forms). In bash only `>|` exists and `>!` would write a file named `!…`;
 * reading `!` as the suffix keeps the write visible in either shell.
 *
 * @param {string|undefined} c
 * @returns {boolean}
 */
const isClobberSuffix = (c) => c === '|' || c === '!';

/**
 * Does `c` end the word of an fd-close / fd-move redirect (`>&-`, `<&-`,
 * `2>&1-`)? (#1830) Only then is the `-` part of the operator. A glued rest
 * (`>&-x`, `3>&1-x`) keeps the HEAD lexing — see the ceiling at the `>&-`
 * close branch for why (bash, sh and zsh disagree on that form).
 */
const endsFdWord = (c) => c === undefined || /[\s;|&()<>]/.test(c);

/**
 * A named-fd prefix `{name}` (bash ≥4.1, zsh), unquoted and glued to the operator (#1832).
 * Ceiling (BV-004): /bin/bash 3.2 has no named fds — there `{fd}` stays an argv
 * word and the redirect is a plain one; this lexer always reads the bash 4.1+
 * form. Revisit trigger: a guard decision that depends on the 3.2 reading.
 */
const FD_NAME_RE = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * Placeholder for `[N|{name}]>&`, `>>&` and `<&` whose operand is not glued
 * digits / a bounded `-` (#1832). `fdOperand` is non-enumerable and the
 * placeholder never leaves tokenizeCommand: resolveFdOperandRedirects replaces
 * it. Its `redirect` is the write/read redirect it becomes for a file operand.
 */
function fdOperandPlaceholder(text, redirect, direction) {
  const tok = { text, quoted: false, redirect };
  Object.defineProperty(tok, 'fdOperand', { value: direction, enumerable: false });
  return tok;
}

/** Unquoted chain-operator texts (the lexer emits them without an `operator` field). */
const CHAIN_OP_TEXTS = new Set([';', '|', '||', '&', '&&']);

/**
 * Resolve every fdOperandPlaceholder against the word that follows it (#1832).
 * `>&` / `<&` are ONE operator with their own operand word, glued or after
 * blanks, quoted or not; the DEQUOTED operand decides (bash expands the word
 * first: `2>&"1"` duplicates, measured 2026-10-27):
 *   - digits, `-` (close) or `N-` (move) → one `dup` token `<op>&<operand>`
 *     owning no word — the token scope-gate's foldFdDupFilenameRedirects built;
 *   - anything else after `>&` / `>>&` → the plain write redirect (`>`, `N>`,
 *     `>>`; truncate/append) FOLLOWED BY the operand as its operand word, the
 *     exact pair the fold produced, so redirectSpanEnd owns the word and
 *     extractBashWriteTargets reports it;
 *   - anything else after `<&` → a read redirect owning the operand (bash:
 *     "ambiguous redirect").
 * No operand word (end of input, an operator next): the plain redirect alone —
 * downstream reports it unresolved. The chain `&` never appears for these forms.
 *
 * Two readings of `-WORD` (C of #1832, measured 2026-10-27): for an operand
 * whose FIRST character is an unquoted `-` followed by more text — glued
 * (`3>&-reset`) or after blanks (`3>& -reset`) — bash 5.3, /bin/bash 3.2 and sh
 * close the fd and pass WORD as the next argv word (`printf '[%s]' a 3>&-reset
 * b` → `[a][reset][b]`), while zsh writes a FILE `-WORD`. The token stream keeps
 * the zsh reading byte-identical to HEAD (redirect + operand `-WORD`, the write
 * target scope-gate's allowlist must see); the bash reading rides on the
 * redirect token as the NON-ENUMERABLE `bashArgvWord` (`{ text, quoted }`),
 * which unquotedSegmentMatch and collectDeleteTargets re-insert into argv where
 * they drop the redirect span. A quoted dash (`3>&"-"reset`) is no close in
 * bash ("ambiguous redirect") and gets no marker. `N>&M-WORD` stays as the
 * digit branch lexes it (bash: "ambiguous redirect", command not run).
 * resolveSegmentVerb reads `bashArgvWord` as the verb when it leads the
 * segment (`3>&-rm P` → verb `rm`), and dashCPayloads reads it as an argv
 * word, so verb-keyed rules see the bash reading too (#1832, wave 6).
 * extractRedirectTargets now reports the concrete target of these forms
 * (`-a.ts`, `out.ts`) where the pre-#1832 split left an `unresolved` entry —
 * stricter and correct (coordinator decision 2026-10-27).
 *
 * @param {Array<object>} tokens
 * @returns {Array<object>} the same array, placeholders resolved in place
 */
function resolveFdOperandRedirects(tokens) {
  let found = false;
  for (const t of tokens) if (t.fdOperand !== undefined) { found = true; break; }
  if (!found) return tokens;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.fdOperand === undefined) { out.push(tok); continue; }
    const next = tokens[i + 1];
    const isWord = next !== undefined && !next.redirect && next.operator === undefined &&
      !(next.quoted === false && CHAIN_OP_TEXTS.has(next.text));
    const opText = tok.text.slice(0, -1); // `N>`, `>>`, `N<` — without the `&`
    if (isWord && /^(?:\d+-?|-)$/.test(next.text)) {
      out.push({ text: `${tok.text}${next.text}`, quoted: false, redirect: { ...tok.redirect, mode: 'dup' } });
      i += 1;
      continue;
    }
    const plain = { text: opText, quoted: false, redirect: tok.redirect };
    if (isWord) {
      const first = next.parts?.[0];
      const dashUnquoted = next.parts ? first?.quote === 'none' && first.text.startsWith('-') : !next.quoted && next.text.startsWith('-');
      if (dashUnquoted && next.text.length > 1) {
        const rest = next.parts ? [{ ...first, text: first.text.slice(1) }, ...next.parts.slice(1)] : [];
        Object.defineProperty(plain, 'bashArgvWord', {
          value: { text: next.text.slice(1), quoted: rest.some((p) => p.text !== '' && p.quote !== 'none') },
          enumerable: false,
        });
      }
    }
    out.push(plain);
  }
  tokens.length = 0;
  for (const t of out) tokens.push(t); // no spread — see closeSubstitution
  return tokens;
}

/** A function-definition head `name()` — its body is a compound command. */
const FUNCTION_HEAD_RE = /^[^\s()$`'"]+\(\)$/;

/**
 * Is the word at index `end` of `sink` (default: the NEXT word pushed) in
 * command position (#1671)? Walks back over
 * a run of unquoted opener keywords (`if ! case …`, `then { case …`) to the
 * statement start: an operator/separator or the start of the sink. An opener
 * that is itself an argument (`echo then case`) does not count. Also openers:
 * `coproc`, a function head `name()` / `function name`, and `time -p`.
 * A case pattern is followed by a `case-pattern` separator token (see
 * {@link tokenizeCommand}), so the first word of a case ARM is in command
 * position through the operator branch.
 *
 * Linear time (#1731 point 1): the answer for a prefix of length `end` depends
 * only on `sink[end-1]`, `sink[end-2]` and the answer for a SHORTER prefix (the
 * old backwards walk "continues" exactly onto prefix `end-1` or `end-2`). `memo`
 * holds `memo[k]` = the answer for prefix length `k`; a sink is append-only, so
 * every stored entry stays valid and each prefix is evaluated once per sink.
 * Before the memo, every `f()` of a `f() { f() { …` flood walked back over all
 * earlier openers: 10k heads took 11.4 s in the real hook (timeout 5 s, and a
 * timed-out hook does not block).
 *
 * @param {Array<{ text: string, quoted: boolean, operator?: string }>} sink
 * @param {boolean[]} [memo=[]] — per-sink memo, owned by the caller
 * @returns {boolean}
 */
function nextWordInCommandPosition(sink, memo = []) {
  for (let end = memo.length; end <= sink.length; end++) {
    memo.push(commandPositionStep(sink, end, memo));
  }
  return memo[sink.length];
}

/**
 * One step of {@link nextWordInCommandPosition}: the answer for prefix length
 * `end`, given `memo[k]` for every `k < end`.
 *
 * @param {Array<{ text: string, quoted: boolean, operator?: string }>} sink
 * @param {number} end
 * @param {boolean[]} memo
 * @returns {boolean}
 */
function commandPositionStep(sink, end, memo) {
  if (end === 0) return true;
  const tok = sink[end - 1];
  if (tok.quoted) return false;
  if (tok.operator !== undefined || CHAIN_OPERATOR_TEXTS.has(tok.text)) return true;
  const prev = sink[end - 2];
  const prevIs = (word) => prev !== undefined && !prev.quoted && prev.text === word;
  // `time -p cmd`: the POSIX-format flag is part of the `time` prefix.
  if (tok.text === '-p' && prevIs('time')) return memo[end - 1];
  // `function name { … }` / `function name() …`: skip the keyword+name pair.
  if (prevIs('function')) return memo[end - 2];
  if (FUNCTION_HEAD_RE.test(tok.text)) return memo[end - 1];
  if (!COMMAND_POSITION_OPENERS.has(tok.text)) return false;
  return memo[end - 1];
}

/**
 * How many `$( … )` / backtick / `( … )` levels {@link tokenizeCommand} tracks
 * (#1667, mirroring the ledger guard's MAX_SCAN_NESTING). The lexer is a loop
 * with an explicit frame stack, so this is a work bound, not a stack-safety
 * bound. Past it an unquoted opener is read as a plain separator: the verb
 * behind it stays visible (fail-closed for verb checks), only the word-boundary
 * fidelity of that pathological level is given up.
 */
const MAX_TOKENIZER_NESTING = 256;

export function tokenizeCommand(command) {
  const tokens = [];
  if (typeof command !== 'string' || command.length === 0) return tokens;
  command = normalizeShellWhitespaceExpansions(command);

  let text = '';
  // Per-part quote provenance of `text` (see the @returns note): consecutive
  // characters with the same quote context share one part, so
  // `parts.map((p) => p.text).join('') === text` for every word token.
  let parts = [];
  const addText = (s, quote) => {
    text += s;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.quote === quote) last.text += s;
    else parts.push({ text: s, quote });
  };
  // #1731 point 1: one command-position memo per sink (see nextWordInCommandPosition).
  const positionMemos = new WeakMap();
  const inCommandPosition = () => {
    let memo = positionMemos.get(sink);
    if (memo === undefined) { memo = []; positionMemos.set(sink, memo); }
    return nextWordInCommandPosition(sink, memo);
  };
  let started = false;     // a token is in progress
  let sawQuote = false;    // any char of the current token came from inside quotes
  // Leading UNQUOTED `{` characters of the current token (#1707 point 2). For a
  // token that is otherwise quoted (`{"unlink"`) the `quoted` flag cannot say
  // whether its first `{` was bare, so the count rides on the token.
  let braceLead = 0;
  // Index of the last BARE `(` appended to a word (`f(`, `arr=(`). An escaped
  // `\(` or a quoted one never sets it, so `$(echo \()` still closes there.
  let bareParenAt = -1;
  let state = 'normal';    // 'normal' | 'single' | 'double' | 'ansi'
  let ansiNul = false;     // inside `$'…'` after a decoded NUL (see decodeAnsiCEscape)
  let arithDepth = 0;      // open `$((` / `((` levels — inside them `<<` is a shift
  // One entry per open `case … esac` level, innermost last. Each names what the
  // NEXT word at that level is: 'subject' (`case WORD`), 'in' (the `in`),
  // 'pattern' (a clause pattern, or `esac`) or 'body' (commands of an arm).
  // In the three head states `(`/`)` are pattern syntax; an unquoted `)` in
  // 'pattern' ENDS the pattern and emits a `case-pattern` separator, so the
  // arm's first word (`a) rm -f x`, `a)rm -f x`) heads its own segment.
  let caseStates = [];
  const caseTop = () => (caseStates.length > 0 ? caseStates[caseStates.length - 1] : null);
  const setCaseTop = (s) => { caseStates[caseStates.length - 1] = s; };
  const pendingHeredocs = [];

  // #1667 nesting: `sink` receives the tokens of the CURRENT command context.
  // A `$( … )` / backtick / process-substitution body gets its own sink and is
  // HOISTED (appended after the outer stream, behind a separator) on close; a
  // `( … )` subshell stays in place between two separators. `stack` holds one
  // frame per open level — see the tokenizeCommand docblock.
  let sink = tokens;
  const hoisted = [];
  const stack = [];

  const flush = () => {
    if (started) {
      // #1671: BOTH words count only where bash reads them as reserved words.
      // An argument `esac` (`echo esac`) used to close a case early, and a
      // `case` behind `then`/`do`/`else`/`{`/`!` was never opened — either way
      // the next pattern `)` closed the enclosing `$( … )` and moved the rest
      // of the body (an `rm` operand) into the outer statement.
      const top = caseTop();
      if (top === 'subject') setCaseTop('in');
      else if (top === 'in') { if (!sawQuote && text === 'in') setCaseTop('pattern'); }
      else if (top === 'pattern') {
        // `case w in esac` / `;; esac` — `esac` where a pattern may start.
        if (!sawQuote && text === 'esac') caseStates.pop();
      } else if (!sawQuote && text === 'case' && inCommandPosition()) {
        caseStates.push('subject');
      } else if (top === 'body' && !sawQuote && text === 'esac' && inCommandPosition()) {
        // `a) esac` (last clause without `;;`) is covered too: the pattern's
        // `case-pattern` separator puts `esac` in command position.
        caseStates.pop();
      }
      const tok = { text, quoted: sawQuote };
      // Only a QUOTED token carries the count: for an unquoted one every `{` of
      // its text is bare, so the text already says it (and the token shape of
      // every unquoted word stays as it was).
      if (sawQuote && braceLead > 0) tok.braceLead = braceLead;
      // Non-enumerable on purpose: JSON, deep equality and `Object.keys` see the
      // exact pre-#1795 token shape; only a reader asking for `tok.parts` gets it.
      Object.defineProperty(tok, 'parts', { value: parts, enumerable: false });
      sink.push(tok);
      text = '';
      parts = [];
      started = false;
      sawQuote = false;
      braceLead = 0;
    }
  };

  // Open a substitution level whose BODY is lexed into a fresh sink. The outer
  // word in progress (`x=` in `x=$(…)`, or the double-quoted run around
  // `"$(…)"`) is parked in the frame and resumed on close.
  const openSubstitution = (kind, start) => {
    stack.push({ kind, start, text, parts, started, sawQuote, braceLead, state, sink, arithDepth, caseStates });
    text = ''; parts = []; started = false; sawQuote = false; braceLead = 0; state = 'normal'; arithDepth = 0; caseStates = [];
    sink = [];
  };

  // Close the innermost substitution level. `end` is the index just past its
  // closing character (or the input length when it never closed). The body is
  // hoisted; the outer word gets the RAW source text of the whole substitution
  // appended, so the outer token stream is byte-identical to the pre-#1667
  // lexer's word boundaries (`rm -rf $(pwd)/x` keeps ONE operand).
  const closeSubstitution = (end) => {
    if (state !== 'normal') sawQuote = true;
    flush();
    const frame = stack.pop();
    // Loops, never `push(...arr)`: a spread passes every element as a call
    // argument, and a body of ~125k tokens throws RangeError — which the
    // destructive guard's top-level catch turns into ALLOW (fail-open).
    hoisted.push({ text: ';', quoted: false, operator: 'substitution' });
    for (const t of sink) hoisted.push(t);
    ({ text, parts, started, sawQuote, braceLead, state, sink, arithDepth, caseStates } = frame);
    const raw = command.slice(frame.start, end);
    addText(raw, state === 'double' ? 'double' : 'none'); started = true;
    if (/["']/.test(raw)) sawQuote = true;
  };

  const topKind = () => (stack.length > 0 ? stack[stack.length - 1].kind : null);
  const pushSubshellSeparator = () => {
    flush();
    sink.push({ text: ';', quoted: false, operator: 'subshell' });
  };

  // A leading all-digit word is the fd of a redirect (`2> log`), not an argument.
  // A word `{name}` glued to the operator is a NAMED fd (bash ≥4.1, zsh —
  // `{fd}>/dev/null`): the shell allocates the fd and stores it in `name`, the
  // word never reaches argv (#1832 — `git {fd}>/dev/null reset --hard` ran the
  // hard reset while `{fd}` was judged as an argv word). Returns `digits` to
  // prefix onto the operator token, the numeric `fd` and the `name` (or null);
  // flushes otherwise. A named fd keeps NO text prefix on the operator, so every
  // text-keyed consumer (scope-gate's WRITE_REDIRECT_OP_RE) reads `>` as before.
  const takeFdPrefix = () => {
    if (started && !sawQuote && (/^\d+$/.test(text) || FD_NAME_RE.test(text))) {
      const named = text.startsWith('{');
      const digits = named ? '' : text;
      const name = named ? text.slice(1, -1) : null;
      text = '';
      parts = [];
      started = false;
      braceLead = 0;
      return { digits, fd: named ? null : Number.parseInt(digits, 10), name };
    }
    flush();
    return { digits: '', fd: null, name: null };
  };
  // The `redirect` field of an operator token: `fdName` only when the fd is named.
  const redirectField = (prefix, mode) => (prefix.name === null ? { fd: prefix.fd, mode } : { fd: null, mode, fdName: prefix.name });

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (state === 'single') {
      if (ch === "'") { state = 'normal'; continue; }
      addText(ch, 'single'); started = true; sawQuote = true;
      continue;
    }

    if (state === 'double' || state === 'ansi') {
      if (ch === (state === 'double' ? '"' : "'")) { state = 'normal'; ansiNul = false; continue; }
      if (state === 'ansi' && ch === '\\' && i + 1 < command.length) {
        // bash decodes `$'…'` escapes BEFORE the program sees the word (#1832):
        // `git $'\x72eset' --hard` runs `git reset --hard`. The token stays
        // quoted, so decoded whitespace still keeps it out of the skeleton.
        // After a decoded NUL bash drops the text but STILL reads escapes to
        // find the closing quote: `$'reset\0\'junk'` is `reset` (Codex review).
        const esc = decodeAnsiCEscape(command, i);
        if (esc.nul) ansiNul = true;
        else if (!ansiNul) addText(esc.text, 'ansi-c');
        started = true; sawQuote = true; i = esc.end - 1;
        continue;
      }
      if (state === 'ansi' && ansiNul) continue; // bash ends the word's text at a decoded NUL
      if (ch === '\\' && i + 1 < command.length) {
        const next = command[i + 1];
        // In double / ANSI-C quotes, backslash escapes the next char; keep it
        // simple and take that char literally (this is what makes `$'a\'b'`
        // one token instead of an unbalanced quote — #965).
        addText(next, 'escape'); started = true; sawQuote = true; i++;
        continue;
      }
      // Double quotes do NOT stop command substitution (#1667): `"$(rm x)"` runs
      // `rm`. The quoted run is parked and the body is lexed as a command.
      // `$((` stays literal arithmetic text, exactly as before.
      if (state === 'double' && stack.length < MAX_TOKENIZER_NESTING) {
        if (ch === '`') {
          if (topKind() === 'backtick') { closeSubstitution(i + 1); continue; }
          openSubstitution('backtick', i);
          continue;
        }
        if (ch === '$' && command[i + 1] === '(' && command[i + 2] !== '(') {
          openSubstitution('subst', i); i++;
          continue;
        }
      }
      addText(ch, state === 'double' ? 'double' : 'ansi-c'); started = true; sawQuote = true;
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
      let lastTerm = false;
      while (pendingHeredocs.length > 0) {
        const { delim, stripTabs } = pendingHeredocs.shift();
        const { body, end, terminated } = readHeredocBody(command, j, delim, stripTabs);
        // The reset is load-bearing: a first here-doc may terminate (lastTerm
        // true) while a SECOND one on the same line does not — leaving lastTerm
        // set would rewind onto the unterminated body's first char instead of a
        // real newline (#999).
        if (!terminated) { lastTerm = false; pendingHeredocs.length = 0; break; }
        lastTerm = true;
        if (body.length > 0) sink.push({ text: body, quoted: true });
        j = end;
      }
      // `readHeredocBody` returns `end` pointing PAST the newline that closes the
      // terminator line, so `j` sits at the first char of the NEXT command and
      // the separating newline is swallowed. Rewind onto it (when there is one —
      // a terminator at input-end has none) so the newline reaches the separator
      // branch below and `cat <<EOF\nbody\nEOF\nrm -rf /tmp/ok` splits into two
      // segments. Without this the trailing command glued into the here-doc
      // verb's segment and an allowlisted rm target failed closed (#999 FP).
      if (lastTerm && command[j - 1] === '\n') j -= 1;
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
      arithDepth++; addText('$((', 'none'); started = true; i += 2;
      continue;
    }
    if (ch === '(' && command[i + 1] === '(' && !started) {
      arithDepth++; addText('((', 'none'); started = true; i++;
      continue;
    }
    if (arithDepth > 0 && ch === ')' && command[i + 1] === ')') {
      arithDepth--; addText('))', 'none'); started = true; i++;
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) {
      // Backslash-NEWLINE is a LINE CONTINUATION, not an escape (#981). bash
      // joins the lines and BOTH characters vanish before word splitting, so
      // this branch must leave no trace: no text, and `started` untouched (a
      // trailing continuation must not flush a phantom empty token).
      //
      // Pre-#981 the newline was appended as literal text and the guard saw a
      // phantom `"\n"` token. Measured consequences, both wrong in a different
      // direction: `rm -rf \<LF> /tmp/ok` (argv `rm -rf /tmp/ok`, allowlisted)
      // was DENIED because `"\n"` read as a second, non-allowlisted target; and
      // `git push \<LF>--force` was ALLOWED because `"\n--force"` is not the
      // `--force` flag any rule looks for. Eliding converges the token stream
      // on bash's argv, which is the only defensible reference.
      if (command[i + 1] === '\n') { i++; continue; }
      addText(command[i + 1], 'escape'); started = true; i++;
      continue;
    }

    // Nesting (#1667) — subshells, command substitutions, backticks and process
    // substitutions. Arithmetic (`$((`/`((`, taken above) keeps every paren as
    // text; inside `case … esac` a paren is pattern syntax (`(a)` / `a)`) and
    // also stays text, the pre-#1667 behaviour.
    if (arithDepth === 0) {
      const atCap = stack.length >= MAX_TOKENIZER_NESTING;
      if (ch === '`') {
        if (topKind() === 'backtick') { closeSubstitution(i + 1); continue; }
        if (atCap) { pushSubshellSeparator(); continue; }
        openSubstitution('backtick', i);
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        if (atCap) { pushSubshellSeparator(); i++; continue; }
        openSubstitution('subst', i); i++;
        continue;
      }
      // Inside a case HEAD (`subject`/`in`/`pattern`) a word-start `(` is the
      // optional leading paren of a pattern (`(a)`); in an arm BODY it is a
      // subshell like anywhere else (`a) (rm x);;`).
      const top = caseTop();
      if (ch === '(' && !started && (top === null || top === 'body')) {
        if (atCap) { pushSubshellSeparator(); continue; }
        // `<(cmd)` / `>(cmd)`: a process substitution is a WORD (a filename),
        // so it is hoisted like `$(…)` and the redirect keeps its operand.
        const prev = sink[sink.length - 1];
        if (i > 0 && (command[i - 1] === '<' || command[i - 1] === '>') && prev && prev.redirect) {
          openSubstitution('subst', i);
          continue;
        }
        // `caseLen`: a subshell opened in an arm body closes only at that
        // same case level, never through a pattern `)` of a nested case.
        stack.push({ kind: 'paren', caseLen: caseStates.length });
        pushSubshellSeparator();
        continue;
      }
      if (ch === ')') {
        // `esac)` must close its case before the paren is judged.
        if (started && !sawQuote && text === 'esac') flush();
        // End of a case PATTERN (`a)`, `(a)`, `"a")`, `a)rm …`): keep the `)`
        // on the pattern word and start the arm as a new statement, so its
        // first word is a segment head (#1671 follow-up F1) and a `case`
        // there opens (F2).
        if (caseTop() === 'pattern') {
          addText(ch, 'none'); started = true;
          flush();
          sink.push({ text: ';', quoted: false, operator: 'case-pattern' });
          setCaseTop('body');
          continue;
        }
        // `f()` / `arr=()` — the `)` right after a MID-WORD `(` is that word's
        // own text, never the close of an enclosing `$( … )` / subshell.
        // Keyed on WHERE that `(` came from, not on the raw previous char: an
        // escaped `\(` would otherwise keep a `"$(echo \()"` open and swallow
        // every following command (refute review of 8f323ad8, HIGH).
        if (started && bareParenAt === i - 1 && text.endsWith('(')) {
          addText(ch, 'none');
          // #1679: an adjacent compound body must start a fresh token too:
          // `f(){unlink X;}` / `f()(unlink X)`. Only a bare, unquoted head in
          // command position qualifies; argument text must stay an argument.
          const bodyOpener = command[i + 1];
          if (!sawQuote && FUNCTION_HEAD_RE.test(text) && inCommandPosition() &&
              (bodyOpener === '{' || bodyOpener === '(')) {
            flush();
            if (bodyOpener === '{') {
              sink.push({ text: '{', quoted: false });
              i++;
            }
          }
          continue;
        }
        const frame = stack[stack.length - 1];
        if (topKind() === 'paren' && caseStates.length === frame.caseLen &&
            (caseTop() === null || caseTop() === 'body')) {
          stack.pop(); pushSubshellSeparator(); continue;
        }
        if (caseStates.length === 0 && topKind() === 'subst') { closeSubstitution(i + 1); continue; }
      }
    }

    // A REAL (non-continued) newline is a command separator, exactly like `;`
    // in the POSIX grammar (#981). MUST stay below the pending-here-doc branch
    // above: a newline that opens or ends a here-doc body is consumed there and
    // never reaches this point, so a body line can never become a separator.
    //
    // Token shape: `text: ';'` is the canonical spelling of its separator class
    // — every text-keyed consumer (splitSegments here, the ledger guard,
    // scope-gate's SHELL_SEPARATOR_OPS) then classifies it correctly without a
    // per-consumer edit, which a `text: '\n'` would silently NOT do (it would
    // land in scope-gate's word stream and could displace a `sed -i` file
    // argument). `operator: 'newline'` keeps the origin distinguishable for
    // consumers that care, mirroring how `redirect` marks redirect tokens.
    if (ch === '\n') {
      flush();
      sink.push({ text: ';', quoted: false, operator: 'newline' });
      continue;
    }

    if (/\s/.test(ch)) { flush(); continue; }

    // Inside `$(( … ))` / `(( … ))` every `<` / `>` is a shift or comparison
    // operator, never a redirect (gate 1, #970) — append verbatim so the
    // redirect branches below never tear an arithmetic expression apart.
    if (arithDepth > 0 && (ch === '<' || ch === '>')) { addText(ch, 'none'); started = true; continue; }

    // Redirect operators (#983) — longest-match-first, and BEFORE the
    // chain-operator branch below so `&>` / `&>>` win over the `&` operator.
    if (ch === '&' && command[i + 1] === '>') {
      flush();
      if (command[i + 2] === '>') {
        sink.push({ text: '&>>', quoted: false, redirect: { fd: null, mode: 'append' } });
        i += 2;
      } else {
        sink.push({ text: '&>', quoted: false, redirect: { fd: null, mode: 'truncate' } });
        i += 1;
      }
      // zsh clobber suffix (#1795): `&>|` / `&>!` / `&>>|` / `&>>!` are the
      // SAME redirect with noclobber overridden — the suffix is syntax.
      if (isClobberSuffix(command[i + 1])) i += 1;
      continue;
    }
    if (ch === '<') {
      if (command[i + 1] === '<' && command[i + 2] === '<') {
        flush();
        sink.push({ text: '<<<', quoted: false, redirect: { fd: null, mode: 'herestring' } });
        i += 2;
        continue;
      }
      if (command[i + 1] === '<') {
        // Here-doc `<<WORD` / `<<-WORD` — merged #965/#970 machinery: the
        // delimiter is SYNTAX (consumed, never a token of its own); the body
        // is consumed at the next newline as ONE quoted token, but ONLY while
        // every pending here-doc finds its terminator (gate 2 — see the `\n`
        // branch above). A delimiter butted against `)` is rejected
        // (belt-and-braces for an arithmetic form the depth counter did not
        // see): the operator token is still emitted, no body is queued.
        let j = i + 2;
        let stripTabs = false;
        if (command[j] === '-') { stripTabs = true; j++; }
        let k = j;
        while (command[k] === ' ' || command[k] === '\t') k++;
        const { value, end } = readDelimiterWord(command, k);
        const prefix = takeFdPrefix();
        const opText = `${prefix.digits}<<${stripTabs ? '-' : ''}`;
        sink.push({ text: opText, quoted: false, redirect: redirectField(prefix, 'heredoc') });
        if (value && command[end] !== ')') {
          pendingHeredocs.push({ delim: value, stripTabs });
          i = end - 1;
        } else {
          i = j - 1;
        }
        continue;
      }
      // `<&N` / `<&-` / `N<&M` / `N<&M-` — input fd duplication / close
      // (#1830). Lexed as `<` read + chain `&` + word before, the `&` split
      // the statement: `git 3<&- reset --hard` lost its verb surface (ALLOW).
      if (command[i + 1] === '&' && (/[0-9]/.test(command[i + 2] ?? '') || (command[i + 2] === '-' && endsFdWord(command[i + 3])))) {
        const prefix = takeFdPrefix();
        let j = i + 2;
        let dupTarget = '';
        while (j < command.length && /[0-9]/.test(command[j])) { dupTarget += command[j]; j++; }
        if (command[j] === '-' && endsFdWord(command[j + 1])) { dupTarget += '-'; j++; }
        sink.push({ text: `${prefix.digits}<&${dupTarget}`, quoted: false, redirect: redirectField(prefix, 'dup') });
        i = j - 1;
        continue;
      }
      const prefix = takeFdPrefix();
      if (command[i + 1] === '&') {
        // `<&` with its operand anywhere else — after blanks, quoted, or a
        // glued `-WORD` (#1832). Placeholder; resolveFdOperandRedirects reads
        // the operand word once the stream is complete.
        sink.push(fdOperandPlaceholder(`${prefix.digits}<&`, redirectField(prefix, 'read'), '<'));
        i += 1;
        continue;
      }
      sink.push({ text: `${prefix.digits}<`, quoted: false, redirect: redirectField(prefix, 'read') });
      continue;
    }
    if (ch === '>') {
      // fd-prefix (`2>/dev/null`, `2>>log`, `2>&1`): a purely-numeric UNQUOTED
      // in-progress token is the IO_NUMBER — consume it as the fd instead of
      // flushing it as an ordinary word (matches bash IO_NUMBER lexing; a
      // quoted "2" stays a word, exactly as bash treats it).
      const prefix = takeFdPrefix();
      const fdText = prefix.digits;
      const field = (mode) => redirectField(prefix, mode);
      // zsh clobber forms (#1795) arrive in CANONICAL spelling, because every
      // text-keyed consumer (scope-gate's WRITE_REDIRECT_OP_RE) already knows it:
      // `>&|` / `>&!` (stdout+stderr) → `&>`, `>>&|` / `>>&!` → `&>>`, `>>|` /
      // `>>!` → `>>`, `>!` → `>|` — fd prefix kept where bash/zsh keep one. A
      // bare `>&` / `>>&` before a WORD becomes the plain write redirect + its
      // operand word (resolveFdOperandRedirects, #1832) — the pair scope-gate's
      // foldFdDupFilenameRedirects used to build from `>` `&` `WORD`.
      if (command[i + 1] === '>' && command[i + 2] === '&' && isClobberSuffix(command[i + 3])) {
        sink.push({ text: '&>>', quoted: false, redirect: { fd: null, mode: 'append' } });
        i += 3;
      } else if (command[i + 1] === '&' && isClobberSuffix(command[i + 2])) {
        sink.push({ text: '&>', quoted: false, redirect: { fd: null, mode: 'truncate' } });
        i += 2;
      } else if (command[i + 1] === '>' && command[i + 2] === '&') {
        // zsh `>>& WORD` appends stdout+stderr (#1832: the chain `&` split the
        // statement). Same operand grammar as `>&` below.
        sink.push(fdOperandPlaceholder(`${fdText}>>&`, field('append'), '>'));
        i += 2;
      } else if (command[i + 1] === '>') {
        sink.push({ text: `${fdText}>>`, quoted: false, redirect: field('append') });
        i += 1;
        if (isClobberSuffix(command[i + 1])) i += 1;
      } else if (command[i + 1] === '&' && /[0-9]/.test(command[i + 2] ?? '')
        && !((fdText === '' || fdText === '1') && /^[0-9]+-[^\s;|&()<>]/.test(command.slice(i + 2)))) {
        // N>&M / >&M — fd duplication; the target fd is inline, no operand word.
        // Not for stdout + `M-WORD` (`>&2-x`, `1>&2-x`): bash writes stdout and
        // stderr to the FILE `2-x` (measured 2026-10-27, Opus review F4) — that
        // form takes the operand placeholder below. `2>&1-x` (fd ≠ 1) stays
        // here: bash reports "ambiguous redirect" and runs nothing.
        let j = i + 2;
        let dupTarget = '';
        while (j < command.length && /[0-9]/.test(command[j])) { dupTarget += command[j]; j++; }
        // `N>&M-` moves the fd (dup + close M) — same token (#1830).
        if (command[j] === '-' && endsFdWord(command[j + 1])) { dupTarget += '-'; j++; }
        sink.push({ text: `${fdText}>&${dupTarget}`, quoted: false, redirect: field('dup') });
        i = j - 1;
      } else if (command[i + 1] === '&' && command[i + 2] === '-' && endsFdWord(command[i + 3])) {
        // `>&-` / `N>&-` closes the fd (#1830). Lexed as `>` truncate + chain
        // `&` + word `-` before, the `&` split the statement, so
        // `git 3>&- reset --hard` was ALLOWED. One dup token, no operand word —
        // the exact token scope-gate's foldFdDupFilenameRedirects built from the
        // old three-token form, so its input for `>& WORD` is unchanged.
        // ONLY at a word boundary: the glued form `N>&-WORD` has two readings
        // (bash: close + argv word WORD; zsh: write to FILE `-WORD`) and goes
        // through the operand placeholder below, which judges both (#1832, see
        // resolveFdOperandRedirects).
        sink.push({ text: `${fdText}>&-`, quoted: false, redirect: field('dup') });
        i += 2;
      } else if (command[i + 1] === '&') {
        // `>&` / `N>&` with its operand anywhere else — after blanks, quoted,
        // a file name, or a glued `-WORD` (#1832). Lexed as `>` + chain `&`,
        // the `&` split the statement: `git >& out reset --hard` and
        // `git 2>&"1" reset --hard` lost their verb surface. Placeholder;
        // resolveFdOperandRedirects reads the operand word once the stream is
        // complete (the word is lexed by the ordinary quote machinery).
        sink.push(fdOperandPlaceholder(`${fdText}>&`, field('truncate'), '>'));
        i += 1;
      } else if (isClobberSuffix(command[i + 1])) {
        sink.push({ text: `${fdText}>|`, quoted: false, redirect: field('truncate') });
        i += 1;
      } else {
        sink.push({ text: `${fdText}>`, quoted: false, redirect: field('truncate') });
      }
      continue;
    }

    // Unquoted shell control operators become standalone tokens so chain-splitting
    // and per-segment verb detection work even without surrounding whitespace
    // (e.g. `/tmp/x;rm -rf src/`). Recognised: ; && || | & — longest match first.
    // The redirect branches above win for `&>` / `&>>` (one token since the
    // #983 redirect token class), so this branch only ever sees a bare chain `&`.
    if (ch === ';' || ch === '|' || ch === '&') {
      flush();
      // `;;` / `;&` / `;;&` end an arm: the next word at this level is a pattern.
      if (ch === ';' && (command[i + 1] === ';' || command[i + 1] === '&') && caseTop() === 'body') {
        setCaseTop('pattern');
      }
      let op = ch;
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) { op = ch + ch; i++; }
      sink.push({ text: op, quoted: false });
      continue;
    }

    if (ch === '(') bareParenAt = i;
    // A bare `{` extends the run of leading braces only while nothing else — not
    // even an empty quote pair (`""{x` is a literal word) — came before it.
    if (ch === '{' && text.length === braceLead && (braceLead > 0 || !started)) braceLead++;
    addText(ch, 'none'); started = true;
  }

  // Unterminated quote → flush whatever accumulated (mark quoted so the guard treats
  // the dangling text conservatively). Deliberately fail-OPEN in the lexer: a wedged
  // guard that blocks every Bash call is strictly worse than a missed enforcement.
  if (state !== 'normal') sawQuote = true;
  flush();

  // Unclosed nesting levels (#1667): an open `( …` just ends; an open
  // substitution is closed at end of input, so its body is STILL hoisted — the
  // conservative direction (the verb inside stays visible) — and the outer word
  // keeps the raw remainder.
  while (stack.length > 0) {
    if (topKind() === 'paren') { stack.pop(); continue; }
    closeSubstitution(command.length);
    if (state !== 'normal') sawQuote = true;
    flush();
  }
  for (const t of hoisted) tokens.push(t); // no spread — see closeSubstitution

  return resolveFdOperandRedirects(tokens);
}

/**
 * Shell RESERVED WORDS and grouping tokens that bash recognises ONLY in COMMAND
 * POSITION — the first word of a statement (#1145). Everywhere else they are
 * ordinary arguments (`echo do`, `git commit -m then`), which is exactly why the
 * drop below is position-gated rather than a blanket text filter.
 *
 * Two classes, both dropped, for the same reason:
 *   - OPENERS (`{`, `(`, `!`, `if`, `elif`, `then`, `else`, `while`, `until`,
 *     `do`, `coproc`) are followed by a COMMAND. `coproc` runs it as a
 *     coprocess in bash and zsh (#1707 point 3). bash's named form
 *     `coproc NAME { …; }` drops NAME too (#1731 point 2, see
 *     splitSegmentsReading). Dropping one moves verb resolution
 *     towards the real command — the identical safety argument WRAPPER_UNWRAP
 *     makes for a transparent wrapper: a dropped token is a reserved word, never
 *     an interpreter, so this cannot turn a match into a miss.
 *   - CLOSERS (`}`, `)`, `fi`, `done`, `esac`) end one. In command position they
 *     are the whole segment, which then filters out as empty.
 *
 * Deliberately NOT listed:
 *   - `for` / `select` / `case` / `in` / `function` — followed by a NAME or WORD,
 *     never a command. Dropping them would invent a verb (`for t in a` → `t`)
 *     where the truthful answer is "this segment has no command".
 *   - `time` — a reserved word AND an external binary, already classified as a
 *     transparent wrapper in WRAPPER_UNWRAP. One classification per token, in
 *     one table: a second entry here would fork the wrapper-vs-keyword decision
 *     the way `VERB_PREFIXES` once forked WRAPPER_UNWRAP (#991).
 *
 * Only a STANDALONE token is dropped. bash requires whitespace around `{` /
 * `}`, so brace groups are always covered; a subshell written WITHOUT the space
 * (`(rm -rf /)`) no longer reaches this table at all — since #1667 the lexer
 * emits its parens as separators (see {@link tokenizeCommand}).
 */
const COMMAND_POSITION_KEYWORDS = new Set([
  '{', '(', '!', 'if', 'elif', 'then', 'else', 'while', 'until', 'do', 'coproc',
  '}', ')', 'fi', 'done', 'esac',
]);

/**
 * Is `segment` exactly a function-definition head: `name()`, `function name`
 * or `function name()`, all unquoted?
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @returns {boolean}
 */
function isFunctionHead(segment) {
  // Length first: splitSegments asks this per token, so a scan of a long
  // segment here would make the split quadratic.
  if (segment.length === 0 || segment.length > 2 || segment.some((t) => t.quoted)) return false;
  // A lone `function` is zsh's anonymous function (`function { …; }`), which
  // zsh runs on the spot — measured: zsh 5.9 prints `hi` for
  // `function { echo hi; }` (#1699 item 13).
  if (segment.length === 1) return segment[0].text === 'function' || FUNCTION_HEAD_RE.test(segment[0].text);
  return segment.length === 2 && segment[0].text === 'function';
}

/**
 * How many brace-group openers are glued to the front of `tok`'s command word
 * (`{unlink` → 1, `{{unlink` → 2, `{"unlink"` → 1)? 0 when none.
 * zsh reads a leading `{` in command position as the reserved word even
 * without a following blank — measured with zsh 5.9: `{echo hi;}`,
 * `f() {echo hi;}; f` and `function f() {echo hi;}; f` all print `hi`, and
 * `{echo,hi}` fails as `command not found: echo,hi` (#1699 item 13). bash
 * rejects or brace-expands these forms; splitting the `{` off never hides a
 * verb there either, since the remainder was no verb before. A token that
 * also ENDS in `}` (`{}`, `{fd}` of a named-fd redirection `{fd}>file`) is
 * left alone: it closes itself, so no command word sits behind its `{`.
 *
 * #1707 point 2: the decision rests on the RAW leading characters, not on the
 * token's `quoted` flag — zsh runs `{"echo" L;}`, `{'echo' L;}` and
 * `{{echo L;}}`, where the `{` is bare although the rest of the word is quoted,
 * or is itself followed by another opener. The lexer records the bare run as
 * `braceLead` on a quoted token (see {@link tokenizeCommand}); a token that is
 * quoted from its first character (`"{unlink"`) carries none and stays a word.
 *
 * @param {{ text: string, quoted: boolean, braceLead?: number, redirect?: object, operator?: string }} tok
 * @returns {number}
 */
function gluedBraceOpenerCount(tok) {
  if (tok.redirect || tok.operator !== undefined) return 0;
  let n = 0;
  if (tok.quoted) n = tok.braceLead ?? 0;
  else while (n < tok.text.length && tok.text[n] === '{') n++;
  if (n === 0 || n >= tok.text.length || tok.text.endsWith('}')) return 0;
  return n;
}

/**
 * The extra reading of a word that ends in a `}` glued to it inside an open
 * brace group (#1707 point 1): zsh 5.9 prints `-r X` for `{echo -r X}` — the
 * glued `}` closes the group and is not part of the word — while bash keeps it
 * as text. An option table cannot enumerate unknown forms, so both readings
 * are judged and never one picked: the word itself stays, and the word with
 * ONE trailing `}` stripped is the second reading.
 *
 * zsh closes exactly ONE group per glued `}` word, however many braces trail
 * it (zsh 5.9, measured 2026-10-22): `{echo X}}` prints `X}`, `{{echo X}}` is a
 * parse error, `{ echo X }}}` prints `X }}`, `{ { echo a}}; echo X}` prints
 * `a}` then `X` (the outer group stays open until `X}`), and
 * `{ { { echo a}}}; echo X}; echo Y}` prints `a}}`, `X`, `Y`. Counting several
 * closes for one word left a later glued `}` with no reading:
 * `{ { echo a}}; echo x >CLAUDE.md}` truncates `CLAUDE.md` in zsh. One reading
 * per word also keeps the work linear on a `{`×N `X` `}`×N flood.
 *
 * A glued `}` word never lowers `openGroups` (security re-review of f99e1352):
 * the reader cannot tell a real closer from a word zsh keeps as text —
 * `${HOME}`, `{a,b}`, `"a}"`, `a\}` — and counting one of those as a close left
 * the REAL closer behind it with no reading: `{ echo ${HOME}; echo x >CLAUDE.md}`
 * truncates `CLAUDE.md` in zsh 5.9. Only a `}` keyword in command position
 * closes a group (see {@link splitSegments}).
 *
 * NAMED CEILING (BV-004): this over-counts open groups, deliberately fail-closed
 * — an extra open group only ADDS a reading, never drops one. What it
 * over-blocks: once a glued group has really closed, a later `x}` word outside
 * it still yields `x` too (`{ echo a}; rm x}` is judged as `x}` and `x`).
 * Revisit if a false DENY on a real transcript command traces to this reading.
 *
 * @param {string} text
 * @param {number} openGroups
 * @returns {string[]} the one stripped reading, or [] when the word has no
 *   glued `}`, no group is open, or the word is only `}`.
 */
function gluedCloseReadings(text, openGroups) {
  if (openGroups === 0 || text.length < 2 || !text.endsWith('}')) return [];
  return [text.slice(0, -1)];
}

/**
 * Is `segment` exactly a prefix that puts the next word — a brace group or any
 * other compound command — in command position? A function head (see
 * {@link isFunctionHead}) or `time` / `time -p` / `time --` / `time -p --`,
 * which bash and zsh both parse as a pipeline prefix (#1707 point 3: zsh runs
 * `time {unlink P;}`; #1731 point 2: bash runs `time -p -- { unlink P; }`).
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @returns {boolean}
 */
function isCompoundPrefix(segment) {
  if (isFunctionHead(segment)) return true;
  if (segment.length === 0 || segment.length > 3 || segment.some((t) => t.quoted)) return false;
  if (segment[0].text !== 'time') return false;
  const flags = segment.slice(1).map((t) => t.text).join(' ');
  return flags === '' || flags === '-p' || flags === '--' || flags === '-p --';
}

/**
 * Keywords whose test list zsh may close with a `[[ … ]]` / `(( … ))` and
 * follow directly with a `{ … }` body — the short forms `if [[ x ]] { … }`,
 * `while (( n )) { … }` (zsh manual, "Alternate Forms For Complex Commands":
 * the test must be delimited by `[[ ]]` or `(( ))`, else its end is not seen).
 */
const ZSH_SHORT_BODY_HEADS = new Set(['if', 'elif', 'while', 'until']);

/**
 * Split a tokenized command into chained segments on shell control operators
 * (`;`, `&&`, `||`, `|`, `&`) and on newline separators (#981). Only UNQUOTED
 * single-token operators split; an operator that arrived inside quotes stays
 * part of its segment.
 *
 * A segment additionally has its COMMAND-POSITION reserved words stripped
 * (#1145) — see {@link COMMAND_POSITION_KEYWORDS}. Without this the first token
 * of a compound statement is `do` / `then` / `{` / `(` and NEVER the command,
 * so every consumer that reads a segment head saw a keyword: measured against
 * the live issue-budget guard with `max-per-session: 1, mode: strict`,
 * `for t in a b c; do glab issue create …; done` and `{ glab issue create …; }`
 * were allowed with NO accounting at all, while the plain form denied at 1/1.
 *
 * zsh keyword bodies (#1707 point 3), each judged in command position:
 * `repeat N cmd` / `repeat N { …; }` (the count word is dropped with the
 * keyword), `{ …; } always { …; }` (an `always` right after a group's closing
 * `}` starts a new statement), `time { …; }` (see {@link isCompoundPrefix}) and
 * zsh's short function body `f() cmd`. Inside an open brace group a word with a
 * glued `}` carries `closeReadings` (see {@link gluedCloseReadings}) for the
 * delete and redirect target surfaces. Only a command-position `}` keyword
 * lowers the open-group count; a glued `}` word never does, so the count may
 * over-state open groups — a fail-closed ceiling named in gluedCloseReadings.
 *
 * The newline separator is checked by its `operator` field as well as its text,
 * so the split survives a future change to that token's spelling. Because a
 * separator token is CONSUMED here, it can never reach a per-segment operand
 * loop — `parseRmTargets` in hooks/pre-bash-destructive-guard.mjs iterates
 * segments, so it never sees a newline token and needed no change for #981.
 *
 * Exported as `splitChainSegments` (see the alias export below):
 * hooks/pre-bash-destructive-guard.mjs consumes it for wrapper-aware rm
 * parsing (#982/#983). The hook previously kept a drift-prone local mirror
 * of this splitter (regex-based operator set vs. this Set) — W4 B1.
 *
 * An `always` after a GLUED or one-word close (`x}`, `{true}`) has two readings
 * and both are judged (review of !233): zsh may read the word as closing the
 * group, so `always` starts a new statement; bash knows no `always` and passes
 * it and every word behind it to the command — `bash -c '{ rm -f x} always
 * CLAUDE.md; }'` deletes CLAUDE.md. The bash reading keeps every statement; from
 * the first soft cut on, each zsh statement is added unless the bash reading has
 * the same words, in which case its glued-close readings are merged into that
 * statement instead — `{true} always {echo a; rm CLAUDE.md}` keeps `CLAUDE.md`
 * from zsh's open `always` group, and no statement is counted twice (the
 * issue-budget guard counts per segment). A command-position `}` is no such
 * case: `} always` is a bash syntax error, the cut is hard.
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @returns {Array<Array<{ text: string, quoted: boolean, closeReadings?: string[] }>>}
 */
function splitSegments(tokens) {
  const zsh = splitSegmentsReading(tokens, true);
  if (!zsh.softCut) return zsh.segments;
  const segments = splitSegmentsReading(tokens, false).segments;
  const byWords = new Map(segments.map((segment, i) => [segmentKey(segment), i]));
  for (const segment of zsh.segments) {
    if (!segment.afterSoftCut) continue;
    const key = segmentKey(segment);
    const at = byWords.get(key);
    if (at === undefined) {
      byWords.set(key, segments.length);
      segments.push(segment);
      continue;
    }
    segments[at] = mergeCloseReadings(segments[at], segment);
  }
  return segments;
}

/**
 * The bash statement with the zsh statement's glued-close readings added per
 * word (both have the same words). New token objects: the tokens are shared
 * between the two readings.
 *
 * @param {Array<object>} target
 * @param {Array<object>} source
 * @returns {Array<object>}
 */
function mergeCloseReadings(target, source) {
  return target.map((tok, i) => {
    const extra = source[i]?.closeReadings;
    if (!extra) return tok;
    const merged = [...new Set([...(tok.closeReadings ?? []), ...extra])];
    return { ...tok, closeReadings: merged };
  });
}

/** @param {Array<{ text: string, quoted: boolean }>} segment */
function segmentKey(segment) {
  return JSON.stringify(segment.map((t) => [t.text, t.quoted]));
}

/**
 * One reading of {@link splitSegments}. `cutSoftAlways`: whether an `always`
 * after a glued or one-word close starts a new statement (zsh) or stays a word
 * (bash). Every statement written after the first such cut is marked
 * `afterSoftCut`.
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @param {boolean} cutSoftAlways
 * @returns {{ segments: Array<Array<object>>, softCut: boolean }}
 */
function splitSegmentsReading(tokens, cutSoftAlways) {
  let softCut = false;
  // Marked when a statement is WRITTEN, not when `current` starts: keyword
  // peeling (`always { rm …`) replaces `current` in between.
  const segments = [];
  const pushSegment = (segment) => {
    if (segment.length > 0 && softCut) segment.afterSoftCut = true;
    segments.push(segment);
  };
  let current = [];
  const operators = new Set([';', '&&', '||', '|', '&']);
  // Open brace groups (#1707 point 1) — only a group opened in command
  // position counts, so `echo {a,b}` never arms the glued-`}` readings.
  let openGroups = 0;
  // The previous token closed a brace group — zsh's `always` may follow it:
  // 'hard' after a command-position `}`, 'soft' after a glued or one-word close.
  let closedGroup = null;
  // The next token is the count word of a command-position `repeat`.
  let repeatCount = false;
  // The statement opened with `if`/`elif`/`while`/`until`: a `{` right behind
  // a closing `]]` / `))` starts zsh's short body (#1731 point 2).
  let shortBodyHead = false;
  // The previous token was a command-position `coproc`: bash's named form
  // `coproc NAME { …; }` follows when the word after it is followed by `{`.
  let afterCoproc = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const afterClose = closedGroup;
    closedGroup = null;
    const coprocJustDropped = afterCoproc;
    afterCoproc = false;
    if (!tok.quoted && (tok.operator === 'newline' || operators.has(tok.text))) {
      pushSegment(current);
      current = [];
      repeatCount = false;
      shortBodyHead = false;
      continue;
    }
    if (repeatCount) { repeatCount = false; continue; }
    // bash `coproc NAME { …; }` (#1731 point 2): NAME is the coprocess's
    // variable name, never a command — before, it resolved as the verb.
    const nextTok = tokens[i + 1];
    if (coprocJustDropped && current.length === 0 && !tok.quoted && !tok.redirect &&
        tok.operator === undefined && nextTok !== undefined && !nextTok.quoted && nextTok.text === '{') {
      continue;
    }
    // zsh short body `if [[ x ]] { …; }` / `while (( n )) { …; }`: the test
    // list ends at its `]]` / `))`, and the `{` behind it opens the body — a
    // statement of its own, judged in command position.
    const lastText = current.length > 0 && !current[current.length - 1].quoted
      ? current[current.length - 1].text
      : '';
    if (shortBodyHead && (lastText === ']]' || lastText === '))') && !tok.quoted) {
      const gluedBody = gluedBraceOpenerCount(tok);
      if (tok.text === '{' || gluedBody > 0) {
        pushSegment(current);
        shortBodyHead = false;
        if (tok.text === '{') {
          current = [];
          openGroups++;
        } else {
          const { braceLead: _consumed, ...rest } = tok;
          current = [{ ...rest, text: tok.text.slice(gluedBody) }];
          openGroups += gluedBody;
        }
        continue;
      }
    }
    // zsh `repeat N body` (#1707 point 3): the keyword and its count are no
    // command; the body behind them runs N times. Only a count WORD counts: in
    // bash `repeat` is an ordinary command name and `repeat >CLAUDE.md`
    // truncates before the lookup fails, so a redirect or an operator behind it
    // keeps `repeat` the segment head and the redirect collected. A quoted count
    // is still one word — zsh 5.9 runs `repeat '2' cmd` and `repeat "$N" cmd`.
    const count = tokens[i + 1];
    // Also behind a compound prefix (#1731 point 2): `time repeat 1 cmd`,
    // `f() repeat 1 cmd`.
    if ((current.length === 0 || isCompoundPrefix(current)) && !tok.quoted && tok.text === 'repeat' &&
        count !== undefined && !count.redirect && count.operator === undefined &&
        !operators.has(count.text)) {
      current = [];
      repeatCount = true;
      continue;
    }
    // zsh `{ try; } always { finally; }` (#1707 point 3): the `always` body runs
    // like any group, so `always` ends the statement before it.
    if (afterClose !== null && !tok.quoted && tok.text === 'always' &&
        (afterClose === 'hard' || cutSoftAlways)) {
      if (current.length > 0) pushSegment(current);
      current = [];
      if (afterClose === 'soft') softCut = true;
      continue;
    }
    // Reserved word in COMMAND POSITION (`current` still empty) → drop it, so
    // the NEXT token becomes the segment head and is itself judged in command
    // position (`do { rm …` peels both). A keyword anywhere else is an ordinary
    // argument and is kept verbatim (#1145).
    //
    // A function head (`f()`, `function f`, `function f()`) before its compound
    // body (#1679 point 1): the head is no command, and the body runs on every
    // call, so drop the head and judge the body in command position like a bare
    // brace group. Before, `f() { unlink <ledger>; }; f` resolved to verb `f()`.
    // `time` / `time -p` before a compound command is dropped the same way.
    if (!tok.quoted && COMMAND_POSITION_KEYWORDS.has(tok.text) &&
        (current.length === 0 || isCompoundPrefix(current))) {
      current = [];
      if (ZSH_SHORT_BODY_HEADS.has(tok.text)) shortBodyHead = true;
      if (tok.text === 'coproc') afterCoproc = true;
      if (tok.text === '{') openGroups++;
      if (tok.text === '}') { openGroups = Math.max(0, openGroups - 1); closedGroup = 'hard'; }
      continue;
    }
    // A `{` glued to the first word of a brace group (zsh, #1699 item 13 —
    // repeatedly and on the raw first character since #1707 point 2): drop the
    // openers, so the word behind them is the segment head.
    const glued = gluedBraceOpenerCount(tok);
    if (glued > 0 && (current.length === 0 || isCompoundPrefix(current))) {
      const { braceLead: _consumed, ...rest } = tok;
      current = [{ ...rest, text: tok.text.slice(glued) }];
      openGroups += glued;
      continue;
    }
    // zsh's short function body `f() cmd` (#1707 point 3): zsh 5.9 runs
    // `f() unlink P; f`, so the head is dropped and `cmd` heads the segment.
    if (current.length === 1 && !current[0].quoted && FUNCTION_HEAD_RE.test(current[0].text) &&
        !tok.redirect) {
      current = [];
    }
    // Outside a group `gluedCloseReadings` is []; inside one, a glued `}` word
    // gets its stripped reading but does NOT lower `openGroups`: `${HOME}`,
    // `{a,b}`, `"a}"` look the same and close nothing in zsh, so every later
    // glued `}` keeps its reading (fail-closed, see gluedCloseReadings). It may
    // still close a group, so an `always` may follow it.
    const readings = !tok.redirect && tok.operator === undefined
      ? gluedCloseReadings(tok.text, openGroups)
      : [];
    if (readings.length > 0) {
      closedGroup = 'soft';
      current.push({ ...tok, closeReadings: readings });
      continue;
    }
    // A one-word group heading its statement (`{true} always {…}`) closes
    // itself, so an `always` may follow it as well.
    if (current.length === 0 && !tok.quoted && tok.text.length > 2 && tok.text[0] === '{' &&
        tok.text.endsWith('}')) {
      closedGroup = 'soft';
    }
    current.push(tok);
  }
  pushSegment(current);
  return { segments: segments.filter((s) => s.length > 0), softCut };
}

// Public alias — the single source of truth for chain-segment splitting shared
// with hooks/pre-bash-destructive-guard.mjs (W4 B1; internal call sites keep
// the short name).
export { splitSegments as splitChainSegments };

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Verbs that name a WRITE TARGET as a bare operand — no redirect operator, no
 * wrapper flag (#1366). A sibling of WRAPPER_UNWRAP's `fileArgFlags`: that table
 * answers "does this WRAPPER flag's operand name a file the wrapper writes?",
 * this one "does this VERB's operand name a file the verb writes?".
 *
 * Spec fields:
 *   - prefix:   the operand's literal prefix (`of=`), matched on a token AFTER
 *               the resolved verb.
 *   - mode:     the default redirect mode the write is equivalent to.
 *   - appendRe: operands that turn the write into an APPEND. `dd` truncates by
 *               default (`conv=notrunc` / `oflag=append` do not), so reporting
 *               `truncate` unconditionally would over-report a rule class that
 *               deliberately permits `>>`.
 *
 * Deliberately narrow — one entry, measured. `tee`/`sponge` and in-process
 * writers (`node -e fs.writeFileSync`) are NOT here: they are not redirect-shaped
 * and belong to a different rule class (see the `redirect-harness-memory`
 * rationale in .orchestrator/policy/blocked-commands.json). REVISIT TRIGGER: a
 * second `<verb> <prefix>file` writer showing up in a transcript census.
 */
const VERB_FILE_OPERANDS = new Map([
  ['dd', { prefix: 'of=', mode: 'truncate', appendRe: /^(?:conv=.*\bnotrunc\b|oflag=.*\bappend\b)/ }],
]);

/**
 * Transparent process-wrapper table for verb resolution (#982), keyed by
 * basename. Each spec describes how to skip a wrapper's own options so the
 * REAL verb it delegates to resolves (`sudo -u root bash -c '…'` → `bash`).
 *
 * Spec fields (all optional):
 *   - argFlags:       Set of flags that consume a SEPARATE next-token argument.
 *   - fileArgFlags:   Subset of `argFlags` whose operand is a FILE THE WRAPPER
 *                     WRITES (`time -o report`), not merely an option value.
 *                     Entries so flagged are reported with `writesFile: true`
 *                     in `wrapperArgs` (#992). Membership is per-wrapper and
 *                     deliberately narrow — measured counter-examples that must
 *                     NOT be in it: `stdbuf -o 0` (a BUFFERING MODE), `nice -n
 *                     10` (a priority), `sudo -u root` (a user name). A blanket
 *                     "every argFlag operand is a file" rule would block all
 *                     three; the table is the discriminator.
 *   - shellFlags:     Set of flags that make the wrapper itself spawn a shell
 *                     (`sudo -i` / `sudo -s`) — resolution yields the synthetic
 *                     verb `sh`, so the quoted-payload guard treats the segment
 *                     as an interpreter.
 *   - envAssignments: skip unquoted `VAR=value` tokens among the options.
 *   - splitString:    `env -S/--split-string <string>` — the string is a shell
 *                     command line; collected as a recursion payload (same
 *                     treatment as a `-c` payload).
 *   - positionals:    number of positional arguments to skip before the verb
 *                     (`timeout DURATION cmd …`).
 *
 * Unknown single-token flags (`-i`, `--foreground`, attached forms like `-o0`
 * / `-n19`, legacy `nice -10`, `--user=root`) are skipped generically; `--`
 * ends option parsing. Deliberately NOT listed:
 *   - `su`   — interpreter (SHELL_EXEC_INTERPRETERS), its `-c` payload executes;
 *   - `xargs` — interpreter; unwrapping it would LOOSEN the guard;
 *   - `flock` / `setsid` / `ionice` — scope cut (#982, operator-approved).
 *
 * `time` IS listed (merge of the #970 here-doc line of work): the here-doc
 * design's safety argument is that a body fed to an interpreter still matches
 * because `bash` is in SHELL_EXEC_INTERPRETERS — that only holds when `bash`
 * is the RESOLVED verb, so `sudo bash <<EOF` / `time bash <<EOF` must unwrap.
 * This table is ALSO the alignment target for the ledger-guard's
 * `VERB_PREFIXES` copy (see #991) — do not fork a second wrapper list.
 *
 * Exported so downstream guards (ledger) can converge on the same table.
 */
export const WRAPPER_UNWRAP = new Map([
  ['sudo', {
    argFlags: new Set([
      '-u', '-g', '-h', '-p', '-C', '-D', '-R', '-r', '-t', '-T', '-U',
      '--user', '--group', '--host', '--prompt', '--close-from', '--chdir',
      '--chroot', '--role', '--type', '--command-timeout', '--other-user',
    ]),
    shellFlags: new Set(['-i', '-s', '--login', '--shell']),
    envAssignments: true,
  }],
  ['doas', {
    argFlags: new Set(['-u', '-C', '-a']),
    shellFlags: new Set(['-s']),
  }],
  // `-P altpath` is BSD/macOS env(1)'s "search THIS path for the utility"
  // option. It was missing, so `-P` was skipped as a one-token boolean and its
  // operand landed in verb position: `env -P /bin:/usr/bin bash -c 'rm -rf
  // /etc'` resolved to the verb `bin` (basename of `/bin:/usr/bin`), the
  // segment was no longer an interpreter, and the quoted payload went inert —
  // measured ALLOW (#992). Note the contrast with `sudo -P`, which is
  // `--preserve-groups`, a BOOLEAN — the same letter is value-taking for one
  // wrapper and not for the other, which is why this table is per-wrapper.
  ['env', {
    argFlags: new Set(['-u', '--unset', '-C', '--chdir', '-P']),
    envAssignments: true,
    splitString: true,
  }],
  ['command', {}],
  ['nohup', {}],
  // `exec cmd args` REPLACES the shell with `cmd` — it delegates to a real verb
  // and never executes a command STRING, so by the #982 classification it is a
  // TRANSPARENT wrapper, not an interpreter (contrast `su -c`, which is in
  // SHELL_EXEC_INTERPRETERS for exactly the opposite reason). `-a NAME` is the
  // one value-taking flag; `-c` (clear environment) and `-l` are BOOLEANS here
  // — despite the spelling, `exec -c` carries no payload, so it must NOT reach
  // DASH_C_SHELLS, and it does not: that set is keyed on the RESOLVED verb.
  // Redirect-only `exec > file` keeps working. Measured both namespaces: on the
  // RAW segment the wrapper consumes `exec` and the redirect operator resolves
  // as the verb (`>`, previously `exec`); on scope-gate's paren-peeled,
  // redirect-stripped projection the segment exhausts in wrappers and yields
  // `verb: null, index: -1` — the shape a bare `sudo` already produced. Neither
  // is `rm`/`tee`/`sed`/`dd`, and a redirect target is read from the redirect
  // token stream rather than from the verb, so detection is unaffected:
  // measured `extractBashWriteTargets('exec > src/out.ts')` → `['src/out.ts']`.
  ['exec', {
    argFlags: new Set(['-a']),
  }],
  // `-o FILE` is the BSD/GNU `time` report destination and it TRUNCATES without
  // `-a` (BSD time(1): "If file exists and the -a flag is not specified, the
  // file will be overwritten"). With an empty spec the operand was read as the
  // verb, so `/usr/bin/time -o LEDGER tee -a X` resolved to `LEDGER` and hid
  // the real write verb (#988 T3). Only the EXTERNAL `time` takes flags — the
  // bash keyword rejects `-o` outright — so consuming them here cannot
  // mis-parse a keyword invocation, which never carries `-o` in the first place.
  // `-f FORMAT` / `--format FORMAT` is GNU time(1) (not BSD/macOS, where the
  // binary rejects it — so this row is Linux-CI-relevant only). Without it the
  // format string is skipped as a boolean and the FOLLOWING token is read as
  // the verb: measured `/usr/bin/time -f %e npm test` → verb `%e` (#992).
  ['time', {
    argFlags: new Set(['-o', '--output', '-f', '--format']),
    fileArgFlags: new Set(['-o', '--output']),
  }],
  ['timeout', {
    argFlags: new Set(['-k', '--kill-after', '-s', '--signal']),
    positionals: 1,
  }],
  ['nice', {
    argFlags: new Set(['-n', '--adjustment']),
  }],
  ['stdbuf', {
    argFlags: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  }],
]);

/**
 * Resolve the effective argv[0] (the command verb) for a chain segment:
 * skips leading `VAR=value` env assignments, then unwraps chained transparent
 * wrappers per WRAPPER_UNWRAP (`sudo env FOO=1 nice -n 10 bash …` → `bash`),
 * collecting any wrapper-level command-string payloads (`env -S '…'`) on the
 * way (#982).
 *
 * Skipping a prefix can only move verb resolution TOWARDS the real command, and
 * a skipped token is either a wrapper name, an option or a duration — never an
 * interpreter — so this cannot turn a match into a miss.
 *
 * Return contract (ADDITIVE — `wrapperArgs` was appended in #988 T3; existing
 * consumers destructuring `{ verb, index, payloads }` are unaffected):
 *
 * DUAL PARSE (#1000). An unknown dash-flag is ambiguous: this table cannot know
 * whether `env -Q x bash -c '…'` means "`-Q` is a boolean, `x` is the verb" or
 * "`-Q` takes `x`, `bash` is the verb". The resolver therefore reads the
 * segment TWICE — parse A treats unknown flags as booleans (byte-identical to
 * the pre-#1000 behaviour, and still the primary result), parse B treats them
 * as value-taking — and reports the second reading as `alt` when it disagrees.
 * Both readings are then judged, so a deny in EITHER is a deny: the safe
 * direction, since guessing wrong in the boolean direction silently hid an
 * interpreter behind an unrecognised flag (the measured #1000 bypass).
 * `alt` is present ONLY when an unknown flag was skipped AND the two readings
 * resolve a different verb or index; it is never nested (no `alt.alt`).
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @returns {{ verb: string|null, index: number, payloads: string[],
 *             wrapperArgs: Array<{ wrapper: string, flag: string, value: string|null,
 *                                  writesFile?: true }>,
 *             alt?: { verb: string|null, index: number, payloads: string[],
 *                     wrapperArgs: Array<{ wrapper: string, flag: string,
 *                                          value: string|null, writesFile?: true }> } }}
 *   verb — bare program basename (or synthetic `sh` for `sudo -i`/`-s`), null
 *   when the segment exhausts in wrappers; index — token index of the resolved
 *   verb (-1 when null); payloads — command strings a wrapper will execute;
 *   wrapperArgs — the value-taking wrapper flags consumed on the way to the
 *   verb, in encounter order. `wrapper` is the wrapper's basename (`time`),
 *   `flag` the option as written (`-o`, `--output`), `value` its operand
 *   (`null` when the flag ended the segment). Both the separated (`-o FILE`)
 *   and the attached long form (`--output=FILE`) are reported.
 *
 *   `writesFile: true` (#992) marks the entries whose operand is a FILE THE
 *   WRAPPER WRITES, per the spec's `fileArgFlags`. The key is present ONLY when
 *   true — an entry without it keeps the exact pre-#992 `{ wrapper, flag,
 *   value }` shape, so a `toEqual` on a non-file entry is unaffected. This is
 *   the answer to the question the caller actually has ("is this operand a
 *   write target?"), which used to be re-derived from a second table
 *   (`WRAPPER_FILE_FLAGS` in hooks/pre-bash-sessions-ledger-guard.mjs). That
 *   copy was replaced by `wa.writesFile` in #996.1 — the knowledge lives here,
 *   next to the grammar it belongs to.
 *   `/usr/bin/time -o <ledger> npm test` truncates `<ledger>` while the verb is
 *   `npm`; extractRedirectTargets surfaces exactly these entries so the
 *   redirect denylist sees them too.
 *
 *   `alt` (#1000) — the value-taking reading of the same segment, present only
 *   under the conditions above. Consumers that judge (matchSegments,
 *   collectRedirectTargets) must consider BOTH readings; consumers that need a
 *   single token position (`parseRmTargets`, the scope gate) keep reading the
 *   primary `verb`/`index` only — `alt.index` addresses a DIFFERENT reading of
 *   the token stream and must never be fed to a positional walk.
 */
function resolveCore(segment, unknownFlagsTakeValue, readMarker = true) {
  const payloads = [];
  const wrapperArgs = [];
  let sawUnknownFlag = false;
  let i = 0;
  // The command word is the first argv word after redirect spans are removed
  // (#1832): the shell allows redirects before it, so `>out rm P` and
  // `2>/dev/null rm P` run `rm P` — the verb used to resolve to `>` and every
  // verb-keyed rule (delete targets, payloads, the worktree walker) missed it.
  // For a glued close (`3>&-rm P`: bash closes fd 3 and runs `rm P`) the
  // `bashArgvWord` IS the verb; its index is the operand token that carries
  // the zsh write reading, so `index + 1` is still the first argument.
  // `segment` is the argvVerbView: the operand of a glued close already holds
  // its bash argv word, so a wrapper there (`3>&-env rm P`) is unwrapped like
  // any other (#1832 review: Opus F3 / Codex 5). With `readMarker` false the
  // zsh reading is resolved instead: the glued close is a write to the FILE
  // `-WORD` and its whole span leaves argv (see verbReadings).
  const argvVerbAt = (j) => {
    while (j < segment.length && segment[j].redirect) {
      const end = redirectSpanEnd(segment, j);
      if (readMarker && segment[j].bashArgvWord !== undefined) return end;
      j = end + 1;
    }
    return j;
  };
  // Skip leading FOO=bar env assignments (unquoted) and redirects, interleaved.
  for (;;) {
    i = argvVerbAt(i);
    if (i < segment.length && !segment[i].quoted && ENV_ASSIGN_RE.test(segment[i].text)) { i++; continue; }
    break;
  }
  while (i < segment.length) {
    i = argvVerbAt(i);
    if (i >= segment.length) break;
    const wrapper = segment[i].text.replace(/^.*\//, ''); // basename
    const spec = WRAPPER_UNWRAP.get(wrapper);
    if (!spec) break;
    i++; // consume the wrapper word
    let sawShellFlag = false;
    while (i < segment.length) {
      const tok = segment[i];
      const text = tok.text;
      if (spec.envAssignments && !tok.quoted && ENV_ASSIGN_RE.test(text)) { i++; continue; }
      if (text === '--') { i++; break; }
      if (!text.startsWith('-') || text === '-') break;
      if (spec.splitString
          && (text === '-S' || text === '--split-string'
            || text.startsWith('--split-string=') || text.startsWith('-S'))) {
        // env(1) APPENDS the remaining argv to the split string: `env -S bash
        // -c '…'` runs `bash -c '…'`, not `bash` (#1366). Collecting only the
        // operand made the trailing `-c '…'` execute unseen — the segment then
        // resolved to `verb: 'echo x > CLAUDE.md'` (the quoted payload read as
        // the verb) and neither the match surface nor the redirect surface ever
        // saw it. So the payload is the operand PLUS every remaining token, and
        // the wrapper CONSUMES the segment: nothing is left to resolve as a
        // verb, which is why this now yields `verb: null, index: -1`.
        let operand = null;
        if (text.startsWith('--split-string=')) {
          operand = text.slice('--split-string='.length);
          i++;
        } else if (text !== '-S' && text !== '--split-string') {
          operand = text.slice(2); // attached form: -S'string'
          i++;
        } else if (i + 1 < segment.length) {
          operand = segment[i + 1].text;
          i += 2;
        } else {
          i++; // `env -S` with no operand at all — nothing to collect
        }
        if (operand !== null) {
          // Raw token texts, joined by one space. Quoting is NOT re-applied:
          // the tokenizer already stripped it, and re-inventing it would be a
          // second quoting grammar. The direction of that loss is safe — an
          // over-wide payload can only make MORE text visible to the matcher
          // (fail-closed), never hide a redirect operator.
          const rest = segment.slice(i).map((t) => t.text);
          payloads.push(rest.length > 0 ? [operand, ...rest].join(' ') : operand);
          i = segment.length;
        }
        continue;
      }
      if (spec.shellFlags && spec.shellFlags.has(text)) { sawShellFlag = true; i++; continue; }
      if (spec.argFlags && spec.argFlags.has(text)) {
        // Separated form `-o FILE`: record the operand, then skip BOTH tokens
        // exactly as before (token accounting unchanged — recording only).
        const entry = {
          wrapper,
          flag: text,
          value: i + 1 < segment.length ? segment[i + 1].text : null,
        };
        if (spec.fileArgFlags?.has(text)) entry.writesFile = true;
        wrapperArgs.push(entry);
        i += 2;
        continue;
      }
      if (spec.argFlags) {
        // Attached long form `--output=FILE`. Consumes ONE token either way —
        // this branch only records the operand the fall-through would drop.
        const eq = text.indexOf('=');
        if (eq > 0 && spec.argFlags.has(text.slice(0, eq))) {
          const flag = text.slice(0, eq);
          const entry = { wrapper, flag, value: text.slice(eq + 1) };
          if (spec.fileArgFlags?.has(flag)) entry.writesFile = true;
          wrapperArgs.push(entry);
        }
      }
      // Unknown / boolean / attached-value flag. A dash token that survived
      // envAssignments, `--`, the non-dash break, splitString, shellFlags,
      // argFlags AND the attached-`=` form is one this table does not know —
      // the ONLY place the two readings differ (#1000). No wrapperArgs entry is
      // recorded in the value-taking reading: an unknown flag is by
      // construction absent from fileArgFlags, so `writesFile` can never be
      // invented for it.
      sawUnknownFlag = true;
      i += (unknownFlagsTakeValue && i + 1 < segment.length) ? 2 : 1;
    }
    for (let p = spec.positionals ?? 0; p > 0 && i < segment.length; p--) i++;
    if (sawShellFlag) return { verb: 'sh', index: i, payloads, wrapperArgs, sawUnknownFlag };
  }
  i = argvVerbAt(i);
  if (i >= segment.length) return { verb: null, index: -1, payloads, wrapperArgs, sawUnknownFlag };
  return {
    verb: segment[i].text.replace(/^.*\//, ''),
    index: i,
    payloads,
    wrapperArgs,
    sawUnknownFlag,
  };
}

/**
 * Strip the internal `sawUnknownFlag` marker from a resolveCore result, leaving
 * the public shape. The key must be ABSENT (not undefined-valued) so a strict
 * `toEqual` on an unambiguous resolution keeps passing.
 *
 * @param {{ verb: string|null, index: number, payloads: string[],
 *           wrapperArgs: object[], sawUnknownFlag: boolean }} r
 * @returns {{ verb: string|null, index: number, payloads: string[], wrapperArgs: object[] }}
 */
function stripCore(r) {
  return { verb: r.verb, index: r.index, payloads: r.payloads, wrapperArgs: r.wrapperArgs };
}

/**
 * The segment as resolveCore reads it: the operand token of every glued close
 * (`3>&-WORD`) is replaced by its bash argv word, so verb resolution and
 * WRAPPER_UNWRAP see WORD (#1832). Same length as `segment`, so every index
 * stays valid for callers that read the original segment.
 *
 * @param {Array<object>} segment
 * @returns {Array<object>}
 */
function argvVerbView(segment) {
  let view = null;
  for (let j = 0; j < segment.length; j++) {
    const argv = segment[j].bashArgvWord;
    if (argv === undefined) continue;
    const end = redirectSpanEnd(segment, j);
    if (end === j) continue;
    view ??= segment.slice();
    view[end] = { text: argv.text, quoted: argv.quoted };
  }
  return view ?? segment;
}

/**
 * Parse A and (for an unknown flag) parse B of one view (#1000).
 *
 * @param {Array<object>} segment
 * @param {boolean} readMarker
 * @returns {Array<object>} 1 or 2 stripped readings
 */
function flagReadings(segment, readMarker) {
  const a = resolveCore(segment, false, readMarker); // parse A — byte-identical to pre-#1000
  if (!a.sawUnknownFlag) return [stripCore(a)];
  const b = resolveCore(segment, true, readMarker); // parse B — unknown flags take a value
  if (b.verb === a.verb && b.index === a.index) return [stripCore(a)];
  return [stripCore(a), stripCore(b)];
}

/**
 * Every verb reading of a segment, de-duplicated by verb + index (#1832 G1).
 * A glued close `N>&-WORD` has two shell readings and both are judged: bash
 * closes fd N and passes WORD as argv (the argvVerbView), zsh writes to the
 * FILE `-WORD` and WORD is NOT argv (the span is dropped). `3>&-echo rm P`
 * runs `echo` in bash and `rm P` in zsh. Each view contributes its parse A
 * and, for an unknown wrapper flag, parse B (#1000).
 *
 * @param {Array<object>} segment
 * @returns {Array<{ verb: string|null, index: number, payloads: string[], wrapperArgs: object[] }>}
 */
function verbReadings(segment) {
  const readings = flagReadings(argvVerbView(segment), true);
  if (!segment.some((t) => t.bashArgvWord !== undefined)) return readings;
  for (const r of flagReadings(segment, false)) {
    if (!readings.some((o) => o.verb === r.verb && o.index === r.index)) readings.push(r);
  }
  return readings;
}

/**
 * Resolve the command verb of a segment. Public shape unchanged: the first
 * reading plus `alt` for the second when there is one. EVERY reading (both
 * flag parses × both shell readings of a glued close, #1832 G1) rides along as
 * the non-enumerable `readings` array — consumers that union readings iterate
 * it, so a third reading is never dropped; `toEqual`/JSON see the old shape.
 */
export function resolveSegmentVerb(segment) {
  const readings = verbReadings(segment);
  const out = readings.length === 1 ? { ...readings[0] } : { ...readings[0], alt: readings[1] };
  Object.defineProperty(out, 'readings', { value: readings, enumerable: false });
  return out;
}

/**
 * Shell verbs whose `-c <payload>` argument is a command line the shell will
 * execute — recursion candidates for matchSegments (#982). `su` participates
 * (`su root -c '…'`); the payload token is the one following `-c` or a bundled
 * short-flag group ending in `c` (`-lc`, `-ec`).
 */
const DASH_C_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'su']);

/**
 * Shell options that take the NEXT word as their value (`-o pipefail`,
 * `+O extglob`, `--rcfile f`, `--init-file f`). bash's only value-taking long
 * options are these two (#1797 7b: `bash --rcfile /dev/null -c '…'` read
 * `/dev/null` as the command string and allowed the payload).
 */
const SHELL_OPTIONS_WITH_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

/**
 * The command string of a `bash|sh|zsh|dash|ksh` call, or null when it runs
 * no `-c` string (Codex review C2; moved here from the destructive guard as
 * the one SSOT, #1832 point 5). With `c` anywhere in an option group (`-c`,
 * `-ce`, `-ec`, `-xc`, and the `+` forms `+c`, `+ec` — bash, zsh and sh all
 * run `+c '…'` as a command string, #1797 7c), the FIRST operand after ALL
 * options is the command string — options may follow `-c` (`bash -c -e '…'`);
 * `-o`/`+o`/`-O`/`+O`/`--rcfile`/`--init-file` consume the next word; `--` and
 * a lone `-` end the options.
 *
 * @param {Array<{ text: string }>} words - argv after the shell verb (redirect spans removed)
 * @returns {string|null}
 */
export function shellCommandString(words) {
  let hasC = false;
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    if (text === '--' || text === '-') return hasC ? (words[i + 1]?.text ?? null) : null;
    if (SHELL_OPTIONS_WITH_VALUE.has(text)) { i++; continue; }
    if (text.startsWith('--')) continue; // other long options (`--norc`, `--login`) take no value
    if (/^[-+][A-Za-z]+$/.test(text)) {
      if (text.includes('c')) hasC = true;
      continue;
    }
    return hasC ? text : null;
  }
  return null;
}

/**
 * Collect `-c`-style payload strings after the verb within a segment.
 *
 * UNION of two readings (#1832 point 5): the loose scan (any `-…c` group, the
 * next token) and, for every verb except `su` (whose `su USER -c '…'` the loose
 * scan already covers), the shell grammar of {@link shellCommandString} over the
 * redirect-free argv — `bash +c '…'`, `bash -ce '…'`, `bash -c -e '…'` and
 * `bash -c -- '…'` gave the loose scan the wrong word or none. Additive: never
 * fewer payloads than before.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {number} verbIndex
 * @param {string} verb
 * @returns {string[]}
 */
function dashCPayloads(segment, verbIndex, verb) {
  const payloads = [];
  for (let i = verbIndex + 1; i < segment.length - 1; i++) {
    if (/^-[A-Za-z]*c$/.test(segment[i].text)) payloads.push(segment[i + 1].text);
  }
  if (verb !== 'su') {
    // Both shell readings of a glued close (#1832 G1): `bash -c 3>&-x 'P'` runs
    // `x` in bash and `P` in zsh.
    for (const bash of [true, false]) {
      const payload = shellCommandString(argvWordsWithoutRedirects(segment, verbIndex + 1, { bash }));
      if (payload !== null && !payloads.includes(payload)) payloads.push(payload);
    }
  }
  return payloads;
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
 * How far a redirect token's syntax reaches: the index of the LAST token this
 * redirect owns, starting at the redirect token itself (#1002).
 *
 * The grammar rule, stated ONCE (it was coded three times independently before
 * this export existed):
 *   - `dup` (`2>&1`) carries its target INLINE in the operator token — it owns
 *     no following word.
 *   - `heredoc` (`<<EOF`) consumes its delimiter as SYNTAX inside the lexer. A
 *     terminated body arrives as a QUOTED token; an UNTERMINATED here-doc
 *     leaves real command tokens behind, which must stay visible to the caller
 *     — skipping a word here would eat the next real command (#970).
 *   - EVERY other mode — `truncate` (`>`), `append` (`>>`), `read` (`<`) and
 *     `herestring` (`<<<`) — owns the next word. `herestring` deliberately so:
 *     in `rm -rf /tmp/x <<< /etc/passwd` the word after `<<<` is inline data
 *     for the redirect, not an `rm` operand, and reading it as one would
 *     invent a deletion target the command never had.
 *   - A next token that is ITSELF a redirect is never an operand (`> >> x`):
 *     the dangling redirect owns nothing.
 *
 * This does NOT answer "does this redirect name a filesystem target" — that is
 * a SEPARATE rule, owned by collectRedirectTargets, which additionally excludes
 * `herestring` (inline data names no file). Operand OWNERSHIP and target
 * REPORTABILITY are different questions with different answers for `<<<`.
 *
 * @param {Array<{ text: string, quoted: boolean, redirect?: { mode: string } }>} segment
 * @param {number} i — index of the redirect token
 * @returns {number} `i` when the redirect owns no operand word, else `i + 1`
 */
export function redirectSpanEnd(segment, i) {
  const tok = segment[i];
  if (!tok || !tok.redirect) return i;
  const hasOperandWord = tok.redirect.mode !== 'dup' && tok.redirect.mode !== 'heredoc';
  if (hasOperandWord && i + 1 < segment.length && !segment[i + 1].redirect) {
    return i + 1;
  }
  return i;
}

/**
 * The argv words a program receives from `segment[from..]` (#1832): redirect
 * spans are dropped (redirectSpanEnd's rule) and the bash argv word of a glued
 * close (`3>&-WORD`, `bashArgvWord`) is put back where the shell passes it.
 * THE helper for every consumer that walks a verb's arguments — a consumer
 * that skips redirects by hand forgets the bash reading (Opus review census:
 * 4 of 11 `redirectSpanEnd` sites read the marker). The zsh reading (a write
 * to the FILE `-WORD`) is the redirect surface's: extractRedirectTargets.
 *
 * @param {Array<{ text: string, quoted: boolean, redirect?: object }>} segment
 * @param {number} [from]
 * @param {{ bash?: boolean }} [view] — `{ bash: false }` reads the zsh view
 * @returns {Array<{ text: string, quoted: boolean }>}
 */
export function argvWordsWithoutRedirects(segment, from = 0, { bash = true } = {}) {
  const words = [];
  for (let i = from; i < segment.length; i++) {
    const tok = segment[i];
    if (tok.redirect) {
      // `bash: false` is the zsh view (#1832 G1): the glued close's whole span
      // is a write to the FILE `-WORD`, no argv word comes back.
      const argv = bash ? tok.bashArgvWord : undefined;
      i = redirectSpanEnd(segment, i);
      if (argv !== undefined) words.push(argv);
      continue;
    }
    words.push(tok);
  }
  return words;
}

/**
 * A quoted token whose text holds one of these characters can never equal a
 * single pattern word (pattern words contain none of the boundary characters).
 */
const QUOTED_NON_WORD_RE = /[\s;|&(){}`'"]/;

/**
 * Test whether a blocked pattern occurs OUTSIDE quoted tokens within a segment.
 * Reconstructs the skeleton of the argv the program receives and applies the
 * boundary regex.
 *
 * Quoted tokens: a quoted token is ONE argv word. When its text is a single
 * plain word (`"reset"`, `re"set"`, `"-rf"`) the program receives exactly
 * what an unquoted word gives it, so the text enters the skeleton (#1830 —
 * `git "reset" --hard` was ALLOWED). A quoted token holding whitespace or a
 * boundary character stays a space placeholder: one argv word can never equal
 * a multi-word pattern, and the placeholder keeps it from bridging an
 * adjacent-token match — that is what keeps `git commit -m "git reset --hard
 * is bad"` and `echo "rm -rf x"` inert here (their quoted payloads are judged
 * by quotedTokensMatch, interpreter verbs only).
 *
 * Redirect tokens (#983) and their operand word are DROPPED entirely: the
 * shell removes them before the program starts, so `git >/dev/null reset
 * --hard` runs `git reset --hard` (#1830 — the old space placeholders left
 * `git   reset --hard` and the single-space pattern missed). The redirect
 * target still never enters the skeleton: `rm -rf /tmp/ok > out.log` feeds
 * neither `>` nor `out.log`. The operand span is redirectSpanEnd's rule
 * (`dup`/`heredoc` own no word).
 *
 * @param {Array<{ text: string, quoted: boolean, redirect?: object }>} segment
 * @param {RegExp} re
 * @returns {boolean}
 */
function unquotedSegmentMatch(segment, re) {
  // Redirects and their operand leave no trace (#1830); the bash argv word of
  // a glued close comes back (#1832) — argvWordsWithoutRedirects owns both.
  // Both shell readings are judged (#1832 G1): `git 3>&-x reset --hard` is
  // `git x reset --hard` in bash but `git reset --hard` in zsh.
  const views = segment.some((t) => t.bashArgvWord !== undefined) ? [true, false] : [true];
  for (const bash of views) {
    const parts = [];
    for (const tok of argvWordsWithoutRedirects(segment, 0, { bash })) {
      if (tok.quoted) {
        parts.push(tok.text !== '' && !QUOTED_NON_WORD_RE.test(tok.text) ? tok.text : ' ');
        continue;
      }
      parts.push(tok.text);
    }
    if (re.test(parts.join(' '))) return true;
  }
  return false;
}

/**
 * Payload-recursion bounds (#982). Depth counts nested payload evaluations
 * (top-level command = depth 0); the budget caps TOTAL payload evaluations per
 * commandMatchesBlocked call so a hostile deeply-chained command cannot turn
 * the hook hot-path into an amplification vector.
 */
const MAX_PAYLOAD_DEPTH = 3;
const MAX_PAYLOAD_EVALUATIONS = 32;

/**
 * Build the DE-DUPLICATED payload set for a segment: the UNION of the primary
 * reading's payloads and the ambiguous alt reading's payloads (#1000).
 *
 * The dual-parse union MUST be de-duped BEFORE budget accounting so an ambiguous
 * segment is charged against the shared MAX_PAYLOAD_EVALUATIONS budget ONCE per
 * DISTINCT payload — never the (primary + alt) sum (HIGH-1 remediation (a)). The
 * pre-#1000 zero-charge for a non-interpreter primary verb is preserved
 * naturally: when the alt reading adds no new distinct payload the set stays
 * empty and no budget is consumed.
 *
 * Both matchSegments AND collectRedirectTargets consume this single helper so the
 * union is applied IDENTICALLY on the match surface and the redirect surface. A
 * redirect-recursion that walked parse A only was a denylist bypass
 * (`env -Q x bash -c 'echo pwned > CLAUDE.md'` resolved to non-interpreter `x` in
 * parse A, so its redirect target was never collected — HIGH-2).
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {{ verb: string|null, index: number, payloads: string[],
 *           alt?: { verb: string|null, index: number, payloads: string[] } }} resolved
 * @returns {string[]} distinct payload strings (insertion-ordered)
 */
/** All readings of a resolveSegmentVerb result (`readings`, else primary + alt). */
const readingsOf = (resolved) => resolved.readings ?? (resolved.alt ? [resolved, resolved.alt] : [resolved]);

function dedupedSegmentPayloads(segment, resolved) {
  const payloadSet = new Set();
  // Every reading (both flag parses × both shell readings, #1832 G1).
  for (const reading of readingsOf(resolved)) {
    for (const p of reading.payloads) payloadSet.add(p);
    if (reading.verb && DASH_C_SHELLS.has(reading.verb)) {
      for (const p of dashCPayloads(segment, reading.index, reading.verb)) payloadSet.add(p);
    }
    addArgJoinedPayload(segment, reading.verb, reading.index, payloadSet);
  }
  return [...payloadSet];
}

/**
 * Interpreters that JOIN their remaining arguments with a space and execute the
 * result — no `-c` flag, no wrapper option to key on (#1366).
 *
 * `eval` is the whole set today. It was already in SHELL_EXEC_INTERPRETERS, but
 * that set only powers the QUOTED-TOKEN match in matchSegments — it never fed
 * the payload traversal, so `eval 'echo x > CLAUDE.md'` carried a redirect no
 * redirect rule ever saw (`resolveSegmentVerb` reports `payloads: []` for it).
 *
 * NAMED CEILING (BV-004): only a LITERAL payload is reachable. `eval "$CMD"` and
 * `eval $(…)` do not exist as command text at hook time and stay in the existing
 * `unresolved` class (#641). REVISIT TRIGGER: a second arg-joining interpreter
 * showing up in a transcript census — extend the set, never special-case `eval`.
 */
const ARG_JOINING_INTERPRETERS = new Set(['eval']);

/**
 * Add the joined post-verb argument text as a recursion payload when `verb` is
 * an arg-joining interpreter. No-op otherwise — every other caller shape keeps
 * the pre-#1366 payload set byte-identical.
 *
 * Quoting is not re-applied for the same reason as the `env -S` tail (see
 * resolveCore): the tokenizer stripped it, and a wider payload can only make
 * more text visible to the matcher, never hide an operator.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {string|null} verb
 * @param {number} index — the verb's token index (`-1` when unresolved)
 * @param {Set<string>} payloadSet — mutated in place
 */
function addArgJoinedPayload(segment, verb, index, payloadSet) {
  if (!verb || index < 0 || !ARG_JOINING_INTERPRETERS.has(verb)) return;
  // A redirect belongs to the SEGMENT (`eval 'x' > f` redirects eval's own
  // stdout), never to the joined argv — the segment scan already reported it.
  // The bash argv word of a glued close IS argv (`eval 3>&-rm P`, #1832).
  // Both shell readings (#1832 G1): `eval >&-z 'rm P'` evaluates `z rm P` in
  // bash and `rm P` in zsh.
  for (const bash of [true, false]) {
    const joined = argvWordsWithoutRedirects(segment, index + 1, { bash }).map((t) => t.text).join(' ').trim();
    if (joined.length > 0) payloadSet.add(joined);
  }
}

/**
 * git global options that take their value as the NEXT word (#1831). Mirrors
 * GIT_OPTIONS_WITH_VALUE + `-C` + the bare `--git-dir`/`--work-tree` forms of
 * gitGlobals in hooks/pre-bash-destructive-guard.mjs (the SSOT) — duplicated,
 * not imported, so this module needs nothing from the hook. Every other
 * leading `-…` word is a value-less global (`--no-pager`, `--bare`, `-p`,
 * `--exec-path`, `--config-env=…`, `--git-dir=…`).
 */
const GIT_GLOBALS_WITH_VALUE = new Set(['-C', '-c', '--namespace', '--config-env', '--attr-source', '--git-dir', '--work-tree']);

/**
 * Long spellings of a short flag, per subcommand (#1831): `git clean --force`
 * is `-f`, `git push --force` is `-f`. `-d`/`-x` of clean have no long form.
 */
const GIT_SHORT_LONG_ALIASES = { clean: { f: '--force' }, push: { f: '--force' } };

/**
 * Parse a `git <sub> <flag…>` pattern into its argv-match spec (#1831), or
 * null for every other pattern (`rm -rf` has its own delete logic, `DROP
 * TABLE` stays literal).
 *
 * @param {string[]} words — the pattern split on spaces
 * @returns {{ sub: string, flags: string[] } | null}
 */
function gitPatternSpec(words) {
  if (words.length < 2 || words[0] !== 'git' || words[1].startsWith('-')) return null;
  const flags = words.slice(2);
  if (!flags.every((f) => f.startsWith('-'))) return null;
  return { sub: words[1], flags };
}

/**
 * Does the argument `arg` spell the long option `name` the way git's option
 * parser accepts it (#1831)? Full name, or ANY prefix with at least one
 * character after `--`: git takes every unique prefix (Opus review against
 * real git, 2026-10-27: `git reset --h`, `git clean --f -d`, `git checkout
 * --q -- a` all exit 0 and act). A `=value` suffix is cut first, so
 * `--force-with-lease=main` spells `--force-with-lease` and never `--force`.
 * NAMED CEILING (BV-004): an ambiguous prefix (`git push --fo`, exit 129)
 * matches every name it prefixes — git rejects it, so the over-match is a
 * harmless deny. REVISIT TRIGGER: an fp-measure replay showing a real command
 * denied by that rule.
 */
function spellsLongOption(arg, name) {
  if (!arg.startsWith('--') || arg === '--') return false;
  const given = arg.split('=')[0];
  if (given === name) return true;
  return given.length >= 3 && name.startsWith(given);
}

/**
 * May `word` stand between `checkout` and `--` in the form PSA-003 names,
 * `git checkout -- <file>` (#1831 coordinator decision, HR-101)? Only the
 * quiet/force options: `-q`, `-f`, a group of those letters, `--quiet`,
 * `--force` and their abbreviations, and `--end-of-options` (review H2:
 * `git checkout --end-of-options -- a` exits 0 and discards). NAMED CEILING (BV-004): `git checkout
 * <ref> -- <path>`, `--ours`/`--theirs`/`-m`/`--merge`/`-p` before `--`, and
 * `git restore` (same effect) are NOT judged by the argv match — the replay
 * counted 175 + 6 such real commands per 30 days, and blocking `checkout <ref>
 * --` without `restore --source` would be incoherent. REVISIT TRIGGER: the
 * #1831 follow-up policy issue on ref-sourced discards.
 *
 * @param {string} word
 * @returns {boolean}
 */
function isPlainCheckoutOption(word) {
  if (/^-[qf]+$/.test(word) || word === '--end-of-options') return true;
  return spellsLongOption(word, '--quiet') || spellsLongOption(word, '--force');
}

/**
 * Is a `git clean` call a dry run (#1831 review M1)? `-n` in any short group
 * or a `--dry-run` spelling turns it on, a `--no-dry-run` spelling off; the
 * last one wins, as in git's option parser. The value of `-e`/`--exclude` is
 * skipped — in `-enode` or `-e -n` the `n` is an exclude pattern, not a dry
 * run, and reading it as one would open a hole.
 *
 * @param {string[]} flagWords — the words after `clean` up to a bare `--`
 * @returns {boolean}
 */
function isCleanDryRun(flagWords) {
  let dry = false;
  for (let i = 0; i < flagWords.length; i++) {
    const w = flagWords[i];
    if (/^-[^-]/.test(w)) {
      const group = w.slice(1);
      const e = group.indexOf('e');
      if (group.slice(0, e === -1 ? undefined : e).includes('n')) dry = true;
      if (e === group.length - 1) i++; // `-e PATTERN`: the next word is the value
      continue;
    }
    if (spellsLongOption(w, '--exclude')) {
      if (!w.includes('=')) i++;
      continue;
    }
    if (spellsLongOption(w, '--dry-run')) dry = true;
    else if (spellsLongOption(w, '--no-dry-run')) dry = false;
  }
  return dry;
}

/**
 * Do the words after `git` carry the pattern's subcommand and every pattern
 * flag in an equivalent spelling (#1831)? Short flags are judged as the UNION
 * of letters over all short groups (`-fdx`, `-xfd`, `-f -d`); a long flag
 * anywhere after the subcommand counts (`git reset HEAD~1 --hard`); a `+`
 * refspec of `git push` is a force push. Flag scanning stops at a bare `--`
 * (after it every word is a pathspec/refspec) except for the `checkout --`
 * pattern itself and for `+` refspecs, which stay refspecs behind `--`.
 * A `git clean` dry run (`-n`, `--dry-run`, last spelling wins against
 * `--no-dry-run`) only prints "Would remove" and never matches (review M1).
 * NAMED CEILINGS (BV-004), all over-matches (a deny, the safe side) unless
 * noted: values of per-subcommand value options are not skipped (`git clean
 * -e -f`, `git push -o -f…`); `--no-force` after `--force` is not undone;
 * `git push --end-of-options --force` still counts `--force`; and git
 * aliases are NOT judged — neither `git config alias.x 'clean -fdx'` nor one
 * defined in the command itself (`git -c alias.zz='reset --hard' zz`, an
 * under-match). REVISIT TRIGGER: a transcript census hit of `-c alias.` or
 * of an alias-run destructive command.
 *
 * @param {string[]} words — argv texts after the `git` verb
 * @param {{ sub: string, flags: string[] }} spec
 * @returns {boolean}
 */
function gitWordsMatch(words, spec) {
  let i = 0;
  for (; i < words.length && words[i].startsWith('-'); i++) {
    if (GIT_GLOBALS_WITH_VALUE.has(words[i])) i++;
  }
  if (words[i] !== spec.sub) return false;
  const after = words.slice(i + 1);
  const end = after.indexOf('--');
  const flagWords = end === -1 ? after : after.slice(0, end);
  const longs = flagWords.filter((w) => w.startsWith('--'));
  const letters = new Set(
    flagWords.filter((w) => /^-[^-]/.test(w)).flatMap((w) => [...w.slice(1)]),
  );
  if (spec.sub === 'clean' && isCleanDryRun(flagWords)) return false;
  const plusRefspec = spec.sub === 'push' && after.some((w) => w.length > 1 && w.startsWith('+'));
  const aliases = GIT_SHORT_LONG_ALIASES[spec.sub] ?? {};
  return spec.flags.every((flag) => {
    if (flag === '--') return end !== -1 && after.slice(0, end).every(isPlainCheckoutOption);
    if (flag.startsWith('--')) {
      if (plusRefspec && flag === '--force') return true;
      return longs.some((w) => spellsLongOption(w, flag));
    }
    return [...flag.slice(1)].every((l) => {
      if (letters.has(l)) return true;
      if (plusRefspec && l === 'f') return true;
      return aliases[l] !== undefined && longs.some((w) => spellsLongOption(w, aliases[l]));
    });
  });
}

/**
 * The argv match of a `git` pattern on one segment (#1831): every reading
 * whose verb is `git` (readingsOf — both flag parses × both shell readings of
 * a glued close, #1832 G1), its words in BOTH views of argvWordsWithoutRedirects.
 * Purely additive to unquotedSegmentMatch: it can only add matches.
 *
 * @param {Array<object>} segment
 * @param {object} resolved — resolveSegmentVerb(segment)
 * @param {{ sub: string, flags: string[] }} spec
 * @returns {boolean}
 */
function gitArgvMatch(segment, resolved, spec) {
  for (const reading of readingsOf(resolved)) {
    if (reading.verb !== 'git' || reading.index < 0) continue;
    for (const bash of [true, false]) {
      const words = argvWordsWithoutRedirects(segment, reading.index + 1, { bash }).map((t) => t.text);
      if (gitWordsMatch(words, spec)) return true;
    }
  }
  return false;
}

/**
 * Match a blocked-pattern regex against tokenized chain segments — the shared
 * core of commandMatchesBlocked, recursion-capable for `-c` payloads (#982).
 *
 * Per segment, in order:
 *   1) Unquoted occurrence → match.
 *   2) Quoted occurrence + interpreter verb (after wrapper unwrap) → match.
 *   3) ADDITIVE payload recursion: when the resolved verb is a `-c`-taking
 *      shell (or a wrapper collected a command-string payload, `env -S`),
 *      re-tokenize each payload and match it recursively. Strictly additive —
 *      never replaces check 2 (removing 2 would LOOSEN quoted-containment
 *      cases like `bash -c 'echo "rm -rf is dangerous"'`).
 *
 * @param {Array<Array<{ text: string, quoted: boolean }>>} segments
 * @param {RegExp} re
 * @param {number} depth — current payload-nesting depth (entry check < MAX)
 * @param {{ remaining: number }} budget — shared across the whole recursion
 * @param {{ sub: string, flags: string[] } | null} [git] — gitPatternSpec of the
 *   pattern; null for a non-git pattern (#1831)
 * @returns {boolean}
 */
function matchSegments(segments, re, depth, budget, git = null) {
  for (const segment of segments) {
    // 1) Unquoted occurrence anywhere in the segment → always a match.
    if (unquotedSegmentMatch(segment, re)) return true;

    const resolved = resolveSegmentVerb(segment);

    // 1b) The argv match of a git pattern (#1831): equivalent flag spellings
    //     (`-fdx`, `--force`, `--forc`, `+main`, flags after operands)
    //     the literal word sequence misses. Union only — never fewer matches.
    if (git && gitArgvMatch(segment, resolved, git)) return true;

    // 2) Quoted occurrence → only a match when the segment verb is an interpreter
    //    that executes its quoted payload. EITHER reading of an ambiguous
    //    unknown flag counts (#1000): `env -Q x bash -c 'rm -rf /etc'` resolves
    //    to the non-interpreter `x` in parse A and to `bash` in parse B.
    if (quotedTokensMatch(segment, re)) {
      const isInterp = (v) => Boolean(v) && SHELL_EXEC_INTERPRETERS.has(v);
      if (readingsOf(resolved).some((r) => isInterp(r.verb))) return true;
      // else: inert literal inside quotes for a non-interpreter verb → no match
      // for THIS segment; keep scanning other segments.
    }

    // 3) `-c`/`env -S` payload recursion (depth-capped, budgeted). The payload
    //    set is the de-duplicated UNION over both readings (dedupedSegmentPayloads)
    //    so an ambiguous segment cannot double-charge the shared evaluation budget.
    if (depth < MAX_PAYLOAD_DEPTH) {
      for (const payload of dedupedSegmentPayloads(segment, resolved)) {
        // FAIL-VISIBLE cut-off (HIGH-1 remediation (b)). A silent `break` here
        // was fail-OPEN: an attacker prepends 32 inert `env -Q x sh -c 'echo N'`
        // filler segments — each charging one alt-reading payload against the
        // shared 32-eval budget (#1000) — then the real deny-capable payload
        // (`env -S 'rm -rf /'`) arrives with budget exhausted and the old `break`
        // returned false → ALLOW (coordinator-measured deny-loss vs 1be450a).
        // This matcher returns a boolean with no unresolved channel, so an
        // UNJUDGED deny-capable payload is treated as a MATCH (fail-closed),
        // mirroring collectRedirectTargets' budget-exhausted marker (#988 T2).
        // A realistic benign command never approaches the budget (depth-capped
        // at 3); only pathological width reaches exhaustion, and denying a
        // command that also carries a blocked pattern in the raw string is the
        // safe direction.
        if (budget.remaining <= 0) return true;
        budget.remaining -= 1;
        const subTokens = tokenizeCommand(
          normalizeShellWhitespaceExpansions(payload, { expandSingleQuoted: true }),
        );
        if (matchSegments(splitSegments(subTokens), re, depth + 1, budget, git)) return true;
      }
    }
  }
  return false;
}

/**
 * Recursive collector behind extractRedirectTargets (#983). Walks each
 * segment's redirect tokens, then re-tokenizes `-c` / `env -S` payloads with
 * the same depth/budget caps matchSegments uses.
 *
 * @param {Array<Array<{ text: string, quoted: boolean, redirect?: object }>>} segments
 * @param {Array<object>} out — accumulator
 * @param {number} depth
 * @param {{ remaining: number }} budget
 */
function collectRedirectTargets(segments, out, depth, budget) {
  for (const segment of segments) {
    for (let i = 0; i < segment.length; i++) {
      const tok = segment[i];
      if (!tok.redirect) continue;
      const { fd, mode } = tok.redirect;
      // Deliberate boundary: only file-operand modes are reported. `dup`
      // (`2>&1`) targets a file descriptor, `heredoc`/`herestring` operands
      // are inline data/delimiters — none names a filesystem target.
      // NOTE: this mode filter is a SEPARATE rule from operand ownership
      // (redirectSpanEnd) — `herestring` OWNS its next word but names no file,
      // so it is excluded here and included there. Do not merge the two.
      if (mode === 'dup' || mode === 'heredoc' || mode === 'herestring') continue;
      // Past the filter `hasOperandWord` is unconditionally true, so the shared
      // span rule reduces to the old inline predicate (#1002).
      const end = redirectSpanEnd(segment, i);
      const operand = end > i ? segment[end] : null;
      if (operand) i = end; // operand word belongs to this redirect
      if (!operand || /[$`]/.test(operand.text)) {
        // Variable indirection (`> "$X"`), command substitution (`> $(cmd)` /
        // backticks), or a missing operand: fail-visible, never guess (#983).
        out.push({ target: null, mode, fd, unresolved: true });
        continue;
      }
      // A glued group-closing `}` (`{echo x >CLAUDE.md}`) — both readings are
      // judged (#1707 point 1, see gluedCloseReadings).
      for (const text of [operand.text, ...(operand.closeReadings ?? [])]) {
        out.push({ target: text, mode, fd });
      }
    }

    const resolved = resolveSegmentVerb(segment);

    // A wrapper can truncate a file WITHOUT any redirect operator and without
    // being the verb: `/usr/bin/time -o CLAUDE.md npm test` empties CLAUDE.md
    // while the verb is `npm` (BSD time(1): "If file exists and the -a flag is
    // not specified, the file will be overwritten"). Measured pre-#992 against
    // the real 14-rule policy: `> CLAUDE.md` DENY, `/usr/bin/time -o CLAUDE.md
    // npm test` ALLOW. `writesFile` — never the bare `argFlags` membership — is
    // the discriminator: `stdbuf -o 0`, `nice -n 10`, `sudo -u root` all carry
    // an argFlag operand that is NOT a file, and all three stay unreported.
    //
    // Mode is `truncate` unconditionally, including under `time -a` (append).
    // Deliberate, safe-direction over-report: reading `-a` would mean tracking
    // the wrapper's BOOLEAN flags too — widening the contract a sibling guard
    // consumes — to buy back a false-positive class that is empty in practice
    // (nobody appends a timing report to a policy-protected file). An
    // under-report here is a bypass; this over-report is a nuisance at worst.
    //
    // Both readings of an ambiguous unknown flag contribute (#1000), UNIONED
    // and never replaced: `env -Q x /usr/bin/time -o CLAUDE.md npm test` hides
    // the operand from parse A (which reads `x` as the verb) and surfaces it in
    // parse B, while `sudo -n /usr/bin/time -o report.txt npm test` is the
    // mirror case — parse B swallows `/usr/bin/time` as `-n`'s operand and
    // reports nothing. Replacement would lose one of the two.
    const seenWrapperTargets = new Set();
    for (const wa of readingsOf(resolved).flatMap((r) => r.wrapperArgs)) {
      if (wa.writesFile !== true) continue;
      if (typeof wa.value !== 'string') continue;
      // De-dup key is the OPERAND plus the mode, which for a resolved entry is
      // exactly `target + ':' + mode`; using the operand keeps two distinct
      // unresolved spellings (`"$OUT"` vs `"$X"`) distinct rather than
      // collapsing them onto a shared `null` target.
      const key = `${wa.value}:truncate`;
      if (seenWrapperTargets.has(key)) continue;
      seenWrapperTargets.add(key);
      if (/[$`]/.test(wa.value)) {
        // Same fail-visible rule as a redirect operand (#983): never guess at a
        // variable or a command substitution, but never silently drop it either.
        out.push({ target: null, mode: 'truncate', fd: null, unresolved: true });
        continue;
      }
      out.push({ target: wa.value, mode: 'truncate', fd: null });
    }

    // A VERB can name its write target as a bare operand, with no redirect
    // operator and no wrapper flag: `dd of=CLAUDE.md` truncates CLAUDE.md while
    // `> CLAUDE.md` is denied (measured ALLOW pre-#1366 against the real
    // policy). Keyed on the RESOLVED verb, so `sudo dd of=X` is reached through
    // the existing wrapper unwrap; both readings contribute, as above.
    const seenVerbOperands = new Set();
    for (const reading of readingsOf(resolved)) {
      const spec = reading.verb ? VERB_FILE_OPERANDS.get(reading.verb) : null;
      if (!spec || reading.index < 0) continue;
      let operand = null;
      let append = false;
      for (let k = reading.index + 1; k < segment.length; k++) {
        const text = segment[k].text;
        if (segment[k].redirect) continue;
        if (text.startsWith(spec.prefix)) operand = text.slice(spec.prefix.length);
        else if (spec.appendRe?.test(text)) append = true;
      }
      if (operand === null || operand.length === 0) continue;
      const mode = append ? 'append' : spec.mode;
      const key = `${operand}:${mode}`;
      if (seenVerbOperands.has(key)) continue;
      seenVerbOperands.add(key);
      if (/[$`]/.test(operand)) {
        // Same fail-visible rule as a redirect operand (#983) — never guess at a
        // variable or a command substitution, never silently drop it either.
        out.push({ target: null, mode, fd: null, unresolved: true });
        continue;
      }
      out.push({ target: operand, mode, fd: null });
    }

    // Both readings of an ambiguous unknown flag contribute payloads (#1000),
    // UNIONED and de-duped (HIGH-2). Walking parse A only let
    // `env -Q x bash -c 'echo pwned > CLAUDE.md'` — which resolves to the
    // non-interpreter `x` in parse A — bypass the redirect denylist entirely
    // (coordinator-measured: `bash -c '… > CLAUDE.md'` DENY, `env -Q x bash -c
    // '… > CLAUDE.md'` ALLOW). The same helper matchSegments uses guarantees the
    // deduped-before-charging rule holds on this surface too, so the redirect
    // recursion cannot be starved any differently than the match recursion.
    const payloads = dedupedSegmentPayloads(segment, resolved);
    if (payloads.length === 0) continue;

    // A cap that drops payloads SILENTLY is a bypass, not a cap: 33 filler
    // `-c` segments exhausted the budget and `> CLAUDE.md` in the 34th came
    // back as an EMPTY target list, so the guard saw nothing (#988 T2,
    // probe-measured). Both cut-offs now emit an unresolved marker — the
    // DoS ceiling is unchanged, its effect is merely visible.
    if (depth >= MAX_PAYLOAD_DEPTH) {
      out.push({ target: null, mode: null, fd: null, unresolved: true, reason: 'depth-exceeded' });
      continue;
    }
    for (const payload of payloads) {
      if (budget.remaining <= 0) {
        out.push({ target: null, mode: null, fd: null, unresolved: true, reason: 'budget-exhausted' });
        break;
      }
      budget.remaining -= 1;
      const subTokens = tokenizeCommand(
        normalizeShellWhitespaceExpansions(payload, { expandSingleQuoted: true }),
      );
      collectRedirectTargets(splitSegments(subTokens), out, depth + 1, budget);
    }
  }
}

/**
 * Extract every filesystem redirect target from a command string (#983).
 *
 * Traverses all chain segments AND (read-only, via the existing payload
 * mechanics) every `-c` / `env -S` shell payload, depth-capped at
 * MAX_PAYLOAD_DEPTH with the shared MAX_PAYLOAD_EVALUATIONS budget.
 *
 * Entry shapes:
 *   - `{ target: string, mode: 'truncate'|'append'|'read', fd: number|null }`
 *     — resolved target; quoted targets are reported WITHOUT their quotes
 *     (the tokenizer strips them).
 *   - `{ target: null, mode, fd, unresolved: true }` — the operand contains a
 *     variable (`> "$X"`), a command substitution, or is missing. Reported
 *     fail-visible so the consuming guard can LOG it; deliberately NOT a
 *     match candidate for redirectRuleMatches (see there — #641 FP class).
 *   - `{ target: null, mode: null, fd: null, unresolved: true,
 *      reason: 'budget-exhausted'|'depth-exceeded' }` — a payload subtree was
 *     NOT traversed because a recursion cap cut it off (#988 T2). `mode` is
 *     null: no redirect was parsed, so the entry belongs to no mode class and
 *     a mode filter must not silently drop it.
 *
 * `dup` (`2>&1`), `heredoc` (`<<`), and `herestring` (`<<<`) redirects name
 * no filesystem target and are omitted (deliberate boundary, documented).
 *
 * WIDENED CONTRACT (#992): the traversal ALSO reports wrapper file operands —
 * `resolveSegmentVerb` entries carrying `writesFile: true`, i.e. today
 * `/usr/bin/time -o FILE` / `--output=FILE`. Such a write has no redirect
 * operator at all, so the pre-#992 traversal saw nothing and
 * `/usr/bin/time -o CLAUDE.md npm test` truncated a denylisted file while
 * `> CLAUDE.md` was blocked. They are emitted as `mode: 'truncate'`, `fd: null`
 * — indistinguishable from a `>` entry by design, because the EFFECT on the
 * named file is indistinguishable.
 *
 * @param {string} command
 * @returns {Array<{ target: string|null, mode: string|null, fd: number|null,
 *                   unresolved?: boolean, reason?: string }>}
 */
export function extractRedirectTargets(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const out = [];
  const segments = splitSegments(tokenizeCommand(normalizeShellWhitespaceExpansions(command)));
  collectRedirectTargets(segments, out, 0, { remaining: MAX_PAYLOAD_EVALUATIONS });
  return out;
}

/**
 * Minimal glob-to-RegExp for redirect target-denylist matching (#983).
 * Same shape as the picomatch-absent fallback in scripts/lib/rule-loader.mjs
 * (`**` = any path segments, `*` = within-segment, `?` = single char) —
 * duplicated locally because this module is hook-hot-path pure (no imports
 * beyond node built-ins, no I/O at import time; see header invariant).
 *
 * CASE-INSENSITIVE (#994 R2): the returned RegExp carries the `i` flag
 * UNCONDITIONALLY — no platform detection. Detection is unsafe in both
 * directions (macOS can run case-sensitive APFS; Linux can mount
 * case-insensitive volumes via ext4 casefold / ciopfs / CIFS), and a correct
 * per-path answer would need filesystem I/O this module forbids (header
 * invariant). The cost is asymmetric: a MISS truncates CLAUDE.md
 * unrecoverably, whereas an over-block is a visible deny with two escapes
 * (`>>`, the Write tool). So `> claude.md` / `> Claude.md` — the same inode as
 * `CLAUDE.md` on a case-insensitive volume — deny like the canonical spelling.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function redirectGlobToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (p[i] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '.') {
      re += '\\.';
      i++;
    } else {
      re += c.replace(/[$()+[\]^{|}]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Collapse the macOS same-inode path aliases so one location has one spelling.
 *
 * Two independent alias classes, applied in order:
 *   1. `/System/Volumes/Data/...` — the firmlink onto the Data volume: on APFS
 *      `/System/Volumes/Data/repo` and `/repo` are the SAME inode. Stripped
 *      FIRST so a `/System/Volumes/Data/private/tmp/...` spelling then also runs
 *      through the `/private` strip below.
 *   2. `/private/{tmp,var,etc}/...` — the short forms `/tmp`, `/var`, `/etc` are
 *      symlinks into `/private`. Without this, a repo checked out under
 *      `/tmp/...` (CI runners, worktrees) would not recognise its own root in a
 *      command that spells it `/private/tmp/...`.
 *
 * A strip that would empty the path (`/System/Volumes/Data` itself) is guarded
 * with `|| '/'` so the result stays an absolute path.
 *
 * Deliberately STATIC: no `realpathSync` on user input. Resolving an
 * attacker-supplied path at guard time is its own risk class, and this module
 * is I/O-free by header invariant. Only the known aliases collapse; every other
 * path is returned byte-identical.
 *
 * @param {string} p — an absolute, already-normalized path
 * @returns {string}
 */
function stripPathAliases(p) {
  const dataStripped =
    (/^\/System\/Volumes\/Data(?:\/|$)/.test(p) ? p.slice('/System/Volumes/Data'.length) : p) ||
    '/';
  return /^\/private\/(?:tmp|var|etc)(?:\/|$)/.test(dataStripped)
    ? dataStripped.slice('/private'.length) || '/'
    : dataStripped;
}

/**
 * Expand a LEADING `~` / `~/` in a redirect target to the operator's home dir —
 * the shell substitution the hook never gets to see, because a PreToolUse gate
 * receives the raw, UNEXPANDED command string. Same motivation as
 * `expandTmpdirToken` in hooks/pre-bash-destructive-guard.mjs (which does the
 * `$TMPDIR` half for rm operands); deliberately NOT merged with it — that one
 * expands an env VAR reference for the rm-allowlist, this one expands the
 * tilde WORD for the redirect denylist, and folding two token grammars into one
 * expander would widen both.
 *
 * `~user/...` is left untouched: another account's home is not this repo.
 *
 * Tilde expansion is applied REGARDLESS of the operand's quoting. A fully
 * quoted `> "~/x/CLAUDE.md"` is a literal `~` directory in the real shell, so
 * matching it is a (harmless, safe-direction) over-block; the partially quoted
 * `> ~/"My Docs"/CLAUDE.md` — which the tokenizer also reports as quoted, and
 * which the shell DOES expand — would otherwise be a real bypass.
 *
 * @param {string} target
 * @param {string|undefined} home
 * @returns {string}
 */
function expandLeadingHome(target, home) {
  if (target !== '~' && !target.startsWith('~/')) return target;
  if (!home || !path.isAbsolute(home)) return target;
  return home + target.slice(1);
}

/**
 * Relativize an ABSOLUTE target against an absolute repoRoot to the repo-relative
 * POSIX form the denylist globs use, or `null` when the target names the root
 * itself or lies outside it.
 *
 * Both paths are alias-collapsed (`stripPathAliases`) and case-folded before the
 * containment comparison (#994 R3): a case-insensitive volume makes `/REPO` and
 * `/repo` the same directory, so the comparison that decides in-vs-out must fold
 * too — otherwise an absolute spelling in the wrong case escapes the root and is
 * silently allowed. Folding uses `toLocaleLowerCase('en-US')` explicitly (same
 * rationale as scripts/lib/path-utils.mjs:46 — avoids the Turkish-İ divergence a
 * locale-default `toLowerCase` carries). The returned path is therefore
 * lowercased; it is matched against the denylist regexes, which carry the `i`
 * flag (#994 R2), so the fold and the match agree.
 *
 * Shared by BOTH branches of `repoRelativeRedirectTarget` (absolute + relative)
 * so the two can never drift again (#994 R1 structural fix).
 *
 * @param {string} absTarget — absolute, resolved target path
 * @param {string} repoRoot — absolute repo root
 * @returns {string|null}
 */
function relativizeAgainstRoot(absTarget, repoRoot) {
  const fold = (p) => p.toLocaleLowerCase('en-US');
  const rel = path.relative(
    fold(stripPathAliases(path.normalize(repoRoot))),
    fold(stripPathAliases(path.normalize(absTarget))),
  );
  // '' = the root itself (a directory, not a file target); '..'-prefixed or
  // absolute = outside the repo, which the repo-relative denylist never covers.
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return path.posix.normalize(rel).replace(/^(\.\/)+/, '');
}

/**
 * Reduce a raw redirect target to the repo-relative POSIX form the denylist
 * globs are written in, or `null` when it cannot name a file inside the repo.
 *
 * A RELATIVE target (#994 R1) is interpreted as REPO-ROOT-relative, not
 * shell-cwd-relative: after lexical normalization, a target that stays inside
 * the root (no leading `..`) is already the repo-relative form and returned
 * as-is; a target that climbs out (`../repo/CLAUDE.md`, `./a/../../repo/…`) is
 * resolved against `repoRoot` and re-relativized through the SAME
 * `relativizeAgainstRoot` the absolute branch uses. Without a usable `repoRoot`
 * the pre-#994 lexical form is returned verbatim — byte-identical for
 * optionless callers.
 *
 * @param {string} raw — resolved target text (quotes already stripped)
 * @param {string|null} repoRoot — absolute repo root, or null (no resolution)
 * @param {string|undefined} home
 * @returns {string|null}
 */
function repoRelativeRedirectTarget(raw, repoRoot, home) {
  const expanded = expandLeadingHome(raw, home);

  if (!path.isAbsolute(expanded)) {
    const lexical = path.posix.normalize(expanded).replace(/^(\.\/)+/, '');
    // Post-normalization, a leading `..` is the ONLY way a relative target
    // leaves the root; anything else is already the repo-relative form (this
    // also preserves the `~other/...` another-account spelling untouched).
    if (!lexical.startsWith('../')) return lexical;
    // A relative target that climbs out — resolve it against repoRoot. Without a
    // usable root, return the pre-#994 lexical form (byte-identical contract).
    if (!repoRoot || !path.isAbsolute(repoRoot)) return lexical;
    return relativizeAgainstRoot(path.resolve(repoRoot, expanded), repoRoot);
  }
  // Absolute target: only judgeable against a known repo root. Without one the
  // pre-#988 behaviour stands (no match) rather than a guess.
  if (!repoRoot || !path.isAbsolute(repoRoot)) return null;
  return relativizeAgainstRoot(expanded, repoRoot);
}

/**
 * Match a `redirect-truncate` policy rule against a command (#983).
 *
 * For every extractRedirectTargets entry whose mode is in `rule.modes`
 * (default `['truncate']` — `truncate` covers `>`, `>|`, `&>`, and `N>`;
 * append `>>` stays allowed by design), the target is matched against the
 * rule's `target-denylist` globs (`**` / `*` / `?`). Targets are
 * POSIX-normalized before matching (`path.posix.normalize` collapses `.//`
 * and `sub/..` spellings — `> .//CLAUDE.md` and `> ./sub/../CLAUDE.md` (same
 * for the AGENTS.md alias) were silently ALLOWED pre-normalization, W4 F1a)
 * and a leading `./` is stripped.
 *
 * Absolute and `~` spellings (#988 T1). The denylist globs are repo-relative,
 * so `> /abs/path/to/repo/CLAUDE.md` and `> ~/repo/CLAUDE.md` matched NOTHING
 * and were silently allowed (probe-measured `rule abs: false`, `rule tilde:
 * false` against `rule rel: true`). Pass `{ repoRoot }` and such a target is
 * tilde-expanded, alias-collapsed and made repo-relative before the globs run;
 * a target outside the repo yields no match. WITHOUT `repoRoot` (the default)
 * an absolute target still never matches — identical to the pre-#988 contract,
 * so existing callers keep their exact behaviour. This function stays I/O-free:
 * `~` resolves from `process.env.HOME` (overridable via `home`), never via a
 * filesystem lookup.
 *
 * Relative spellings and case (#994). A RELATIVE target is interpreted as
 * REPO-ROOT-relative, NOT shell-cwd-relative: one that climbs out with `..`
 * (`> ../repo/CLAUDE.md`) is resolved against `repoRoot` and re-relativized, so
 * it is caught when it lands back inside the root and allowed when it does not
 * (without `repoRoot`, such a target keeps its pre-#994 lexical form). The
 * denylist globs and the absolute-containment comparison are BOTH
 * case-insensitive, because a case-insensitive volume makes `> claude.md` the
 * same inode as `CLAUDE.md`; the alias-collapse also covers `/System/Volumes/Data`
 * and `/private/etc` alongside `/private/{tmp,var}`.
 *
 * Deliberate boundary (#641 FP class): `unresolved: true` entries (variable
 * indirection, command substitution) are NEVER matched — blocking on a guess
 * would reintroduce the false-positive class #641 removed. They remain
 * visible via extractRedirectTargets; the consuming guard hook (W3-A, #983)
 * decides whether to log them.
 *
 * The guard-hook branch dispatching on `rule.type === 'redirect-truncate'`
 * lives in hooks/pre-bash-destructive-guard.mjs and consumes this export.
 *
 * @param {{ modes?: string[], 'target-denylist'?: string[] }} rule
 * @param {string} command
 * @param {{ repoRoot?: string|null, home?: string|undefined }} [opts]
 *   repoRoot — absolute repo root; enables absolute/`~` target resolution.
 *   home — `~` expansion base; defaults to `process.env.HOME`.
 * @returns {boolean}
 */
export function redirectRuleMatches(rule, command, opts = {}) {
  const { repoRoot = null, home = process.env.HOME } = opts;
  if (!rule || typeof command !== 'string' || command.length === 0) return false;
  const denylist = Array.isArray(rule['target-denylist']) ? rule['target-denylist'] : [];
  if (denylist.length === 0) return false;
  const modes = new Set(Array.isArray(rule.modes) && rule.modes.length > 0 ? rule.modes : ['truncate']);

  // #1362 — TWO denylist classes, deliberately kept apart:
  //
  //   REPO-RELATIVE (every pre-#1362 entry): judged against
  //   `repoRelativeRedirectTarget`, which returns `null` for anything outside
  //   the root. Behaviour is byte-identical to before, and that null is what
  //   keeps a relative entry from ever reaching an out-of-repo path.
  //
  //   HOME-ANCHORED (`~/…`, new): judged against the EXPANDED ABSOLUTE target,
  //   never relativized. Needed because the artefacts worth denying are not all
  //   inside the repo — the harness auto-memory directory
  //   (`~/.claude/projects/<encodeProjectDir(root)>/memory/`) is auto-injected
  //   as trusted project context into every later session yet lives outside
  //   `git diff`, CI review and the secret scanners. Measured 2026-09-13: with
  //   only the repo-relative class, NO glob spelling could match it, because
  //   `relativizeAgainstRoot` discards out-of-repo targets by design.
  //
  // The split is one-directional on purpose: a home-anchored entry cannot widen
  // an existing repo-relative rule, and a repo-relative entry still cannot
  // escape the root. An unexpandable `~` (no usable `home`) matches NOTHING —
  // fail-closed for the new class, since an unexpanded `~` names no file.
  const compiled = compileTargetDenylist(denylist, home);
  if (compiled.relRegexes.length === 0 && compiled.absRegexes.length === 0) return false;

  for (const entry of extractRedirectTargets(command)) {
    if (entry.unresolved) continue;
    if (!modes.has(entry.mode)) continue;
    if (targetMatchesDenylist(entry.target, compiled, repoRoot, home)) return true;
  }
  return false;
}

/**
 * Compile a rule's `target-denylist` into the two glob classes described in
 * `redirectRuleMatches` (#1362): repo-relative entries and home-anchored (`~/…`)
 * entries. Extracted so a SECOND rule class can reuse the exact same compilation
 * instead of growing a third copy of the glob logic (#1401) — the file already
 * carries that warning at `findMatchedRedirectEntry` in the consuming hook.
 *
 * An unexpandable `~` (no usable `home`) contributes NOTHING — fail-closed for
 * the home-anchored class, since an unexpanded `~` names no file.
 *
 * @param {string[]} denylist
 * @param {string|undefined} home
 * @returns {{ relRegexes: RegExp[], absRegexes: RegExp[] }}
 */
function compileTargetDenylist(denylist, home) {
  const relRegexes = [];
  const absRegexes = [];
  for (const pattern of denylist) {
    const text = String(pattern);
    if (text === '~' || text.startsWith('~/')) {
      const expanded = expandLeadingHome(text, home);
      if (expanded === text) continue; // no usable home → no match, never a guess
      absRegexes.push(redirectGlobToRegExp(foldAbsoluteTarget(expanded)));
    } else {
      relRegexes.push(redirectGlobToRegExp(text));
    }
  }
  return { relRegexes, absRegexes };
}

/**
 * Test ONE resolved target text against a compiled denylist.
 *
 * A RELATIVE target is repo-root-relative in BOTH classes, exactly as the
 * repo-relative class already treats it (#994 R1) — otherwise
 * `../../.claude/projects/<enc>/memory/MEMORY.md` from the repo root names the
 * very file the `~` spelling blocks, and only the spelling would be denied
 * (measured 2026-09-13: relative `>`/`>>` ALLOW vs tilde/absolute BLOCK on one
 * and the same resolved path). This resolves TARGETS, never ENTRIES: a
 * repo-relative denylist entry still goes through `repoRelativeRedirectTarget`
 * and still cannot reach out of the root.
 *
 * @param {string} rawTarget — resolved target text (quotes already stripped)
 * @param {{ relRegexes: RegExp[], absRegexes: RegExp[] }} compiled
 * @param {string|null} repoRoot
 * @param {string|undefined} home
 * @returns {boolean}
 */
function targetMatchesDenylist(rawTarget, compiled, repoRoot, home) {
  const { relRegexes, absRegexes } = compiled;

  if (absRegexes.length > 0) {
    const expandedTarget = expandLeadingHome(rawTarget, home);
    const absTarget = path.isAbsolute(expandedTarget)
      ? expandedTarget
      : repoRoot && path.isAbsolute(repoRoot)
        ? path.resolve(repoRoot, expandedTarget)
        : null;
    if (absTarget !== null) {
      const folded = foldAbsoluteTarget(absTarget);
      if (absRegexes.some((re) => re.test(folded))) return true;
    }
  }

  if (relRegexes.length > 0) {
    const target = repoRelativeRedirectTarget(rawTarget, repoRoot, home);
    if (target !== null && relRegexes.some((re) => re.test(target))) return true;
  }

  return false;
}

/**
 * Normalize an ABSOLUTE path for home-anchored denylist comparison (#1362):
 * same alias-collapse and case-fold `relativizeAgainstRoot` applies before its
 * containment test, so the two classes agree on what `/private/tmp` and a
 * case-insensitive volume mean. Applied to BOTH sides (pattern and target), so
 * the folding can never make a pattern match more than its literal spelling.
 *
 * @param {string} abs
 * @returns {string}
 */
function foldAbsoluteTarget(abs) {
  return stripPathAliases(path.posix.normalize(String(abs).replace(/\\/g, '/'))).toLocaleLowerCase(
    'en-US',
  );
}

/**
 * Verbs that REMOVE or RELOCATE a file named as a bare operand (#1401).
 *
 * `mv` is here for BOTH of its operand roles: the SOURCE disappears from its
 * path, and the DESTINATION is overwritten when it already exists — either one
 * loses the file that was there. So every operand of these verbs is a candidate,
 * with no source/destination distinction to get wrong.
 *
 * NAMED CEILING (BV-004) — measured 2026-09-19 against `splitChainSegments` +
 * `resolveSegmentVerb`. COVERED, because the verb resolves through the existing
 * machinery: bare `rm`/`mv`/`unlink`; `env X=1 rm …`, `sudo rm …`, `timeout 5 rm
 * …`, `nohup`/`nice`/`stdbuf`/`command`/`exec` (WRAPPER_UNWRAP); every chain
 * position (`;`, `&&`, `||`, `|`, `&`, newline) and compound-statement head
 * (`do rm …`, `{ rm …; }` — COMMAND_POSITION_KEYWORDS); and the literal payload
 * of `bash -c '…'` / `env -S '…'` / `eval '…'` via the shared payload recursion.
 *
 * NOT covered, deliberately, because the deleted path is not lexically an
 * operand of a resolvable verb:
 *   - `find … -delete` / `find … -exec rm {} \;` — the verb is `find`; its path
 *     operand is a SEARCH ROOT, and treating a search root as a delete target
 *     would also flag a pure `find … -print` over the same directory.
 *   - `… | xargs rm` — the targets arrive on stdin and do not exist as command
 *     text at hook time. `xargs` is deliberately NOT in WRAPPER_UNWRAP (see
 *     there: unwrapping it could only LOOSEN the guard).
 *   - `git rm <path>` — the verb is `git`; a git-subverb grammar is a separate
 *     table. PSA-007 already bans `git rm` for dispatched subagents.
 *   - in-process deletion (`node -e 'fs.unlinkSync(…)'`) — not redirect- or
 *     operand-shaped; same class boundary the `redirect-harness-memory`
 *     rationale draws for `tee -a` and `fs.appendFileSync`.
 * REVISIT TRIGGER: any of those four shapes showing up in a real deletion
 * incident or a transcript census — extend this set or add the sibling grammar,
 * never special-case one command.
 */
const PATH_DESTRUCTIVE_VERBS = new Set(['rm', 'mv', 'unlink']);

/**
 * Recursive collector behind {@link extractDeleteTargets}. Mirrors
 * collectRedirectTargets' structure — same segment walk, same dual-reading
 * union, same depth/budget caps and the same fail-VISIBLE cut-off markers.
 *
 * @param {Array<Array<{ text: string, quoted: boolean, redirect?: object }>>} segments
 * @param {Array<object>} out — accumulator
 * @param {number} depth
 * @param {{ remaining: number }} budget
 */
function collectDeleteTargets(segments, out, depth, budget) {
  for (const segment of segments) {
    const resolved = resolveSegmentVerb(segment);

    // BOTH readings of an ambiguous unknown WRAPPER flag contribute (#1000),
    // unioned and never replaced: `env -Q x rm .orchestrator/metrics/events.jsonl`
    // resolves to the non-destructive verb `x` in parse A and to `rm` in parse B,
    // while `sudo -n rm <file>` is the mirror case (parse B swallows `rm` as
    // `-n`'s operand). Picking either reading alone drops one of the two.
    const readings = readingsOf(resolved);
    const seen = new Set();

    for (const reading of readings) {
      if (!reading.verb || reading.index < 0) continue;
      if (!PATH_DESTRUCTIVE_VERBS.has(reading.verb)) continue;
      // A verb that only exists inside a quoted token is inert literal text for
      // this segment — same rule commandHasRecursiveForceRm applies. An
      // interpreter's quoted payload is reached through the recursion below
      // instead, where it is re-tokenized as the command it really is.
      // A quoted SINGLE word is no such literal (#1707 point 2): `"unlink" P`
      // and `{"unlink" P;}` run unlink, the quotes only vanish. Only a quoted
      // token with whitespace in it — a payload, never one argv word that
      // could still resolve to the verb — stays inert.
      if (segment[reading.index].quoted && /\s/.test(segment[reading.index].text)) continue;

      let seenDashDash = false;
      // A redirect operand is a filename the SHELL consumes, not an operand of
      // the verb — `rm -f x > out.log` deletes `x`, it does not delete
      // `out.log` (the redirect surface judges that one). The bash reading of
      // a glued close (`rm 3>&--rf P`: close fd 3, argv `-rf`) is an argv
      // word again (#1832, argvWordsWithoutRedirects).
      for (const tok of argvWordsWithoutRedirects(segment, reading.index + 1)) {
        if (!seenDashDash && tok.text === '--') { seenDashDash = true; continue; }
        // FLAG SKIPPING, and why this is the UNION of both flag readings rather
        // than a pick (#1000 applied to the VERB's own options): an option table
        // cannot enumerate every flag `rm`/`mv` may grow, and the two possible
        // readings of an unknown one are "boolean" (the next word is an operand)
        // and "value-taking" (the next word is the flag's value). The
        // value-taking reading is a strict SUBSET of the boolean one here — it
        // can only HIDE a word, never reveal one — so collecting under the
        // boolean reading yields exactly the union of both. That is also the
        // fail-closed direction: `mv -t .orchestrator/metrics/ x` reports the
        // `-t` operand as a candidate (it IS a destination that can overwrite),
        // where a value-taking reading would have swallowed it silently.
        if (!seenDashDash && !tok.quoted && tok.text.startsWith('-') && tok.text !== '-') continue;

        // A word with a glued group-closing `}` is judged in BOTH readings
        // (#1707 point 1, see gluedCloseReadings): `{rm -r .orchestrator}`.
        for (const text of tok.closeReadings ? [tok.text, ...tok.closeReadings] : [tok.text]) {
          const key = `${reading.verb}\u0000${text}`;
          if (seen.has(key)) continue;
          seen.add(key);

          if (/[$`]/.test(text)) {
            // Variable indirection (`rm -f "$LEDGER"`) or command substitution:
            // fail-visible, never guess (#983 rule, same direction).
            out.push({
              target: null, verb: reading.verb, unresolved: true, reason: 'variable/substitution',
            });
            continue;
          }
          out.push({ target: text, verb: reading.verb });
        }
      }
    }

    // Literal `-c` / `env -S` / `eval` payload recursion — the same deduped
    // union helper and the same shared budget the match and redirect surfaces
    // use, so this traversal cannot be starved any differently than those.
    const payloads = dedupedSegmentPayloads(segment, resolved);
    if (payloads.length === 0) continue;

    // A cap that drops payloads SILENTLY is a bypass, not a cap (#988 T2) —
    // emit a marker so the consuming hook can surface it.
    if (depth >= MAX_PAYLOAD_DEPTH) {
      out.push({ target: null, verb: null, unresolved: true, reason: 'depth-exceeded' });
      continue;
    }
    for (const payload of payloads) {
      if (budget.remaining <= 0) {
        out.push({ target: null, verb: null, unresolved: true, reason: 'budget-exhausted' });
        break;
      }
      budget.remaining -= 1;
      const subTokens = tokenizeCommand(
        normalizeShellWhitespaceExpansions(payload, { expandSingleQuoted: true }),
      );
      collectDeleteTargets(splitSegments(subTokens), out, depth + 1, budget);
    }
  }
}

/**
 * Extract every path a command names as an operand of a file-destroying verb
 * (`rm`, `mv`, `unlink` — see {@link PATH_DESTRUCTIVE_VERBS} for the covered and
 * uncovered shapes), across all chain segments and literal shell payloads (#1401).
 *
 * This is the DELETE/RENAME sibling of `extractRedirectTargets`: that one answers
 * "which file does this command WRITE", this one "which file does it REMOVE or
 * MOVE". They are separate surfaces because a redirect target and a verb operand
 * are different grammar positions — `rm -f x > out.log` names one of each, and
 * the guard's 53,896-line telemetry loss (#1401) happened because only the write
 * surface was ever consulted.
 *
 * Entry shapes:
 *   - `{ target: string, verb: 'rm'|'mv'|'unlink' }` — resolved operand, quotes
 *     stripped by the tokenizer.
 *   - `{ target: null, verb, unresolved: true, reason: 'variable/substitution' }`
 *     — the operand carries a variable or a command substitution. Reported
 *     fail-visible; never a match candidate (#641 FP class).
 *   - `{ target: null, verb: null, unresolved: true,
 *      reason: 'budget-exhausted'|'depth-exceeded' }` — a payload subtree was NOT
 *     traversed because a recursion cap cut it off (#988 T2).
 *
 * @param {string} command
 * @returns {Array<{ target: string|null, verb: string|null, unresolved?: boolean, reason?: string }>}
 */
export function extractDeleteTargets(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const out = [];
  const segments = splitSegments(tokenizeCommand(normalizeShellWhitespaceExpansions(command)));
  collectDeleteTargets(segments, out, 0, { remaining: MAX_PAYLOAD_EVALUATIONS });
  return out;
}

/**
 * Return the FIRST collected delete/rename target a `path-delete` policy rule's
 * `target-denylist` matches, or `null` when none does (#1401).
 *
 * Returns the ENTRY, not a boolean, so the consuming hook can name the verb and
 * the target in its deny reason without re-probing through a boolean matcher —
 * the workaround `findMatchedRedirectEntry` needs, and which its own docblock
 * flags as one copy too many.
 *
 * Takes pre-collected `entries` rather than the raw command so the hook
 * tokenizes ONCE (it needs the same array for the unresolved-marker notices).
 *
 * PER-TARGET, never per-command: every entry is judged on its own, so a sibling
 * operand that is NOT on the denylist can never lift the verdict for one that
 * is. `rm -f .orchestrator/tmp/ok .orchestrator/metrics/events.jsonl` matches on
 * the second operand — the exemption is the ABSENCE of a denylist entry for
 * `.orchestrator/tmp/**`, never a whole-command escape clause. That shape is the
 * #1106 hole (`guard-design.md` § "Widening a matcher without narrowing its
 * bypass"), where an appended exempt statement lifted the verdict for the whole
 * command; it is structurally unreachable here.
 *
 * Denylist semantics (globs, the two classes, `~` handling, case-folding,
 * repo-root relativization) are IDENTICAL to `redirectRuleMatches` — both call
 * `compileTargetDenylist` / `targetMatchesDenylist`, so the two rule classes can
 * never drift apart on what a pattern means.
 *
 * @param {{ 'target-denylist'?: string[] }} rule
 * @param {Array<{ target: string|null, verb: string|null, unresolved?: boolean }>} entries
 * @param {{ repoRoot?: string|null, home?: string|undefined }} [opts]
 * @returns {{ target: string, verb: string }|null}
 */
export function firstDeniedDeleteTarget(rule, entries, opts = {}) {
  const { repoRoot = null, home = process.env.HOME } = opts;
  if (!rule || !Array.isArray(entries) || entries.length === 0) return null;
  const denylist = Array.isArray(rule['target-denylist']) ? rule['target-denylist'] : [];
  if (denylist.length === 0) return null;

  const compiled = compileTargetDenylist(denylist, home);
  if (compiled.relRegexes.length === 0 && compiled.absRegexes.length === 0) return null;

  for (const entry of entries) {
    if (entry.unresolved || typeof entry.target !== 'string') continue;
    if (targetMatchesDenylist(entry.target, compiled, repoRoot, home)) {
      return { target: entry.target, verb: entry.verb };
    }
  }
  return null;
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
 * segment's verb (argv[0], after skipping env-assignments and unwrapping the
 * transparent wrappers in WRAPPER_UNWRAP — `env`, `command`, `sudo`, `doas`,
 * `nohup`, `timeout`, `nice`, `stdbuf` (#982)) is a shell-exec interpreter
 * (`bash -c "rm -rf /"`, `sudo bash -c "…"`, `eval "…"`, `psql -c "DROP TABLE …"`,
 * `find … -exec …`). The guard is applied PER chain segment: a quoted pattern in
 * segment N is judged against segment N's verb. Shell `-c` payloads (and
 * `env -S` strings) are additionally re-tokenized and matched recursively,
 * depth-capped at 3 with a total evaluation budget (#982).
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

  // Fast path — a SUPERSET prefilter (#1830). The old one asked the boundary
  // regex of the raw text, claiming "no tokenization can produce a match"; that
  // was false: quote removal (`git "reset" --hard`), redirect removal
  // (`git >/dev/null reset --hard`) and tab separators produce the pattern from
  // text that does not contain it, and all 13 pattern rules were bypassed that
  // way. Every token the lexer emits is command text with characters REMOVED
  // (quotes, `$` of `$'…'`, escaping backslashes, `\<newline>`), never
  // added, and no pattern word contains one of those characters — so a command
  // whose stripped text lacks any pattern word cannot match, and every other
  // command goes to the tokenizer.
  // ANSI-C quotes `$'…'` are DECODED by the lexer (#1832: `$'\x72eset'` →
  // `reset`), i.e. characters are ADDED that the text does not contain, so the
  // stripped-text argument above does not hold for them. A command holding
  // `$'` skips the prefilter and always goes to the tokenizer — the smaller
  // correct change than a second `$'…'` decoder here (one grammar, in the
  // lexer); the cost is a tokenizer run for the rare commands that use it.
  const words = pattern.split(' ').filter(Boolean);
  // A git pattern's flags may be spelled differently (#1831: `-xfd` holds no
  // `-f`), so its prefilter asks only for `git` and the subcommand — the
  // argv match needs both words verbatim (git does not abbreviate
  // subcommands), so the superset property above still holds.
  const git = gitPatternSpec(words);
  const required = git ? ['git', git.sub] : words;
  const mayMatch = (text) => {
    const stripped = text.replace(/\\\n/g, '').replace(/[\\'"$`]/g, '');
    return required.every((w) => stripped.includes(w));
  };
  if (!command.includes("$'") && !mayMatch(normalizedCommand) && !mayMatch(payloadNormalizedCommand)) return false;

  const segments = splitSegments(tokenizeCommand(normalizedCommand));
  return matchSegments(segments, re, 0, { remaining: MAX_PAYLOAD_EVALUATIONS }, git);
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
