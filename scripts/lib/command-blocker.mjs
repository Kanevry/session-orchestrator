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
      flush();
      if (command[i + 1] === '<' && command[i + 2] === '<') {
        tokens.push({ text: '<<<', quoted: false, redirect: { fd: null, mode: 'herestring' } });
        i += 2;
      } else if (command[i + 1] === '<') {
        tokens.push({ text: '<<', quoted: false, redirect: { fd: null, mode: 'heredoc' } });
        i += 1;
      } else {
        tokens.push({ text: '<', quoted: false, redirect: { fd: null, mode: 'read' } });
      }
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
 *   - `time` / `flock` / `setsid` / `ionice` — scope cut (#982, operator-approved).
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
  ['env', {
    argFlags: new Set(['-u', '--unset', '-C', '--chdir']),
    envAssignments: true,
    splitString: true,
  }],
  ['command', {}],
  ['nohup', {}],
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
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @returns {{ verb: string|null, index: number, payloads: string[] }}
 *   verb — bare program basename (or synthetic `sh` for `sudo -i`/`-s`), null
 *   when the segment exhausts in wrappers; index — token index of the resolved
 *   verb (-1 when null); payloads — command strings a wrapper will execute.
 */
export function resolveSegmentVerb(segment) {
  const payloads = [];
  let i = 0;
  // Skip leading FOO=bar env assignments (unquoted).
  while (i < segment.length && !segment[i].quoted && ENV_ASSIGN_RE.test(segment[i].text)) {
    i++;
  }
  while (i < segment.length) {
    const spec = WRAPPER_UNWRAP.get(segment[i].text.replace(/^.*\//, '')); // basename
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
      if (spec.argFlags && spec.argFlags.has(text)) { i += 2; continue; }
      i++; // unknown / boolean / attached-value flag — one token
    }
    for (let p = spec.positionals ?? 0; p > 0 && i < segment.length; p--) i++;
    if (sawShellFlag) return { verb: 'sh', index: i, payloads };
  }
  if (i >= segment.length) return { verb: null, index: -1, payloads };
  return { verb: segment[i].text.replace(/^.*\//, ''), index: i, payloads };
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
      if (tok.redirect.mode !== 'dup' && i + 1 < segment.length && !segment[i + 1].redirect) {
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

    if (depth < MAX_PAYLOAD_DEPTH) {
      const resolved = resolveSegmentVerb(segment);
      const payloads = [...resolved.payloads];
      if (resolved.verb && DASH_C_SHELLS.has(resolved.verb)) {
        payloads.push(...dashCPayloads(segment, resolved.index));
      }
      for (const payload of payloads) {
        if (budget.remaining <= 0) break;
        budget.remaining -= 1;
        const subTokens = tokenizeCommand(
          normalizeShellWhitespaceExpansions(payload, { expandSingleQuoted: true }),
        );
        collectRedirectTargets(splitSegments(subTokens), out, depth + 1, budget);
      }
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
 *
 * `dup` (`2>&1`), `heredoc` (`<<`), and `herestring` (`<<<`) redirects name
 * no filesystem target and are omitted (deliberate boundary, documented).
 *
 * @param {string} command
 * @returns {Array<{ target: string|null, mode: string, fd: number|null, unresolved?: boolean }>}
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
 * Match a `redirect-truncate` policy rule against a command (#983).
 *
 * For every extractRedirectTargets entry whose mode is in `rule.modes`
 * (default `['truncate']` — `truncate` covers `>`, `>|`, `&>`, and `N>`;
 * append `>>` stays allowed by design), the target is matched against the
 * rule's `target-denylist` globs (`**` / `*` / `?`). Targets are
 * POSIX-normalized before matching (`path.posix.normalize` collapses `.//`
 * and `sub/..` spellings — `> .//CLAUDE.md` and `> ./sub/../CLAUDE.md` (same
 * for the AGENTS.md alias) were silently ALLOWED pre-normalization, W4 F1a)
 * and a leading `./` is stripped;
 * no repo-root resolution happens here (pure function, no I/O — absolute and
 * `~` spellings are out of scope, see the follow-up issue).
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
 * @returns {boolean}
 */
export function redirectRuleMatches(rule, command) {
  if (!rule || typeof command !== 'string' || command.length === 0) return false;
  const denylist = Array.isArray(rule['target-denylist']) ? rule['target-denylist'] : [];
  if (denylist.length === 0) return false;
  const modes = new Set(Array.isArray(rule.modes) && rule.modes.length > 0 ? rule.modes : ['truncate']);
  const regexes = denylist.map(redirectGlobToRegExp);

  for (const entry of extractRedirectTargets(command)) {
    if (entry.unresolved) continue;
    if (!modes.has(entry.mode)) continue;
    const target = path.posix.normalize(entry.target).replace(/^(\.\/)+/, '');
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
