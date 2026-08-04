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
 *     `N>&M` (fd digits are consumed from the in-progress token, so
 *     `2>/dev/null` lexes as fd-2 redirect + `/dev/null` operand instead of
 *     one glued token). The `redirect` field appears ONLY on redirect tokens —
 *     ordinary tokens keep the exact `{ text, quoted }` shape.
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
 * @returns {Array<{ text: string, quoted: boolean, redirect?: { fd: number|null, mode: string } }>}
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
      text += command[i + 1]; started = true; i++;
      continue;
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
      tokens.push({ text: ';', quoted: false, operator: 'newline' });
      continue;
    }

    if (/\s/.test(ch)) { flush(); continue; }

    // Inside `$(( … ))` / `(( … ))` every `<` / `>` is a shift or comparison
    // operator, never a redirect (gate 1, #970) — append verbatim so the
    // redirect branches below never tear an arithmetic expression apart.
    if (arithDepth > 0 && (ch === '<' || ch === '>')) { text += ch; started = true; continue; }

    // Redirect operators (#983) — longest-match-first, and BEFORE the
    // chain-operator branch below so `&>` / `&>>` win over the `&` operator.
    if (ch === '&' && command[i + 1] === '>') {
      flush();
      if (command[i + 2] === '>') {
        tokens.push({ text: '&>>', quoted: false, redirect: { fd: null, mode: 'append' } });
        i += 2;
      } else {
        tokens.push({ text: '&>', quoted: false, redirect: { fd: null, mode: 'truncate' } });
        i += 1;
      }
      continue;
    }
    if (ch === '<') {
      if (command[i + 1] === '<' && command[i + 2] === '<') {
        flush();
        tokens.push({ text: '<<<', quoted: false, redirect: { fd: null, mode: 'herestring' } });
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
        const fdDigits = takeFdPrefix();
        const fdNum = fdDigits === '' ? null : Number.parseInt(fdDigits, 10);
        const opText = `${fdDigits}<<${stripTabs ? '-' : ''}`;
        tokens.push({ text: opText, quoted: false, redirect: { fd: fdNum, mode: 'heredoc' } });
        if (value && command[end] !== ')') {
          pendingHeredocs.push({ delim: value, stripTabs });
          i = end - 1;
        } else {
          i = j - 1;
        }
        continue;
      }
      const fdDigits = takeFdPrefix();
      const fdNum = fdDigits === '' ? null : Number.parseInt(fdDigits, 10);
      tokens.push({ text: `${fdDigits}<`, quoted: false, redirect: { fd: fdNum, mode: 'read' } });
      continue;
    }
    if (ch === '>') {
      // fd-prefix (`2>/dev/null`, `2>>log`, `2>&1`): a purely-numeric UNQUOTED
      // in-progress token is the IO_NUMBER — consume it as the fd instead of
      // flushing it as an ordinary word (matches bash IO_NUMBER lexing; a
      // quoted "2" stays a word, exactly as bash treats it).
      let fd = null;
      if (started && !sawQuote && /^[0-9]+$/.test(text)) {
        fd = Number.parseInt(text, 10);
        text = '';
        started = false;
      } else {
        flush();
      }
      const fdText = fd === null ? '' : String(fd);
      if (command[i + 1] === '>') {
        tokens.push({ text: `${fdText}>>`, quoted: false, redirect: { fd, mode: 'append' } });
        i += 1;
      } else if (command[i + 1] === '&' && /[0-9]/.test(command[i + 2] ?? '')) {
        // N>&M / >&M — fd duplication; the target fd is inline, no operand word.
        let j = i + 2;
        let dupTarget = '';
        while (j < command.length && /[0-9]/.test(command[j])) { dupTarget += command[j]; j++; }
        tokens.push({ text: `${fdText}>&${dupTarget}`, quoted: false, redirect: { fd, mode: 'dup' } });
        i = j - 1;
      } else if (command[i + 1] === '|') {
        tokens.push({ text: `${fdText}>|`, quoted: false, redirect: { fd, mode: 'truncate' } });
        i += 1;
      } else {
        tokens.push({ text: `${fdText}>`, quoted: false, redirect: { fd, mode: 'truncate' } });
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
      let op = ch;
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) { op = ch + ch; i++; }
      tokens.push({ text: op, quoted: false });
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
 * (`;`, `&&`, `||`, `|`, `&`) and on newline separators (#981). Only UNQUOTED
 * single-token operators split; an operator that arrived inside quotes stays
 * part of its segment.
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
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @returns {Array<Array<{ text: string, quoted: boolean }>>}
 */
function splitSegments(tokens) {
  const segments = [];
  let current = [];
  const operators = new Set([';', '&&', '||', '|', '&']);
  for (const tok of tokens) {
    if (!tok.quoted && (tok.operator === 'newline' || operators.has(tok.text))) {
      segments.push(current);
      current = [];
      continue;
    }
    current.push(tok);
  }
  segments.push(current);
  return segments.filter((s) => s.length > 0);
}

// Public alias — the single source of truth for chain-segment splitting shared
// with hooks/pre-bash-destructive-guard.mjs (W4 B1; internal call sites keep
// the short name).
export { splitSegments as splitChainSegments };

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

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
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @returns {{ verb: string|null, index: number, payloads: string[],
 *             wrapperArgs: Array<{ wrapper: string, flag: string, value: string|null,
 *                                  writesFile?: true }> }}
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
 *   copy is now REDUNDANT and can be replaced by `wa.writesFile` (#991
 *   follow-up) — the knowledge lives here, next to the grammar it belongs to.
 *   `/usr/bin/time -o <ledger> npm test` truncates `<ledger>` while the verb is
 *   `npm`; extractRedirectTargets surfaces exactly these entries so the
 *   redirect denylist sees them too.
 */
export function resolveSegmentVerb(segment) {
  const payloads = [];
  const wrapperArgs = [];
  let i = 0;
  // Skip leading FOO=bar env assignments (unquoted).
  while (i < segment.length && !segment[i].quoted && ENV_ASSIGN_RE.test(segment[i].text)) {
    i++;
  }
  while (i < segment.length) {
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
        if (text.startsWith('--split-string=')) {
          payloads.push(text.slice('--split-string='.length));
        } else if (text !== '-S' && text !== '--split-string') {
          payloads.push(text.slice(2)); // attached form: -S'string'
        } else if (i + 1 < segment.length) {
          payloads.push(segment[i + 1].text);
          i++;
        }
        i++;
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
      i++; // unknown / boolean / attached-value flag — one token
    }
    for (let p = spec.positionals ?? 0; p > 0 && i < segment.length; p--) i++;
    if (sawShellFlag) return { verb: 'sh', index: i, payloads, wrapperArgs };
  }
  if (i >= segment.length) return { verb: null, index: -1, payloads, wrapperArgs };
  return { verb: segment[i].text.replace(/^.*\//, ''), index: i, payloads, wrapperArgs };
}

/**
 * Shell verbs whose `-c <payload>` argument is a command line the shell will
 * execute — recursion candidates for matchSegments (#982). `su` participates
 * (`su root -c '…'`); the payload token is the one following `-c` or a bundled
 * short-flag group ending in `c` (`-lc`, `-ec`).
 */
const DASH_C_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'su']);

/**
 * Collect `-c`-style payload strings after the verb within a segment.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {number} verbIndex
 * @returns {string[]}
 */
function dashCPayloads(segment, verbIndex) {
  const payloads = [];
  for (let i = verbIndex + 1; i < segment.length - 1; i++) {
    if (/^-[A-Za-z]*c$/.test(segment[i].text)) payloads.push(segment[i + 1].text);
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
 * Test whether a blocked pattern occurs OUTSIDE quoted tokens within a segment.
 * Reconstructs the unquoted skeleton (quoted tokens replaced by a single space
 * placeholder so they cannot bridge an adjacent-token match) and applies the
 * boundary regex.
 *
 * Redirect tokens (#983) and their operand word are ALSO replaced by space
 * placeholders (same no-bridging treatment as quoted tokens): a redirect
 * target is a filename argument to the shell, not part of the command verb
 * surface — `rm -rf /tmp/ok > out.log` must not feed `>` / `out.log` into
 * the pattern skeleton. `dup`-mode redirects (`2>&1`) carry their target
 * inline and consume no operand.
 *
 * @param {Array<{ text: string, quoted: boolean, redirect?: object }>} segment
 * @param {RegExp} re
 * @returns {boolean}
 */
function unquotedSegmentMatch(segment, re) {
  const parts = [];
  for (let i = 0; i < segment.length; i++) {
    const tok = segment[i];
    if (tok.redirect) {
      parts.push(' ');
      // `dup` (2>&1) has its target inline; `heredoc` consumes its delimiter in
      // the lexer and its body arrives as a separate QUOTED token — neither has
      // an operand word to skip, and skipping would eat the next real command.
      const hasOperandWord = tok.redirect.mode !== 'dup' && tok.redirect.mode !== 'heredoc';
      if (hasOperandWord && i + 1 < segment.length && !segment[i + 1].redirect) {
        parts.push(' ');
        i++; // operand word belongs to the redirect — skip it too
      }
      continue;
    }
    parts.push(tok.quoted ? ' ' : tok.text);
  }
  return re.test(parts.join(' '));
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
 * @returns {boolean}
 */
function matchSegments(segments, re, depth, budget) {
  for (const segment of segments) {
    // 1) Unquoted occurrence anywhere in the segment → always a match.
    if (unquotedSegmentMatch(segment, re)) return true;

    const resolved = resolveSegmentVerb(segment);

    // 2) Quoted occurrence → only a match when the segment verb is an interpreter
    //    that executes its quoted payload.
    if (quotedTokensMatch(segment, re)) {
      if (resolved.verb && SHELL_EXEC_INTERPRETERS.has(resolved.verb)) return true;
      // else: inert literal inside quotes for a non-interpreter verb → no match
      // for THIS segment; keep scanning other segments.
    }

    // 3) `-c`/`env -S` payload recursion (depth-capped, budgeted).
    if (depth < MAX_PAYLOAD_DEPTH) {
      const payloads = resolved.payloads;
      if (resolved.verb && DASH_C_SHELLS.has(resolved.verb)) {
        payloads.push(...dashCPayloads(segment, resolved.index));
      }
      for (const payload of payloads) {
        if (budget.remaining <= 0) break;
        budget.remaining -= 1;
        const subTokens = tokenizeCommand(
          normalizeShellWhitespaceExpansions(payload, { expandSingleQuoted: true }),
        );
        if (matchSegments(splitSegments(subTokens), re, depth + 1, budget)) return true;
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
      if (mode === 'dup' || mode === 'heredoc' || mode === 'herestring') continue;
      const operand = (i + 1 < segment.length && !segment[i + 1].redirect)
        ? segment[i + 1]
        : null;
      if (operand) i++; // operand word belongs to this redirect
      if (!operand || /[$`]/.test(operand.text)) {
        // Variable indirection (`> "$X"`), command substitution (`> $(cmd)` /
        // backticks), or a missing operand: fail-visible, never guess (#983).
        out.push({ target: null, mode, fd, unresolved: true });
      } else {
        out.push({ target: operand.text, mode, fd });
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
    for (const wa of resolved.wrapperArgs) {
      if (wa.writesFile !== true) continue;
      if (typeof wa.value !== 'string') continue;
      if (/[$`]/.test(wa.value)) {
        // Same fail-visible rule as a redirect operand (#983): never guess at a
        // variable or a command substitution, but never silently drop it either.
        out.push({ target: null, mode: 'truncate', fd: null, unresolved: true });
        continue;
      }
      out.push({ target: wa.value, mode: 'truncate', fd: null });
    }

    const payloads = [...resolved.payloads];
    if (resolved.verb && DASH_C_SHELLS.has(resolved.verb)) {
      payloads.push(...dashCPayloads(segment, resolved.index));
    }
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
  return new RegExp(`^${re}$`);
}

/**
 * Collapse the macOS `/private` alias prefix: `/private/tmp` and `/private/var`
 * name the SAME directories as `/tmp` and `/var` (the short forms are symlinks
 * into `/private`). Without this, one location has two spellings that compare
 * unequal — a repo checked out under `/tmp/...` (CI runners, worktrees) would
 * not recognise its own root in a command that spells it `/private/tmp/...`.
 *
 * Deliberately STATIC: no `realpathSync` on user input. Resolving an
 * attacker-supplied path at guard time is its own risk class, and this module
 * is I/O-free by header invariant. Only the two known macOS aliases collapse;
 * every other path is returned byte-identical.
 *
 * @param {string} p — an absolute, already-normalized path
 * @returns {string}
 */
function stripPrivateAlias(p) {
  return /^\/private\/(?:tmp|var)(?:\/|$)/.test(p) ? p.slice('/private'.length) : p;
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
 * Reduce a raw redirect target to the repo-relative POSIX form the denylist
 * globs are written in, or `null` when it cannot name a file inside the repo.
 *
 * @param {string} raw — resolved target text (quotes already stripped)
 * @param {string|null} repoRoot — absolute repo root, or null (no resolution)
 * @param {string|undefined} home
 * @returns {string|null}
 */
function repoRelativeRedirectTarget(raw, repoRoot, home) {
  const expanded = expandLeadingHome(raw, home);

  if (!path.isAbsolute(expanded)) {
    return path.posix.normalize(expanded).replace(/^(\.\/)+/, '');
  }
  // Absolute target: only judgeable against a known repo root. Without one the
  // pre-#988 behaviour stands (no match) rather than a guess.
  if (!repoRoot || !path.isAbsolute(repoRoot)) return null;
  const rel = path.relative(
    stripPrivateAlias(path.normalize(repoRoot)),
    stripPrivateAlias(path.normalize(expanded)),
  );
  // '' = the root itself (a directory, not a file target); '..'-prefixed or
  // absolute = outside the repo, which the repo-relative denylist never covers.
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return path.posix.normalize(rel).replace(/^(\.\/)+/, '');
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
 * tilde-expanded, `/private`-alias-collapsed and made repo-relative before the
 * globs run; a target outside the repo yields no match. WITHOUT `repoRoot`
 * (the default) an absolute target still never matches — identical to the
 * pre-#988 contract, so existing callers keep their exact behaviour. This
 * function stays I/O-free: `~` resolves from `process.env.HOME` (overridable
 * via `home`), never via a filesystem lookup.
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
  const regexes = denylist.map(redirectGlobToRegExp);

  for (const entry of extractRedirectTargets(command)) {
    if (entry.unresolved) continue;
    if (!modes.has(entry.mode)) continue;
    const target = repoRelativeRedirectTarget(entry.target, repoRoot, home);
    if (target === null) continue;
    if (regexes.some((re) => re.test(target))) return true;
  }
  return false;
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

  // Fast path: if the boundary regex does not match the raw string at all, no
  // tokenization can produce a match. Shell whitespace expansions can create
  // matches, so test the normalized forms rather than the original command.
  if (!re.test(normalizedCommand) && !re.test(payloadNormalizedCommand)) return false;

  const segments = splitSegments(tokenizeCommand(normalizedCommand));
  return matchSegments(segments, re, 0, { remaining: MAX_PAYLOAD_EVALUATIONS });
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
