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
  // BusyBox's Almquist shell and `fish` run a quoted `-c` payload like the
  // POSIX shells (#1944 point 8); `fish -c '…'` and `ash -c '…'` (also reached
  // as `busybox ash -c '…'`) were allowed while `bash -c '…'` was denied.
  // fish's option VALUES (`-c S`, glued `-cS`, `--command[=]S`, `-C S`,
  // `--init-command[=]S`) are read by fishCommandStrings, for the pattern
  // matcher (dashCPayloads) and, via suCommandStrings(words, 'fish'), for the
  // destructive guard's readers (#1944 follow-up: those forms were allowed).
  'ash', 'fish',
  'eval', 'xargs', 'env', 'command',
  'psql', 'mysql', 'sqlite3',
  'find',
  // `su -c 'payload'` executes its quoted payload as a shell command (#982).
  // Deliberately an interpreter, NOT a WRAPPER_UNWRAP entry: unwrapping `su`
  // would resolve past it and could only loosen the quoted-payload guard.
  'su',
  // util-linux `runuser` and shadow `sg` read like su (#1944 F4): `runuser
  // USER -c '…'` hands the string to the target user's shell, `sg GROUP [-c]
  // '…'` to /bin/sh. Interpreters for the same reason su is one.
  'runuser', 'sg',
  // `parallel 'git restore {}' ::: a` composes each argument into a shell
  // command line and runs it (#1925 point 8) — unlike `exec`, which execs an
  // argv and never a command string (tests/lib/command-blocker.test.mjs).
  'parallel',
]);

/** Stands for an unquoted IFS expansion in lexTokens' second normalization (#1956 fix cycle 1). */
const IFS_MARK = '\u{E000}';

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
 * `ifsMark` (#1956 fix cycle 1): an unquoted IFS expansion becomes this one
 * character instead of a space, at the same offset, so the lexer can tell
 * where it split a word at `$IFS` (lexTokens, `ifsSplit`).
 *
 * @param {string} command
 * @param {{ expandSingleQuoted?: boolean, expandDoubleQuoted?: boolean, ifsMark?: string }} [options]
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
    if (end !== -1) {
      out += options.ifsMark !== undefined && matchIfsWhitespaceExpansion(command, i) !== -1 ? options.ifsMark : ' ';
      i = end;
      continue;
    }
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
 * `quoted` is whether any part of the word was quoted or escaped: bash expands
 * `$(…)`, backticks and `$x` in the body of an UNQUOTED delimiter only
 * (`<<EOF` runs `$(cmd)` in the body, `<<'EOF'` prints it, #1899).
 *
 * @returns {{ value: string, end: number, quoted: boolean }}
 */
function readDelimiterWord(command, i) {
  let value = '';
  let state = 'normal';
  let ansiNul = false;
  let quoted = false;
  while (i < command.length) {
    const ch = command[i];
    if (state === 'single') {
      if (ch === "'") { state = 'normal'; i++; continue; }
      value += ch; i++; continue;
    }
    if (state === 'ansi') {
      // bash decodes the escapes of a `$'…'` delimiter too: `<<$'E\x4fF'` ends at `EOF`.
      if (ch === "'") { state = 'normal'; ansiNul = false; i++; continue; }
      if (ch === '\\' && i + 1 < command.length) {
        const esc = decodeAnsiCEscape(command, i);
        if (esc.nul) ansiNul = true;
        else if (!ansiNul) value += esc.text;
        i = esc.end;
        continue;
      }
      if (!ansiNul) value += ch;
      i++; continue;
    }
    if (state === 'double') {
      if (ch === '"') { state = 'normal'; i++; continue; }
      if (ch === '\\' && i + 1 < command.length) { value += command[i + 1]; i += 2; continue; }
      value += ch; i++; continue;
    }
    if (/\s/.test(ch) || WORD_END_CHARS.has(ch)) break;
    if (ch === '\\' && i + 1 < command.length) { value += command[i + 1]; quoted = true; i += 2; continue; }
    // `$"EOF"` and `$'EOF'` are the delimiter `EOF` in bash (#1895): read as `$EOF`,
    // the body ran on past the real terminator and hid the commands after it.
    if (ch === '$' && command[i + 1] === "'") { state = 'ansi'; quoted = true; i += 2; continue; }
    if (ch === '$' && command[i + 1] === '"') { i++; continue; }
    if (ch === "'") { state = 'single'; quoted = true; i++; continue; }
    if (ch === '"') { state = 'double'; quoted = true; i++; continue; }
    value += ch; i++;
  }
  return { value, end: i, quoted };
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
 *     stays literal text there. An unquoted here-doc body past the cap is
 *     hoisted as one raw word marked `unread`, judged fail-closed (UNREAD).
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
 * ## Substitution ranges (`substitutions`, #1893)
 *
 * A word holding the raw text of a substitution also carries
 * `substitutions: Array<{ start, end }>` — one range of `text` per spliced
 * substitution, in source order: `$( … )`, a backtick pair, or the `( … )` of
 * a process substitution (its raw text starts with `(`). Parts cannot say this,
 * since the raw text merges into the part of its outer context. Non-enumerable
 * like `parts`, and absent on a word without a substitution.
 *
 * @param {string} command
 * @returns {Array<{ text: string, quoted: boolean, redirect?: { fd: number|null, mode: string }, braceLead?: number, operator?: string, parts?: Array<{ text: string, quote: 'none'|'double'|'single'|'ansi-c'|'escape' }>, substitutions?: Array<{ start: number, end: number }> }>}
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
        const argvWord = { text: next.text.slice(1), quoted: rest.some((p) => p.text !== '' && p.quote !== 'none') };
        // #1893: parts and substitution ranges for the empty-expansion reading.
        Object.defineProperty(argvWord, 'parts', { value: rest, enumerable: false });
        if (next.substitutions) {
          const subs = next.substitutions.map((s) => ({ start: s.start - 1, end: s.end - 1 }));
          Object.defineProperty(argvWord, 'substitutions', { value: subs, enumerable: false });
        }
        Object.defineProperty(plain, 'bashArgvWord', { value: argvWord, enumerable: false });
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
  if (typeof command !== 'string' || command.length === 0) return [];
  return resolveFdOperandRedirects(lexTokens(command, -1));
}

/**
 * The size bound of a command line every reader of this module checks before
 * it splits or reads the line (#2032): characters, and statements (unquoted
 * separators the lexer emits — `;`, `&&`, `||`, `|`, `&`, newline, subshell
 * and substitution boundaries — plus one). The harness kills a hook after 5 s
 * and a killed or aborted hook lets the command through, so a line past
 * either bound is denied as unreadable instead, whatever it names.
 * NAMED CEILING (BV-004): a harmless line past a bound is denied. The
 * character bound is set by the slowest form below it, a quoted inner script
 * piped to a shell (`printf '%s' ':;…' | sh`), which the hook reads at about
 * 1.7 s per 128 KiB (measured 2026-11-11, load 5: 64 KiB 0.96 s, 512 KiB
 * 4.1 s, too close to the 5 s kill); 128 KiB keeps it near 1.7 s, and the
 * brace-word and pipe-read budget tests (70-100 KB lines) still reach their
 * own budgets. 32,001 statements took 0.87 s. Census 2026-11-11 over the session-orchestrator
 * transcripts (13 folders, 30 days, 32,635 unique Bash commands): longest
 * 14,702 characters, most 54 statements, 0 at either bound (population is
 * this repo's sessions only). REVISIT TRIGGER: a real command denied as too
 * long to read safely.
 */
export const MAX_COMMAND_CHARS = 128 * 1024;
export const MAX_SEGMENTS = 8192;

/**
 * Why `command` is too long to read safely (see MAX_COMMAND_CHARS), or null.
 * Linear in the line: the character test runs first, and the statement count
 * walks the lexer's tokens once, before any split builds statements or views.
 *
 * @param {string} command
 * @returns {string | null} a one-line reason, e.g. `command too long to read
 *   safely (9000 statements > 8192)`
 */
export function oversizedCommand(command) {
  if (typeof command !== 'string') return null;
  if (command.length > MAX_COMMAND_CHARS) {
    return `command too long to read safely (${command.length} characters > ${MAX_COMMAND_CHARS})`;
  }
  let statements = 1;
  for (const tok of tokenizeCommand(command)) {
    if (!tok.quoted && (tok.operator !== undefined || CHAIN_OPERATOR_TEXTS.has(tok.text))) statements++;
  }
  return statements > MAX_SEGMENTS ? `command too long to read safely (${statements} statements > ${MAX_SEGMENTS})` : null;
}

/**
 * Program names every reader compares in lower case (#1955 (a)). macOS APFS
 * and Windows NTFS look names up case-insensitively, so `GIT reset --hard`,
 * `Git checkout -f` and `/usr/bin/GIT clean -fdx` run git, and macOS ships
 * `/usr/bin/eval` and its siblings as scripts that run the builtin. Built
 * lazily from the tables the readers already key on (wrappers, interpreters,
 * `-c` shells) plus the verbs the guards compare by literal.
 * NAMED CEILING (BV-004): a verb a guard compares that is in none of these
 * lists is read case-sensitively; a guard keying on a new program adds it
 * here. `cd`/`pushd`/`popd` stay unfolded on purpose: `/usr/bin/cd` runs in
 * a subshell and moves nothing, and reading `CD /x` as a move would measure
 * a later git call in the wrong directory. git subcommands are not folded:
 * git reads them case-sensitively. Only comparisons fold (programName,
 * foldedCommandSegment); no token text changes, so an operand such as the
 * file `Node` keeps its name for the measured readers. REVISIT TRIGGER: a
 * replayed command that runs a guarded program through an unfolded spelling.
 */
const CASE_FOLD_EXTRA = [
  'git', 'rm', 'mv', 'cp', 'ln', 'unlink', 'rmdir', 'truncate', 'dd', 'tee', 'cat', 'echo', 'printf',
  'trap', 'source', 'builtin', 'watch', 'script', 'node', 'deno', 'rg',
  'apply_patch', 'applypatch',
];
let caseFoldNames = null;

/** @returns {Set<string>} */
export function caseFoldCommandNames() {
  caseFoldNames ??= new Set([...WRAPPER_UNWRAP.keys(), ...SHELL_EXEC_INTERPRETERS, ...DASH_C_SHELLS, ...CASE_FOLD_EXTRA]);
  return caseFoldNames;
}

/**
 * The program name a command word runs (#1955 (a)): its basename, in lower
 * case when that spells a guarded program (caseFoldCommandNames). Every
 * reader that compares a command word with a program name goes through this;
 * a token's `text` is never changed, so path operands keep their case
 * (`git restore Node` names the file `Node`, review of 1d7d8a5b).
 *
 * @param {string} text
 * @returns {string}
 */
export function programName(text) {
  const base = text.replace(/^.*\//, '');
  if (!/[A-Z]/.test(base)) return base;
  const lower = base.toLowerCase();
  return caseFoldCommandNames().has(lower) ? lower : base;
}

/**
 * The extra reading of a segment for the text checks of matchSegments
 * (#1955 (a)): every word that spells a guarded program in another case, in
 * its lower-case spelling, or null when no word differs. It is one more
 * reading next to the segment itself (union): a match only names the rule,
 * and the measured readers (path resets, delete targets) read the unchanged
 * words. A changed word is a copy whose text keeps its length, so `parts`
 * stay aligned.
 *
 * @param {Array<object>} segment
 * @returns {Array<object>|null}
 */
function foldedCommandSegment(segment) {
  let out = null;
  for (let i = 0; i < segment.length; i++) {
    const tok = segment[i];
    if (tok.operator !== undefined || tok.redirect !== undefined || tok.text.startsWith('-') || !/[A-Z]/.test(tok.text)) continue;
    const base = tok.text.replace(/^.*\//, '');
    const name = programName(tok.text);
    if (name === base) continue;
    const at = tok.text.length - base.length;
    const copy = { ...tok, text: tok.text.slice(0, at) + name };
    if (Array.isArray(tok.parts)) {
      let pos = 0;
      const parts = tok.parts.map((p) => {
        const from = Math.max(0, at - pos);
        pos += p.text.length;
        return { ...p, text: p.text.slice(0, from) + p.text.slice(from).toLowerCase() };
      });
      Object.defineProperty(copy, 'parts', { value: parts, enumerable: false });
    }
    out ??= segment.slice();
    out[i] = copy;
  }
  return out;
}

/**
 * The lexer behind tokenizeCommand (before resolveFdOperandRedirects).
 *
 * `heredocNesting` -1 lexes a command. 0 and up lexes the BODY of a here-doc
 * with an unquoted delimiter (#1899), nested that many bodies deep: bash
 * expands such a body like double-quoted text without the closing quote — a
 * `"` is literal there and `\` escapes only `$`, `` ` `` and `\` — so the body
 * lexes as one double-quoted word whose `$( … )` / backtick bodies are hoisted
 * like those of `"$(…)"`.
 *
 * @param {string} command
 * @param {number} heredocNesting
 * @returns {Array<object>}
 */
function lexTokens(command, heredocNesting) {
  const tokens = [];
  if (command.length === 0) return tokens;
  // #1956 fix cycle 1: where an unquoted `$IFS` split a word. bash expands
  // braces before it splits fields, so `{git,reset,$IFS--hard}` is ONE brace
  // word; the lexer splits it here, and expandBraces fails closed on a piece
  // that holds an open brace (`ifsSplit`). Same offsets as the spaces below.
  const ifsMarked = /\$\{?IFS/.test(command) ? normalizeShellWhitespaceExpansions(command, { ifsMark: IFS_MARK }) : null;
  command = normalizeShellWhitespaceExpansions(command);
  const heredocBody = heredocNesting >= 0;
  // The current token borders an unquoted IFS split (see ifsMarked).
  let ifsSplit = false;

  let text = '';
  // Per-part quote provenance of `text` (see the @returns note): consecutive
  // characters with the same quote context share one part, so
  // `parts.map((p) => p.text).join('') === text` for every word token.
  let parts = [];
  // Where the raw text of each `$( … )` / backtick / process substitution sits
  // in `text` (see the @returns note on `substitutions`, #1893).
  let subs = [];
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
  let state = heredocBody ? 'double' : 'normal';    // 'normal' | 'single' | 'double' | 'ansi'
  let ansiNul = false;     // inside `$'…'` after a decoded NUL (see decodeAnsiCEscape)
  let arithDepth = 0;      // open `$((` / `((` levels — inside them `<<` is a shift
  // A terminated here-doc body was read in the CURRENT substitution level
  // (#1908 point 1). The raw text of the closed `$( … )` that is appended to the
  // outer word then carries that body, which is DATA: the outer word must count
  // as quoted, or `"$(cat <<EOF⏎<pattern text>⏎EOF⏎)"` matched the pattern in
  // the outer word's raw text although the body only ever reaches `cat`'s
  // stdin. The body's own `$( … )` are still hoisted and judged as commands.
  let heredocData = false;
  // The CURRENT word carries such a closed substitution (#1908 point 1). Kept
  // apart from `sawQuote` on purpose: the word is not quoted — `x=$(cat <<EOF…)`
  // is still an assignment and the verb after it still runs. The flag only
  // switches off raw-text pattern matching on this word (token field `data`).
  let dataWord = false;
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
      // An escaped chain operator (`\;`, `\&\&`, `\|`) stays an unquoted word
      // and still splits the statement, fail-closed for every consumer: a
      // runner that joins its words into a shell line (`watch`, `ssh`, `eval`)
      // runs it as an operator (#1927 cycle 3 — marking it quoted let
      // `watch echo \; git clean -fdx` through). `find`'s own `\;` terminator
      // is read in the matcher instead (`findActionStart`).
      const tok = { text, quoted: sawQuote };
      // Only a QUOTED token carries the count: for an unquoted one every `{` of
      // its text is bare, so the text already says it (and the token shape of
      // every unquoted word stays as it was).
      if (sawQuote && braceLead > 0) tok.braceLead = braceLead;
      // Non-enumerable on purpose: JSON, deep equality and `Object.keys` see the
      // exact pre-#1795 token shape; only a reader asking for `tok.parts` gets it.
      Object.defineProperty(tok, 'parts', { value: parts, enumerable: false });
      if (subs.length > 0) Object.defineProperty(tok, 'substitutions', { value: subs, enumerable: false });
      if (dataWord) Object.defineProperty(tok, 'data', { value: true, enumerable: false });
      if (ifsSplit) Object.defineProperty(tok, 'ifsSplit', { value: true, enumerable: false });
      sink.push(tok);
      text = '';
      parts = [];
      subs = [];
      started = false;
      sawQuote = false;
      dataWord = false;
      braceLead = 0;
    }
    ifsSplit = false;
  };

  // Open a substitution level whose BODY is lexed into a fresh sink. The outer
  // word in progress (`x=` in `x=$(…)`, or the double-quoted run around
  // `"$(…)"`) is parked in the frame and resumed on close.
  const openSubstitution = (kind, start) => {
    stack.push({ kind, start, text, parts, subs, started, sawQuote, dataWord, braceLead, state, sink, arithDepth, caseStates, heredocData });
    text = ''; parts = []; subs = []; started = false; sawQuote = false; dataWord = false; braceLead = 0; state = 'normal'; arithDepth = 0; caseStates = []; heredocData = false;
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
    const bodyHeldHeredoc = heredocData;
    ({ text, parts, subs, started, sawQuote, dataWord, braceLead, state, sink, arithDepth, caseStates, heredocData } = frame);
    const raw = command.slice(frame.start, end);
    const at = text.length;
    addText(raw, state === 'double' ? 'double' : 'none'); started = true;
    subs.push({ start: at, end: text.length });
    if (/["']/.test(raw)) sawQuote = true;
    // The enclosing level's raw text holds this body too (nested `$( … )`).
    if (bodyHeldHeredoc) { dataWord = true; heredocData = true; }
  };

  const topKind = () => (stack.length > 0 ? stack[stack.length - 1].kind : null);
  const pushSubshellSeparator = (capped = false, side = undefined) => {
    flush();
    const sep = { text: ';', quoted: false, operator: 'subshell' };
    // Fix cycle 2 (3a): a nesting level past MAX_TOKENIZER_NESTING is no
    // subshell the pipe-data reader can follow; the marker makes that reading
    // fail closed (splitSegmentsReading) instead of losing the data.
    if (capped) Object.defineProperty(sep, 'nestingCapped', { value: true });
    // #2014 point 1: which paren this is, so the splitter can tell the body of
    // a piped subshell (`echo S | ( true; xargs git )`). Non-enumerable: the
    // token shape every consumer compares stays unchanged.
    if (side !== undefined) Object.defineProperty(sep, 'subshellSide', { value: side });
    sink.push(sep);
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
      subs = [];
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
      // In a here-doc body (stack level 0) the pseudo double quote never closes.
      const bodyLevel = heredocBody && stack.length === 0;
      if (ch === (state === 'double' ? '"' : "'") && !bodyLevel) { state = 'normal'; ansiNul = false; continue; }
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
        // Double quotes preserve backslashes except before shell-special
        // characters; a backslash-newline pair is a line continuation.
        if (next === '\n') { i++; continue; }
        if ((bodyLevel ? '$`\\' : '$`"\\').includes(next)) {
          addText(next, 'escape'); started = true; sawQuote = true; i++;
          continue;
        }
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
        const { delim, stripTabs, expand, op } = pendingHeredocs.shift();
        const { body, end, terminated } = readHeredocBody(command, j, delim, stripTabs);
        // The reset is load-bearing: a first here-doc may terminate (lastTerm
        // true) while a SECOND one on the same line does not — leaving lastTerm
        // set would rewind onto the unterminated body's first char instead of a
        // real newline (#999).
        // NAMED CEILING (BV-004, review round 3): bash and zsh feed an
        // unterminated body to its statement up to the end of input
        // (`bash <<'E'` + `git checkout -f` and no `E`); here the rest lexes
        // into the `<<` statement (#970/#999 pin that shape, no phantom
        // separator). REVISIT TRIGGER: #1944 (stdin-script forms).
        if (!terminated) { lastTerm = false; pendingHeredocs.length = 0; break; }
        lastTerm = true;
        heredocData = true;
        // Fix cycle 1 (R-F3): the body is the stdin of the statement that
        // wrote `<<`, which may stand left of a pipe while the body token
        // lands in a later statement (`cat <<'E' | sh`). Both links are
        // non-enumerable, so the token shape every consumer sees is unchanged:
        // the operator carries its body (hereStringWords), and the body word
        // is marked so a stdin shell does not read it as a script file.
        Object.defineProperty(op, 'heredocText', { value: body });
        if (body.length > 0) {
          const word = { text: body, quoted: true };
          Object.defineProperty(word, 'heredocBody', { value: true });
          sink.push(word);
        }
        // An unquoted delimiter's body runs its `$( … )` / backticks (#1899):
        // hoist their bodies as commands. Past MAX_TOKENIZER_NESTING bodies the
        // body is not lexed but hoisted as one raw word marked `unread`, which
        // emptyExpansionSegment reads as UNREAD: unjudged is a match / an
        // unresolved delete target. Leaving it inert let 256 nested bodies hide
        // a hard reset (a cap that drops payloads silently is a bypass, #988 T2).
        if (expand && /[$`]/.test(body)) {
          if (heredocNesting + 1 < MAX_TOKENIZER_NESTING) {
            const inner = lexTokens(body, heredocNesting + 1);
            const from = inner.findIndex((t) => t.operator === 'substitution');
            if (from !== -1) for (let k = from; k < inner.length; k++) hoisted.push(inner[k]);
          } else {
            hoisted.push({ text: ';', quoted: false, operator: 'substitution' });
            const unread = { text: body, quoted: false };
            Object.defineProperty(unread, 'unread', { value: true, enumerable: false });
            hoisted.push(unread);
          }
        }
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
    if (ch === '"') {
      // A zero-length part records where the quoted run starts even when it
      // stays empty: `res$""et` is the locale string `$""`, read empty (#1899).
      if (parts[parts.length - 1]?.quote !== 'double') parts.push({ text: '', quote: 'double' });
      state = 'double'; started = true; continue;
    }
    if (ch === '$' && command[i + 1] === "'") { state = 'ansi'; started = true; i++; continue; }
    // A locale string `$"…"` keeps its `$` here (zsh's reading, `a$rb`): which
    // text bash passes depends on a message catalog, so a consumer that resolves
    // a path (scope-gate) must not read it as known. The pattern rules judge
    // bash's no-catalog reading separately (#1895, readEmptyExpansion).

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
        if (atCap) { pushSubshellSeparator(true); continue; }
        openSubstitution('backtick', i);
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        if (atCap) { pushSubshellSeparator(true); i++; continue; }
        openSubstitution('subst', i); i++;
        continue;
      }
      // Inside a case HEAD (`subject`/`in`/`pattern`) a word-start `(` is the
      // optional leading paren of a pattern (`(a)`); in an arm BODY it is a
      // subshell like anywhere else (`a) (rm x);;`).
      const top = caseTop();
      if (ch === '(' && !started && (top === null || top === 'body')) {
        if (atCap) { pushSubshellSeparator(true); continue; }
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
        pushSubshellSeparator(false, 'open');
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
          stack.pop(); pushSubshellSeparator(false, 'close'); continue;
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

    if (/\s/.test(ch)) {
      const atIfs = ifsMarked !== null && ifsMarked[i] === IFS_MARK;
      if (atIfs) ifsSplit = true;
      flush();
      ifsSplit = atIfs;
      continue;
    }

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
        // #2014 point 2: the fd prefix (`0<<< S`, `3<<< S`) is the IO_NUMBER, as
        // for every other redirect — before, `0` became an argv word, so
        // `git 0<<< x reset --hard` read as verb `git 0` and `xargs git 0<<<
        // 'S'` built `git 0 …`.
        const prefix = takeFdPrefix();
        sink.push({ text: `${prefix.digits}<<<`, quoted: false, redirect: redirectField(prefix, 'herestring') });
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
        const { value, end, quoted } = readDelimiterWord(command, k);
        const prefix = takeFdPrefix();
        const opText = `${prefix.digits}<<${stripTabs ? '-' : ''}`;
        const op = { text: opText, quoted: false, redirect: redirectField(prefix, 'heredoc') };
        sink.push(op);
        if (value && command[end] !== ')') {
          pendingHeredocs.push({ delim: value, stripTabs, expand: !quoted, op });
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

  return tokens;
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
  const pipeRead = newPipeRead();
  pipeRead.exhausted = tokens.some((t) => t.nestingCapped === true);
  const base = splitSegmentReadings(tokens, pipeRead);
  // #2033: preserve every old reading. Only statements with syntax relevant
  // to stdin normalization pay for the additional structural pass. `repeat`
  // too (#2036): only that pass gives its sublist body the pipe into it.
  if (!tokens.some((t) => t.redirect || t.subshellSide || t.text === 'function' || t.text === 'repeat' || t.text.includes('(') || STDIN_PREFIX_WORDS.has(t.text))) return base;
  return unionReadings(base, splitSegmentReadings(tokens, pipeRead, true));
}

function splitSegmentReadings(tokens, pipeRead, structural = false) {
  // #1999 fix cycle H3: ONE pipe-read context for the whole line, shared by
  // both readings and every segment (piped or not), so the xargs memo and
  // the budget hold across segments and across policy rules.
  const zsh = splitSegmentsReading(tokens, true, pipeRead, false, structural);
  let segments = zsh.segments;
  let bareSeen = zsh.bareSeen;
  if (zsh.softCut) {
    const bash = splitSegmentsReading(tokens, false, pipeRead, false, structural);
    segments = bash.segments;
    bareSeen ||= bash.bareSeen;
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
  }
  // #2027 point 1: the zsh reading of a bare `}` word inside an open brace
  // group as its closer (`{ xargs -n 2 git }`, `echo S | { sh }`). Only a line
  // whose default reading saw such a word (fix cycle 1, HIGH) pays for the
  // extra pass, and only a reading that really closed a group there adds its
  // statements.
  if (bareSeen) {
    const bare = splitSegmentsReading(tokens, true, pipeRead, true, structural);
    if (bare.bareClosed) segments = unionReadings(segments, bare.segments);
  }
  return segments;
}

/**
 * The statements of `base` plus each statement of `extra` that `base` does
 * not hold with the same words (#2027 point 1); a same-word statement gets the
 * extra one's glued-close readings merged instead. A statement that reads a
 * pipe or a stdin view (`pipedFrom`, `stdinView`) is always added: its stdin
 * may differ although its words do not (`{ cat } < <(…) | xargs git` — the
 * xargs statement reads `cat` in one reading and `cat } …` in the other), and
 * comparing the stdin chains would cost their length per statement.
 * Statements are never dropped, so the union only adds readings; a same-word
 * plain duplicate is not added twice. A statement's own stdin redirect also
 * keeps its bare-close reading (#2033), even without an inherited link.
 * Every added statement is marked
 * `extraReading` (markExtra), which the issue-budget matcher does not count.
 *
 * @param {Array<Array<object>>} base
 * @param {Array<Array<object>>} extra
 * @returns {Array<Array<object>>}
 */
function unionReadings(base, extra) {
  const out = [...base];
  const at = new Map();
  for (let i = 0; i < out.length; i++) {
    if (!out[i].pipedFrom && !out[i].stdinView) at.set(segmentKey(out[i]), i);
  }
  for (const segment of extra) {
    const linked = Boolean(segment.pipedFrom || segment.stdinView);
    const ownStdin = segment.some((t) => t.redirect && STDIN_SOURCE_MODES.has(t.redirect.mode));
    // A glued close (`git}`) the default reading already judges through its
    // closeReadings (#1707): only its stdin links are new here (fix cycle 1).
    if (!linked && !ownStdin && segment.some((t) => t.bareGlued)) continue;
    const key = linked ? null : segmentKey(segment);
    const i = linked ? undefined : at.get(key);
    if (i === undefined) {
      if (!linked) at.set(key, out.length);
      out.push(markExtra([segment])[0]);
    } else if (segment.some((t) => t.closeReadings)) {
      out[i] = copyLinks(out[i], mergeCloseReadings(out[i], segment));
    }
  }
  return out;
}

/**
 * Mark statements that only an extra reading adds — the bare-`}` reading's
 * and the function-call views (#2027) — with a non-enumerable `extraReading`
 * flag. Readers that judge a statement read them all; a reader that COUNTS
 * statements (the issue-budget matcher, hooks/_lib/vcs-create-matcher.mjs)
 * skips them, so one create is counted once (fix cycle 1, LOW).
 *
 * @param {Array<Array<object>>} segments
 * @returns {Array<Array<object>>} the same arrays
 */
function markExtra(segments) {
  for (const segment of segments) Object.defineProperty(segment, 'extraReading', { value: true, configurable: true });
  return segments;
}

/**
 * `next` with the non-enumerable links of `prev` (pipedFrom, stdinView,
 * pipeRead, tmuxChain) copied onto it: mergeCloseReadings builds a new array.
 *
 * @param {Array<object>} prev
 * @param {Array<object>} next
 * @returns {Array<object>}
 */
function copyLinks(prev, next) {
  for (const name of ['pipedFrom', 'stdinView', 'pipeRead', 'tmuxChain']) {
    if (prev[name] !== undefined) Object.defineProperty(next, name, { value: prev[name], configurable: true });
  }
  if (prev.afterSoftCut) next.afterSoftCut = true;
  return next;
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

/** Words that close a compound statement (#1940 point 6); a subshell closes on its `subshell` operator token. */
const COMPOUND_CLOSERS = new Set([')', '}', 'done', 'fi', 'esac']);

/**
 * Dropped command-position keywords that open (`COMPOUND_OPENERS`) or close
 * (`COMPOUND_WORD_CLOSERS`) a compound body (#2014 point 1); a subshell's
 * parens are `subshellSide` separators, `for`/`select`/`case` head a statement.
 */
const COMPOUND_OPENERS = new Set(['{', 'if', 'while', 'until']);
const COMPOUND_WORD_CLOSERS = new Set(['}', 'done', 'fi', 'esac']);
const LOOP_AND_CASE_HEADS = new Set(['for', 'select', 'case']);

/** Redirect targets that ARE stdout: a file redirect to them keeps the data on the pipe. */
const STDOUT_NAMES = new Set(['/dev/stdout', '/dev/fd/1', '/proc/self/fd/1']);

/**
 * The statement written just before a `|` when it holds only redirections
 * (fix cycle 1, C4: `( echo … ) 2>/dev/null | sh`), or an empty one: its length
 * in tokens and whether it sends stdout to a file. null when it holds a word
 * of its own (it is the pipe's left statement) or does not end at the `|`.
 *
 * @param {Array<object>} current - the statement just written
 * @param {Array<object>} tokens
 * @param {number} pipeAt - index of the `|` token
 * @returns {{ length: number, stdoutGone: boolean } | null}
 */
function redirectOnlyTail(current, tokens, pipeAt) {
  if (current.length === 0) return { length: 0, stdoutGone: false };
  if (tokens[pipeAt - current.length] !== current[0]) return null;
  let stdoutGone = false;
  // Fix cycle 2 (3b): any dup (`2>&1`, `>&2`, `3>&1`), `&>` or fd-path target
  // (`/dev/fd/N`, `/dev/stdout`, `/dev/stderr`) may route the data back onto
  // the pipe (`2>&1 >/dev/fd/2`) — then no file redirect is read as stopping it.
  let rerouted = false;
  for (let k = 0; k < current.length; k++) {
    const tok = current[k];
    if (!tok.redirect) return null;
    const end = redirectSpanEnd(current, k);
    const { mode, fd } = tok.redirect;
    if (mode === 'dup' || tok.text.startsWith('&>') || tok.text.includes('>&')) rerouted = true;
    if (end > k && /^\/dev\/(?:fd\/|stdout$|stderr$)|^\/proc\/self\/fd\//.test(current[end].text)) rerouted = true;
    if ((mode === 'truncate' || mode === 'append') && (fd === null || fd === 1)) {
      stdoutGone = end > k && !STDOUT_NAMES.has(current[end].text);
    }
    k = end;
  }
  return { length: current.length, stdoutGone: stdoutGone && !rerouted };
}

/**
 * The stdin redirects of a compound statement (#2014 point 1): `{ xargs -n 2
 * git; } <<< 'S'`, `( sh ) <<< 'S'`, `while …; done < <(…)` leave a
 * redirect-only statement behind the closer, and the body never saw them. In
 * bash the redirect is the body's stdin (it replaces a pipe); in zsh MULTIOS
 * joins it after the pipe (`echo aa | { xargs echo RUN; } <<< bb` prints `RUN
 * aa bb` in zsh, `RUN bb` in bash, measured 2026-11-10 with echo only). Each
 * earlier statement gets `stdinView` — itself with the tail appended, its
 * `pipedFrom` kept — and pipedShellData reads that view: both readings, as for
 * a redirect written on the statement itself.
 *
 * NAMED CEILING (BV-004): the body is not delimited — every statement written
 * before the tail on the line reads it, as the pipe's compoundBody does (`xargs
 * git diff; { cat; } <<< 'S'` lets the first xargs read S): a deny-side
 * over-read. REVISIT TRIGGER: a real command denied by it.
 *
 * @param {Array<Array<object>>} segments - the statements written so far
 * @param {Array<object>} current - the statement about to be written
 * @param {Array<object>} tokens
 * @param {number} end - index of the token that ends `current`
 * @param {ReturnType<typeof newPipeRead>} pipeRead - the line's budget: every
 *   statement visited and every token copied into a view is charged to
 *   `viewTokens`; past VIEW_TOKENS_MAX no view is built any more and the line
 *   is marked `viewsCut` (#2027 fix cycle 1, HIGH: each tail copied every
 *   earlier view, so `{ :; } <<< x; ` × 1100 took over 6 s, past the harness's
 *   5 s kill, which lets the command through).
 * @param {Set<number>} [closers] - token indexes the bare-`}` reading read as a
 *   group closer although their text is no `}` (`git}`, `{sh}`, fix cycle 1)
 */
function attachCompoundStdin(segments, current, tokens, end, pipeRead, closers = NO_CLOSERS) {
  if (pipeRead.viewsCut || current.length === 0 || tokens[end - current.length] !== current[0]) return;
  if (!current.some((t) => feedsStdin(t) && ['herestring', 'heredoc', 'read'].includes(t.redirect.mode))) return;
  for (let k = 0; k < current.length; k++) {
    if (current[k].heredocBody) continue;
    if (!current[k].redirect) return;
    k = redirectSpanEnd(current, k);
  }
  const prevAt = end - current.length - 1;
  const prev = tokens[prevAt];
  if (prev === undefined || !(closers.has(prevAt) || (!prev.quoted && (prev.operator === 'subshell' || COMPOUND_CLOSERS.has(prev.text))))) return;
  // A compound's pipe lands on its first statement — for `if`/`while` the
  // condition: a later body statement reads it too (zsh MULTIOS, `echo a |
  // while c; do xargs git; done <<< b`), so the last pipe seen is inherited.
  let pipe;
  for (const seg of segments) {
    if (seg.length === 0) continue;
    pipe = seg.pipedFrom ?? pipe;
    if (!chargeViewTokens(pipeRead, 1 + (seg.stdinView ?? seg).length + current.length)) return;
    const view = [...(seg.stdinView ?? seg), ...current];
    if (pipe) Object.defineProperty(view, 'pipedFrom', { value: pipe });
    if (seg.pipeRead) Object.defineProperty(view, 'pipeRead', { value: seg.pipeRead });
    Object.defineProperty(seg, 'stdinView', { value: view, configurable: true });
  }
}

/**
 * A compound body as a prefix view of a reading's append-only list of written
 * statements (#2032): `of[0..length-1]` are its members. O(1) per pipe; the
 * statements written later stay outside the view.
 *
 * @param {Array<Array<object>>} written
 * @returns {{ of: Array<Array<object>>, length: number }}
 */
function bodyView(written) {
  return { of: written, length: written.length };
}

/** No bare closers (attachCompoundStdin default). */
const NO_CLOSERS = new Set();

/**
 * One reading of {@link splitSegments}. `cutSoftAlways`: whether an `always`
 * after a glued or one-word close starts a new statement (zsh) or stays a word
 * (bash). Every statement written after the first such cut is marked
 * `afterSoftCut`.
 *
 * `bareClose` (#2027 point 1): zsh closes an open brace group at a bare `}`
 * word anywhere in it, not only in command position — zsh 5.9 prints `a` for
 * `{ echo a }` and `q` for `echo q | { cat }`, and rejects an unquoted `}`
 * word outside a group as a parse error (`echo }`); bash passes the word to
 * the command. With `bareClose` such a word ends its statement and closes the
 * group (`bareClosed` reports that one did); the default reading keeps it a
 * word, and splitSegments judges both.
 *
 * #2027 points 2 and 4 are read in every reading: a call of a function
 * defined earlier on the line feeds its stdin to the body
 * ({@link functionCallViews}), and an `exec` without a command feeds its
 * stdin sources to every later statement ({@link execStdinTokens}).
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @param {boolean} cutSoftAlways
 * @param {ReturnType<typeof newPipeRead>} pipeRead
 * @param {boolean} [bareClose]
 * @param {boolean} [structural] - #2033 normalization, beside legacy readings
 * @param {object | null} [inherited] - eval stdin, function table and shared call budget
 * @returns {{ segments: Array<Array<object>>, softCut: boolean, bareClosed: boolean, bareSeen: boolean }}
 */
function splitSegmentsReading(tokens, cutSoftAlways, pipeRead, bareClose = false, structural = false, inherited = null) {
  const functionHead = (words) => isFunctionHead(words) || (structural && structuralFunctionHead(words) !== undefined);
  const headName = (words) => structural ? structuralFunctionHead(words) ?? functionHeadName(words) : functionHeadName(words);
  const headAliases = (head) => typeof head === 'string' ? [head]
    : structural ? structuralHeadNames(head) ?? [headName(head)] : [headName(head)];
  const compoundPrefix = (words) => isCompoundPrefix(words) || (structural && (functionHead(words) || commandPrefix(words).index === words.length));
  let softCut = false;
  let bareClosed = false;
  let bareSeen = false;
  // Token indexes this reading closed a group at without a `}` word of their own.
  const bareClosers = new Set();
  // #2027 point 2: functions defined on the line (name → the index ranges of
  // every body defined for it in `segments`, #2036; `end` null while open),
  // the bodies still open (name + the compoundPipes depth that closes them),
  // and the views a call with stdin adds (appended after the line's statements).
  const functions = inherited?.functions ?? new Map();
  const openBodies = [];
  const callViews = [];
  const commandViews = [];
  const evalViews = [];
  const callBudget = inherited?.callBudget ?? { tokens: 0 };
  // #2027 point 4: the stdin sources an `exec` without a command opened, for
  // every later statement of the line.
  const execStdin = [];
  // Marked when a statement is WRITTEN, not when `current` starts: keyword
  // peeling (`always { rm …`) replaces `current` in between.
  const segments = [];
  // The non-empty statements written so far, append-only (#2032): a pipe
  // after a compound closer hands the next statement a PREFIX VIEW of it
  // (compoundBody), never a copy — a copy per pipe held N²/2 references,
  // `{ :; } | cat; ` × 16000 grew the heap past 3.9 GB and aborted the hook
  // without a verdict.
  const written = [];
  // The statement left of a top-level `|` (#1933 point 4): the next written
  // statement reads its output. Kept as a NON-enumerable back-reference, so the
  // segment shape every consumer sees (and every `toEqual`) is unchanged.
  let pipeLeft = null;
  // Fix cycle 2 (item 2): ONE work budget and memo for every pipe-data
  // reading of this line (pipelineLiteralData), shared by all its pipes and
  // (#1999 H3) attached to every segment as `pipeRead`. A nesting level the
  // lexer capped (3a) leaves the line unreadable up front (splitSegments).
  // An empty push (`a |<newline>b`, bash continues the pipeline) keeps it.
  // The statement before the last `;` ran tmux: this one may be its next command.
  let tmuxNext = false;
  // #2014 point 1 (writer side): a pipe into a compound statement is the stdin
  // of EVERY statement in its body, not only of the first one — for `if` and
  // `while` that is the condition (`echo S | if true; then xargs git; fi`,
  // `echo S | { true; sh; }`). One entry per open compound: the pipe its body
  // reads (the `|` right before its opener, or the enclosing body's), or null.
  // NAMED CEILING (BV-004): a glued closer (`{ xargs git}` in zsh) closes
  // nothing here, so the statements after it on the line read the pipe too —
  // a deny-side over-read, like attachCompoundStdin's. REVISIT TRIGGER: a real
  // command denied by it.
  const compoundPipes = inherited ? [inherited.pipe] : [];
  const compoundSources = inherited ? [inherited.sources] : [];
  let leadingSources = [];
  const openCompound = () => {
    compoundPipes.push(pipeLeft ?? compoundPipes[compoundPipes.length - 1] ?? null);
    const parent = compoundSources.at(-1) ?? [];
    if (leadingSources.length > 0 && chargeViewTokens(pipeRead, parent.length + leadingSources.length)) {
      compoundSources.push([...parent, ...leadingSources]);
    } else compoundSources.push(parent);
    leadingSources = [];
  };
  // Close the innermost compound; a function body that ends with it gets its
  // end index (#2027 point 2).
  const closeCompound = () => {
    const body = openBodies[openBodies.length - 1];
    if (body !== undefined && body.depth === compoundPipes.length) {
      openBodies.pop();
      body.fn.end = segments.length;
    }
    if (casePatterns.at(-1)?.depth === compoundPipes.length) casePatterns.pop();
    compoundPipes.pop();
    compoundSources.pop();
  };
  // #2036 second review (S1): a closer first ends every zsh `repeat` sublist
  // open at its own depth, so `( repeat 1 true && : )` closes both scopes and
  // leaves no stale repeat scope to cut a later group short.
  const closeRepeats = () => {
    while (repeatScopes.at(-1) === compoundPipes.length) {
      repeatScopes.pop();
      closeCompound();
    }
  };
  // A function head before a body opener: record the body from here on.
  // #2036 second review (S2): a name keeps every body defined for it on the
  // line — a later definition (possibly never run: `false && f() if …`) is
  // read beside the earlier one, never instead of it.
  const defineFunction = (name, fn) => {
    const bodies = functions.get(name);
    if (bodies === undefined) functions.set(name, [fn]);
    else if (bodies.at(-1) !== fn) bodies.push(fn);
  };
  const openBody = (head) => {
    const names = headAliases(head);
    const fn = { start: segments.length, end: null, segments };
    if (structural && !chargeViewTokens(pipeRead, names.length)) return;
    for (const name of names) {
      if (name !== null) defineFunction(name, fn);
    }
    if (names.some((name) => name !== null)) openBodies.push({ fn, depth: compoundPipes.length });
  };
  // Run eval in statement order so its definitions enter the same table
  // before a following call. Tokens and inherited sources share the line cap.
  const readEval = (segment, tokens) => {
    const depth = inherited?.evalDepth ?? 0;
    const source = segment.stdinView ?? segment;
    const sources = stdinSourceSpans(source, 0);
    if (depth >= 8 || !chargeViewTokens(pipeRead, tokens.length + sources.length)) {
      cutViews(pipeRead);
      return;
    }
    const context = { functions, callBudget, evalDepth: depth + 1, sources, pipe: source.pipedFrom ?? null };
    const read = splitSegmentsReading(tokens, cutSoftAlways, pipeRead, bareClose, true, context);
    for (const stmt of read.segments) callViews.push(stmt);
    if (!bareClose && read.bareSeen && !pipeRead.viewsCut) {
      const bare = splitSegmentsReading(tokens, true, pipeRead, true, true, context);
      for (const stmt of bare.segments) callViews.push(stmt);
    }
  };
  const queueEval = (segment, normalized) => {
    if (!normalized?.evalTokens) return;
    evalViews.push({ segment, tokens: normalized.evalTokens, source: segment.stdinView ?? segment });
    readEval(segment, normalized.evalTokens);
  };
  const pushSegment = (segment) => {
    if (structural && segment.length >= 3 && !segment[0].quoted && segment[0].text === 'function' &&
        structuralFunctionHead(segment.slice(0, 2)) !== undefined) {
      const name = structuralFunctionHead(segment.slice(0, 2));
      defineFunction(name, { start: segments.length, end: segments.length + 1, segments });
      segment = segment.slice(2);
    }
    if (segment.length > 0) {
      if (tmuxNext) Object.defineProperty(segment, 'tmuxChain', { value: true });
      tmuxNext = false;
      if (softCut) segment.afterSoftCut = true;
      const bodyPipe = pipeLeft ?? compoundPipes[compoundPipes.length - 1] ?? null;
      if (bodyPipe !== null) Object.defineProperty(segment, 'pipedFrom', { value: bodyPipe });
      pipeLeft = null;
      Object.defineProperty(segment, 'pipeRead', { value: pipeRead, configurable: true });
      const groupSources = compoundSources.at(-1) ?? [];
      if ((execStdin.length > 0 || groupSources.length > 0) &&
          (!structural || chargeViewTokens(pipeRead, segment.length + execStdin.length + groupSources.length))) {
        const view = [...segment, ...execStdin, ...groupSources];
        if (bodyPipe !== null) Object.defineProperty(view, 'pipedFrom', { value: bodyPipe });
        Object.defineProperty(view, 'pipeRead', { value: pipeRead });
        Object.defineProperty(segment, 'stdinView', { value: view, configurable: true });
      }
      const normalized = structural ? normalizeStatement(segment, pipeRead) : null;
      if (normalized?.changed && normalized.words.length > 0) commandViews.push({ segment, normalized });
      const bodyEvals = [];
      // Collect bodies (S2 keeps every one per name) only for a call that can
      // add a view: a known name (O(1)), budget left, then stdin. Each visited
      // body is charged in functionCallViews, so the work stays bounded.
      // The call stdin sources are scanned once per call, never per body.
      const callSources = callBudget.tokens <= CALL_VIEW_TOKENS_MAX && callsKnownFunction(functions, segment, normalized)
        ? stdinSourceSpans(segment.stdinView ?? segment, 0) : null;
      const called = callSources !== null && (bodyPipe !== null || callSources.length > 0)
        ? calledFunctions(functions, segment, normalized) : [];
      if (called.length > 0) {
        const from = callViews.length;
        for (const fn of called) functionCallViews(fn.segments ?? segments, fn, segment, bodyPipe, pipeRead, callBudget, callViews, callSources);
        // Follow calls in added bodies too, with the SAME token budget. A
        // recursive function exhausts that budget rather than recursing JS.
        if (structural) for (let v = from; v < callViews.length && callBudget.tokens <= CALL_VIEW_TOKENS_MAX; v++) {
          const caller = callViews[v];
          const bodyNormalized = normalizeStatement(caller, pipeRead);
          if (bodyNormalized.evalTokens) bodyEvals.push({ caller, normalized: bodyNormalized });
          if (!callsKnownFunction(functions, caller, bodyNormalized)) continue;
          const nestedSources = stdinSourceSpans(caller.stdinView ?? caller, 0);
          if ((caller.pipedFrom ?? null) === null && nestedSources.length === 0) continue;
          for (const nested of calledFunctions(functions, caller, bodyNormalized)) {
            functionCallViews(nested.segments ?? segments, nested, caller, caller.pipedFrom ?? null, pipeRead, callBudget, callViews, nestedSources);
          }
        }
      }
      queueEval(segment, normalized);
      for (const body of bodyEvals) queueEval(body.caller, body.normalized);
      execStdinTokens(segment, execStdin, pipeRead, normalized);
      written.push(segment);
    }
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
  const repeatScopes = [];
  const casePatterns = [];
  // The statement opened with `if`/`elif`/`while`/`until`: a `{` right behind
  // a closing `]]` / `))` starts zsh's short body (#1731 point 2).
  let shortBodyHead = false;
  // The previous token was a command-position `coproc`: bash's named form
  // `coproc NAME { …; }` follows when the word after it is followed by `{`.
  let afterCoproc = false;
  // Fix cycle 1 (MEDIUM 1): `f () { …; }` and `function f () …` — the lexer
  // gives the empty `()` as two subshell separators, so the head reads as the
  // statement `f`. The name is armed at the `)` and stays armed across
  // newlines (`f ()⏎{`); the next body opener opens its body.
  let spacedHead = null;
  let pendingSpacedHead = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const afterClose = closedGroup;
    closedGroup = null;
    const coprocJustDropped = afterCoproc;
    afterCoproc = false;
    const armedHead = spacedHead;
    spacedHead = null;
    // The original lexer may not see `case` behind a redirect prefix. Its
    // pattern-closing `)` then remains a word. Split that extra structural
    // reading here, retaining the original token stream in the legacy pass.
    const casePattern = structural ? casePatterns.at(-1) : null;
    if (casePattern && casePattern.depth === compoundPipes.length) {
      if (casePattern.stage === 'subject' && !tok.operator) casePattern.stage = 'in';
      else if (casePattern.stage === 'in' && !tok.quoted && tok.text === 'in') casePattern.stage = 'pattern';
      else if (casePattern.stage === 'pattern' && tok.subshellSide === 'open') continue;
      else if (casePattern.stage === 'pattern' &&
          (tok.subshellSide === 'close' || (tok.text.endsWith(')') &&
            (!tok.quoted || tok.parts?.at(-1)?.quote === 'none')))) {
        current.push(tok);
        pushSegment(current);
        current = [];
        casePattern.stage = 'body';
        continue;
      } else if (casePattern.stage === 'body' && tok.text === ';' && tokens[i - 1]?.text === ';') {
        casePattern.stage = 'pattern';
      }
    }
    if (!tok.quoted && (tok.operator === 'newline' || operators.has(tok.text))) {
      // tmux's own `\;` command separator reaches here as this `;` operator
      // (the tokenizer keeps an escaped operator unquoted, see tokenizeCommand),
      // so the next tmux command starts a statement of its own: mark it for
      // tmuxChainReading (#1944 points 4/8 follow-up).
      const chainsTmux = tok.operator !== 'newline' && tok.text === ';' && current.length > 0
        && (current.tmuxChain === true || current.some((t) => !t.quoted && programName(t.text) === 'tmux'));
      attachCompoundStdin(segments, current, tokens, i, pipeRead, bareClosers);
      // `f() ( … )`: the head is written as a statement of its own here, and
      // the subshell behind it is the body (#2027 point 2).
      const newlineHead = tok.operator === 'newline' && functionHead(current) ? current : null;
      const subshellHead = tok.subshellSide === 'open' && functionHead(current) ? current
        : tok.subshellSide === 'open' && armedHead !== null ? armedHead : null;
      // `f (` + `)` right behind it: an empty pair after a name is a head.
      const emptyPairName = tok.subshellSide === 'open' && tokens[i + 1]?.subshellSide === 'close'
        ? (structural ? structuralSpacedNames(current) : spacedHeadName(current)) : null;
      if (structural && tok.subshellSide === 'open' && commandPrefix(current).index === current.length) leadingSources = stdinSourceSpans(current, 0);
      if (!(structural && newlineHead !== null)) pushSegment(current);
      // A zsh short `repeat` body is a sublist: `repeat 2 echo A && echo B`
      // prints A B A B (zsh 5.9), so `&&`/`||` keep its scope open (#2036).
      // A newline right after `&&`/`||`/`|` continues the list (zsh 5.9 runs
      // `<<< S repeat 1 true &&⏎ cat` with S), so it keeps the sublist open too.
      const continuesList = tok.operator === 'newline' && !tokens[i - 1]?.quoted &&
        (tokens[i - 1]?.text === '&&' || tokens[i - 1]?.text === '||' || tokens[i - 1]?.text === '|');
      if (structural && tok.text !== '|' && tok.text !== '&&' && tok.text !== '||' && tok.subshellSide !== 'open' && !continuesList) closeRepeats();
      if (tok.subshellSide === 'open') {
        openCompound();
        if (subshellHead !== null) openBody(subshellHead);
        if (emptyPairName !== null) pendingSpacedHead = emptyPairName;
      } else if (tok.subshellSide === 'close') {
        closeCompound();
        if (pendingSpacedHead !== null && tokens[i - 1]?.subshellSide === 'open') spacedHead = pendingSpacedHead;
        pendingSpacedHead = null;
      }
      if (tok.operator === 'newline' && armedHead !== null) spacedHead = armedHead;
      // Fix cycle 2: `f()⏎{ …; }`, `function f⏎{` (a comment between is
      // gone in the lexer): the head before a newline arms the body opener.
      if (tok.operator === 'newline' && newlineHead !== null) spacedHead = newlineHead;
      tmuxNext = chainsTmux;
      if (tok.operator !== 'newline' && tok.text === '|') {
        pipeLeft = current.length > 0 ? current : null;
        // #1940 point 6: a compound statement left of the pipe (`( echo …
        // ) | sh`, `{ echo …; } | sh`, `for …; do echo …; done | sh`) leaves
        // no statement of its own — its closer is not written. Every
        // statement written before it on the line stands in for its body.
        // NAMED CEILING (BV-004): that over-reads statements before the
        // compound (`echo 'git restore .'; (echo hi) | sh` is read as piping
        // both) — a deny-side over-read. REVISIT TRIGGER: a real command
        // denied by it.
        // Fix cycle 1 (C4): redirections behind the closer (`( echo … )
        // 2>/dev/null | sh`) leave a redirect-only statement; the closer is
        // found in front of it. Only a FILE redirect of stdout as its last
        // fd-1 redirect (`>f`, `1>>f`) with no dup, `&>` or fd-path target
        // in the tail (fix cycle 2, 3b: `2>&1 >/dev/fd/2` reaches the pipe)
        // sends no data down the pipe.
        // Fix cycle 2 (F1): the tail itself stays in the body — its
        // here-string and here-doc words (`{ cat; } <<<'S' | sh`) are the
        // compound's stdin, read as data by statementLiteralOutput.
        const tail = redirectOnlyTail(current, tokens, i);
        const prevAt = tail === null ? -1 : i - 1 - tail.length;
        const prev = tail === null ? undefined : tokens[prevAt];
        if (tail !== null && prev !== undefined && (bareClosers.has(prevAt) || (!prev.quoted && (prev.operator === 'subshell' || COMPOUND_CLOSERS.has(prev.text))))) {
          if (!tail.stdoutGone) {
            pipeLeft = Object.defineProperty([], 'compoundBody', { value: bodyView(written) });
          }
        }
        if (pipeLeft !== null) Object.defineProperty(pipeLeft, 'pipeRead', { value: pipeRead, configurable: true });
      }
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
    if (!tok.quoted && tok.text === 'repeat' && (current.length === 0 || compoundPrefix(current)) &&
        count !== undefined && !count.redirect && count.operator === undefined &&
        !operators.has(count.text)) {
      if (structural) {
        // #2036 cause 2: `f() repeat 1 sh` — the repeat scope is the body.
        const head = functionHead(current) ? current : (current.length === 0 ? armedHead : null);
        leadingSources = stdinSourceSpans(current, 0);
        openCompound();
        repeatScopes.push(compoundPipes.length);
        if (head !== null) openBody(head);
      }
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
    // The lexer keeps the opening paren glued in f( ); finish that head
    // before the legacy `function NAME` prefix can consume the closing ).
    if (structural && tok.text === ')' && !tok.quoted && current.length <= 2 &&
        structuralFunctionHead([...current, tok]) !== undefined) {
      current.push(tok);
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
        (current.length === 0 || compoundPrefix(current))) {
      // #2036 cause 2: `f() if …; fi`, `f() while …; done`, `function f until
      // …` — any compound opener is a body, not only `{` (zsh 5.9 and bash).
      const bodyOpener = tok.text === '{' || (structural && COMPOUND_OPENERS.has(tok.text));
      const head = bodyOpener && functionHead(current) ? current
        : bodyOpener && armedHead !== null && current.length === 0 ? armedHead : null;
      if (structural && COMPOUND_OPENERS.has(tok.text)) leadingSources = stdinSourceSpans(current, 0);
      current = [];
      if (ZSH_SHORT_BODY_HEADS.has(tok.text)) shortBodyHead = true;
      if (tok.text === 'coproc') afterCoproc = true;
      if (tok.text === '{') openGroups++;
      if (tok.text === '}') { openGroups = Math.max(0, openGroups - 1); closedGroup = 'hard'; }
      if (COMPOUND_OPENERS.has(tok.text)) openCompound();
      else if (COMPOUND_WORD_CLOSERS.has(tok.text)) {
        if (structural) closeRepeats();
        closeCompound();
      }
      if (head !== null) openBody(head);
      continue;
    }
    // #2027 point 1, zsh reading only (`bareClose`): a bare `}` word inside an
    // open brace group ends the statement and closes the group, as a
    // command-position `}` does — `{ xargs -n 2 git } <<< 'S'` gives the group
    // the here-string (attachCompoundStdin, at the next statement end).
    // Fix cycle 1 (MEDIUM 4): so does a word with a `}` glued to its end (`{
    // xargs -n 2 git}`, `| { sh}`; zsh 5.9 runs both), read here as the word
    // without that `}` and a close, and a one-word group in command position
    // (`| {sh}`): a group of that one word. The default reading keeps the
    // #1707 glued-close reading (the word stripped, the group left open).
    // The default readings only note that such a word occurs (`bareSeen`), so
    // the extra pass runs only for a line that has one (fix cycle 1, HIGH: an
    // ordinary closing `}` of `{ …; }` started it before).
    const plainWord = !tok.quoted && !tok.redirect && tok.operator === undefined;
    // Fix cycle 2: a quoted word counts too — `{ "sh"}` (zsh runs sh) and
    // `{ "sh}" }` lex alike, so both are read as a close (an extra reading).
    // A quoted word holding a `{` is left out: `awk '{print $2}'` and `"${x}"`
    // inside a group would close it falsely (census of fix cycle 2), and no
    // stdin runner's name holds a `{`.
    const anyWord = !tok.redirect && tok.operator === undefined && !(tok.quoted && tok.text.includes('{'));
    const closesBare = anyWord && openGroups > 0 && tok.text.endsWith('}') && (current.length > 0 || tok.text.length > 1);
    const oneWordGroup = plainWord && tok.text.length > 2 && tok.text[0] === '{' && tok.text.endsWith('}') &&
      (current.length === 0 || compoundPrefix(current));
    if (closesBare || oneWordGroup) bareSeen = true;
    if (bareClose && (closesBare || oneWordGroup)) {
      bareClosed = true;
      if (tok.text !== '}') bareClosers.add(i);
      if (oneWordGroup) {
        const head = functionHead(current) ? current : null;
        if (structural) leadingSources = stdinSourceSpans(current, 0);
        current = [];
        openGroups++;
        openCompound();
        if (head !== null) openBody(head);
      }
      const word = oneWordGroup ? tok.text.slice(1, -1) : tok.text.slice(0, -1);
      if (word !== '') current.push({ ...tok, text: word, bareGlued: tok.text !== '}' });
      attachCompoundStdin(segments, current, tokens, i, pipeRead, bareClosers);
      pushSegment(current);
      current = [];
      openGroups--;
      closedGroup = 'hard';
      if (structural) closeRepeats();
      closeCompound();
      repeatCount = false;
      shortBodyHead = false;
      continue;
    }
    // A `{` glued to the first word of a brace group (zsh, #1699 item 13 —
    // repeatedly and on the raw first character since #1707 point 2): drop the
    // openers, so the word behind them is the segment head.
    const glued = gluedBraceOpenerCount(tok);
    if (glued > 0 && (current.length === 0 || compoundPrefix(current))) {
      const head = functionHead(current) ? current : (current.length === 0 ? armedHead : null);
      const { braceLead: _consumed, ...rest } = tok;
      if (structural) leadingSources = stdinSourceSpans(current, 0);
      current = [{ ...rest, text: tok.text.slice(glued) }];
      openGroups += glued;
      for (let g = 0; g < glued; g++) {
        openCompound();
        if (g === 0 && head !== null) openBody(head);
      }
      continue;
    }
    // zsh's short function body `f() cmd` (#1707 point 3): zsh 5.9 runs
    // `f() unlink P; f`, so the head is dropped and `cmd` heads the segment.
    // #2027 point 2: that one statement is the body, so a call reads it.
    // #2036 cause 2: a head before `for`/`select`/`case` gets the whole
    // compound as its body (opened below), beyond the one-statement body.
    const loopOpener = structural && !tok.quoted && !tok.redirect && LOOP_AND_CASE_HEADS.has(tok.text);
    let loopHead = null;
    if (armedHead !== null && current.length === 0 && !tok.redirect && tok.operator === undefined) {
      for (const name of headAliases(armedHead)) defineFunction(name, { start: segments.length, end: segments.length + 1, segments });
      if (loopOpener) loopHead = armedHead;
    }
    if (((current.length === 1 && !current[0].quoted && FUNCTION_HEAD_RE.test(current[0].text)) ||
         (structural && typeof structuralFunctionHead(current) === 'string' &&
           !(current[0]?.text === 'function' && !current[0].quoted))) && !tok.redirect) {
      const name = headName(current);
      if (name !== null) defineFunction(name, { start: segments.length, end: segments.length + 1, segments });
      if (loopOpener) loopHead = current;
      current = [];
    }
    // `function f for …`: the keyword head is no short body above, so the
    // opener check below would see it as the statement's first words.
    if (loopOpener && loopHead === null && current.length > 0 && functionHead(current) &&
        !current[0].quoted && current[0].text === 'function') {
      loopHead = current;
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
    // `for`/`select`/`case` head their own statement (they are no dropped
    // keyword); their body still closes with `done`/`esac`.
    if (!tok.quoted && !tok.redirect && LOOP_AND_CASE_HEADS.has(tok.text) &&
        (current.length === 0 || (structural && commandPrefix(current).index === current.length))) {
      if (structural) {
        leadingSources = stdinSourceSpans(current, 0);
        current = [];
      }
      openCompound();
      if (loopHead !== null) openBody(loopHead);
      if (structural && tok.text === 'case') casePatterns.push({ depth: compoundPipes.length, stage: 'subject' });
    }
    current.push(tok);
  }
  attachCompoundStdin(segments, current, tokens, tokens.length, pipeRead, bareClosers);
  pushSegment(current);
  // Compound tails are attached only after the closing token, so construct
  // command views now, from the final stdinView rather than an early copy.
  for (const { segment, normalized } of commandViews) {
    const source = segment.stdinView ?? segment;
    const sources = stdinSourceSpans(source, 0);
    if (!source.pipedFrom && sources.length === 0 && !pipeRead.viewsCut) continue;
    if (!chargeViewTokens(pipeRead, normalized.words.length + sources.length)) break;
    const view = [...normalized.words, ...sources];
    if (source.pipedFrom) Object.defineProperty(view, 'pipedFrom', { value: source.pipedFrom });
    Object.defineProperty(view, 'pipeRead', { value: pipeRead, configurable: true });
    callViews.push(view);
  }
  // A later compound tail can add stdin after the eager eval reading. Read
  // that added source as well; ordinary statements need no second descent.
  for (const item of evalViews) {
    if ((item.segment.stdinView ?? item.segment) !== item.source) readEval(item.segment, item.tokens);
  }
  return { segments: [...segments, ...markExtra(callViews)].filter((s) => s.length > 0), softCut, bareClosed, bareSeen };
}

/**
 * The function name a definition head declares (`f()`, `function f`,
 * `function f()`), or null for zsh's anonymous `function`.
 *
 * @param {Array<{ text: string }>} head - a segment isFunctionHead accepts
 * @returns {string | null}
 */
function functionHeadName(head) {
  const word = head.length === 2 ? head[1].text : head[0].text;
  if (head.length === 1 && word === 'function') return null;
  return word.endsWith('()') ? word.slice(0, -2) : word;
}

/**
 * The function name of a statement written before an empty `( )` pair (fix
 * cycle 1, MEDIUM 1): `f ()` and `function f ()` — zsh 5.9 and bash run
 * `f () { echo F; }; f`. null when the statement is no bare name.
 *
 * @param {Array<{ text: string, quoted: boolean, redirect?: object }>} current
 * @returns {string | null}
 */
function spacedHeadName(current) {
  const words = current.length === 2 && !current[0].quoted && current[0].text === 'function' ? current.slice(1) : current;
  // Fix cycle 2: a quoted name is a name (`'f' () …` defines f in zsh).
  if (words.length !== 1 || words[0].redirect) return null;
  return literalFunctionName(words[0]) ? words[0].text : null;
}

/** Prefixes recognized by the shared stdin statement normalization (#2033). */
const STDIN_PREFIX_WORDS = new Set(['time', 'noglob', 'nocorrect', 'command', 'builtin', 'eval', 'exec']);
// An append-only statement cannot change a command word already found.
const COMMAND_PREFIX_MEMO = new WeakMap();

/**
 * Read the command position once, skipping redirect spans and assignments.
 * Options are dequoted argv words; exec's -a consumes its attached suffix or
 * the next non-redirect word. Stops at eval: its argv needs shell re-lexing.
 * Also usable on an unfinished prefix at a compound opener: stops at the
 * first command word, so repeated keyword arguments cannot rescan its tail.
 * @param {Array<object>} words
 * @returns {{ index: number, execAt: number, evalAt: number, suppressFunction: boolean }}
 */
function commandPrefix(words) {
  const known = COMMAND_PREFIX_MEMO.get(words);
  if (known) return known;
  const remember = (result) => {
    if (result.index < words.length) COMMAND_PREFIX_MEMO.set(words, result);
    return result;
  };
  let k = 0;
  let execAt = -1;
  let suppressFunction = false;
  let option = null;
  let value = false;
  while (k < words.length) {
    const tok = words[k];
    if (tok.redirect) { k = redirectSpanEnd(words, k) + 1; continue; }
    if (tok.heredocBody) { k++; continue; }
    const text = tok.text;
    if (value) { value = false; k++; continue; }
    if (option) {
      if (text === '--') { option = null; k++; continue; }
      if (option === 'exec' && /^-[cl]*a/.test(text)) {
        value = /^-[cl]*a$/.test(text); k++; continue;
      }
      if ((option === 'exec' && /^-[cl]+$/.test(text)) ||
          (option === 'time' && text === '-p') ||
          (option === 'command' && text === '-p')) { k++; continue; }
      option = null;
    }
    if (isAssignmentWord(tok)) { k++; continue; }
    if (text === 'eval') return remember({ index: k, execAt, evalAt: k, suppressFunction });
    if (!STDIN_PREFIX_WORDS.has(text)) break;
    if (text === 'command' || text === 'builtin') suppressFunction = true;
    if (text === 'exec') execAt = k + 1;
    if (text === 'exec' || text === 'command' || text === 'time' || text === 'builtin') option = text;
    k++;
  }
  return remember({ index: k, execAt: execAt < 0 ? -1 : k, evalAt: -1, suppressFunction });
}

/**
 * A single normalized command view per finished statement, shared by calls,
 * exec and the added stdin-reader view. eval joins argv then re-lexes it;
 * eight layers and the existing shared view-token cap bound that work.
 * The original statement is never replaced. Redirections stay on its stdin
 * view and are appended to the added command view by the splitter.
 * @param {Array<object>} segment
 * @param {ReturnType<typeof newPipeRead>} pipeRead
 * @returns {{ words: Array<object>, changed: boolean, execAt: number, evalTokens?: Array<object> | null, suppressFunction?: boolean, prefixWords: Array<string> }}
 */
function normalizeStatement(segment, pipeRead) {
  let words = segment;
  let prefix = commandPrefix(words);
  const execAt = prefix.execAt;
  let changed = prefix.index > 0;
  let evalTokens = null;
  const prefixWords = [];
  prefixWordNames(words, prefix, prefixWords);
  for (let depth = 0; prefix.evalAt >= 0; depth++) {
    if (depth >= 8 || !chargeViewTokens(pipeRead, words.length)) {
      cutViews(pipeRead);
      return { words: [], changed: true, execAt, prefixWords };
    }
    const argv = argvWordsWithoutRedirects(words, prefix.evalAt + 1).filter((t) => !t.heredocBody);
    if (argv[0]?.text === '--') argv.shift();
    words = tokenizeCommand(argv.map((t) => t.text).join(' '));
    evalTokens ??= words;
    prefix = commandPrefix(words);
    prefixWordNames(words, prefix, prefixWords);
    changed = true;
  }
  return { words: (words === segment ? argvWordsWithoutRedirects(words, prefix.index) : words.slice(prefix.index)).filter((t) => !t.heredocBody), changed, execAt, evalTokens, suppressFunction: prefix.suppressFunction, prefixWords };
}

/**
 * #2036 cause 1: the prefix words commandPrefix skipped, by dequoted text. A
 * function of the same name shadows the builtin (`eval() { sh; }; … | eval`,
 * `'noglob'`, `A=1 'time'`, `builtin eval -- 'exec'` run the function in zsh
 * 5.9 and bash), so the caller also reads each one as a call — a union with
 * the stripped reading, never a replacement. The word right behind `command`
 * or `builtin` stays the builtin and is left out. An `exec -a` value with a
 * prefix word's text is read as well: a deny-side over-read, effective only
 * when a function of that name exists.
 * @param {Array<object>} words
 * @param {ReturnType<typeof commandPrefix>} prefix
 * @param {Array<string>} out - names, extended in place without repeats
 */
function prefixWordNames(words, prefix, out) {
  const end = Math.min(words.length, prefix.evalAt >= 0 ? prefix.evalAt + 1 : prefix.index);
  let suppress = false;
  for (let k = 0; k < end; k++) {
    const tok = words[k];
    if (tok.redirect) { k = redirectSpanEnd(words, k); continue; }
    if (tok.heredocBody || !STDIN_PREFIX_WORDS.has(tok.text)) continue;
    if (!suppress && !out.includes(tok.text)) out.push(tok.text);
    suppress = tok.text === 'command' || tok.text === 'builtin';
  }
}

/**
 * The function bodies a statement may run: every body defined for its call
 * name, and (#2036) for each prefix word naming a function on the line.
 * Distinct body ranges only.
 * @param {Map<string, Array<object>>} functions - name → every body defined for it
 * @param {Array<object>} segment
 * @param {ReturnType<typeof normalizeStatement> | null} normalized
 * @returns {Array<object>}
 */
function calledFunctions(functions, segment, normalized) {
  if (functions.size === 0) return [];
  // The common case is no match: allocate nothing for it.
  let out = null;
  const add = (name) => {
    const bodies = name === undefined ? undefined : functions.get(name);
    if (bodies === undefined) return;
    out ??= new Set();
    for (const fn of bodies) out.add(fn);
  };
  add(callName(segment, normalized));
  for (const name of normalized?.prefixWords ?? []) add(name);
  return out === null ? [] : [...out];
}

/**
 * Whether a statement names a function defined on the line, by its call name
 * or a prefix word: O(prefix words), no body is touched.
 * @param {Map<string, Array<object>>} functions
 * @param {Array<object>} segment
 * @param {ReturnType<typeof normalizeStatement> | null} normalized
 * @returns {boolean}
 */
function callsKnownFunction(functions, segment, normalized) {
  if (functions.size === 0) return false;
  if (functions.has(callName(segment, normalized))) return true;
  return (normalized?.prefixWords ?? []).some((name) => functions.has(name));
}

/**
 * Part-aware bash/zsh function head; undefined means no head, null the zsh
 * anonymous `function`. Quotes may cover the name, never the () syntax.
 * Append-only name validation is memoized because the statement is growing.
 * @param {Array<object>} head
 * @returns {string | null | undefined}
 */
function structuralFunctionHead(head) {
  if (head.length === 0) return undefined;
  const keyword = !head[0].quoted && head[0].text === 'function';
  const from = keyword ? 1 : 0;
  if (from === head.length) return null;
  const tok = head[from];
  if (tok.redirect || tok.operator) return undefined;
  const tail = tok.parts?.at(-1);
  const bareSuffix = (suffix) => tok.text.endsWith(suffix) && (!tok.quoted || (tail?.quote === 'none' && tail.text.endsWith(suffix)));
  if (head.length === from + 1 && bareSuffix('()') && literalFunctionName(tok, 2)) return tok.text.slice(0, -2);
  if (head.length === from + 2 && bareSuffix('(') && head[from + 1].text === ')' &&
      !head[from + 1].quoted && literalFunctionName(tok, 1)) return tok.text.slice(0, -1);
  if (keyword && literalHeadWords(head, 1)) return head[1].text;
  return undefined;
}

/** Literal quotes protect metacharacters; double quotes still expand $ and `. */
function literalFunctionName(tok, suffix = 0) {
  if (!tok || tok.redirect || tok.operator) return false;
  // #2036 cause 3: an empty quoted word is a name of its own (`function f ''
  // g { sh; }` defines f, '' and g in zsh 5.9; `''` then calls it), so it no
  // longer voids the other names of the head. Only quotes make an empty word
  // (the lexer leaves `quoted` false on it), so no further check is needed.
  if (suffix === 0 && tok.text.length === 0) return true;
  if (tok.text.length <= suffix) return false;
  let left = tok.text.length - suffix;
  for (const part of tok.parts ?? [{ text: tok.text, quote: tok.quoted ? 'single' : 'none' }]) {
    const text = part.text.slice(0, left);
    left -= text.length;
    if (part.quote === 'none' && /[\s()$`'"=<>|&;{}]/.test(text)) return false;
    if (part.quote === 'double' && /[$`]/.test(text)) return false;
    if (left === 0) break;
  }
  return true;
}

// A head grows one word at a time. Validate each appended word once, avoiding
// an O(N²) scan for `function f1 f2 … fN { … }`.
const LITERAL_HEAD_MEMO = new WeakMap();
function literalHeadWords(head, from) {
  let memo = LITERAL_HEAD_MEMO.get(head);
  if (!memo || memo.from !== from) {
    memo = { from, end: from, valid: true };
    LITERAL_HEAD_MEMO.set(head, memo);
  }
  while (memo.valid && memo.end < head.length) memo.valid = literalFunctionName(head[memo.end++]);
  return memo.valid && head.length > from;
}

/** Only used once at the empty parenthesis pair or the body opener. */
function structuralSpacedNames(head) {
  const from = head[0]?.text === 'function' && !head[0].quoted ? 1 : 0;
  return literalHeadWords(head, from) ? { names: head.slice(from).map((t) => t.text) } : null;
}
function structuralHeadNames(head) {
  if (head.names) return head.names;
  if (head[0]?.text === 'function' && !head[0].quoted && literalHeadWords(head, 1)) {
    return head.slice(1).map((t) => t.text);
  }
  const name = structuralFunctionHead(head);
  return name === undefined ? null : [name];
}

/** Words before a function name that still run the function (fix cycle 1, MEDIUM 2). */
const CALL_PREFIX_WORDS = new Set(['time', 'noglob', 'nocorrect', 'eval']);

/**
 * The name a statement calls when it runs a function (fix cycle 1, MEDIUM 2):
 * leading assignments (`x=1 f`), `time` (with `-p` / `--`), zsh's
 * `noglob` / `nocorrect` and `eval` (`eval f`, `eval 'f'`) are skipped,
 * and a quoted name or prefix compares by its text (`'f'` runs `f`, `'eval' f`
 * and `$'noglob' f` run it too; fix cycle 2). Measured with
 * `echo` only, zsh 5.9 and bash: these run the function, while `command f`,
 * `builtin f` and `nice f` do not.
 *
 * @param {Array<{ text: string, quoted: boolean, redirect?: object }>} segment
 * @returns {string | undefined}
 */
function callName(segment, normalized = null) {
  if (normalized) return normalized.suppressFunction ? undefined : normalized.words[0]?.text;
  let k = 0;
  while (k < segment.length) {
    const tok = segment[k];
    if (tok.redirect) { k = redirectSpanEnd(segment, k) + 1; continue; }
    if (isAssignmentWord(tok)) { k++; continue; }
    if (CALL_PREFIX_WORDS.has(tok.text)) {
      k++;
      if (tok.text === 'time') while (k < segment.length && !segment[k].quoted && (segment[k].text === '-p' || segment[k].text === '--')) k++;
      continue;
    }
    return tok.text;
  }
  return undefined;
}

/** The stdin redirect modes a call or an `exec` hands on (fd-agnostic, as pipedShellData reads them, #2014). */
const STDIN_SOURCE_MODES = new Set(['herestring', 'heredoc', 'read']);

/**
 * The redirect spans of `segment` that feed a stdin source on any fd
 * (here-string, here-document, `<`, `< <(…)`), as tokens.
 *
 * @param {Array<object>} segment
 * @param {number} from
 * @returns {Array<object>}
 */
function stdinSourceSpans(segment, from) {
  const out = [];
  for (let k = from; k < segment.length; k++) {
    const tok = segment[k];
    if (!tok.redirect) continue;
    const end = redirectSpanEnd(segment, k);
    if (STDIN_SOURCE_MODES.has(tok.redirect.mode)) out.push(...segment.slice(k, end + 1));
    k = end;
  }
  return out;
}

/**
 * #2027 point 4: an `exec` with only redirections (`exec 3<<< 'S'`, `exec <<<
 * 'S'`, `exec 3<<'E'`) opens its stdin sources for the REST of the shell, so
 * every later statement of the line may read them (`exec 3<<< 'S'; xargs git
 * <&3`). Read fd-agnostic, like pipedShellData since #2014: a source on any
 * fd counts as stdin of every later statement, which pushSegment hands on as
 * that statement's `stdinView`.
 *
 * NAMED CEILING (BV-004): no scope is judged — an `exec` inside a subshell or
 * a pipeline element, and an fd closed again (`exec 3<&-`), still feed every
 * later statement: a deny-side over-read. REVISIT TRIGGER: a real command
 * denied by it.
 *
 * Every later statement copies the sources into its view, so their tokens are
 * capped at EXEC_STDIN_TOKENS_MAX per line: past it the line's pipe reading
 * is marked spent and every stdin reader of the line fails closed
 * (pipedShellData `unreadable`), which keeps the copies linear.
 *
 * @param {Array<object>} segment - the statement just written
 * @param {Array<object>} execStdin - the line's exec sources, extended in place
 * @param {ReturnType<typeof newPipeRead>} pipeRead
 */
function execStdinTokens(segment, execStdin, pipeRead, normalized = null) {
  const at = execArgvStart(segment, normalized);
  if (at < 0) return;
  if (argvWordsWithoutRedirects(segment, at).some((t) => !t.heredocBody)) return;
  const spans = stdinSourceSpans(segment, 0);
  if (execStdin.length + spans.length > EXEC_STDIN_TOKENS_MAX) {
    cutViews(pipeRead);
    return;
  }
  execStdin.push(...spans);
}

/** Words before `exec` that still run the exec builtin (fix cycle 2; measured with `echo`, bash and zsh). */
const EXEC_PREFIX_WORDS = new Set(['command', 'builtin', 'noglob', 'nocorrect', 'time']);

/**
 * Where the argv of an `exec` statement starts, or -1 when the statement runs
 * no `exec` (#2027 fix cycle 2). Leading redirections (`<<< 'S' exec`) and
 * assignments (`A=1 exec`) are skipped, so are `command`, `builtin`,
 * `noglob`, `nocorrect` and `time` before it, and `exec` compares by its
 * dequoted text (`'exec'`, `$'exec'`); its own options `--`, `-c`, `-l` and
 * `-a NAME` (bash and zsh both take a value for `-a`) are skipped behind it.
 *
 * @param {Array<{ text: string, quoted: boolean, redirect?: object }>} segment
 * @returns {number}
 */
function execArgvStart(segment, normalized = null) {
  if (normalized) return normalized.execAt;
  let k = 0;
  while (k < segment.length) {
    const tok = segment[k];
    if (tok.redirect) { k = redirectSpanEnd(segment, k) + 1; continue; }
    if (isAssignmentWord(tok) || EXEC_PREFIX_WORDS.has(tok.text) || (k > 0 && segment[k - 1].text === 'time' && tok.text === '-p')) { k++; continue; }
    break;
  }
  if (k >= segment.length || segment[k].text !== 'exec') return -1;
  k++;
  while (k < segment.length && !segment[k].redirect) {
    const text = segment[k].text;
    if (text === '--') return k + 1;
    if (/^-[cl]+$/.test(text)) { k++; continue; }
    if (/^-[cl]*a$/.test(text)) { k += 2; continue; }
    break;
  }
  return k;
}

/** The most exec source tokens one line hands on (execStdinTokens). */
const EXEC_STDIN_TOKENS_MAX = 64;

/** The most tokens the function-call views of one line may copy (#2027 point 2). */
const CALL_VIEW_TOKENS_MAX = 4096;

/**
 * #2027 point 2: a function body reads the stdin of its CALL — `f() { xargs -n
 * 2 git; }; f <<< 'S'` and `… | f` run `git S`, in zsh and bash alike. For a
 * call (a statement headed by the name of a function defined earlier on the
 * line) that has a pipe or a stdin source, each body statement is added once
 * more as a view: its tokens, then the call's stdin sources, piped from the
 * call's pipe (a body pipeline keeps its own pipe, re-pointed to the view of
 * its left statement). The body statements themselves stay as they are.
 *
 * Every view's tokens are charged to `budget`; past CALL_VIEW_TOKENS_MAX no
 * view is added and the line's pipe reading is marked spent, so every stdin
 * reader of the line fails closed (pipedShellData `unreadable`).
 *
 * NAMED CEILING (BV-004): a call is recognised only as the head word of a
 * statement after its definition. #2033 additionally reads the normalized
 * prefix and nested body calls within the same token budget, #2036 each
 * skipped prefix word that names a function (calledFunctions); external wrappers
 * (`sudo f`), function output/positionals, and calls with only the
 * stdin of a compound around them (`{ f; } <<< 'S'`). REVISIT TRIGGER: a
 * reported discard through one of these call forms.
 *
 * @param {Array<Array<object>>} segments - the statements written so far
 * @param {{ start: number, end: number | null }} fn - the body range
 * @param {Array<object>} caller - the call statement
 * @param {Array<object> | null} callerPipe - the pipe the call reads
 * @param {ReturnType<typeof newPipeRead>} pipeRead
 * @param {{ tokens: number }} budget
 * @param {Array<Array<object>>} out - the views, extended in place
 * @param {Array<object> | null} [callSources] - the call stdin sources, when the caller scanned them once
 */
function functionCallViews(segments, fn, caller, callerPipe, pipeRead, budget, out, callSources = null) {
  if (budget.tokens > CALL_VIEW_TOKENS_MAX) return;
  // Passed in by a caller that visits several bodies: scanning the call once
  // keeps bodies × call length out of the cost (#2036 delta review).
  const sources = callSources ?? stdinSourceSpans(caller.stdinView ?? caller, 0);
  if (callerPipe === null && sources.length === 0) return;
  // Every visited body costs at least one unit, so empty ranges (`g() { }`)
  // cannot repeat this walk without ever spending the budget (#2036).
  budget.tokens += 1;
  if (budget.tokens > CALL_VIEW_TOKENS_MAX) {
    cutViews(pipeRead);
    return;
  }
  const views = new Map();
  for (let i = fn.start; i < (fn.end ?? segments.length); i++) {
    const stmt = segments[i];
    if (stmt.length === 0) continue;
    budget.tokens += stmt.length + sources.length;
    if (budget.tokens > CALL_VIEW_TOKENS_MAX) {
      cutViews(pipeRead);
      return;
    }
    const view = [...(stmt.stdinView ?? stmt), ...sources];
    const pipe = stmt.pipedFrom ? (views.get(stmt.pipedFrom) ?? stmt.pipedFrom) : callerPipe;
    if (pipe) Object.defineProperty(view, 'pipedFrom', { value: pipe });
    Object.defineProperty(view, 'pipeRead', { value: pipeRead, configurable: true });
    views.set(stmt, view);
    out.push(view);
  }
}

// Public alias — the single source of truth for chain-segment splitting shared
// with hooks/pre-bash-destructive-guard.mjs (W4 B1; internal call sites keep
// the short name).
export { splitSegments as splitChainSegments };

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Whether a word is a `NAME=value` assignment prefix. Bash decides this on the
 * UNQUOTED `NAME=` run at the word start; quotes in the VALUE do not matter.
 * Reading `tok.quoted` instead made `x=$(echo "a") bash -c "…"` resolve the
 * assignment itself as the verb, and the real verb after it was never read.
 * `text` overrides the word text for an expanded reading (the `parts` still
 * describe the source word, whose `NAME=` run no expansion can produce).
 *
 * @param {{ text: string, quoted: boolean, parts?: Array<{ text: string, quote: string }> }} tok
 * @param {string} [text]
 * @returns {boolean}
 */
function isAssignmentWord(tok, text = tok.text) {
  if (!ENV_ASSIGN_RE.test(text)) return false;
  if (!tok.quoted) return true;
  const first = tok.parts?.[0];
  return first !== undefined && first.quote === 'none' && ENV_ASSIGN_RE.test(first.text);
}

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
 *   - commandString:  util-linux `script -c/--command <string>` — the value is
 *                     a shell command line, collected as a recursion payload
 *                     wherever it stands in the wrapper's argv (#1933).
 *   - requiresFlag:   a wrapper only when one of its option words matches
 *                     (`runuser -u USER CMD`); without it the wrapper itself
 *                     is the resolved verb (#1944 F4).
 *   - subcommand:     the one verb word that makes the wrapper delegate
 *                     (`machinectl shell`); options may stand before and
 *                     after it. Any other first non-option word leaves the
 *                     wrapper itself as the resolved verb (#1944 F4).
 *
 * Unknown single-token flags (`-i`, `--foreground`, attached forms like `-o0`
 * / `-n19`, legacy `nice -10`, `--user=root`) are skipped generically; `--`
 * ends option parsing. Deliberately NOT listed:
 *   - `su`   — interpreter (SHELL_EXEC_INTERPRETERS), its `-c` payload executes;
 *   - `xargs` — interpreter; unwrapping it would LOOSEN the guard;
 *   - `flock` / `ionice` — scope cut (#982, operator-approved; `setsid` lifted #1944 point 8).
 *
 * `time` IS listed (merge of the #970 here-doc line of work): the here-doc
 * design's safety argument is that a body fed to an interpreter still matches
 * because `bash` is in SHELL_EXEC_INTERPRETERS — that only holds when `bash`
 * is the RESOLVED verb, so `sudo bash <<EOF` / `time bash <<EOF` must unwrap.
 * This table is ALSO the alignment target for the ledger-guard's
 * `VERB_PREFIXES` copy (see #991) — do not fork a second wrapper list.
 *
 * Exported so downstream guards (ledger) can converge on the same table.
 *
 *   - shellCommandReader: a wrapper that does NOT delegate to an argv verb but
 *                     runs one or more SHELL-COMMAND STRINGS (`tmux new-session
 *                     -d '<cmd>'` hands `<cmd>` to `/bin/sh -c`). The reader is
 *                     called with the redirect-free argv after the wrapper word
 *                     and returns the command strings; they are collected as
 *                     recursion payloads and the segment resolves to `verb:
 *                     null` (nothing after the wrapper is a plain argv verb).
 */

/** tmux commands whose trailing argument is a shell-command string run via `/bin/sh -c` (#1944 point 8). */
const TMUX_SHELL_COMMANDS = new Set([
  'new-session', 'new', 'new-window', 'neww', 'split-window', 'splitw',
  'respawn-pane', 'respawnp', 'respawn-window', 'respawnw', 'run-shell', 'run', 'if-shell', 'if',
  // `display-popup [-BCEkN] [-b …] [-c …] [-d …] [-e …] [-h …] … [shell-command]`
  // and `pipe-pane [-IOo] [-t …] [shell-command]` run their trailing string too.
  'display-popup', 'popup', 'pipe-pane', 'pipep',
]);

/** tmux global options that take a separate value word (`tmux -L sock new …`). */
const TMUX_GLOBAL_VALUE = new Set(['-f', '-L', '-S', '-T']);

/**
 * The shell-command strings a `tmux` invocation runs (#1944 point 8), as
 * recursion payloads. tmux hands these to `/bin/sh -c`: `tmux new-session -d
 * '<cmd>'`, `tmux new-window '<cmd>'`, `tmux run-shell '<cmd>'`, and the global
 * `tmux -c '<cmd>'` (tmux as a command runner). The grammar is `tmux [global
 * opts] command [command opts] [shell-command]`.
 *
 * Global options are skipped first — the value-taking ones (`-f -L -S -T`)
 * consume their word, `-c` is itself a shell-command. Then, for a command in
 * {@link TMUX_SHELL_COMMANDS}, the command's own options are read BOTH ways
 * (each unknown option as a boolean AND as value-taking, the watch(1) union):
 * every resulting start position yields `words.slice(start)` joined, so the
 * single shell-command token is never missed whatever the real option arity.
 * This runs for EVERY command of a `;`-chained sequence ({@link
 * tmuxCommandGroups}); a chain the shell split at `\;` is read by
 * {@link tmuxChainReading}.
 *
 * NAMED CEILING (BV-004): `send-keys`/`send` is NOT read — it types literal
 * keystrokes into a pane, not a `/bin/sh -c` string; the eventual shell is the
 * pane's, outside this command. Reading an option VALUE as a command line
 * (`new-session -s '<name>' …` where `<name>` spells a verb) is an over-read
 * toward deny, accepted. REVISIT TRIGGER: a transcript of `send-keys` carrying
 * a destructive line, or a real tmux command denied by the option-value read.
 *
 * @param {Array<{ text: string }>} words - redirect-free argv after `tmux`
 * @returns {string[]}
 */
function tmuxCommandStrings(words) {
  const out = [];
  const add = (slice) => {
    const s = slice.map((t) => t.text).join(' ');
    if (s !== '' && !out.includes(s)) out.push(s);
  };
  let g = 0;
  while (g < words.length) {
    const t = words[g].text;
    if (t === '--') { g++; break; }
    if (t === '-c') { if (words[g + 1] !== undefined) add([words[g + 1]]); g += 2; continue; }
    if (TMUX_GLOBAL_VALUE.has(t)) { g += 2; continue; }
    if (t.startsWith('-') && t !== '-') { g++; continue; }
    break;
  }
  for (const group of tmuxCommandGroups(words.slice(g))) {
    if (group.length === 0 || !TMUX_SHELL_COMMANDS.has(group[0].text)) continue;
    // watch(1)-style union over the command's options: every start an unknown
    // option could leave is collected, so the shell-command token is never lost.
    const starts = new Set();
    const seen = new Set();
    const todo = [1];
    while (todo.length > 0) {
      const i = todo.pop();
      if (seen.has(i)) continue;
      seen.add(i);
      const t = group[i]?.text;
      if (t === undefined) continue;
      if (t === '--') { starts.add(i + 1); continue; }
      if (!t.startsWith('-') || t === '-') { starts.add(i); continue; }
      todo.push(i + 1, i + 2); // the option as a boolean AND as value-taking
    }
    for (const s of starts) if (s < group.length) add(group.slice(s));
  }
  return out;
}

/**
 * Split a tmux command sequence into its commands (#1944 points 4/8 follow-up).
 * tmux chains commands on its own command line with a `;` ARGUMENT: the shell
 * spells it `\;` or `';'` (both reach the guard as the word `;`, measured with
 * tokenizeCommand), and a word that ENDS in `;` (`-d\;`, `'sleep 1;'`) ends
 * its command after the text before the `;`. `tmux new -d \; run-shell 'S'`
 * runs S, which the first-command-only reading missed.
 *
 * A word ending in a literal backslash-semicolon (`"\;"`, `"foo\;"`) is tmux's
 * ESCAPED semicolon — a literal `;`, not a separator — in tmux's own docs; it
 * is read BOTH ways (split and kept), so neither arity reading is lost.
 *
 * @param {Array<{ text: string }>} words - argv from the first tmux command on
 * @returns {Array<Array<{ text: string }>>} the commands, each a word list
 */
function tmuxCommandGroups(words) {
  const groupings = [];
  for (const splitEscaped of [false, true]) {
    const groups = [[]];
    for (const w of words) {
      const t = w.text;
      const escaped = t.endsWith('\\;');
      if (!t.endsWith(';') || (escaped && !splitEscaped)) { groups[groups.length - 1].push(w); continue; }
      const head = t.slice(0, t.length - (escaped ? 2 : 1));
      if (head !== '') groups[groups.length - 1].push({ ...w, text: head });
      groups.push([]);
    }
    groupings.push(...groups);
  }
  return groupings;
}

/**
 * The reading of a statement that follows a tmux statement across `;` and
 * starts with a tmux shell command (#1944 points 4/8 follow-up): the shell's
 * `\;` is split as an operator by the tokenizer (fail-closed for `watch`/`ssh`
 * runners), so `tmux new -d \; run-shell 'S'` arrives as `tmux new -d` and
 * `run-shell 'S'`. The second statement is tmux's next command; its
 * shell-command strings are its payloads and it resolves no verb.
 *
 * NAMED CEILING (BV-004): a REAL `;` cannot be told apart from an escaped one
 * here, so `tmux ls; run-shell 'S'` (where the shell runs a `run-shell`
 * program) is read the same way — a deny-side over-read. REVISIT TRIGGER: a
 * real command denied by it.
 *
 * @param {Array<object>} segment
 * @returns {object|null} a resolveCore-shaped reading, or null
 */
function tmuxChainReading(segment) {
  if (segment.tmuxChain !== true) return null;
  const words = argvWordsWithoutRedirects(segment);
  if (words.length === 0 || !TMUX_SHELL_COMMANDS.has(words[0].text)) return null;
  return { verb: null, index: -1, payloads: tmuxCommandStrings(words), wrapperArgs: [], sawUnknownFlag: false, sawScriptDashDash: false, scriptWrite: null };
}

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
  // `builtin` and zsh's precommand modifiers run the next word in the same
  // shell. Without these rows the verb read as the modifier, so `- eval '…'`,
  // `noglob bash -c '…'` and `nocorrect git clean -fdx` hid their payload or
  // subcommand (#1892, measured ALLOW on 2026-10-31). None takes options.
  ['builtin', {}],
  ['noglob', {}],
  ['nocorrect', {}],
  ['-', {}],
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
  // macOS launch wrappers (#1932 point 2). Without these rows the wrapper read
  // as the verb, so `caffeinate git clean -fdx` and `taskpolicy -b bash -c
  // 'git reset --hard'` matched nothing (measured ALLOW at 0637a681). Grammar
  // measured on macOS 2026-11-03 (man pages + harmless `echo` runs):
  // caffeinate `-d -i -m -s -u` are booleans, `-t secs` / `-w pid` take a value.
  ['caffeinate', {
    argFlags: new Set(['-t', '-w']),
  }],
  // taskpolicy `-b -B -a -s -x -X` are booleans; options after the program
  // belong to the program, which the non-dash break already honours.
  ['taskpolicy', {
    argFlags: new Set(['-d', '-g', '-c', '-p', '-m', '-j', '-P', '-S', '-t', '-l']),
  }],
  // arch `-arm64` / `-x86_64` / `-32` / `-64` are booleans. arch does NOT accept
  // `--`; the generic `--` skip still consumes it, which can only move the verb
  // onto a real command word (over-read toward deny, accepted).
  ['arch', {
    argFlags: new Set(['-arch', '-d', '-e']),
  }],
  ['sandbox-exec', {
    argFlags: new Set(['-f', '-n', '-p', '-D']),
  }],
  // xcrun `-f/--find` only looks a tool up; unwrapping it can only add a deny.
  // The single-dash spellings take a value too (review measurement on this
  // host, 2026-11-03: `xcrun -n -sdk macosx echo …` and `xcrun -toolchain
  // default echo …` run `echo`; `--sdk=macosx` is rejected).
  ['xcrun', {
    argFlags: new Set(['--sdk', '--toolchain', '-sdk', '-toolchain']),
  }],
  // `script` (#1933 point 3) has two grammars, both measured 2026-11-03:
  //  - BSD/macOS 27.0.1 `script [-aeFkpqr] [-t time] [file [command ...]]`:
  //    the command is positional after the typescript file (`script -q
  //    /dev/null git clean -fdx`); `-t secs` and `-T fmt` take a value.
  //  - util-linux 2.39.3 `script [options] [file]`: the command is the
  //    `-c`/`--command` string (`script -qc 'git clean -fdx' /dev/null`),
  //    getopt also permutes it behind the file; `-I -O -B -T -m -E -o` and
  //    their long forms take a value, `-t[file]` only glued.
  // `positionals: 1` skips the file, so the BSD command resolves as the verb;
  // `commandString` collects every `-c`/`--command` value as a payload, on
  // both sides of the file (resolveCore). Over-reads only add denies: `-t` is
  // value-taking for BSD (on Linux it takes no separate value), `-p` playback
  // runs nothing, the BSD form errors on Linux and `-c` is illegal on macOS.
  // With no command at all `script` starts an interactive `$SHELL`, which
  // reads a pipe as its script — pipedShellData reads that form.
  ['script', {
    argFlags: new Set([
      '-t', '-T', '-I', '-O', '-B', '-m', '-E', '-o',
      '--log-in', '--log-out', '--log-io', '--log-timing', '--logging-format', '--echo', '--output-limit',
    ]),
    commandString: true,
    positionals: 1,
  }],
  // polkit `pkexec [--keep-cwd] [--user U] [--disable-internal-agent]
  // PROGRAM [ARGS…]` runs PROGRAM as U (#1944 F4): a transparent wrapper like
  // sudo, so `pkexec sh -c '…'` resolves to `sh` and its payload is read.
  ['pkexec', {
    argFlags: new Set(['--user']),
  }],
  // util-linux `runuser [opts] -u USER [[--] CMD [ARGS…]]` runs an argv, not a
  // string (#1944 F4): only with `-u`/`--user` is runuser a wrapper. Its other
  // form `runuser [opts] [-] [USER [ARGS…]]` (`-c S`, `--command=S`) is su's,
  // read by suCommandStrings — without `-u` the wrapper stays the verb.
  ['runuser', {
    argFlags: new Set([
      '-u', '-g', '-G', '-s', '-w',
      '--user', '--group', '--supp-group', '--shell', '--whitelist-environment',
    ]),
    // getopt groups and long-option prefixes count too (#1944 F4 review):
    // `-pu root`, `-Pmu root` (u after value-less letters only — in `-gu` the
    // `u` is -g's value) and `--u`/`--us`/`--use`/`--user`[=…], the unique
    // prefixes of --user. Missing one left runuser the verb and unread.
    requiresFlag: /^(?:-[flmpPhV]*u.*|--u(?:s(?:er?)?)?(?:=.*)?)$/s,
  }],
  // systemd `machinectl [opts] shell [opts] [[USER@]MACHINE [PROGRAM [ARGS…]]]`
  // (#1944 F4). machinectl stops option parsing behind the machine name for
  // the `shell` verb only, so PROGRAM and its words are a plain argv: the row
  // unwraps `shell` plus one machine positional, every other verb (`list`,
  // `start`, …) stays the verb `machinectl`.
  // NAMED CEILING (BV-004): only `shell` is read. `machinectl login` is
  // interactive and `machinectl run`/`systemd-run --machine` are not
  // unwrapped. REVISIT TRIGGER: a transcript running a destructive command
  // through another machinectl or systemd-run verb.
  ['machinectl', {
    argFlags: new Set([
      '-p', '-s', '-H', '-M', '-o', '-n', '-E',
      '--property', '--signal', '--kill-whom', '--host', '--machine', '--output',
      '--lines', '--setenv', '--uid', '--format', '--max-addresses', '--verify',
    ]),
    subcommand: 'shell',
    positionals: 1,
  }],
  // util-linux `setsid [-c] [-f] [-w] PROGRAM [ARGS…]` runs PROGRAM in a new
  // session (#1944 point 8): a transparent argv wrapper like `nohup`, so
  // `setsid sh -c '…'` resolves to `sh` and `setsid -f git reset --hard` to
  // `git`. Its three options (`-c`/`--ctty`, `-f`/`--fork`, `-w`/`--wait`) take
  // no value, so the generic boolean skip resolves PROGRAM. Lifting the #982
  // scope cut for setsid only — `flock`/`ionice` stay out (below).
  ['setsid', {}],
  // BusyBox `busybox APPLET [ARGS…]` runs the applet as the verb (#1944 point
  // 8): a transparent wrapper with no options before the applet, so `busybox
  // rm -fr src` resolves to `rm` and `busybox sh -c '…'` / `busybox ash -c
  // '…'` to the shell (`ash` is in DASH_C_SHELLS). `busybox` alone or `busybox
  // --list` resolves no verb.
  ['busybox', {}],
  // GNU `screen [opts] [PROGRAM [ARGS…]]` runs PROGRAM as an argv, not through
  // a shell (#1944 point 8): a transparent wrapper, so `screen -dm sh -c '…'`
  // resolves to `sh` and `screen -dmS name git reset --hard` to `git`. The
  // value-taking options are listed so PROGRAM resolves in parse A; a combined
  // group (`-dmS name`) is covered by the #1000 value-taking parse B. The
  // many boolean options (`-d -m -D -R -r -A -q -l -L -U -a -4 -6 -v -O -G -x`)
  // skip generically. `screen -X <cmd>` (send a command to a running session)
  // is not special-cased: `-X` is read as an unknown flag, which only loosens
  // toward resolving a later verb.
  ['screen', {
    argFlags: new Set(['-c', '-e', '-h', '-p', '-S', '-s', '-T', '-t']),
  }],
  // `tmux [global opts] command [opts] [shell-command]` runs the shell-command
  // through `/bin/sh -c` (#1944 point 8) — NOT an argv verb, so it is read with
  // a shellCommandReader that collects those strings as recursion payloads
  // (tmuxCommandStrings). `tmux ls`, `tmux new-session -d` (no command) and
  // `tmux attach` resolve no payload.
  ['tmux', {
    shellCommandReader: tmuxCommandStrings,
  }],
  // Left out on purpose (#1932 point 2):
  //   `flock` / `ionice` — the #982 scope cut named above (setsid lifted in #1944 point 8);
  //   `chrt` / `unbuffer` / `chronic` — not installed on the measuring host, grammar unmeasured.
]);
// Homebrew coreutils install GNU tools under a `g` prefix with the same grammar:
// the alias points at the SAME spec object, so the two can never drift (#1932).
for (const [alias, base] of [['gtimeout', 'timeout'], ['gnice', 'nice'], ['gstdbuf', 'stdbuf'], ['gnohup', 'nohup'], ['genv', 'env']]) {
  WRAPPER_UNWRAP.set(alias, WRAPPER_UNWRAP.get(base));
}

/**
 * util-linux `--command` and the abbreviations getopt_long accepts for it —
 * `--co` is unique among the long options of both `script` and `su`.
 */
const COMMAND_LONG_OPTION_RE = /^--c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?(?:=|$)/;

/** util-linux `script --append` and its getopt_long abbreviations (`--a` is unique). */
const SCRIPT_APPEND_LONG_RE = /^--a(?:p(?:p(?:e(?:n(?:d)?)?)?)?)?$/;

/** A `script` short-option group of value-less letters only (BSD `-adeFkpqr`, util-linux `-aefqhV`). */
const SCRIPT_BOOLEAN_GROUP_RE = /^-[adeFfkpqrhV]+$/;

/**
 * `script` options whose value is a log file it writes: util-linux `-I/-O/-B`
 * (`--log-in/--log-out/--log-io`), `-T`/`--log-timing`. BSD `-T fmt` is read
 * the same way — one more written file can only keep a deny.
 */
const SCRIPT_LOG_FILE_FLAGS = new Set(['-I', '-O', '-B', '-T', '--log-in', '--log-out', '--log-io', '--log-timing']);

/** env's `-S` behind its boolean letters (`-i`, `-0`, `-v`), #1940 point 1. */
const SPLIT_STRING_SHORT_RE = /^-[0iv]*S/;

/** One word in shell single quotes. */
function shellQuoteWord(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** env -S escapes that stand for one character (macOS env(1), FreeBSD-derived, 2026-11-03). */
const ENV_SPLIT_ESCAPES = Object.freeze({ f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '#': '#', $: '$', '"': '"', "'": "'", '\\': '\\' });

/**
 * Split an `env -S` string with env's own grammar (fix cycle 1, R-F5), read
 * from the macOS env(1) manual page (2026-11-03; GNU coreutils documents the
 * same escapes): blanks split outside quotes; `'…'` keeps all but `\'`/`\\`;
 * `"…"` reads every escape; `\_` is a separator outside quotes and a blank
 * inside double quotes; `\c` ends the string (outside double quotes); `#`
 * starting a new word ends it; `\f \n \r \t \v \# \$ \" \' \\` stand for their
 * character; `${NAME}` is the variable's value inserted unsplit.
 * The words come back shell-quoted for the payload recursion: a `${NAME}`
 * stays a double-quoted shell expansion (`"${NAME}"`), exactly the unknown
 * the shell reading of `bash -c` has — the hook adds a fail-closed name test
 * for it (unreadForcedDiscard). Returns null when env itself rejects the
 * string (an unterminated quote, an unknown escape): env then runs nothing.
 * A tab or newline from an escape splits here (env keeps it inside the word):
 * a deny-side over-read.
 *
 * @param {string} text
 * @returns {string[]|null} shell-quoted words
 */
function envSplitString(text) {
  const words = [];
  let word = null; // null: between words
  let quote = null;
  let lit = ''; // literal characters of the current word not yet quoted
  const put = (s) => { word ??= ''; lit += s; };
  const seal = () => { if (lit !== '') { word += shellQuoteWord(lit); lit = ''; } };
  const end = () => { if (word !== null) { seal(); words.push(word === '' ? "''" : word); word = null; } };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") { quote = null; continue; }
      if (ch === '\\' && (text[i + 1] === "'" || text[i + 1] === '\\')) { put(text[++i]); continue; }
      put(ch);
      continue;
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return null;
      i++;
      if (next === '_') {
        if (quote === '"') put(' ');
        else end();
        continue;
      }
      if (next === 'c') {
        if (quote === '"') return null;
        break;
      }
      if (!(next in ENV_SPLIT_ESCAPES)) return null;
      const value = ENV_SPLIT_ESCAPES[next];
      if (quote === null && (value === '\t' || value === '\n')) { end(); continue; }
      put(value);
      continue;
    }
    if (ch === '$' && text[i + 1] === '{') {
      const close = text.indexOf('}', i + 2);
      if (close === -1) return null;
      const name = text.slice(i + 2, close);
      word ??= '';
      seal();
      word += `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `"\${${name}}"` : shellQuoteWord('${' + name + '}')}`;
      i = close;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else put(ch);
      continue;
    }
    if (ch === ' ' || ch === '\t') { end(); continue; }
    if (ch === '#' && word === null) break;
    if (ch === "'" || ch === '"') { quote = ch; word ??= ''; continue; }
    put(ch);
  }
  if (quote !== null) return null;
  end();
  return words;
}
/** `--split-string` and its getopt_long abbreviations, with or without `=value`. */
const SPLIT_STRING_LONG_RE = /^--s(?:p(?:l(?:i(?:t(?:-(?:s(?:t(?:r(?:i(?:n(?:g)?)?)?)?)?)?)?)?)?)?)?(?:=|$)/;

/** util-linux `script` long options that take no value and write no file. */
const SCRIPT_BOOLEAN_LONG_RE = /^--(?:quiet|flush|force|return|help|version)$/;

/**
 * Whether a `script` wrapper truncates a file (#1933 fix cycle 1, Codex HIGH):
 * BSD and util-linux `script` OVERWRITE their typescript (default
 * `typescript`, the positional FILE otherwise) unless `-a` appends; BSD `-p`
 * plays a recording back and writes nothing. `/dev/null` is no file. A log
 * file option (`-B log`) writes too. Such a `script` keeps a reading of its
 * own (flagReadings), so `script notes.md grep git restore` — which empties
 * `notes.md` — stays denied as before the unwrapping, while the
 * search-only exemption and the path-less lift of wrappedRestoreMatch still
 * apply to `script -q /dev/null grep git restore`.
 *
 * `-a` exempts the typescript only (#1933 fix cycle 2, Codex HIGH): util-linux
 * opens its timing log (`-T`/`--log-timing`) with truncation whatever `-a`
 * says (term-utils/script.c), so `script -a -T notes.md /dev/null …` still
 * empties `notes.md`. Every log option naming a file therefore counts as a
 * write, `-a` or not — over-reading the appended `-O`/`-B` logs only keeps a
 * deny.
 *
 * Every other option word counts as a write too (#1933 fix cycle 3): glued
 * log files (`-t<file>`, `-Blog`), abbreviated long log options
 * (`--log-t=f`) and options the table does not know are not read one by one;
 * only the boolean letters, the boolean long options and `-a`/`--append`
 * drop script's own reading. NAMED CEILING (BV-004): this over-reads value
 * options that write nothing (`-E auto`, `-m advanced`, BSD `-t 0`), which
 * only keeps a deny; 0 of 22,905 replay commands use `script` at all
 * (2026-11-03). REVISIT TRIGGER: a replay census or report of a harmless
 * `script` call denied by it.
 *
 * @param {string|null} file - the positional typescript word, null when absent
 * @param {boolean} appends - `-a`/`--append` or BSD `-p` seen
 * @param {boolean} logWrites - a log file option with a value other than `/dev/null`
 * @returns {boolean}
 */
function scriptTypescriptWritten(file, appends, logWrites) {
  if (logWrites) return true;
  return !appends && file !== '/dev/null';
}

/**
 * The util-linux `script` command option at `segment[j]` (#1933 point 3):
 * `--command=S`, `--command S`, `-c S`, a short group ending in `c` (`-qc S`,
 * `-qec S`), or a short group with `c` inside, whose rest is the glued value
 * (`-c'S'`). `width` is the number of tokens the option owns; `payload` is
 * null when the value is missing. Null when the token is no command option.
 *
 * @param {Array<{ text: string }>} segment
 * @param {number} j
 * @returns {{ payload: string|null, width: number } | null}
 */
function scriptCommandOption(segment, j) {
  const text = segment[j].text;
  const next = segment[j + 1]?.text ?? null;
  if (COMMAND_LONG_OPTION_RE.test(text)) {
    const eq = text.indexOf('=');
    if (eq > 0) return { payload: text.slice(eq + 1), width: 1 };
    return { payload: next, width: next === null ? 1 : 2 };
  }
  if (text.startsWith('--') || !/^-[A-Za-z]*c/.test(text)) return null;
  const at = text.indexOf('c');
  if (at === text.length - 1) return { payload: next, width: next === null ? 1 : 2 };
  return { payload: text.slice(at + 1), width: 1 };
}

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
function resolveCore(segment, unknownFlagsTakeValue, readMarker = true, scriptDashDashCommand = false) {
  const payloads = [];
  const wrapperArgs = [];
  let sawUnknownFlag = false;
  // #1933 fix cycle 1: the `script` reading state (scriptTypescript).
  let commandStringsScanned = false;
  let sawScriptDashDash = false;
  let scriptWrite = null;
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
    if (i < segment.length && isAssignmentWord(segment[i])) { i++; continue; }
    break;
  }
  while (i < segment.length) {
    i = argvVerbAt(i);
    if (i >= segment.length) break;
    const wrapper = programName(segment[i].text); // basename, folded (#1955)
    const spec = WRAPPER_UNWRAP.get(wrapper);
    if (!spec) break;
    i++; // consume the wrapper word
    if (spec.shellCommandReader) {
      // `tmux '<cmd>'` (#1944 point 8): the wrapper runs shell-command STRINGS,
      // not an argv verb — collect them as payloads and resolve no verb, so the
      // recursion (matchSegments check 3, the guard's reading.payloads readers)
      // judges each string.
      for (const p of spec.shellCommandReader(argvWordsWithoutRedirects(segment, i))) {
        if (!payloads.includes(p)) payloads.push(p);
      }
      return { verb: null, index: -1, payloads, wrapperArgs, sawUnknownFlag, sawScriptDashDash, scriptWrite };
    }
    let sawShellFlag = false;
    const wrapperAt = i - 1;
    // `script` options that make it write no typescript (scriptTypescript).
    let scriptAppends = false;
    let scriptLogWrites = false;
    let scriptDashDash = false;
    // `machinectl shell`: whether the delegating verb word was read.
    let sawSubcommand = false;
    let otherSubcommand = false;
    let sawRequiredFlag = false;
    const wrapperArgsAt = wrapperArgs.length;
    if (spec.commandString && !commandStringsScanned) {
      // getopt permutes, so a `-c` string may stand behind the file (`script
      // /dev/null -c '…'`): every command option of the rest of the segment is
      // a payload. One behind a BSD command word belongs to that command — an
      // extra payload there can only add a deny.
      // NAMED CEILING (BV-004, #1940 point 8): the scan also takes the `-c`
      // of the command script runs (`script -q /dev/null grep -c 'git
      // checkout -- .' f` is denied) — an over-deny; 0 of 22,905 replay
      // commands (2026-11-03). REVISIT TRIGGER: a real command denied by it.
      // ONE scan per segment (#1933 fix cycle 1, Codex MED): it reaches the
      // segment's end, so it already holds the options of every nested
      // `script` behind this one — rescanning per wrapper was quadratic
      // (`'script /dev/null '.repeat(16000)` took ~4.5 s per call).
      commandStringsScanned = true;
      for (let j = i; j < segment.length; j++) {
        const cmd = scriptCommandOption(segment, j);
        if (cmd === null) continue;
        if (cmd.payload !== null && !payloads.includes(cmd.payload)) payloads.push(cmd.payload);
        j += cmd.width - 1;
      }
    }
    while (i < segment.length) {
      const tok = segment[i];
      const text = tok.text;
      if (spec.envAssignments && isAssignmentWord(tok, text)) { i++; continue; }
      if (text === '--') {
        i++;
        scriptDashDash = Boolean(spec.commandString);
        // env(1) and sudo read `NAME=VALUE` words after `--` too (#1957 fix
        // cycle 3): `env -- GIT_CONFIG_KEY_0=… git z` runs git, and the
        // assignment was read as the verb.
        while (spec.envAssignments && i < segment.length && isAssignmentWord(segment[i])) i++;
        break;
      }
      // env's bare `-` is `-i` (#1957 fix cycle 3): `env - X=1 git z` runs git.
      if (spec.splitString && text === '-') { i++; continue; }
      if (spec.commandString) {
        if (/^-[A-Za-z]+$/.test(text)) {
          // Letters before a glued `-c` value only (`-qac S`, not `-cap`).
          const letters = text.includes('c') ? text.slice(1, text.indexOf('c')) : text.slice(1);
          if (/[ap]/.test(letters)) scriptAppends = true;
        } else if (SCRIPT_APPEND_LONG_RE.test(text)) {
          scriptAppends = true;
        }
        const cmd = scriptCommandOption(segment, i);
        if (cmd !== null) { i += cmd.width; continue; }
        // The boolean letters of both grammars (BSD `-adeFkpqr`, util-linux
        // `-aefqhV`) take no value; read as unknown, parse B took the FILE as
        // their value and the next word as the file (`script -q /dev/null grep
        // …` would have truncated a file named `grep`).
        if (SCRIPT_BOOLEAN_GROUP_RE.test(text)) { i++; continue; }
        const eq = text.indexOf('=');
        // A short group ending in a log letter takes the next word (`-aT notes.md`).
        const logFlag = eq > 0 ? text.slice(0, eq) : /^-[A-Zabd-z]*[IOBT]$/.test(text) ? `-${text.at(-1)}` : text;
        if (SCRIPT_LOG_FILE_FLAGS.has(logFlag)) {
          const value = eq > 0 ? text.slice(eq + 1) : segment[i + 1]?.text;
          if (value !== '/dev/null') scriptLogWrites = true;
        } else if (text.startsWith('-') && text !== '-' && !SCRIPT_APPEND_LONG_RE.test(text)
            && !SCRIPT_BOOLEAN_LONG_RE.test(text)) {
          // Fail-closed (#1933 fix cycle 3, Codex HIGH): an option word read as
          // none of the above — a glued log file (`-Tnotes.md`, `-tnotes.md`,
          // `-Blog`), an abbreviated long log option (`--log-t=notes.md`), or
          // any option this table does not know — may name a file `script`
          // truncates, so it counts as a write. That only keeps script's own
          // reading: a deny-side over-read on value options such as `-E auto`
          // or `-t 0`.
          scriptLogWrites = true;
        }
      }
      if (spec.requiresFlag?.test(text)) sawRequiredFlag = true;
      if (spec.subcommand && !sawSubcommand && !text.startsWith('-')) {
        if (text !== spec.subcommand) { otherSubcommand = true; break; }
        sawSubcommand = true;
        i++;
        continue;
      }
      if (!text.startsWith('-') || text === '-') break;
      // #1940 point 1: a short group ending its boolean letters in `S`
      // (`-iS`, `-0vS'…'`) and an abbreviated long option (`--split=…`,
      // `--s …`; GNU getopt_long, the only long option starting with `s`) are
      // the split string too. Before, `env -iS 'git checkout -- a'` resolved
      // the quoted string itself as the verb.
      const shortSplit = SPLIT_STRING_SHORT_RE.exec(text);
      const longSplit = SPLIT_STRING_LONG_RE.test(text);
      if (spec.splitString && (shortSplit !== null || longSplit)) {
        // env(1) APPENDS the remaining argv to the split string: `env -S bash
        // -c '…'` runs `bash -c '…'`, not `bash` (#1366). Collecting only the
        // operand made the trailing `-c '…'` execute unseen — the segment then
        // resolved to `verb: 'echo x > CLAUDE.md'` (the quoted payload read as
        // the verb) and neither the match surface nor the redirect surface ever
        // saw it. So the payload is the operand PLUS every remaining token, and
        // the wrapper CONSUMES the segment: nothing is left to resolve as a
        // verb, which is why this now yields `verb: null, index: -1`.
        let operand = null;
        if (longSplit && text.includes('=')) {
          operand = text.slice(text.indexOf('=') + 1);
          i++;
        } else if (shortSplit !== null && text.length > shortSplit[0].length) {
          operand = text.slice(shortSplit[0].length); // attached form: -S'string', -iS'string'
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
          // Fix cycle 1 (R-F5): env splits the string with ITS grammar, not
          // the shell's (`git\_checkout\_-f` is three words). Its argv is
          // added as a second, shell-quoted reading — union, never weaker.
          // Without a backslash both grammars split the string alike (blanks,
          // quotes, `#`, `${…}`), so the second reading is only built for one.
          const split = operand.includes('\\') ? envSplitString(operand) : null;
          if (split !== null) {
            const line = [...split, ...rest.map(shellQuoteWord)].join(' ');
            if (line !== '' && !payloads.includes(line)) payloads.push(line);
          }
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
        // An empty-expansion copy lost its `$` (#1908 point 2): its value is unknown.
        if (segment[i + 1]?.expanded === true) entry.expanded = true;
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
          if (segment[i].expanded === true) entry.expanded = true;
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
    if (spec.commandString) {
      // util-linux 2.43 `script [options] [file] -- command [argument…]`
      // (#1933 fix cycle 1, r3 F5): after `--` the words ARE the command, no
      // file in between (`script -- git clean -fdx`); BSD reads the word
      // after `--` as the file. Both readings are judged: this parse is the
      // BSD one unless `scriptDashDashCommand` (flagReadings' extra parse).
      if (scriptDashDash) sawScriptDashDash = true;
      const takesFile = !(scriptDashDash && scriptDashDashCommand);
      const file = takesFile && i < segment.length ? segment[i].text : null;
      if (takesFile && i < segment.length) i++;
      // `script FILE -- command`: the `--` before the command is no verb.
      if (takesFile && segment[i]?.text === '--') i++;
      if (scriptWrite === null && scriptTypescriptWritten(file, scriptAppends, scriptLogWrites)) scriptWrite = wrapperAt;
    } else if ((spec.subcommand && (otherSubcommand || !sawSubcommand)) || (spec.requiresFlag && !sawRequiredFlag)) {
      // Not the delegating verb (`machinectl list`) or form (`runuser USER
      // -c S`): the wrapper is the verb.
      wrapperArgs.length = wrapperArgsAt;
      i = wrapperAt;
      break;
    } else {
      for (let p = spec.positionals ?? 0; p > 0 && i < segment.length; p--) i++;
    }
    if (sawShellFlag) {
      // `sudo -i CMD ARGS…` / `sudo -s CMD ARGS…` hand CMD and its words to the
      // target shell's `-c` (#1944 F4), so the joined words are a payload, as
      // a `sh -c` string is: `sudo -u root -i 'git rm -f a.txt'` was allowed
      // while `sudo sh -c '…'` was denied. sudo escapes the words before it
      // joins them, so a single quoted word is one command name to the shell —
      // reading it as a command line is an over-read toward deny, accepted.
      // Without a command (`sudo -i`) the shell is interactive: no payload.
      const words = argvWordsWithoutRedirects(segment, i);
      if (words.length > 0) {
        const line = words.map((t) => t.text).join(' ');
        if (!payloads.includes(line)) payloads.push(line);
      }
      return { verb: 'sh', index: i, payloads, wrapperArgs, sawUnknownFlag, sawScriptDashDash, scriptWrite };
    }
  }
  i = argvVerbAt(i);
  if (i >= segment.length) return { verb: null, index: -1, payloads, wrapperArgs, sawUnknownFlag, sawScriptDashDash, scriptWrite };
  return {
    verb: programName(segment[i].text),
    index: i,
    payloads,
    wrapperArgs,
    sawUnknownFlag,
    sawScriptDashDash,
    scriptWrite,
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
  const cores = [a];
  // parse B — unknown flags take a value
  if (a.sawUnknownFlag) cores.push(resolveCore(segment, true, readMarker));
  // util-linux `script … -- command` (#1933 fix cycle 1): the words after
  // `--` are the command, where parse A read the first as the BSD file.
  if (cores.some((c) => c.sawScriptDashDash)) cores.push(resolveCore(segment, false, readMarker, true));
  const readings = [];
  const add = (r) => {
    if (!readings.some((o) => o.verb === r.verb && o.index === r.index)) readings.push(r);
  };
  for (const c of cores) add(stripCore(c));
  // A `script` that truncates a file keeps its own reading (scriptTypescriptWritten):
  // the verb before #1933 unwrapped it, so every verdict the old reading gave stays.
  for (const c of cores) {
    if (c.scriptWrite !== null) add({ verb: 'script', index: c.scriptWrite, payloads: [], wrapperArgs: [] });
  }
  return readings;
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
  const chained = tmuxChainReading(segment);
  const readings = chained !== null ? [chained] : verbReadings(segment);
  const out = readings.length === 1 ? { ...readings[0] } : { ...readings[0], alt: readings[1] };
  Object.defineProperty(out, 'readings', { value: readings, enumerable: false });
  return out;
}

/**
 * Shell verbs whose `-c <payload>` argument is a command line the shell will
 * execute — recursion candidates for matchSegments (#982). `su` participates
 * (`su root -c '…'`); the payload token is the one following `-c` or a bundled
 * short-flag group ending in `c` (`-lc`, `-ec`). `ash` (BusyBox) and `fish`
 * read a `-c` string the bash way (#1944 point 8).
 */
const DASH_C_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'su', 'runuser', 'sg']);

/**
 * The su-like verbs of DASH_C_SHELLS (#1944 F4): they hand a command string to
 * another user's (or group's) shell and are read by {@link suCommandStrings},
 * never by the shell grammar, which stops at their USER / GROUP word. The hook
 * copies (pre-bash-destructive-guard.mjs `SU_LIKE_SHELLS`, codex-apply-patch-guard.mjs
 * `SU_LIKE_VERBS`, pre-bash-staging-fence.mjs and pre-bash-sessions-ledger-guard.mjs
 * `SU_LIKE_SHELLS`) must list the same verbs; so must the three hook copies of
 * `DASH_C_SHELLS` the set above. tests/hooks/dash-c-shells-parity.test.mjs checks both.
 */
const SU_LIKE_SHELLS = new Set(['su', 'runuser', 'sg']);

/**
 * Long shell options that take the NEXT word as their value (`--rcfile f`,
 * `--init-file f`). bash's only value-taking long options are these two
 * (#1797 7b: `bash --rcfile /dev/null -c '…'` read `/dev/null` as the command
 * string and allowed the payload). The short value letters `o`/`O` are read
 * per option group in {@link shellCommandString}.
 */
// zsh `--emulate sh` (#1933 fix cycle 1, r3 F4) takes a value too: read as
// the script file, `echo 'S' | zsh --emulate sh` left the pipe unread.
// dash and ksh93 have no value-taking long option (`-o`/`-O` are read per group).
const SHELL_LONG_OPTIONS_WITH_VALUE = new Set(['--rcfile', '--init-file', '--emulate']);

/**
 * The command string of a `bash|sh|zsh|dash|ksh` call, or null when it runs
 * no `-c` string (Codex review C2; moved here from the destructive guard as
 * the one SSOT, #1832 point 5). With `c` anywhere in an option group (`-c`,
 * `-ce`, `-ec`, `-xc`, and the `+` forms `+c`, `+ec` — bash, zsh and sh all
 * run `+c '…'` as a command string, #1797 7c), the FIRST operand after ALL
 * options is the command string — options may follow `-c` (`bash -c -e '…'`);
 * `--rcfile`/`--init-file` consume the next word; `--` and a lone `-` end the
 * options.
 *
 * Value letters inside a `-`/`+` option group (#1833 review Q3; measured with
 * bash 5.3, bash 3.2 as sh, zsh 5.9 on 2026-11-01):
 *  - bash/sh/dash: EVERY `o` and `O` letter consumes ONE following word,
 *    in letter order — `-co pipefail 'P'`, `-oc pipefail 'P'`, `-cO extglob
 *    'P'`, `-coO pipefail extglob 'P'` all run `P`.
 *  - zsh (`opts.zsh`): `o` takes the REST of its group as the option name,
 *    or the next word when it is the group's last letter (`-co pipefail 'P'`
 *    runs `P`); `O` is a plain flag — `zsh -cO 'P' x` and `zsh -c -O 'P' x`
 *    run `P`, where bash would run `x`.
 *  - ksh (`opts.ksh`; measured with ksh 93u+ on 2026-11-01): an `o` that is
 *    the group's LAST letter consumes the next word (`-co pipefail 'P'` runs
 *    `P`); an `o` followed by more letters takes the REST of the group as the
 *    option name and consumes no word, but a `c` in that rest still sets `-c`
 *    (`-oc 'P'`, `-eoc 'P'`, `-coc 'P'` run `P`; `-oc pipefail 'P'` runs
 *    `pipefail`; `-copipefail 'P'` runs `P`). `-oec`/`-coe` error in ksh and
 *    are read as `-c` set (fail-closed). `O` is a plain flag (`-cO x 'P'`
 *    runs nothing in ksh).
 *
 * @param {Array<{ text: string }>} words - argv after the shell verb (redirect spans removed)
 * @param {{ zsh?: boolean, ksh?: boolean }} [opts] - read the option groups as zsh / ksh does
 * @returns {string|null}
 */
export function shellCommandString(words, { zsh = false, ksh = false } = {}) {
  let hasC = false;
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    if (text === '--' || text === '-') return hasC ? (words[i + 1]?.text ?? null) : null;
    if (SHELL_LONG_OPTIONS_WITH_VALUE.has(text)) { i++; continue; }
    if (text.startsWith('--')) continue; // other long options (`--norc`, `--login`) take no value
    if (/^[-+][A-Za-z]+$/.test(text)) {
      for (let k = 1; k < text.length; k++) {
        const letter = text[k];
        if (letter === 'c') hasC = true;
        else if (zsh && letter === 'o') {
          if (k === text.length - 1) i++;
          break; // the rest of the group is the option name
        } else if (ksh && letter === 'o') {
          if (k === text.length - 1) i++;
          else if (text.slice(k + 1).includes('c')) hasC = true;
          break; // the rest of the group is the option name
        } else if (!zsh && !ksh && (letter === 'o' || letter === 'O')) i++;
      }
      continue;
    }
    return hasC ? text : null;
  }
  return null;
}

/**
 * The command strings `su` runs (#1944). su hands `-c S` on to the target
 * user's shell wherever it stands — `su -c S`, `su USER -c S`, `su - USER
 * -c S` (util-linux and BSD alike) — so every short-option group ending in
 * `c` takes the next word, and a glued value (`-cS`, `-lcS`) is read too.
 * util-linux `--command[=]S` and `--session-command[=]S` (#1933 point 3:
 * the glued `=` value is one token, so a boundary match missed it) run a
 * string as well. Position-free on purpose: an option that is not su's only
 * over-reads, which can add a deny, never lift one. One grammar for the
 * pattern matcher (dashCPayloads) and the destructive guard's own readers,
 * which had no su reading at all: `su -c 'git rm -f a.txt'` over a changed
 * file was allowed while `bash -c` was denied.
 *
 * util-linux `runuser` shares this grammar (`runuser USER -c S`, `-l`, `-`,
 * `--command=S`, #1944 F4); its `-u USER -- CMD` form runs an argv, not a
 * string, and is read by the unquoted text as before. shadow `sg [-] [GROUP
 * [-c] COMMAND]` runs COMMAND with /bin/sh even WITHOUT `-c`, so for `sg` the
 * word behind the group is a command string too (`verb` = `'sg'`).
 *
 * @param {Array<{ text: string }>} words - argv after `su` (redirect spans removed)
 * @param {string} [verb] - the su-like verb (`su`, `runuser`, `sg`)
 * @returns {string[]}
 */
export function suCommandStrings(words, verb = 'su') {
  // fish has its own grammar (#1944 points 4/8 follow-up). Routed through this
  // EXPORT so the destructive guard reaches it without a new required export
  // (its loader's HEAD-copy check would disable the guard until committed).
  if (verb === 'fish') return fishCommandStrings(words);
  const out = [];
  const add = (value) => { if (value !== undefined && !out.includes(value)) out.push(value); };
  if (verb === 'sg') {
    const operands = words.filter((t) => t.text !== '-');
    if (operands.length > 1 && !operands[0].text.startsWith('-') && !/^-[A-Za-z]*c$/.test(operands[1].text)) {
      // `sg GROUP COMMAND`: sg runs the one word; further words are an over-read.
      add(operands[1].text);
      add(operands.slice(1).map((t) => t.text).join(' '));
    }
  }
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    // Review F1: behind USER (or `--`) su hands the rest to the login shell,
    // which reads `-cl 'S'`, `-ce 'S'` and `-c -l 'S'` with its own grammar.
    // The login shell may be bash, zsh (`-cO S x`) or ksh, and `+c` sets `c`
    // too (re-review N1): the union of the three readings.
    if (/^[-+][A-Za-z]*c[A-Za-z]*$/.test(text)) {
      for (const shell of [{}, { zsh: true }, { ksh: true }]) add(shellCommandString(words.slice(i), shell) ?? undefined);
    }
    if (/^-[A-Za-z]*c$/.test(text)) { add(words[i + 1]?.text); continue; }
    const glued = /^-[A-Za-z]*?c(.+)$/s.exec(text);
    if (glued !== null) { add(glued[1]); continue; }
    if (COMMAND_LONG_OPTION_RE.test(text) || /^--session-command(?:=|$)/.test(text)) {
      const eq = text.indexOf('=');
      add(eq > 0 ? text.slice(eq + 1) : words[i + 1]?.text);
    }
  }
  return out;
}

/**
 * The command strings a `fish` call runs (#1944 points 4/8 follow-up). fish
 * parses its options with getopt_long (fish(1): `-c`/`--command=COMMANDS`,
 * `-C`/`--init-command=COMMANDS`), so unlike bash the command string is the
 * VALUE of the option: `-c S`, glued `-cS` / `-lcS`, `--command S`,
 * `--command=S`, and the same for `-C` / `--init-command`, which runs S before
 * the `-c` string. getopt_long accepts an unambiguous long-option prefix
 * (`--comm=S`, `--ini=S`). The bash reading of {@link shellCommandString} is
 * unioned in, so no string read before is lost.
 *
 * Position-free on purpose (fish stops at its first operand): an option word
 * behind a script name, or a letter another short option would take as its
 * value (`-dc S`), is over-read toward deny.
 *
 * NAMED CEILING (BV-004): fish is not installed on the measuring host; the
 * grammar follows the fish(1) option table, not a run. REVISIT TRIGGER: a
 * fish option that runs a string and is not listed here.
 *
 * @param {Array<{ text: string }>} words - argv after `fish` (redirect spans removed)
 * @returns {string[]}
 */
function fishCommandStrings(words) {
  const out = [];
  const add = (value) => { if (value !== undefined && value !== null && !out.includes(value)) out.push(value); };
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = text.slice(2, eq > 0 ? eq : undefined);
      const runs = (name.length >= 1 && 'command'.startsWith(name)) || (name.length >= 3 && 'init-command'.startsWith(name));
      if (runs) add(eq > 0 ? text.slice(eq + 1) : words[i + 1]?.text);
      continue;
    }
    const short = /^-[A-Za-z]*?[cC](.*)$/s.exec(text);
    if (short !== null) add(short[1] !== '' ? short[1] : words[i + 1]?.text);
  }
  add(shellCommandString(words));
  return out;
}

/**
 * Collect `-c`-style payload strings after the verb within a segment.
 *
 * UNION of two readings (#1832 point 5): the loose scan (any `-…c` group, the
 * next token) and, for every verb except the su-like ones ({@link suCommandStrings}
 * reads `su`/`runuser`/`sg`), the shell grammar of {@link shellCommandString} over the
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
  for (let i = verbIndex + 1; i < segment.length; i++) {
    const text = segment[i].text;
    if (i < segment.length - 1 && /^-[A-Za-z]*c$/.test(text)) payloads.push(segment[i + 1].text);
  }
  if (SU_LIKE_SHELLS.has(verb) || verb === 'fish') {
    for (const p of suCommandStrings(argvWordsWithoutRedirects(segment, verbIndex + 1), verb)) {
      if (!payloads.includes(p)) payloads.push(p);
    }
  }
  if (!SU_LIKE_SHELLS.has(verb)) {
    // Both shell readings of a glued close (#1832 G1): `bash -c 3>&-x 'P'` runs
    // `x` in bash and `P` in zsh.
    for (const bash of [true, false]) {
      const payload = shellCommandString(argvWordsWithoutRedirects(segment, verbIndex + 1, { bash }), { zsh: verb === 'zsh', ksh: verb === 'ksh' });
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
      // `tok.data`: the word carries a closed `$( … )` that held a here-doc
      // body (#1908 point 1) — the body is stdin data, never argv text.
      if (tok.quoted || tok.data) {
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
 * Whether a shell called with these argv words reads its script from stdin
 * (#1933 point 4): no `-c` string and no script-file operand, or `-s`.
 * `o`/`O` and `--rcfile`/`--init-file` take a value as in bash; reading a
 * zsh/ksh `o` group the bash way can only hide an operand, i.e. read MORE data
 * as a script — the deny direction.
 *
 * @param {Array<{ text: string }>} words - argv after the shell verb (redirect spans removed)
 * @returns {boolean}
 */
function shellReadsStdin(words) {
  let hasS = false;
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    if (text === '--' || text === '-') return hasS || i + 1 >= words.length;
    if (SHELL_LONG_OPTIONS_WITH_VALUE.has(text)) { i++; continue; }
    if (text.startsWith('--')) continue;
    if (/^[-+][A-Za-z]+$/.test(text)) {
      for (const letter of text.slice(1)) {
        if (letter === 'c') return false; // a `-c` string: check 3 reads it
        if (letter === 's') hasS = true;
        else if (letter === 'o' || letter === 'O') i++;
      }
      continue;
    }
    // `sh /dev/stdin`, `bash /dev/fd/0`, `sh /proc/self/fd/0` name stdin as
    // the script file (#1933 fix cycle 1, r3 F4).
    if (STDIN_SCRIPT_FILE_RE.test(text)) return true;
    return hasS; // a script-file operand
  }
  return true;
}

/**
 * Whether a command line may pipe data into a shell whose words only escape
 * decoding or a printf conversion spell out (`printf 'git cl\145an -fd' | sh`):
 * a `|` or `<<<`, a backslash or `%`, and a word ending in `sh` or `script`.
 * A cheap SUPERSET test (#1933 fix cycle 1, r3 F3) for the prefilter of
 * commandMatchesBlocked and the past-cap fallback of matchSegments check 4.
 *
 * @param {string} text
 * @returns {boolean}
 */
function pipesEncodedData(text) {
  return /\||<<</.test(text) && /[\\%]/.test(text) && /(?:sh|script)\b/.test(text);
}

/** A script-file operand that is the shell's own stdin. */
const STDIN_SCRIPT_FILE_RE = /^\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/;

/** Single-letter escapes printf, `%b`, `echo -e` and zsh's echo decode alike. */
const PRINTF_LETTER_ESCAPES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };

/**
 * Decode the backslash escapes of printf/echo data (#1933 fix cycle 1, r3 F3),
 * measured with bash 5.3.20 and zsh 5.9 on 2026-11-03:
 *  - `format-bash`: a printf format in bash — `\NNN` octal (1–3 digits, so
 *    `\0101` is `\010` + `1`), `\xHH`, letter escapes; `\c` stays literal.
 *  - `format-zsh`: the same in zsh, whose printf stops all output at `\c`.
 *  - `b`: a `%b` argument — `\0NNN` and `\NNN` octal, `\c` stops all output.
 *  - `echo`: `echo -e`, zsh's echo, macOS `/bin/sh` echo — `\0NNN` octal only
 *    (`\101` stays literal), `\c` stops.
 * `\uHHHH`/`\UHHHHHHHH` decode in every mode (bash 4.2+); an unknown escape
 * keeps its backslash.
 *
 * @param {string} text
 * @param {'format-bash'|'format-zsh'|'b'|'echo'} mode
 * @returns {{ text: string, stopped: boolean }}
 */
function decodeDataEscapes(text, mode) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\' || i + 1 >= text.length) { out += text[i]; continue; }
    const next = text[i + 1];
    if (next === 'c') {
      if (mode === 'format-bash') { out += '\\c'; i++; continue; }
      return { text: out, stopped: true };
    }
    if (PRINTF_LETTER_ESCAPES[next] !== undefined) { out += PRINTF_LETTER_ESCAPES[next]; i++; continue; }
    let m = null;
    if (next === '0' && (mode === 'b' || mode === 'echo')) m = /^0([0-7]{0,3})/.exec(text.slice(i + 1, i + 5));
    else if (/[0-7]/.test(next) && mode !== 'echo') m = /^([0-7]{1,3})/.exec(text.slice(i + 1, i + 4));
    if (m) { out += String.fromCharCode(parseInt(m[1] || '0', 8) & 0xff); i += m[0].length; continue; }
    const hex = next === 'x' ? /^[0-9A-Fa-f]{1,2}/.exec(text.slice(i + 2, i + 4))
      : next === 'u' ? /^[0-9A-Fa-f]{1,4}/.exec(text.slice(i + 2, i + 6))
        : next === 'U' ? /^[0-9A-Fa-f]{1,8}/.exec(text.slice(i + 2, i + 10)) : null;
    if (hex) {
      const code = parseInt(hex[0], 16);
      out += code <= 0x10ffff ? String.fromCodePoint(code) : '';
      i += 1 + hex[0].length;
      continue;
    }
    out += '\\';
  }
  return { text: out, stopped: false };
}

/**
 * One printf conversion: zsh's positional `n$`, flags, width, precision
 * (`*` or zsh's `*n$`), conversion letter.
 */
const PRINTF_CONVERSION_RE = /%(?:(\d+)\$)?([-+ #0']*)(\*(?:\d+\$)?|\d+)?(?:\.(\*(?:\d+\$)?|\d*))?([A-Za-z%])/y;

/**
 * The output cap of renderPrintf, padding excluded. NAMED CEILING (BV-004):
 * past it the rendered text is cut and the render is not exact, so the raw
 * format and arguments are judged as well (pipelineLiteralData). REVISIT
 * TRIGGER: a real printf piped into a shell whose output exceeds 1 MiB.
 */
const PRINTF_OUTPUT_CAP = 1 << 20;

/**
 * The longest padding renderPrintf writes (#1933 fix cycle 2, Codex HIGH): a
 * pad is blanks only and never forms a word, so `%1048576s` renders as 8
 * blanks — the words after it stay in the rendered text instead of the cap
 * stopping the render before them (and 50,000 huge pads stay cheap).
 */
const PRINTF_PAD_CAP = 8;

/**
 * Render `printf FORMAT ARG…` as the shell does (#1933 fix cycle 1, Codex MED
 * + r3 F2): `%s`, `%b`, `%c`, `%d/%i/%u/%o/%x/%X`, `%%`, flags, width and
 * precision (`*` from the arguments); arguments are consumed in order, the
 * format is REUSED while arguments remain, a missing argument is empty (`0`
 * for a number). `exact` is false when a conversion cannot be rendered
 * (`%q`, `%f`, an unknown letter): the caller then judges the raw text too.
 * A negative `*` precision counts as none, a negative `*` width left-justifies
 * (POSIX, bash 5.3 and zsh 5.9 measured 2026-11-03).
 * zsh's positional `%n$s` / `*n$` (#1933 fix cycle 2) take argument n of the
 * current pass, and a pass consumes up to its highest n (`printf '%1$s|' a b`
 * prints `a|b|` in zsh). bash rejects them; rendering them in both modes only
 * adds data. A format mixing positional and plain conversions, or naming an
 * argument past the last, is not exact.
 *
 * @param {string} format
 * @param {string[]} args
 * @param {'format-bash'|'format-zsh'} mode - decodeDataEscapes mode of the format
 * @returns {{ text: string, exact: boolean }}
 */
function renderPrintf(format, args, mode) {
  let out = '';
  let exact = true;
  let k = 0;
  let base = 0;
  let maxPos = 0;
  let sawPositional = false;
  let sawPlain = false;
  const nextArg = () => { sawPlain = true; return k < args.length ? args[k++] : null; };
  // `spec` is `12$` (positional) or undefined (the next argument).
  const argAt = (spec) => {
    if (spec === undefined) return nextArg();
    sawPositional = true;
    const n = Number.parseInt(spec, 10);
    if (n > maxPos) maxPos = n;
    if (n < 1 || base + n > args.length) { exact = false; return null; }
    return args[base + n - 1];
  };
  const number = (arg) => {
    if (arg === null || arg === '') return 0n;
    if (/^['"]/.test(arg)) return BigInt(arg.codePointAt(1) ?? 0);
    try { return BigInt(arg.trim()); } catch { return 0n; }
  };
  for (;;) {
    const passStart = k;
    base = k;
    maxPos = 0;
    for (let i = 0; i < format.length;) {
      if (out.length > PRINTF_OUTPUT_CAP) return { text: out, exact: false };
      const ch = format[i];
      if (ch === '\\') {
        // Decode exactly one escape: the shortest prefix that decodes alone.
        const esc = /^\\(?:0?[0-7]{1,3}|x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|.)?/s.exec(format.slice(i))[0];
        const dec = decodeDataEscapes(esc.startsWith('\\0') ? esc.slice(0, 4) : esc, mode);
        if (dec.stopped) return { text: out, exact };
        out += dec.text;
        i += esc.startsWith('\\0') ? Math.min(esc.length, 4) : esc.length;
        continue;
      }
      if (ch !== '%') { out += ch; i++; continue; }
      PRINTF_CONVERSION_RE.lastIndex = i;
      const conv = PRINTF_CONVERSION_RE.exec(format);
      if (!conv) { exact = false; out += ch; i++; continue; }
      i = PRINTF_CONVERSION_RE.lastIndex;
      const [, posSpec, flags, widthSpec, precSpec, letter] = conv;
      if (letter === '%') { out += '%'; continue; }
      const starArg = (spec) => Number(number(argAt(spec.length > 1 ? spec.slice(1) : undefined)));
      const width = widthSpec?.startsWith('*') ? starArg(widthSpec) : Number(widthSpec ?? 0);
      let prec = precSpec === undefined ? null : precSpec.startsWith('*') ? starArg(precSpec) : Number(precSpec || 0);
      if (prec !== null && prec < 0) prec = null;
      const arg = argAt(posSpec === undefined ? undefined : `${posSpec}$`);
      let field;
      if (letter === 's') field = arg ?? '';
      else if (letter === 'b') {
        const dec = decodeDataEscapes(arg ?? '', 'b');
        if (dec.stopped) return { text: out + dec.text, exact };
        field = dec.text;
      } else if (letter === 'c') field = (arg ?? '').slice(0, 1);
      else if ('diu'.includes(letter)) field = number(arg).toString();
      else if (letter === 'o') field = number(arg).toString(8);
      else if (letter === 'x' || letter === 'X') field = number(arg).toString(16)[letter === 'X' ? 'toUpperCase' : 'toLowerCase']();
      else { exact = false; field = arg ?? ''; }
      if (prec !== null && (letter === 's' || letter === 'b')) field = field.slice(0, Math.max(0, prec));
      const pad = Math.min(Math.abs(width) - field.length, PRINTF_PAD_CAP);
      if (pad > 0) field = flags.includes('-') || width < 0 ? field + ' '.repeat(pad) : ' '.repeat(pad) + field;
      out += field;
    }
    if (base + maxPos > k) k = base + maxPos;
    if (k === passStart || k >= args.length) break;
  }
  return { text: out, exact: exact && !(sawPositional && sawPlain) };
}

/**
 * Whether a token is a redirect that can feed stdin (#2014). Deliberately
 * fd-AGNOSTIC, as before #2014: a source on any fd — none, 0, a number, a named
 * `{fd}` — counts, with or without a dup. Judging which fd reaches stdin
 * (`3<&4 <&3` chains, `<&$fd`) let discards through twice in the refute
 * review (RCR-008).
 * NAMED CEILING (BV-004): `xargs git 3<<< S` without a dup is read as if S
 * fed stdin — a deny-side over-read (ADR-0017). REVISIT TRIGGER: a real
 * command denied by it.
 *
 * @param {{ redirect?: object } | undefined} tok
 * @returns {boolean}
 */
const feedsStdin = (tok) => tok?.redirect !== undefined;

/**
 * The here-string words of a segment: `cmd <<< WORD` feeds WORD to stdin, and
 * so does a here-document body (`cmd <<'E'`, fix cycle 1 R-F3 — the lexer links
 * the body to its `<<` token).
 *
 * @param {Array<{ text: string, redirect?: { mode: string } }>} segment
 * @returns {string[]}
 */
function hereStringWords(segment) {
  const words = [];
  for (let i = 0; i < segment.length; i++) {
    if (!feedsStdin(segment[i])) continue;
    if (segment[i].redirect.mode === 'herestring' && redirectSpanEnd(segment, i) > i) words.push(segment[i + 1].text);
    else if (segment[i].redirect.mode === 'heredoc' && typeof segment[i].heredocText === 'string') words.push(segment[i].heredocText);
  }
  return words;
}

/**
 * The stdin sources a segment's redirects feed, in source order, each as its
 * two stream readings (literalOutput's stream 0 and 1): a here-string word
 * with the newline the shell appends, a here-document body with its last
 * newline, and the output of a `< <(…)` process substitution (#2012). zsh
 * MULTIOS concatenates them, after the pipe, into ONE stdin stream
 * ({@link multiosStreams}). A `< file` redirect is left out: its content is
 * unknown (the "only literal data" ceiling of pipedShellData).
 *
 * @param {Array<object>} segment
 * @returns {Array<[string, string]> | null} null when a process
 *   substitution's own read budget is spent
 */
function hereSourceStreams(segment) {
  const sources = [];
  for (let i = 0; i < segment.length; i++) {
    const tok = segment[i];
    if (feedsStdin(tok) && tok.redirect.mode === 'herestring' && redirectSpanEnd(segment, i) > i) {
      const text = `${segment[i + 1].text}\n`;
      sources.push([text, text]);
    } else if (feedsStdin(tok) && tok.redirect.mode === 'heredoc' && typeof tok.heredocText === 'string') {
      const text = `${tok.heredocText}\n`;
      sources.push([text, text]);
    } else if (isProcSubToken(tok) && segment[i - 1]?.redirect?.mode === 'read' && feedsStdin(segment[i - 2]) && segment[i - 2].redirect.mode === 'read') {
      // `< <(…)`: the lexer splits it into two read redirects and the `( … )`
      // word; `-a <(…)` (one `<`) is an argument file, not stdin.
      const streams = procSubStreams(tok);
      if (streams === null) return null;
      sources.push(streams);
    }
  }
  return sources;
}

/**
 * The two output streams of a process-substitution word `( … )`: the streams
 * of its statements in order, leaving out a statement another one reads
 * through a pipe (literalOutput's compound rule).
 *
 * @param {object} tok - a token isProcSubToken accepts
 * @returns {[string, string] | null} null when the body's read budget is spent
 */
function procSubStreams(tok) {
  const out = ['', ''];
  for (const r of tok.substitutions ?? []) {
    const raw = tok.text.slice(r.start, r.end);
    if (!raw.startsWith('(')) continue;
    const segments = splitSegments(tokenizeCommand(raw.slice(1, -1)));
    const consumed = new Set(segments.map((s) => s.pipedFrom).filter(Boolean));
    for (const seg of segments) {
      if (consumed.has(seg)) continue;
      const result = pipelineLiteralResult(seg);
      if (result === null) return null;
      out[0] = capJoin(out[0], result.streams[0]);
      out[1] = capJoin(out[1], result.streams[1]);
    }
  }
  return out;
}

/**
 * The stdin a segment reads under zsh MULTIOS (#2012): a pipe AND redirects
 * that feed stdin (here-string, here-document, `< <(…)`), or two such
 * redirects, are concatenated into ONE stream — the pipe first, then the
 * redirects in source order (zsh manual, "Multios": `cat bar | sort <foo` is
 * `cat bar foo | sort`). `echo aa | xargs -n 2 echo RUN <<< bb` prints `RUN
 * aa bb` in zsh and `RUN bb` in bash, where the last redirect replaces the
 * pipe (measured 2026-11-10, zsh and bash, harmless `echo`). The bash
 * reading (each source alone) stays with the caller; this adds the zsh one,
 * so the union can only add a deny. The concatenation is exact, a source
 * without a trailing newline glues onto the next (`printf aa | xargs echo
 * RUN <<< bb` prints `RUN aabb`).
 *
 * Each concatenation is charged to the line's pipe-read budget before it is
 * kept; one stream per stream reading (two), so the work is linear in the
 * sources.
 *
 * NAMED CEILING (BV-004): a `< file` source is read as empty (its content is
 * unknown, as everywhere in this reader). REVISIT TRIGGER: a reported discard
 * whose second half comes from a file.
 *
 * @param {Array<[string, string]> | null} sources - hereSourceStreams(segment)
 * @param {{ streams: [string, string] } | null | undefined} pipe - the pipe's
 *   literal output (pipelineLiteralResult), undefined without a pipe
 * @param {ReturnType<typeof newPipeRead>} ctx
 * @returns {string[] | null} the concatenated streams; null when a budget is spent
 */
function multiosStreams(sources, pipe, ctx) {
  if (sources === null || pipe === null) return null;
  const pipeText = pipe !== undefined && pipe.streams.some((s) => s !== '');
  if (sources.length === 0 || (!pipeText && sources.length < 2)) return [];
  const out = [];
  try {
    readingPipe(ctx, () => {
      for (const v of [0, 1]) {
        let text = pipeText ? pipe.streams[v] : '';
        for (const s of sources) text = capJoin(text, s[v]);
        chargePipeRead(ctx, 1 + Math.ceil(text.length / XARGS_REPLACE_CHARS_PER_UNIT));
        if (!out.includes(text)) out.push(text);
      }
    });
  } catch (e) {
    if (e === PIPE_READ_SPENT) return null;
    throw e;
  }
  return out;
}

/** The most nested pass-through filters and compound bodies read with their structure. */
const PASS_THROUGH_DEPTH = 16;

/** Filters whose output is lines of their input, read as pass-through (#1944 point 2). */
const LINE_FILTERS = new Set([
  'head', 'tail', 'grep', 'egrep', 'fgrep', 'sed', 'gsed', 'awk', 'gawk', 'mawk', 'nawk',
  'sort', 'uniq', 'tr', 'dd', 'perl',
]);

/**
 * The longest concatenated output kept per statement (fix cycle 1, C3).
 * NAMED CEILING (BV-004): past it the concatenation is cut; every statement's
 * own data is still read. REVISIT TRIGGER: a real line whose concatenated
 * literal output exceeds 1 MiB.
 */
const STREAM_CAP = 1 << 20;

/** Append with STREAM_CAP. */
const capJoin = (a, b) => (a.length >= STREAM_CAP ? a : (a + b).slice(0, STREAM_CAP));

/**
 * What a pass-through statement (`cat`, `tee`, a line filter) prints from its
 * stdin redirects: the here-string and here-doc words, and since #2014 point 3
 * a `< <(…)` process substitution (`cat < <(echo 'S') | xargs git`). With a
 * process substitution the sources are joined in order (zsh MULTIOS) and each
 * one's literal data is added to `data` (bash: the last source alone).
 *
 * @param {Array<object>} left
 * @param {string[]} fed - hereStringWords(left)
 * @param {Set<string>} data - the statement's data readings, extended in place
 * @returns {[string, string] | null}
 */
function fedOutput(left, fed, data) {
  const sources = hereSourceStreams(left);
  if (sources !== null && sources.length > fed.length) {
    for (const d of procSubLiteralData(left)) data.add(d);
    return [sources.map((s) => s[0]).join(''), sources.map((s) => s[1]).join('')];
  }
  if (fed.length === 0) return null;
  const out = fed.map((w) => (w.endsWith('\n') ? w : `${w}\n`)).join('');
  return [out, out];
}

/**
 * The literal output of ONE statement, without following its pipe: the data
 * readings (a Set) and two ordered output streams — stream 0 with bash's echo
 * (raw) and bash's printf escapes, stream 1 with the decoded echo and zsh's
 * printf escapes. A statement with no literal output streams nothing.
 * Pass-through filters are returned as `passThrough` for the caller to follow.
 *
 * @param {Array<object>} left
 * @returns {{ data: Set<string>, streams: [string, string], passThrough: boolean }}
 */
function statementLiteralOutput(left) {
  const data = new Set();
  let streams = null;
  let passThrough = false;
  const fed = hereStringWords(left);
  for (const w of fed) data.add(w);
  for (const { verb, index } of readingsOf(resolveSegmentVerb(left))) {
    // #1940 point 6: pure pass-through filters hand on what they read —
    // `tee <file>…` always, `cat` without a file operand (or only `-`).
    // Options are not judged (`cat -n` alters the data, `tee -a` does not):
    // reading the unaltered data is a deny-side over-read.
    if (verb === 'tee' || verb === 'cat') {
      // A here-doc body word is stdin, never a file operand (fix cycle 2, 5a).
      const operands = argvWordsWithoutRedirects(left, index + 1).filter((t) => !t.heredocBody && (t.text === '-' || !t.text.startsWith('-')));
      if (verb === 'tee' || operands.every((t) => t.text === '-')) {
        if (left.pipedFrom) passThrough = true;
        // `cat <<< S` / `cat <<'E'`: the fed text is the output.
        streams ??= fedOutput(left, fed, data);
      }
      continue;
    }
    // #1944 point 2: line filters (`| head -n 1 | sh`, `| grep . | sh`, `|
    // sed -n p | sh`, `| awk 1 | sh`, `| sort | sh`, `| dd | sh`, `| perl -pe ''
    // | sh`) hand on lines of what they read: the ORIGINAL data is read as their
    // output — a deny-side over-read. Operands are not judged (a file operand
    // replaces stdin; reading the pipe anyway can only add a deny).
    // NAMED CEILING (BV-004): output a filter CREATES or rewrites (`sed
    // 's/x/git/'`, `tr a-z A-Z`, `base64 -d`, `rev`) is not computed; only the
    // unaltered data is read. REVISIT TRIGGER: a reported or replayed discard
    // through a rewriting filter.
    if (LINE_FILTERS.has(verb)) {
      if (left.pipedFrom) passThrough = true;
      streams ??= fedOutput(left, fed, data);
      continue;
    }
    if (verb !== 'echo' && verb !== 'printf') continue;
    const words = argvWordsWithoutRedirects(left, index + 1).map((t) => t.text);
    if (verb === 'echo') {
      let newline = '\n';
      while (words.length > 0 && /^-[neE]+$/.test(words[0])) { if (words[0].includes('n')) newline = ''; words.shift(); }
      const text = words.join(' ');
      const decoded = decodeDataEscapes(text, 'echo').text;
      data.add(text);
      data.add(decoded);
      streams ??= [text + newline, decoded + newline];
      continue;
    }
    if (words[0] === '--') words.shift();
    if (words[0] === '-v' || words.length === 0) continue; // `printf -v VAR` prints nothing
    const [format, ...args] = words;
    let exact = true;
    const rendered = [];
    for (const mode of ['format-bash', 'format-zsh']) {
      const r = renderPrintf(format, args, mode);
      data.add(r.text);
      rendered.push(r.text);
      exact &&= r.exact;
    }
    streams ??= [rendered[0], rendered[1]];
    if (!exact) data.add(decodeDataEscapes([format, ...args].join(' '), 'format-bash').text).add(args.join('\n'));
  }
  return { data, streams: streams ?? ['', ''], passThrough };
}

/**
 * The literal output of a pipeline's left side, memoized per statement object
 * (fix cycle 1, C5: compound bodies list every earlier statement, so an
 * unmemoized walk revisited them exponentially — 32 nested `( … ) | cat` took
 * 4.28 s). A compound's streams are the CONCATENATION of its statements'
 * streams in order (C3: `( printf 'git '; printf 'checkout -f' ) | sh` hands
 * the shell `git checkout -f`), leaving out statements whose output another
 * statement of the body reads through a pipe.
 * Past PASS_THROUGH_DEPTH the walk does not stop (R-F4: it did, which let 17
 * `| cat` hide the data): it goes on iteratively (flatLiteralOutput).
 *
 * Fix cycle 2 (item 2): the memo and a work budget belong to the LINE
 * (`ctx`, splitSegmentsReading's `pipeRead`), not to one call — every visit
 * is charged (chargePipeRead), and an exhausted budget makes the data
 * unreadable (pipedShellData `unreadable`), never silently partial.
 *
 * @param {Array<object>} left
 * @param {number} depth
 * @param {{ memo: Map<object, object> }} ctx
 * @returns {{ data: Set<string>, streams: [string, string] }}
 */
function literalOutput(left, depth, ctx) {
  chargePipeRead(ctx, 1);
  const memo = ctx.memo;
  const known = memo.get(left);
  if (known) return known;
  // A cycle guard: a statement under evaluation reads as no output (the
  // segment graph is acyclic; this only bounds a malformed one).
  memo.set(left, { data: new Set(), streams: ['', ''] });
  let out;
  if (depth >= PASS_THROUGH_DEPTH) out = flatLiteralOutput(left, ctx);
  else if (left.compoundBody) {
    const body = left.compoundBody;
    // A body is a PREFIX of the line's written statements (splitSegmentsReading
    // only appends), so the statements an inner compound's pipe consumes are
    // the first `consumedPrefix` members — counted, not collected (fix cycle
    // 2: collecting every inner body was quadratic per compound).
    const consumed = new Set();
    let consumedPrefix = 0;
    for (let k = 0; k < body.length; k++) {
      const from = body.of[k].pipedFrom;
      if (!from) continue;
      if (from.compoundBody) consumedPrefix = Math.max(consumedPrefix, from.compoundBody.length);
      else consumed.add(from);
    }
    const data = new Set();
    const streams = ['', ''];
    for (let k = 0; k < body.length; k++) {
      const m = body.of[k];
      const sub = literalOutput(m, depth + 1, ctx);
      chargePipeRead(ctx, sub.data.size);
      for (const d of sub.data) data.add(d);
      if (k < consumedPrefix || consumed.has(m)) continue;
      streams[0] = capJoin(streams[0], sub.streams[0]);
      streams[1] = capJoin(streams[1], sub.streams[1]);
    }
    addStreams(data, streams);
    out = { data, streams };
  } else {
    // #2014 point 1 (writer side): a statement inside a compound writes what
    // the compound's stdin redirects feed it (`echo a | { cat; } <<< 'S' |
    // xargs git`): read its stdinView, which holds them and its pipe.
    const stmt = left.stdinView ?? left;
    const own = statementLiteralOutput(stmt);
    if (own.passThrough) {
      const src = literalOutput(stmt.pipedFrom, depth + 1, ctx);
      chargePipeRead(ctx, src.data.size);
      for (const d of src.data) own.data.add(d);
      own.streams = [capJoin(own.streams[0], src.streams[0]), capJoin(own.streams[1], src.streams[1])];
      // #2012: under zsh MULTIOS a filter fed by the pipe AND a here-string,
      // here-document or `< <(…)` reads both, the pipe first (`echo a | cat
      // <<< b` prints `a` then `b`): that stream is one more reading.
      // NAMED CEILING (BV-004): past PASS_THROUGH_DEPTH (flatLiteralOutput)
      // this order is not built. REVISIT TRIGGER: a reported discard through
      // more than 16 nested filters.
      const sources = hereSourceStreams(stmt);
      // A spent body budget marks the line's too: the memo already holds this
      // statement's placeholder, so a later read must not see it as read.
      if (sources === null) {
        ctx.exhausted = true;
        throw PIPE_READ_SPENT;
      }
      if (sources.length > 0) {
        for (const v of [0, 1]) {
          let text = src.streams[v];
          for (const s of sources) text = capJoin(text, s[v]);
          chargePipeRead(ctx, 1 + Math.ceil(text.length / XARGS_REPLACE_CHARS_PER_UNIT));
          own.data.add(text);
        }
      }
    }
    out = { data: own.data, streams: own.streams };
  }
  memo.set(left, out);
  return out;
}

/**
 * The fail-closed reading past PASS_THROUGH_DEPTH (fix cycle 1, R-F4/C5): every
 * statement reachable through pass-through filters and compound bodies, walked
 * iteratively once each; their data, and their streams concatenated in walk
 * order (an over-read: order and consumption are not judged here).
 *
 * @param {Array<object>} left
 * @param {object} ctx - the line's pipe-read budget (chargePipeRead)
 * @returns {{ data: Set<string>, streams: [string, string] }}
 */
function flatLiteralOutput(left, ctx) {
  const data = new Set();
  const streams = ['', ''];
  const seen = new Set();
  const stack = [left];
  while (stack.length > 0) {
    const node = stack.pop();
    chargePipeRead(ctx, 1);
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.compoundBody) { for (let k = node.compoundBody.length - 1; k >= 0; k--) stack.push(node.compoundBody.of[k]); continue; }
    const stmt = node.stdinView ?? node;
    const own = statementLiteralOutput(stmt);
    for (const d of own.data) data.add(d);
    streams[0] = capJoin(streams[0], own.streams[0]);
    streams[1] = capJoin(streams[1], own.streams[1]);
    if (own.passThrough) stack.push(stmt.pipedFrom);
  }
  addStreams(data, streams);
  return { data, streams };
}

/**
 * Add the streams to the data unless a reading already holds them (with or
 * without the trailing newline): each extra text costs one evaluation of the
 * matcher's shared budget.
 *
 * @param {Set<string>} data
 * @param {string[]} streams
 */
function addStreams(data, streams) {
  for (const s of streams) {
    if (s !== '' && !data.has(s) && !data.has(s.replace(/\n$/, ''))) data.add(s);
  }
}

/**
 * The data a pipeline's left statement writes, as far as it is literal: the
 * here-string and here-document words (`cat <<< 'S'`), `echo` arguments and
 * `printf` output, through pass-through filters and compound bodies. echo
 * data is judged raw (bash's echo) AND decoded (`echo -e`, zsh's echo, macOS
 * `/bin/sh`). printf output is rendered (renderPrintf) with bash's and zsh's
 * format escapes; a render that is not exact adds the raw reading — the
 * decoded format and arguments joined by blanks, and the arguments by
 * newlines (#1933 fix cycle 1: union, never weaker). Over-reading data as a
 * script can only add a deny.
 *
 * @param {Array<{ text: string, quoted: boolean }>} left
 * @returns {string[] | null} null when the line's pipe-read budget is spent
 */
function pipelineLiteralData(left) {
  const result = pipelineLiteralResult(left);
  if (result === null) return null;
  const out = new Set(result.data);
  addStreams(out, result.streams);
  return [...out];
}

/**
 * literalOutput of a pipeline's left statement against its line's budget
 * (memoized there, so a second call is one unit): its data readings and its
 * two ordered streams (#2012: multiosStreams needs the streams alone).
 *
 * @param {Array<object>} left
 * @returns {{ data: Set<string>, streams: [string, string] } | null} null when
 *   the line's pipe-read budget is spent
 */
function pipelineLiteralResult(left) {
  const ctx = left.pipeRead ?? newPipeRead();
  if (ctx.exhausted) return null;
  try {
    return readingPipe(ctx, () => literalOutput(left, 0, ctx));
  } catch (e) {
    if (e === PIPE_READ_SPENT) return null;
    throw e;
  }
}

/**
 * The work one line's pipe-data readings may spend (fix cycle 2, item 2):
 * statement visits plus data texts carried, shared by every pipe of the line
 * and every caller. NAMED CEILING (BV-004): past it — or past PIPE_READ_MS of
 * reading — the data is UNREAD and fails closed (pipedShellData
 * `unreadable`): a stdin shell on such a line is denied. 0 of 22,905 replay
 * commands pipe data into a shell (2026-11-03), so no real line reaches it.
 * REVISIT TRIGGER: a real command denied as unreadable pipe data.
 */
const PIPE_READ_WORK = 4096;
const PIPE_READ_MS = 400;
/** The pipe-read memo key of the xargs readings, a Map segment → lines | null (fix cycle M1). */
const XARGS_READING_MEMO = Symbol('xargs readings');
/** Thrown inside the walk when the budget is spent; caught in pipelineLiteralData. */
const PIPE_READ_SPENT = Symbol('pipe-read budget spent');

/** A fresh pipe-read budget, for a statement no split linked to one. */
function newPipeRead() {
  return { work: 0, startedAt: 0, spentMs: 0, depth: 0, built: 0, memo: new Map(), exhausted: false, viewTokens: 0, viewsCut: false };
}

/**
 * The most work the stdin views of one line may cost: statements visited and
 * tokens copied by attachCompoundStdin (#2027 fix cycle 1, HIGH). NAMED
 * CEILING (BV-004): past it the line is `viewsCut` — the stdin of later
 * statements is not linked any more, so every statement that may read stdin
 * is unreadable (pipedShellData) and a line with one is denied, a harmless one
 * too. REVISIT TRIGGER: a real command denied as unreadable through this cut.
 *
 * Why it bites early (#2031 item 8): every stdin view appends ALL later
 * statement tails, so the cost grows roughly cubically with the statement
 * count and the cap already trips at about 45 `{ :; } <<< x; ` on one line
 * (measured 2026-11-11 in the verification review of !394: N=44 not cut,
 * N=45 cut). From then on every stdin-reading statement of the line is deny
 * (fail-closed). Long-term fix: share the views instead of copying them. A
 * second REVISIT TRIGGER: a real line that is denied this way.
 */
const VIEW_TOKENS_MAX = 1 << 16;

/**
 * Mark the line's stdin links as cut (#2027 fix cycle 1): a view or call link
 * that a cap kept from being built leaves every stdin reader unreadable, and
 * the pipe reading spent as before.
 *
 * @param {ReturnType<typeof newPipeRead>} pipeRead
 */
function cutViews(pipeRead) {
  pipeRead.viewsCut = true;
  pipeRead.exhausted = true;
}

/**
 * Charge `n` units to the line's view budget; false (and the line cut) past
 * VIEW_TOKENS_MAX.
 *
 * @param {ReturnType<typeof newPipeRead>} pipeRead
 * @param {number} n
 * @returns {boolean}
 */
function chargeViewTokens(pipeRead, n) {
  pipeRead.viewTokens += n;
  if (pipeRead.viewTokens <= VIEW_TOKENS_MAX) return true;
  cutViews(pipeRead);
  return false;
}

/**
 * Characters of command lines the xargs readings of ONE command line may
 * build, summed over every segment, window, substitution and argv line
 * (#1999 fix cycle H4). The hook lexes every built line again in its own
 * readers, outside this module's budgets: ~38 KB of command text built ~1 MB
 * of lines there (1.0–3.2 s per probe under load, base ~100 ms).
 * NAMED CEILING (BV-004): past it the reading is unreadable and the line
 * denied (pipedShellData `unreadable`), a harmless one too; the largest
 * total any of 4651 real commands builds is 8,783 characters (22 build any;
 * 2026-11-10).
 * REVISIT TRIGGER: a real xargs line denied as unreadable.
 */
const XARGS_BUILT_CHARS_MAX = 64 * 1024;

/**
 * Charge `chars` built characters to the line's xargs output cap
 * (XARGS_BUILT_CHARS_MAX) BEFORE the line is kept; throws PIPE_READ_SPENT
 * (and marks the budget exhausted) past it.
 *
 * @param {{ built: number, exhausted: boolean }} ctx
 * @param {number} chars
 */
function chargeXargsBuilt(ctx, chars) {
  ctx.built += chars;
  if (ctx.built > XARGS_BUILT_CHARS_MAX) {
    ctx.exhausted = true;
    throw PIPE_READ_SPENT;
  }
}

/**
 * Add `line` to `out` unless it is there, charging its length first
 * (chargeXargsBuilt).
 *
 * @param {Set<string>} out
 * @param {string} line
 * @param {{ built: number, exhausted: boolean }} ctx
 */
function addBuiltLine(out, line, ctx) {
  if (out.has(line)) return;
  chargeXargsBuilt(ctx, line.length);
  out.add(line);
}

/**
 * Run one reading against the line's budget (#1999 fix cycle H3): PIPE_READ_MS
 * counts the time spent INSIDE readings, summed over all of them, not the
 * wall clock since the first charge — the line's budget is shared by every
 * segment and rule, and the matcher's own work between two readings is not
 * reading time (a late first reading of a harmless segment was spent by it).
 *
 * @template T
 * @param {{ startedAt: number, spentMs: number, depth: number }} ctx
 * @param {() => T} fn
 * @returns {T}
 */
function readingPipe(ctx, fn) {
  if (ctx.depth++ === 0) ctx.startedAt = Date.now();
  try {
    return fn();
  } finally {
    if (--ctx.depth === 0) ctx.spentMs += Date.now() - ctx.startedAt;
  }
}

/**
 * Charge `n` units to the line's pipe-read budget; throws PIPE_READ_SPENT
 * (and marks the budget exhausted for every later reading) when it is spent.
 *
 * @param {{ work: number, startedAt: number, spentMs: number, depth: number, exhausted: boolean }} ctx
 * @param {number} n
 */
function chargePipeRead(ctx, n) {
  ctx.work += n;
  const inReading = ctx.depth > 0 ? Date.now() - ctx.startedAt : 0;
  if (ctx.work > PIPE_READ_WORK || ctx.spentMs + inReading > PIPE_READ_MS) {
    ctx.exhausted = true;
    throw PIPE_READ_SPENT;
  }
}

/**
 * The pipe-read context of a segment (#1999 fix cycle H3): the line's own
 * (`splitChainSegments` attaches it to every segment), else the one of the
 * pipe it reads, else one created once per segment OBJECT — a segment a
 * caller built itself still gets a bounded budget, shared by every call on it.
 *
 * @param {Array<object> & { pipeRead?: object, pipedFrom?: { pipeRead?: object } }} segment
 * @returns {ReturnType<typeof newPipeRead>}
 */
function pipeReadOf(segment) {
  const own = segment.pipeRead ?? segment.pipedFrom?.pipeRead;
  if (own) return own;
  let ctx = SEGMENT_PIPE_READ.get(segment);
  if (ctx === undefined) SEGMENT_PIPE_READ.set(segment, (ctx = newPipeRead()));
  return ctx;
}

/** Fallback pipe-read contexts of segments no split linked to a line (pipeReadOf). */
const SEGMENT_PIPE_READ = new WeakMap();

/**
 * Data piped or here-stringed into a shell that reads its script from stdin
 * (#1933 point 4), each a command line for the payload recursion:
 * `echo "git restore ." | sh`, `printf 'git clean -fdx\n' | bash`,
 * `cat <<< 'S' | sh`, `bash <<< 'S'`, and `echo 'S' | script -q /dev/null`
 * (`script` with no command starts `$SHELL`, which reads the pipe). The shell
 * is resolved through the wrappers (`| sudo sh`); `su` is left out, it reads a
 * password from the terminal, not a script.
 *
 * The data passes through pure pass-through filters (`| tee x | sh`, `| cat |
 * sh`) and may come from a subshell, group or loop of echo/printf statements
 * (`( echo … ) | sh`, `for …; do echo …; done | sh`, #1940 point 6). The
 * destructive guard reads the same data as a payload for its path-reset and
 * forced-discard verdicts (hook walkGitSegments, #1940).
 *
 * The `source`/`.` builtin reading stdin (`printf 'S' | . /dev/stdin`, #1944
 * point 8) joins the stdin shells: it runs the piped text in the current
 * shell. Process substitutions feeding a script-reading shell (`bash <(echo
 * 'S')`, `sh < <(echo 'S')`, `source <(echo 'S')`, #1944 point 4) are read by
 * {@link procSubShellData} and returned alongside, whether or not the segment
 * also reads stdin.
 *
 * NAMED CEILING (BV-004): only literal data is read. Data from files (`cat
 * f | sh`, `sh < f`), variables (`echo "$CMD" | sh` reads `$CMD` as the
 * empty-expansion text only) and `$( … )` stay unread; 0 of 22,905 replay
 * commands pipe data into a shell (2026-11-03). REVISIT TRIGGER: a replay
 * census or report showing the form. Runners that build the command from
 * stdin (`echo 'S' | xargs -I{} sh -c '{}'`, `printf '"S"' | xargs sh -c`)
 * are no longer unread: {@link xargsCommandLines} reads them (#1944 points
 * 2/3; quote splitting without `-0`/`-d` 2026-11-10).
 *
 * @param {Array<{ text: string, quoted: boolean }> & { pipedFrom?: Array<object> }} segment
 * @returns {string[]}
 */
export function pipedShellData(segment) {
  // #2014 point 1: a statement inside a compound reads the compound's stdin
  // redirects (`{ xargs git; } <<< 'S'`) — the splitter hangs them on as
  // `stdinView`, the statement with them appended (a superset of its tokens).
  if (segment.stdinView) return pipedShellData(segment.stdinView);
  const hereStrings = hereStringWords(segment);
  const procSub = procSubShellData(segment);
  // #2027 fix cycle 1: on a line whose stdin links a cap cut (viewsCut), a
  // statement may read stdin it has no link to — read it as unreadable when
  // it is a stdin reader, never as reading nothing.
  const cut = pipeReadOf(segment).viewsCut === true;
  if (!cut && !segment.pipedFrom && hereStrings.length === 0 && procSub.length === 0 && !segment.some(isProcSubToken)) return [];
  const readings = readingsOf(resolveSegmentVerb(segment));
  const dashVerb = readings.some(({ verb }) => verb !== null && DASH_C_SHELLS.has(verb));
  const readsStdin = readings.some(({ verb, index }) => {
    if (verb === null) return argvWordsWithoutRedirects(segment).some((t) => !t.quoted && programName(t.text) === 'script');
    // `source FILE` / `. FILE` run FILE in the current shell; when FILE is the
    // shell's own stdin (`printf 'S' | . /dev/stdin`) the piped text is the
    // script (#1944 point 8).
    if (SOURCE_BUILTINS.has(verb)) return argvWordsWithoutRedirects(segment, index + 1).some((t) => STDIN_SCRIPT_FILE_RE.test(t.text));
    // A here-document body word lands in the statement after `<<` (fix cycle
    // 1, R-F3: `cat <<'E' | sh` puts it behind `sh`); it is stdin, not a
    // script-file operand.
    return DASH_C_SHELLS.has(verb) && !SU_LIKE_SHELLS.has(verb) && shellReadsStdin(argvWordsWithoutRedirects(segment, index + 1).filter((t) => !t.heredocBody));
  });
  if (cut && (readsStdin || dashVerb || xargsShellCommand(segment) !== null)) {
    return Object.defineProperty([...hereStrings, ...procSub], 'unreadable', { value: true });
  }
  if (!readsStdin) {
    // #2027 point 3: a `-c` script reads the shell's stdin — one more reading
    // beside the xargs one (a union: neither replaces the other).
    const dashC = dashVerb ? dashCStdinLines(segment, hereStrings, readings) : [];
    if (dashC === null) return Object.defineProperty([...procSub], 'unreadable', { value: true });
    const lines = xargsStdinLines(segment, hereStrings, procSub);
    if (dashC.length === 0) return lines;
    const all = [...dashC, ...lines];
    return lines.unreadable ? Object.defineProperty(all, 'unreadable', { value: true }) : all;
  }
  const piped = segment.pipedFrom ? pipelineLiteralData(segment.pipedFrom) : [];
  // Fix cycle 2 (item 2): a spent budget is marked, never read as no data —
  // every consumer fails closed on `unreadable` (matcher check 4, the hook).
  if (piped === null) return Object.defineProperty([...hereStrings, ...procSub], 'unreadable', { value: true });
  // #2012: a stdin shell reads the zsh MULTIOS stream too (`printf 'S1 ' |
  // sh <<< 'S2'` runs `S1 S2` in zsh).
  const joined = multiosStreams(hereSourceStreams(segment), segment.pipedFrom ? pipelineLiteralResult(segment.pipedFrom) : undefined, pipeReadOf(segment));
  if (joined === null) return Object.defineProperty([...hereStrings, ...piped, ...procSub], 'unreadable', { value: true });
  return [...hereStrings, ...piped, ...joined.filter((j) => !piped.includes(j) && !hereStrings.includes(j)), ...procSub];
}

/**
 * The literal stdin data of a segment, every reading: the pipe's data, the
 * here-string and here-document words, `< <(…)` output, and the zsh MULTIOS
 * concatenations (#2012). The xargs reading and the `-c` reading (#2027
 * point 3) read the same data.
 *
 * @param {Array<object>} segment
 * @param {string[]} hereStrings - hereStringWords(segment)
 * @returns {string[] | null} null when the line's pipe-read budget is spent
 */
function fedStdinData(segment, hereStrings) {
  const piped = segment.pipedFrom ? pipelineLiteralData(segment.pipedFrom) : [];
  if (piped === null) return null;
  const joined = multiosStreams(hereSourceStreams(segment), segment.pipedFrom ? pipelineLiteralResult(segment.pipedFrom) : undefined, pipeReadOf(segment));
  if (joined === null) return null;
  return [...new Set([...piped, ...hereStrings, ...procSubLiteralData(segment), ...joined])];
}

/** The pipe-read memo key of the `-c` stdin readings, a Map segment → lines | null (#2027 point 3). */
const DASH_C_READING_MEMO = Symbol('dash-c stdin readings');

/**
 * A `-c` script that may run what it reads from stdin: it names xargs, a
 * shell (`sh`, `bash`, … — any word ending in `sh`), `source`, `script` or
 * `parallel`. A cheap SUPERSET test; a script naming none of them runs no
 * stdin data (`cat`, `wc -l`), so its data is not composed (#2027 point 3).
 */
const STDIN_RUNNER_HINT = /xargs|sh|source|script|parallel|(?:^|[\s;&|({])\.(?=\s)/;

/** A `-c` script whose words quotes, escapes or expansions may spell (fix cycle 1, MEDIUM 3). */
const SCRIPT_MAY_HIDE_NAME = /['"\\$`]/;

/**
 * #2027 point 3: a shell's `-c` script reads the shell's stdin — `echo S | sh
 * -c 'xargs -n 2 git'` and `sh -c 'sh' <<< 'S'` run S. For each `-c` script
 * that names a stdin runner (STDIN_RUNNER_HINT) or may hide one behind quotes,
 * escapes or `$` (SCRIPT_MAY_HIDE_NAME), and each literal stdin data
 * reading (fedStdinData), the line `{ <script>⏎} <<'D'⏎<data>⏎D` is returned:
 * the script as a group whose here-document is the data, read again by the
 * payload recursion of every consumer like any group with a stdin redirect
 * (attachCompoundStdin). `D` is a delimiter no data line equals.
 *
 * The built lines are charged to the line's xargs output cap
 * (XARGS_BUILT_CHARS_MAX) and memoized per segment, as the xargs reading is.
 *
 * NAMED CEILING (BV-004): past the cap the reading is unreadable and the line
 * denied, a harmless one too (a large here-document into `bash -c '… sh …'`).
 * REVISIT TRIGGER: a real command denied as unreadable through this reading.
 *
 * @param {Array<object>} segment
 * @param {string[]} hereStrings - hereStringWords(segment)
 * @param {Array<{ verb: string|null, index: number }>} verbReadings - readingsOf(resolveSegmentVerb(segment))
 * @returns {string[] | null} the lines; null when a budget is spent
 */
function dashCStdinLines(segment, hereStrings, verbReadings) {
  if (!segment.pipedFrom && hereStrings.length === 0 && !segment.some(isProcSubToken)) return [];
  const scripts = new Set();
  for (const { verb, index } of verbReadings) {
    if (!verb || !DASH_C_SHELLS.has(verb)) continue;
    // Fix cycle 1 (MEDIUM 3): the hint reads raw text, and quotes, escapes or
    // expansions can spell a runner it does not see (`xar""gs`, `xa\rgs`,
    // `$SHELL`): such a script is always composed.
    for (const p of dashCPayloads(segment, index, verb)) if (SCRIPT_MAY_HIDE_NAME.test(p) || STDIN_RUNNER_HINT.test(p)) scripts.add(p);
  }
  if (scripts.size === 0) return [];
  const ctx = pipeReadOf(segment);
  let readings = ctx.memo.get(DASH_C_READING_MEMO);
  if (readings === undefined) ctx.memo.set(DASH_C_READING_MEMO, (readings = new Map()));
  if (!readings.has(segment)) {
    let lines = null;
    const data = ctx.exhausted ? null : fedStdinData(segment, hereStrings);
    if (data !== null) {
      try {
        lines = readingPipe(ctx, () => {
          const out = new Set();
          for (const script of scripts) {
            for (const d of data) {
              if (d === '') continue;
              let delim = 'SO2027EOF';
              const dataLines = new Set(d.split('\n'));
              while (dataLines.has(delim)) delim += 'X';
              addBuiltLine(out, `{ ${script}\n} <<'${delim}'\n${d.replace(/\n$/, '')}\n${delim}`, ctx);
            }
          }
          return [...out];
        });
      } catch (e) {
        if (e !== PIPE_READ_SPENT) throw e;
      }
    }
    readings.set(segment, lines);
  }
  return readings.get(segment);
}

/**
 * The xargs reading of pipedShellData for a segment whose verb does not read
 * stdin as a script itself (#1999 point 2, #2012).
 *
 * @param {Array<object>} segment
 * @param {string[]} hereStrings - hereStringWords(segment)
 * @param {string[]} procSub - procSubShellData(segment)
 * @returns {string[]} the lines, marked `unreadable` when the data is unread
 */
function xargsStdinLines(segment, hereStrings, procSub) {
  const xargsShell = xargsShellCommand(segment);
  if (xargsShell === null) return procSub;
  const unreadable = () => Object.defineProperty([...procSub], 'unreadable', { value: true });
  // #1999 point 2: xargs reads its items from the pipe, a here-string or
  // here-document, `< <(…)`, or `-a`/`--arg-file <(…)` — all literal data
  // is read (a union: a procsub that is a plain argument is over-read).
  // NAMED CEILING (BV-004): only literal data — `-a file`, `< file` stay
  // unread. REVISIT TRIGGER: a reported discard through an xargs data file.
  const piped = segment.pipedFrom ? pipelineLiteralData(segment.pipedFrom) : [];
  if (piped === null) return unreadable();
  // #2012: zsh MULTIOS joins the pipe and the stdin redirects into one
  // stream (`echo a | xargs -n 2 git <<< b` builds `git a b`).
  const joined = multiosStreams(hereSourceStreams(segment), segment.pipedFrom ? pipelineLiteralResult(segment.pipedFrom) : undefined, pipeReadOf(segment));
  if (joined === null) return unreadable();
  const fedData = [...new Set([...piped, ...hereStrings, ...procSubLiteralData(segment), ...joined])];
  if (fedData.length === 0) return procSub;
  // An xargs option this reader cannot resolve leaves the program unknown:
  // fail closed (#1999 point 3), only when there is data it would run.
  if (xargsShell.unreadable) return unreadable();
  const ctx = pipeReadOf(segment);
  // Fix cycle M1: the matcher reads the same lexed segment once per policy
  // rule; the reading is memoized per segment in the line's budget, so a
  // repeat returns the same lines (or the same unreadable verdict) without
  // charging the budget again. Since H3 the budget is the LINE's for every
  // segment, piped or fed by a here-string, here-doc or `< <(…)`.
  let readings = ctx.memo.get(XARGS_READING_MEMO);
  if (readings === undefined) ctx.memo.set(XARGS_READING_MEMO, (readings = new Map()));
  if (!readings.has(segment)) {
    let lines = null;
    if (!ctx.exhausted) {
      try {
        lines = readingPipe(ctx, () => xargsCommandLines(xargsShell, fedData, ctx));
      } catch (e) {
        if (e !== PIPE_READ_SPENT) throw e;
      }
    }
    readings.set(segment, lines);
  }
  const lines = readings.get(segment);
  return lines === null ? unreadable() : [...lines, ...procSub];
}

/** xargs options that take a value word when not glued (GNU findutils + BSD xargs). */
const XARGS_VALUE_SHORT = new Set(['I', 'L', 'n', 'P', 's', 'E', 'd', 'a', 'J', 'R', 'S']);

/**
 * GNU xargs' long options (findutils 4.9 `xargs.c` longopts) and how each
 * takes its value: `required` — `--opt=V` or the next word; `optional` —
 * only `--opt=V` (getopt_long never takes the next word for an optional
 * argument); `none`. GNU getopt also accepts any UNAMBIGUOUS prefix (#1999
 * point 3: `--rep=@`, `--max-arg 1`, `--arg /dev/stdin`), resolved by
 * {@link resolveXargsLongOption}.
 */
const XARGS_LONG_OPTIONS = new Map([
  ['null', 'none'], ['arg-file', 'required'], ['delimiter', 'required'], ['eof', 'optional'],
  ['replace', 'optional'], ['max-lines', 'optional'], ['max-args', 'required'], ['max-procs', 'required'],
  ['max-chars', 'required'], ['interactive', 'none'], ['no-run-if-empty', 'none'], ['open-tty', 'none'],
  ['process-slot-var', 'required'], ['show-limits', 'none'], ['verbose', 'none'], ['exit', 'none'],
  ['help', 'none'], ['version', 'none'],
]);

/**
 * The GNU xargs long option a `--name` word names, as getopt_long resolves
 * it: an exact name, else the one option the name is a prefix of. null when
 * no option or more than one matches (`--max`, `--bogus`) — xargs refuses
 * the line, and the reader cannot know where the program starts (#1999
 * point 3: an unknown value option made its value the program word, no shell
 * was found and the reading was dropped).
 *
 * @param {string} name - the word without `--` and without `=value`
 * @returns {string | null}
 */
function resolveXargsLongOption(name) {
  if (XARGS_LONG_OPTIONS.has(name)) return name;
  const hits = [...XARGS_LONG_OPTIONS.keys()].filter((o) => name !== '' && o.startsWith(name));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Whether the value of a separate-value xargs option is a process
 * substitution the lexer split off as a `<` redirect (`xargs -a <(printf
 * 'S') sh -c`, #1999 point 2): argvWordsWithoutRedirects dropped it, so the
 * option must not take the next argv word as its value.
 *
 * @param {Array<object>} segment
 * @param {object} tok - the option word, a token of `segment`
 * @returns {boolean}
 */
function procSubFollows(segment, tok) {
  const i = segment.indexOf(tok);
  const next = segment[i + 1];
  return i !== -1 && next?.redirect?.mode === 'read' && isProcSubToken(segment[i + 2]);
}

/** A token that is the `( … )` of a process substitution (`<(…)`), not `$( … )` / backtick. */
const isProcSubToken = (tok) => tok !== undefined && (tok.substitutions ?? []).some((r) => r.start === 0 && tok.text.startsWith('('));

/**
 * The `sh -c` an xargs segment runs with the piped data (#1944 points 2/3):
 * `printf 'S' | xargs -0 sh -c` makes S the `-c` string, `echo 'S' | xargs
 * -I{} sh -c '{}'` substitutes it into the string. Wrappers behind xargs
 * (`xargs -I{} sudo sh -c …`) resolve through resolveSegmentVerb.
 *
 * `delimited` is set when `-0`/`--null`/`-d`/`--delimiter` is read: xargs
 * then takes the data verbatim, with no quote or backslash processing.
 *
 * An unknown or ambiguous GNU long option (resolveXargsLongOption) returns
 * `{ unreadable: true }`: the caller fails closed, never `null` (#1999
 * point 3).
 *
 * `batches` lists the batch limits read (#1999 point 8): `{ kind: 'args' |
 * 'lines' | 'chars', n }` for `-n`/`--max-args`, `-L`/`-l`/`--max-lines`
 * and `-s`/`--max-chars`; `n` is NaN when the value is not a number.
 *
 * Seam (#1999 point 5): the program behind the options is resolved to a
 * `-c` shell below (`program`). A program in {@link XARGS_ARGV_TARGETS}
 * (`sg`, `su`, `runuser`, a nested `xargs`, `git` — through the wrappers)
 * returns its fixed words as `argv` (`strings` empty): xargs appends the
 * items to them, and {@link xargsArgvLines} judges the argv it builds.
 *
 * @param {Array<object>} segment
 * `appends` is set when xargs appends the items although `replace` is set:
 * BSD `-J`, or a GNU `-L`/`-l`/`-n` after `-I`/`-i` (it clears the pattern).
 *
 * `delimiter` is the character `-0`/`-d` split at (#2003 point 3, #2011).
 *
 * @returns {{ replace: string | null, appends: boolean, strings: string[], argv?: string[], delimited: boolean, delimiter: string | null, batches: Array<{ kind: string, n: number }> } | { unreadable: true } | null}
 */
function xargsShellCommand(segment) {
  const reading = readingsOf(resolveSegmentVerb(segment)).find(({ verb }) => verb === 'xargs');
  if (reading === undefined || reading.index < 0) return null;
  // A here-document body word is stdin, never an argument (#1999 point 2).
  const words = argvWordsWithoutRedirects(segment, reading.index + 1).filter((t) => !t.heredocBody);
  let replace = null;
  let delimited = false;
  // #2003 point 3: the delimiter `-0`/`-d X` names (the last one given
  // wins, as in GNU). A `-d` value this reader cannot decode makes the
  // reading unreadable (#2011, xargsDelimiter).
  let delimiter = null;
  // Whether xargs appends the items although a replace string is set (H2):
  // BSD `-J` always appends them, and GNU `-L`/`-n` given after `-I` clear
  // the replace pattern (findutils xargs.c).
  let appends = false;
  const batches = [];
  const batch = (kind, value) => {
    if (replace !== null && kind !== 'chars') appends = true;
    batches.push({ kind, n: value === undefined || value === '' ? (kind === 'lines' ? 1 : NaN) : Number(value) });
  };
  let k = 0;
  for (; k < words.length; k++) {
    const t = words[k].text;
    if (t === '--') { k++; break; }
    if (!t.startsWith('-') || t === '-') break;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const option = resolveXargsLongOption(eq === -1 ? t.slice(2) : t.slice(2, eq));
      if (option === null) return { unreadable: true };
      const kind = XARGS_LONG_OPTIONS.get(option);
      if (eq !== -1 && kind === 'none') return { unreadable: true }; // `--null=x`: xargs refuses it
      if (option === 'replace') replace = eq === -1 ? '{}' : t.slice(eq + 1);
      const value = eq !== -1 ? t.slice(eq + 1) : kind === 'required' ? words[k + 1]?.text : undefined;
      if (option === 'null') { delimited = true; delimiter = '\0'; }
      if (option === 'delimiter') {
        delimited = true;
        delimiter = xargsDelimiter(value);
        if (delimiter === null) return { unreadable: true };
      }
      if (XARGS_BATCH_LONG[option]) batch(XARGS_BATCH_LONG[option], value);
      if (kind === 'required' && eq === -1 && !procSubFollows(segment, words[k])) k++;
      continue;
    }
    // A short group: flags up to the first value letter, whose value is the
    // rest of the word or the next word (`-0I{}`, `-I {}`); GNU `-i[R]`,
    // `-l[N]`, `-e[EOF]` take only a glued value.
    for (let c = 1; c < t.length; c++) {
      const letter = t[c];
      if (letter === '0') { delimited = true; delimiter = '\0'; }
      if (letter === 'i') { replace = t.slice(c + 1) || '{}'; break; }
      if (letter === 'l') { batch('lines', t.slice(c + 1)); break; }
      if (letter === 'e') break;
      if (XARGS_VALUE_SHORT.has(letter)) {
        const glued = c + 1 < t.length;
        // `-a <(…)`: the value was split off as a redirect (procSubFollows).
        const value = glued ? t.slice(c + 1) : procSubFollows(segment, words[k]) ? undefined : words[++k]?.text;
        if ((letter === 'I' || letter === 'J') && value !== undefined) replace = value;
        if (letter === 'J') appends = true;
        if (letter === 'd') {
          delimited = true;
          delimiter = xargsDelimiter(value);
          if (delimiter === null) return { unreadable: true };
        }
        if (XARGS_BATCH_SHORT[letter]) batch(XARGS_BATCH_SHORT[letter], value);
        break;
      }
    }
  }
  const program = words.slice(k);
  if (program.length === 0) return null;
  const split = { delimited, delimiter };
  const asArgv = () => ({ replace, appends, strings: [], argv: argvWordsWithoutRedirects(program).map((t) => t.text), ...split, batches });
  const programReadings = readingsOf(resolveSegmentVerb(program));
  const shell = programReadings.find(({ verb }) => DASH_C_SHELLS.has(verb) && !SU_LIKE_SHELLS.has(verb));
  if (shell === undefined || shell.index < 0) {
    // #1999 point 5: a program that runs the appended items — a su-like verb
    // (its command string), a nested xargs (its program), git (its own
    // arguments) — is read as the argv xargs builds (xargsArgvLines).
    // #2003 point 1: so is a program whose wrappers resolve to no verb
    // (`xargs env`, `xargs nice`, `xargs timeout 9`, `xargs sudo -u me`):
    // the first item is the program, the data a whole command line.
    const target = programReadings.find(({ verb, index }) => (index >= 0 && XARGS_ARGV_TARGETS.has(verb)) || verb === null || index < 0);
    return target === undefined ? null : asArgv();
  }
  const shellWords = argvWordsWithoutRedirects(program, shell.index + 1);
  const cAt = shellWords.findIndex((t) => !t.quoted && /^-[A-Za-z]*c[A-Za-z]*$/.test(t.text));
  // #2003 point 2: a shell with no fixed `-c` takes its options from the
  // items (`printf '%s\n' -c 'S' | xargs -d '\n' sh` runs `sh -c S`): each
  // window is judged as the shell's argv.
  if (cAt === -1) return asArgv();
  const strings = shellWords.slice(cAt + 1).map((t) => t.text);
  return { replace, appends, strings, ...split, batches };
}

/**
 * The delimiter a GNU `-d`/`--delimiter` value names (findutils xargs.c
 * get_input_delimiter, #2003 point 3, #2011): one character as written; a
 * backslash and one of `a b f n r t v \\` (GNU looks at that one character
 * only, so `\nX` is a newline too); else `\x` + hex digits or `\` + octal
 * digits, read by strtoul with NO length limit — `\0054`, `\054`, `\x2c`
 * and `\x02c` are all `,` (measured on GNU findutils 4.9.0, win-wsl,
 * 2026-11-10, with harmless `echo` forms). Leading zeros are dropped before
 * the value is checked against 255.
 *
 * null for every other value — one GNU refuses (more than 255, `\8`,
 * trailing characters, a multi-character value without `\`) or one only
 * strtoul's lenient edges accept (blanks or a sign after `\x`, a `0x`
 * prefix, an empty `\x`). The caller fails closed on null (unreadable):
 * GNU runs nothing for a refused value, and an accepted edge is denied
 * rather than read with a guessed delimiter. NAMED CEILING (BV-004): such a
 * harmless line is denied. REVISIT TRIGGER: a real xargs line denied for
 * its `-d` value.
 *
 * @param {string | undefined} value
 * @returns {string | null}
 */
function xargsDelimiter(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (value.length === 1) return value;
  if (value[0] !== '\\') return null;
  const named = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
  if (Object.hasOwn(named, value[1])) return named[value[1]];
  const m = /^\\(?:x([0-9A-Fa-f]+)|([0-7]+))$/.exec(value);
  if (m === null) return null;
  const digits = (m[1] ?? m[2]).replace(/^0+(?=.)/, '');
  if (digits.length > 3) return null;
  const code = m[1] !== undefined ? parseInt(digits, 16) : parseInt(digits, 8);
  return code <= 0xff ? String.fromCharCode(code) : null;
}

/**
 * The items xargs cuts from one data blob: at the delimiter with `-0`/`-d`
 * (a trailing delimiter ends the last item, it opens no empty one), else by
 * the quote rules of {@link xargsInputItems}. An undecodable `-d` value
 * never gets here: xargsShellCommand makes that reading unreadable (#2011).
 *
 * @param {string} data
 * @param {{ delimited?: boolean, delimiter?: string | null }} split
 * @returns {string[]}
 */
function xargsItems(data, { delimited = false, delimiter = null }) {
  if (!delimited) return xargsInputItems(data, false);
  const parts = data.split(delimiter ?? '\0');
  return parts.filter((x, i) => x !== '' || i < parts.length - 1);
}

/** xargs options that cut the items into batches (#1999 point 8), by kind. */
const XARGS_BATCH_SHORT = { n: 'args', L: 'lines', s: 'chars' };
const XARGS_BATCH_LONG = { 'max-args': 'args', 'max-lines': 'lines', 'max-chars': 'chars' };

/**
 * xargs programs that run the items xargs appends (#1999 point 5): `sg GROUP`
 * makes the item its command string, `su USER -c` the item behind `-c`, a
 * nested `xargs [sh -c]` its program and `-c` string, and `git` its own
 * subcommand and options (`echo checkout -f other | xargs git`).
 *
 * NAMED CEILING (BV-004): only these verbs; any other program's argv
 * (`xargs rm`, `xargs env git` resolves to git and is read) stays unread as
 * before. REVISIT TRIGGER: a reported discard through another xargs program.
 */
const XARGS_ARGV_TARGETS = new Set([...SU_LIKE_SHELLS, 'xargs', 'git']);

/**
 * The input items xargs reads from `data` when neither `-0` nor `-d` is given
 * (#1944 quote form): unquoted blanks and newlines separate items (in
 * `lineMode`, the `-I`/`-i` reading, only newlines, and leading blanks are
 * dropped); `'…'` and `"…"` group their text literally, a backslash outside
 * quotes takes the next character literally, and xargs REMOVES the quotes and
 * backslashes. So `printf '"git checkout -f other"' | xargs sh -c` runs the
 * one item `git checkout -f other` as the `-c` string. GNU findutils and BSD
 * xargs agree on these rules; both treat a backslash inside quotes literally.
 *
 * NAMED CEILING (BV-004): an unmatched quote (or a newline inside quotes) is
 * an error for both xargs; here the quote runs to the end of the data — the
 * union reading, it can only add an item. The `-E`/`-e` end-of-file string
 * and GNU's legacy `_` are not honoured (over-read: items past it are still
 * judged). REVISIT TRIGGER: a real command denied on an item past an EOF
 * string.
 *
 * @param {string} data
 * @param {boolean} lineMode
 * @returns {string[]}
 */
function xargsInputItems(data, lineMode) {
  const items = [];
  let cur = '';
  let open = false; // an item has started (an empty `""` is still an item)
  let quote = null;
  const flush = () => { if (open) items.push(cur); cur = ''; open = false; };
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '\n') { flush(); continue; }
    if (ch === ' ' || ch === '\t') {
      if (!lineMode) flush();
      else if (open) cur += ch;
      continue;
    }
    open = true;
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\' && i + 1 < data.length) cur += data[++i];
    else cur += ch;
  }
  flush();
  return items;
}

/**
 * An xargs item that is one plain shell word as a `-c` string: no blank, no
 * quote, no expansion (`$`, glob, brace, tilde), no operator or redirect.
 * An allow-list of characters, so anything unlisted stays a separate payload.
 * An empty item runs nothing and is plain too.
 *
 * NAMED CEILING (BV-004): assumes every untyped blocked pattern spans more
 * than one word (all 18 rules of `.orchestrator/policy/blocked-commands.json`
 * on 2026-11-10; the two `>` patterns are typed redirect rules, and `>` is not
 * plain). REVISIT TRIGGER: a single-word block pattern in the policy.
 */
const XARGS_PLAIN_ITEM = /^[A-Za-z0-9._/:@+=,-]*$/;

/**
 * The command lines the xargs shell runs over the piped data (#1944 points
 * 2/3), as a deny-side over-read: with a replace string, each `-c` word with
 * it replaced by every data line (and by the whole data); without a `-c`
 * string, or one that runs its positional arguments (`'eval "$0"'`), the data
 * itself. Without `-0`/`-d`, xargs splits unquoted data into words and only
 * the first is the `-c` string — reading the whole data over-reads that.
 *
 * Without `-0`/`-d` xargs also strips quotes and backslashes (xargsInputItems),
 * so the raw reading alone missed `printf '"git checkout -f other"' | xargs sh
 * -c` (ALLOW at c47eb57e). Both readings are judged — the raw data AND the
 * xargs items: every item (with `-n1`/`-L1` any item can head a batch and be
 * the `-c` string), the items joined by blanks (`"$@"`, `eval "$0" "$@"`), and
 * in `-I` mode each unquoted line as the replacement. A union, never one
 * reading picked: an option this table misreads cannot narrow the verdict
 * below today's raw reading.
 *
 * NAMED CEILING (BV-004): `delimited` comes from this table's own option
 * parse; a misread `-0`/`-d` drops only the item readings, back to the raw
 * reading of c47eb57e. REVISIT TRIGGER: a quoted-data xargs form behind an
 * option the table does not know.
 *
 * A {@link XARGS_PLAIN_ITEM} item is not judged on its own: as a `-c` string
 * it runs one word with no argument, which no multi-word blocked pattern
 * matches, and every payload costs one of the MAX_PAYLOAD_EVALUATIONS — 33
 * plain words through `xargs sh -c '… "$@"' _` exhausted the budget and the
 * harmless line was denied (F1, caed9e34). The joined reading still carries
 * every plain word. `-I` pieces are NOT filtered: a plain piece substituted
 * into the `-c` string (`sh -c 'git {} --hard'`) can complete a pattern.
 *
 * The `-I` substitution is charged to the line's pipe-read budget BEFORE a
 * string is built (#1999 point 1): every piece goes into every replace
 * occurrence of every `-c` string, so the output grows as pieces ×
 * occurrences × length — 3000 lines into 1000 `{}` took 5.7 s (past the
 * hook timeout, which Claude Code treats as ALLOW) and 5000 × 2000 ran out of
 * memory. A spent budget throws PIPE_READ_SPENT; pipedShellData marks the
 * reading `unreadable` and the line is denied.
 *
 * The data is judged whatever the `-c` string looks like (#1999 point 4),
 * with a replace string too (fix cycle H2: `-J`, and `-L`/`-n` after `-I`,
 * append the items): xargs appends the items as the shell's arguments, and
 * a script reaches them in forms no pattern lists (`for a; do eval "$a"`,
 * `eval "${!#}"`, `shift`, `"${@:2}"`, `set --`). Over-reading costs only a
 * line whose DATA is itself a blocked command while the script ignores it.
 *
 * The batches xargs cuts (`-n`, `-L`, `-s`) and the arguments the `-c`
 * string names are read too (#1999 points 8/9, {@link xargsBatchLines}).
 *
 * @param {{ replace: string | null, appends?: boolean, strings: string[], argv?: string[], delimited?: boolean, delimiter?: string | null, batches?: Array<{ kind: string, n: number }> }} xargsShell
 * @param {string[]} data
 * @param {{ work: number, startedAt: number, exhausted: boolean }} ctx - the line's pipe-read budget
 * @returns {string[]}
 */
function xargsCommandLines({ replace, appends = false, strings, argv, delimited = false, delimiter = null, batches = [] }, data, ctx) {
  const split = { delimited, delimiter };
  if (argv !== undefined) return xargsArgvLines({ replace, appends, argv, ...split, batches }, data, ctx);
  const out = new Set();
  const asReplace = replace !== null && replace !== '';
  // Each `-c` string holding the replace string, split once: its pieces cost
  // `literal + occurrences × piece.length` characters.
  const templates = asReplace
    ? strings.filter((t) => t.includes(replace)).map((t) => {
      const parts = t.split(replace);
      return { parts, literal: t.length - (parts.length - 1) * replace.length, occurrences: parts.length - 1 };
    })
    : [];
  for (const d of data) {
    // The data is judged as appended arguments with or without a replace
    // string (fix cycle H2): BSD `-J` appends the items, and GNU `-L`/`-n`
    // after `-I` clear the pattern — the same over-read as #1999 point 4.
    addBuiltLine(out, d, ctx);
    // A delimited item is the data between delimiters, verbatim (#2003
    // point 3: `-d X` splits at X as well as `-0` at NUL; a `-d` value this
    // reader cannot decode never gets here, its reading is unreadable,
    // #2011). Every item can head a batch and be the `-c` string,
    // delimited or not.
    const items = xargsItems(d, split);
    for (const item of items) if (!XARGS_PLAIN_ITEM.test(item)) addBuiltLine(out, item, ctx);
    if (items.length > 1) addBuiltLine(out, items.join(' '), ctx);
    // xargsBatchLines charges each line it builds.
    if (strings.length > 0) for (const line of xargsBatchLines(strings, items, batches, d, split, ctx)) out.add(line);
    // `xargs -I{} sh -c` with no `-c` string substitutes nothing (M2).
    if (!asReplace || strings.length === 0) continue;
    const pieces = new Set([d, ...d.split('\n').filter(Boolean)]);
    for (const item of delimited ? items : xargsInputItems(d, true)) pieces.add(item);
    for (const piece of pieces) {
      let chars = 0;
      for (const t of templates) chars += t.literal + t.occurrences * piece.length;
      chargePipeRead(ctx, 1 + Math.ceil(chars / XARGS_REPLACE_CHARS_PER_UNIT));
      for (const t of templates) addBuiltLine(out, t.parts.join(piece), ctx);
      // `-I{} sh -c 'git reset "$1"' _ {}`: the substituted arguments are the
      // script's positionals (#1999 point 9).
      const argv = strings.slice(1).map((w) => w.split(replace).join(piece));
      const named = substitutePositionals(strings[0].split(replace).join(piece), argv);
      if (named !== null) addBuiltLine(out, named, ctx);
    }
  }
  return [...out];
}

/**
 * The command lines one xargs data blob runs through a `-c` script batch by
 * batch (#1999 points 8/9), a deny-side over-read:
 *
 * - Batches: with `-n N` every N-item window (from EVERY item index, not
 *   only multiples of N — the real split depends on run-time expansion and
 *   on the shell, so the reader never counts it, #2006), with `-L N` every
 *   N-line window, with `-s N` (where a batch ends depends on lengths this
 *   reader does not know) every start index up to N characters; without a
 *   limit, the one batch of all items. Each window joined by blanks is a
 *   line (`sh -c '"$@"' _` runs it).
 * - Positionals: the `-c` string with its argument references replaced by
 *   the window — `"$@"`/`$@`/`$*` by the items joined, `$N`/`${N}` by
 *   argument N, where the words after the `-c` string come first (`sh -c
 *   'S' _ a` makes `$0=_`, `$1=a`; `sh -c 'S' a` makes `$0=a`):
 *   `echo --hard | xargs sh -c 'git reset "$@"' _` runs the hard reset.
 *
 * Every window iteration is charged to the line's pipe-read budget before
 * the window is sliced or its lines are built (xargsBatchWindows), duplicate
 * windows included, so a flood of items or of batch options fails closed
 * (PIPE_READ_SPENT) instead of running past the hook timeout. Each judged line costs one of the line's
 * MAX_PAYLOAD_EVALUATIONS, so the lines that cannot change the reading of
 * another are joined into ONE newline-separated payload
 * ({@link joinableXargsLine}): 40 plain words through `xargs -n1 sh -c 'wc
 * -l "$0"'` are one payload, not 80 (a spent payload budget denies the line,
 * the F1 false deny of caed9e34).
 *
 * @param {string[]} strings - the `-c` string and the words after it
 * @param {string[]} items - the data's xargs items
 * @param {Array<{ kind: string, n: number }>} batches
 * @param {string} data - the raw data blob (its lines, for `-L`)
 * @param {{ delimited: boolean }} split
 * @param {{ work: number, startedAt: number, exhausted: boolean }} ctx
 * @returns {string[]}
 */
function xargsBatchLines(strings, items, batches, data, split, ctx) {
  // #2012: an item that expands to nothing shifts the batches and the
  // positionals; without either the one batch of all items is the data
  // already judged, so no variant is built (and none can fail closed).
  const vanishing = batches.length > 0 || substitutePositionals(strings[0], []) !== null;
  const windows = xargsBatchWindows(items, batches, data, split, ctx, strings[0].length, { vanishing });
  const joinable = [];
  const single = [];
  const all = items.join(' ');
  // #2006: a line two windows build is charged to the cap once.
  const seen = new Set();
  for (const w of windows) {
    const plain = w.every((x) => XARGS_PLAIN_ITEM.test(x));
    const joined = w.join(' ');
    const lines = joined === all ? [] : [joined];
    const named = substitutePositionals(strings[0], [...strings.slice(1), ...w]);
    if (named !== null) lines.push(named);
    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      chargeXargsBuilt(ctx, line.length);
      (plain && joinableXargsLine(line, ctx) ? joinable : single).push(line);
    }
  }
  return joinable.length > 1 ? [joinable.join('\n'), ...single] : [...joinable, ...single];
}

/**
 * The item windows xargs runs its program with (xargsBatchLines): all items,
 * plus every batch window `-n`/`-L`/`-s` can cut.
 *
 * Every loop iteration is charged to the line's pipe-read budget BEFORE its
 * window is sliced or joined, whether or not the window turns out to be new
 * (fix cycle H1): the charge is computed from prefix sums of the item
 * lengths (with `baseLen` characters of fixed text), so the work spent on
 * slices, joins and duplicate keys is bounded by the units charged, and the
 * budget's time limit is checked on every iteration. The batch options are
 * deduplicated first, every limit that is not a positive number counting as
 * one "unknown" batch, and the `-L` lines are cut once. A spent budget throws
 * PIPE_READ_SPENT; the reading is then unreadable and the line denied.
 *
 * @param {string[]} items
 * @param {Array<{ kind: string, n: number }>} batches
 * @param {string} data
 * @param {{ delimited: boolean }} split
 * @param {{ work: number, startedAt: number, exhausted: boolean }} ctx
 * @param {number} baseLen
 * @returns {string[][]}
 */
function xargsBatchWindows(items, batches, data, { delimited }, ctx, baseLen, { vanishing = true } = {}) {
  const windows = new Map(); // items joined by NUL → items
  const cost = (chars) => 1 + Math.ceil((baseLen + chars) / XARGS_REPLACE_CHARS_PER_UNIT);
  const keep = (w) => {
    if (w.length === 0) return;
    const key = w.join('\0');
    if (!windows.has(key)) windows.set(key, w);
  };
  // NAMED CEILING (BV-004): a limit that is not a positive number reads as
  // unknown, like `-s`: every start index to the end. REVISIT TRIGGER: a
  // real line denied as unreadable through such a limit.
  const unique = new Map();
  for (const { kind, n } of batches) {
    const known = Number.isInteger(n) && n > 0;
    const k = known && !(kind === 'lines' && delimited) ? `${kind}:${n}` : 'unknown';
    if (!unique.has(k)) unique.set(k, k === 'unknown' ? { kind: 'unknown', n: NaN } : { kind, n });
  }
  const itemBatches = [...unique.values()].filter(({ kind }) => kind !== 'lines');
  const lineBatches = [...unique.values()].filter(({ kind }) => kind === 'lines');
  // #2012: every subset of the items that may expand to nothing removed
  // (xargsVanishingVariants); the first variant is `items` itself.
  for (const variant of xargsVanishingVariants(items, vanishing, ctx, cost)) {
    // prefix[i]: characters (each item plus one blank) of variant[0..i).
    const prefix = [0];
    for (const x of variant) prefix.push(prefix.at(-1) + x.length + 1);
    chargePipeRead(ctx, cost(prefix.at(-1)));
    keep(variant);
    for (const { kind, n } of itemBatches) {
      for (let i = 0; i < variant.length; i++) {
        let end = variant.length;
        if (kind === 'args') end = Math.min(variant.length, i + n);
        if (kind === 'chars') {
          end = i + 1;
          let len = variant[i].length + 1;
          while (end < variant.length && len + variant[end].length + 1 <= n) len += variant[end++].length + 1;
        }
        chargePipeRead(ctx, cost(prefix[end] - prefix[i]));
        keep(variant.slice(i, end));
      }
    }
  }
  if (lineBatches.length === 0) return [...windows.values()];
  // NAMED CEILING (BV-004): a line ending in a blank continues onto the
  // next for GNU `-L`; lines are cut at every newline here. REVISIT
  // TRIGGER: a reported discard through `-L` with trailing blanks.
  const lineItems = data.split('\n').map((l) => xargsInputItems(l, false));
  // Each line's items tagged with their line, so a variant can drop items and
  // then the lines left blank (GNU `-L` counts nonblank lines only).
  const tagged = lineItems.flatMap((l, j) => l.map((x) => ({ x, j })));
  for (const variant of xargsVanishingVariants(tagged, vanishing, ctx, (chars) => cost(chars), (t) => t.x)) {
    const lines = [];
    let at = -1;
    for (const { x, j } of variant) {
      if (j !== at) { lines.push([]); at = j; }
      lines.at(-1).push(x);
    }
    const linePrefix = [0];
    for (const l of lines) linePrefix.push(linePrefix.at(-1) + l.reduce((c, x) => c + x.length + 1, 0));
    for (const { n } of lineBatches) {
      for (let j = 0; j < lines.length; j++) {
        const to = Math.min(lines.length, j + n);
        chargePipeRead(ctx, cost(linePrefix[to] - linePrefix[j]));
        keep(lines.slice(j, to).flat());
      }
    }
  }
  return [...windows.values()];
}

/**
 * The most items that may expand to nothing one xargs data blob is read
 * with (#2012): every subset of them is removed in turn, 2^m variants.
 * NAMED CEILING (BV-004): past it the reading is unreadable and the line is
 * denied (pipedShellData `unreadable`), a harmless one too. 4 keeps the
 * variants at 16, each charged to the line's pipe-read budget; 0 of 4651
 * replayed real commands feed xargs a blob with more than one such item
 * (21 with one, 2026-11-10). REVISIT TRIGGER: a real xargs line denied as
 * unreadable through this limit.
 */
const XARGS_VANISHING_ITEMS_MAX = 4;

/**
 * The item sequences xargs may really get when items of the data expand at
 * run time (#2012): a word that is not {@link XARGS_PLAIN_ITEM} (`$X`,
 * `"$X"`, `$(…)`, a glob such as `*.zz(N)`) is 0..k words. k ≥ 1 is the
 * reading with the word kept: every window from every start index is built,
 * so the k words sit where the one did, and their content is the
 * "only literal data" ceiling. k = 0 is not: `echo w0 w1 <R> $X <H> | xargs
 * -n 2 git` runs `git <R> <H>` with X empty, a window the kept word splits
 * (also bash). So every subset of those items is removed in turn; with
 * `vanishing` false (nothing positional to shift) only `items` is returned.
 *
 * Each variant is charged to the line's pipe-read budget before it is built;
 * more than {@link XARGS_VANISHING_ITEMS_MAX} such items make the reading
 * unreadable (fail-closed).
 *
 * @template T
 * @param {T[]} items
 * @param {boolean} vanishing
 * @param {ReturnType<typeof newPipeRead>} ctx
 * @param {(chars: number) => number} cost - work units for `chars` characters
 * @param {(item: T) => string} [text]
 * @returns {Generator<T[]>}
 */
function* xargsVanishingVariants(items, vanishing, ctx, cost, text = (x) => x) {
  yield items;
  if (!vanishing) return;
  const at = [];
  let chars = 0;
  for (let i = 0; i < items.length; i++) {
    const t = text(items[i]);
    chars += t.length + 1;
    if (!XARGS_PLAIN_ITEM.test(t)) at.push(i);
  }
  if (at.length === 0) return;
  if (at.length > XARGS_VANISHING_ITEMS_MAX) {
    ctx.exhausted = true;
    throw PIPE_READ_SPENT;
  }
  for (let mask = 1; mask < 1 << at.length; mask++) {
    chargePipeRead(ctx, cost(chars));
    const drop = new Set(at.filter((_, b) => mask & (1 << b)));
    yield items.filter((_, i) => !drop.has(i));
  }
}

/** One argv word as command-line text: plain words bare, the rest single-quoted. */
const xargsArgvWord = (w) => (w !== '' && XARGS_PLAIN_ITEM.test(w) ? w : shellQuoteWord(w));

/**
 * The command lines an xargs program in {@link XARGS_ARGV_TARGETS} runs
 * (#1999 point 5) — or a program whose wrappers resolve to no verb (`xargs
 * env`, #2003 point 1) and a shell with no fixed `-c` (#2003 point 2): the
 * fixed argv with every batch window of items appended
 * (xargsBatchWindows), or with `-I` each piece substituted into the fixed
 * words, each word shell-quoted so the item stays ONE argument. The matcher
 * and the hook judge each line as a command: `sg staff 'S'` and `su me -c
 * 'S'` through suCommandStrings, `xargs sh -c 'S'` through the xargs
 * reading again (bounded by the payload recursion depth), `git checkout -f
 * other` as git. The raw data is not judged on its own here: these programs
 * never run it as a script, only as their arguments.
 *
 * Lines that change no shell context are joined into one newline-separated
 * payload (joinableXargsLine), so many plain windows cost one evaluation.
 *
 * With a replace string the items are appended as well when `appends` is
 * set (BSD `-J`, GNU `-L`/`-n` after `-I`): `printf 'checkout -f other' |
 * xargs -J % git` runs `git checkout -f other`.
 *
 * @param {{ replace: string | null, appends?: boolean, argv: string[], delimited: boolean, delimiter?: string | null, batches: Array<{ kind: string, n: number }> }} xargsArgv
 * @param {string[]} data
 * @param {{ work: number, startedAt: number, exhausted: boolean }} ctx
 * @returns {string[]}
 */
function xargsArgvLines({ replace, appends = false, argv, delimited, delimiter = null, batches }, data, ctx) {
  const split = { delimited, delimiter };
  const lines = new Set();
  const fixed = argv.map(xargsArgvWord).join(' ');
  for (const d of data) {
    if (replace !== null && replace !== '') {
      const pieces = new Set([d, ...d.split('\n').filter(Boolean)]);
      for (const item of delimited ? xargsItems(d, split) : xargsInputItems(d, true)) pieces.add(item);
      for (const piece of pieces) {
        chargePipeRead(ctx, 1 + Math.ceil(argv.reduce((n, w) => n + w.length + piece.length + 1, 0) / XARGS_REPLACE_CHARS_PER_UNIT));
        addBuiltLine(lines, argv.map((w) => xargsArgvWord(w.split(replace).join(piece))).join(' '), ctx);
      }
      // `-J %` and `-I{} -n1` also append the items (fix cycle H2).
      if (!appends) continue;
    }
    const items = xargsItems(d, split);
    for (const w of xargsBatchWindows(items, batches, d, split, ctx, fixed.length)) addBuiltLine(lines, [fixed, ...w.map(xargsArgvWord)].join(' '), ctx);
  }
  const joinable = [];
  const single = [];
  for (const line of lines) (joinableXargsLine(line, ctx) ? joinable : single).push(line);
  return joinable.length > 1 ? [joinable.join('\n'), ...single] : [...joinable, ...single];
}

/**
 * Argument references a `-c` string can name (#1999 point 9): `"$@"`,
 * `"${@}"`, `"$*"`, `"${*}"` with their quotes, bare `$@`/`$*`/`${@}`/`${*}`,
 * and `$N`/`${N}`.
 */
const POSITIONAL_REF = /"\$(?:[@*]|\{[@*]\})"|\$(?:[@*]|\{[@*]\})|\$([0-9])|\$\{([0-9]+)\}/g;

/**
 * The `-c` string with its argument references replaced by `argv` (`argv[0]`
 * is `$0`): `"$@"` and `$*` by `argv[1…]` joined by blanks, unquoted, so
 * each item is a word; `$N` by `argv[N]` (empty past the end), inside the
 * quotes it stood in. null when the string names no argument.
 *
 * NAMED CEILING (BV-004): operator forms (`${1:-x}`, `${@:2}`, `${!#}`) and
 * `shift` are not substituted; the data itself is still judged
 * (xargsCommandLines). An unquoted `$1` holding a blank is word-split, a
 * substituted `;` reads as an operator — both over-reads. REVISIT TRIGGER: a
 * reported discard through such a form whose data alone does not match.
 *
 * @param {string} script
 * @param {string[]} argv
 * @returns {string | null}
 */
function substitutePositionals(script, argv) {
  let hit = false;
  const out = script.replace(POSITIONAL_REF, (m, digit, braced) => {
    hit = true;
    const n = digit ?? braced;
    return n === undefined ? argv.slice(1).join(' ') : argv[Number(n)] ?? '';
  });
  return hit ? out : null;
}

/** A word no xargs line can contain: it marks where the next line starts. */
const XARGS_LINE_SENTINEL = 'xargsLineSentinel1999';

/**
 * Words that change what LATER statements of a shell mean (its directory,
 * variables, functions, aliases), plus any assignment `=`: a line holding one
 * is judged on its own, never joined in front of another batch's line.
 */
const XARGS_CONTEXT_WORD = /=|(?:^|[\s;&|(){}])(?:cd|pushd|popd|chdir|export|alias|set|unset|declare|typeset|local|readonly|source|\.|shopt|function|eval|exec|trap|hash|enable)(?=$|[\s;&|(){}])/;

/**
 * Whether a batch line may share one payload with the other batch lines
 * (xargsBatchLines): it changes no shell context for the lines after it, and
 * the lexer ends it at its newline — no open quote, here-document, line
 * continuation or hoisted substitution carries it on (or swallows the next
 * line). Checked with this module's own tokenizer: a sentinel line behind it
 * must be a fresh unquoted word after a newline separator.
 *
 * #1999 fix cycle H3: the tokenizer pass is charged to the line's pipe-read
 * budget BEFORE it runs (XARGS_TOKENIZE_CHARS_PER_UNIT), so a flood of long
 * batch lines fails closed instead of running uncharged past the hook
 * timeout.
 *
 * @param {string} line
 * @param {ReturnType<typeof newPipeRead>} ctx - the line's pipe-read budget
 * @returns {boolean}
 */
function joinableXargsLine(line, ctx) {
  if (line.includes('\n') || XARGS_CONTEXT_WORD.test(line)) return false;
  chargePipeRead(ctx, line.length / XARGS_TOKENIZE_CHARS_PER_UNIT);
  const tokens = tokenizeCommand(`${line}\n${XARGS_LINE_SENTINEL}`);
  const last = tokens.at(-1);
  const prev = tokens.at(-2);
  return last?.text === XARGS_LINE_SENTINEL && !last.quoted && prev?.operator === 'newline';
}

/**
 * Substituted `-I` output characters per pipe-read work unit (#1999 point 1).
 * NAMED CEILING (BV-004): with PIPE_READ_WORK units a line may build about
 * 1 MiB of substituted `-c` strings (STREAM_CAP); past it the xargs reading
 * is unreadable and the line is denied. 0 of 4651 replayed real commands
 * reach it (2026-11-10). REVISIT TRIGGER: a real `xargs -I` line denied as
 * unreadable pipe data.
 */
const XARGS_REPLACE_CHARS_PER_UNIT = 256;

/**
 * Tokenized batch-line characters per pipe-read work unit (joinableXargsLine,
 * #1999 fix cycle H3). NAMED CEILING (BV-004): the lines are already charged
 * when their window is built (XARGS_REPLACE_CHARS_PER_UNIT); this adds the
 * tokenizer pass at a quarter of that rate. The characters it tokenizes are
 * bounded first by XARGS_BUILT_CHARS_MAX (fix cycle H4), at most 64 units.
 * REVISIT TRIGGER: a real xargs line denied as unreadable pipe data.
 */
const XARGS_TOKENIZE_CHARS_PER_UNIT = 1024;

/** `source`/`.` run a file in the CURRENT shell — stdin is a script (#1944 point 8). */
const SOURCE_BUILTINS = new Set(['source', '.']);

/** Shells that run a process-substitution file as their script (#1944 point 4). */
const SCRIPT_READING_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'source', '.']);

/**
 * The literal command lines a process substitution feeds to a script-reading
 * shell (#1944 point 4): `bash <(echo 'S')` runs S as a script, `sh < <(echo
 * 'S')` reads it on stdin, `source <(echo 'S')` / `. <(printf 'S')` run it in
 * the current shell. The inner `echo`/`printf` statement's literal output is
 * read exactly as the pipe-to-shell reader reads `echo S | sh`
 * (pipelineLiteralData), so a `git reset --hard`, `git checkout -f` or `git rm
 * -f` inside is judged.
 *
 * Only when the segment's resolved verb is a {@link SCRIPT_READING_SHELLS}
 * shell — a process substitution to `diff` / `cat` is a data file, not a
 * script, so `diff <(git show HEAD:a.txt) a.txt` is untouched.
 *
 * NAMED CEILING (BV-004): a process substitution that is a DATA argument to a
 * shell SCRIPT (`bash run.sh <(echo 'S')`, where S is `$1`) is still read as a
 * script here — a deny-side over-read. Only literal `echo`/`printf` bodies are
 * read; `<(cat f)`, `<($(…))` stay unread. REVISIT TRIGGER: a real command
 * denied by the data-argument over-read.
 *
 * @param {Array<object>} segment
 * @returns {string[]}
 */
function procSubShellData(segment) {
  if (!readingsOf(resolveSegmentVerb(segment)).some(({ verb }) => SCRIPT_READING_SHELLS.has(verb))) return [];
  return procSubLiteralData(segment);
}

/**
 * The literal output of every process substitution `<( … )` in a segment,
 * read as pipelineLiteralData reads a pipe's left side (procSubShellData,
 * and the xargs reader for `xargs -a <(…)` / `xargs … < <(…)`, #1999
 * point 2).
 *
 * @param {Array<object>} segment
 * @returns {string[]}
 */
function procSubLiteralData(segment) {
  const out = [];
  for (const tok of segment) {
    for (const r of tok.substitutions ?? []) {
      const raw = tok.text.slice(r.start, r.end);
      if (!raw.startsWith('(')) continue; // a process substitution `( … )`, not `$( … )` / backtick
      for (const seg of splitSegments(tokenizeCommand(raw.slice(1, -1)))) {
        const data = pipelineLiteralData(seg);
        if (data === null) continue;
        for (const d of data) if (!out.includes(d)) out.push(d);
      }
    }
  }
  return out;
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
 * `git checkout --end-of-options -- a` exits 0 and discards). The argv form `git checkout --` stays
 * the wave-manifest pattern here (#1509). Same-ref resets and `git restore`
 * are judged since #1834 by measurement in `hooks/pre-bash-destructive-guard.mjs`
 * (`findPathResets` / `pathResetVerdict`), see ADR-0017 § Path reset.
 *
 * NAMED CEILING (BV-004, #1925 point 6): the merge-side options (`--ours`,
 * `--theirs`, `-m`, `--conflict`) are NOT plain checkout options here, so
 * `git checkout --ours -- a` does not match the `git checkout --` manifest
 * pattern, while `git restore --ours a` does (merge-side restore was measured
 * to discard even without a conflict). The asymmetry is kept on purpose:
 * blocking `git checkout --ours -- a` would deny a form allowed before #1917
 * without its own replay evidence. REVISIT TRIGGER: a replay that shows
 * git checkout --ours -- <path> discarding uncommitted work in a session.
 *
 * @param {string} word
 * @returns {boolean}
 */
function isPlainCheckoutOption(word) {
  if (/^-[qf]+$/.test(word) || word === '--end-of-options') return true;
  return spellsLongOption(word, '--quiet') || spellsLongOption(word, '--force');
}

/**
 * #1937 — do the words after `git checkout` (in front of any `--`) name the
 * ref-less list-file reset `git checkout --pathspec-from-file=<f>`? Only plain
 * checkout options (isPlainCheckoutOption), `--[no-]pathspec-file-nul` and at
 * least one `--pathspec-from-file` (a separate value word is its file name)
 * may stand there. Any other word — a ref above all — answers false: ref
 * parity with `git checkout HEAD -- a`, which the literal `git checkout --`
 * rule leaves to the destructive guard's measurement (readPathReset). This is
 * the argv twin of that literal rule for the forms it cannot spell, so it
 * reaches every reading gitArgvMatch reaches (find -exec, xargs, parallel,
 * git bisect run, git submodule foreach, shell payloads).
 *
 * @param {string[]} flagWords - argv texts after `checkout`, up to a bare `--`
 * @returns {boolean}
 */
function readsPathspecFile(flagWords) {
  let fromFile = false;
  for (let i = 0; i < flagWords.length; i++) {
    const w = flagWords[i];
    if (spellsLongOption(w, '--pathspec-from-file')) {
      fromFile = true;
      if (!w.includes('=')) i++;
      continue;
    }
    if (spellsLongOption(w, '--pathspec-file-nul') || spellsLongOption(w, '--no-pathspec-file-nul') || isPlainCheckoutOption(w)) continue;
    return false;
  }
  return fromFile;
}

/**
 * #1834 — the options of `git checkout <…> -- <path>` / `git restore` that
 * take the content from a merge side instead of a commit (`--ours`, `--theirs`,
 * `-m`/`--merge`, `--conflict=…`).
 */
const MERGE_SIDE_LONG = ['--ours', '--theirs', '--merge', '--conflict'];

/**
 * #1925 point 8a/9a — long options of `git checkout` / `git restore` whose
 * value may stand as the NEXT word (git 2.56.0, 2026-11-03, tmp repo: `git
 * checkout --conflict merge -- a.txt` and `git checkout -p -U 3 -- a.txt`
 * consumed `merge`/`3` and discarded a dirty a.txt, exit 0).
 * NAMED CEILING (BV-004): checkout's `-b`/`-B`/`--orphan` values were not
 * measured — they start a branch switch, not a `--` path reset read here.
 * REVISIT TRIGGER: a replay of `git checkout -b x -- p` read wrong.
 */
const SEPARATE_VALUE_LONG = ['--conflict', '--unified', '--inter-hunk-context'];

/** A short-option group: `-q`, `-2`, `-pU3`, `-sHEAD`. */
const SHORT_GROUP = /^-[a-zA-Z0-9]+$/;

/**
 * Split a short-option group at its first value-taking letter (`s` = source,
 * `U` = unified): the letters in front are flags, the rest is the attached
 * value (`-pU3` → flags `p`, letter `U`, value `3`). NAMED CEILING
 * (BV-004): the `[sU]` cut is shared by both verbs, though `checkout` has no
 * `-s`. REVISIT TRIGGER: a checkout short option measured to take a value
 * other than `-U`.
 *
 * @param {string} text
 * @returns {{ flags: string, letter: string|null, value: string }}
 */
function shortGroup(text) {
  const at = text.slice(1).search(/[sU]/);
  if (at === -1) return { flags: text.slice(1), letter: null, value: '' };
  return { flags: text.slice(1, at + 1), letter: text[at + 1], value: text.slice(at + 2) };
}

/**
 * Read one option word of `git checkout` / `git restore` into the merge-side
 * state (#1927 part c). Three fields, because git negates them differently
 * (git 2.56.0, 2026-11-03, throwaway repos with an unmerged c.txt):
 * - `merge` — the explicit merge: `-m` (also inside a group), `--merge`;
 *   cleared by `--no-merge` only, the last spelling wins (`git restore
 *   --merge --no-merge c.txt` exit 1 "path is unmerged", `--no-merge --merge`
 *   merges). `--no-conflict` does NOT clear it: `git checkout -m
 *   --no-conflict -- c.txt` and `git restore -m --no-conflict c.txt` exit 0
 *   and recreate the conflict markers (#1927 review J).
 * - `conflict` — the merge `--conflict[=…]` implies; cleared by `--no-conflict`
 *   and by `--no-merge`, last spelling wins (`--conflict=merge --no-conflict`
 *   and `--conflict=merge --no-merge` exit 1 "path is unmerged";
 *   `--no-merge --conflict=merge` and `--no-conflict --conflict=merge` merge).
 * - `stage` — `--ours`/`--theirs`/`-2`/`-3`, sticky: they have no negation
 *   (`--no-ours` exit 129) and `--ours --no-merge` still takes ours.
 * Abbreviations go through spellsLongOption (`--no-me`, `--merg`).
 *
 * @param {string} text - an option word (starts with `-`)
 * @param {{ merge: boolean, conflict: boolean, stage: boolean }} side - updated in place
 */
function readMergeSideWord(text, side) {
  if (SHORT_GROUP.test(text)) {
    const { flags } = shortGroup(text);
    if (flags.includes('m')) side.merge = true;
    if (/[23]/.test(flags)) side.stage = true;
    return;
  }
  if (spellsLongOption(text, '--no-merge')) { side.merge = false; side.conflict = false; }
  else if (spellsLongOption(text, '--no-conflict')) side.conflict = false;
  else if (spellsLongOption(text, '--merge')) side.merge = true;
  else if (spellsLongOption(text, '--conflict')) side.conflict = true;
  else if (MERGE_SIDE_LONG.some((name) => spellsLongOption(text, name))) side.stage = true;
}

/**
 * Does this option word consume the next word as its value (`-U 3`,
 * `-s HEAD`, `--conflict merge`)?
 *
 * @param {string} text
 * @returns {boolean}
 */
function takesNextWord(text) {
  if (SHORT_GROUP.test(text)) {
    const group = shortGroup(text);
    return group.letter !== null && group.value === '';
  }
  return !text.includes('=') && SEPARATE_VALUE_LONG.some((name) => spellsLongOption(text, name));
}

/**
 * Read one `git checkout` / `git restore` call as a path reset (#1834, moved
 * here from the destructive guard for #1917 point 2), or null when it is none.
 * Pure argv reading: no git call, no fs — the measurement stays in
 * `hooks/pre-bash-destructive-guard.mjs`. Words are read by their text.
 *
 * - `checkout`: a pathspec behind a bare `--`, or `--pathspec-from-file`
 *   (any unique-prefix spelling; its separate value word is consumed) with or
 *   without `--` (#1937: git 2.56.0, 2026-11-03, one tmp repo per form —
 *   `git checkout [<ref>] --pathspec-from-file=l` discarded a dirty a.txt
 *   listed in `l`, also with `=-`/stdin, `--pathspec-file-nul`, `-f`/`-q`).
 *   Words in front of `--` (all words without one) are options and the ref —
 *   the first non-option word; words behind it are paths. NAMED CEILINGS
 *   (BV-004): (1) `git checkout <path>` without `--` is not read; REVISIT
 *   TRIGGER: a replay hit of that form on a dirty path. (2) The list file is
 *   never read — a same-line write (`printf a > l && git checkout
 *   --pathspec-from-file=l`), stdin and `<(…)` are unreadable to the hook —
 *   so the caller judges a list-file reset unmeasurable, like restore's.
 *   (3) Forms git rejects are still read as list-file resets (an over-deny,
 *   the safe side): the ambiguous `--pathspec-f=`, a missing value,
 *   `--pathspec-from-file=l -- a` (exit 128) and `--end-of-options
 *   --pathspec-from-file=l` (a pathspec there); REVISIT TRIGGER: a replay
 *   hit of one of them in a session.
 * - `restore`: any pathspec or `--pathspec-from-file` (its separate value
 *   word is consumed); `--source=<ref>`, `--source <ref>`, `-s <ref>`,
 *   `-s<ref>` set the ref, `--no-source` clears it (last wins). `worktree` is false
 *   only for an index-only reset (`--staged`/`-S` without `--worktree`/`-W`,
 *   or `--no-worktree`): git 2.56.0, 2026-11-02, tmp repo — `git restore
 *   --staged a.txt` left the worktree file as it was and reset only the index.
 *
 * @param {string} sub - `checkout` or `restore`
 * @param {Array<{ text: string }>} words - argv after the subcommand
 * @returns {{ verb: string, ref: string|null, mergeSide: boolean, paths: Array<{ text: string }>, pathsFromFile: boolean, worktree: boolean } | null}
 */
export function readPathReset(sub, words) {
  if (sub === 'checkout') {
    const end = words.findIndex((t) => t.text === '--');
    const before = end === -1 ? words : words.slice(0, end);
    const paths = end === -1 ? [] : words.slice(end + 1);
    const side = { merge: false, conflict: false, stage: false };
    const refs = [];
    let pathsFromFile = false;
    for (let i = 0; i < before.length; i++) {
      const text = before[i].text;
      if (!text.startsWith('-') || text === '-') { refs.push(before[i]); continue; }
      // #1937: the list file names the paths; a separate value word is the
      // file name, never the ref (`git checkout --pathspec-from-file l`).
      if (spellsLongOption(text, '--pathspec-from-file')) {
        pathsFromFile = true;
        if (!text.includes('=')) i++;
        continue;
      }
      readMergeSideWord(text, side);
      if (takesNextWord(text)) i++; // `--conflict merge`, `-U 3`: a value, not the ref
    }
    if (!pathsFromFile && paths.length === 0) return null;
    return { verb: 'checkout', ref: refs.length > 0 ? refs[0].text : null, mergeSide: side.merge || side.conflict || side.stage, paths, pathsFromFile, worktree: true };
  }
  if (sub !== 'restore') return null;
  let ref = null;
  const side = { merge: false, conflict: false, stage: false };
  let pathsFromFile = false;
  let staged = false;
  let worktree = null; // null: not given — git then defaults to the worktree unless --staged
  const paths = [];
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    if (text === '--') { paths.push(...words.slice(i + 1)); break; }
    if (!text.startsWith('-') || text === '-') { paths.push(words[i]); continue; }
    if (spellsLongOption(text, '--source')) {
      ref = text.includes('=') ? text.slice(text.indexOf('=') + 1) : (words[++i]?.text ?? '');
      continue;
    }
    // `--no-source` undoes an earlier `--source`/`-s`; the last spelling wins,
    // as in git's option parser (git 2.56.0, 2026-11-03, tmp repo: `git
    // restore -s x --no-source a.txt` exit 0, dirty a.txt discarded).
    if (spellsLongOption(text, '--no-source')) { ref = null; continue; }
    if (spellsLongOption(text, '--pathspec-from-file')) {
      // A separate value is the file name, never an option: `git restore
      // --pathspec-from-file --staged` reads the file `--staged` and discards
      // (git 2.56.0, 2026-11-03, tmp repo: exit 0, dirty a.txt discarded).
      pathsFromFile = true;
      if (!text.includes('=')) i++;
      continue;
    }
    if (SHORT_GROUP.test(text)) {
      const { flags, letter, value } = shortGroup(text);
      readMergeSideWord(text, side);
      if (flags.includes('S')) staged = true;
      if (flags.includes('W')) worktree = true;
      if (letter === 's') ref = value !== '' ? value : (words[++i]?.text ?? '');
      else if (letter === 'U' && value === '') i++; // `-U 3`: a value, not a path
      continue;
    }
    if (spellsLongOption(text, '--staged')) staged = true;
    else if (spellsLongOption(text, '--no-staged')) staged = false;
    if (spellsLongOption(text, '--worktree')) worktree = true;
    else if (spellsLongOption(text, '--no-worktree')) worktree = false;
    readMergeSideWord(text, side);
    if (takesNextWord(text)) i++; // `--conflict merge`: a value, not a path
  }
  if (paths.length === 0 && !pathsFromFile) return null;
  return { verb: 'restore', ref, mergeSide: side.merge || side.conflict || side.stage, paths, pathsFromFile, worktree: worktree ?? !staged };
}

/**
 * A force switch's on/off state after one option word (#1939): `--<name>` and
 * its unique prefixes turn it on, `--no-<name>` off (git's OPT_BOOL; the last
 * spelling wins). A negation is read only from `--no-<first letter>` on, so a
 * bare `--no` (ambiguous for git, exit 129) cannot switch a force off.
 *
 * @param {string} text
 * @param {string[]} names - long option names (`--force`, `--discard-changes`)
 * @param {boolean} state
 * @returns {boolean}
 */
function forceState(text, names, state) {
  for (const name of names) {
    const neg = `--no-${name.slice(2)}`;
    const given = text.split('=')[0];
    if (given.length >= 6 && neg.startsWith(given)) return false;
    if (spellsLongOption(text, name)) return true;
  }
  return state;
}

/** The short letters that take a value in the groups readForcedDiscard reads. */
const FORCED_VALUE_LETTERS = Object.freeze({ checkout: /[bBU]/, switch: /[cC]/ });

/**
 * #1939 — read one `git checkout` / `git switch` / `git checkout-index` /
 * `git rm` call as a FORCED discard, or null when it is none. Pure argv
 * reading like readPathReset; the destructive guard measures the result
 * (findPathResets / measurePathReset) and denies over uncommitted changes.
 * Measured with git 2.56.0 on 2026-11-03 (throwaway repo, dirty tracked
 * a.txt): `git checkout -f [<ref>]`, `git switch -f|--discard-changes <b>`,
 * `git checkout-index -f a.txt|-a` and `git rm -f a.txt` all discarded or
 * deleted the uncommitted a.txt, exit 0.
 *
 * - `checkout` / `switch` with a force (`-f` in a short group in front of the
 *   first value letter — `-bfix` is `-b fix` — `--force`, switch's
 *   `--discard-changes`; `--no-…` clears it, last wins) and no pathspec →
 *   `whole`: every tracked file is measured, since a forced switch overwrites
 *   every local change. `git checkout -f <ref> <path…>` (only quiet/force
 *   options, two or more operands) and `git checkout -f [<ref>] -- <path…>`
 *   name paths; every operand is measured, the ref word included — a
 *   superset, the safe side, because git alone knows whether the first word
 *   is a ref. Any other option (`-b x`, `--orphan x`, `-m`) keeps `whole`.
 * - `checkout-index` with a force: `-a`/`--all` → `whole`, `--stdin` → `stdin`
 *   (paths on stdin, unmeasurable), else its operands (none: null — it
 *   writes nothing).
 * - `rm` with a force and no dry run (`-n`, `--dry-run`, last wins): its
 *   operands or `--pathspec-from-file` (a separate value word is the file).
 *
 * NAMED CEILINGS (BV-004): (1) `git checkout -f <other>` can also overwrite
 * an UNTRACKED file that `<other>` tracks; the measurement leaves untracked
 * files out (`--untracked-files=no`, as for every path reset). REVISIT
 * TRIGGER: a session losing an untracked file to a forced switch. (2)
 * `checkout-index --prefix=`/`--temp` write elsewhere and `rm --cached` keeps
 * the worktree file; all three are measured like the plain form (an
 * over-deny). REVISIT TRIGGER: a replay hit of one of them denied.
 *
 * @param {string} sub
 * @param {Array<{ text: string }>} words - argv after the subcommand
 * @returns {{ verb: string, ref: null, mergeSide: false, paths: Array<{ text: string }>, pathsFromFile: boolean, stdin: boolean, whole: boolean } | null}
 */
export function readForcedDiscard(sub, words) {
  const result = (verb, paths, extra = {}) => ({ verb, ref: null, mergeSide: false, paths, pathsFromFile: false, stdin: false, whole: false, ...extra });
  if (sub === 'checkout' || sub === 'switch') {
    // Fix cycle 1 (R-F1): switch's `--force` and `--discard-changes` are two
    // switches, each negated on its own; either one discards (git 2.56.0,
    // REFUTE review 2026-11-03: `git switch --force --no-discard-changes
    // other` discarded). One shared state let the last spelling clear both.
    let force = false;
    let discard = false;
    let plainOnly = true;
    let pathsFromFile = false;
    const operands = [];
    let after = null;
    for (let i = 0; i < words.length; i++) {
      const text = words[i].text;
      if (text === '--') { after = words.slice(i + 1); break; }
      if (!text.startsWith('-') || text === '-') { operands.push(words[i]); continue; }
      if (sub === 'checkout' && isPlainCheckoutOption(text)) {
        if (/^-[qf]+$/.test(text) ? text.includes('f') : spellsLongOption(text, '--force')) force = true;
        continue;
      }
      plainOnly = false;
      if (sub === 'checkout' && spellsLongOption(text, '--pathspec-from-file')) { pathsFromFile = true; if (!text.includes('=')) i++; continue; }
      // A short group is read left to right up to its first value letter;
      // the rest of the word is that value, whatever its characters (fix
      // cycle 1, C1: `-fBtopic-name`, `-fcfix/x` failed SHORT_GROUP and lost
      // the force).
      if (!text.startsWith('--')) {
        const cut = text.slice(1).search(FORCED_VALUE_LETTERS[sub]);
        if ((cut === -1 ? text.slice(1) : text.slice(1, cut + 1)).includes('f')) force = true;
        continue;
      }
      force = forceState(text, ['--force'], force);
      if (sub === 'switch') discard = forceState(text, ['--discard-changes'], discard);
    }
    if (!force && !discard) return null;
    const verb = `${sub} -f`;
    if (sub === 'checkout' && pathsFromFile) return result(verb, [], { pathsFromFile: true });
    if (sub === 'checkout' && after !== null && after.length > 0) return result(verb, after);
    // Fix cycle 1 (R-F2): the operands are measured as a superset only while
    // every one is a plain path; a magic pathspec (`:!b.txt`, `:(exclude)…`,
    // `:/`) subtracts or re-roots, so `git status -- HEAD ':!b.txt'` measured
    // nothing while git updated a.txt. Then the whole tree is measured.
    if (sub === 'checkout' && plainOnly && after === null && operands.length >= 2 && !operands.some((t) => t.text.startsWith(':'))) return result(verb, operands);
    return result(verb, [], { whole: true });
  }
  if (sub === 'checkout-index') {
    let force = false;
    let all = false;
    let stdin = false;
    const paths = [];
    for (let i = 0; i < words.length; i++) {
      const text = words[i].text;
      if (text === '--') { paths.push(...words.slice(i + 1)); break; }
      if (!text.startsWith('-') || text === '-') { paths.push(words[i]); continue; }
      if (SHORT_GROUP.test(text)) {
        if (text.includes('f')) force = true;
        if (text.includes('a')) all = true;
        continue;
      }
      force = forceState(text, ['--force'], force);
      if (spellsLongOption(text, '--all')) all = true;
      if (spellsLongOption(text, '--stdin')) stdin = true;
    }
    if (!force) return null;
    if (stdin) return result('checkout-index -f', [], { stdin: true });
    if (all) return result('checkout-index -f', [], { whole: true });
    return paths.length > 0 ? result('checkout-index -f', paths) : null;
  }
  if (sub === 'read-tree') {
    // #1944 point 7: `git read-tree -u --reset <tree>` rewrites the index and
    // the worktree to <tree> and, per git-read-tree(1) § --reset, "updates
    // leading to loss of working tree changes … will not abort" — a
    // `reset --hard` without moving HEAD. Measured like a forced switch: the
    // whole tracked tree. `-m -u` aborts on a dirty entry ("not uptodate.
    // Cannot merge"), so only `--reset` counts; `-n`/`--dry-run` writes nothing.
    let update = false;
    let reset = false;
    let dryRun = false;
    for (const { text } of words) {
      if (text === '--') break;
      if (!text.startsWith('-') || text === '-') continue;
      if (SHORT_GROUP.test(text)) {
        if (text.includes('u')) update = true;
        if (text.includes('n')) dryRun = true;
        continue;
      }
      reset = forceState(text, ['--reset'], reset);
      dryRun = forceState(text, ['--dry-run'], dryRun);
    }
    return update && reset && !dryRun ? result('read-tree -u --reset', [], { whole: true }) : null;
  }
  if (sub !== 'rm') return null;
  let force = false;
  let dryRun = false;
  let pathsFromFile = false;
  const paths = [];
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    if (text === '--') { paths.push(...words.slice(i + 1)); break; }
    if (!text.startsWith('-') || text === '-') { paths.push(words[i]); continue; }
    if (SHORT_GROUP.test(text)) {
      if (text.includes('f')) force = true;
      if (text.includes('n')) dryRun = true;
      continue;
    }
    if (spellsLongOption(text, '--pathspec-from-file')) { pathsFromFile = true; if (!text.includes('=')) i++; continue; }
    force = forceState(text, ['--force'], force);
    dryRun = forceState(text, ['--dry-run'], dryRun);
  }
  if (!force || dryRun) return null;
  if (pathsFromFile) return result('rm -f', [], { pathsFromFile: true });
  return paths.length > 0 ? result('rm -f', paths) : null;
}

/**
 * Does a `git restore` call (its words after `restore`, null = `emptyWord`
 * placeholder) discard worktree content the way `git checkout -- <path>` does
 * (#1917 point 2)? Only then does the `git checkout --` wave-manifest pattern
 * match it. A placeholder reads as an empty unknown operand — a path, the
 * matching (deny) side.
 * NAMED CEILINGS (BV-004): (1) parity with the checkout rule, which leaves
 * ref-sourced forms unjudged (#1831, HR-101): `--source`/`-s` stays unjudged;
 * REVISIT TRIGGER: a replay of a ref-sourced restore discarding work inside a
 * wave. (2) An index-only reset (`--staged`) does not match: the blob it
 * drops from the index stays in the object store. (3) A merge-side restore
 * (`--ours`, `-m`) DOES match: git 2.56.0 (2026-11-02) ran `git restore
 * --ours a.txt` on a non-conflicted dirty path with exit 0 and discarded it;
 * REVISIT TRIGGER: a wave denied while resolving a real conflict.
 *
 * @param {Array<string|null>} after
 * @returns {boolean}
 */
function restoreDiscardsWorktree(after) {
  const reset = readPathReset('restore', after.map((w) => ({ text: w ?? '' })));
  return reset !== null && reset.ref === null && reset.worktree;
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
 * pattern itself and for `+` refspecs, which stay refspecs behind `--`. The
 * `checkout --` pattern also matches the ref-less list-file reset without a
 * `--` (readsPathspecFile, #1937).
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
 * A null word is the `emptyWord` placeholder of the empty-expansion reading
 * (#1893): skipped before the subcommand, an unknown operand after it.
 *
 * @param {Array<string|null>} words — argv texts after the `git` verb
 * @param {{ sub: string, flags: string[] }} spec
 * @returns {boolean}
 */
function gitWordsMatch(words, spec) {
  let i = 0;
  for (; i < words.length && (words[i] === null || words[i].startsWith('-')); i++) {
    if (GIT_GLOBALS_WITH_VALUE.has(words[i])) i++;
  }
  // #1917 point 2: `git checkout --` also names the `git restore` path reset.
  if (words[i] === 'restore' && spec.restore !== false && spec.sub === 'checkout' && spec.flags.length === 1 && spec.flags[0] === '--') {
    return restoreDiscardsWorktree(words.slice(i + 1));
  }
  if (words[i] !== spec.sub) return false;
  const after = words.slice(i + 1).map((w) => w ?? '');
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
    if (flag === '--') {
      return (end !== -1 && after.slice(0, end).every(isPlainCheckoutOption))
        || (spec.sub === 'checkout' && readsPathspecFile(flagWords));
    }
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
      const words = argvWordsWithoutRedirects(segment, reading.index + 1, { bash }).map((t) => (t.emptyWord ? null : t.text));
      if (gitWordsMatch(words, spec)) return true;
    }
  }
  return false;
}

/**
 * The `git restore` twin of the literal `git checkout --` match (#1917 point
 * 2, review R1). The checkout form inside a wrapper (`xargs`, `find -exec`,
 * `watch`, `parallel`, `npx`, `git bisect run`) matches through
 * unquotedSegmentMatch: the words `git checkout --` in a row in the argv
 * skeleton. This reads the same skeleton — quoted plain words count, a quoted
 * word holding whitespace or a boundary character is no `git` word, so
 * `echo "git restore a"` and `git commit -m "git restore a"` stay inert — and
 * matches a `git` word directly followed by `restore` whose words discard
 * worktree content (restoreDiscardsWorktree).
 *
 * - The verb's own `git` word is gitArgvMatch's (it reads git globals); here
 *   the first `git` word is skipped only when EVERY reading's verb is `git`.
 *   A wrapper flag of unknown arity (`caffeinate -i`, `env -i`) gives a
 *   second reading whose verb is the next word; skipping on ANY git reading
 *   lost `caffeinate -i xargs git restore` (#1932). An ambiguous segment
 *   scans its first `git` word too — more matches, never fewer.
 * - An EMPTY path list matches: `xargs` and `find` append the paths. A
 *   placeholder path word is appended for that.
 * - The words stop at a `;` word or a `{} +` pair, the end of a `find -exec`
 *   command; later find predicates (`-size`) are not restore options.
 *
 * NAMED CEILINGS (BV-004): (1) like the checkout twin, no git globals between
 * `git` and `restore` (`xargs git -C . restore a` misses, as `xargs git -C .
 * checkout -- a` does; measured 2026-11-03); REVISIT TRIGGER: a replay hit of a
 * wrapper git call with globals. (2) A value-taking option that ends the words
 * (`xargs git restore -s`) takes the placeholder as its ref and does not
 * match — the ref arrives on stdin, a ref-sourced reset, unjudged like
 * restoreDiscardsWorktree's ceiling (1). A restore inside a QUOTED shell
 * payload under `xargs`/`find` (`xargs sh -c 'git restore a.txt'`,
 * `find … -exec sh -c 'git restore "$1"' _ {} \;`) is not read here but by
 * check 2b of matchSegments (#1925 point 1), the twin of the literal
 * quoted-token match its checkout form gets in check 2.
 *
 * A `git` word followed by `checkout` matches when its words name the
 * ref-less list-file reset (readsPathspecFile, #1937) — for every spec of the
 * `checkout --` pattern, `restore: false` included, as check 1 matches the
 * literal `watch git checkout -- a` for it too.
 *
 * @param {Array<object>} segment
 * @param {object} resolved — resolveSegmentVerb(segment)
 * @param {boolean} restore — false: the `git restore` twin is not read (`restore: false` spec)
 * @returns {boolean}
 */
function wrappedRestoreMatch(segment, resolved, restore) {
  // A search tool neither runs nor prints its arguments: `grep git restore`
  // searches for the word `git` in a file `restore` (#1932 point 4). `every`
  // keeps an ambiguous second reading (unknown wrapper flag) on the deny side.
  // echo/printf stay out on purpose — their output can be piped into a shell.
  // `rg --pre <cmd>` runs a command per searched file (#1932 B1); any word
  // with the `--pre` prefix (`--pre=`, also the harmless `--pre-glob`) is
  // read conservatively and takes no exemption.
  const rgPre = segment.some((t) => t.text.startsWith('--pre'));
  const searchReading = (r) => SEARCH_ONLY_VERBS.has(r.verb) && !(r.verb === 'rg' && rgPre);
  if (readingsOf(resolved).every(searchReading)) return false;
  // #1937 over-deny: a reading that only searches runs no git word either, so
  // `env -i grep git restore` (readings `grep` and `git`) skips the first `git`
  // word like a plain git segment — its git reading is gitArgvMatch's (`git
  // restore` without a path discards nothing; `env -i grep git restore a.txt`
  // still matches there). Any other non-git reading (`xargs`, `echo`) scans it.
  const isGitReading = (r) => r.verb === 'git' && r.index >= 0;
  const gitVerb = readingsOf(resolved).some(isGitReading)
    && readingsOf(resolved).every((r) => isGitReading(r) || searchReading(r));
  const views = segment.some((t) => t.bashArgvWord !== undefined) ? [true, false] : [true];
  for (const bash of views) {
    const toks = argvWordsWithoutRedirects(segment, 0, { bash });
    // null: a quoted word that can never equal `git`/`restore` (a path to git).
    const words = toks.map((t) => ((t.quoted || t.data) && (t.text === '' || QUOTED_NON_WORD_RE.test(t.text)) ? null : t.text));
    let skip = gitVerb;
    for (let j = 0; j + 1 < words.length; j++) {
      if (words[j] !== 'git') continue;
      if (skip) { skip = false; continue; }
      if (words[j + 1] !== 'restore' && words[j + 1] !== 'checkout') continue;
      const after = [];
      for (let k = j + 2; k < toks.length; k++) {
        if (toks[k].text === ';' || (toks[k].text === '+' && toks[k - 1]?.text === '{}')) break;
        after.push(words[k]);
      }
      if (words[j + 1] === 'checkout') {
        // #1937: `watch git checkout --pathspec-from-file=l` — the literal
        // `git checkout --` words that check 1 reads for `watch git checkout
        // -- a` are not there, and `watch` is no verb gitArgvMatch unwraps.
        const end = after.indexOf('--');
        if (readsPathspecFile((end === -1 ? after : after.slice(0, end)).map((w) => w ?? ''))) return true;
        continue;
      }
      if (restore && restoreDiscardsWorktree([...after, null])) return true;
    }
  }
  return false;
}

/**
 * Verbs that only search their arguments — never run or print them (#1932 point 4).
 * `ag` and `ack` are out (#1932 B1): their `--pager` option executes a command
 * (the_silver_searcher passes it to popen). `rg` stays, minus `--pre` (wrappedRestoreMatch).
 *
 * NAMED CEILINGS (BV-004, #1933 points 1 and 2):
 * (1) The exemption is wrappedRestoreMatch's only. Check 1 (unquotedSegmentMatch)
 *     judges an unquoted literal in every verb's argv, search tools included:
 *     `grep git checkout -- a` is denied though grep only searches. Fail-closed,
 *     usability only; 0/22,905 replay commands (0/9,614 with a search verb) at
 *     53ac5051, 2026-11-03. REVISIT TRIGGER: a replay census or operator report
 *     showing the form.
 *     The `grep` entry is safe for BSD and GNU grep. On the M4 the agent shell's
 *     `grep` is a Claude Code function running ugrep 7.8.4, which forwards
 *     `--filter`/`--pager`/`--view`/`--format-open`/`--config` to BSD grep, which
 *     rejects them; ugrep itself runs commands with `--filter` and `--pager` (the
 *     pager only with a pty). So the entry holds for ugrep only through that
 *     function (measured 2026-11-03). REVISIT TRIGGER: a fleet host where `grep`
 *     resolves to ugrep directly.
 * (2) Leaving `ag`/`ack` out keeps their segments judged, but `ag --pager <cmd>`
 *     / `ack --pager=<cmd>` start a pager command whose quoted value is not read
 *     as a payload (dedupedSegmentPayloads reads `-c`-style shells, wrappers and
 *     `eval`, no pager option). ag and ack are absent on the M4 and win-wsl, 0
 *     of 22,905 replay commands use them (2026-11-03). REVISIT TRIGGER: ag or
 *     ack installed on a fleet host or appearing in a replay census.
 */
const SEARCH_ONLY_VERBS = new Set(['grep', 'egrep', 'fgrep', 'rg']);

/** Verbs whose payload `hooks/pre-bash-destructive-guard.mjs` reads itself (`walkGitSegments`). */
const GUARD_READ_PAYLOAD_VERBS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'eval']);

/**
 * Does a segment of a payload nobody else reads carry a `git checkout` /
 * `git restore` path reset that discards worktree content, judged by the
 * matcher or not (#1925 review MED)? `gitWordsMatch` leaves the ref-sourced
 * forms (`git restore --source=HEAD a`, `-s HEAD`, `git checkout HEAD -- a`)
 * unjudged because the destructive guard measures them where it sees them
 * (#1831); inside a quoted word under `xargs`/`find` it does not see them, so
 * there they count as a match (fail-closed). Index-only `git restore
 * --staged` and calls readPathReset reads as no reset (`git checkout main`,
 * `git checkout -b x`) stay unmatched. Git globals are skipped as gitWordsMatch
 * skips them.
 *
 * @param {Array<object>} segment
 * @param {object} resolved — resolveSegmentVerb(segment)
 * @returns {boolean}
 */
function unreadPathResetMatch(segment, resolved) {
  for (const reading of readingsOf(resolved)) {
    if (reading.verb !== 'git' || reading.index < 0) continue;
    for (const bash of [true, false]) {
      const words = argvWordsWithoutRedirects(segment, reading.index + 1, { bash }).map((t) => (t.emptyWord ? '' : t.text));
      let i = 0;
      for (; i < words.length && (words[i] === '' || words[i].startsWith('-')); i++) {
        if (GIT_GLOBALS_WITH_VALUE.has(words[i])) i++;
      }
      const sub = words[i];
      if (sub !== 'checkout' && sub !== 'restore') continue;
      const reset = readPathReset(sub, words.slice(i + 1).map((text) => ({ text })));
      if (reset !== null && reset.worktree) return true;
    }
  }
  return false;
}

/** A parameter name after `$` or `${` (`HOME`, `1`, `@`, `#`, …). */
const PARAM_NAME_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/;

/**
 * How deep default words inside default words are read (`${a:-${b:-…}}`).
 * NAMED CEILING (BV-004): a deeper one is not read, and its segment counts as
 * a match — unjudged is fail-closed here, as for an exhausted payload budget
 * (review of !310: reading it as empty let `--ha${a:-…9 levels…r}d` pass).
 * REVISIT TRIGGER: a real command denied for nesting this deep.
 */
const MAX_DEFAULT_WORD_DEPTH = 8;

/** emptyExpansionText / emptyExpansionSegment result past MAX_DEFAULT_WORD_DEPTH. */
const UNREAD = Symbol('default word nested too deep to read');

/**
 * Index of the `}` closing the `${` whose body starts at `from`, or -1. Only
 * braces the shell sees count: quoted ones (ctx 0) and those inside a
 * substitution are skipped.
 *
 * @param {string} text
 * @param {Uint8Array} ctx — per character: 0 literal, 1 unquoted, 2 in `"…"`
 * @param {Map<number, number>} subEnd — substitution start → end
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function closingBraceAt(text, ctx, subEnd, from, to) {
  let open = 0;
  for (let j = from; j < to; j++) {
    const end = subEnd.get(j);
    if (end !== undefined) { j = end - 1; continue; }
    if (ctx[j] === 0) continue;
    if (text[j] === '$' && text[j + 1] === '{' && ctx[j + 1] !== 0) { open++; j++; continue; }
    if (text[j] === '}') {
      if (open === 0) return j;
      open--;
    }
  }
  return -1;
}

/**
 * Read the expansion at `i` (a `$` the shell expands) as empty, or return null
 * for a literal `$`. See emptyExpansionText. Sets `state.capped` past
 * MAX_DEFAULT_WORD_DEPTH.
 *
 * An unquoted `$` right before a double-quoted run is a locale string `$"…"`
 * (#1895): without a message catalog bash passes its text and drops the `$`
 * (`git reset $"--hard"` is a hard reset), so this reading drops it too. The
 * lexer keeps it (zsh's reading); the two readings together judge both shells.
 *
 * @returns {{ text: string, end: number } | null}
 */
function readEmptyExpansion(text, ctx, subEnd, i, to, depth, state) {
  const c = ctx[i];
  // `state.doubleAt` also holds an EMPTY double-quoted run: `res$""et` (#1899).
  if (c === 1 && i + 1 <= to && (state.doubleAt.has(i + 1) || (ctx[i + 1] === 2 && i + 1 < to))) return { text: '', end: i + 1 };
  const next = i + 1 < to && ctx[i + 1] === c ? text[i + 1] : '';
  if (next === '{') {
    const close = closingBraceAt(text, ctx, subEnd, i + 2, to);
    if (close === -1) return { text: '', end: to };
    const body = text.slice(i + 2, close);
    const name = PARAM_NAME_RE.exec(body)?.[0] ?? '';
    const op = /^:?[-=]/.exec(body.slice(name.length))?.[0];
    if (name === '' || op === undefined) return { text: '', end: close + 1 };
    if (depth >= MAX_DEFAULT_WORD_DEPTH) {
      state.capped = true;
      return { text: '', end: close + 1 };
    }
    const word = readEmptyExpansions(text, ctx, subEnd, i + 2 + name.length + op.length, close, depth + 1, state);
    return { text: word, end: close + 1 };
  }
  if (next === '(') {
    // `$((…))` arithmetic: the lexer keeps it as word text (a `$( … )`
    // substitution never gets here, subEnd skipped it).
    let open = 0;
    for (let j = i + 1; j < to; j++) {
      if (ctx[j] === 0) continue;
      if (text[j] === '(') open++;
      else if (text[j] === ')' && --open === 0) return { text: '', end: j + 1 };
    }
    return { text: '', end: to };
  }
  if (/[A-Za-z_]/.test(next)) {
    let j = i + 2;
    while (j < to && ctx[j] === c && /[A-Za-z0-9_]/.test(text[j])) j++;
    return { text: '', end: j };
  }
  if (next !== '' && /[0-9@*#?$!-]/.test(next)) return { text: '', end: i + 2 };
  return null;
}

/**
 * The characters `from`..`to` of a word in the empty-expansion reading.
 *
 * @returns {string}
 */
function readEmptyExpansions(text, ctx, subEnd, from, to, depth, state) {
  let out = '';
  for (let i = from; i < to;) {
    const end = subEnd.get(i);
    if (end !== undefined) { i = end; continue; }
    if (ctx[i] !== 0 && text[i] === '$') {
      const exp = readEmptyExpansion(text, ctx, subEnd, i, to, depth, state);
      if (exp !== null) { out += exp.text; i = exp.end; continue; }
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * The empty-expansion reading of one word token (#1893): its text as the shell
 * builds it when no variable is set and every command substitution prints
 * nothing. In an expanding part (`none` / `double`, tokenizeCommand § parts)
 * `$name`, `$1`, `$@`, `${…}`, `$((…))` and every `$( … )` / backtick
 * substitution read as empty; `${x:-w}`, `${x-w}`, `${x:=w}` and `${x=w}` read
 * as their word `w`, itself read the same way. A process substitution keeps its
 * text (the shell passes a file name for it).
 * NAMED CEILING (BV-004): the lexer splits a word at a blank inside `${…}`, so a
 * default word with a blank (`${x:- reset}`) is not read, and a variable whose
 * VALUE spells the flag (`git reset $MODE`) cannot be read at all. REVISIT
 * TRIGGER: a transcript census hit of either form in a git command.
 *
 * @param {{ text: string, parts?: Array<{ text: string, quote: string }>, substitutions?: Array<{ start: number, end: number }> }} tok
 * @returns {string|null|symbol} the reading, null when the word expands
 *   nothing, or UNREAD past MAX_DEFAULT_WORD_DEPTH
 */
function emptyExpansionText(tok) {
  const { text, parts } = tok;
  if (parts === undefined || !/[$`]/.test(text)) return null;
  const ctx = new Uint8Array(text.length);
  // Start offsets of the double-quoted runs, zero-length ones included — the
  // only trace an empty `""` leaves in `parts` (#1899).
  const doubleAt = new Set();
  let at = 0;
  for (const p of parts) {
    if (p.quote === 'double') doubleAt.add(at);
    ctx.fill(p.quote === 'none' ? 1 : p.quote === 'double' ? 2 : 0, at, at + p.text.length);
    at += p.text.length;
  }
  const subEnd = new Map();
  for (const s of tok.substitutions ?? []) {
    if (text[s.start] !== '(') subEnd.set(s.start, s.end);
  }
  const state = { capped: false, doubleAt };
  const reading = readEmptyExpansions(text, ctx, subEnd, 0, text.length, 0, state);
  if (state.capped) return UNREAD;
  return reading === text ? null : reading;
}

/**
 * Mark a word copy whose text is an empty-expansion reading (#1896): its `$`
 * is gone, so a path consumer must still treat its value as unknown.
 * Non-enumerable, so the token's shape stays the one tests compare.
 * `sourceText` is the word's text before the reading (non-enumerable too):
 * a consumer can tell a literal tail of the source word from expanded text.
 *
 * @param {object} tok
 * @param {string} [sourceText]
 * @returns {object} tok
 */
function markExpanded(tok, sourceText) {
  Object.defineProperty(tok, 'expanded', { value: true, enumerable: false });
  if (sourceText !== undefined) Object.defineProperty(tok, 'sourceText', { value: sourceText, enumerable: false });
  return tok;
}

/**
 * The empty-expansion reading of a chain segment (#1893), or null when no word
 * of it expands, or UNREAD (see MAX_DEFAULT_WORD_DEPTH).
 *
 * An unquoted word that reads empty — the shell drops it — is dropped only in
 * front of the verb (`${x} git …`). Behind it, it stays as an `emptyWord`
 * placeholder with text '': the git argv match skips it only before the
 * subcommand (`git ${x} reset --hard` is a hard reset) and reads it as an
 * unknown operand after it, so `git checkout $REF -- f` stays the ref-sourced
 * form #1831 leaves unjudged (review of !310: dropping it everywhere denied
 * that form). A quoted word that reads empty stays an empty argument (`"$x"`).
 * A changed word is a copy without `parts`; so is a glued close whose bash
 * argv word changed (`git 3>&-res${x}et`, #1832).
 *
 * @param {Array<object>} segment
 * @returns {Array<object>|null|symbol}
 */
function emptyExpansionSegment(segment) {
  let changed = false;
  let verbSeen = false;
  const out = [];
  for (const tok of segment) {
    // A here-doc body past MAX_TOKENIZER_NESTING the lexer did not read.
    if (tok.unread === true) return UNREAD;
    const argv = tok.bashArgvWord === undefined ? null : emptyExpansionText(tok.bashArgvWord);
    if (argv === UNREAD) return UNREAD;
    if (argv !== null) {
      changed = true;
      const copy = { ...tok };
      const empty = argv === '' && !tok.bashArgvWord.quoted;
      if (!empty || verbSeen) {
        const word = empty ? { text: '', quoted: false, emptyWord: true } : { text: argv, quoted: tok.bashArgvWord.quoted };
        Object.defineProperty(copy, 'bashArgvWord', { value: word, enumerable: false });
        verbSeen = true;
      }
      out.push(copy);
      continue;
    }
    const text = emptyExpansionText(tok);
    if (text === UNREAD) return UNREAD;
    const isWord = !tok.redirect && tok.operator === undefined;
    if (text === null) {
      out.push(tok);
      if (isWord && !isAssignmentWord(tok)) verbSeen = true;
      continue;
    }
    changed = true;
    if (text === '' && !tok.quoted) {
      if (verbSeen) out.push(markExpanded({ ...tok, text: '', emptyWord: true }));
      continue;
    }
    out.push(markExpanded({ ...tok, text }, tok.text));
    if (isWord && !isAssignmentWord(tok, text)) verbSeen = true;
  }
  return changed ? out : null;
}

/** git subcommands that run a command line given as their argument (#1925 point 12). */
const GIT_PAYLOAD_RUNNERS = new Map([['submodule', 'foreach'], ['bisect', 'run']]);

/**
 * Is a segment a `git submodule … foreach <cmd>` / `git bisect run <cmd>`
 * call, whose quoted argument git runs as a command line (#1925 point 12)?
 * Git globals are skipped as unreadPathResetMatch skips them, options between
 * the subcommand and its verb too (`git submodule --quiet foreach`).
 *
 * @param {Array<object>} segment
 * @param {object} resolved — resolveSegmentVerb(segment)
 * @returns {boolean}
 */
function gitRunsPayload(segment, resolved) {
  for (const reading of readingsOf(resolved)) {
    if (reading.verb !== 'git' || reading.index < 0) continue;
    const words = argvWordsWithoutRedirects(segment, reading.index + 1).map((t) => t.text);
    if (gitPayloadStart(words) !== -1 || gitShellAliasRun(words, segment.slice(0, reading.index))) return true;
  }
  return false;
}

/**
 * Does this git call run a shell alias it defines itself (#1955 (a2))? `git -c
 * alias.z='!git rm -f' z a` runs `git rm -f a` through the shell, and an alias
 * value from a variable, a substitution or `--config-env` may be one. Alias
 * names compare case-insensitively, as git reads them. A defined alias that is
 * not the subcommand runs nothing.
 * An alias from leading `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`
 * assignments counts too (`env` words, gitEnvConfigWords; #1957 fix cycle 1).
 * NAMED CEILING (BV-004): a shell alias from a config file, from
 * `GIT_CONFIG_PARAMETERS` or from a `GIT_CONFIG_*` variable exported by an
 * earlier statement is not read. REVISIT TRIGGER: a replayed discard through
 * a configured shell alias.
 *
 * @param {string[]} words — argv texts after the `git` verb
 * @param {Array<{ text: string }>} [env] — the words before the `git` verb
 * @returns {boolean}
 */
export function gitShellAliasRun(words, env = []) {
  const shell = new Set();
  words = [...gitEnvConfigWords(env).map((t) => t.text), ...words];
  let i = 0;
  for (; i < words.length && words[i].startsWith('-'); i++) {
    let value = null;
    let fromEnv = false;
    if (words[i] === '-c') value = words[++i] ?? '';
    else if (words[i] === '--config-env') { value = words[++i] ?? ''; fromEnv = true; }
    else if (words[i].startsWith('--config-env=')) { value = words[i].slice('--config-env='.length); fromEnv = true; }
    else if (GIT_GLOBALS_WITH_VALUE.has(words[i])) { i++; continue; }
    if (value === null) continue;
    const m = /^alias\.([^=]*)=(.*)$/is.exec(value);
    if (m === null) continue;
    if (fromEnv || m[2].startsWith('!') || /[$`]/.test(m[2])) shell.add(m[1].toLowerCase());
  }
  const sub = words[i];
  return sub !== undefined && shell.has(sub.toLowerCase());
}

/**
 * The argv after `git` with an alias the call defines itself resolved (#1957):
 * `git -c alias.z='reset --hard' z` runs `git reset --hard`, so the alias word
 * is replaced by its value's words in front of the remaining arguments, as
 * git does. A chain (`-c alias.a=b -c alias.b='reset --hard' a`) is followed,
 * each name once (git refuses a loop). Alias names compare case-insensitively;
 * the last definition wins. A shell alias (`!…`) is gitShellAliasRun's, not
 * resolved here. Callers read the result as an ADDITIONAL reading (union):
 * git runs a builtin of the same name instead of the alias.
 * Leading `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` assignments (`env`)
 * define aliases too, before the `-c` ones (git 2.56 reads them first, so a
 * `-c` of the same name wins; #1957 fix cycle 1, gitEnvConfigWords).
 * NAMED CEILING (BV-004): an alias from a config file, `GIT_CONFIG_PARAMETERS`,
 * a `GIT_CONFIG_*` variable exported by an earlier statement or
 * `--config-env` is not resolved (the last is a shell alias candidate,
 * gitShellAliasRun). REVISIT TRIGGER: a replayed discard through a configured
 * alias.
 *
 * @param {Array<{ text: string, quoted?: boolean }>} words - argv after the `git` verb, redirects removed
 * @param {Array<{ text: string }>} [env] — the words before the `git` verb
 * @returns {Array<{ text: string, quoted?: boolean }>|null} null when no inline alias is the subcommand
 */
export function gitInlineAliasWords(words, env = []) {
  const defined = gitEnvConfigWords(env);
  const start = defined.length === 0 ? words : [...defined, ...words];
  let current = start;
  const used = new Set();
  for (;;) {
    const aliases = new Map();
    let i = 0;
    for (; i < current.length && (current[i].text === '' || current[i].text.startsWith('-')); i++) {
      if (current[i].text === '-c') {
        const m = /^alias\.([^=]*)=(.*)$/is.exec(current[i + 1]?.text ?? '');
        if (m !== null) aliases.set(m[1].toLowerCase(), m[2]);
        i++;
      } else if (GIT_GLOBALS_WITH_VALUE.has(current[i].text)) i++;
    }
    const name = current[i]?.text.toLowerCase();
    const value = aliases.get(name);
    if (value === undefined || value.startsWith('!') || used.has(name)) break;
    used.add(name);
    const valueWords = tokenizeCommand(value).map((t) => ({ text: t.text, quoted: t.quoted }));
    current = [...current.slice(0, i), ...valueWords, ...current.slice(i + 1)];
  }
  return current === start ? null : current;
}

/**
 * The `-c alias.<name>=<value>` word pairs that leading environment
 * assignments `GIT_CONFIG_KEY_<n>=alias.<name>` / `GIT_CONFIG_VALUE_<n>=…`
 * define for the git call behind them (#1957 fix cycle 1; git 2.56 runs
 * `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.z GIT_CONFIG_VALUE_0='reset
 * --hard' git z`). Every key that has a number counts, whatever
 * `GIT_CONFIG_COUNT` says (fail toward deny); a missing value is empty.
 * Only assignment words count (`env` and other prefixes are skipped).
 *
 * @param {Array<{ text: string }>} env - the words before the `git` verb
 * @returns {Array<{ text: string }>}
 */
function gitEnvConfigWords(env) {
  if (!env.some((t) => /^GIT_CONFIG_KEY_/.test(t.text))) return [];
  const keys = new Map();
  const values = new Map();
  for (const t of env) {
    const m = /^GIT_CONFIG_(KEY|VALUE)_(\d+)=(.*)$/s.exec(t.text);
    if (m !== null) (m[1] === 'KEY' ? keys : values).set(m[2], m[3]);
  }
  const out = [];
  for (const [n, key] of keys) {
    if (/^alias\./i.test(key)) out.push({ text: '-c' }, { text: `${key}=${values.get(n) ?? ''}` });
  }
  return out;
}

/**
 * Does a segment define a git alias in its leading environment for a command
 * the guard does not read as the git call behind it (#1957 fix cycle 3)? A
 * leading `GIT_CONFIG_KEY_<n>=alias.<name>` assignment (also after `env` and
 * its options; key and `alias.` compared case-insensitively) reaches every git
 * the command starts: `E bash -c 'git z'`, `E eval 'git z'`, `E xargs git z`
 * run the alias, and only a direct git reading feeds gitEnvConfigWords. So the
 * segment fails closed unless some git reading has every defining assignment
 * in front of its `git` word. A defined alias that no git call uses is denied
 * with it (over-deny, BV-002).
 * NAMED CEILING (BV-004): `GIT_CONFIG_PARAMETERS`, a `GIT_CONFIG_*` exported
 * by an earlier statement, a config file and assignments behind a wrapper
 * other than `env` (`sudo E …`) are not read. REVISIT TRIGGER: a replayed
 * discard through one of them.
 *
 * @param {Array<object>} segment
 * @returns {boolean}
 */
export function gitEnvAliasUnfollowed(segment) {
  if (!segment.some((t) => /^GIT_CONFIG_KEY_\d+=alias\./i.test(t.text))) return false;
  const words = argvWordsWithoutRedirects(segment, 0);
  const defining = [];
  let afterEnv = false;
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    // env(1) takes a quoted `NAME=VALUE` as an assignment too.
    if (isAssignmentWord(words[i]) || (afterEnv && ENV_ASSIGN_RE.test(text))) {
      if (/^GIT_CONFIG_KEY_\d+=alias\./i.test(text)) defining.push(words[i]);
      continue;
    }
    if (programName(text) === 'env') { afterEnv = true; continue; }
    if (!afterEnv || !text.startsWith('-')) break;
    if (WRAPPER_UNWRAP.get('env').argFlags.has(text)) i++;
  }
  if (defining.length === 0) return false;
  return !readingsOf(resolveSegmentVerb(segment)).some((r) => r.index >= 0 && String(r.verb).toLowerCase() === 'git'
    && defining.every((t) => segment.indexOf(t) < r.index));
}

/**
 * The inline-alias readings of a segment (#1957): per git reading and both
 * argv views, the segment up to its `git` word followed by the argv with the
 * alias resolved (gitInlineAliasWords). Empty when the segment defines no
 * alias.
 *
 * @param {Array<object>} segment
 * @returns {Array<Array<object>>}
 */
function inlineAliasSegments(segment) {
  if (!segment.some((t) => /alias\./i.test(t.text))) return [];
  const out = [];
  for (const reading of readingsOf(resolveSegmentVerb(segment))) {
    if (reading.verb !== 'git' || reading.index < 0) continue;
    for (const bash of [true, false]) {
      const resolved = gitInlineAliasWords(argvWordsWithoutRedirects(segment, reading.index + 1, { bash }), segment.slice(0, reading.index));
      if (resolved !== null) out.push([...segment.slice(0, reading.index + 1), ...resolved]);
    }
  }
  return out;
}

/**
 * The index of the first command word behind `submodule … foreach` /
 * `bisect run` in the words after `git` (options after the runner verb,
 * `foreach --recursive`, are skipped), or -1 when the call runs no payload.
 *
 * @param {string[]} words — argv texts after the `git` verb
 * @returns {number}
 */
function gitPayloadStart(words) {
  let i = 0;
  for (; i < words.length && (words[i] === '' || words[i].startsWith('-')); i++) {
    if (GIT_GLOBALS_WITH_VALUE.has(words[i])) i++;
  }
  const want = GIT_PAYLOAD_RUNNERS.get(words[i]);
  if (!want) return -1;
  let j = i + 1;
  while (j < words.length && words[j].startsWith('-')) j++;
  if (words[j] !== want) return -1;
  let k = j + 1;
  while (k < words.length && words[k].startsWith('-')) k++;
  return k;
}

/** `xargs` short options whose value may stand as the next word (GNU + BSD: `-n 1`, `-I {}`). */
const XARGS_VALUE_LETTERS = new Set(['a', 'd', 'E', 'I', 'J', 'L', 'n', 'P', 'R', 's', 'S']);

/** GNU `parallel` short options whose value may stand as the next word (`-j 2`, `-n 1`, `-S host`). */
const PARALLEL_VALUE_LETTERS = new Set(['a', 'C', 'd', 'E', 'I', 'j', 'L', 'n', 'N', 'P', 's', 'S']);

/** `find` actions that run the words up to `;` (or `{} +`) as a command. */
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** `parallel` separators between its command and its argument sources. */
const PARALLEL_SEPARATORS = new Set([':::', '::::', ':::+', '::::+']);

/**
 * GNU parallel replacement strings (#1932 point 1, from its documentation —
 * parallel is not installed on the measuring host): `{}` `{.}` `{/}` `{//}`
 * `{/.}`, the same per source `{N…}` / `{-N…}`, `{#}` `{%}`, `{=perl=}`.
 * Groups: 1 = source number, 2 = path transform.
 */
const PARALLEL_REPLACEMENT_RE = /\{(-?\d+)?(\/\/|\/\.|\/|\.)?\}|\{[#%]\}|\{=[\s\S]*?=\}/;
const PARALLEL_REPLACEMENT_RE_G = new RegExp(PARALLEL_REPLACEMENT_RE.source, 'g');

/**
 * `parallel` options whose grammar is known and that leave the argument →
 * word mapping alone (#1932 fix cycle 2, an ALLOWLIST). Any other option —
 * unknown, abbreviated (GNU parallel reads options with Getopt::Long, which
 * accepts unique abbreviations), or one that changes the mapping (`-n`, `-N`,
 * `-L`, `-X`, `-m`, `-C`, `-I`, `--colsep`, `--plus`, `--pipe`, …) — makes the
 * template unreadable, so it is read fail-closed (parallelFailClosedLine).
 */
const PARALLEL_READABLE_BOOL_LONG = new Set([
  '--keep-order', '--link', '--xapply', '--quote', '--verbose', '--progress', '--bar', '--eta', '--dry-run',
]);
const PARALLEL_READABLE_VALUE_LONG = new Set(['--jobs', '--halt', '--sshlogin', '--env', '--tmpdir', '--results', '--joblog']);
const PARALLEL_READABLE_BOOL_SHORT = new Set(['k', 'q', 'v']);
const PARALLEL_READABLE_VALUE_SHORT = new Set(['j', 'S']);

/** A replacement value as the shell line parallel builds sees it: plain, or single-quoted. */
function shellQuoteValue(text) {
  return /^[A-Za-z0-9_.,/:=+@%-]*$/.test(text) && text !== '' ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * Perl `File::Basename::dirname` on a Unix path — GNU parallel's `{//}`.
 * Reference values (`perl -MFile::Basename`, macOS host, 2026-11-03):
 * `clean//file` → `clean`, `a/b/` → `a`, `file` → `.`, `a//` → `.`, `/x` → `/`.
 *
 * @param {string} v
 * @returns {string}
 */
function perlDirname(v) {
  const s = v.replace(/\/+$/, '');
  if (s === '') return v.startsWith('/') ? '/' : '.';
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  return s.slice(0, i).replace(/\/+$/, '') || '/';
}

/**
 * Can `{.}` `{/}` `{/.}` `{//}` be rendered for this value without guessing
 * GNU parallel's edge behaviour (#1932 fix cycle 2)? `{.}` removes a final
 * `.ext` that holds no `/`; `{/}` is everything after the last `/`; `{//}` is
 * perlDirname. NAMED CEILING (BV-004): a value with a trailing `/` (Perl's
 * basename strips it, a `s:.*\/::` substitution does not), an empty value,
 * and for the extension transforms a basename that starts or ends with `.`
 * (`.bashrc`, `file.`) are not rendered — the template is read fail-closed.
 * REVISIT TRIGGER: GNU parallel on the measuring host, or a replayed real
 * call denied through such a value.
 *
 * @param {string} v
 * @param {string} transform — `.` `/` `//` `/.`
 * @returns {boolean}
 */
function parallelTransformSure(v, transform) {
  if (v === '') return false;
  if (transform === '//') return true;
  if (v.endsWith('/')) return false;
  if (transform === '/') return true;
  const base = v.replace(/^.*\//, '');
  return !base.startsWith('.') && !base.endsWith('.');
}

/**
 * One word of a parallel command with a job's arguments substituted (#1932
 * point 1). `job` holds one value per source; a `{}` reaches here only with a
 * single source (a bare `{}` over several sources is spliced by
 * renderParallelLine, a glued or transformed one is unreadable). Only called
 * for a readable template (no `{=…=}`, every `{N}` in range, every transform
 * parallelTransformSure).
 *
 * @param {string} text
 * @param {string[]} job
 * @param {number} jobNo — 1-based, for `{#}`
 * @param {boolean} quote — shell-quote the values (the joined shell line)
 * @returns {string}
 */
function renderParallelWord(text, job, jobNo, quote) {
  return text.replace(PARALLEL_REPLACEMENT_RE_G, (m, n, transform) => {
    if (m === '{#}') return String(jobNo);
    if (m === '{%}') return '1';
    let v = job.join(' ');
    if (n !== undefined) {
      const k = Number(n);
      v = job[k < 0 ? job.length + k : k - 1] ?? '';
    }
    const base = v.replace(/^.*\//, '');
    if (transform === '.') v = v.replace(/\.[^./]+$/, '');
    else if (transform === '/') v = base;
    else if (transform === '//') v = perlDirname(v);
    else if (transform === '/.') v = base.replace(/\.[^.]+$/, '');
    return quote ? shellQuoteValue(v) : v;
  });
}

/**
 * A parallel command line with one job's arguments substituted (#1932 fix
 * cycle 2): GNU parallel replaces a `{}` standing alone with EACH argument of
 * the job as a word of its own (quoted separately), so `git {} ::: clean :::
 * -fdx` runs `git clean -fdx`, not `git 'clean -fdx'`.
 *
 * @param {Array<{ text: string }>} line
 * @param {string[]} job
 * @param {number} jobNo
 * @returns {{ argv: Array<object>, shell: string }}
 */
function renderParallelLine(line, job, jobNo) {
  const argv = [];
  const shell = [];
  for (const t of line) {
    if (t.text === '{}' && job.length > 1) {
      for (const v of job) { argv.push({ ...t, text: v }); shell.push(shellQuoteValue(v)); }
      continue;
    }
    argv.push({ ...t, text: renderParallelWord(t.text, job, jobNo, false) });
    shell.push(renderParallelWord(t.text, job, jobNo, true));
  }
  return { argv, shell: shell.join(' ') };
}

/**
 * Read a parallel call's argument sources and options (#1932 point 1).
 * Options are read against the allowlist above, getopt-style: a bundle
 * (`-kj2`, `-kI XX`) is scanned letter by letter up to its first value-taking
 * letter; the scan stops at the first word that is no option (the command
 * start of this reading).
 *
 * @param {Array<{ text: string }>} opts — the runner's option words before the command
 * @param {Array<{ text: string }>} rest — the words from the first separator on
 * @param {Array<{ text: string }>} line — the command words
 * @returns {{ readable: boolean, repl: string[], jobs: () => string[][], count: number }}
 *   `repl` = extra replacement strings set by options; `jobs()` = one value list per job
 */
function readParallelSources(opts, rest, line) {
  let readable = true;
  let linkAll = false;
  const repl = [];
  for (let i = 0; i < opts.length; i++) {
    const t = opts[i].text;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t : t.slice(0, eq);
      if (name === '--link' || name === '--xapply') linkAll = true;
      if (PARALLEL_READABLE_VALUE_LONG.has(name)) {
        if (eq < 0) i++;
      } else if (!PARALLEL_READABLE_BOOL_LONG.has(name) || eq >= 0) {
        readable = false;
        // Any other long option may define a replacement string — a full name
        // (`--extensionreplace XX`) or a Getopt::Long abbreviation (`--extensionr
        // XX`, `--rep XX`) — so its value is read as one for the fail-closed
        // reading. Over-reads toward deny only.
        repl.push(eq >= 0 ? t.slice(eq + 1) : opts[i + 1]?.text ?? '');
      }
    } else if (/^-./.test(t)) {
      for (let k = 1; k < t.length; k++) {
        const c = t[k];
        if (PARALLEL_READABLE_BOOL_SHORT.has(c)) continue;
        const valueLetter = PARALLEL_READABLE_VALUE_SHORT.has(c) || PARALLEL_VALUE_LETTERS.has(c);
        if (!PARALLEL_READABLE_VALUE_SHORT.has(c)) readable = false;
        if (c === 'I') repl.push(t.slice(k + 1) || (opts[i + 1]?.text ?? ''));
        if (c === 'i') repl.push(t.slice(k + 1) || '{}');
        if (valueLetter && k === t.length - 1) i++;
        break;
      }
    } else {
      break;
    }
  }
  const sources = [];
  for (const t of rest) {
    if (PARALLEL_SEPARATORS.has(t.text)) sources.push({ sep: t.text, values: [] });
    else sources.at(-1)?.values.push(t.text);
  }
  if (sources.length === 0 || sources.some((s) => s.sep.startsWith('::::'))) readable = false;
  for (const t of line) {
    for (const m of t.text.matchAll(PARALLEL_REPLACEMENT_RE_G)) {
      if (m[0] === '{#}' || m[0] === '{%}') continue;
      if (m[0].startsWith('{=')) { readable = false; continue; }
      const n = m[1];
      if (n !== undefined && (Number(n) === 0 || Math.abs(Number(n)) > sources.length)) { readable = false; continue; }
      // A `{}` over several sources: standing alone it is spliced word by
      // word (renderParallelLine); glued to text or transformed it is not
      // one word per argument, so it is read fail-closed. A transform standing
      // alone (`{.}`, `{/}`, `{//}`, `{/.}`) counts too: GNU transforms EACH
      // argument, renderParallelWord the joined string (#1932 B2).
      const transform = m[2];
      if (n === undefined && sources.length > 1 && (m[0] !== t.text || transform !== undefined)) readable = false;
      if (transform !== undefined) {
        const k = Number(n);
        const values = n === undefined ? sources.flatMap((s) => s.values)
          : sources[k < 0 ? sources.length + k : k - 1].values;
        if (values.some((v) => !parallelTransformSure(v, transform))) readable = false;
      }
    }
  }
  // Linked sources (`:::+`, `--link`) form one group, paired by position; the
  // shorter one wraps — a superset of GNU's truncating `:::+` pairs.
  const groups = [];
  for (const [i, s] of sources.entries()) {
    if (i > 0 && (linkAll || s.sep.endsWith('+'))) groups.at(-1).push(i);
    else groups.push([i]);
  }
  const sizes = groups.map((g) => (g.some((i) => sources[i].values.length === 0) ? 0 : Math.max(...g.map((i) => sources[i].values.length))));
  const count = sizes.reduce((a, b) => a * b, 1);
  const jobs = () => {
    const out = [];
    for (let n = 0; n < count; n++) {
      const job = new Array(sources.length);
      let rem = n;
      for (let g = groups.length - 1; g >= 0; g--) {
        const pos = rem % sizes[g];
        rem = Math.floor(rem / sizes[g]);
        for (const i of groups[g]) job[i] = sources[i].values[pos % sources[i].values.length];
      }
      out.push(job);
    }
    return out;
  };
  return { readable, repl, jobs, count };
}

/**
 * The fail-closed reading of a parallel command line whose template is not
 * readable (#1932 point 1): `{=…=}`, a file/stdin source, a replacement-
 * changing option. A word holding a replacement string (or the placeholder
 * `{}` standing for unreadable appended arguments) could become anything, so
 * against the git pattern `spec`:
 *   (a) in git's subcommand position it becomes the pattern's subcommand and
 *       flags;
 *   (b) behind the pattern's own subcommand, one that starts with `-` or
 *       stands alone becomes the pattern's flags;
 *   (c) otherwise it stays as written — an unknown operand.
 * Not the empty-expansion null word (#1893): gitWordsMatch skips null words
 * before the subcommand, which would lose (a).
 * NAMED CEILING (BV-004): only a line whose `git` word is a plain word, or
 * whose command word holds a replacement string (read as `git`), is
 * rewritten (a wrapper in front is fine: the first `git` word is taken), and
 * the `git restore` twin of `checkout --` gets no (b) reading.
 * REVISIT TRIGGER: a replayed real parallel call with an unreadable template
 * that destroys work through `git restore`.
 *
 * @param {Array<{ text: string }>} line
 * @param {{ sub: string, flags: string[] }} spec
 * @param {string[]} repl — extra replacement strings set by options
 * @returns {Array<{ text: string }>}
 */
function parallelFailClosedLine(line, spec, repl) {
  const isTemplate = (t) => PARALLEL_REPLACEMENT_RE.test(t) || repl.some((r) => r !== '' && t.includes(r));
  const standsAlone = (t) => t.replace(PARALLEL_REPLACEMENT_RE_G, '') === '' || repl.includes(t);
  let gi = line.findIndex((t) => programName(t.text) === 'git');
  // A command word that holds a replacement string could BE git (`g{} clean
  // -fdx :::: f`, #1932 fix cycle 2): read it as git.
  if (gi < 0 && line.length > 0 && isTemplate(line[0].text)) {
    line = [{ ...line[0], text: 'git' }, ...line.slice(1)];
    gi = 0;
  }
  if (gi < 0) return line;
  let i = gi + 1;
  while (i < line.length && line[i].text.startsWith('-') && !isTemplate(line[i].text)) {
    if (GIT_GLOBALS_WITH_VALUE.has(line[i].text)) i++;
    i++;
  }
  if (i >= line.length) return line;
  const as = (tok, texts) => texts.map((text) => ({ ...tok, text }));
  if (isTemplate(line[i].text)) return [...line.slice(0, i), ...as(line[i], [spec.sub, ...spec.flags]), ...line.slice(i + 1)];
  if (line[i].text !== spec.sub) return line;
  return [...line.slice(0, i + 1), ...line.slice(i + 1).flatMap((t) => (
    isTemplate(t.text) && (t.text.startsWith('-') || standsAlone(t.text)) ? as(t, spec.flags) : [t]))];
}

/**
 * Where does the command an option-taking runner executes start (#1927 part
 * b)? The first non-option word after `from`; when that word directly follows
 * a value-taking option (`isValueOption`), the NEXT non-option word too —
 * both readings are returned and judged, the union (the deny side).
 *
 * @param {Array<{ text: string }>} words
 * @param {number} from
 * @param {(text: string) => boolean} isValueOption
 * @returns {number[]}
 */
function runnerCommandStarts(words, from, isValueOption) {
  let k = from;
  while (k < words.length && words[k].text.startsWith('-') && words[k].text !== '-') k++;
  if (k >= words.length) return [];
  if (k === from || !isValueOption(words[k - 1].text)) return [k];
  let next = k + 1;
  while (next < words.length && words[next].text.startsWith('-')) next++;
  return next < words.length ? [k, next] : [k];
}

/**
 * The indices of the words that name git (`git`, `/usr/bin/git`) inside a
 * runner's option prefix — each a possible command start of an option-taking
 * runner (#1927 review A). The prefix is the run of option words and the one
 * word after each (a possible value): `-n 1 -P 4 git …`, `--max-args 1 git …`,
 * `-tI {} git …`. It ends at the first word that is neither, which the option
 * table already reads as the command start — so `xargs echo git clean -fdx`
 * (git as an argument of echo) adds no start.
 *
 * A word naming a command wrapper (WRAPPER_UNWRAP: `env`, `timeout`, `nice`,
 * …) or a shell interpreter (SHELL_EXEC_INTERPRETERS: `sh`, `bash`, …)
 * starts one too (#1927 fix cycle 2): `xargs -n 1 -P 4 env git clean -fdx`,
 * `xargs -n 1 -P 4 sh -c 'git clean -fdx'` — the re-read line then goes
 * through resolveSegmentVerb's unwrap and check 3's `-c` payload.
 *
 * @param {Array<{ text: string }>} words
 * @returns {number[]}
 */
function gitWordStarts(words) {
  const starts = [];
  let afterOption = false;
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text;
    const base = programName(text);
    if (base === 'git' || WRAPPER_UNWRAP.has(base) || SHELL_EXEC_INTERPRETERS.has(base)) starts.push(i);
    if (text.startsWith('-') && text !== '-') afterOption = true;
    else if (afterOption) afterOption = false;
    else break;
  }
  return starts;
}

/**
 * The command lines a runner segment executes (#1927 part b): the argv words
 * of `xargs <cmd…>`, `find … -exec <cmd…> ;` (or `{} +`), `parallel <cmd…>
 * [::: …]`, `git submodule foreach <cmd…>` and `git bisect run <cmd…>` ARE a
 * command line, which resolveSegmentVerb does not unwrap (measured
 * 2026-11-03: the verb of `xargs git clean -fdx` is `xargs`, of `git
 * submodule foreach git clean -fdx` it is `git`). Both views of
 * argvWordsWithoutRedirects, every reading.
 *
 * Where an option-taking runner's command starts is read twice and judged as
 * the union: from its option table (runnerCommandStarts), AND at every word
 * of its option prefix that names git (gitWordStarts, #1927 review A). The
 * option tables are approximate — xargs' value letters only as a separate
 * `-n` word, not `-0n`, `-tI`, `--max-args`, `--arg-file`; parallel's `-j 2
 * -n 1` — so they alone lost the start of `xargs -n 1 -P 4 git clean -fdx`.
 * NAMED CEILING (BV-004): a non-git command line behind a misread option
 * value (`xargs --max-args 1 rm -rf x`) is still read from the table only;
 * the git rules are the ones this reach serves.
 * REVISIT TRIGGER: a replay of a runner call whose non-git payload is read
 * with the wrong command start.
 *
 * `parallel` without a replacement string appends its arguments to the
 * command (GNU parallel docs; parallel is not installed on the measuring
 * host): the command line is judged once alone and once with every word
 * after its first `:::`/`::::` appended (separators dropped) — a superset of
 * each real combination's words, so `parallel git clean ::: -fdx` reads `git
 * clean -fdx` (#1927 review D).
 *
 * `git submodule foreach` joins its payload words by a blank and runs the
 * result through the shell (git 2.56.0, 2026-11-03, review measurement:
 * `'true;' echo HELLO-ARGS` prints HELLO-ARGS, `'echo A' B` prints `A B`), so
 * the joined TEXT is returned in `shellTexts` to be re-tokenized (#1927 review
 * E). `git bisect run` does not: it shell-quotes every word (git 2.56.0,
 * 2026-11-03, throwaway repo: `git bisect run 'true;' echo X` → "true;:
 * command not found"), its argv words are the command line.
 *
 * Replacement strings (#1932 point 1): see the parallel branch below —
 * rendered per job when readable, read fail-closed (`unreadLines`,
 * `unreadTexts`, judged through parallelFailClosedLine) when not.
 *
 * @param {Array<object>} segment
 * @param {object} resolved — resolveSegmentVerb(segment)
 * @param {number} [jobLimit] — the most parallel jobs rendered (the shared budget left)
 * @returns {{ lines: Array<Array<object>>, shellTexts: string[], parallelTexts: string[],
 *   unreadLines: Array<{ line: Array<object>, repl: string[] }>, unreadTexts: Array<{ text: string, repl: string[] }>,
 *   overflow: boolean }}
 *   token slices (each one command line), shell texts (each one command
 *   string), the shell texts parallel builds (not read for the checkout twin),
 *   the unreadable parallel templates as argv and as shell text, and whether
 *   a parallel call naming git has more jobs than `jobLimit`
 */
function runnerCommandLines(segment, resolved, jobLimit = Infinity) {
  const lines = [];
  const shellTexts = [];
  const parallelTexts = [];
  const unreadLines = [];
  const unreadTexts = [];
  let overflow = false;
  const startsOf = (words, isValue) => [...new Set([...runnerCommandStarts(words, 0, isValue), ...gitWordStarts(words)])];
  for (const reading of readingsOf(resolved)) {
    if (reading.index < 0) continue;
    for (const bash of [true, false]) {
      const words = argvWordsWithoutRedirects(segment, reading.index + 1, { bash });
      if (reading.verb === 'git') {
        const texts = words.map((t) => (t.emptyWord ? '' : t.text));
        const start = gitPayloadStart(texts);
        if (start === -1 || start >= words.length) continue;
        lines.push(words.slice(start));
        if (texts.slice(0, start).includes('foreach')) shellTexts.push(texts.slice(start).join(' '));
      } else if (reading.verb === 'xargs') {
        const isValue = (t) => /^-[a-zA-Z]$/.test(t) && XARGS_VALUE_LETTERS.has(t[1]);
        for (const start of startsOf(words, isValue)) lines.push(words.slice(start));
      } else if (reading.verb === 'parallel') {
        // Short options: only the value-taking letters (GNU parallel man page)
        // — a misread `-q` would put the start on `:::` and read the
        // arguments as command lines (implicit mode). Long options stay
        // approximate: any `--name` without `=` may take the next word.
        const isValue = (t) => (/^-[a-zA-Z]$/.test(t) && PARALLEL_VALUE_LETTERS.has(t[1]))
          || (t.startsWith('--') && t.length > 2 && !t.includes('='));
        // NAMED CEILING (BV-004, #1927 review I): `parallel --dry-run git
        // clean -fdx ::: x` is judged like the real run on purpose — its
        // output is a command list that `… | sh` executes.
        // REVISIT TRIGGER: a real dry-run call denied whose output is never run.
        let cmdEnd = 0;
        while (cmdEnd < words.length && !PARALLEL_SEPARATORS.has(words[cmdEnd].text)) cmdEnd++;
        const args = words.slice(cmdEnd).filter((t) => !PARALLEL_SEPARATORS.has(t.text));
        // GNU parallel joins its command words into one shell line and appends
        // each argument shell-QUOTED, one job per argument. So the command is
        // judged as argv (alone, with every argument, with each argument
        // alone — `git clean ::: -n -fdx` is two jobs, `-n` must not hide
        // `-fdx`) and, when a command word is quoted (`'git reset --har
        // HEAD'`, `sh -c`), as the joined shell text with the arguments quoted
        // — a quoted argument is DATA (`echo ::: 'git clean -fdx'`).
        // With no command word before `:::` (implicit command mode) every
        // argument IS a command line (`parallel ::: 'git reset --har HEAD'`).
        // These shell texts go to `parallelTexts`: the checkout twin reads a
        // quoted parallel word through check 2b already (#1925) and keeps
        // that reach unchanged.
        const quoteArg = (text) => `'${text.replace(/'/g, "'\\''")}'`;
        for (const start of startsOf(words, isValue)) {
          if (start >= cmdEnd) { // implicit command mode
            for (const arg of args) parallelTexts.push(arg.text);
            continue;
          }
          const line = words.slice(start, cmdEnd);
          const joined = line.some((t) => t.quoted) ? line.map((t) => t.text).join(' ') : null;
          // #1932 point 1: replacement strings. A readable template (literal
          // `:::` / `:::+` sources, no option that changes the reading) is
          // rendered ONE LINE PER JOB — judged per job, never as the union of
          // all arguments (`git {} ::: clean -fdx` runs `git clean` and `git
          // -fdx`). The jobs are capped by the shared budget (`jobLimit`);
          // more jobs on a line naming git deny (`overflow`). An unreadable
          // one is read fail-closed (parallelFailClosedLine) beside today's
          // reading; with no replacement string the unreadable arguments are
          // appended as the placeholder `{}`.
          // NAMED CEILING (BV-004): a readable call with more jobs than the
          // budget left is denied unjudged when it names git (`parallel git log
          // {} ::: <40 refs>`), `{%}` renders as slot 1, linked sources wrap
          // instead of truncating, `-I XX` is read fail-closed rather than
          // substituted, and every option outside the readable allowlist
          // (readParallelSources) makes the template unreadable, so it
          // over-denies (GNU parallel is not installed to measure its grammar).
          // REVISIT TRIGGER: a replayed real parallel call denied by the job
          // cap, or GNU parallel on the measuring host.
          // The rendered job lines are ADDED to the base readings below (the
          // command alone, with every argument, with each argument), never
          // instead of them (#1932 fix cycle 2): rendering can only add a
          // match, so it can never judge weaker than the pre-render reading
          // (`git clean {#} ::: -fdx` renders `git clean 1`, the base reading
          // still holds `git clean {#} -fdx`).
          const src = readParallelSources(words.slice(0, start), words.slice(cmdEnd), line);
          const templated = line.some((t) => PARALLEL_REPLACEMENT_RE.test(t.text));
          if (src.readable && templated) {
            if (src.count > jobLimit) {
              // The command word itself may become git (`g{} clean ::: it`).
              if ([...line, ...args].some((t) => t.text.includes('git')) || PARALLEL_REPLACEMENT_RE.test(line[0].text)) overflow = true;
            } else {
              for (const [n, job] of src.jobs().entries()) {
                const { argv, shell } = renderParallelLine(line, job, n + 1);
                lines.push(argv);
                if (joined !== null) parallelTexts.push(shell);
              }
            }
          }
          if (!src.readable) {
            const isTemplate = (t) => PARALLEL_REPLACEMENT_RE.test(t.text) || src.repl.some((r) => r !== '' && t.text.includes(r));
            const unread = line.some(isTemplate) ? line : [...line, { text: '{}', quoted: false }];
            unreadLines.push({ line: unread, repl: src.repl });
            if (joined !== null) unreadTexts.push({ text: unread.map((t) => t.text).join(' '), repl: src.repl });
          }
          lines.push(line);
          if (joined !== null) parallelTexts.push(joined);
          if (args.length === 0) continue;
          lines.push([...line, ...args]);
          if (joined !== null) parallelTexts.push([joined, ...args.map((t) => quoteArg(t.text))].join(' '));
          if (args.length < 2) continue;
          for (const arg of args) {
            lines.push([...line, arg]);
            if (joined !== null) parallelTexts.push(`${joined} ${quoteArg(arg.text)}`);
          }
        }
      } else if (reading.verb === 'find' || FIND_EXEC_ACTIONS.has(reading.verb)) {
        // A find action that an escaped `\;` split into a segment of its own
        // (`find . -exec echo {} \; -exec git clean -fdx \;`): the tokenizer
        // keeps `\;` an operator — fail-closed for runners that join their
        // words into a shell line (`watch`, `ssh`, `eval`) — so the second
        // action STARTS a segment whose verb is `-exec` (#1927 cycle 3,
        // measured: `resolveSegmentVerb` → `{ verb: '-exec', index: 0 }`).
        // NAMED CEILING (BV-004): any segment that begins with a find action
        // word is read this way, also one not preceded by a `find` (`echo x \;
        // -exec git clean -fdx`), which can only add a deny.
        // REVISIT TRIGGER: a replayed real command denied through a stray
        // leading `-exec` segment.
        const acts = FIND_EXEC_ACTIONS.has(reading.verb) ? [{ text: reading.verb }, ...words] : words;
        for (let i = 0; i < acts.length; i++) {
          if (!FIND_EXEC_ACTIONS.has(acts[i].text)) continue;
          let end = i + 1;
          while (end < acts.length && acts[end].text !== ';' && !(acts[end].text === '+' && acts[end - 1]?.text === '{}')) end++;
          if (end > i + 1) lines.push(acts.slice(i + 1, end));
          i = end;
        }
      }
    }
  }
  return { lines, shellTexts, parallelTexts, unreadLines, unreadTexts, overflow };
}

/** Most words one token may brace-expand into before the reading fails closed (#1944 point 5). */
const BRACE_EXPANSION_CAP = 64;

/**
 * Most words the pattern matcher reads of one brace word past
 * BRACE_EXPANSION_CAP (#1956, `braceWords`). Past it the word is judged by
 * unreadBraceSpells (fail-closed). NAMED CEILING (BV-004): the cap bounds the
 * work of one hook call. REVISIT TRIGGER: a real command denied for a brace
 * word past it.
 */
const MATCHER_BRACE_CAP = 4096;

/**
 * Most words brace expansion may make for one command reading in total
 * (#1956 fix cycle 1): every expanded and every `braceWords` word counts,
 * across all words of the line and, for the pattern matcher, all payloads one
 * call reads. Past it the reading stops and the line counts as a match
 * (fail-closed); the destructive guard names the deny (commandMatchesBlocked
 * `onBudgetSpent`). Without it each word could expand to MATCHER_BRACE_CAP
 * words with no bound on the number of words, and the hook ran past the
 * harness kill, which lets the command through (review W3: 800 × `{1..4000}`
 * took 5.3 s). NAMED CEILING (BV-004): a harmless line past it is denied.
 * REVISIT TRIGGER: a real command denied as past the brace budget.
 */
const BRACE_WORD_BUDGET = 65_536;

/**
 * Most characters braceExpandChars may read for one command reading (#1973
 * review H1/H1'), summed over its recursion and over every word and payload
 * that shares the reading's brace budget (newBraceBudget). A run of expanding
 * groups re-reads the whole word once per word it makes: `{a,b}` × 4000
 * (20 KB) took 5.9 s in the hook, past the harness kill that lets the command
 * through, at 60 KB the hook ran out of memory (also not a block), and with a
 * per-word budget a line of many such words still took 5.5 s at 100 KB. Past
 * it `spent` is set like past BRACE_WORD_BUDGET: the word is unread and the
 * pattern matcher counts the line as a match (fail-closed). NAMED CEILING
 * (BV-004): a harmless line past it is denied, e.g. a destructive verb on a
 * brace word of about 31 KB that makes 64 words (PATH_MAX is 1–4 KB).
 * REVISIT TRIGGER: a real command denied as an unread brace word or as past
 * the brace budget.
 */
const BRACE_WORK_BUDGET = 2_000_000;

/**
 * A fresh brace budget for one command reading (BRACE_WORD_BUDGET).
 *
 * @returns {{ left: number, spent: boolean, work: number }}
 */
function newBraceBudget() {
  return { left: BRACE_WORD_BUDGET, spent: false, work: BRACE_WORK_BUDGET };
}

/**
 * The words bash brace expansion makes of one character run, or null when it
 * contains no expansion. `chars` carries each character's quote state: only
 * an unquoted `{`, `,`, `}` or `..` counts. `${…}` is a parameter, never a
 * brace. A `{…}` without a top-level comma or a valid sequence stays literal
 * and the scan goes on behind its `{` (bash: `{x}` → `{x}`, `{{a,b}}` →
 * `{a}` `{b}`). Throws RangeError past the cap.
 *
 * @param {Array<{ c: string, on: boolean }>} chars
 * @param {{ n: number, cap?: number, budget: { work?: number, spent: boolean } }} count
 * @returns {Array<Array<{ c: string, on: boolean }>> | null}
 */
function braceExpandChars(chars, count) {
  // #1973 review H1/H1': every expanding group recurses over the whole word
  // again, so a run of them (`{a,b}{a,b}…`) costs words × length, and every
  // word of the line may do so. One work budget per reading (BRACE_WORK_BUDGET).
  const budget = count.budget;
  budget.work = (budget.work ?? BRACE_WORK_BUDGET) - chars.length;
  if (budget.work < 0) { budget.spent = true; throw new RangeError('brace expansion work'); }
  const { close: closeOf, commas: commasOf, seqRunEnd } = braceGroups(chars);
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].on || chars[i].c !== '{' || (i > 0 && chars[i - 1].on && chars[i - 1].c === '$')) continue;
    const close = closeOf[i];
    if (close === -1) continue;
    const commas = commasOf.get(i) ?? [];
    let alts;
    if (commas.length > 0) {
      alts = [];
      let from = i + 1;
      for (const at of [...commas, close]) { alts.push(chars.slice(from, at)); from = at + 1; }
    } else {
      // #1973: copy the body only when it can be a sequence, so a nest of
      // literal groups (`{x{x{x…}}}`) costs no copy per level.
      if (!maybeBraceSequence(chars, i + 1, close, seqRunEnd)) continue;
      alts = braceSequence(chars.slice(i + 1, close), count.cap ?? BRACE_EXPANSION_CAP);
      if (alts === null) continue;
    }
    const pre = chars.slice(0, i);
    const post = chars.slice(close + 1);
    const out = [];
    for (const alt of alts) {
      const word = [...pre, ...alt, ...post];
      const more = braceExpandChars(word, count);
      for (const w of more ?? [word]) {
        if (++count.n > (count.cap ?? BRACE_EXPANSION_CAP)) throw new RangeError('brace expansion cap');
        out.push(w);
      }
    }
    return out;
  }
  return null;
}

/**
 * The brace groups of one character run in one pass (#1973): for every
 * unquoted `{` the index of its matching unquoted `}` (-1 when none) and the
 * unquoted commas at its own depth, and for every index the end of the
 * unquoted run of sequence characters (`-`, digits, `.`) starting there.
 * Matching on a stack gives the same pairs as counting depth forward from
 * each `{`, which braceExpandChars did before: that scan ran to the end of the
 * word for every unclosed `{`, so `{`×N cost N² steps and a deep enough group
 * flood ran the hook past the harness kill, which lets the command through.
 *
 * @param {Array<{ c: string, on: boolean }>} chars
 * @returns {{ close: Int32Array, commas: Map<number, number[]>, seqRunEnd: Int32Array }}
 */
function braceGroups(chars) {
  const close = new Int32Array(chars.length).fill(-1);
  const commas = new Map();
  const stack = [];
  for (let k = 0; k < chars.length; k++) {
    if (!chars[k].on) continue;
    const c = chars[k].c;
    if (c === '{') stack.push(k);
    else if (c === '}' && stack.length > 0) close[stack.pop()] = k;
    else if (c === ',' && stack.length > 0) {
      const open = stack[stack.length - 1];
      const list = commas.get(open);
      if (list === undefined) commas.set(open, [k]); else list.push(k);
    }
  }
  const seqRunEnd = new Int32Array(chars.length + 1);
  seqRunEnd[chars.length] = chars.length;
  for (let k = chars.length - 1; k >= 0; k--) {
    const { c, on } = chars[k];
    seqRunEnd[k] = on && (c === '-' || c === '.' || (c >= '0' && c <= '9')) ? seqRunEnd[k + 1] : k;
  }
  return { close, commas, seqRunEnd };
}

/**
 * Whether the body chars[from, to) can match braceSequence's pattern, in
 * O(1). Never false for a body the pattern accepts: a numeric body is one run
 * of sequence characters, a character range is `X..Y` with an optional
 * `..N` step. A false here only skips the copy and the regex (#1973).
 *
 * @param {Array<{ c: string, on: boolean }>} chars
 * @param {number} from - first body index
 * @param {number} to - index of the closing `}`
 * @param {Int32Array} seqRunEnd - from braceGroups
 * @returns {boolean}
 */
function maybeBraceSequence(chars, from, to, seqRunEnd) {
  if (seqRunEnd[from] >= to) return true;
  const len = to - from;
  if (len !== 4 && len < 6) return false;
  const dot = (k) => chars[k].on && chars[k].c === '.';
  if (!chars[from].on || !dot(from + 1) || !dot(from + 2) || !chars[from + 3].on) return false;
  return len === 4 || (dot(from + 4) && dot(from + 5) && seqRunEnd[from + 6] >= to);
}

/**
 * A sequence body (`1..3`, `a..e`, `5..1..2`) as alternatives, or null when it
 * is none. Any single-character range counts, as zsh reads it (`{-..-}` is `-`;
 * bash keeps non-letter ranges literal), so the union is read (review W3).
 */
function braceSequence(body, cap = BRACE_EXPANSION_CAP) {
  if (body.some((x) => !x.on)) return null;
  const m = /^(?:(-?\d+)\.\.(-?\d+)|(.)\.\.(.))(?:\.\.(-?\d+))?$/s.exec(body.map((x) => x.c).join(''));
  if (m === null) return null;
  const numeric = m[1] !== undefined;
  const from = numeric ? Number(m[1]) : m[3].charCodeAt(0);
  const to = numeric ? Number(m[2]) : m[4].charCodeAt(0);
  const step = Math.abs(Number(m[5] ?? 1)) || 1;
  if (Math.abs(to - from) / step >= cap) throw new RangeError('brace expansion cap');
  const alts = [];
  for (let v = from; from <= to ? v <= to : v >= to; v += from <= to ? step : -step) {
    const text = numeric ? String(v) : String.fromCharCode(v);
    alts.push([...text].map((c) => ({ c, on: true })));
  }
  return alts;
}

/**
 * #1944 point 5 — the token list after bash brace expansion: `git rm
 * {-f,a.txt}` is `git rm -f a.txt`, `{git,rm,-f,a.txt}` is the call itself
 * (ADR-0017 rule (a): brace expansion counts toward the target). Comma lists,
 * nesting and plain sequences are expanded; a quoted or escaped `{`/`,` stays
 * literal (per-part provenance, tokenizeCommand § parts). A redirect or an
 * operator token is left as it is; a brace word that also holds a
 * substitution or parameter is marked unreadable like one past the cap. An
 * expanded word is unquoted unless a quoted character survives into it; a
 * word bash would drop (unquoted and empty) is dropped. A word past
 * BRACE_EXPANSION_CAP keeps its text and gets `braceUnreadable: true`, so a
 * reader can fail closed. One grammar for the pattern matcher (matchSegments
 * reads every segment in this reading too, #1956) and the destructive guard's
 * forced-discard and path-reset readers (findPathResets, unreadForcedDiscard).
 *
 * All words of one call share `budget` (BRACE_WORD_BUDGET); a word it no
 * longer covers is unread (no `braceWords`) and `budget.spent` is set. A word
 * the lexer split at an unquoted `$IFS` while it held an open brace
 * (`ifsSplit`, `{git,reset,$IFS--hard}`) is unread too: bash expands the
 * braces of the whole word before it splits fields (#1956 fix cycle 1).
 *
 * @param {Array<object>} tokens - tokenizeCommand output
 * @param {{ left: number, spent: boolean, work?: number }} [budget] - shared across calls of one reading
 * @returns {Array<object>} the same list when nothing expands, else a new one
 */
export function expandBraces(tokens, budget = newBraceBudget()) {
  let changed = false;
  const out = [];
  for (const tok of tokens) {
    if (tok.operator !== undefined || tok.redirect !== undefined || !tok.text.includes('{')) { out.push(tok); continue; }
    const parts = tok.parts ?? [{ text: tok.text, quote: tok.quoted ? 'single' : 'none' }];
    const chars = parts.flatMap((p) => [...p.text].map((c) => ({ c, on: p.quote === 'none' })));
    if (tok.ifsSplit === true && hasOpenBrace(chars)) {
      out.push({ ...tok, braceUnreadable: true });
      changed = true;
      continue;
    }
    const cap = Math.min(BRACE_EXPANSION_CAP, budget.left);
    let words;
    try {
      words = braceExpandChars(chars, { n: 0, cap, budget });
    } catch {
      const unread = { ...tok, braceUnreadable: true };
      if (cap < BRACE_EXPANSION_CAP) budget.spent = true;
      // #1956: the pattern matcher reads the word up to MATCHER_BRACE_CAP
      // words (matcherSegments, `braceWords`); past it, unreadBraceSpells.
      const wide = Math.min(MATCHER_BRACE_CAP, budget.left);
      try {
        const more = budget.spent ? null : braceExpandChars(chars, { n: 0, cap: wide, budget });
        if (more !== null) {
          budget.left -= more.length;
          Object.defineProperty(unread, 'braceWords', { value: braceWordTexts(more), enumerable: false });
        }
      } catch {
        // past MATCHER_BRACE_CAP too: no braceWords
        if (wide < MATCHER_BRACE_CAP) budget.spent = true;
      }
      out.push(unread);
      changed = true;
      continue;
    }
    if (words === null) { out.push(tok); continue; }
    budget.left -= words.length;
    // Review W3: a brace word that also holds a substitution or a parameter
    // (`{-f,a.txt}$(true)`, `{-f,a.txt}"$EMPTY"`) expands to words the shell
    // finishes later — not read, so the readers fail closed on it.
    if (tok.substitutions !== undefined || /[$`]/.test(tok.text)) {
      // #1956: the brace words as written, `$…` kept as text — the pattern
      // matcher's substitution reading (matcherSegments). Non-enumerable, so
      // the token's shape stays the one consumers compare.
      const unread = { ...tok, braceUnreadable: true };
      Object.defineProperty(unread, 'braceWords', { value: braceWordTexts(words), enumerable: false });
      out.push(unread);
      changed = true;
      continue;
    }
    changed = true;
    for (const w of words) {
      const quoted = w.some((x) => !x.on);
      if (w.length === 0 && !quoted) continue;
      out.push({ text: w.map((x) => x.c).join(''), quoted });
    }
  }
  return changed ? out : tokens;
}

/**
 * Whether an unquoted `{` (not `${`) of the characters has no closing `}`
 * after it — a brace word the lexer cut (expandBraces, `ifsSplit`).
 *
 * @param {Array<{ c: string, on: boolean }>} chars
 * @returns {boolean}
 */
function hasOpenBrace(chars) {
  let depth = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].on) continue;
    if (chars[i].c === '{' && !(i > 0 && chars[i - 1].on && chars[i - 1].c === '$')) depth++;
    else if (chars[i].c === '}' && depth > 0) depth--;
  }
  return depth > 0;
}

/**
 * Brace words as `{ text, quoted }` — quoted when a quoted character
 * survives into the word.
 *
 * @param {Array<Array<{ c: string, on: boolean }>>} words
 * @returns {Array<{ text: string, quoted: boolean }>}
 */
function braceWordTexts(words) {
  return words.map((w) => ({ text: w.map((x) => x.c).join(''), quoted: w.some((x) => !x.on) }));
}

/**
 * Commands that never run their argument words, so an unread brace word after
 * them stays a plain word (reviews W3). Not `git`: `git bisect run`, `git
 * submodule foreach`, `git rebase --exec` and `-c alias.x='!…'` run their
 * words as a command (review of f6cdbe45).
 */
const BRACE_SAFE_COMMANDS = new Set(['echo', 'printf', 'cp', 'mv', 'mkdir', 'touch', 'ls', 'cat', 'ln', 'chmod', 'rmdir', 'stat', 'wc', 'head', 'tail', 'diff', 'basename', 'dirname', 'realpath']);

/**
 * The first brace word of an expandBraces segment that was not read (past
 * BRACE_EXPANSION_CAP, or beside a substitution or parameter), or undefined
 * when there is none or the segment's command word is a plain command that
 * never runs its arguments (BRACE_SAFE_COMMANDS, reviews W3). Such a word can
 * build any command, as the command word or behind any prefix, so its raw
 * text proves nothing. Shared by the destructive guard's forced-discard
 * reader and the pattern matcher (#1956).
 *
 * @param {Array<object>} segment - one chain segment of expandBraces output
 * @returns {object|undefined}
 */
export function unreadBraceWord(segment) {
  const commandAt = segment.findIndex((t) => t.quoted || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text));
  const command = segment[commandAt];
  // #1955 (b): only a bare name or a system path is the harmless program;
  // `/tmp/x/echo` can be any program.
  const plain = command !== undefined && command.braceUnreadable !== true && /^(?:(?:\/usr)?\/bin\/)?[a-z]+$/.test(command.text)
    && BRACE_SAFE_COMMANDS.has(programName(command.text));
  return plain ? undefined : segment.find((t) => t.braceUnreadable === true);
}

/**
 * Could the brace words of a segment that expand past BRACE_EXPANSION_CAP
 * spell every word a pattern needs (#1956)? A brace expansion only joins
 * characters its word holds, plus those of a sequence (`{a..z}`, `{1..70}`),
 * so a needed word must be a word of the segment already or be made of
 * characters one such word can produce. Compared in lower case (program names
 * are folded, foldedCommandSegment). A superset test: more matches, never
 * fewer — the word is not read, so the match is fail-closed. Behind a plain
 * command that never runs its arguments (unreadBraceWord) it is no match. A
 * brace word left unread for a substitution or parameter is read instead
 * (matcherSegments, `braceWords`).
 *
 * @param {Array<object>} segment - one chain segment of expandBraces output
 * @param {Array<string[]>} needed - per needed word, its alternatives
 * @returns {boolean}
 */
function unreadBraceSpells(segment, needed) {
  if (unreadBraceWord(segment) === undefined) return false;
  const sets = [];
  for (const tok of segment) {
    if (tok.braceUnreadable !== true || tok.braceWords !== undefined) continue;
    const set = braceCharset(tok.text);
    // A wide character range can make any word.
    if (set === null) return true;
    sets.push(set);
  }
  if (sets.length === 0) return false;
  const text = segment.map((t) => t.text.toLowerCase()).join(' ');
  return needed.every((alts) => alts.some((w) => {
    const lower = w.toLowerCase();
    return text.includes(lower) || sets.some((set) => [...lower].every((c) => set.has(c)));
  }));
}

/**
 * The lower-case characters an unread brace word can produce: its own, plus
 * those of each sequence (`{a..z}`, `{1..70}`), or null when a character range
 * is so wide it can make any word (unreadBraceSpells, braceTextCouldSpell).
 *
 * @param {string} text
 * @returns {Set<string>|null}
 */
function braceCharset(text) {
  const set = new Set(text.toLowerCase());
  for (const m of text.matchAll(/\{(?:(-?\d+)\.\.(-?\d+)|(.)\.\.(.))(?:\.\.-?\d+)?\}/gs)) {
    if (m[1] !== undefined) { for (const c of '0123456789-') set.add(c); continue; }
    const [lo, hi] = [m[3].charCodeAt(0), m[4].charCodeAt(0)].sort((a, b) => a - b);
    if (hi - lo > 256) return null;
    for (let v = lo; v <= hi; v++) set.add(String.fromCharCode(v).toLowerCase());
  }
  return set;
}

/**
 * Could an unread brace word spell a denylist glob (#1970)? Every literal
 * character of the glob (`*`, `?`, `/` and `~` dropped) must be one the word
 * can produce (braceCharset) — a superset test, so a match is fail-closed.
 *
 * @param {string} text - the unread word as written
 * @param {string[]} globs - the rule's `target-denylist`
 * @returns {boolean}
 */
function braceTextCouldSpell(text, globs) {
  const set = braceCharset(text);
  if (set === null) return true;
  return globs.some((g) => [...g.toLowerCase().replace(/[*?/~]/g, '')].every((c) => set.has(c)));
}

/**
 * The chain segments of a token list's brace-expanded reading (#1970,
 * expandBraces), empty when no word expands. A brace word left unread beside
 * a substitution or parameter is read a second time with its brace words as
 * written (`braceWords`), `$…` spans kept — the target readers report those
 * as unresolved.
 *
 * @param {Array<object>} tokens - tokenizeCommand output
 * @param {{ left: number, spent: boolean }} brace - the reading's brace budget
 * @returns {Array<Array<object>>}
 */
function braceExtraSegments(tokens, brace) {
  if (!tokens.some((t) => t.text.includes('{'))) return [];
  const braced = expandBraces(tokens, brace);
  if (braced === tokens) return [];
  const out = splitSegments(braced);
  if (braced.some((t) => t.braceWords !== undefined)) {
    out.push(...splitSegments(braced.flatMap((t) => (t.braceWords === undefined ? [t] : t.braceWords.map((w) => ({ ...w }))))));
  }
  return out;
}

/**
 * Run a target collector (collectRedirectTargets, collectDeleteTargets) over
 * a text a shell parses: over its segments as before, then over its
 * brace-expanded readings (#1970) — normalized, and raw when an `$IFS` stands
 * beside a brace (`ifsSplit`). Union only: an entry of the extra readings is
 * added when the text's own reading did not already report it.
 *
 * @param {Function} collect - (segments, out, depth, budget) => void
 * @param {string} text
 * @param {object} options - normalizeShellWhitespaceExpansions options
 * @param {Array<object>} out
 * @param {number} depth
 * @param {{ remaining: number, brace: { left: number, spent: boolean } }} budget
 */
function collectWithBraces(collect, text, options, out, depth, budget) {
  const normalized = normalizeShellWhitespaceExpansions(text, options);
  const tokens = tokenizeCommand(normalized);
  collect(splitSegments(tokens), out, depth, budget);
  const extra = braceExtraSegments(tokens, budget.brace);
  if (normalized !== text && /\$\{?IFS/.test(text) && text.includes('{')) {
    const raw = tokenizeCommand(text);
    extra.push(...splitSegments(raw), ...braceExtraSegments(raw, budget.brace));
  }
  if (extra.length === 0) return;
  const more = [];
  collect(extra, more, depth, budget);
  const seen = new Set(out.map((e) => JSON.stringify(e)));
  for (const e of more) {
    const key = JSON.stringify(e);
    if (!seen.has(key)) { seen.add(key); out.push(e); }
  }
}

/**
 * The chain segments the pattern matcher judges for one token list: those of
 * the tokens as written and, when a word brace-expands, those of the
 * brace-expanded reading (#1956, expandBraces; ADR-0017 rule (a): `{git,reset,
 * --hard}` and `git {reset,--hard}` run `git reset --hard`). Union only:
 * the written segments are always judged. Expanded before the segment split,
 * as the destructive guard reads it: the split peels a glued `{` as a zsh
 * group opener, and bash reads `{git,…}` as one brace word.
 *
 * A brace word that also holds a substitution or parameter is unread in the
 * guard's readers (`{git,reset,--hard}$(true)`). bash expands braces before
 * parameters, so the matcher reads its brace words with every `$…` and
 * backtick span read as empty — a third reading, as emptyExpansionSegment
 * reads a plain word. NAMED CEILING (BV-004): a span is cut by a plain-text
 * scan (stripExpansionSpans); a nested quote or parenthesis inside `$( )`
 * can cut it wrong. REVISIT TRIGGER: a replayed bypass through that form.
 * A brace word past BRACE_EXPANSION_CAP is read the same way up to
 * MATCHER_BRACE_CAP words (`braceWords`); past that, unreadBraceSpells.
 * All readings of one call share `brace` (BRACE_WORD_BUDGET); once it is
 * spent, matchSegments counts the line as a match.
 *
 * @param {Array<object>} tokens - tokenizeCommand output
 * @param {{ left: number, spent: boolean }} [brace] - the call's brace budget
 * @returns {Array<Array<object>>}
 */
function matcherSegments(tokens, brace = newBraceBudget()) {
  const segments = splitSegments(tokens);
  if (!tokens.some((t) => t.text.includes('{'))) return segments;
  const braced = expandBraces(tokens, brace);
  if (braced === tokens) return segments;
  const out = [...segments, ...splitSegments(braced)];
  if (braced.some((t) => t.braceWords !== undefined)) {
    const read = braced.flatMap((t) => {
      if (t.braceWords === undefined) return [t];
      return t.braceWords
        .map((w) => ({ text: stripExpansionSpans(w.text), quoted: w.quoted }))
        .filter((w) => w.text !== '' || w.quoted);
    });
    out.push(...splitSegments(read));
  }
  return out;
}

/**
 * matcherSegments of a payload a later shell parses (`bash -c`, piped data):
 * normalized with its single-quoted text, and — when an `$IFS` stands in it
 * beside a brace — also raw, where the lexer still marks the IFS split of a
 * brace word (#1956 fix cycle 1, `ifsSplit`). Union only.
 *
 * @param {string} payload
 * @param {{ left: number, spent: boolean }} brace - the call's brace budget
 * @returns {Array<Array<object>>}
 */
function payloadMatcherSegments(payload, brace) {
  return ifsAwareSegments(payload, { expandSingleQuoted: true }, (tokens) => matcherSegments(tokens, brace));
}

/**
 * `read` of the text's tokens after whitespace normalization and — when an
 * `$IFS` stands in the text beside a brace — also of its raw tokens, where
 * the lexer still marks an IFS split of a brace word (`ifsSplit`, #1956 fix
 * cycle 1). Union only.
 *
 * @param {string} text
 * @param {object} options - normalizeShellWhitespaceExpansions options
 * @param {(tokens: Array<object>) => Array<Array<object>>} read
 * @returns {Array<Array<object>>}
 */
function ifsAwareSegments(text, options, read) {
  const normalized = normalizeShellWhitespaceExpansions(text, options);
  const segments = read(tokenizeCommand(normalized));
  if (normalized === text || !/\$\{?IFS/.test(text) || !text.includes('{')) return segments;
  return [...segments, ...read(tokenizeCommand(text))];
}

/**
 * The text with every `$(…)`, `${…}`, `$name`, special parameter and
 * backtick span removed — read as empty, like emptyExpansionSegment (#1956,
 * matcherSegments).
 *
 * @param {string} text
 * @returns {string}
 */
function stripExpansionSpans(text) {
  return text
    .replace(/\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\$\{[^}]*\}|\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/g, '');
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
 * Every segment is judged twice when a word of it expands (#1893): as written,
 * and in its empty-expansion reading (emptyExpansionSegment), where
 * `git res${x}et --hard` reads `git reset --hard`. Either reading matching is a
 * match, fail-closed like the other paired readings. A payload text is judged
 * once per call — its verdict depends only on the text, and both readings of a
 * segment often carry the same one. The same union holds for the
 * brace-expanded reading (#1956, expandBraces) and the inline-alias reading
 * of a git call (#1957, gitInlineAliasWords).
 *
 * @param {Array<Array<{ text: string, quoted: boolean }>>} segments
 * @param {RegExp} re
 * @param {number} depth — current payload-nesting depth (entry check < MAX)
 * @param {{ remaining: number, needed?: Array<string[]> }} budget — shared
 *   across the whole recursion; `needed`: the pattern's required words (per
 *   word its alternatives), for the unread brace word test (unreadBraceSpells);
 *   `pipeUnread`: set when check 4 met pipe data it could not read (#2006)
 * @param {{ sub: string, flags: string[] } | null} [git] — gitPatternSpec of the
 *   pattern; null for a non-git pattern (#1831)
 * @returns {boolean}
 */
function matchSegments(segments, re, depth, budget, git = null) {
  // #1956 fix cycle 1: the brace reading stopped at BRACE_WORD_BUDGET —
  // unjudged, so a match (fail-closed).
  if (budget.brace?.spent) return true;
  const judged = new Set();
  const readings = [];
  for (const s of segments) {
    // #1956: a brace word of the brace-expanded reading (matcherSegments)
    // past MATCHER_BRACE_CAP that could spell the pattern is a match,
    // fail-closed (unreadBraceSpells).
    if (budget.needed && s.some((t) => t.braceUnreadable === true) && unreadBraceSpells(s, budget.needed)) return true;
    // #1957 fix cycle 3: a git alias defined in the leading environment for a
    // command no git reading follows (`E bash -c 'git z'`) — fail-closed.
    if (git && gitEnvAliasUnfollowed(s)) return true;
    const own = [s];
    const empty = emptyExpansionSegment(s);
    // Unread default word (MAX_DEFAULT_WORD_DEPTH): unjudged → match, fail-closed.
    if (empty === UNREAD) return true;
    if (empty !== null) own.push(empty);
    // #1955 (a): `GIT reset --hard` is read as `git reset --hard` by the text checks.
    for (const r of empty === null ? [s] : [s, empty]) {
      const folded = foldedCommandSegment(r);
      if (folded !== null) own.push(folded);
    }
    // #1957: an alias the git call defines itself, resolved
    // (`git -c alias.z='reset --hard' z`).
    for (const r of [...own]) own.push(...inlineAliasSegments(r));
    readings.push(...own);
  }
  for (const segment of readings) {
    // 1) Unquoted occurrence anywhere in the segment → always a match.
    if (unquotedSegmentMatch(segment, re)) return true;

    const resolved = resolveSegmentVerb(segment);

    // 1b) The argv match of a git pattern (#1831): equivalent flag spellings
    //     (`-fdx`, `--force`, `--forc`, `+main`, flags after operands)
    //     the literal word sequence misses. Union only — never fewer matches.
    if (git && gitArgvMatch(segment, resolved, git)) return true;

    // 1c) The `git restore` twin of check 1 for `git checkout --` (#1917
    //     point 2, review R1): `xargs git restore`, `find … -exec git restore`.
    //     Also the wrapped list-file checkout (#1937), for `restore: false` too.
    if (git && git.sub === 'checkout' && git.flags.length === 1 && git.flags[0] === '--'
      && wrappedRestoreMatch(segment, resolved, git.restore !== false)) return true;

    // 1d) Inside a quoted payload the guard does not read (check 2b below),
    //     every worktree path reset matches, the ref-sourced ones too (#1925
    //     review MED).
    if (git?.unreadPayload && unreadPathResetMatch(segment, resolved)) return true;

    // 2) Quoted occurrence → only a match when the segment verb is an interpreter
    //    that executes its quoted payload. EITHER reading of an ambiguous
    //    unknown flag counts (#1000): `env -Q x bash -c 'rm -rf /etc'` resolves
    //    to the non-interpreter `x` in parse A and to `bash` in parse B.
    if (quotedTokensMatch(segment, re)) {
      const isInterp = (v) => Boolean(v) && SHELL_EXEC_INTERPRETERS.has(v);
      if (readingsOf(resolved).some((r) => isInterp(r.verb)) || gitRunsPayload(segment, resolved)) return true;
      // else: inert literal inside quotes for a non-interpreter verb → no match
      // for THIS segment; keep scanning other segments.
    }

    // 2b) The `git restore` twin of check 2 for `git checkout --` (#1925 point
    //     1): restore has no literal form, so each quoted word of an
    //     interpreter segment is read as a command line of its own —
    //     `xargs sh -c 'git restore a.txt'`, `find … -exec sh -c 'git restore
    //     "$1"' _ {} \;`. Same reach as check 2 (`xargs echo 'git checkout --
    //     a'` matches there too), same depth cap and shared budget as check 3,
    //     whose `judged` set it shares. A quoted word with no blank, `$` or
    //     backslash is one word and holds no `git restore` command line, so it
    //     charges no budget. When no reading's verb is one whose payload the
    //     destructive guard reads (`xargs`, `find`, not `sh -c`), the payload
    //     is read with `unreadPayload` (check 1d): nothing measures its
    //     ref-sourced resets (#1925 review MED).
    //     The other git patterns reach their runner payloads through check 2c
    //     (#1927), not here.
    //     The `checkout --` spec with `restore: false` (the destructive guard's
    //     RESET_RULE_MATCH, "did the literal checkout rule match?") keeps its
    //     pre-#1927 reach in 2b and 2c: the guard asks the `restore: true`
    //     spec for the payload reach, and widening the narrow one changed
    //     which deny message its unread-form branch names.
    const checkoutSpec = Boolean(git) && git.sub === 'checkout' && git.flags.length === 1 && git.flags[0] === '--';
    const checkoutTwin = checkoutSpec && git.restore !== false;
    const runnerReach = Boolean(git) && (!checkoutSpec || checkoutTwin);
    //     #1927 review H + fix cycle 2: the non-checkout patterns get NO
    //     per-word re-read here. A quoted word is re-read only where the
    //     runner really runs it as a command line, and check 2c builds exactly
    //     that line: the `foreach` join, `parallel`'s command words joined
    //     plus each argument as a quoted word (or, in implicit command mode,
    //     each argument as a line), `bisect run`'s argv. Re-reading every
    //     quoted word on its own read DATA as code (`git bisect run grep -n
    //     'git reset --har HEAD' x`, `parallel echo ::: 'git clean -fdx'`).
    //     Under xargs / find a quoted `sh -c '…'` payload is reached through
    //     check 2c → the inner `sh -c` segment → check 3. The checkout twin
    //     keeps its #1925 reach (every interpreter verb).
    if (checkoutTwin && (readingsOf(resolved).some((r) => Boolean(r.verb) && SHELL_EXEC_INTERPRETERS.has(r.verb))
      || gitRunsPayload(segment, resolved))) {
      const inner = git.unreadPayload || readingsOf(resolved).some((r) => GUARD_READ_PAYLOAD_VERBS.has(r.verb))
        ? git : { ...git, unreadPayload: true };
      for (const tok of segment) {
        if (!tok.quoted) continue;
        const text = normalizeShellWhitespaceExpansions(tok.text, { expandSingleQuoted: true });
        // An unread reading is a verdict of its own: the same text read by the
        // guard elsewhere on the line must not stand in for it.
        const key = inner === git ? text : `\0unread\0${text}`;
        if (!/[\s$\\]/.test(text) || judged.has(key)) continue;
        judged.add(key);
        // Past the depth cap the word is unread: naming restore, it matches
        // (fail-closed, like the guard's reading of a nested payload).
        // `checkout` too, as the destructive guard's own past-cap fallbacks
        // (#1925 point 13: `xargs` around nested `bash -c` levels of `git
        // checkout HEAD -- a.txt` was allowed and discarded). A past-cap
        // branch switch is denied with it, as the guard already does.
        if (depth >= MAX_PAYLOAD_DEPTH) {
          if (/checkout|restore/.test(text)) return true;
          continue;
        }
        if (budget.remaining <= 0) return true;
        budget.remaining -= 1;
        if (matchSegments(matcherSegments(tokenizeCommand(text), budget.brace), re, depth + 1, budget, inner)) return true;
      }
    }

    // 2c) Unquoted runner payloads (#1927 part b): the argv words a runner
    //     executes (`xargs git clean -fdx`, `find … -exec git clean -fdx \;`,
    //     `parallel git reset --har HEAD ::: x`, `git submodule foreach git
    //     clean -fdx`, `git bisect run git reset --har HEAD`) are re-read as a
    //     segment of their own, so check 1b judges them. Same depth cap, shared
    //     budget and `judged` set; a line with no word holding `git` holds no
    //     git call and charges no budget. Union only — never fewer matches.
    //     The destructive guard never reads a runner payload (its
    //     findPathResets judges the segment's own verb), so for the checkout
    //     twin the lines are read with `unreadPayload` (check 1d), as check 2b
    //     does: `xargs git checkout HEAD -- a.txt` (#1927 review B).
    //     `git submodule foreach` payloads are also judged as one shell text
    //     (runnerCommandLines `shellTexts`, #1927 review E).
    if (runnerReach) {
      const lineGit = checkoutTwin && !git.unreadPayload ? { ...git, unreadPayload: true } : git;
      const unread = lineGit === git ? '' : '\0unread';
      const { lines, shellTexts, parallelTexts, unreadLines, unreadTexts, overflow } = runnerCommandLines(segment, resolved, budget.remaining);
      // #1932 point 1: more parallel jobs than the budget left, on a line
      // naming git — unjudged, so a match (fail-closed, like an exhausted budget).
      if (overflow) return true;
      const reads = [
        ...lines.map((line) => ({ texts: line.map((t) => t.text), segments: () => [line], kind: 'argv' })),
        ...[...shellTexts, ...(checkoutTwin ? [] : parallelTexts)]
          .map((text) => ({ texts: [text], segments: () => matcherSegments(tokenizeCommand(text), budget.brace), kind: 'shell' })),
        ...unreadLines.map(({ line, repl }) => {
          const failClosed = parallelFailClosedLine(line, git, repl);
          return { texts: failClosed.map((t) => t.text), segments: () => [failClosed], kind: 'unread-argv' };
        }),
        ...(checkoutTwin ? [] : unreadTexts).map(({ text, repl }) => ({
          texts: [text],
          segments: () => matcherSegments(tokenizeCommand(text), budget.brace).map((s) => parallelFailClosedLine(s, git, repl)),
          kind: 'unread-shell',
        })),
      ];
      for (const { texts, segments: payloadSegments, kind } of reads) {
        if (!texts.some((t) => t.includes('git'))) continue;
        const key = `\0${kind}${unread}\0${texts.join('\0')}`;
        if (judged.has(key)) continue;
        judged.add(key);
        // Past the depth cap the line is unread: naming the subcommand, it
        // matches (fail-closed, like check 2b).
        // NAMED CEILING (BV-004, #1927 review G): that fallback is a text test,
        // so a pathological runner stack past the cap (`xargs xargs xargs xargs
        // git push origin main`) is denied for naming `push` — fail-closed.
        // REVISIT TRIGGER: a real command denied by this past-cap fallback.
        if (depth >= MAX_PAYLOAD_DEPTH) {
          if (texts.some((t) => t.includes(git.sub) || (checkoutTwin && t.includes('restore')))) return true;
          continue;
        }
        // NAMED CEILING (BV-004, #1927 review F): the budget is shared with
        // checks 2b and 3, and an exhausted budget denies — many harmless
        // runner reads on one line can deny it (fail-closed; 0 hits in a
        // 30-day replay of 22,905 real commands, 2026-11-03).
        // REVISIT TRIGGER: a replayed real command denied by the budget alone.
        if (budget.remaining <= 0) return true;
        budget.remaining -= 1;
        if (matchSegments(payloadSegments(), re, depth + 1, budget, lineGit)) return true;
      }
    }

    // 3) `-c`/`env -S` payload recursion (depth-capped, budgeted). The payload
    //    set is the de-duplicated UNION over both readings (dedupedSegmentPayloads)
    //    so an ambiguous segment cannot double-charge the shared evaluation budget.
    if (depth < MAX_PAYLOAD_DEPTH) {
      for (const payload of dedupedSegmentPayloads(segment, resolved)) {
        if (judged.has(payload)) continue;
        judged.add(payload);
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
        if (matchSegments(payloadMatcherSegments(payload, budget.brace), re, depth + 1, budget, git)) return true;
      }
    } else {
      // Past the depth cap a `-c`/`env -S` payload is unread and fails CLOSED
      // with check 4's name test (#1933 lead review M1, 2026-11-03: `printf
      // '\147it re\163et --hard' | sh` inside four `bash -c` levels was allowed,
      // and so was a literal `git clean -fdx` in alternating `echo|sh`/`bash -c`
      // nesting, also at main).
      for (const payload of dedupedSegmentPayloads(segment, resolved)) {
        if (pastCapNamesPattern(payload, git, re)) return true;
      }
    }
  }

  // 4) Literal data piped or here-stringed into a shell that reads its script
  //    from stdin (#1933 point 4, pipedShellData): re-read as a command line,
  //    with check 3's depth cap, shared budget and `judged` set. The pipe pair
  //    lives on the written statements (`pipedFrom`), so this reads `segments`,
  //    not their empty-expansion readings. The destructive guard reads no pipe
  //    data, so the checkout twin judges it with `unreadPayload` (check 1d), as
  //    check 2c does for runner lines.
  //    Past the depth cap the data is unread and fails CLOSED (#1933 fix cycle
  //    1, r3 F1: `echo '…' | sh` nested four levels ran `git reset --hard`
  //    unjudged): it matches when its quote-stripped text, raw or with its
  //    escapes decoded, names the pattern's subcommand (the boundary pattern
  //    for a non-git pattern), or `restore` for the checkout twin — as checks
  //    2b and 2c do.
  //    NAMED CEILING (BV-004): a text test, so a harmless line nested past the
  //    cap that names the subcommand is denied. REVISIT TRIGGER: a real
  //    command denied by this past-cap fallback.
    //    Since #1940 point 6 the data also reaches the shell through pure
  //    pass-through filters (`| tee x | sh`, `| cat | sh`) and from a
  //    group, subshell or loop (`{ echo …; } | sh`, `(echo …) | sh`);
  //    pipelineLiteralData reads them.
  {
    const checkoutTwin = Boolean(git) && git.sub === 'checkout' && git.flags.length === 1 && git.flags[0] === '--' && git.restore !== false;
    const dataGit = checkoutTwin && !git.unreadPayload ? { ...git, unreadPayload: true } : git;
    for (const segment of segments) {
      const piped = pipedShellData(segment);
      // Fix cycle 2 (item 2): data past the line's pipe-read budget is
      // unjudged — a match (fail-closed), like a payload past the depth cap.
      // #2006: marked, not returned here — commandMatchesBlocked makes it the
      // match only when no rule matched the rest of the line, and names it
      // through `onBudgetSpent`, so the deny no longer goes to the first rule
      // asked (`git-reset-hard` on a line holding no reset).
      if (piped.unreadable) { budget.pipeUnread = true; continue; }
      for (const data of piped) {
        if (depth >= MAX_PAYLOAD_DEPTH) {
          // Raw and escape-decoded (`cl\145an`); a printf argument stands
          // literally in the data, so `git %s` + `restore` names it raw. The
          // texts the unread data would pipe on or run (#1933 fix cycle 2,
          // Codex HIGH: `printf 'git cl%s -fd' ean | sh` four levels deep) are
          // rendered and read the same way (unreadDataTexts).
          if (pastCapNamesPattern(data, git, re)) return true;
          continue;
        }
        const key = `\0piped\0${data}`;
        if (judged.has(key)) continue;
        judged.add(key);
        if (budget.remaining <= 0) return true;
        budget.remaining -= 1;
        if (matchSegments(payloadMatcherSegments(data, budget.brace), re, depth + 1, budget, dataGit)) return true;
      }
    }
  }
  return false;
}

/**
 * The most texts unreadDataTexts collects. NAMED CEILING (BV-004): past it the
 * remaining nested data stays judged by its raw text only. REVISIT TRIGGER: a
 * command nesting more than 64 piped or `-c` texts past the depth cap.
 */
const UNREAD_DATA_TEXTS_CAP = 64;

/**
 * The fail-closed name test for text past MAX_PAYLOAD_DEPTH (#1933): piped
 * shell data (check 4) and `-c`/`env -S` payloads (check 3) match when any text
 * they would run (unreadDataTexts), raw or with its escapes decoded and its
 * quotes stripped, names the pattern's subcommand — or `restore` for the
 * checkout twin; a non-git pattern is tested as written.
 * NAMED CEILING (BV-004): a text test, so a harmless line past the cap that
 * names the subcommand is denied. REVISIT TRIGGER: a real command denied by it.
 *
 * @param {string} data
 * @param {object|null} git - the git pattern spec, null for a non-git pattern
 * @param {RegExp} re
 * @returns {boolean}
 */
function pastCapNamesPattern(data, git, re) {
  const checkoutTwin = Boolean(git) && git.sub === 'checkout' && git.flags.length === 1 && git.flags[0] === '--' && git.restore !== false;
  return unreadDataTexts(data).flatMap((t) => [t, decodeDataEscapes(t, 'b').text]).some((text) => {
    const stripped = text.replace(/\\\n/g, '').replace(/[\\'"$`]/g, '');
    return git
      ? stripped.includes(git.sub) || (checkoutTwin && stripped.includes('restore'))
      : re.test(stripped);
  });
}

/**
 * Data past MAX_PAYLOAD_DEPTH and every text it would hand on to a shell
 * (#1933 fix cycle 2): the rendered pipe data (pipedShellData — printf output,
 * decoded echo data) and the `-c`/`env -S` payloads of its statements, closed
 * transitively up to UNREAD_DATA_TEXTS_CAP texts. Only read as text by the
 * fail-closed past-cap check of matchSegments, never judged as a command
 * line, so it charges no evaluation budget.
 *
 * @param {string} data
 * @returns {string[]}
 */
function unreadDataTexts(data) {
  const texts = [data];
  for (let n = 0; n < texts.length && texts.length < UNREAD_DATA_TEXTS_CAP; n++) {
    const segments = splitSegments(tokenizeCommand(normalizeShellWhitespaceExpansions(texts[n], { expandSingleQuoted: true })));
    for (const segment of segments) {
      for (const text of [...pipedShellData(segment), ...dedupedSegmentPayloads(segment, resolveSegmentVerb(segment))]) {
        if (!texts.includes(text)) texts.push(text);
      }
    }
  }
  return texts;
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
        // #1953: a `$` that win32 reads as part of a path (`C$`, `::$DATA`)
        // keeps the text for the win32 judgement in the matchers.
        const win32Text = operand ? win32DollarLiteral(operand.text) : null;
        out.push(win32Text === null ? { target: null, mode, fd, unresolved: true } : { target: null, mode, fd, unresolved: true, win32Text });
        continue;
      }
      // A glued group-closing `}` (`{echo x >CLAUDE.md}`) — both readings are
      // judged (#1707 point 1, see gluedCloseReadings).
      for (const text of [operand.text, ...(operand.closeReadings ?? [])]) {
        out.push({ target: text, mode, fd });
      }
      // #1970: every word of a brace operand (zsh writes them all: `>{CLAUDE.md,x}`);
      // one not read (past the budget, cut at `$IFS`) is judged by its characters.
      if (operand.braceUnreadable === true && operand.braceWords === undefined) {
        out.push({ target: null, mode, fd, unresolved: true, reason: 'brace-unread', text: operand.text });
      } else if (operand.text.includes('{')) {
        for (const w of expandBraces([operand], budget.brace ?? newBraceBudget())) {
          if (w === operand) continue;
          if (w.braceUnreadable === true) out.push({ target: null, mode, fd, unresolved: true, reason: 'brace-unread', text: w.text });
          else out.push({ target: w.text, mode, fd });
        }
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
    // Both the raw segment and its empty-expansion reading are judged (#1908
    // point 2): `/usr/bin/ti${x}me -o CLAUDE.md true` and `d${x}d of=CLAUDE.md`
    // name the wrapper/verb only in the reading. A reading's word whose `$` is
    // gone (`expanded`) is an unknown operand, reported unresolved.
    const empty = emptyExpansionSegment(segment);
    const views = [[segment, resolved]];
    if (Array.isArray(empty)) views.push([empty, resolveSegmentVerb(empty)]);
    // BOTH views are always read, even when the raw segment already names a
    // file-writing wrapper / file-operand verb: the reading can hold a second
    // operand the raw view never sees (`dd of=/tmp/ok o${x}f=CLAUDE.md` — dd
    // takes the LAST `of=`; `time -o /tmp/ok /usr/bin/ti${x}me -o CLAUDE.md`).
    // An entry of the reading that is IDENTICAL to one the raw view produced is
    // the same operand judged twice (`time -o "$OUT"`) and is dropped.
    const rawEntryKeys = new Set();
    const pushFromView = (viewIndex, entry) => {
      const key = JSON.stringify(entry);
      if (viewIndex === 0) rawEntryKeys.add(key);
      else if (rawEntryKeys.has(key)) return;
      out.push(entry);
    };
    const seenWrapperTargets = new Set();
    for (const [vi, wa] of views.flatMap(([, res], v) => readingsOf(res).flatMap((r) => r.wrapperArgs.map((w) => [v, w])))) {
      if (wa.writesFile !== true) continue;
      if (typeof wa.value !== 'string') continue;
      // De-dup key is the OPERAND plus the mode, which for a resolved entry is
      // exactly `target + ':' + mode`; using the operand keeps two distinct
      // unresolved spellings (`"$OUT"` vs `"$X"`) distinct rather than
      // collapsing them onto a shared `null` target.
      const key = `${wa.value}:truncate`;
      if (seenWrapperTargets.has(key)) continue;
      seenWrapperTargets.add(key);
      if (/[$`]/.test(wa.value) || wa.expanded === true) {
        // Same fail-visible rule as a redirect operand (#983): never guess at a
        // variable or a command substitution, but never silently drop it either.
        pushFromView(vi, { target: null, mode: 'truncate', fd: null, unresolved: true });
        continue;
      }
      pushFromView(vi, { target: wa.value, mode: 'truncate', fd: null });
    }

    // A VERB can name its write target as a bare operand, with no redirect
    // operator and no wrapper flag: `dd of=CLAUDE.md` truncates CLAUDE.md while
    // `> CLAUDE.md` is denied (measured ALLOW pre-#1366 against the real
    // policy). Keyed on the RESOLVED verb, so `sudo dd of=X` is reached through
    // the existing wrapper unwrap; both readings contribute, as above.
    const seenVerbOperands = new Set();
    for (const [seg, reading, vi] of views.flatMap(([v, res], n) => readingsOf(res).map((r) => [v, r, n]))) {
      const spec = reading.verb ? VERB_FILE_OPERANDS.get(reading.verb) : null;
      if (!spec || reading.index < 0) continue;
      let operand = null;
      let operandExpanded = false;
      let append = false;
      for (let k = reading.index + 1; k < seg.length; k++) {
        const text = seg[k].text;
        if (seg[k].redirect) continue;
        if (text.startsWith(spec.prefix)) {
          operand = text.slice(spec.prefix.length);
          // An expanded word whose value is a literal tail of its source word
          // had its expansion in the KEY (`o${x}f=CLAUDE.md`): the value is
          // known, so it is judged, not reported unresolved.
          const src = seg[k].sourceText;
          operandExpanded = seg[k].expanded === true &&
            !(typeof src === 'string' && operand.length > 0 && src.endsWith(operand) && src.length - operand.length >= spec.prefix.length &&
              !/[$`\\'"]/.test(operand));
        }
        else if (spec.appendRe?.test(text)) append = true;
      }
      if (operand === null || operand.length === 0) continue;
      const mode = append ? 'append' : spec.mode;
      const key = `${operand}:${mode}`;
      if (seenVerbOperands.has(key)) continue;
      seenVerbOperands.add(key);
      if (/[$`]/.test(operand) || operandExpanded) {
        // Same fail-visible rule as a redirect operand (#983) — never guess at a
        // variable or a command substitution, never silently drop it either.
        pushFromView(vi, { target: null, mode, fd: null, unresolved: true });
        continue;
      }
      pushFromView(vi, { target: operand, mode, fd: null });
    }

    // Both readings of an ambiguous unknown flag contribute payloads (#1000),
    // UNIONED and de-duped (HIGH-2). Walking parse A only let
    // `env -Q x bash -c 'echo pwned > CLAUDE.md'` — which resolves to the
    // non-interpreter `x` in parse A — bypass the redirect denylist entirely
    // (coordinator-measured: `bash -c '… > CLAUDE.md'` DENY, `env -Q x bash -c
    // '… > CLAUDE.md'` ALLOW). The same helper matchSegments uses guarantees the
    // deduped-before-charging rule holds on this surface too, so the redirect
    // recursion cannot be starved any differently than the match recursion.
    // The empty-expansion reading's payloads too (#1896): `ba${x}sh -c 'echo
    // x > T'` runs bash. Only the payload walk — redirect operators are read
    // above whatever the verb is.
    const payloadSet = new Set(dedupedSegmentPayloads(segment, resolved));
    if (empty === UNREAD) out.push({ target: null, mode: null, fd: null, unresolved: true, reason: 'depth-exceeded' });
    else if (empty !== null) for (const p of dedupedSegmentPayloads(empty, resolveSegmentVerb(empty))) payloadSet.add(p);
    const payloads = [...payloadSet];
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
      collectWithBraces(collectRedirectTargets, payload, { expandSingleQuoted: true }, out, depth + 1, budget);
    }
  }
}

/**
 * The collected target entries without exact repeats, in first-seen order: a
 * second reading of the same statement (the zsh bare-`}` reading, #2027
 * point 1, judges `rm -f X }` and `rm -f X`) collects the same entry again,
 * and a repeat changes no verdict.
 *
 * @template {object} T
 * @param {T[]} entries
 * @returns {T[]}
 */
function uniqueEntries(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    const key = JSON.stringify(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  // #1970: the brace-expanded reading too (`>{CLAUDE.md,x}`, `{dd,of=CLAUDE.md}`).
  collectWithBraces(collectRedirectTargets, command, {}, out, 0, { remaining: MAX_PAYLOAD_EVALUATIONS, brace: newBraceBudget() });
  return uniqueEntries(out);
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
  return path.posix.normalize(rel.split(path.sep).join('/')).replace(/^(\.\/)+/, '');
}

/**
 * The text of an operand whose every `$` is part of a Windows path, or null
 * (#1953). Two places: the administrative share `\\host\C$` (bash never expands
 * `$` before a separator or at the end) and an NTFS stream suffix
 * (`CLAUDE.md::$DATA`, `x:$S`) — whatever a stream name expands to, the file is
 * the part before the colon, so the suffix is dropped here. Any other `$` or a
 * backtick keeps the operand unresolved. Used on every platform by the
 * extractors (an extra `win32Text` field), judged only on win32 by the matchers.
 *
 * @param {string} text
 * @returns {string|null}
 */
function win32DollarLiteral(text) {
  const share = /^[\\/]{2}(?:[?.][\\/]UNC[\\/])?[^\\/$`]+[\\/][a-z]\$(?=[\\/]|$)/i.exec(text);
  const head = share ? share[0] : (/^(?:[\\/]{2}[?.][\\/])?[a-z]:/i.exec(text)?.[0] ?? '');
  const rest = text.slice(head.length).replace(/[^\\/]+/g, (c) => (c.includes(':') ? c.slice(0, c.indexOf(':')) : c) || c);
  return /[$`]/.test(rest) ? null : head + rest;
}

/**
 * win32 only (#1953): judge an unresolved entry by its `win32Text`.
 *
 * @param {{ win32Text?: string }} entry
 * @param {ReturnType<typeof compileTargetDenylist>} compiled
 * @param {string|null} repoRoot
 * @param {string|undefined} home
 * @returns {boolean}
 */
function win32TextMatches(entry, compiled, repoRoot, home) {
  return process.platform === 'win32' && typeof entry.win32Text === 'string'
    && targetMatchesDenylist(entry.win32Text, compiled, repoRoot, home);
}

/**
 * Canonicalize Windows target spellings, then translate an MSYS drive prefix.
 * POSIX hosts keep these paths unchanged.
 *
 * Windows aliases of one file (#1953), each mapped to the plain spelling:
 *   - `\\?\UNC\h\s`, `\\.\UNC\h\s` → `\\h\s`; `\\?\C:`, `\\.\C:` → `C:`.
 *   - administrative share `\\<any host>\C$\…` → `C:\…`. Any host, not only
 *     `localhost`/`127.0.0.1`: the machine's own name and its other loopback
 *     spellings are not knowable without I/O, and a remote host's identical
 *     path only over-denies (fail-closed). A non-admin share that points into
 *     the repo is NOT resolvable lexically — named ceiling in ADR-0017.
 *   - drive-relative `C:CLAUDE.md` (cwd of drive C) → `CLAUDE.md`, which the
 *     caller then judges repo-root-relative like every relative target.
 *   - NTFS stream `name::$DATA` / `name:stream` → `name`: the default stream IS
 *     the file, and a named stream is treated as the file (fail-closed).
 *   - trailing dots and spaces per component, as before.
 * 8.3 short names (`CLAUDE~1.MD`) cannot be mapped without the filesystem;
 * `targetMatchesDenylist` fails closed on them instead.
 *
 * @param {string} target
 * @param {string} [platform]
 * @returns {string}
 */
export function normalizeMsysPath(target, platform = process.platform) {
  if (platform !== 'win32') return target;
  target = target.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '\\\\')
    .replace(/^[\\/]{2}[?.][\\/](?=[a-z]:)/i, '')
    .replace(/^[\\/]{2}[^\\/]+[\\/]([a-z])\$([\\/]|$)/i, (_m, drive, sep) => `${drive.toUpperCase()}:${sep || '\\'}`);
  if (/^[a-z]:(?![\\/])/i.test(target)) target = target.slice(2) || '.';
  target = target.replace(/[^\\/]+/g, (component, offset) => {
    if (offset === 0 && /^[a-z]:$/i.test(component)) return component;
    if (component === '.' || component === '..') return component;
    const file = component.replace(/:.*$/s, '') || component;
    return file.replace(/[. ]+$/, '') || file;
  });
  if (!/^\/[a-z](?:\/|$)/i.test(target)) return target;
  return `${target[1].toUpperCase()}:\\${target.slice(3).replace(/\//g, '\\')}`;
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
  const expanded = normalizeMsysPath(expandLeadingHome(raw, home));

  if (!path.isAbsolute(expanded)) {
    const lexical = path.posix.normalize(expanded.split(path.sep).join('/')).replace(/^(\.\/)+/, '');
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
    // #1970: a brace word the reader did not expand matches when its
    // characters can spell a denylist entry (fail-closed).
    if (entry.reason === 'brace-unread' && modes.has(entry.mode) && braceTextCouldSpell(entry.text, denylist)) return true;
    if (entry.unresolved) {
      if (win32TextMatches(entry, compiled, repoRoot, home) && modes.has(entry.mode)) return true;
      continue;
    }
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
 * @returns {{ relRegexes: RegExp[], absRegexes: RegExp[], relGlobs: string[], absGlobs: string[] }}
 */
function compileTargetDenylist(denylist, home) {
  const relRegexes = [];
  const absRegexes = [];
  // The glob texts too, for the win32 8.3 short-name check (#1953).
  const relGlobs = [];
  const absGlobs = [];
  for (const pattern of denylist) {
    const text = String(pattern);
    if (text === '~' || text.startsWith('~/')) {
      const expanded = expandLeadingHome(text, home);
      if (expanded === text) continue; // no usable home → no match, never a guess
      absRegexes.push(redirectGlobToRegExp(foldAbsoluteTarget(expanded)));
      absGlobs.push(expanded);
    } else {
      relRegexes.push(redirectGlobToRegExp(text));
      relGlobs.push(text);
    }
  }
  return { relRegexes, absRegexes, relGlobs, absGlobs };
}

// An 8.3 short-name component (`CLAUDE~1.MD`, `ORCHES~1`, hashed `CL1A2B~1`).
const SHORT_NAME_COMPONENT = /^([^~.\\/]{1,6})~\d{1,6}(?:\.([^.\\/]{1,3}))?$/i;

/**
 * Could the 8.3 alias `short` (a SHORT_NAME_COMPONENT match) stand for a long
 * name that the glob component `glob` matches (#1953)? Mirrors the alias
 * generator loosely, always erring toward yes: leading dots dropped, spaces and
 * inner dots removed, upper-cased; the base is the first up-to-6 characters,
 * or 2 characters plus a 4-hex hash; the extension is the first 3 characters
 * of the last one. A wildcard compares only its literal prefix; one in the
 * extension part may hide the last dot, so any extension is accepted there.
 *
 * @param {RegExpExecArray} short
 * @param {string} glob — one glob component, never `**`
 * @returns {boolean}
 */
function shortNameCouldBe(short, glob) {
  const base = short[1].toUpperCase();
  const ext = (short[2] ?? '').toUpperCase();
  const clean = (s) => s.split(/[*?]/)[0].replace(/[ .]/g, '').toUpperCase().replace(/[+,;=[\]]/g, '_');
  const agree = (a, b) => a.slice(0, Math.min(a.length, b.length)) === b.slice(0, Math.min(a.length, b.length));
  const long = glob.replace(/^\.+/, '');
  const dot = long.lastIndexOf('.');
  const longBase = dot === -1 ? long : long.slice(0, dot);
  const longExt = dot === -1 ? '' : long.slice(dot + 1);
  const wild = /[*?]/;
  const hashed = /^.{2}[0-9A-F]{4}$/.test(base);
  if (wild.test(longExt)) {
    // The long name's last dot may lie inside or after the wildcard
    // (`*.jsonl*` → `events.jsonl.1` → `EVENTS~1.1`): the base then runs on
    // through the glob's dot, and any extension can follow.
    const runOn = clean(long);
    return agree(runOn, base) || (hashed && agree(runOn, base.slice(0, 2)));
  }
  const wantBase = clean(longBase);
  const baseOk = wild.test(longBase)
    ? agree(wantBase, base) || (hashed && agree(wantBase, base.slice(0, 2)))
    : wantBase.startsWith(base) || (hashed && wantBase.startsWith(base.slice(0, 2)));
  if (!baseOk) return false;
  if (dot === -1) return wild.test(longBase) || ext === '';
  return clean(longExt).slice(0, 3) === ext;
}

/**
 * Component-wise match of a path against a denylist glob where an 8.3 component
 * of the path counts as every long name it could abbreviate (#1953). `**`
 * spans any number of components (zero included — over-matching is the safe
 * direction here).
 *
 * @param {string[]} parts — path components
 * @param {string[]} globParts — glob components
 * @returns {boolean}
 */
function shortNamePathCouldMatch(parts, globParts) {
  const walk = (i, j) => {
    if (j === globParts.length) return i === parts.length;
    if (globParts[j] === '**') {
      for (let k = i; k <= parts.length; k++) if (walk(k, j + 1)) return true;
      return false;
    }
    if (i === parts.length) return false;
    const short = SHORT_NAME_COMPONENT.exec(parts[i]);
    const ok = short ? shortNameCouldBe(short, globParts[j]) : redirectGlobToRegExp(globParts[j]).test(parts[i]);
    return ok && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

/**
 * win32 only (#1953): a target with an 8.3 short-name component is denied when
 * that alias could name a denylisted path. The real long name needs the
 * filesystem, which this module never reads, so the check fails closed. The
 * target is compared absolute (repoRoot + glob for the repo-relative class) so a
 * short name in the root's own path is read too; without a usable root a
 * relative target is compared to the repo-relative globs directly.
 *
 * @param {string} rawTarget
 * @param {{ relGlobs: string[], absGlobs: string[] }} compiled
 * @param {string|null} repoRoot
 * @param {string|undefined} home
 * @returns {boolean}
 */
function shortNameTargetCouldMatch(rawTarget, compiled, repoRoot, home) {
  const split = (p) => p.split(/[\\/]+/).filter((c) => c !== '');
  const expanded = normalizeMsysPath(expandLeadingHome(rawTarget, home));
  if (!split(expanded).some((c) => SHORT_NAME_COMPONENT.test(c))) return false;
  const rooted = repoRoot && path.isAbsolute(repoRoot);
  if (!path.isAbsolute(expanded) && !rooted) {
    const parts = split(path.normalize(expanded));
    return compiled.relGlobs.some((g) => shortNamePathCouldMatch(parts, split(g)));
  }
  const parts = split(path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded)));
  if (compiled.absGlobs.some((g) => shortNamePathCouldMatch(parts, split(g)))) return true;
  if (!rooted) return false;
  const root = split(path.normalize(repoRoot));
  return compiled.relGlobs.some((g) => shortNamePathCouldMatch(parts, [...root, ...split(g)]));
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
 * On win32 an 8.3 short-name target is judged by `shortNameTargetCouldMatch`
 * as well (fail-closed, #1953).
 *
 * @param {string} rawTarget — resolved target text (quotes already stripped)
 * @param {ReturnType<typeof compileTargetDenylist>} compiled
 * @param {string|null} repoRoot
 * @param {string|undefined} home
 * @returns {boolean}
 */
function targetMatchesDenylist(rawTarget, compiled, repoRoot, home) {
  const { relRegexes, absRegexes } = compiled;

  if (absRegexes.length > 0) {
    const expandedTarget = normalizeMsysPath(expandLeadingHome(rawTarget, home));
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

  if (process.platform === 'win32' && /~\d/.test(rawTarget)) {
    return shortNameTargetCouldMatch(rawTarget, compiled, repoRoot, home);
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
  for (const raw of segments) {
    // #1970: a brace word the brace-expanded reading did not read (past the
    // budget, cut at `$IFS`) behind a delete verb or a command that runs its
    // words is judged by the characters of its segment — a word cut at `$IFS`
    // spans several tokens (firstDeniedDeleteTarget), fail-closed.
    if (raw.some((t) => t.braceUnreadable === true && t.braceWords === undefined)) {
      const verb = readingsOf(resolveSegmentVerb(raw)).find((r) => PATH_DESTRUCTIVE_VERBS.has(r.verb))?.verb ?? null;
      if (verb !== null || unreadBraceWord(raw) !== undefined) {
        out.push({ target: null, verb, unresolved: true, reason: 'brace-unread', text: raw.map((t) => t.text).join(' ') });
      }
    }
    // The empty-expansion reading too (#1896, as matchSegments, #1893):
    // `r${x}m P`, `${x} rm P`, `ba${x}sh -c 'rm P'` delete P. Its changed
    // words carry `expanded`, so an operand like `$f` stays unresolved.
    const empty = emptyExpansionSegment(raw);
    if (empty === UNREAD) out.push({ target: null, verb: null, unresolved: true, reason: 'depth-exceeded' });
    const seen = new Set();
    const payloadSet = new Set();
    for (const segment of empty === null || empty === UNREAD ? [raw] : [raw, empty]) {
      const resolved = resolveSegmentVerb(segment);

      // BOTH readings of an ambiguous unknown WRAPPER flag contribute (#1000),
      // unioned and never replaced: `env -Q x rm .orchestrator/metrics/events.jsonl`
      // resolves to the non-destructive verb `x` in parse A and to `rm` in parse B,
      // while `sudo -n rm <file>` is the mirror case (parse B swallows `rm` as
      // `-n`'s operand). Picking either reading alone drops one of the two.
      const readings = readingsOf(resolved);

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
        let argvAt = 0;
        for (const tok of argvWordsWithoutRedirects(segment, reading.index + 1)) {
          argvAt++;
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

            if (tok.expanded || /[$`]/.test(text)) {
              // Variable indirection (`rm -f "$LEDGER"`) or command substitution:
              // fail-visible, never guess (#983 rule, same direction). Keyed on
              // the operand's position, so both segment readings report it once.
              const at = `${reading.verb}\u0000#${argvAt}`;
              if (seen.has(at)) continue;
              seen.add(at);
              const win32Text = tok.expanded ? null : win32DollarLiteral(text);
              out.push({
                target: null, verb: reading.verb, unresolved: true, reason: 'variable/substitution',
                ...(win32Text === null ? {} : { win32Text }),
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
      // Both readings' payloads are de-duped before charging (HIGH-1).
      for (const p of dedupedSegmentPayloads(segment, resolved)) payloadSet.add(p);
    }
    const payloads = [...payloadSet];
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
      collectWithBraces(collectDeleteTargets, payload, { expandSingleQuoted: true }, out, depth + 1, budget);
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
  // #1970: the brace-expanded reading too (`{rm,-f,<ledger>}`, `rm {-f,<ledger>}`).
  collectWithBraces(collectDeleteTargets, command, {}, out, 0, { remaining: MAX_PAYLOAD_EVALUATIONS, brace: newBraceBudget() });
  return uniqueEntries(out);
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
    // #1970: an unread brace word whose characters can spell a denylist entry (fail-closed).
    if (entry.reason === 'brace-unread' && braceTextCouldSpell(entry.text, denylist)) {
      return { target: entry.text, verb: entry.verb ?? 'rm|mv|unlink' };
    }
    if (entry.unresolved && win32TextMatches(entry, compiled, repoRoot, home)) {
      return { target: entry.win32Text, verb: entry.verb };
    }
    if (entry.unresolved || typeof entry.target !== 'string') continue;
    if (targetMatchesDenylist(entry.target, compiled, repoRoot, home)) {
      return { target: entry.target, verb: entry.verb };
    }
  }
  return null;
}

// The hooks ask once per pattern rule with the same command (13 calls per
// Bash command), and #1893 sends every command with a `$` to the lexer. The
// segments do not depend on the pattern and matchSegments never changes them,
// so commandMatchesBlocked keeps the last command's.
let lastLexed = { command: null, segments: null };

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
 * @param {{ restore?: boolean, onBudgetSpent?: (cause: 'brace' | 'pipe') => void }} [opts] — `restore: false` keeps the
 *   `git checkout --` pattern from also matching `git restore` (#1917 point
 *   2). The destructive guard passes it: it reads and measures restore resets
 *   itself, and its unread-form fallback must see checkout matches only.
 *   `onBudgetSpent` is called before a match a read budget decided, with
 *   its cause: `'brace'` (BRACE_WORD_BUDGET) or `'pipe'` (piped or xargs
 *   data the line's pipe-read budget left unread, #2006), so a caller can
 *   name that deny; it may throw.
 * @returns {boolean}
 */
export function commandMatchesBlocked(command, pattern, { restore = true, onBudgetSpent } = {}) {
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
  // The empty-expansion reading (#1893) REMOVES text between two pattern
  // characters (`res${x}et` → `reset`), so a command with any `$` or backtick
  // skips the prefilter for the same reason.
  const words = pattern.split(' ').filter(Boolean);
  // A git pattern's flags may be spelled differently (#1831: `-xfd` holds no
  // `-f`), so its prefilter asks only for `git` and the subcommand — the
  // argv match needs both words verbatim (git does not abbreviate
  // subcommands), so the superset property above still holds.
  const git = gitPatternSpec(words);
  if (git !== null) git.restore = restore;
  const required = git ? ['git', git.sub] : words;
  // #1917 point 2: the `git checkout --` spec also matches `git restore`
  // (gitWordsMatch), whose subcommand word must then pass the prefilter too.
  const alsoRestore = git !== null && git.restore && git.sub === 'checkout' && git.flags.length === 1 && git.flags[0] === '--';
  const mayMatch = (text) => {
    // #1955 (a): matchSegments also reads every guarded program name in
    // lower case (foldedCommandSegment), so the superset test compares in
    // lower case too.
    const stripped = text.replace(/\\\n/g, '').replace(/[\\'"$`]/g, '').toLowerCase();
    if (alsoRestore && stripped.includes('git') && stripped.includes('restore')) return true;
    // #1932 point 1: an unreadable parallel template supplies the subcommand
    // (parallelFailClosedLine (a): `parallel git {} :::: f`), so a git pattern
    // on a line naming `parallel` and `git` goes to the tokenizer — and so
    // does one holding a replacement string, which can spell `git` only once
    // rendered (`parallel g{} clean -fdx ::: it`, #1932 fix cycle 2).
    if (git && stripped.includes('parallel') && (stripped.includes('git') || PARALLEL_REPLACEMENT_RE.test(stripped))) return true;
    return required.every((w) => stripped.includes(w.toLowerCase()));
  };
  // Data piped into a shell is decoded (#1933 fix cycle 1, r3 F3): printf and
  // echo escapes (`cl\145an`, `\x67it`) and printf conversions (`git %s`) ADD
  // characters the text does not hold, like `$'…'` — such a line skips the
  // prefilter too (pipesEncodedData, a superset test).
  // #1956: brace expansion removes text between pattern characters
  // (`re{s,}et` → `reset`) and a sequence adds characters (`{r..r}`), so a
  // line holding a brace list or sequence skips the prefilter too.
  // #2012: zsh MULTIOS glues a pipe or `< <(…)` output without a trailing
  // newline onto the next stdin source (`printf 're' | xargs git <<< 'set
  // …'` reads `reset …`), removing the text between two pattern characters:
  // a line with a stdin here-source and a second source skips it too.
  const sources = (command.match(/<<|<\(/g) ?? []).length;
  if (!/[$`]/.test(command) && !pipesEncodedData(command) && !/\{[^}]*(?:,|\.\.)/.test(command)
    && !(sources > 0 && (sources > 1 || command.includes('|')))
    && !mayMatch(normalizedCommand) && !mayMatch(payloadNormalizedCommand)) return false;

  if (lastLexed.command !== command) {
    const brace = newBraceBudget();
    let segments = matcherSegments(tokenizeCommand(normalizedCommand), brace);
    // #1956 fix cycle 1: the raw command too, where the lexer still sees the
    // `$IFS` that split a brace word (ifsSplit) — normalizedCommand has none.
    if (normalizedCommand !== command && /\$\{?IFS/.test(command) && command.includes('{')) {
      segments = [...segments, ...matcherSegments(tokenizeCommand(command), brace)];
    }
    lastLexed = { command, segments, brace };
  }
  const needed = required.map((w) => (alsoRestore && w === 'checkout' ? ['checkout', 'restore'] : [w]));
  const brace = { ...lastLexed.brace };
  const budget = { remaining: MAX_PAYLOAD_EVALUATIONS, needed, brace, pipeUnread: false };
  const matched = matchSegments(lastLexed.segments, re, 0, budget, git);
  if (matched && brace.spent && typeof onBudgetSpent === 'function') onBudgetSpent('brace');
  if (matched || !budget.pipeUnread) return matched;
  // Unread pipe data and no other match: fail-closed, named (#2006).
  if (typeof onBudgetSpent === 'function') onBudgetSpent('pipe');
  return true;
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
    case 'git checkout --':
      return "Discarding uncommitted changes (git checkout -- <path>, git restore <path>) is blocked. Recover a file's committed content with 'git show HEAD:<path>' instead, or ask the coordinator.";
    default:
      return `Blocked command pattern '${pattern}' is not permitted during wave execution.`;
  }
}
