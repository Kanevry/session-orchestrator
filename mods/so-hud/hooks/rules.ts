// The pure half of the so-hud protection gates (#1551): reading a shell command, a tool's output
// and a peer's scope. Nothing here touches `$`, the engine or node:, so every rule runs inside the
// mod engine and is testable on its own. Ported from an internal mod; only its general rules are
// carried over.

import { scanHeredocs, type HeredocStage } from './heredoc-scan'

// ---- Reading a shell command ------------------------------------------------

// One part of a shell word: a double-quoted run, a single-quoted run, a backslash escape, plain text,
// or a quote that never closes (kept as written).
const WORD_PART = /"((?:[^"\\]|\\.)*)"|'([^']*)'|\\(.)|([^"'\\]+)|(["'\\])/gs

/** A shell word with its quotes and escapes removed, as the shell passes it on: `"HEAD:ma"in` is `HEAD:main`. */
function dequote(word: string): string {
  return word.replace(WORD_PART, (_m: string, dq?: string, sq?: string, esc?: string, plain?: string, lone?: string) =>
    dq !== undefined ? dq.replace(/\\(["\\$`])/g, '$1') : (sq ?? esc ?? plain ?? lone ?? ''))
}

/**
 * Splits one segment into shell words: each word is a run of `"…"`, `'…'` and unquoted characters
 * joined together, quotes and escapes removed. Good enough to read flags and paths.
 */
export function tokenize(text: string): string[] {
  return rawWords(text).map(dequote)
}

/** The shell words of a segment as written, quotes and escapes kept. */
function rawWords(text: string): string[] {
  return [...text.matchAll(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s"'\\]+|["'\\])+/gs)].map(m => m[0])
}

// An output redirection or descriptor copy as written: `2>&1`, `>/dev/null`, `&>>log`, `<&3`, or an
// operator alone (`>`, `2>`, `&>`) whose target is the next word. Input redirections (`< .env`) stay
// words: the file they name is read by the command.
const REDIRECT = /^(?:(?:\d+|&)?>[>|&]?|\d*<&)(.*)$/s
// An input redirection as written: `<file`, `0< in`, `<>file`, a here-string `<<<word`, a heredoc's
// `<<EOF` / `<<-EOF`. Only the outward reader drops them (`</dev/null git push` is `git push`); a
// trap still reads the file a command is fed (`cat < .env`).
const IN_REDIRECT = /^\d*(?:<<<|<<-?|<>|<)(.*)$/s

/**
 * The raw words without their output redirections — and, when `input`, their input redirections:
 * the shell removes them before the command sees its words, so `git 2>/dev/null push` is `git push`.
 * Checked before quote removal, so a quoted `">"` stays an argument; `>(…)` and `<(…)` (process
 * substitution) stay words too.
 */
function dropRedirections(raw: readonly string[], input: boolean): string[] {
  const out: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const word = raw[i] ?? ''
    const target = REDIRECT.exec(word)?.[1] ?? (input ? IN_REDIRECT.exec(word)?.[1] : undefined)
    if (target === undefined || target.startsWith('(')) out.push(word)
    else if (target === '') i += 1
  }
  return out
}

// Where a redirection or process substitution starts after its `<` or `>`, longest form first.
const REDIRECT_OP = /<<<|<<-?|<>|<&|<\(|<|>\(|>>|>&|>\||>/y
// The characters that end a redirection target unquoted in every shell; also where the next one may
// start. An unquoted `&` inside a target starts `&>` (a lone one already ended the segment): `x&>y`.
const TARGET_END = /[<>()&]/g
const ANGLE = /[<>]/g

/** The word with every quoted run and backslash escape blanked to `_`, same length: what is left is unquoted. */
function maskQuoted(word: string): string {
  return word.replace(WORD_PART, (m: string, _dq?: string, _sq?: string, _esc?: string, plain?: string) => (plain === undefined ? '_'.repeat(m.length) : m))
}

/**
 * Whether an output redirection writes nothing: `>`, `>>` or `&>` (any descriptor) onto exactly
 * `/dev/null`, or `>&` copying stdout or stderr onto the other. Every other form, target or descriptor
 * (`>&3`, `3>&1`, `&>>`, `<>`, `<&`, `>|`, a quoted or `$` target) counts as a write.
 */
function harmlessOutput(op: string, fd: string, target: string): boolean {
  if (op === '>' || op === '>>' || op === '&>') return target === '/dev/null'
  return op === '>&' && (fd === '' || fd === '1' || fd === '2') && (target === '1' || target === '2')
}

/**
 * Whether a segment carries an output redirection that may write a file (#1569, MR !133): `git log
 * --format=… >> .git/config` wrote the push configuration the facts never saw. Read quote-aware over the
 * same words as {@link readCommand}, also where the reader keeps the word (`--short>>.git/config`), so a
 * quoted `"a > b"` is no redirection. Input redirections (`<`, `N<`, `<<`, `<<<`) and process
 * substitutions (`<(…)`, `>(…)`, read by {@link gitInSubstitution}) write nothing here. One pass per word.
 */
function writesOutput(segment: string): boolean {
  // An operator whose target is the next word: `> .git/HEAD`. `in` skips that word, `out` judges it.
  let pending: { kind: 'in' | 'out'; op: string; fd: string } | null = null
  for (const word of rawWords(stripGroup(segment))) {
    const masked = maskQuoted(word)
    let at = 0
    // The target runs to the next unquoted `<`, `>`, `(`, `)` or `&`: `/dev/null)` closes a `$(…)`.
    const targetEnd = (from: number): number => {
      TARGET_END.lastIndex = from
      return TARGET_END.exec(masked)?.index ?? word.length
    }
    if (pending !== null) {
      at = targetEnd(0)
      if (pending.kind === 'out' && !harmlessOutput(pending.op, pending.fd, word.slice(0, at))) return true
      pending = null
    }
    for (;;) {
      ANGLE.lastIndex = at
      const angle = ANGLE.exec(masked)?.index
      if (angle === undefined) break
      REDIRECT_OP.lastIndex = angle
      let op = REDIRECT_OP.exec(masked)?.[0] ?? ''
      let opEnd = angle + op.length
      if (op === '<(' || op === '>(') {
        at = opEnd
        continue
      }
      // `&>` / `&>>`: the `&` belongs to the operator; otherwise the digits in front are its descriptor.
      let fd = ''
      if (op.startsWith('>') && masked[angle - 1] === '&') op = `&${op}`
      else {
        let start = angle
        while (start > at && /\d/.test(masked[start - 1] ?? '')) start -= 1
        fd = masked.slice(start, angle)
      }
      if (op === '&>' && masked[opEnd] === '>') {
        op = '&>>'
        opEnd += 1
      }
      const kind = op.startsWith('<') && op !== '<>' && op !== '<&' ? 'in' : 'out'
      if (opEnd >= word.length) {
        pending = { kind, op, fd }
        break
      }
      at = targetEnd(opEnd)
      if (kind === 'out' && !harmlessOutput(op, fd, word.slice(opEnd, at))) return true
    }
  }
  // An output operator with no target left (`git log >`, cut at a `|`): fail-closed.
  return pending?.kind === 'out'
}

/** The words of a segment as the command receives them: redirections dropped (input ones when `input`), quotes removed. */
function argWords(text: string, input = false): string[] {
  return dropRedirections(rawWords(text), input).map(dequote)
}

// Words that can come before the real command without changing what it does. `eval` with unquoted
// words runs exactly those words; its quoted form is read by {@link extractInner}. `if`, `while`,
// `until` and `elif` run their condition as a command, `then`, `do` and `else` their body.
const PREFIXES = new Set(['command', 'exec', 'nohup', 'time', 'if', 'elif', 'while', 'until', 'then', 'do', 'else', '!', 'eval'])

// The options of the transparent prefixes and runners that take a separate value.
const ENV_VALUED = new Set(['-u', '--unset'])
const SUDO_VALUED = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--other-user', '--command-timeout'])
const NICE_VALUED = new Set(['-n', '--adjustment'])
const TIMEOUT_VALUED = new Set(['-s', '--signal', '-k', '--kill-after'])
const RUNNER_VALUED = new Set(['-p', '--package'])
// caffeinate's -t <seconds> and -w <pid>, also as the last letter of a group (`-it 5`).
const CAFFEINATE_VALUED = /^-[a-z]*[tw]$/

// A variable assignment word: `NAME=value`, `NAME+=value`, and an array element `NAME[i]=value` (zsh: `HOME[1,-1]=x`
// rewrites HOME, #1571); group 1 is the name.
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/

/**
 * A segment without the `(`/`{` in front and the `)`/`}` behind it. Trimmed by hand: `\s*[)}]+$`
 * retried from every blank of a long run, quadratic on attacker-controlled length.
 */
function stripGroup(segment: string): string {
  const text = segment.trim().replace(/^[({]+\s*/, '')
  let end = text.length
  while (end > 0 && (text[end - 1] === ')' || text[end - 1] === '}')) end -= 1
  return end === text.length ? text : text.slice(0, end).trimEnd()
}

/**
 * The command a segment runs, read with an index (a `shift()` per word was quadratic: 535 ms for 50k
 * characters of `npx -y`): its words with redirections, leading `VAR=x`, `env -u X`, `sudo`, `nice`,
 * `timeout`, `caffeinate`, the prefixes above and a runner's own options removed, and the names those
 * leading assignments set. `input` also drops input redirections (the outward reader).
 */
function readCommand(segment: string, input: boolean): { words: string[]; assigned: string[] } {
  const words = argWords(stripGroup(segment), input)
  const assigned: string[] = []
  let i = 0
  // Skips options (and, for those `valued` names, their value) up to the first word that is none, or past `--`.
  // `env -u NAME` / `--unset=NAME` removes NAME for the command: recorded like an assignment (`env -u HOME git push`).
  const skipOptions = (valued: ReadonlySet<string> | RegExp, unsets = false): void => {
    while ((words[i] ?? '').startsWith('-')) {
      const option = words[i] ?? ''
      i += 1
      if (option === '--') break
      if (unsets && option.startsWith('--unset=')) assigned.push(option.slice('--unset='.length))
      else if (unsets && /^-u./.test(option)) assigned.push(option.slice(2))
      if (valued instanceof RegExp ? valued.test(option) : valued.has(option)) {
        if (unsets) assigned.push(words[i] ?? '')
        i += 1
      }
    }
  }
  for (;;) {
    const word = words[i]
    if (word === undefined) break
    const assignment = ASSIGNMENT.exec(word)
    if (assignment !== null || PREFIXES.has(word)) {
      if (assignment !== null) assigned.push(assignment[1] ?? '')
      i += 1
      continue
    }
    if (word === 'env' || word === 'sudo' || word === 'nice') {
      i += 1
      skipOptions(word === 'env' ? ENV_VALUED : word === 'sudo' ? SUDO_VALUED : NICE_VALUED, word === 'env')
      continue
    }
    if (word === 'timeout' || word === 'gtimeout') {
      i += 1
      skipOptions(TIMEOUT_VALUED)
      i += 1 // the duration
      continue
    }
    if (word === 'caffeinate') {
      i += 1
      skipOptions(CAFFEINATE_VALUED)
      continue
    }
    break
  }
  // npx vercel, npx --yes npm publish, pnpm dlx vercel, npm exec -- changeset: the tool is the next
  // word after the runner's own options.
  if (words[i] === 'npx' || words[i] === 'bunx') {
    i += 1
    skipOptions(RUNNER_VALUED)
  } else if ((words[i] === 'pnpm' && (words[i + 1] === 'dlx' || words[i + 1] === 'exec')) || (words[i] === 'npm' && (words[i + 1] === 'exec' || words[i + 1] === 'x'))) {
    i += 2
    skipOptions(RUNNER_VALUED)
  }
  return { words: words.slice(i), assigned }
}

/** The words of one segment, redirections, leading `VAR=x`, `env -u X`, `sudo`, `nice`, `timeout`, `caffeinate` and the prefixes above removed. */
export function commandWords(segment: string): string[] {
  return readCommand(segment, false).words
}

/** `\` + newline removed, as the shell does before it reads words: `git \<LF>push` is `git push`. */
function joinContinuations(command: string): string {
  return command.replace(/\\\r?\n/g, '')
}

// ---- What the shell never runs: comments and data heredocs (#1572, #1574) -----

// The characters after which an unquoted `#` starts a comment (the start of a word).
const WORD_BREAK = /[\s;&|()<>]/
// A heredoc operator and its delimiter: `<<EOF`, `<<-EOF`, `<< 'EOF'`, `<<"EOF"`, `<<\EOF`. Group 1 is `-`, groups
// 2 and 3 a single- or double-quoted delimiter, group 4 a backslash-quoted one, group 5 an unquoted one.
const HEREDOC_OP = /<<(-?)[ \t]*(?:(?:'([A-Za-z_][\w.-]*)'|"([A-Za-z_][\w.-]*)")|\\([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*))/y
// `$(cat <<'EOF'` up to the end of its line: a substitution whose only command is `cat` reading a heredoc with a quoted delimiter.
const CAT_HEREDOC = /\$\([ \t]*cat[ \t]+<<(-?)[ \t]*(?:'([A-Za-z_][\w.-]*)'|"([A-Za-z_][\w.-]*)")[ \t]*\n/y
// What may follow a heredoc operator on its own line for the body to stay data: words, `>`, `&&`, `||`, `;`, `&` and
// simple quotes — no `|` into another command, no second heredoc, no `$`, backtick or backslash.
const HEREDOC_REST = /^(?:[^'"`$\\|<\n]|'[^'\n]*'|"[^"\\$`\n]*"|\|\|)*$/
// A `${name}` that nests nothing; any other `${` stops the view like `$(`.
const PLAIN_BRACE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/y
// Heredocs whose closing line was not found before the view gives up (each miss reads to the end of the line).
const MAX_HEREDOC_MISSES = 4
// An `eval` word: what it is given is parsed again as shell code, so nothing quoted behind it is text.
const EVAL_WORD = /(?:^|[\s;&|(){}])eval(?=\s)/

/**
 * Whether the command a heredoc or `$(cat <<'EOF' …)` feeds treats it as text: `cat` printing it (no file
 * written), `git commit` (its message), or a forge's issue/merge-request/pull-request command (a body). Never a
 * shell, an interpreter, `gh api` (a GraphQL body) or anything else (#1574: `bash <<'EOF'` still runs its body).
 */
function readsAsText(words: readonly string[], writes: boolean): boolean {
  const [first, ...args] = words
  const cmd = baseName(first ?? '')
  if (cmd === 'cat') return !writes && args.every(arg => arg === '-')
  if (cmd === 'git') {
    const git = readGit(args, null)
    return git.sub === 'commit' && git.config.length === 0
  }
  return (cmd === 'gh' || cmd === 'glab') && (args[0] === 'issue' || args[0] === 'mr' || args[0] === 'pr')
}

/**
 * Whether the body of a heredoc with an unquoted delimiter runs nothing: no backtick, `$(`, `$((`, `$[` or `${…}` other
 * than `${name}` — a plain `$name` only expands. (A quoted delimiter keeps every body literal.)
 */
function inertBody(body: string): boolean {
  return !/`|\$[([]|\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/.test(body)
}

/** The index just past the closing line of a heredoc whose body starts at `from`, or -1 (`tabs`: `<<-`, leading tabs stripped). */
function heredocEnd(line: string, from: number, delimiter: string, tabs: boolean): number {
  let at = from
  while (at <= line.length) {
    const nl = line.indexOf('\n', at)
    const end = nl === -1 ? line.length : nl
    const text = line.slice(at, end)
    if ((tabs ? text.replace(/^\t+/, '') : text) === delimiter) return end
    if (nl === -1) return -1
    at = nl + 1
  }
  return -1
}

/**
 * The line as the shell runs it, for every reader below: each comment removed, and each heredoc that is only text
 * replaced by the word `<_` (an input redirection the readers drop), its body and closing line removed — so a commit
 * message, an issue body or a comment that mentions `git push` is no command, and `git commit -m "$(cat <<'EOF' …
 * EOF)"` (Claude Code's own recipe) is one git step, not a `cat` before the push (#1574). A heredoc is text only with
 * a quoted delimiter (or an unquoted one with an {@link inertBody}) and a reader per
 * {@link readsAsText}; `$(cat <<'EOF' … EOF)` only inside double quotes, its closing `)` right after the closing line.
 * Read with the quote tracking of {@link scanLine}: from the first newline inside a quote or construct that nests its
 * own quoting (`$(`, a backtick, `${…}` other than `${name}`, `$'`, `<(`, `>(`, a heredoc that is not text) the rest
 * is kept as written — over-reading only asks. A `#` starts a comment at the start of a word outside quotes: a push
 * between `# bash -c '` and `# '` runs (#1572 E1).
 */
function dataView(line: string): string {
  const out: string[] = []
  let quote: '"' | "'" | null = null
  let segStart = 0
  let misses = 0
  let copied = 0
  let consumerAt = -1
  let consumerText = false
  const flush = (to: number): void => {
    if (to > copied) out.push(line.slice(copied, to))
    copied = to
  }
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? ''
    if (quote === "'") {
      if (ch === "'") quote = null
      else if (ch === '\n') break
      continue
    }
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '\n' && quote !== null) break
    if (ch === '`') break
    if (ch === '$') {
      const next = line[i + 1]
      if (next === '{') {
        PLAIN_BRACE.lastIndex = i
        if (!PLAIN_BRACE.test(line)) break
        i = PLAIN_BRACE.lastIndex - 1
        continue
      }
      if (next === "'") break
      if (next !== '(') continue
      CAT_HEREDOC.lastIndex = i
      const cat = CAT_HEREDOC.exec(line)
      const delimiter = cat?.[2] ?? cat?.[3]
      if (cat === null || delimiter === undefined || quote !== '"' || misses >= MAX_HEREDOC_MISSES) break
      const end = heredocEnd(line, CAT_HEREDOC.lastIndex, delimiter, cat[1] === '-')
      const close = end === -1 ? null : /^\s*\)/.exec(line.slice(end, end + 64))
      if (close === null) {
        misses += 1
        break
      }
      // Judged once per segment: many substitutions in one quoted word would re-read its growing prefix (quadratic).
      if (consumerAt !== segStart) {
        const prefix = line.slice(segStart, i)
        const consumer = readCommand(prefix, true).words
        consumerAt = segStart
        // `eval git commit -m "$(cat …)"` parses the message again as shell code.
        consumerText = readsAsText(consumer, false) && baseName(consumer[0] ?? '') !== 'cat' && !EVAL_WORD.test(prefix)
      }
      if (!consumerText) break
      flush(i)
      out.push('_')
      copied = end + close[0].length
      i = copied - 1
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if ((ch === '<' || ch === '>') && line[i + 1] === '(') break
    else if (ch === '#' && (i === 0 || WORD_BREAK.test(line[i - 1] ?? ''))) {
      flush(i)
      const nl = line.indexOf('\n', i)
      copied = nl === -1 ? line.length : nl
      i = copied - 1
    } else if (ch === '<' && line[i + 1] === '<' && line[i + 2] === '<') i += 2
    else if (ch === '<' && line[i + 1] === '<') {
      HEREDOC_OP.lastIndex = i
      const op = HEREDOC_OP.exec(line)
      const delimiter = op?.[2] ?? op?.[3] ?? op?.[4] ?? op?.[5]
      if (op === null || delimiter === undefined || misses >= MAX_HEREDOC_MISSES) break
      const opEnd = HEREDOC_OP.lastIndex
      const nl = line.indexOf('\n', opEnd)
      const rest = line.slice(opEnd, nl === -1 ? line.length : nl)
      if (nl === -1 || !HEREDOC_REST.test(rest)) break
      const end = heredocEnd(line, nl + 1, delimiter, op[1] === '-')
      if (end === -1) {
        misses += 1
        break
      }
      const reader = `${line.slice(segStart, i)} ${rest}`
      const body = line.slice(nl + 1, end)
      const literal = op[5] === undefined || inertBody(body)
      if (!literal || !readsAsText(readCommand(reader, true).words, writesOutput(reader))) break
      flush(i)
      out.push(`<_${rest}`)
      copied = end
      i = end - 1
    } else if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '(' || ch === ')') segStart = i + 1
  }
  flush(line.length)
  return out.join('')
}

/**
 * One pass over a line. `marked` is the line with each background `&` turned into `;`, same length: a
 * lone `&` ends a command like `;` does (`true & git push`). Not `&&`, `&>`, `>&`, `<&` or `|&`, and
 * not after a backslash or inside quotes, where `&` is a character (`curl "…?a=1&b=2"`, a commit
 * message) — but only while the quote tracking is certain. It stops being certain (`doubt`) at the
 * first newline inside an open quote (a heredoc body or a multi-line string: which of the two, this
 * cannot tell, and resetting the quote there flipped parity on the next line, so `"msg<NL>x=1"; git
 * status & git switch main` hid the `&`) and at the first construct that nests its own quoting or is
 * no shell word: `$(`, `${`, `$'`, a backtick, `<(`, `>(`, `<<`. From there every lone `&` is cut,
 * quoted or not: over-reading finds more commands, never fewer.
 * `unsure[i]` is 1 where position `i` may sit inside a quote — or after doubt began, or after an
 * unquoted `(` or `{` (a group: a `cd` there may not reach what follows); `unsure[length]` is the state
 * at the end.
 */
function scanLine(line: string): { marked: string; unsure: Uint8Array } {
  const out: string[] = new Array<string>(line.length)
  const unsure = new Uint8Array(line.length + 1)
  let quote: string | null = null
  let doubt = false
  let group = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? ''
    const next = line[i + 1] ?? ''
    if (!doubt && ((ch === '$' && (next === '(' || next === '{' || next === "'")) || ch === '`' || ((ch === '<' || ch === '>') && next === '(') || (ch === '<' && next === '<') || (ch === '\n' && quote !== null))) doubt = true
    unsure[i] = doubt || group || quote !== null ? 1 : 0
    out[i] = ch
    if (ch === '&' && (quote === null || doubt) && !/[&<>|]/.test(line[i - 1] ?? '') && !/[&>]/.test(next)) out[i] = ';'
    else if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '\\') {
      i += 1
      if (i < line.length) {
        out[i] = line[i] ?? ''
        unsure[i] = unsure[i - 1] ?? 1
      }
    } else if (quote === '"') {
      if (ch === '"') quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '{') group = true
  }
  unsure[line.length] = doubt || group || quote !== null ? 1 : 0
  return { marked: out.join(''), unsure }
}

/** The line with each background `&` turned into `;` ({@link scanLine}). */
function markBackground(line: string): string {
  return scanLine(line).marked
}

// Where splitSegments cuts: `&&`, `||`, `|` and `|&`, `;`, newlines (a background `&` is a `;` by then).
const SEPARATOR = /&&|\|\||\|&?|;|\n/g

/** The command line cut at `&&`, `||`, `;`, `&`, `|`, `|&` and newlines. Quotes are honoured for `&` only: detection only. */
export function splitSegments(command: string): string[] {
  return markBackground(joinContinuations(command)).split(SEPARATOR)
}

// A separator as written; '' is the start or end of the line.
type Sep = '' | '&&' | '||' | '|' | '|&' | ';' | '\n' | '&'
// The separators that end an and-or list (`a && b || c`): what follows runs whatever the list returned.
const LIST_END: ReadonlySet<Sep> = new Set<Sep>([';', '\n', '&'])
const PIPE: ReadonlySet<Sep> = new Set<Sep>(['|', '|&'])

/**
 * A segment as {@link splitSegments} cuts it, with the separators around it. `sure`: at neither end can
 * it sit inside a quote, after doubt began, or inside a group ({@link scanLine}) — so it is a command
 * of its own in this shell, not a piece of a string a separator inside quotes cut out. `start`: its index in the line.
 */
type Seg = { text: string; before: Sep; after: Sep; sure: boolean; start: number }

function segmentsOf(command: string): Seg[] {
  const line = joinContinuations(command)
  const { marked, unsure } = scanLine(line)
  const segs: Seg[] = []
  let start = 0
  let before: Sep = ''
  const push = (end: number, after: Sep): void => {
    segs.push({ text: line.slice(start, end), before, after, sure: unsure[start] === 0 && unsure[end] === 0, start })
  }
  for (const m of marked.matchAll(SEPARATOR)) {
    const sep = (m[0] === ';' && line[m.index] === '&' ? '&' : m[0]) as Sep
    push(m.index, sep)
    start = m.index + m[0].length
    before = sep
  }
  push(line.length, '')
  return segs
}

/** The pipelines of a command line, each a list of its stages. */
export function splitPipelines(command: string): string[][] {
  return markBackground(joinContinuations(command)).split(/&&|\|\||;|\n/).map(pipeline => pipeline.split(/\|&?/))
}

// A quoted command line run by another shell (`bash -c "…"`, `sh -lc '…'`), by a runner's shell mode
// (`npx -c '…'`, `pnpm exec -c '…'`) or by `eval "…"`. Its separators sit inside quotes, which
// splitSegments does not honour, so it is cut out first and read as a command line of its own.
// The shell runs one word after `-c` (the rest become $0, $1, …); `eval` joins all its words. A word
// that starts with `-` (`bash -c -- "…"`) or a shell this cannot cut is left whole: {@link unreadableOutward} reads it.
const SHELL_WORD = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s"'\\;&|()<>]+)+`
const INNER_SOURCE = String.raw`(?<![\w./-])(?:(?:(?:bash|sh|zsh|dash|ksh)\s+(?:-[-\w]+\s+)*?-(?=[A-Za-z]*c)[A-Za-z]+|(?:npx|bunx|pnpm\s+(?:dlx|exec)|npm\s+(?:exec|x))\s+(?:-[-\w=]+\s+)*?(?:-c|--call|--shell-mode))\s+(?!-)(${SHELL_WORD})|eval((?:[ \t]+${SHELL_WORD})+))`
const INNER = new RegExp(INNER_SOURCE, 'g')
const INNER_AT = new RegExp(INNER_SOURCE, 'y')
const INNER_WORD = /^__SOHUD_INNER_(\d+)__$/
// Nesting deeper than this is read without cutting, so its words still split (and over-detect).
const MAX_DEPTH = 3

// `expanded`: the part of the inner line the OUTER shell expands before running it — all of an `eval`, and the
// double-quoted or bare parts of a `-c` word (a single-quoted `$x` is read by the child, which has no unexported x).
type Inner = { command: string; sameShell: boolean; expanded: string }

/** The line with each inner command line replaced by a placeholder word, and those command lines. */
function extractInner(line: string, depth: number): { text: string; inners: Inner[] } {
  const inners: Inner[] = []
  if (depth >= MAX_DEPTH) return { text: line, inners }
  const text = line.replace(INNER, (_match: string, shellWord?: string, evalWords?: string) => {
    if (shellWord !== undefined) {
      const expanded = shellWord.replace(/"(?:[^"\\]|\\.)*"|'[^']*'|\\./g, part => (part.startsWith("'") ? '' : part))
      inners.push({ command: dequote(shellWord), sameShell: false, expanded })
    } else {
      const command = tokenize(evalWords ?? '').join(' ')
      inners.push({ command, sameShell: true, expanded: command })
    }
    return ` __SOHUD_INNER_${inners.length - 1}__ `
  })
  return { text, inners }
}

/** The inner command line a segment runs, when its first word is a placeholder. */
function innerAt(word: string, inners: readonly Inner[]): Inner | null {
  const m = INNER_WORD.exec(word)
  return m ? (inners[Number(m[1])] ?? null) : null
}

function baseName(word: string): string {
  return word.replace(/^\\/, '').split('/').pop() ?? word
}

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir: string | null, arg: string | undefined): string {
  if (arg === undefined || arg === '~' || arg.startsWith('/') || arg.startsWith('~/')) {
    return arg ?? '~'
  }
  return dir ? `${dir}/${arg}` : arg
}

/** The positional arguments, skipping each option and, for the options in `valued`, its value. */
export function positionals(args: readonly string[], valued: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '--') {
      out.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (valued.has(arg)) i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

/** The value of `--name value`, `--name=value` or `-n value`, or undefined. */
export function optionValue(args: readonly string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    for (const name of names) {
      if (arg === name) return args[i + 1]
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
    }
  }
  return undefined
}

// ---- Actions with an effect outside this machine -----------------------------

export type OutwardKind = 'push' | 'merge' | 'publish' | 'deploy' | 'release'

export const KIND_LABEL: Record<OutwardKind, string> = {
  push: 'Push',
  merge: 'Merge',
  publish: 'Paket veröffentlichen',
  deploy: 'Produktiv-Deploy',
  release: 'Release',
}

export type Outward = {
  kind: OutwardKind
  /** The detected action. */
  label: string
  /** The command's own words after the subcommand. */
  args: string[]
  /**
   * Where a `cd` earlier on the line moved to; null means the session folder. A `cd`, `pushd` or
   * `popd` whose effect on this command is not certain — inside `( )`, `{ }` or quotes, in a pipeline
   * stage, after `||` or followed by one before the command, ending a background list, behind a
   * prefix (`if`, `then`, `command`, `VAR=x`), after `&&` in an earlier list, an option or `-`/`+N` —
   * makes it {@link UNKNOWN_DIR} (or a folder below it), which resolves to no folder, so the push asks.
   */
  dir: string | null
  /** For merges and releases: which forge CLI. */
  forge?: 'glab' | 'gh'
  /** For publishes and deploys: which tool. */
  tool?: string
  /**
   * For pushes: every git invocation earlier on the line as a step ({@link gitStep}), child shells and
   * command substitutions included: any of them may have moved what the facts measured. A git step run
   * in a folder other than {@link dir}, or in an unknown one, is recorded as `<step> [other folder]`: its
   * hooks and its configuration are not the ones {@link PushFacts.hooks} and {@link PushFacts.repoConfig}
   * measured (`git -C ../b diff` runs ../b's `diff.external`, #1573 review).
   */
  gitBefore?: string[]
  /**
   * For pushes: some earlier command on the line is not a git call — in this shell, a child shell or a
   * command substitution (`gh pr checkout 5 && …`, `./switch.sh; …`, `x=$(./x)`) — so it may have moved
   * HEAD or written the push configuration (`printf … >> .git/config`): every push form behind it asks.
   * `cd`/`pushd`/`popd` (read as {@link dir}) and a bare assignment (`x=1`) run no command and do not set it.
   * Also set by an earlier output redirection on any segment, git steps included ({@link writesOutput}):
   * `git log --format=… >> .git/config`, `cd . > .git/HEAD`, `exec 3>>.git/config`.
   */
  otherBefore?: true
  /**
   * For pushes: an earlier `git commit` on the line signs explicitly (`-S`, `-S<key>`, `--gpg-sign`, a short
   * option bundle holding `S`; the last of these and `--no-gpg-sign` wins), so it runs `gpg.program` whatever
   * `commit.gpgSign` says ({@link repoConfigStandard}). `tag -s` and `merge -S` are no local step.
   */
  signsBefore?: true
  /**
   * For pushes: git configuration the push runs with that the measured facts did not see — each
   * `-c` / `--config-env` entry as written (`key=value`), `--git-dir` / `--work-tree` / `--namespace`
   * as `--option=value`, every other global option as written, the names of `GIT_CONFIG*` /
   * `GIT_DIR`-style variables anywhere on the line, and the name of every variable assigned, exported,
   * declared or unset on the line (in front of the push or as a statement) that is not
   * {@link HARMLESS_VAR} (`HOME=x` moves the config git reads), plus `source`/`.`/`alias`/`hash` as written.
   */
  gitConfig?: string[]
  /** For pushes: the destination is not read from git's own words (an unreadable line, a forge API ref write): always asks. */
  opaque?: true
}

// stepDirs: the folder each git step of gitBefore ran in, by its index.
type WalkState = { dir: string | null; gitBefore: string[]; stepDirs: Map<number, string | null>; otherBefore: boolean; signs: boolean; gitEnv: Set<string> }

// Variables that route a push past what the facts measured: extra config, another repository.
const GIT_ENV = /(?<![\w])(GIT_(?:CONFIG\w*|DIR|WORK_TREE|NAMESPACE|COMMON_DIR))=/g

/**
 * The folder a push gets when a `cd` before it may or may not have run ({@link Outward.dir}): a path
 * below `/dev/null`, a device and never a directory, so `cd` into it (or into any folder below it)
 * fails on every system and the wiring resolves no folder — the push asks.
 */
export const UNKNOWN_DIR = '/dev/null/so-hud-unknown-folder'

/**
 * The variable names an assignment before a push may set without asking — an allowlist (#1569 M2a):
 * a single lowercase letter, or a name an agent's one-liner uses to hold a value. bash gives no
 * lowercase name a meaning; none of these is a zsh special parameter (zshparam(1), zsh/parameter —
 * `path`, `cdpath`, `commands`, `aliases` are, and stay out), and none is read by git, ssh or curl.
 * Also one or two uppercase characters (`D`, `WT`, `L1`, `TZ`): agents hold paths in them, and no
 * shell gives such a name a meaning (measured 2026-10-12: zsh 5.9 `${(k)parameters}`, 185 names, and
 * bash `compgen -v` hold none matching `^[A-Z][A-Z0-9]?$`); `TZ` only changes how times print. A later
 * `$D` after `cd` or in the push's own words is not read by the rules and asks on its own.
 * Everything else asks: `HOME`, `XDG_*`, `GIT_*`, `PATH`, `PREFIX`, `CDPATH`, `BASH_ENV` … change
 * which config git reads, which git runs, or where `cd` goes.
 */
const HARMLESS_VAR = /^(?:[a-z]|rc|out|msg|sha|ref|head|base|branch|res|ok|tmp|[A-Z][A-Z0-9]?)$/
// Statements that set or remove variables by name, and those that change how the shell finds a command.
const DECLARERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'let'])
// Builtins that set the variables they name without `=` (#1571): `read -r GIT_CONFIG_COUNT … <<< "…"`, `printf -v HOME`,
// `mapfile`/`readarray`, `getopts`, zsh `vared`. Every word that starts like a name counts (a prompt word too: that only asks).
const NAME_SETTERS = new Set(['read', 'printf', 'mapfile', 'readarray', 'getopts', 'vared'])
const SHELL_STATE = new Set(['source', '.', 'alias', 'hash'])

/**
 * Every action with an effect outside, one per segment: `git push origin feat && git push origin main`
 * holds two, and a skippable first one must not let the second run (review R1, gate-host). Command
 * lines run by `bash -c`, `sh -c`, `zsh -c`, `eval` and a runner's `-c` are read too, up to depth 3;
 * a line this cannot read adds one fail-closed hit from {@link unreadableOutward}.
 */
export function classifyAllOutward(command: string): Outward[] {
  const hits: Outward[] = []
  const line = dataView(joinContinuations(command))
  walkOutward(line, 0, { dir: null, gitBefore: [], stepDirs: new Map(), otherBefore: false, signs: false, gitEnv: new Set() }, hits)
  const kind = unreadKind(line) ?? unformedKind(line, 0)
  if (kind !== null) hits.push({ kind, label: UNREADABLE_LABEL, args: [], dir: null, opaque: true })
  return hits
}

// ---- The fail-closed fallback: an outward word no hit was formed for (#1570) ---

// Commands that never run what they are given: their words are data (`echo "… git push …"`, `grep -rn publish`).
// Not here: `sed` (GNU `e`), `awk` (`system()`), `find` (`-ok`), `xargs`, any shell or interpreter, and every
// command not listed — an allowlist, so a wrapper this does not know (`flock`, `stdbuf`, `doas`) is read as code.
const DATA_COMMANDS = new Set(['echo', 'printf', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'ls', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'less', 'more', 'file', 'stat', 'du', 'df', 'test', '[', '[[', ':', 'true', 'false', 'sleep', 'wait', 'date', 'pwd', 'which', 'type', 'whence', 'mkdir', 'touch', 'rm', 'rmdir', 'cp', 'mv', 'ln', 'chmod', 'basename', 'dirname', 'realpath', 'readlink', 'jq', 'yq', 'column', 'nl', 'fold', 'cd', 'pushd', 'popd', 'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'set', 'shift', 'return', 'exit', 'break', 'continue', 'ps', 'pgrep', 'pkill', 'kill', 'lsof'])
// Commands that read a pipe as data and never run it; a pipe into anything else (`| sh`, `| awk`, `| sed`) runs its input.
const PIPE_DATA = new Set(['cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'less', 'more', 'jq', 'yq', 'tee', 'column', 'nl', 'fold', 'diff', 'cmp', 'base64', 'shasum', 'sha256sum', 'md5', 'od', 'xxd', 'hexdump', 'strings'])
// The forge subcommands whose words are titles, bodies and filters; `merge`, `release create` and `api` writes are read as hits.
const FORGE_TEXT = new Set(['issue', 'mr', 'pr', 'api', 'label', 'search', 'browse', 'status', 'auth', 'config'])
const FORGE_READ_ACTIONS = new Set(['view', 'list', 'download', 'status', 'watch', 'trace', 'get', 'clone'])
// The tools whose outward subcommands the classifier knows exactly: a `--dry-run` of theirs, and any vercel call that is
// no production deploy, was read and judged.
const OUTWARD_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'cargo', 'changeset', 'vercel', 'supabase', 'fly', 'flyctl', 'railway'])
// Interpreters whose inline code (`node -e "…"`, `python3 - <<'EOF'`) reaches git only through a process API: without
// one of {@link SPAWN_API} on the line, their code is data to the fallback (an analysis script that mentions `git push`).
// Ceiling: a process API spelled so this does not match (`require('child' + '_process')`), or a module the code loads.
const GATED_INTERPRETERS = new Set(['node', 'deno', 'bun', 'tsx', 'python', 'python3', 'osascript', 'perl', 'ruby'])
// perl and ruby also run a backtick string, and a backtick is ordinary text to node (a template literal).
const BACKTICK_RUNNERS = new Set(['perl', 'ruby'])
const SPAWN_API = /\bsystem\s*\(|\bqx\b|\bpopen\b|\bOpen3\b|%x[({[]|child_process|\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|\bexeca\b|\$`|\bBun\.(?:spawn|\$)|\bDeno\.(?:run|Command)|\bzx\b|\bsubprocess\b|\bos\.(?:system|popen|exec|spawn|posix_spawn)|\bpty\b|\bplumbum\b|\bpexpect\b|do shell script/

// What a command word from a variable may hide behind it: an outward subcommand whose tool is unreadable (`${X}t push`).
const OUTWARD_SUBWORDS = new Set(['push', 'publish', 'merge', 'accept', 'deploy', 'promote', 'rollback', 'up', '--prod'])

// git subcommands that run a shell command given as an argument (`git rebase -x "…"`, `git submodule foreach '…'`): their
// words are code, not judged.
const GIT_RUNS_SHELL = new Set(['rebase', 'bisect', 'submodule', 'filter-branch', 'difftool', 'mergetool'])

/** Whether the classifier read this command and judged it, so its words need no second look ({@link unformedKind}). */
function judged(cmd: string, args: string[]): boolean {
  if (classifyWords(cmd, args, null) !== null || cmd === 'git-push') return true
  if (cmd === 'git') return !GIT_RUNS_SHELL.has(readGit(args, null).sub ?? '')
  if (cmd === 'gh' || cmd === 'glab' || /^glab-[a-z0-9-]+$/.test(cmd)) {
    return FORGE_TEXT.has(args[0] ?? '') || FORGE_READ_ACTIONS.has(args[1] ?? '')
  }
  if (!OUTWARD_TOOLS.has(cmd)) return false
  // `npm help publish`, `npm i publish-x`: a subcommand the publish reader rules out.
  const pm = (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') && PM_NOT_PUBLISHING.has(positionals(args, PM_VALUED)[0] ?? '')
  return cmd === 'vercel' || pm || isDryRun(args, PM_VALUED, false)
}

/** The segment with each inner command line put back where its placeholder stands. */
function withInners(text: string, inners: readonly Inner[]): string {
  return text.replace(/__SOHUD_INNER_(\d+)__/g, (m: string, n: string) => inners[Number(n)]?.command ?? m)
}

/**
 * The fail-closed fallback after the walker (#1570): the outward kind of the first segment that names an outward
 * action ({@link classKindIn}) but formed no hit and was not judged ({@link judged}); null when there is none. A
 * denylist of spellings does not converge (each review found new wrappers: `time -p`, `flock … bash -c`, `nohup --`,
 * `sh <<<'…'`, `python3 -c`, `case x in a|x)`), so this asks for every segment it cannot account for instead. Not read
 * as code: a segment whose command is in {@link DATA_COMMANDS} (unless its output is piped into a command outside
 * {@link PIPE_DATA}: `echo git push origin main | sh`), one with no command (`msg="deploy"`), and what {@link dataView}
 * removed. A placeholder of a cut-out `bash -c '…'` that is not the first word (`flock /tmp/l bash -c "…"`) counts
 * as code; a first-word one is read as its own line. Inline code of a {@link GATED_INTERPRETERS} interpreter counts
 * only on a line with a process API ({@link SPAWN_API}). A git subcommand from a variable (`git ${X}sh`) always asks,
 * a command word from one asks when its subcommand is an outward word ({@link OUTWARD_SUBWORDS}: `${X}t push`).
 */
function unformedKind(line: string, depth: number): OutwardKind | null {
  const { text, inners } = extractInner(line, depth)
  const joined = joinContinuations(text)
  const segs = segmentsOf(joined)
  const spawns = SPAWN_API.test(joined)
  const openers = quoteOpeners(joined, spawns)
  const words = segs.map(seg => readCommand(seg.text, true).words)
  // Per segment, the first segment from it on whose cut is outside every quote (or not followed): where its command ends.
  const realEnd = new Int32Array(segs.length)
  for (let j = segs.length - 1; j >= 0; j -= 1) {
    const cut = openers[(segs[j]?.start ?? 0) + (segs[j]?.text.length ?? 0)] ?? UNKNOWN_QUOTE
    realEnd[j] = cut < 0 || j === segs.length - 1 ? j : (realEnd[j + 1] ?? j)
  }
  // The segment holding index `at` (the last one starting at or before it).
  const segAt = (at: number): number => {
    let lo = 0
    let hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((segs[mid]?.start ?? 0) <= at) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  for (let k = 0; k < segs.length; k += 1) {
    const seg = segs[k]
    if (seg === undefined) continue
    const opener = openers[seg.start] ?? UNKNOWN_QUOTE
    if (opener === HEREDOC_DATA) continue
    // A segment cut out of a quoted word (a commit body's line, `-m "a; b"`) is that word's command's argument —
    // unless an `eval` parses that word again.
    const quotedIn = opener >= 0 ? segAt(opener) : k
    const owner = EVAL_WORD.test(segs[quotedIn]?.text ?? '') ? k : quotedIn
    const [first, ...args] = words[owner] ?? []
    if (first === undefined) continue
    const inner = innerAt(first, inners)
    if (inner !== null) {
      if (owner !== k) continue
      const kind = unformedKind(inner.command, depth + 1)
      if (kind !== null) return kind
      continue
    }
    const cmd = baseName(first)
    if (owner === k && cmd === 'git' && (readGit(args, null).sub ?? '').includes('$')) return 'push'
    if (judged(cmd, args)) continue
    // The command ends at the first cut outside its quotes: a `|` inside `grep -E "a|b"` is no pipe.
    const last = realEnd[owner] ?? owner
    const next = words[last + 1] ?? []
    const piped = PIPE.has(segs[last]?.after ?? '') && !PIPE_DATA.has(baseName(next[0] ?? '')) && !judged(baseName(next[0] ?? ''), next.slice(1))
    if (DATA_COMMANDS.has(cmd) && !piped) continue
    if (GATED_INTERPRETERS.has(cmd) && !spawns && !(BACKTICK_RUNNERS.has(cmd) && joined.includes('`'))) continue
    const code = withInners(seg.text, inners)
    const kind = classKindIn(code)
    if (kind !== null) return kind
    if (owner === k && first.includes('$') && args.slice(0, 2).some(word => OUTWARD_SUBWORDS.has(word))) return 'push'
  }
  return null
}

// A command that may run a file written earlier on the line, in command position (line start or after `;`, `&`, `|`,
// `(`, `{`, a newline, `then`/`do`): a shell or interpreter, `source`/`.`, `exec`, `xargs`, or a path like `./x`, `/tmp/x.sh`.
const RUNS_FILE = /(?:^|[;&|(){}\n]|\b(?:then|do|else)\s)\s*(?:sudo\s+|env\s+|nohup\s+|exec\s+)*(sh|bash|zsh|dash|ksh|fish|source|\.|python3?|node|deno|bun|tsx|perl|ruby|exec|xargs|\.{0,2}\/\S+)(?=[\s;&|()]|$)/g

/**
 * Whether a line may run a file it wrote ({@link RUNS_FILE}): a runner that is no {@link GATED_INTERPRETERS} one, or a
 * gated one on a line that can start a process (`spawns`) — `cat > x.mjs <<'EOF' … EOF; node x.mjs` with no process API
 * runs no git.
 */
function runsWrittenFile(line: string, spawns: boolean): boolean {
  for (const m of line.matchAll(RUNS_FILE)) {
    const runner = m[1] ?? ''
    if (spawns || !GATED_INTERPRETERS.has(runner) || (BACKTICK_RUNNERS.has(runner) && line.includes('`'))) return true
  }
  return false
}

// Values of {@link quoteOpeners} that are no index: outside every quote, not followed (after a construct that nests its
// own quoting), and inside the body of a heredoc read as text.
const NO_QUOTE = -1
const UNKNOWN_QUOTE = -2
const HEREDOC_DATA = -3

/**
 * Per index of `line`: where the quote it sits inside opened, {@link NO_QUOTE}, {@link HEREDOC_DATA} inside the body of
 * a heredoc with a literal body that `cat` or `tee` reads (also into a file, on a line that runs no file
 * ({@link runsWrittenFile}): the walker still reads those lines, this only keeps the fallback from asking for them) or a
 * {@link GATED_INTERPRETERS} one does on a line without `spawns`,
 * or {@link UNKNOWN_QUOTE} from the first construct whose quoting this does not follow (a backtick, `${…}` other than
 * `${name}`, `$'`, `<(`, `>(`, any other heredoc). Quotes are followed
 * across newlines (a multi-line commit message is one word) and into `$(…)`, whose body starts unquoted and whose `)`
 * restores the quote around it; a `case` or a comment inside it stops the tracking (their `)` would end it early). Every
 * `$(…)` body is read by {@link unreadRegions} as well. One pass.
 */
function quoteOpeners(line: string, spawns: boolean): Int32Array {
  const owner = new Int32Array(line.length + 1).fill(UNKNOWN_QUOTE)
  let quote: '"' | "'" | null = null
  let opened = NO_QUOTE
  let segStart = 0
  // One frame per open `$(`: the quote around it, and the plain `(` opened inside it, so its `)` is found.
  const frames: { quote: '"' | "'" | null; opened: number; parens: number }[] = []
  let i = 0
  const here = (): number => (quote === null ? NO_QUOTE : opened)
  for (; i < line.length; i += 1) {
    const ch = line[i] ?? ''
    owner[i] = here()
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (ch === '\\') {
      i += 1
      if (i < line.length) owner[i] = here()
      continue
    }
    if (ch === '`') break
    if (ch === '$') {
      const next = line[i + 1]
      if (next === "'") break
      if (next === '(') {
        frames.push({ quote, opened, parens: 0 })
        quote = null
        owner[i + 1] = NO_QUOTE
        i += 1
        segStart = i + 1
      } else if (next === '{') {
        PLAIN_BRACE.lastIndex = i
        if (!PLAIN_BRACE.test(line)) break
      }
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      continue
    }
    const frame = frames.at(-1)
    // Inside `$(…)` a `case` pattern's `)` or a comment's `)` would end the frame early and shift the quotes after it.
    if (frame !== undefined && (i === 0 || WORD_BREAK.test(line[i - 1] ?? '')) && (ch === '#' || /^case(?=[\s;&|()<>]|$)/.test(line.slice(i, i + 5)))) break
    if (ch === '"' || ch === "'") {
      quote = ch
      opened = i
    } else if ((ch === '<' || ch === '>') && line[i + 1] === '(') break
    else if (ch === '(' && frame !== undefined) frame.parens += 1
    else if (ch === ')' && frame !== undefined && frame.parens > 0) frame.parens -= 1
    else if (ch === ')' && frame !== undefined) {
      frames.pop()
      quote = frame.quote
      opened = frame.opened
      owner[i] = here()
    } else if (ch === '<' && line[i + 1] === '<' && line[i + 2] === '<') {
      owner[i + 1] = NO_QUOTE
      owner[i + 2] = NO_QUOTE
      i += 2
    } else if (ch === '<' && line[i + 1] === '<') {
      HEREDOC_OP.lastIndex = i
      const op = HEREDOC_OP.exec(line)
      const delimiter = op?.[2] ?? op?.[3] ?? op?.[4] ?? op?.[5]
      const nl = line.indexOf('\n', HEREDOC_OP.lastIndex)
      if (op === null || delimiter === undefined || nl === -1) break
      const rest = line.slice(HEREDOC_OP.lastIndex, nl)
      const end = HEREDOC_REST.test(rest) ? heredocEnd(line, nl + 1, delimiter, op[1] === '-') : -1
      if (end === -1) break
      const readerText = `${line.slice(segStart, i)} ${rest}`
      const reader = readCommand(readerText, true).words
      const tool = baseName(reader[0] ?? '')
      const literal = op[5] === undefined || inertBody(line.slice(nl + 1, end))
      // A body `cat`/`tee` writes to a file is code when the line may run a file (`cat > f <<'EOF' … EOF; sh f`).
      const written = (tool === 'cat' || tool === 'tee') && !runsWrittenFile(line, spawns)
      if (!literal || !(written || readsAsText(reader, writesOutput(readerText)) || (GATED_INTERPRETERS.has(tool) && !spawns && !(BACKTICK_RUNNERS.has(tool) && line.includes('`'))))) break
      owner.fill(NO_QUOTE, i, nl + 1)
      owner.fill(HEREDOC_DATA, nl + 1, end)
      i = end - 1
    } else if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '(' || ch === ')') segStart = i + 1
  }
  if (i >= line.length) owner[line.length] = here()
  return owner
}

// ---- Shapes this parser does not read (fail-closed) --------------------------

const UNREADABLE_LABEL = 'nicht lesbare Befehlsform'

// Constructs whose effect the word reader above cannot see. Each is judged on the segment it sits in.
const UNREAD_CONSTRUCTS = [
  /\bxargs\b/g,
  /\bssh\s/g,
  /\bwatch\s/g,
  // The lookbehind anchors the name at a word start: without it the engine retries from every
  // character of a long word, quadratic (1524 ms on 50k chars, Lead review of !132).
  /(?<![\w.-])[\w.-]+\s*\(\)\s*\{/g,
  /\bfunction\s+[\w.-]+/g,
  /\/(?:bash|sh|zsh|dash|ksh|env)(?=\s)/g,
  /\$'/g,
  /\balias\./gi,
]
// Constructs of a head and a later tail in the same run (no `;`, `&`, `|` or newline between):
// `find … -exec`, `env … -S`, `case … in`. Matched as two linear scans ({@link headsWithTail}): as one
// regex `head[^\n;&|]*tail` each head re-scanned the run to its end, quadratic (`env -i` ×N).
const UNREAD_PAIRS: readonly (readonly [head: RegExp, tail: RegExp])[] = [
  [/\bfind\b/g, /\s-exec(?:dir)?\b/g],
  [/\benv\b/g, /\s(?:-[A-Za-z]*S|--split-string)/g],
  [/\bcase\b/g, /\bin\b/g],
]
// A shell given a command with -c — a shell name followed by whitespace, and later in the same run
// without `;`, `&` or `|` a word of letters holding `c` (`-c`, `-lc`) — unreadable when INNER cannot
// cut it at the same place. Matched as two linear scans ({@link shellCStarts}): as one regex with a
// lazy word run it retried from every shell name to the run's end, 680 ms for 10k `bash ` words.
const SHELL_NAME = /(?<![\w./-])(?:bash|sh|zsh|dash|ksh)(?=\s)/g
// `-(?=[A-Za-z]*c)[A-Za-z]+` is `-[A-Za-z]*c[A-Za-z]*` without its quadratic backtracking on a long word.
const C_OPTION = /\s-(?=[A-Za-z]*c)[A-Za-z]+(?=\s|$)/g

/** The `[start, end)` of each run of the line between the characters `cut` matches. */
function runsOf(line: string, cut: RegExp): Span[] {
  const runs: Span[] = []
  let start = 0
  for (const m of line.matchAll(cut)) {
    runs.push([start, m.index])
    start = m.index + 1
  }
  runs.push([start, line.length])
  return runs
}

/** The start of each `head` match with a `tail` match starting at or after its end in the same run: two linear scans. */
function headsWithTail(line: string, runs: readonly Span[], head: RegExp, tail: RegExp): number[] {
  const lastTail = new Map<number, number>()
  for (const m of line.matchAll(tail)) lastTail.set(spanIndexAt(runs, m.index), m.index)
  const starts: number[] = []
  for (const m of line.matchAll(head)) {
    const t = lastTail.get(spanIndexAt(runs, m.index))
    if (t !== undefined && t >= m.index + m[0].length) starts.push(m.index)
  }
  return starts
}

/** Where a shell is given `-c`: a SHELL_NAME with a C_OPTION after it and no `;`, `&` or `|` between. */
function shellCStarts(line: string): number[] {
  return headsWithTail(line, runsOf(line, /[;&|]/g), SHELL_NAME, C_OPTION)
}

type Span = [start: number, end: number]

/** The `[start, end)` of every segment of the line, cut at the separators splitSegments cuts at, in order. */
function segmentSpans(line: string): Span[] {
  const spans: Span[] = []
  let start = 0
  for (const m of markBackground(line).matchAll(SEPARATOR)) {
    spans.push([start, m.index])
    start = m.index + m[0].length
  }
  spans.push([start, line.length])
  return spans
}

/** The index in `spans` of the segment holding `index` (binary search: the last segment starting at or before it). */
function spanIndexAt(spans: readonly Span[], index: number): number {
  let lo = 0
  let hi = spans.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((spans[mid]?.[0] ?? 0) <= index) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The `[start, end)` body of every `$(…)` (parentheses balanced, quotes not honoured) and after every
 * backtick (to the next one), each to the end of the line when unclosed. One pass with a stack, so a
 * line of 25,000 unclosed `$(` costs no more than one of plain words.
 */
function substitutionSpans(line: string): Span[] {
  const spans: Span[] = []
  // Per open parenthesis: the index in `spans` of the `$(` it opened, or -1 for a plain `(`.
  const open: number[] = []
  let lastTick = -1
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '$' && line[i + 1] === '(') {
      open.push(spans.push([i + 2, line.length]) - 1)
      i += 1
    } else if (ch === '(') open.push(-1)
    else if (ch === ')') {
      const k = open.pop()
      const span = k === undefined || k === -1 ? undefined : spans[k]
      if (span !== undefined) span[1] = i
    } else if (ch === '`') {
      const prev = lastTick === -1 ? undefined : spans[lastTick]
      if (prev !== undefined) prev[1] = i
      lastTick = spans.push([i + 1, line.length]) - 1
    }
  }
  return spans
}

/** The spans merged where they overlap or touch, sorted. */
function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = []
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** The text with `$'…'` escapes decoded and every quote and backslash dropped, so `pu"sh"` and `$'\x70ush'` read as `push`. */
function normalizeWords(text: string): string {
  return text
    .replace(/\$'((?:[^'\\]|\\.)*)'/g, (_m: string, body: string) =>
      body.replace(/\\x([0-9a-fA-F]{1,2})|\\u([0-9a-fA-F]{1,4})|\\([0-7]{1,3})|\\(.)/g, (_e: string, hex?: string, uni?: string, oct?: string, ch?: string) =>
        hex !== undefined ? String.fromCharCode(parseInt(hex, 16)) : uni !== undefined ? String.fromCharCode(parseInt(uni, 16)) : oct !== undefined ? String.fromCharCode(parseInt(oct, 8)) : (ch ?? '')))
    .replace(/["'\\]/g, '')
}

/** The outward kind a piece of unread text names, or null — wide on purpose: any `deploy` or `publish`, any forge `merge`/`release`. */
function outwardWordIn(text: string): OutwardKind | null {
  const t = normalizeWords(text)
  const forge = /\b(?:gh|glab)\b/.test(t)
  if (/\bgit\b/.test(t) && /\bpush\b/.test(t)) return 'push'
  if (/\bpublish\b/.test(t)) return 'publish'
  if (forge && /\b(?:merge|accept)\b/.test(t)) return 'merge'
  if (/\bdeploy\b/.test(t) || /--prod(?:uction)?\b/.test(t)) return 'deploy'
  if (forge && /\brelease\b/.test(t)) return 'release'
  return classKindIn(text)
}

// The words of unread text, split at blanks and at shell and code punctuation: `os.system(git push)` gives `git`, `push`;
// `args.push(x)` stays one word, so a JS `.push(` next to a `git` word is no push.
const CODE_WORD = /[^\s()[\]{}<>;|&,`]+/g
// git's global options that take the next word as their value (`git -C dir push`).
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--attr-source'])
const FORGE_VALUED = new Set(['-R', '--repo'])
const NONE_VALUED: ReadonlySet<string> = new Set()

/**
 * The outward kind of the first action the classifier holds ({@link classifyWords}) that a piece of unread text spells
 * as a tool word with its action word in subcommand position, options skipped — or null. `git [options] push`,
 * `git-push`; `gh|glab [options] mr|pr merge|accept`, `… release create`, `… api` with a method or field and a ref, branch or
 * merge path; npm/pnpm/yarn/changeset/cargo with a later `publish` word; vercel/vc with `--prod`, `--production`,
 * `promote` or `rollback`; `supabase db push`, `supabase db reset … --linked`, `supabase migration up … --linked`;
 * `fly deploy`; `railway up` (#1572 E3/E4). A piece holding `--dry-run` names no publish or supabase write. Linear: one
 * pass over the words, a later word looked up by its last index.
 */
function classKindIn(text: string): OutwardKind | null {
  const plain = normalizeWords(text)
  const words = plain.match(CODE_WORD) ?? []
  const last = new Map<string, number>()
  words.forEach((word, i) => last.set(word, i))
  const later = (i: number, ...names: string[]): boolean => names.some(name => (last.get(name) ?? -1) > i)
  const dry = last.has('--dry-run')
  // Judged for the whole piece, once: a slice per `api` word was quadratic on `gh api gh api …`.
  // An API call writes only with a method or a field (`gh api repos/o/r/git/refs/heads/main` alone reads).
  const apiWrites = /(?:^|\s)(?:-X\s*|--method[=\s]+)(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-[fF]|--(?:raw-)?field|--input)(?:[=\s]|\S)/i.test(plain)
  const refWrite = apiWrites && /refs\/heads\/|\bbranch=/.test(plain)
  const mergePath = apiWrites && /\/merges?\b/.test(plain)
  // The index of the first word from `j` that is no option (a valued option skips its value too).
  const skip = (j: number, valued: ReadonlySet<string>): number => {
    let k = j
    while ((words[k] ?? '').startsWith('-')) k += valued.has(words[k] ?? '') ? 2 : 1
    return k
  }
  for (let i = 0; i < words.length; i += 1) {
    const tool = baseName(words[i] ?? '')
    if (tool === 'git-push') return 'push'
    if (tool === 'git' && words[skip(i + 1, GIT_VALUED)] === 'push') return 'push'
    if (tool === 'gh' || tool === 'glab') {
      const j = skip(i + 1, FORGE_VALUED)
      const [sub, action] = [words[j], words[j + 1]]
      if ((sub === 'mr' || sub === 'pr') && (action === 'merge' || action === 'accept')) return 'merge'
      if (sub === 'release' && action === 'create') return 'release'
      if (sub === 'api' && refWrite) return 'push'
      if (sub === 'api' && mergePath) return 'merge'
    }
    if (['npm', 'pnpm', 'yarn', 'changeset', 'cargo'].includes(tool) && later(i, 'publish') && !dry) return 'publish'
    if ((tool === 'vercel' || tool === 'vc') && later(i, '--prod', '--production', 'promote', 'rollback')) return 'deploy'
    if (tool === 'supabase' && !dry) {
      const j = skip(i + 1, NONE_VALUED)
      const [sub, action] = [words[j], words[j + 1]]
      if (sub === 'db' && (action === 'push' || (action === 'reset' && later(j, '--linked')))) return 'deploy'
      if (sub === 'migration' && action === 'up' && later(j, '--linked')) return 'deploy'
    }
    if ((tool === 'fly' || tool === 'flyctl') && words[skip(i + 1, NONE_VALUED)] === 'deploy') return 'deploy'
    if (tool === 'railway' && words[skip(i + 1, NONE_VALUED)] === 'up') return 'deploy'
  }
  return null
}

/**
 * The pieces of a line this parser does not read: each construct's segment, a substitution's segment
 * joined with its body, and the whole line for a `$var` command. Each segment is read once however
 * many constructs it holds, and a substitution's segment and body, with every span overlapping them,
 * form one contiguous piece — a superset of reading each pair on its own, in linear time (a construct
 * per match over the whole line was quadratic: 317 ms at 8k characters of `$(`, about 12 s at 50k).
 */
function unreadRegions(line: string): string[] {
  const regions: string[] = []
  const segments = segmentSpans(line)
  const constructSegments = new Set<number>()
  for (const re of UNREAD_CONSTRUCTS) for (const m of line.matchAll(re)) constructSegments.add(spanIndexAt(segments, m.index))
  const runs = runsOf(line, /[\n;&|]/g)
  for (const [head, tail] of UNREAD_PAIRS) for (const at of headsWithTail(line, runs, head, tail)) constructSegments.add(spanIndexAt(segments, at))
  for (const at of shellCStarts(line)) {
    INNER_AT.lastIndex = at
    if (!INNER_AT.test(line)) constructSegments.add(spanIndexAt(segments, at))
  }
  for (const k of constructSegments) {
    const span = segments[k]
    if (span !== undefined) regions.push(line.slice(...span))
  }
  const bodies = substitutionSpans(line)
  const owners = new Set<number>()
  for (const [start] of bodies) owners.add(spanIndexAt(segments, start - 1))
  const pieces = [...bodies]
  for (const k of owners) {
    const span = segments[k]
    if (span !== undefined) pieces.push(span)
  }
  for (const [start, end] of mergeSpans(pieces)) regions.push(line.slice(start, end))
  // `p=push; git $p origin main`: a command or git subcommand from a variable is set anywhere on the
  // line, so the whole line is read — once (once per such segment re-read the line, quadratic).
  const expanded = (word: string | undefined) => word !== undefined && word.includes('$') && !word.startsWith('$(')
  for (const segment of splitSegments(line)) {
    const [first, ...args] = readCommand(segment, true).words
    if (expanded(first) || (baseName(first ?? '') === 'git' && expanded(readGit(args, null).sub))) {
      regions.push(line)
      break
    }
  }
  return regions
}

/**
 * One fail-closed hit for a line holding a construct this parser does not read (`$(…)`, a backtick,
 * `xargs`, `find -exec`, `ssh`, `env -S`, `watch`, a function, `case`, a shell by path or one `-c`
 * cannot be cut from, `$'…'`, a git alias, a command from a variable) whose unread part names an
 * outward action; null otherwise. Its push always asks ({@link Outward.opaque}).
 */
export function unreadableOutward(command: string): Outward | null {
  const kind = unreadKind(dataView(joinContinuations(command)))
  return kind === null ? null : { kind, label: UNREADABLE_LABEL, args: [], dir: null, opaque: true }
}

/** The outward kind the first unread region of a line ({@link unreadRegions}, after {@link dataView}) names, or null. */
function unreadKind(line: string): OutwardKind | null {
  for (const region of unreadRegions(line)) {
    const kind = outwardWordIn(region)
    if (kind !== null) return kind
  }
  return null
}

function walkOutward(line: string, depth: number, state: WalkState, hits: Outward[]): void {
  const { text, inners } = extractInner(line, depth)
  for (const m of text.matchAll(GIT_ENV)) if (m[1] !== undefined) state.gitEnv.add(m[1])
  walkSegments(text, inners, depth, state, hits)
}

// Where a command substitution or process substitution opens: it runs before its segment's command.
const SUBSTITUTION_OPEN = /\$\(|[<>]\(|`/

/**
 * The git calls inside a segment's `$(…)`, backticks, `<(…)` or `>(…)` count as earlier git calls:
 * `echo $(git switch main) && git push` moves HEAD before the push runs. Read from the first opener to
 * the segment's end (over-reading only adds steps, which asks). Its pushes are not collected — the
 * line is held as unreadable for them ({@link unreadableOutward}) — and its `cd` ends with the
 * subshell. Past {@link MAX_DEPTH} any git word left counts as a step that is not local, and any
 * text left as an earlier command that is not git ({@link Outward.otherBefore}).
 */
function gitInSubstitution(segment: string, inners: readonly Inner[], depth: number, state: WalkState): void {
  const at = segment.search(SUBSTITUTION_OPEN)
  if (at === -1) return
  const body = segment.slice(at + (segment[at] === '`' ? 1 : 2))
  if (depth + 1 >= MAX_DEPTH) {
    if (/\bgit\b|__SOHUD_INNER_/.test(body)) state.gitBefore.push('$(…)')
    if (/\S/.test(body)) state.otherBefore = true
    return
  }
  const dir = state.dir
  walkSegments(body, inners, depth + 1, state, [])
  state.dir = dir
}

// The options of `git log`, `show` and `diff` that only choose what is printed — an allowlist (MR !133
// HOCH 1): `--output` writes a file (`.git/HEAD`, `.git/config`), `--ext-diff` and `--textconv` run a
// configured program, and an option git adds later is not here either. git takes none of these
// commands' long options abbreviated (measured, git 2.56.0: `git show --outp=x` is refused).
const DISPLAY_OPTIONS = new Set(['--oneline', '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--summary', '--cached', '--staged', '--no-color', '--decorate', '--graph', '--abbrev-commit', '-s', '--no-patch', '-p', '-u', '--patch', '-q', '--quiet', '--', '--no-ext-diff', '--no-textconv'])
// …and these, with any value in the same word: a count (`-3`, `-n3`), `--format=`, `--pretty=`, `--color=`, `--max-count=`.
const DISPLAY_VALUED = /^(?:-n?\d+$|--(?:format|pretty|color|max-count)=)/

/**
 * How an earlier git call is recorded for {@link LOCAL_GIT}: its subcommand, with three exact
 * read-only forms spelled out — `branch --show-current`; `tag --list` for `tag -l` or `tag --list`
 * with no other word (a pattern or option is not needed for the everyday form, so none is admitted);
 * and `checkout -- <paths>` for `checkout` whose first word is `--` with at least one path after it
 * (it restores files and cannot switch the branch; `checkout main -- f` and a bare `checkout --` stay
 * `checkout`). `fetch` is the local step only with plain words (no option — `--upload-pack`, also as
 * `--upload=`, runs a program, `--set-upstream` moves the upstream — and no `ext::`-style URL, whose
 * transport runs a command where `protocol.ext.allow` permits it); `log`, `show` and `diff` only with every option in {@link DISPLAY_OPTIONS}
 * or {@link DISPLAY_VALUED} (a value given as its own word, `--output x`, is caught by its option). Any
 * other form is recorded as `<sub> [options]`, which is not local.
 */
/**
 * Whether a `git commit` with these words signs explicitly: the last of `-S`/`-S<key>`/`--gpg-sign[=<key>]`/a short
 * bundle holding `S` (`-aS`), or `--no-gpg-sign`, before `--`. Over-reads a bundle whose `S` is a value (`-mS`):
 * that only asks, and only where a `gpg.program` is set.
 */
function signsCommit(rest: readonly string[]): boolean {
  let signs = false
  for (const word of rest) {
    if (word === '--') break
    if (word === '--gpg-sign' || word.startsWith('--gpg-sign=') || (/^-[^-]/.test(word) && word.includes('S'))) signs = true
    else if (word === '--no-gpg-sign') signs = false
  }
  return signs
}

// `git commit` options that open no editor, run no pager or diff filter and read no patch interactively — an allowlist
// (#1573 input), matched as whole words; the `=`-forms of the valued ones are taken too. Not here: `-e`/`--edit`,
// `-c`/`--reedit-message`, `-t`/`--template`, `-p`/`--patch`/`--interactive`, `--squash`, `--fixup=amend:`/`reword:`.
const COMMIT_FLAGS = new Set(['-a', '--all', '-q', '--quiet', '-s', '--signoff', '--no-signoff', '-n', '--no-verify', '--verify', '--allow-empty', '--allow-empty-message', '--amend', '--no-edit', '-o', '--only', '-i', '--include', '-v', '--verbose', '--no-verbose', '--status', '--no-status', '--dry-run', '--short', '--porcelain', '--long', '--branch', '-z', '--null', '--reset-author', '--no-post-rewrite', '-S', '--gpg-sign', '--no-gpg-sign', '--untracked-files'])
const COMMIT_VALUED = new Set(['-m', '--message', '-F', '--file', '-C', '--reuse-message', '--author', '--date', '--cleanup', '--trailer', '--fixup'])
// The message options: with one of them (or `--amend --no-edit`, or a dry run) commit opens no editor.
const COMMIT_MESSAGE = new Set(['-m', '--message', '-F', '--file', '-C', '--reuse-message', '--fixup'])
// The short options of a bundle (`-am`, `-sm"msg"`): flags, then one that takes the rest of the word or the next word.
const COMMIT_SHORT_FLAGS = 'aqsnoivz'
const COMMIT_SHORT_VALUED = 'mFCSu'
// `git add` options that only choose what is staged; `-p`, `-i`, `-e`, `--renormalize` and the rest ask.
const ADD_FLAGS = new Set(['-A', '--all', '--no-all', '-u', '--update', '-f', '--force', '-v', '--verbose', '-n', '--dry-run', '-N', '--intent-to-add', '--ignore-errors', '--ignore-missing', '--ignore-removal', '--no-ignore-removal', '--sparse', '--refresh', '--chmod=+x', '--chmod=-x'])
const ADD_SHORT = 'AufvnN'

/** Whether a `git commit` runs neither an editor nor an interactive patch read: every option allowed, a message given. */
function plainCommit(rest: readonly string[]): boolean {
  const seen = new Set<string>()
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i] ?? ''
    if (word === '--') break
    if (!word.startsWith('-') || word === '-') continue
    const long = word.startsWith('--') ? word.split('=')[0] ?? word : null
    if (long !== null) {
      if (long === '--fixup' && /^--fixup=(?:amend|reword):/.test(word)) return false
      if (COMMIT_FLAGS.has(word) || ((long === '--untracked-files' || long === '--gpg-sign') && word.includes('='))) seen.add(long)
      else if (COMMIT_VALUED.has(long)) {
        seen.add(long)
        if (!word.includes('=')) i += 1
      } else return false
      continue
    }
    // A short option or bundle: `-a`, `-am`, `-mmsg`, `-S`, `-Skey`, `-uno`.
    for (let k = 1; k < word.length; k += 1) {
      const letter = word[k] ?? ''
      if (COMMIT_SHORT_FLAGS.includes(letter)) seen.add(`-${letter}`)
      else if (COMMIT_SHORT_VALUED.includes(letter)) {
        seen.add(`-${letter}`)
        // -S and -u take their value only in the same word; -m, -F, -C take the rest of it or the next word.
        if (k === word.length - 1 && 'mFC'.includes(letter)) i += 1
        break
      } else return false
    }
  }
  const message = [...seen].some(option => COMMIT_MESSAGE.has(option))
  return message || (seen.has('--amend') && seen.has('--no-edit')) || ['--dry-run', '--short', '--porcelain'].some(option => seen.has(option))
}

/** Whether a `git add` only stages: every option in {@link ADD_FLAGS} or a short bundle of {@link ADD_SHORT}. */
function plainAdd(rest: readonly string[]): boolean {
  for (const word of rest) {
    if (word === '--') break
    if (!word.startsWith('-') || word === '-') continue
    if (!ADD_FLAGS.has(word) && !(/^-[^-]+$/.test(word) && [...word.slice(1)].every(letter => ADD_SHORT.includes(letter)))) return false
  }
  return true
}

// `--format=`/`--pretty=` placeholders that verify a signature (`%G?`, `%GG`, `%GS`, `%GK`, `%GF`, `%GP`, `%GT`): they run gpg.program.
const SIGNATURE_FORMAT = /^--(?:format|pretty)=.*%G/

function gitStep(sub: string | undefined, rest: readonly string[]): string {
  if (sub === 'commit' && !plainCommit(rest)) return 'commit [options]'
  if (sub === 'add' && !plainAdd(rest)) return 'add [options]'
  if (sub === 'branch' && rest.length === 1 && rest[0] === '--show-current') return 'branch --show-current'
  if (sub === 'tag' && rest.length === 1 && (rest[0] === '-l' || rest[0] === '--list')) return 'tag --list'
  if (sub === 'checkout' && rest[0] === '--' && rest.length > 1) return 'checkout -- <paths>'
  if (sub === 'fetch' && rest.some(word => word.startsWith('-') || word.includes('::'))) return 'fetch [options]'
  const display = (word: string): boolean => !word.startsWith('-') || DISPLAY_OPTIONS.has(word) || DISPLAY_VALUED.test(word)
  // A signature check runs gpg.program: `log [signature]` is local, but makes the wide scopes' gpg.program count.
  const signature = (word: string): boolean => word === '--show-signature' || SIGNATURE_FORMAT.test(word)
  if ((sub === 'log' || sub === 'show') && rest.some(signature)) return rest.every(word => signature(word) || display(word)) ? `${sub} [signature]` : `${sub} [options]`
  if ((sub === 'log' || sub === 'show' || sub === 'diff') && !rest.every(display)) return `${sub} [options]`
  return sub ?? ''
}

/** For each segment, the separator that ends its and-or list ('' at the end of the line). */
function listEnds(segs: readonly Seg[]): Sep[] {
  const ends: Sep[] = new Array<Sep>(segs.length)
  let end: Sep = ''
  for (let k = segs.length - 1; k >= 0; k -= 1) {
    const after = segs[k]?.after ?? ''
    if (after === '' || LIST_END.has(after)) end = after
    ends[k] = end
  }
  return ends
}

/**
 * Walks the segments of a line in order. The folder ({@link WalkState.dir}) follows a `cd` only where
 * its effect on what follows is certain: a plain `cd`, `pushd` or `eval` that is {@link Seg.sure}, not
 * a pipeline stage and not after `||`. One after `&&`, or in a list that runs in the background, holds
 * for the rest of its and-or list only (`a && cd x; git push` runs the push wherever `a` left it); an
 * `||` later in the list (`cd x || cd y`, `cd x || echo; git push`) means it may not have run. Every
 * other case makes the folder {@link UNKNOWN_DIR}.
 */
function walkSegments(text: string, inners: readonly Inner[], depth: number, state: WalkState, hits: Outward[]): void {
  const segs = segmentsOf(text)
  const ends = listEnds(segs)
  let moved = false // a folder move happened in this and-or list
  let movedForList = false // … and it holds only until the list ends
  const move = (seg: Seg, k: number, to: string | null): void => {
    if (to === null || !seg.sure || seg.before === '||' || PIPE.has(seg.before) || PIPE.has(seg.after)) state.dir = UNKNOWN_DIR
    else {
      state.dir = to
      if (seg.before === '&&' || ends[k] === '&') movedForList = true
    }
    moved = true
  }
  const walkSegment = (seg: Seg, k: number): void => {
    if (LIST_END.has(seg.before)) {
      if (movedForList) state.dir = UNKNOWN_DIR
      moved = false
      movedForList = false
    } else if (seg.before === '||' && moved) state.dir = UNKNOWN_DIR
    const segment = seg.text
    gitInSubstitution(segment, inners, depth, state)
    const { words, assigned } = readCommand(segment, true)
    const [first, ...args] = words
    for (const name of assigned) if (!HARMLESS_VAR.test(name)) state.gitEnv.add(name)
    if (first === undefined) return
    // The command as written, prefixes kept: a `cd` behind `then`, `command` or `VAR=x` is not plain.
    const written = argWords(segment, true)
    const inner = innerAt(first, inners)
    if (inner !== null) {
      const dir = state.dir
      walkOutward(inner.command, depth + 1, state, hits)
      // A child shell's `cd` ends with it; `eval` runs in this shell. Its git calls count either way.
      if (!inner.sameShell) state.dir = dir
      else if (state.dir !== dir) {
        const to = state.dir
        state.dir = dir
        move(seg, k, written[0] === first ? to : null)
      }
      return
    }
    const cmd = baseName(first)
    if (cmd === 'cd' || cmd === 'pushd' || cmd === 'popd') {
      // `cd`, `cd dir`, `pushd dir`; never `popd`, `cd -`, `pushd +1`, an option or a second word.
      const arg = args[0]
      const plain = written[0] === cmd && written.length === words.length && cmd !== 'popd' && args.length <= 1 && (cmd === 'cd' || arg !== undefined) && !/^[-+]/.test(arg ?? '')
      move(seg, k, plain ? joinDir(state.dir, arg) : null)
      return
    }
    if (DECLARERS.has(cmd)) {
      // `declare -n r=HOME` makes r a name for HOME: its value is a name being set too.
      const nameref = args.some(word => /^-[a-zA-Z]*n/.test(word))
      for (const word of args) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?(?:\+?=(.*))?$/s.exec(word)
        for (const name of [m?.[1], nameref ? /^[A-Za-z_][A-Za-z0-9_]*$/.exec(m?.[2] ?? '')?.[0] : undefined]) {
          if (name !== undefined && !HARMLESS_VAR.test(name)) state.gitEnv.add(name)
        }
      }
    } else if (NAME_SETTERS.has(cmd)) {
      // printf sets a name only with -v; its format and arguments are text.
      const named = cmd === 'printf' ? args.flatMap((word, j) => (word === '-v' ? [args[j + 1] ?? ''] : word.startsWith('-v') ? [word.slice(2)] : [])) : args.map(word => word.replace(/^-[A-Za-z]*[aA](?=[A-Za-z_])/, ''))
      for (const word of named) {
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(word)?.[0]
        if (name !== undefined && !HARMLESS_VAR.test(name)) state.gitEnv.add(name)
      }
    } else if (SHELL_STATE.has(cmd)) state.gitEnv.add(cmd)
    const hit = classifyWords(cmd, args, state.dir)
    if (hit !== null) hits.push(hit.kind === 'push' ? withPushContext(hit, state) : hit)
    if (cmd === 'git') {
      const { sub, rest, dir, config } = readGit(args, state.dir)
      const step = gitStep(sub, rest)
      // `git -c diff.external=./x diff` runs a program of its choice: local only with the push's own config allowlist.
      state.gitBefore.push(config.every(entry => SAFE_CONFIG.test(entry)) ? step : `${step} [${config.join(' ')}]`)
      // Its hooks and its config are those of the folder it ran in (`cd`, then `-C`): compared with the push's in withPushContext.
      state.stepDirs.set(state.gitBefore.length - 1, dir)
      if (sub === 'commit' && signsCommit(rest)) state.signs = true
    } else if (cmd.startsWith('git-')) {
      // `git-push`, or a git builtin run by path (`$(git --exec-path)/git-switch main`): never local.
      state.gitBefore.push(cmd === 'git-push' ? 'push' : cmd)
    } else if (runsOwnCommand(segment)) state.otherBefore = true
  }
  segs.forEach((seg, k) => {
    walkSegment(seg, k)
    // Judged after the segment's own hit is recorded, so it counts for the pushes after it: an output
    // redirection on any segment (a git step, `cd`, `exec`, an assignment) may write .git/config or
    // .git/HEAD. Ceiling: one on the push itself (`git push … > .git/config`) is not judged — the shell
    // opens it before git starts, so it can only truncate the file, and git writes into it only after
    // it read its refs and config.
    if (writesOutput(seg.text)) state.otherBefore = true
  })
  if (movedForList) state.dir = UNKNOWN_DIR
}

// A `$(…)` or backtick span holding no quote, parenthesis, backtick or backslash, so where it ends is certain.
const PLAIN_SUBSTITUTION = /\$\([^()'"`\\]*\)|`[^`'"\\$]*`/g

/**
 * Whether a segment whose first word is not git runs a command of its own: read again with each plain
 * substitution as one word, so `h=$(git rev-parse HEAD)` runs none (its body was read by
 * {@link gitInSubstitution}). Any word left — a command, or a word split out of a substitution this
 * cannot bound — counts, and so does a git call the first read missed (`h=$(echo x) git switch main`).
 */
function runsOwnCommand(segment: string): boolean {
  return readCommand(segment.replace(PLAIN_SUBSTITUTION, '_'), true).words.length > 0
}

/**
 * Resolves a `cd` target to an absolute folder (`bash -c CD_SCRIPT so-hud <dir>` in the session folder; the target is an
 * argument, never source): prints it and exits 0, or exits non-zero. A relative target that does not start with `.`
 * exits 3 while `CDPATH` is set (#1573 input): the session's shell looks it up there first, so `cd sub` may land
 * elsewhere than the folder this would resolve — the push then asks. Ceiling: a zsh `cdpath` set only in the session
 * shell's own startup files is not in this environment.
 */
export const CD_SCRIPT = `d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; /*|.|..|./*|../*) ;; *) [ -z "\${CDPATH:-}" ] || exit 3;; esac; unset CDPATH; cd -- "$d" 2>/dev/null && pwd -P`

/** Whether a folder the walker could not follow ({@link UNKNOWN_DIR}, or one below it). */
const unknownDir = (dir: string | null): boolean => dir !== null && (dir === UNKNOWN_DIR || dir.startsWith(`${UNKNOWN_DIR}/`))

/** A push hit with what earlier segments of the line changed under the measured facts. */
function withPushContext(hit: Outward, state: WalkState): Outward {
  const gitConfig = [...(hit.gitConfig ?? []), ...state.gitEnv]
  // A git step elsewhere ran hooks and config the facts never measured: compared as written, so `-C .` asks too.
  // A step without a recorded folder (`git-<name>`, `$(…)` past the depth) is not local anyway.
  const sameDir = (i: number): boolean => !state.stepDirs.has(i) || (state.stepDirs.get(i) === hit.dir && !unknownDir(hit.dir))
  return {
    ...hit,
    ...(state.gitBefore.length > 0 ? { gitBefore: state.gitBefore.map((step, i) => (sameDir(i) ? step : `${step} [other folder]`)) } : {}),
    ...(state.otherBefore ? { otherBefore: true as const } : {}),
    ...(state.signs ? { signsBefore: true as const } : {}),
    ...(gitConfig.length > 0 ? { gitConfig } : {}),
  }
}

// git's own options before the subcommand that point it at another repository or ref namespace.
const GIT_REDIRECTS = ['--git-dir', '--work-tree', '--namespace']
// git's global options that change nothing about where a push goes; every other one is reported as config.
const GIT_GLOBAL_PLAIN = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks'])

/** git's global options read off: the subcommand, its words, the folder `-C` moved to, and the config the facts did not see. */
function readGit(args: readonly string[], dir: string | null): { sub: string | undefined; rest: string[]; dir: string | null; config: string[] } {
  let gitDir = dir
  const config: string[] = []
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const arg = args[i] ?? ''
    const value = args[i + 1]
    if (value !== undefined && arg === '-C') {
      gitDir = joinDir(gitDir, value)
      i += 2
    } else if (value !== undefined && (arg === '-c' || arg === '--config-env')) {
      config.push(value)
      i += 2
    } else if (value !== undefined && GIT_REDIRECTS.includes(arg)) {
      config.push(`${arg}=${value}`)
      i += 2
    } else if (value !== undefined && arg === '--attr-source') {
      config.push(`${arg}=${value}`)
      i += 2
    } else {
      if (arg.startsWith('--config-env=')) config.push(arg.slice('--config-env='.length))
      else if (!GIT_GLOBAL_PLAIN.has(arg)) config.push(arg)
      i += 1
    }
  }
  return { sub: args[i], rest: args.slice(i + 1), dir: gitDir, config }
}

// Without -X, gh and glab send POST as soon as a field or --input is given.
const API_FIELDS = /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)|^-[fF]./
const GRAPHQL_MERGE = /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch|mergeRequestAccept)\b/
const API_REF_MAIN = /(?:^|\/)git\/refs\/heads\/(?:main|master)\/?(?:\?.*)?$/

const decodePath = (word: string): string => {
  try {
    return decodeURIComponent(word)
  } catch {
    return word
  }
}

/**
 * What a forge API call that writes does, or null: a write to `git/refs/heads/main|master` (or a
 * `git/refs` create naming it), and any write carrying the field `branch=main|master` (a contents
 * or commits write onto the default branch), is a push; a REST `…/merge` or `…/merges`, a GraphQL
 * merge mutation, and a GraphQL body this cannot read (`-F query=@file`, `--input`) are merges.
 */
function apiAction(apiArgs: readonly string[]): { kind: 'push' | 'merge'; path: string } | null {
  let method: string | undefined
  const fields: string[] = []
  // Indices of the words that are an option's value, so the endpoint is the first word that is none.
  const values = new Set<number>()
  for (let i = 0; i < apiArgs.length; i += 1) {
    const arg = apiArgs[i] ?? ''
    if (arg === '-X' || arg === '--method') {
      method = apiArgs[i + 1]
      values.add(i + 1)
    } else if (arg.startsWith('--method=')) method = arg.slice('--method='.length)
    else if (/^-X./.test(arg)) method = arg.slice(2)
    else if (arg === '-f' || arg === '-F' || arg === '--field' || arg === '--raw-field') {
      fields.push(apiArgs[i + 1] ?? '')
      values.add(i + 1)
    } else if (/^-[fF]./.test(arg)) fields.push(arg.slice(2))
    else if (/^--(?:raw-)?field=/.test(arg)) fields.push(arg.slice(arg.indexOf('=') + 1))
  }
  const writes = method !== undefined ? /^(?:PUT|POST|PATCH|DELETE)$/i.test(method) : apiArgs.some(a => API_FIELDS.test(a))
  if (!writes) return null
  const words = apiArgs.filter(a => !a.startsWith('-')).map(decodePath)
  const ref = words.find(a => API_REF_MAIN.test(a))
  if (ref !== undefined) return { kind: 'push', path: ref }
  const refs = words.find(a => /(?:^|\/)git\/refs\/?$/.test(a))
  if (refs !== undefined && fields.some(v => /^ref=refs\/heads\/(?:main|master)$/.test(v))) return { kind: 'push', path: refs }
  if (fields.some(v => /^branch=(?:refs\/heads\/)?(?:main|master)$/.test(v))) {
    return { kind: 'push', path: apiArgs.find((a, i) => !a.startsWith('-') && !values.has(i)) ?? 'api' }
  }
  const merge = words.find(a => /\/merges?\/?(?:\?.*)?$/.test(a))
  if (merge !== undefined) return { kind: 'merge', path: merge }
  const unreadBody = apiArgs.some(a => a === '--input' || a.startsWith('--input=')) || fields.some(v => v.startsWith('query=@'))
  return words.includes('graphql') && (unreadBody || apiArgs.some(a => GRAPHQL_MERGE.test(a))) ? { kind: 'merge', path: 'graphql' } : null
}

// The options of git push that take a separate value.
const PUSH_VALUED = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo'])

/**
 * Whether the last dry-run switch before `--` turns dry-run on: `--dry-run`, `--dry-run=true` and,
 * when `shortN`, a lone `-n` turn it on; `--no-dry-run` and any other `--dry-run=` turn it off. A
 * value of an option in `valued` (`git push -o -n`) is no switch.
 */
function isDryRun(args: readonly string[], valued: ReadonlySet<string>, shortN: boolean): boolean {
  let dry = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '--') break
    if (valued.has(arg)) i += 1
    else if (arg === '--dry-run' || arg === '--dry-run=true' || (shortN && arg === '-n')) dry = true
    else if (arg === '--no-dry-run' || arg.startsWith('--dry-run=')) dry = false
  }
  return dry
}

// npm/pnpm/yarn options before the subcommand that take a separate value (`-w pkg`, `--filter x`).
const PM_VALUED = new Set(['-w', '--workspace', '--prefix', '--registry', '--tag', '--otp', '--access', '--userconfig', '--cache', '--filter', '-F', '-C', '--dir', '--cwd', '--loglevel', '--reporter', '--include', '--exclude', '--from', '--since', '-j', '--jobs'])
// Subcommands that only name `publish` as a word (`npm help publish`) or a package (`npm i publish`).
const PM_NOT_PUBLISHING = new Set(['help', 'view', 'info', 'show', 'v', 'search', 's', 'docs', 'home', 'repo', 'bugs', 'why', 'explain', 'ls', 'list', 'outdated', 'audit', 'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un'])

/** Whether npm/pnpm/yarn publishes: `publish` among the positionals before `--`, so `-w pkg`, `--filter x` or `yarn workspace x` in front cannot hide it. */
function pmPublishes(args: readonly string[]): boolean {
  const end = args.indexOf('--')
  const pos = positionals(end === -1 ? args : args.slice(0, end), PM_VALUED)
  return pos.includes('publish') && !PM_NOT_PUBLISHING.has(pos[0] ?? '')
}

function classifyWords(cmd: string, args: string[], dir: string | null): Outward | null {
  const [sub, action] = args
  if (cmd === 'git' || cmd === 'git-push') {
    const git = cmd === 'git' ? readGit(args, dir) : { sub: 'push', rest: args, dir, config: [] }
    if (git.sub !== 'push') return null
    if (isDryRun(git.rest, PUSH_VALUED, true)) return null
    return { kind: 'push', label: 'git push', args: git.rest, dir: git.dir, ...(git.config.length > 0 ? { gitConfig: git.config } : {}) }
  }
  // Wrappers like glab-<name> speak the same API as glab.
  if (cmd === 'glab' || cmd === 'gh' || /^glab-[a-z0-9-]+$/.test(cmd)) {
    const forge = cmd === 'gh' ? 'gh' : 'glab'
    // `glab mr accept` is glab's alias of `glab mr merge`.
    if ((sub === 'mr' || sub === 'pr') && (action === 'merge' || action === 'accept')) {
      return { kind: 'merge', label: `${cmd} ${sub} ${action}`, args: args.slice(2), dir, forge }
    }
    if (sub === 'release' && action === 'create') {
      return { kind: 'release', label: `${cmd} release create`, args: args.slice(2), dir, forge }
    }
    const api = sub === 'api' ? apiAction(args.slice(1)) : null
    if (api !== null) {
      return { kind: api.kind, label: `${cmd} api ${api.path}`, args: args.slice(1), dir, forge, ...(api.kind === 'push' ? { opaque: true as const } : {}) }
    }
    return null
  }
  const joined = [cmd, ...args].join(' ')
  if (isDryRun(args, PM_VALUED, false)) return null
  if (((cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') && pmPublishes(args)) || /^changeset publish\b/.test(joined) || /^cargo publish\b/.test(joined)) {
    return { kind: 'publish', label: [cmd, ...args.slice(0, args.indexOf('publish') + 1)].join(' '), args, dir, tool: cmd }
  }
  if (cmd === 'vercel' && (args.includes('--prod') || args.includes('--production') || sub === 'promote' || sub === 'rollback')) {
    return { kind: 'deploy', label: `vercel ${args.filter(a => !a.startsWith('--token')).join(' ')}`.trim(), args, dir, tool: 'vercel' }
  }
  if (cmd === 'supabase' && ((sub === 'db' && (action === 'push' || (action === 'reset' && args.includes('--linked')))) || (sub === 'migration' && action === 'up' && args.includes('--linked')))) {
    return { kind: 'deploy', label: `supabase ${sub} ${action}`, args, dir, tool: 'supabase' }
  }
  if ((cmd === 'fly' || cmd === 'flyctl') && sub === 'deploy') {
    return { kind: 'deploy', label: 'fly deploy', args, dir, tool: 'fly' }
  }
  if (cmd === 'railway' && sub === 'up') {
    return { kind: 'deploy', label: 'railway up', args, dir, tool: 'railway' }
  }
  return null
}

// ---- Which pushes may skip the confirmation ----------------------------------

const PROTECTED_BRANCHES = ['main', 'master']
// The only options a push may carry and skip the confirmation, matched as exact words.
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--progress', '--no-progress'])
// The only git steps that may run earlier on the line (see {@link gitStep}): none moves the branch, its upstream or the config.
const LOCAL_GIT = new Set(['add', 'commit', 'status', 'log', 'diff', 'show', 'log [signature]', 'show [signature]', 'rev-parse', 'fetch', 'ls-files', 'branch --show-current', 'tag --list', 'checkout -- <paths>'])
// The steps of LOCAL_GIT that can fire a hook (pre-/post-commit, reference-transaction,
// post-index-change, post-checkout), which runs any program: local only when no hook can run ({@link PushFacts.hooks}).
const HOOK_GIT = new Set(['add', 'commit', 'status', 'diff', 'fetch', 'checkout -- <paths>'])
// The only `-c` / `--config-env` keys a push may carry and skip the confirmation.
const SAFE_CONFIG = /^(?:user\.(?:name|email)|core\.quotepath|color\.[^=]+)(?:=|$)/i
const PLAIN_REMOTE = /^[A-Za-z0-9._-]+$/

/**
 * What the wiring measured with `git` in the push's folder (`hit.dir`), each read independently.
 * Any read that failed, printed nothing, or was not run is `null` / `false`: the push then needs
 * confirmation (fail-closed).
 */
export type PushFacts = {
  /** `git rev-parse --abbrev-ref HEAD` (`HEAD` when detached). */
  current: string | null
  /** `git rev-parse --abbrev-ref @{u}`, e.g. `origin/feat/x`. */
  upstream: string | null
  /** `git config branch.<current>.remote`; null when unset, so {@link pushRemote} falls back to `origin`. */
  remote: string | null
  /** `git remote get-url <pushRemote(hit, facts.remote)>` exited 0 with a non-empty URL. */
  remoteUrlKnown: boolean
  /**
   * Each destination from {@link pushDestinations} for which `git rev-parse --verify --quiet refs/tags/<dst>`
   * exited 0. null when the probes were not run.
   */
  tagRefs: readonly string[] | null
  /**
   * The push configuration a previous call may have set (#1569). Optional only so a caller from before
   * it still type-checks: absent (`undefined`) or `null` (any of its reads failed) asks, never runs.
   */
  pushConfig?: PushConfig | null
  /**
   * Whether a hook the earlier git steps can fire exists in the push's folder (#1574): only the hook
   * names those steps fire are looked up in the hooks directory (`git rev-parse --git-path hooks`), a
   * verified husky v9 stub counts only when its `.husky/<name>` exists, and a config hook only for those
   * events; `false` only when measured absent; `null` when a read failed or the layout is unknown. Absent or `null` asks like
   * `true` — for a push behind a step in {@link HOOK_GIT} (MR !133: a post-commit hook of
   * `git commit && git push origin HEAD` may switch HEAD or write the push configuration). A hook step
   * in another folder asks whatever this holds ({@link Outward.gitBefore}).
   */
  hooks?: boolean | null
  /**
   * Every configured key with the scope git read it from ({@link REPO_CONFIG_READ}, parsed by
   * {@link repoConfigEntries}). A key such as `core.fsmonitor`, `diff.external`, `filter.<x>.clean` or
   * `core.sshCommand` makes a local step (`status`, `diff`, `add`, `fetch`) run a program, which may move
   * HEAD or write the push configuration after the facts were measured (#1573). Absent or `null` (the read
   * failed, or its output did not parse) asks for every push behind a git step, like a key outside
   * {@link repoConfigStandard}.
   */
  repoConfig?: RepoConfig | null
  /**
   * Whether the index of the push's folder holds a gitlink (mode 160000: a submodule, or an embedded
   * repository added without `.gitmodules`), counted by {@link GITLINKS_SCRIPT}. `git status`, `git diff`
   * and `git fetch` step into such a repository and run its own `core.fsmonitor`, filters and transport,
   * which {@link repoConfig} never read (#1573 review; measured with git 2.56.0: an embedded `sub/` with
   * its own `core.fsmonitor` ran it four times during the outer repository's `git status` and `git diff`).
   * `false` only when counted zero; absent or `null` (the count failed) asks like `true` for every push
   * behind a git step. This also covers `submodule.recurse`, which only acts where gitlinks exist.
   */
  gitlinks?: boolean | null
  /**
   * `git rev-parse --symbolic-full-name <src>` for each source of {@link pushSources}, in order (#1570); null
   * entry when the read failed or printed nothing (an ambiguous name exits 0 with nothing on stdout, git 2.56.0).
   * A push naming its branch runs only when each is exactly `refs/heads/<name>`: a symbolic ref `feat/x` →
   * `refs/heads/main` is pushed as `feat/x -> main`, and a `refs/feat/x` without that branch is pushed to `refs/feat/x`
   * (beside the branch the name is ambiguous and git refuses the push; both measured, git 2.56.0). Absent
   * or `null` asks for every push that names a source; `HEAD` and a bare push name none ({@link pushSources}).
   */
  sourceRefs?: readonly (string | null)[] | null
}

/**
 * Counts the gitlinks of the index in the folder it runs in (`bash -c <script> so-hud-gitlinks`): prints
 * the count and exits 0, or exits non-zero when `git ls-files` or `grep` failed (pipefail; grep's exit 1
 * for no match is turned into 0). Paths with unusual characters are quoted by git, so each entry is one
 * line starting with its mode. Reads the whole index but prints one number, so no output limit is hit.
 */
export const GITLINKS_SCRIPT = 'set -o pipefail; git ls-files --stage | { LC_ALL=C grep -c "^160000 " || [ $? -eq 1 ]; }'

/** {@link PushFacts.gitlinks} from a {@link GITLINKS_SCRIPT} run: null unless it exited 0 and printed one count. */
export function gitlinksFromRun(exitCode: number, stdout: string): boolean | null {
  const count = /^(\d+)\n?$/.exec(stdout)?.[1]
  return exitCode === 0 && count !== undefined ? Number(count) > 0 : null
}

/**
 * `[scope, key, value]` per configured entry, as `git config --show-scope` prints them (`local`,
 * `core.fsmonitor`, `./x`); the value is null for a key written without `=`.
 */
export type RepoConfig = readonly (readonly [scope: string, key: string, value: string | null])[]

/**
 * The read behind {@link PushFacts.repoConfig}, run as `git <words>` in the push's folder: every entry of
 * every scope, `<scope>\0<key>\n<value>\0` each (`<scope>\0<key>\0` without `=`), entries of an included
 * file under the scope of the file including it (measured, git 2.56.0). One process per hook call, and
 * only when the push would otherwise run. The values stay inside the hook; nothing of them is shown.
 */
export const REPO_CONFIG_READ: readonly string[] = ['config', '--null', '--show-scope', '--list']

/** The entries of a {@link REPO_CONFIG_READ} output (exit 0); null when it does not parse. Nothing printed is no key. */
export function repoConfigEntries(stdout: string): RepoConfig | null {
  if (stdout === '') return []
  if (!stdout.endsWith('\0')) return null
  const fields = stdout.slice(0, -1).split('\0')
  if (fields.length % 2 !== 0) return null
  const entries: (readonly [string, string, string | null])[] = []
  for (let i = 0; i < fields.length; i += 2) {
    const entry = fields[i + 1] ?? ''
    const cut = entry.indexOf('\n')
    entries.push(cut === -1 ? [fields[i] ?? '', entry, null] : [fields[i] ?? '', entry.slice(0, cut), entry.slice(cut + 1)])
  }
  return entries
}

/**
 * The repository keys that run no program — an allowlist (#1573), measured 2026-10-16 as every key set in
 * the 27 local configs of one owner's repos (`git config --local --name-only --list`), plus the push keys
 * {@link pushConfigStandard} judges. git prints section and key in lower case and the subsection as
 * written. `core.hookspath` is judged by {@link PushFacts.hooks}. `include.path` and `includeIf` ask:
 * nothing more is needed, as the included keys are listed too. Program keys outside: `core.fsmonitor`,
 * `core.sshcommand`, `core.pager`, `core.editor`, `diff.external`, `diff.<x>.textconv`, `filter.<x>.*`,
 * `merge.<x>.driver`, `gpg.program`, `credential.helper`, `remote.<x>.uploadpack`, `protocol.*`,
 * `submodule.<x>.update`, `alias.*`, `url.*` — and any key git adds later. A remote URL is judged by its
 * value too ({@link TRANSPORT_URL}).
 */
const PLAIN_REPO_KEY = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|hookspath|sparsecheckout|sparsecheckoutcone)|index\.sparse|extensions\.worktreeconfig|user\.(?:name|email)|gc\.auto|maintenance\.auto|submodule\.recurse|push\.[a-z]+|remote\.pushdefault|branch\..+\.(?:remote|merge|pushremote|vscode-merge-base)|remote\..+\.(?:url|pushurl|fetch|push|mirror|glab-resolved[a-z-]*))$/

// A remote URL in git's `<transport>::<address>` form: `git fetch` starts `git-remote-<transport>` from
// PATH (`ext::` is refused by default, every other transport allowed) — the same `::` word gitStep refuses
// on `fetch`. A `url.<base>.insteadOf` whose base has one rewrites a plain remote into such a URL.
const TRANSPORT_URL = /^remote\..+\.(?:url|pushurl)$/
const TRANSPORT_REWRITE = /^url\..*::.*\.(?:insteadof|pushinsteadof)$/

// Keys of the global and system scopes that make a local step run a program whatever their value (#1573
// review): `diff.external` and textconv for `diff`/`log -p`, `core.sshCommand`, `core.askPass`,
// `core.gitProxy`, an upload-pack override and `uploadpack.packObjectsHook` (read only from these scopes,
// run when fetching from a local path) for `fetch`, and `remote.<r>.vcs`, which routes a remote through
// `git-remote-<vcs>` from PATH.
const PROGRAM_KEY = /^(?:diff\.external|core\.(?:sshcommand|askpass|gitproxy)|diff\..+\.(?:textconv|command)|remote\..+\.(?:uploadpack|receivepack|vcs)|uploadpack\.packobjectshook)$/
// git's spellings of a boolean; `core.fsmonitor` set to one uses git's own daemon or none, never a program.
const GIT_BOOL = /^(?:true|yes|on|1|false|no|off|0|)$/i
// The values git-lfs writes with `git lfs install` — the only filter programs the wide scopes may name.
const LFS_FILTERS = new Set(['git-lfs clean -- %f', 'git-lfs smudge -- %f', 'git-lfs filter-process'])
// The credential helpers git and the forge CLIs install (`gh`/`glab auth setup-git`), and `''` (resets the
// list). A helper anywhere else, or `!` with any other command, asks. Measured on one host 2026-10-16:
// osxkeychain, `!/opt/homebrew/bin/gh auth git-credential`, `!glab auth git-credential`, `''`.
const KNOWN_HELPER = /^(?:|osxkeychain|manager|manager-core|wincred|libsecret|store|cache(?: --timeout=\d+)?|!(?:(?:\/opt\/homebrew\/bin|\/usr\/local\/bin|\/usr\/bin)\/)?(?:gh|glab) auth git-credential)$/

/**
 * Whether an entry of the `global` or `system` scope makes a local step run a program — a denylist,
 * because these scopes hold the host's own helpers. `gpg.program` counts only when a `commit` runs on the
 * line and signs: `commit.gpgSign` on there (last value wins) or an explicit `-S` ({@link Outward.signsBefore}) — or when
 * a `log`/`show` step verifies signatures (`--show-signature`, a `%G` placeholder, or `log.showSignature` on: `verifies`);
 * `log.showSignature` itself counts behind any `log`/`show` step (`logs`). Not judged: `core.pager` (no step
 * here pages: its output is no terminal), `core.editor` (a commit message given with `-m` opens none; the
 * host's editor is set on most hosts), `include.path`/`includeIf` (the included entries are listed and
 * judged themselves), `core.hooksPath`/`hook.*` ({@link PushFacts.hooks}).
 */
function wideProgram(key: string, value: string | null, signing: boolean, commits: boolean, verifies: boolean, logs: boolean): boolean {
  const k = key.toLowerCase()
  // `log.showSignature` makes a plain `git log`/`git show` verify signatures, which runs gpg (#1573 input): a denylist entry.
  if (k === 'log.showsignature') return logs && !/^(?:false|no|off|0)$/i.test(value ?? 'true')
  if (PROGRAM_KEY.test(k) || TRANSPORT_REWRITE.test(k)) return true
  if (TRANSPORT_URL.test(k)) return (value ?? '').includes('::')
  if (k === 'core.fsmonitor') return !GIT_BOOL.test(value ?? '')
  if (/^filter\..+\.(?:clean|smudge|process)$/.test(k)) return !LFS_FILTERS.has(value ?? '')
  if (/^credential\.(?:.+\.)?helper$/.test(k)) return !KNOWN_HELPER.test(value ?? '')
  if (/^gpg\.(?:.+\.)?program$/.test(k)) return (signing && commits) || verifies
  return false
}

/**
 * Whether no configured entry can make a local git step (`steps`, {@link Outward.gitBefore}) run a program:
 * every entry of the repository's own scopes (`local`, `worktree`, `command`, and any other git reports,
 * includes followed) is in {@link PLAIN_REPO_KEY}, with no remote URL in the `<transport>::` form; and no
 * entry of `global` or `system` is a program per {@link wideProgram}.
 * Ceiling: the wide scopes are judged by a denylist, so a program key git adds later passes there; the
 * repository's own scopes stay an allowlist.
 */
function repoConfigStandard(config: RepoConfig | null | undefined, steps: readonly string[], signs: boolean): boolean {
  if (!Array.isArray(config) || !config.every(entry => Array.isArray(entry))) return false
  const wide = (scope: unknown): boolean => scope === 'global' || scope === 'system'
  const signing = config.reduce((on, [scope, key, value]) => (wide(scope) && String(key).toLowerCase() === 'commit.gpgsign' ? /^(?:true|yes|on|1)$/i.test(value ?? 'true') : on), false)
  const commits = steps.includes('commit')
  const verifies = steps.some(step => step.endsWith(' [signature]'))
  const logs = steps.some(step => /^(?:log|show)(?: \[signature\])?$/.test(step))
  // A log or show that verifies signatures, or any log or show where the wide scopes turn log.showSignature on, runs gpg.program.
  const showsSignature = logs && config.some(([scope, key, value]) => wide(scope) && String(key).toLowerCase() === 'log.showsignature' && !/^(?:false|no|off|0)$/i.test(value ?? 'true'))
  return config.every(([scope, key, value]) => {
    if (wide(scope)) return !wideProgram(String(key), value, signing || signs, commits, verifies || showsSignature, logs)
    return PLAIN_REPO_KEY.test(String(key)) && !(TRANSPORT_URL.test(String(key)) && (value ?? '').includes('::'))
  })
}

/**
 * Push configuration read with `git config --null` in the push's folder, each value as measured. Exit 1
 * with no output means unset (`null`, or `[]`); any other failure (exit code, timeout, output that does
 * not parse) makes the whole {@link PushFacts.pushConfig} `null`. `<target>` is
 * `pushRemote(hit, facts.remote)`, `<current>` is `facts.current`. `--null` keeps a value that is empty
 * or holds a newline one entry, so a set-but-empty `remote.<target>.push` never reads as unset.
 */
export type PushConfig = {
  /**
   * `git config --null --get-regexp '^push\.'`: every `push.*` entry as `[key, value]`, the key as git
   * prints it (`push.default`), the value null for a key written without `=`. `[]` when none is set.
   */
  push: readonly (readonly [key: string, value: string | null])[]
  /** `git config --get-all remote.<target>.push`: every value (several are possible). `[]` when unset. */
  remotePush: readonly string[]
  /** `git config --type=bool --get remote.<target>.mirror`: `'true'`, `'false'`, or null when unset. */
  remoteMirror: string | null
  /** `git config --get remote.pushDefault`, or null when unset. */
  remotePushDefault: string | null
  /** `git config --get branch.<current>.pushRemote`, or null when unset (and when detached: not read). */
  branchPushRemote: string | null
  /** `git config --type=bool --get submodule.recurse`: `'true'`, `'false'`, or null when unset. */
  submoduleRecurse: string | null
}

// The push.* keys that change nothing about where a plain push goes: autoSetupRemote acts only without
// an upstream, and a bare push without one already asks ({@link pushDestinations} is null).
const SAFE_PUSH_KEYS = new Set(['push.autosetupremote'])

const measuredValue = (value: unknown): value is string | null => value === null || typeof value === 'string'

/**
 * Whether the measured push configuration is the standard one for this push — an allowlist, and every
 * read must have happened (`undefined` anywhere asks):
 * - `remote.<target>.push` is unset: it maps even a named branch (`feat/x` → `refs/heads/main`).
 * - `remote.<target>.mirror` and `submodule.recurse` are unset or false: either pushes more than named.
 * - With no remote named, the remote git picks (`branch.<b>.pushRemote`, then `remote.pushDefault`, then
 *   the measured one) is the measured target; a named remote overrides both, as in git.
 * - Every `push.*` key is `push.autosetupremote` or `push.default`. `push.default` must be `simple` —
 *   git's default, which pushes the current branch only to its same-named upstream and refuses
 *   otherwise, the model {@link pushDestinations} implements — or, when the push names its branch,
 *   `current`. git reads push.default for a named branch too: under `upstream`/`tracking` a single
 *   named branch goes to its upstream (measured, git 2.56.0: `git push -u origin feat/y` with feat/y
 *   tracking origin/main printed `feat/y -> main`, #1569 H1). So `upstream`, `tracking`, `matching`
 *   (every same-named branch, main included), `nothing` and any value git may add later ask, named or
 *   not, as does any other `push.*` key (`pushOption` can merge on GitLab, `followTags` pushes tags,
 *   `recurseSubmodules` pushes other repositories).
 */
function pushConfigStandard(config: PushConfig | null | undefined, target: string, remoteNamed: boolean, specNamed: boolean): boolean {
  if (config === null || config === undefined || typeof config !== 'object') return false
  const { push, remotePush, remoteMirror, remotePushDefault, branchPushRemote, submoduleRecurse } = config
  if (!Array.isArray(push) || !Array.isArray(remotePush) || ![remoteMirror, remotePushDefault, branchPushRemote, submoduleRecurse].every(measuredValue)) return false
  if (remotePush.length > 0 || (remoteMirror ?? 'false') !== 'false' || (submoduleRecurse ?? 'false') !== 'false') return false
  if (!remoteNamed && (branchPushRemote ?? remotePushDefault ?? target) !== target) return false
  return push.every(entry => {
    if (!Array.isArray(entry)) return false
    const key = String(entry[0]).toLowerCase()
    return SAFE_PUSH_KEYS.has(key) || (key === 'push.default' && (entry[1] === 'simple' || (specNamed && entry[1] === 'current')))
  })
}

function readPush(args: readonly string[]): { pos: string[]; specs: string[] } {
  const pos = positionals(args, PUSH_VALUED)
  return { pos, specs: pos.slice(1) }
}

const PLAIN_BRANCH = /^[A-Za-z0-9._/-]+$/

/**
 * A destination git writes to as exactly `refs/heads/<name>`: no `@`, no `HEAD`, no prefix git
 * expands on its own (`heads/main` is refs/heads/main, `tags/v1` a tag), no other `refs/…`, and not
 * the `tag` of `git push origin tag v1`. `HEAD` in any case: on a case-insensitive filesystem git reads
 * `head` as HEAD (measured on macOS 2026-10-12: `git push origin head` on main printed `head -> main`).
 */
function isPlainBranch(name: string): boolean {
  return PLAIN_BRANCH.test(name) && !name.startsWith('-') && name.toLowerCase() !== 'head' && name !== 'tag' && !/^(?:refs|heads|tags|remotes)\//.test(name)
}

/** `main` or `master` in any case: a case-insensitive filesystem on either end may store `Main` as `main`. */
function isProtected(name: string): boolean {
  return PROTECTED_BRANCHES.includes(name.toLowerCase())
}

/** The remote a push goes to: the first positional, `--repo`, the branch's configured remote, else `origin`. */
export function pushRemote(hit: Outward, configured: string | null): string {
  return readPush(hit.args).pos[0] ?? optionValue(hit.args, '--repo') ?? (configured || 'origin')
}

/**
 * The branches a push writes to, or null when one cannot be named as a plain branch (no upstream for
 * a bare push, detached HEAD, a wildcard, `@`, `heads/…`, a `refs/` refspec other than refs/heads/):
 * such a push always needs confirmation. The wiring probes each returned name for a tag to fill
 * {@link PushFacts.tagRefs}.
 */
export function pushDestinations(hit: Outward, current: string | null, upstream: string | null, remote: string): string[] | null {
  if (hit.opaque === true) return null
  const { specs } = readPush(hit.args)
  const here = current ?? ''
  if (specs.length === 0) {
    if (!isPlainBranch(here) || upstream === null || upstream === '') return null
    const dst = upstream.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : here
    return isPlainBranch(dst) ? [dst] : null
  }
  const dsts = specs.map(spec => {
    const bare = spec.replace(/^\+/, '')
    const target = (bare.includes(':') ? bare.slice(bare.indexOf(':') + 1) : bare).replace(/^refs\/heads\//, '')
    return target === '' || target === 'HEAD' ? here : target
  })
  return dsts.every(isPlainBranch) ? dsts : null
}

/**
 * The source of each refspec a push names (the part before `:`, without `+`), whose ref the wiring
 * resolves into {@link PushFacts.sourceRefs}. `HEAD`, an empty source and a bare push name none:
 * `facts.current` (`--abbrev-ref HEAD`) already follows a symbolic ref to its branch, and git pushes
 * HEAD to that same branch (measured, git 2.56.0: HEAD → `feat/sym` → main printed `main` and
 * pushed `HEAD -> main`), so a HEAD on a symbolic ref is judged by its real branch already.
 */
export function pushSources(hit: Outward): string[] {
  return readPush(hit.args).specs
    .map(spec => spec.replace(/^\+/, '').split(':')[0] ?? '')
    .filter(src => src !== '' && src !== 'HEAD')
}

/** The full name a source must resolve to: `refs/heads/<name>`, also when spelled with that prefix. */
function branchRef(src: string): string {
  return src.startsWith('refs/heads/') ? src : `refs/heads/${src}`
}

/** The {@link PushFacts.sourceRefs} of a push whose every source resolves as written; the wiring's permissive value. */
export function plainSourceRefs(hit: Outward): string[] {
  return pushSources(hit).map(branchRef)
}

/**
 * Whether an outward action needs the owner's confirmation — an allowlist: a push skips it only
 * when every option is one of {@link PUSH_FLAGS} exactly; it names at most a plain remote and one
 * plain branch (no `:`, `+`, `@`, `main`/`master`, tag), or exactly `HEAD`, or with no branch the
 * measured destination is such a branch; every earlier command on the line is a git call in
 * {@link LOCAL_GIT}, and none is in {@link HOOK_GIT} unless `facts.hooks` is `false` and it ran in the
 * push's own folder ({@link Outward.gitBefore}: `<step> [other folder]` is not local), and with any of them
 * the repository's configuration names no program ({@link repoConfigStandard}); its config is in
 * {@link SAFE_CONFIG}; the push configuration is the standard one ({@link pushConfigStandard}); and every
 * fact was measured. Everything else, and every other kind, asks.
 *
 * The facts are measured before the line runs, so an earlier command may change them for every push
 * form (#1569 P3, MR !133 HOCH 2): one that is not git ({@link Outward.otherBefore}: `gh pr checkout 5`,
 * `./switch.sh`, `printf … >> .git/config`, one inside `$(…)`) may move HEAD or write the push
 * configuration, and so may a hook a git step fires. `HEAD` (`git push -u origin HEAD`, the usual first
 * push) and a bare push (no refspec, #1569 M1) then stand for `facts.current`; the wiring probes HEAD for
 * a tag like a named branch.
 * Detached (`current` is `HEAD` or null) it is no plain branch and asks; `HEAD:x`, `@` and
 * `refs/heads/HEAD` are not this form and ask.
 */
export function pushNeedsConfirm(hit: Outward, facts: PushFacts): boolean {
  if (hit.kind !== 'push' || hit.opaque === true) return true
  // `git switch main && git push`: the facts describe what was checked out before the line ran.
  if (hit.gitBefore?.some(step => !LOCAL_GIT.has(step)) === true) return true
  if (hit.otherBefore === true) return true
  if (facts.hooks !== false && hit.gitBefore?.some(step => HOOK_GIT.has(step)) === true) return true
  // #1573: `git status` runs core.fsmonitor, `git diff` diff.external, `git fetch` core.sshCommand — any of them may move HEAD.
  if ((hit.gitBefore?.length ?? 0) > 0 && !repoConfigStandard(facts.repoConfig, hit.gitBefore ?? [], hit.signsBefore === true)) return true
  // …and so does a submodule or embedded repository a step walks into: its own configuration was never read.
  if ((hit.gitBefore?.length ?? 0) > 0 && facts.gitlinks !== false) return true
  if (hit.gitConfig?.some(entry => !SAFE_CONFIG.test(entry)) === true) return true
  if (hit.args.some(arg => arg.startsWith('-') && !PUSH_FLAGS.has(arg))) return true
  const [remote, spec, ...extra] = hit.args.filter(arg => !arg.startsWith('-'))
  if (extra.length > 0 || (remote !== undefined && !PLAIN_REMOTE.test(remote))) return true
  if (!facts.remoteUrlKnown || facts.tagRefs === null) return true
  const target = pushRemote(hit, facts.remote)
  if (!pushConfigStandard(facts.pushConfig, target, remote !== undefined, spec !== undefined)) return true
  const named = spec === 'HEAD' ? facts.current : spec?.replace(/^refs\/heads\//, '')
  const dsts = spec === undefined ? pushDestinations(hit, facts.current, facts.upstream, target) : typeof named === 'string' ? [named] : null
  const tags = facts.tagRefs
  // #1570: a named source must be the branch it names, not a symbolic ref or a `refs/<name>` git picks first.
  const sourceRefs = facts.sourceRefs
  if (pushSources(hit).some((src, i) => !Array.isArray(sourceRefs) || sourceRefs[i] !== branchRef(src))) return true
  return dsts?.length !== 1 || dsts.some(d => !isPlainBranch(d) || isProtected(d) || tags.includes(d))
}

// ---- Traps the rules name ---------------------------------------------------

export type Trap = { id: string; klasse: 'sec008' | 'regel'; title: string; why: string; fix: string }

// `$NAME`, `${NAME…}`, and zsh's parameter flags in front of the name that still expand the value: `${(U)NAME}`,
// `${=NAME}`, `${~NAME}`, `${^NAME}` (#1699). Not `${#NAME}` (the length) or `${+NAME}` (set or not).
const PARAM_OPEN = String.raw`\$(?:\{(?:\([^()]*\)|[=~^])*)?`
const SECRET_VAR = new RegExp(String.raw`${PARAM_OPEN}((?:[A-Z][A-Z0-9_]*)?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|_KEY|_PAT))\b`)

// .env, .envrc, .env.<x>, .env-<x>, .env_<x>, <name>.env, and a glob reaching them (`.env*`) — but not the committed templates.
const ENV_FILE = /^(?:\.env(?:rc)?|\.env[._-][\w.-]+|[\w.-]+\.env|\.env[._-]?[*?[].*)$/
const ENV_TEMPLATE = /(?:^|[._-])(?:example|sample|template|schema)(?:[._-]|$)/i

function isEnvFile(arg: string): boolean {
  const base = arg.replace(/^\d*</, '').split('/').pop() ?? ''
  return ENV_FILE.test(base) && !ENV_TEMPLATE.test(base)
}

// Commands that print the content of a file they are given.
const ENV_READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'nl', 'strings', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'gawk', 'cut', 'sort', 'uniq', 'tac', 'rev', 'xxd', 'od', 'hexdump', 'hd', 'base64', 'base32', 'basenc', 'diff', 'paste', 'column', 'jq', 'yq', 'tr', 'fold', 'fmt', 'pr', 'expand', 'iconv'])

// `s/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p` under -n: the key of each KEY=value line and nothing else
// (each class holds only the exact tokens A-Z, a-z, 0-9 and _, so it cannot span `=`: `[--z]` does).
const SED_KEY_GROUP = /^s\/\^?\\\((?:\[(?:A-Z|a-z|0-9|_)+\][*+]?)+\\\)=\.\*\/\\1\/p$/
// `s/=.*//`: strips the value of each line; accepted only as a filter behind an env dump.
const SED_STRIP = /^s\/=\.\*\/\/g?$/
const AWK_KEY = /^\{\s*print\s+\$1\s*;?\s*\}$/

const unquote = (value: string | undefined): string | undefined => value?.replace(/["']/g, '')

// A sed call whose one script prints keys only: the -n key-group form, and the value strip when `allowStrip`.
function sedKeysOnly(args: readonly string[], allowStrip: boolean): boolean {
  let quiet = false
  const scripts: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') quiet = true
    else if (arg === '-e' || arg === '--expression') {
      scripts.push(args[i + 1] ?? '')
      i += 1
    } else if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') continue
    else if (arg.startsWith('-')) return false
    else scripts.push(arg)
  }
  const [script] = scripts
  return scripts.length === 1 && script !== undefined && ((quiet && SED_KEY_GROUP.test(script)) || (allowStrip && SED_STRIP.test(script)))
}

/** `cut -d= -f1` exactly (also `-d '='`, `--fields=1`, `-s`): `-f1-`, `-f1,2` and `--complement` print values. */
function cutKeysOnly(args: readonly string[]): boolean {
  let delimiter: string | undefined
  let fields: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '-d' || arg === '--delimiter') {
      delimiter = args[i + 1]
      i += 1
    } else if (arg.startsWith('--delimiter=')) delimiter = arg.slice('--delimiter='.length)
    else if (arg.startsWith('-d')) delimiter = arg.slice(2)
    else if (arg === '-f' || arg === '--fields') {
      fields = args[i + 1]
      i += 1
    } else if (arg.startsWith('--fields=')) fields = arg.slice('--fields='.length)
    else if (arg.startsWith('-f')) fields = arg.slice(2)
    else if (arg !== '-s' && arg !== '--only-delimited') return false
  }
  return unquote(delimiter) === '=' && unquote(fields) === '1'
}

/** `awk -F= '{print $1}'` exactly: any other program (`{print $1, $2}`) prints values. */
function awkKeysOnly(args: readonly string[]): boolean {
  let separator: string | undefined
  const programs: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '-F') {
      separator = args[i + 1]
      i += 1
    } else if (arg.startsWith('-F')) separator = arg.slice(2)
    else if (arg.startsWith('-')) return false
    else programs.push(arg)
  }
  return unquote(separator) === '=' && programs.length === 1 && AWK_KEY.test(programs[0] ?? '')
}

/** A pipeline stage that cuts an env dump down to its keys. */
function isKeysOnlyFilter(stage: string): boolean {
  const [first, ...args] = commandWords(stage)
  const cmd = baseName(first ?? '')
  if (cmd === 'cut') return cutKeysOnly(args)
  if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk') return awkKeysOnly(args)
  return cmd === 'sed' && sedKeysOnly(args, true)
}

/** A reader of a .env file that prints no value: `grep -q`/`-c`/`-l`, or the keys-only sed of the trap's own fix. */
function readsKeysOnly(cmd: string, args: readonly string[]): boolean {
  if (cmd === 'grep' || cmd === 'egrep' || cmd === 'fgrep' || cmd === 'rg') {
    return args.some(a => /^-[A-Za-z]*[qcl]/.test(a) || ['--quiet', '--silent', '--count', '--files-with-matches', '--files-without-match'].includes(a))
  }
  return cmd === 'sed' && sedKeysOnly(args.filter(a => !isEnvFile(a)), false)
}

/**
 * Where a stage's output goes, from every output redirection read in order: `stdout` when fd 1 is redirected and
 * EVERY fd-1 target is `/dev/null` (zsh MULTIOS writes to each listed target, so `>&2 >/dev/null` still prints),
 * `stderr` likewise for fd 2, where `2>&1` counts only when fd 1 already points at `/dev/null` alone. `&>`, `>&file`
 * set both. A quoted, unknown or closed (`>&-`) target, or a descriptor copy elsewhere, keeps it printing (fail-closed).
 * `moved`: fd 1 itself is redirected anywhere (`>&2`, `>file`, `&>`), so a pipe after the stage receives none of it (#1649);
 * `>&1` copies fd 1 onto itself and moves nothing. An fd-1 or fd-2 `<&` / `<>` reopens that descriptor too: bash's
 * `>/dev/null 1<&2` points fd 1 back at stderr and prints (#1696), so it is read as `>&` / `>`; `0<&2` is stdin and moves no output.
 * `fileOk`: a file target that also counts as silent (the heredoc file writes, {@link safeFileTarget}); default none.
 */
function outputSilence(stage: string, fileOk: (target: string) => boolean = () => false): { stdout: boolean; stderr: boolean; moved: boolean } {
  const raw = rawWords(stripGroup(stage))
  const out = { set: false, silent: true }
  const err = { set: false, silent: true }
  let moved = false
  const send = (fd: typeof out, silent: boolean): void => {
    fd.set = true
    fd.silent &&= silent
  }
  for (let i = 0; i < raw.length; i += 1) {
    const m = /^(\d*|&)(>&|>>|>\||>)(.*)$/s.exec(raw[i] ?? '') ?? /^([12])(<&|<>)(.*)$/s.exec(raw[i] ?? '')
    if (m === null) continue
    const [, fd = '', written = '', inline = ''] = m
    const op = written === '<&' ? '>&' : written === '<>' ? '>' : written
    let to = inline
    if (to === '') {
      i += 1
      to = raw[i] ?? ''
    }
    const copy = op === '>&' && /^(?:\d+|-)$/.test(to)
    const silent = to === '/dev/null' || fileOk(to)
    if (fd === '2') send(err, copy ? to === '1' && out.set && out.silent : silent)
    else if (fd === '' || fd === '1') {
      moved ||= !(copy && to === '1')
      send(out, !copy && silent)
      if (op === '>&' && !copy) send(err, silent)
    } else if (fd === '&') {
      moved = true
      send(out, silent)
      send(err, silent)
    } else {
      // fd 3 and above: a copy of stdout or stderr (`3>&1 >/dev/null`) lets the program write past the /dev/null.
      send(out, false)
      send(err, false)
    }
  }
  return { stdout: out.set && out.silent, stderr: err.set && err.silent, moved }
}

// Digests print a hash of what they read, never the input: `-c`/`--check` (reads a checklist, prints its
// names) and BSD md5's `-p` (echoes stdin) are excluded below.
const DIGEST = /^(?:sha\d*sum|shasum|md5sum|md5|b2sum|b3sum|cksum)$/

/** `curl --config -` / `-K -` / `--config=-` / `-K-`: the config, and the secret in it, is read from stdin. */
function curlConfigStdin(args: readonly string[]): boolean {
  return args.some((arg, i) => ((arg === '-K' || arg === '--config') && args[i + 1] === '-') || arg === '-K-' || arg === '--config=-')
}

// The curl options that print what the config set: `-v` / `--verbose` and `--trace*` the request headers,
// `--libcurl` the options as C code (#1706 item 1). A short group counts when its letters reach a `v` (`-sv`).
// `-w` / `--write-out` is read by {@link curlPrints}. curl 8.x accepts the same long options that take an
// argument under an `--expand-` prefix (`--expand-libcurl`, `--expand-write-out`), so the prefix counts too.
// NAMED CEILING (BV-004): a `verbose` / `trace` / `write-out` line inside the stdin config itself is not read; revisit
// if a config that sets them shows up.
const CURL_PRINTS = /^(?:-[A-Za-z]*v|--(?:verbose|(?:expand-)?(?:trace(?:-ascii)?|libcurl))(?:=|$))/
// The `-w` variables that print only status, counts, sizes and timings, never a value the config set. An allow list
// on purpose: `%{url}`, `%{url_effective}`, `%{url.*}`, `%{urle.*}`, `%{json}`, `%{header_json}`, `%header{…}`,
// `%{referer}`, `%{errormsg}` and every variable a later curl adds count as printing.
const CURL_QUIET_VARS: ReadonlySet<string> = new Set([
  'http_code', 'response_code', 'http_connect', 'http_version', 'exitcode', 'num_connects', 'num_redirects',
  'num_headers', 'num_retries', 'size_download', 'size_upload', 'size_header', 'size_request', 'speed_download',
  'speed_upload', 'ssl_verify_result', 'proxy_ssl_verify_result', 'time_appconnect', 'time_connect',
  'time_namelookup', 'time_pretransfer', 'time_posttransfer', 'time_queue', 'time_redirect', 'time_starttransfer',
  'time_total', 'stdout', 'stderr',
])

/**
 * Whether a `-w` / `--write-out` format can print what the config set: a `@file` or `$`/backtick format (unreadable
 * here), or any `%` that is not `%%` or a {@link CURL_QUIET_VARS} variable (`-w "%{http_code}\n"` prints nothing of it).
 */
function writeOutPrints(format: string | undefined): boolean {
  if (format === undefined || format.startsWith('@') || /[$`]/.test(format)) return true
  for (const m of format.replace(/%%/g, '').matchAll(/%(?:\{([^}]*)\})?/g)) if (!CURL_QUIET_VARS.has(m[1] ?? '')) return true
  return false
}

/**
 * Whether a curl command line prints the config it read: {@link CURL_PRINTS}, or a `-w` / `--write-out` whose format
 * {@link writeOutPrints} (`-w FMT`, `-wFMT`, `-sw FMT`, `--write-out FMT`, `--write-out=FMT`, and the same with
 * `--expand-write-out`, whose `{{variable}}` may hold any format and so counts as printing).
 */
function curlPrints(args: readonly string[]): boolean {
  return args.some((arg, i) => {
    if (CURL_PRINTS.test(arg)) return true
    const long = /^--(expand-)?write-out(?:=(.*))?$/s.exec(arg)
    if (long !== null) {
      const format = long[2] ?? args[i + 1]
      return (long[1] !== undefined && format?.includes('{{') === true) || writeOutPrints(format)
    }
    // A short group: the letters after `w` are its value, otherwise the next word is.
    const group = /^-[A-Za-z]*?w(.*)$/s.exec(arg)
    if (group === null || arg.startsWith('--')) return false
    return writeOutPrints(group[1] === '' ? args[i + 1] : group[1])
  })
}

// Registry clients whose `login --password-stdin` reads the password from stdin and prints only a status line.
const STDIN_LOGIN = /^(?:docker|podman|nerdctl|buildah|skopeo|oras)$/
// Commands that run other commands or shell code: what they run may print stdin anywhere (`sh -c "cat >/dev/tty"`).
const RUNNERS = new Set(['xargs', 'parallel', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'su', 'script', 'env', 'exec', 'command', 'nohup', 'time', 'eval', 'sudo', 'nice', 'timeout', 'gtimeout', 'caffeinate', 'builtin'])

/**
 * A named login that takes its secret on stdin silently, the flag read at the login's own position:
 * `docker|podman|nerdctl|buildah|skopeo|oras login … --password-stdin`, `helm registry login … --password-stdin`,
 * `crane auth login … --password-stdin`, `gh auth login … --with-token`, `glab auth login … --stdin`.
 */
function stdinLogin(cmd: string, args: readonly string[]): boolean {
  if (STDIN_LOGIN.test(cmd)) return args[0] === 'login' && args.includes('--password-stdin')
  if (cmd === 'helm') return args[0] === 'registry' && args[1] === 'login' && args.includes('--password-stdin')
  if (cmd === 'crane') return args[0] === 'auth' && args[1] === 'login' && args.includes('--password-stdin')
  if (cmd === 'gh') return args[0] === 'auth' && args[1] === 'login' && args.includes('--with-token')
  if (cmd === 'glab') return args[0] === 'auth' && args[1] === 'login' && args.includes('--stdin')
  return false
}

// The compound commands whose body inherits the stdin of their head (`while read -r l; do echo "$l"; done`).
const COMPOUND_HEADS = new Set(['while', 'until', 'if', 'for', 'select', 'case'])

/**
 * Whether a stage is only the head of a group or compound command that the pipeline split cut at its `;` or `&&`
 * (`{ true >/dev/null 2>&1; cat; }`, `while read -r l; do echo "$l"; done`): the commands behind the cut read the
 * same stdin and this stage cannot see them, so it never counts as silent (#1649, fail-closed). More leading `(`/`{`
 * than trailing `)`/`}` means the group runs on; one pass from each end. NAMED CEILING (BV-004): a whole group of
 * silent commands (`{ sha256sum; }`) is refused too instead of being read across the cut; revisit if such a form is
 * needed in practice.
 */
function cutCompound(stage: string): boolean {
  let open = 0
  let i = 0
  for (; i < stage.length && /[\s({]/.test(stage[i] ?? ''); i += 1) if (stage[i] === '(' || stage[i] === '{') open += 1
  let close = 0
  for (let j = stage.length; j > i && /[\s)}]/.test(stage[j - 1] ?? ''); j -= 1) if (stage[j - 1] === ')' || stage[j - 1] === '}') close += 1
  if (open > close) return true
  for (const word of argWords(stripGroup(stage))) {
    if (COMPOUND_HEADS.has(word)) return true
    if (!PREFIXES.has(word)) break
  }
  return false
}

/**
 * The allow list part of {@link consumesSilently}: a command that prints no part of what it reads wherever its
 * output goes (a digest, `openssl dgst`, `wc`, `read`, `curl --config -`, a named stdin login).
 */
function printsNoInput(stage: string): boolean {
  if (cutCompound(stage)) return false
  const [first, ...args] = commandWords(stage)
  const cmd = baseName(first ?? '')
  if (DIGEST.test(cmd)) return !args.some(a => a === '--check' || /^-[A-Za-z]*[cp]/.test(a))
  if (cmd === 'openssl') return /^(?:dgst|sha\d*|md5)$/.test(args[0] ?? '')
  if (cmd === 'wc' || cmd === 'read') return true
  if (cmd === 'curl' && curlConfigStdin(args)) return !curlPrints(args)
  return stdinLogin(cmd, args)
}

/**
 * The variables a `read` stage sets (`read -r a b`, `IFS= read -r l`, `command read x`, `builtin read x`, zsh's
 * `read 'x?prompt'`), or null when the stage is no `read`. REPLY always counts: an option value (`-p Enter`) is
 * not told apart from a name, so the default variable is never lost. NAMED CEILING (BV-004): option values are read
 * as names too (more names, never fewer); revisit if that taints a name that is printed in practice.
 */
function readNames(stage: string): string[] | null {
  if (cutCompound(stage)) return null
  const words = commandWords(stage)
  const at = words[0] === 'builtin' ? 1 : 0
  if (baseName(words[at] ?? '') !== 'read') return null
  const names = words.slice(at + 1).map(w => w.split('?')[0] ?? '').filter(w => /^[A-Za-z_][A-Za-z0-9_]*$/.test(w))
  return [...names, 'REPLY']
}

const VAR_REF = new RegExp(String.raw`${PARAM_OPEN}([A-Za-z_][A-Za-z0-9_]*)`, 'g')

/** The first secret variable a stage expands: a secret-shaped name, or one a `read` filled with a secret (#1695). */
function secretRef(text: string, tainted: ReadonlySet<string>): string | undefined {
  const named = SECRET_VAR.exec(text)?.[1]
  if (named !== undefined || tainted.size === 0) return named
  for (const m of text.matchAll(VAR_REF)) if (tainted.has(m[1] ?? '')) return m[1]
  return undefined
}

/**
 * A stage that reads a secret from stdin and prints none of it (an allow list, #1569 point 1): a digest,
 * `openssl dgst`, `wc`, `read`, `curl --config -`, a named stdin login ({@link stdinLogin}), or a command other than
 * `tee` and a runner whose stdout AND stderr both go only to `/dev/null` ({@link outputSilence}). Everything else
 * (`perl -pe1`, `gzip`, `base64`, `python3 -c …`, `xargs echo --password-stdin`) counts as re-printing.
 */
function consumesSilently(stage: string): boolean {
  if (cutCompound(stage)) return false
  if (printsNoInput(stage)) return true
  const [first] = commandWords(stage)
  const cmd = baseName(first ?? '')
  // A runner stripped as a prefix by commandWords (`eval`, `exec`, `sudo`) still counts: any word before the command.
  // Unlocated (-1): every word is read, fail-closed. A cut-out `sh -c '…'` / `eval '…'` sits here as its placeholder word.
  const words = argWords(stripGroup(stage))
  const at = words.indexOf(first ?? '')
  if (cmd === 'tee' || (at === -1 ? words : words.slice(0, at + 1)).some(w => RUNNERS.has(baseName(w)) || INNER_WORD.test(w))) return false
  const silence = outputSilence(stage)
  return silence.stdout && silence.stderr
}

// The env options that take a separate value; `-S` / `--split-string` runs its string as a command.
const ENV_DUMP_VALUED = new Set(['-u', '--unset', '-C', '--chdir'])

/**
 * Whether the words (prefixes already removed) print variable values, judged by the command and its
 * arguments, not by their number: `env`/`env -0`/`env -i` with no command left, `printenv` with no name or a
 * secret one, bare `export`/`readonly` (options only), bare `set` (`set -e` sets options), `declare`/`typeset`
 * with no name (`declare -x`, `-p`) or with a set secret name and no `=` (zsh prints it). `env FOO=1 cmd`
 * runs cmd; `export FOO=bar` and `declare -i n` print nothing. A secret name is secret-shaped or one of
 * `tainted` (a `read` or an assignment filled it with a secret: `read x; printenv x`, #1699).
 */
function dumpsEnvironment(words: readonly string[], tainted: ReadonlySet<string> = new Set()): boolean {
  const [first, ...args] = words
  const cmd = baseName(first ?? '')
  const secretName = (name: string): boolean => SECRET_VAR.test(`$${name}`) || tainted.has(name)
  if (cmd === 'env') {
    let i = 0
    while (i < args.length) {
      const arg = args[i] ?? ''
      if (arg === '--') {
        i += 1
        break
      }
      if (arg.startsWith('-S') || arg.startsWith('--split-string')) return false
      if (arg === '-' || !arg.startsWith('-')) break
      i += ENV_DUMP_VALUED.has(arg) ? 2 : 1
    }
    while (i < args.length && ASSIGNMENT.test(args[i] ?? '')) i += 1
    return i >= args.length
  }
  // printenv prints every variable it is given: one secret name among several still prints (#1572 T2).
  if (cmd === 'printenv') {
    const names = args.filter(a => !a.startsWith('-'))
    return names.length === 0 || names.some(secretName)
  }
  if (cmd === 'export' || cmd === 'readonly') return args.every(a => a.startsWith('-'))
  if (cmd === 'set') return args.length === 0
  if (cmd === 'declare' || cmd === 'typeset') {
    if (args.some(a => /^-[A-Za-z]*[fF]/.test(a))) return false
    const names = args.filter(a => !/^[-+]/.test(a))
    return names.length === 0 || names.some(name => !name.includes('=') && secretName(name))
  }
  return false
}

/**
 * Every trap the rules name in a shell command, once per id, in reading order. All of them, not the
 * first: on `locker` a `regel` trap only warns, so `git add -A && cat .env` must still carry the SEC-008 one.
 */
export function findTraps(command: string): Trap[] {
  const line = dataView(joinContinuations(command))
  const found = collectTraps(line, 0, line, new Set(), command)
  return found.filter((trap, i) => found.findIndex(other => other.id === trap.id) === i)
}

/**
 * `raw`: the text the heredoc reader scans — the command as written at the top (the data view drops text heredocs,
 * bodies and all), the inner command line itself below it.
 */
function collectTraps(line: string, depth: number, root: string, inherited: ReadonlySet<string> = new Set(), raw = line): Trap[] {
  const found: Trap[] = []
  const { text, inners } = extractInner(line, depth)
  // The read taint of the whole line, so an inner `sh -c "echo $x"` / `eval "echo $x"` sees the `read x` before it
  // (#1695). Ceiling: a `read` AFTER the inner command taints it too (fail-closed over-detection); revisit if that
  // false alarm shows up in practice.
  const lineTaint = new Set(inherited)
  for (const stages of splitPipelines(text)) echoedSecrets(stages, lineTaint)
  // A child shell (`sh -c '…'`) reads an exported name from its environment, single quotes or not (#1699):
  // `read x; export x; sh -c 'echo $x'`. Ceiling as above: an export after the inner command counts too; `set -a`
  // (export everything) is not read — revisit if it shows up in practice.
  const exported = new Set<string>()
  for (const segment of splitSegments(text)) {
    const [head, ...rest] = commandWords(segment)
    if (head !== 'export' && !(DECLARERS.has(head ?? '') && rest.some(arg => /^-[A-Za-z]*x/.test(arg)))) continue
    for (const arg of rest) exported.add(/^[A-Za-z_][A-Za-z0-9_]*/.exec(arg)?.[0] ?? '')
  }
  const innerTaint = (inner: Inner): Set<string> => {
    const names = [...inner.expanded.matchAll(VAR_REF)].map(m => m[1] ?? '').filter(name => lineTaint.has(name))
    if (!inner.sameShell) for (const m of inner.command.matchAll(VAR_REF)) if (exported.has(m[1] ?? '') && lineTaint.has(m[1] ?? '')) names.push(m[1] ?? '')
    return new Set(names)
  }
  for (const segment of splitSegments(text)) {
    const words = commandWords(segment)
    const [first, ...args] = words
    if (first === undefined) continue
    const inner = innerAt(first, inners)
    if (inner !== null) {
      found.push(...collectTraps(inner.command, depth + 1, root, innerTaint(inner)))
      continue
    }
    // A cut-out `bash -c '…'` behind another word still runs (`flock /tmp/l bash -c "cat .env"`, #1572 T1).
    for (const word of DATA_COMMANDS.has(baseName(first)) ? [] : args) {
      const later = innerAt(word, inners)
      if (later !== null) found.push(...collectTraps(later.command, depth + 1, root, innerTaint(later)))
    }
    const cmd = baseName(first)

    if (
      cmd === 'claude' &&
      args.some(a => a === '-p' || a === '--print') &&
      !/env\s+(-\S+\s+)*-u\s+ANTHROPIC_API_KEY\b|unset\s+ANTHROPIC_API_KEY\b/.test(root)
    ) {
      found.push({
        id: 'claude-p-oauth',
        klasse: 'regel',
        title: 'claude -p ohne env -u ANTHROPIC_API_KEY',
        why: 'claude -p erbt sonst den ANTHROPIC_API_KEY aus älteren Shells und rechnet über die bezahlte API ab statt über OAuth (Memory "claude -p nur über OAuth").',
        fix: `env -u ANTHROPIC_API_KEY ${segment.trim()}`,
      })
    }

    if (ENV_READERS.has(cmd) && args.some(isEnvFile) && !readsKeysOnly(cmd, args)) {
      const file = args.find(isEnvFile) ?? '.env'
      found.push({
        id: 'sec008-env-datei',
        klasse: 'sec008',
        title: `${cmd} ${file}`,
        why: 'Gibt Secret-Werte in Transkript und Log aus (SEC-008: never emit, do not mask).',
        fix: `sed -n 's/^\\([A-Z_][A-Z0-9_]*\\)=.*/\\1/p' ${file}   # nur die Schlüssel`,
      })
    }

    if (cmd === 'docker' && (args[0] === 'inspect' || (args[0] === 'container' && args[1] === 'inspect'))) {
      const formatted = args.some(a => a === '-f' || a === '--format' || a.startsWith('--format=') || /^-f./.test(a))
      if (!formatted) {
        found.push({
          id: 'sec008-docker-inspect',
          klasse: 'sec008',
          title: 'docker inspect ohne --format',
          why: 'docker inspect druckt Config.Env im Klartext (SEC-008).',
          fix: "docker exec <container> printenv | cut -s -d= -f1 | sort   # oder: docker inspect -f '{{.State.Status}}' <container>",
        })
      }
    }

    if (cmd === 'git' && args[0] === 'add' && args.slice(1).some(a => a === '.' || a === '-A' || a === '--all' || a === ':/')) {
      found.push({
        id: 'commit-discipline-add',
        klasse: 'regel',
        title: 'git add . / -A / --all',
        why: 'Pauschales Stagen nimmt die Arbeit paralleler Sessions mit (commit-discipline, PSA-004).',
        fix: 'git add <datei> <datei> …   # einzeln nach Namen, dann git diff --cached prüfen',
      })
    }

    if (cmd === 'curl') {
      if (/-H\s*["']?Authorization:\s*(Bearer|token)\s+\$|--header\s*["']?Authorization:\s*(Bearer|token)\s+\$/i.test(segment)) {
        found.push({
          id: 'sec008-secret-argv',
          klasse: 'sec008',
          title: 'Token in curl-Argumenten',
          why: 'Argumente sind für jeden lokalen User in ps lesbar und landen in Shell-History und Logs (SEC-008).',
          fix: `printf 'header = "Authorization: Bearer %s"' "$TOKEN" | curl --config - <url>`,
        })
      }
      if (/[?&](access_token|private_token|api_key|apikey|token|key)=\$/i.test(segment)) {
        found.push({
          id: 'sec008-token-in-url',
          klasse: 'sec008',
          title: 'Token in der URL',
          why: 'Query-Strings landen in Server-, Proxy- und Referer-Logs (SEC-008).',
          fix: 'Token als Header über curl --config - übergeben, nie in der URL.',
        })
      }
    }
  }

  if (/\$\{?PIPESTATUS\[/.test(text)) {
    found.push({
      id: 'zsh-pipestatus',
      klasse: 'regel',
      title: '${PIPESTATUS[0]} in zsh',
      why: 'Die Shell hier ist zsh: ${PIPESTATUS[0]} ist leer, und ein leeres EXIT= liest sich wie Erfolg (bash-harness-pitfalls §6).',
      fix: 'cmd > /tmp/out.log 2>&1; rc=$?; tail -5 /tmp/out.log; echo "EXIT=$rc"',
    })
  }

  if (/\bgrep\s+(?:-[A-Za-z]*c[A-Za-z]*|--count)\b[^\n]*?\|\|\s*echo\s+["']?0["']?/.test(text)) {
    found.push({
      id: 'grep-c-echo-0',
      klasse: 'regel',
      title: 'grep -c … || echo 0',
      why: 'grep -c druckt bei keinem Treffer selbst 0 und endet mit 1: das Ergebnis ist "0\\n0" und bricht jeden Zahlenvergleich (bash-harness-pitfalls §1).',
      fix: 'count=$(grep -c "MUSTER" datei || true)',
    })
  }

  const tainted = new Set(inherited)
  for (const stages of splitPipelines(text)) {
    // Not commandWords: a bare `env` is the command here, not a prefix. `if env; then` runs it too,
    // and so do `(env)`, `command env`, `builtin set` and `FOO=1 env`.
    const head = argWords(stripGroup(stages[0] ?? ''), true)
    while (PREFIXES.has(head[0] ?? '') || head[0] === 'builtin' || ASSIGNMENT.test(head[0] ?? '')) head.shift()
    // The keys-only filter must read the dump directly: `env | tee /dev/stderr | cut -d= -f1` printed it first.
    // `printenv NAME` prints the bare value with no `=`, so no filter makes it keys-only.
    const filtered = !(baseName(head[0] ?? '') === 'printenv' && head.slice(1).some(a => !a.startsWith('-'))) && isKeysOnlyFilter(stages[1] ?? '')
    if (dumpsEnvironment(head, tainted) && !filtered) {
      found.push({
        id: 'sec008-env-dump',
        klasse: 'sec008',
        title: `${head.join(' ')} ohne Filter`,
        why: 'Ein Umgebungs-Dump druckt jeden Token-Wert ins Transkript (SEC-008).',
        fix: 'env | cut -s -d= -f1 | sort   # Schlüssel; Einzelwert: test -n "${VAR:-}" && echo "VAR: set"',
      })
    }
    found.push(...echoedSecrets(stages, tainted))
  }
  const heredoc = heredocTrap(raw, lineTaint)
  if (heredoc !== null) found.push(heredoc)
  return found
}

// A plain file name the heredoc file exemption accepts: relative segments or `~/` in front, no `..`, no leading `/`
// (`//dev/stdout`, `/dev/fd/1`, `/proc/self/fd/1`), no quote, `$`, glob or leading `-`. NAMED CEILING (BV-004): an
// absolute path (`/tmp/x`) and a symlink planted by an earlier command are not told apart from a device, so the
// first is refused and the second allowed; revisit if `cat > /tmp/x <<EOF` with a secret is needed in practice.
// A relative name resolves against the cwd and `~/` against HOME, so a text that changes either (`cd /dev; cat >
// stdout`, `HOME=/dev; cat > ~/stdout`, #1696 M6) gets no exemption at all ({@link movesTargets}). The cwd a
// previous Bash call left behind, and zsh AUTO_CD (a bare directory name changes it), stay invisible: named ceiling.
// movesTargets is a denylist over the raw text, so deliberate obfuscation passes it (`c\d /dev`, `'c'd /dev`,
// `eval 'HO''ME=/dev'`, zsh `chdir` and `${HOME::=/dev}`, measured by the #1696 review round 2; CDPATH is matched in
// every form, `${CDPATH:=…}` included, see {@link MOVES_HOME}); revisit with a
// one-statement-only exemption when that becomes a real attack shape rather than a constructed one.
const SAFE_FILE = /^(?:~\/)?(?!-)(?:[\w.@+,=%-]+\/)*[\w.@+,=%-]+$/
const TEE_OPTIONS = new Set(['-a', '--append', '-i', '--ignore-interrupts'])
// A `cd` / `pushd` / `popd` word anywhere (quoted or inner commands included), the word after it, and the start of a
// second operand on the same line (zsh `cd old new` swaps `old` for `new` inside the cwd).
const MOVES_CWD = /(?<![\w./-])(cd|pushd|popd)(?![\w./-])[ \t]*([^\s;&|()<>]*)([ \t]+[^\s;&|()<>])?/g
// A HOME that is not only expanded, and any mention of CDPATH or zsh's tied `cdpath` array: CDPATH sends a relative
// `cd fd` to `/dev/fd` (`CDPATH=/dev cd fd`, `cdpath=(/dev)`, `: ${CDPATH:=/dev}`). CDPATH is usually unset, so an
// assign-on-expand form takes effect; it counts even only expanded (`$CDPATH`), a false alarm accepted (fail-closed).
// HOME is always set, so `${HOME:=…}` changes nothing; `${HOME::=…}` stays the obfuscation ceiling above.
// NAMED CEILING (BV-004): a CDPATH exported by an earlier Bash call is not in the text; revisit if one shows up.
const MOVES_HOME = /(?<![\w${])HOME\b|(?<!\w)(?:CDPATH|cdpath)\b/
// A directory a `cd` may move to and keep the exemption: plain segments, absolute, relative or `~/`, no `..`.
const SAFE_DIR = /^(?:~\/|\/)?(?!-)(?:[\w.@+,=%-]+\/)*[\w.@+,=%-]+\/?$/
// The first segments under which a device sits (`/dev`, `/dev/fd`, `/proc/self/fd`), also relative to a cwd of `/`;
// compared lower-cased, since APFS resolves `/DEV/stdout` and `/Dev/Fd` to the devices.
const DEVICE_ROOTS: ReadonlySet<string> = new Set(['dev', 'proc'])

function safeFileTarget(target: string): boolean {
  return SAFE_FILE.test(target) && !target.split('/').includes('..')
}

/**
 * Whether the text may move the cwd or HOME a relative heredoc file target resolves against (#1696 M6). A `cd` /
 * `pushd` into a plain directory outside `/dev` and `/proc` keeps the exemption (`cd ~/repo && cat > .env`, #1706
 * item 6): the word after it is judged, not where the `cd` stands, so a quoted or `eval`-ed `cd /dev` still counts.
 * Any other word after it (none, `-`, an option, `..`, a quote or `$`), a second operand (zsh `cd old new`), and
 * every `popd` count as moving.
 * NAMED CEILING (BV-004): a `cd` written only as text (`git commit -m "cd x"`) with an unplain word after it still
 * withholds the exemption (fail-closed), and a plain directory that is a symlink to a device is the planted-symlink
 * ceiling above; revisit with a quote-aware command-position reading if the false alarm shows up in practice.
 */
function movesTargets(text: string): boolean {
  if (MOVES_HOME.test(text)) return true
  for (const [, cmd, dir = '', second] of text.matchAll(MOVES_CWD)) {
    // The first segment that names a directory: `/./dev` and `./dev` reach `dev` too.
    const top = dir.replace(/^~\//, '').split('/').find(segment => segment !== '' && segment !== '.') ?? ''
    if (cmd === 'popd' || second !== undefined || !SAFE_DIR.test(dir) || dir.split('/').includes('..') || DEVICE_ROOTS.has(top.toLowerCase())) return true
  }
  return false
}

// A run of characters a file name is written with, and the output operator (`>`, `>>`, `>|`) right before it.
const NAME_RUN = /(>[|>]?[ \t]*)?([^\s;&|()<>"'`$\\]+)/g

// Commands that name a file without printing what is in it (`chmod 600 ~/.npmrc` after writing it): a denylist, so
// any other command that names the file counts as reading it (fail-closed).
// `source` / `.` are not among them: they run the file, and a body line run that way prints (`command not found: …`).
const FILE_META: ReadonlySet<string> = new Set(['chmod', 'chown', 'chgrp', 'rm', 'unlink', 'touch', 'test', '[', '[[', 'ls', 'stat'])

/**
 * How often each file base name appears in the text other than as an output redirect target (`cat .npmrc`,
 * `< .npmrc`, `"$HOME/.npmrc"`, an operand of `tee`) outside a {@link FILE_META} command, and the base names of the
 * output targets. One pass over the segments.
 */
function fileNames(text: string): { reads: Map<string, number>; targets: string[] } {
  const reads = new Map<string, number>()
  const targets: string[] = []
  for (const segment of splitSegments(text)) {
    const meta = FILE_META.has(baseName(commandWords(segment)[0] ?? ''))
    for (const [, op, name = ''] of segment.matchAll(NAME_RUN)) {
      const base = name.split('/').pop() ?? name
      if (op !== undefined) targets.push(base)
      else if (!meta) reads.set(base, (reads.get(base) ?? 0) + 1)
    }
  }
  return { reads, targets }
}

/**
 * Whether a file the stage writes is named again elsewhere in the text, where another command may print it:
 * `cat > .npmrc <<EOF … EOF; cat .npmrc` (#1706 item 2). Judged by base name over the whole text, read once.
 * NAMED CEILING (BV-004): order is not read (a read BEFORE the write withholds too) and a mention in a body or a
 * quote counts (both fail-closed); a read through another name (`cat ~/.n*`) is not seen. Revisit if either shows up.
 */
function namedAgain(stage: string, reads: ReadonlyMap<string, number>): boolean {
  const own = fileNames(stage)
  const [first, ...args] = commandWords(stage)
  // `tee` names the files it writes as operands; they count as written, and once among the stage's own names.
  const operands = baseName(first ?? '') === 'tee' ? args.filter(arg => !arg.startsWith('-')).map(arg => arg.split('/').pop() ?? arg) : []
  return [...own.targets, ...operands].some(base => (reads.get(base) ?? 0) > (own.reads.get(base) ?? 0))
}

/**
 * A stage that writes what it reads into files only: `cat` (no operand but `-`) or `tee` (its options and plain
 * file operands) with every fd-1 target a {@link safeFileTarget} or `/dev/null`, and no pipe after it — zsh MULTIOS
 * writes `cat >o <<EOF | cat` into both. `1<&2` / `>&2` keep fd 1 on a terminal ({@link outputSilence}).
 */
function writesFilesOnly(stage: string): boolean {
  if (cutCompound(stage)) return false
  const [first, ...args] = commandWords(stage)
  const cmd = baseName(first ?? '')
  const operands = cmd === 'cat' ? args.every(arg => arg === '-') : cmd === 'tee' && args.every(arg => TEE_OPTIONS.has(arg) || safeFileTarget(arg))
  return operands && outputSilence(stage, safeFileTarget).stdout
}

/**
 * Whether the stage a heredoc feeds prints its body: the {@link echoedSecrets} reading of a here-string (a stage
 * that prints none of its input, or a silent consumer after the pipe, prints nothing), plus the file writes of
 * {@link writesFilesOnly}. A heredoc inside `$(…)`, a backtick or `<(…)`, a stage the scanner could not delimit,
 * and a `read` (it fills a variable a later command may print) count as printing — fail-closed. `filesExempt`
 * false (the text moves the cwd or HOME, {@link movesTargets}) withholds the file exemption, and so does a written
 * file the text names again ({@link namedAgain}, `reads` from {@link fileNames} over the whole text).
 */
function heredocPrints({ text: stage, next, nested }: HeredocStage, filesExempt: boolean, reads: ReadonlyMap<string, number>): boolean {
  if (nested || stage === null || readNames(stage) !== null) return true
  if (filesExempt && next === undefined && writesFilesOnly(stage) && !namedAgain(stage, reads)) return false
  if (printsNoInput(stage)) return false
  const quiet = consumesSilently(stage)
  if (next === undefined) return !quiet
  return next === null || !consumesSilently(next) || (outputSilence(stage).moved && !quiet)
}

// A `printenv` substitution in a body line and its words up to the closing `)` or backtick.
const PRINTENV_SUBST = /(?:\$\(|`)[ \t]*(?:command[ \t]+)?printenv((?:[ \t]+[^\s)`]+)+)/g

/**
 * The first secret a heredoc body line expands: a secret-shaped or tainted `$name` / `${name`, or a `printenv` of
 * one in a substitution, not after an odd run of `\`.
 */
function bodySecret(line: string, tainted: ReadonlySet<string>): string | undefined {
  const unescaped = (at: number): boolean => {
    let slashes = 0
    for (let j = at - 1; j >= 0 && line[j] === '\\'; j -= 1) slashes += 1
    return slashes % 2 === 0
  }
  const secret = (name: string): boolean => SECRET_VAR.test(`$${name}`) || tainted.has(name)
  for (const m of line.matchAll(VAR_REF)) {
    const name = m[1] ?? ''
    if (secret(name) && unescaped(m.index ?? 0)) return name
  }
  // `$(printenv NAME)` / `` `printenv NAME` `` substitutes the value as `echo $(printenv NAME)` prints it (#1706 item 3).
  for (const m of line.matchAll(PRINTENV_SUBST)) {
    const name = (m[1] ?? '').split(/\s+/).find(secret)
    if (name !== undefined && unescaped(m.index ?? 0)) return name
  }
  return undefined
}

/**
 * The SEC-008 trap of a heredoc whose unquoted body expands a secret into a stage that prints it (#1696), read by
 * {@link scanHeredocs} in one linear pass. A text the scanner cannot read safely (an unbalanced quote, more
 * heredocs on a line than it queues, an operator without a delimiter) traps only when it names a secret anywhere.
 */
function heredocTrap(text: string, tainted: ReadonlySet<string>): Trap | null {
  if (!text.includes('<<') && !text.includes("'") && !text.includes('"')) return null
  const filesExempt = !movesTargets(text)
  // Read once, and only when a body with a secret asks for a verdict.
  let reads: Map<string, number> | undefined
  const finding = scanHeredocs(text, line => bodySecret(line, tainted), stage => heredocPrints(stage, filesExempt, (reads ??= fileNames(text).reads)))
  if (finding === null) return null
  const name = finding.kind === 'body' ? finding.name : (SECRET_VAR.exec(text)?.[1] ?? bodySecret(text, tainted))
  if (name === undefined) return null
  return {
    id: 'sec008-echo-secret',
    klasse: 'sec008',
    title: finding.kind === 'body' ? `<<${finding.delimiter} $${name}` : `unlesbare Quote-/Heredoc-Form mit $${name}`,
    why: finding.kind === 'body'
      ? 'Ein Heredoc mit ungequotetem Delimiter setzt den Wert ein und druckt ihn ins Transkript (SEC-008).'
      : 'Quotes oder Heredocs sind nicht sicher lesbar, und eine Secret-Variable kommt vor (SEC-008, fail-closed).',
    fix: `test -n "\${${name}:-}" && echo "${name}: set"; echo "\${#${name}}"   # gesetzt? Länge?`,
  }
}

// The builtins that print their arguments: echo, printf and zsh's print (#1699).
const PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf', 'print'])
// A function definition head as one word: `f()`, `f(){` (#1699).
const FUNCTION_HEAD = /^[\w.:-]+\(\)\{?$/

/**
 * The command a stage runs, read past `builtin` (`builtin echo`) and past a function definition head (`f() {`,
 * `f () (`, `function f {`): a printer in a function body is reported where it is defined, whether or not the
 * function is called later (#1699) — simpler than following calls, and a defined body is meant to run.
 * NAMED CEILING (BV-004): a redirect after the closing brace (`f() { echo "$T"; } >/dev/null`) sits in another stage
 * and is not seen, so that silenced body still reports; revisit if such a definition shows up in practice.
 */
function printerCommand(stage: string): string {
  const words = commandWords(stage)
  let at = 0
  if (words[0] === 'function') at = words[2] === '()' ? 3 : 2
  else if (FUNCTION_HEAD.test(words[0] ?? '')) at = 1
  else if (words[1] === '()') at = 2
  if (at > 0 && (words[at] === '{' || words[at] === '(')) at += 1
  if (words[at] === 'builtin') at += 1
  return baseName(words[at] ?? '')
}

/**
 * Adds to `tainted` the names a stage assigns a secret or tainted value (`x=$T_TOKEN`, `y=$x`, `export x="$T"`),
 * so a later `echo "$x"` reads as printing it (#1699), like a name a `read` filled. Only assignments the shell keeps:
 * a stage of nothing but assignments, or the operands of a declaring builtin — `x=$T cmd` sets x for cmd's
 * environment only. NAMED CEILING (BV-004): a value that reaches the secret through a command (`x=$(printenv T)`)
 * or an expansion operator (`: ${x:=$T}`) is not followed, and a single-quoted `x='$T'` taints too (fail-closed);
 * revisit if one of them shows up in practice.
 */
function assignedSecrets(stage: string, tainted: Set<string>): void {
  const words = rawWords(stripGroup(stage))
  const declarer = DECLARERS.has(words[0] ?? '')
  if (!declarer && !words.every(word => ASSIGNMENT.test(word))) return
  for (const word of declarer ? words.slice(1) : words) {
    const name = ASSIGNMENT.exec(word)?.[1]
    if (name !== undefined && secretRef(word.slice(word.indexOf('=') + 1), tainted) !== undefined) tainted.add(name)
  }
}

/**
 * The stages of one pipeline that print a secret: an echoed secret, or one fed as a here-string (`cat <<< "$TOKEN"`),
 * reaches the transcript unless the stage itself discards it or the stage directly after consumes it silently (an
 * allow list: anything else re-prints). With a pipe after it the stage writes into the pipe even when its fd 1 is
 * redirected (zsh MULTIOS: `echo "$TOKEN" >/dev/null | cat` prints, #1696), and the redirect target receives it too
 * (`echo "$TOKEN" >&2 | sha256sum` prints it on stderr, #1649) — both shells' readings are judged.
 * `tainted` carries the variables a `read` filled with a secret across the pipelines of the line: zsh runs the last
 * stage in the current shell, so `echo "$TOKEN" | read -r x; echo "$x"` prints it (#1695); a here-string `read`
 * keeps it in every shell. A `read` in an earlier stage runs in a subshell and sets nothing here.
 */
function echoedSecrets(stages: readonly string[], tainted: Set<string>): Trap[] {
  const found: Trap[] = []
  let carries = false
  for (let k = 0; k < stages.length; k += 1) {
    const stage = stages[k] ?? ''
    assignedSecrets(stage, tainted)
    const stageCmd = printerCommand(stage)
    const echoed = PRINTERS.has(stageCmd) ? secretRef(stage, tainted) : undefined
    const hereString = stage.indexOf('<<<')
    const fed = hereString === -1 ? undefined : secretRef(stage.slice(hereString), tainted)
    // Fail-closed: any earlier stage that names a secret may feed it to a `read` at the end, redirected or not (MULTIOS).
    if (k === stages.length - 1 && (carries || fed !== undefined)) for (const name of readNames(stage) ?? []) tainted.add(name)
    carries ||= secretRef(stage, tainted) !== undefined
    const name = echoed ?? fed
    if (name === undefined || (echoed === undefined && printsNoInput(stage))) continue
    // echo writes nothing to stderr, so its stdout alone decides; bash's printf prints a bad numeric argument
    // (`printf %d "$TOKEN"`) on stderr and zsh's `print -u2` writes there, so both need both.
    const silence = outputSilence(stage)
    const quiet = echoed !== undefined ? silence.stdout && (stageCmd === 'echo' || silence.stderr) : consumesSilently(stage)
    const piped = k + 1 < stages.length
    const printed = piped ? !consumesSilently(stages[k + 1] ?? '') || (silence.moved && !quiet) : !quiet
    if (printed) {
      found.push({
        id: 'sec008-echo-secret',
        klasse: 'sec008',
        title: echoed !== undefined ? `echo $${name}` : `<<< $${name}`,
        why: 'Druckt den Wert ins Transkript (SEC-008). Prüfen geht ohne Ausgabe.',
        fix: `test -n "\${${name}:-}" && echo "${name}: set"; echo "\${#${name}}"   # gesetzt? Länge?`,
      })
    }
  }
  return found
}

export type Profil = 'locker' | 'ausgewogen' | 'streng'

export type Verdict = { aktion: 'laufen' } | { aktion: 'warnen'; text: string } | { aktion: 'ablehnen'; text: string }

/**
 * What the gate does with the traps of one command. A SEC-008 trap refuses on every profile; rule
 * traps only warn on `locker` and refuse otherwise. Any profile not exactly `locker` refuses (fail-closed).
 */
export function trapVerdict(traps: readonly Trap[], profil: Profil): Verdict {
  if (traps.length === 0) return { aktion: 'laufen' }
  const text = traps.map(trap => `[so-hud · Regel-Falle ${trap.id}] ${trap.why}\nStattdessen: ${trap.fix}`).join('\n')
  return profil === 'locker' && traps.every(trap => trap.klasse === 'regel') ? { aktion: 'warnen', text } : { aktion: 'ablehnen', text }
}

// ---- Collisions with a peer's wave scope (F8) --------------------------------

/**
 * Whether a path matches one SO wave-scope entry, with the semantics of SO's own
 * `pathMatchesPattern` (scripts/lib/scope-gate.mjs), mirrored because a mod cannot import it:
 * exact path; a trailing `/` is a directory prefix; `*` stays within one segment; `**` spans any
 * depth, `**\/` also zero segments. Case-sensitive; an empty pattern never matches.
 */
export function scopeMatches(relPath: string, pattern: string): boolean {
  if (!pattern) return false
  if (pattern.endsWith('/')) return relPath.startsWith(pattern)
  const regex = pattern
    .replace(/[.+?|[\](){}\\^$]/g, ch => `\\${ch}`)
    .replace(/\*\*\//g, '<<DBLS>>')
    .replace(/\*\*/g, '<<DBLG>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DBLS>>/g, '(.*\\/)?')
    .replace(/<<DBLG>>/g, '.*')
  return new RegExp(`^${regex}$`).test(relPath)
}

/** An absolute path with `.`, `..` and repeated slashes resolved, by string operations only. */
function normalizeAbsolute(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export type ScopePeer = { session_id: string; gleiches_working_copy: boolean; scope_paths: readonly string[] | null }
export type Collision = { session_id: string; pattern: string }

/**
 * Which live peers in this working copy hold the file in their wave scope. Peers in another working
 * copy and this session itself never collide; a peer without a readable scope is listed in
 * `unknownScope` instead (it can neither be proven disjoint nor shown to collide). A file outside
 * `repoRoot` lies in no peer's working copy: no hits and no unknown scopes. Absolute scope entries
 * are matched against the absolute path, all others against the repo-relative one.
 */
export function findCollisions(input: {
  filePath: string
  repoRoot: string
  ownSessionId: string | null
  peers: readonly ScopePeer[]
}): { hits: Collision[]; unknownScope: string[] } {
  const hits: Collision[] = []
  const unknownScope: string[] = []
  const root = normalizeAbsolute(input.repoRoot)
  const file = normalizeAbsolute(input.filePath)
  if (root === '/' || !file.startsWith(`${root}/`)) return { hits, unknownScope }
  const rel = file.slice(root.length + 1)
  for (const peer of input.peers) {
    if (peer.gleiches_working_copy !== true || peer.session_id === input.ownSessionId) continue
    if (peer.scope_paths === null) {
      unknownScope.push(peer.session_id)
      continue
    }
    for (const pattern of peer.scope_paths) {
      if (scopeMatches(pattern.startsWith('/') ? file : rel, pattern)) hits.push({ session_id: peer.session_id, pattern })
    }
  }
  return { hits, unknownScope }
}

export const COLLISION_OPTIONS = ['Trotzdem', 'Worktree vorschlagen', 'Abbrechen'] as const

export type CollisionVerdict =
  | { aktion: 'laufen' }
  | { aktion: 'warnen'; text: string }
  | { aktion: 'fragen'; text: string; optionen: typeof COLLISION_OPTIONS }
  | { aktion: 'ablehnen'; text: string }

/** What the collision guard does per profile: locker warns, ausgewogen asks, streng (and any unknown profile) refuses. */
export function collisionVerdict(hits: readonly Collision[], profil: Profil): CollisionVerdict {
  if (hits.length === 0) return { aktion: 'laufen' }
  const text = hits.map(hit => `[so-hud · Kollision] Peer-Session ${hit.session_id} hat ${hit.pattern} im Wellen-Scope.`).join('\n')
  if (profil === 'locker') return { aktion: 'warnen', text }
  if (profil === 'ausgewogen') return { aktion: 'fragen', text, optionen: COLLISION_OPTIONS }
  return { aktion: 'ablehnen', text: `${text}\nStattdessen: in einem eigenen Worktree weiterarbeiten (git worktree add <pfad> -b <branch>).` }
}

// ---- Secrets in output ------------------------------------------------------

export type SecretHit = { name: string; fp: string }

export const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'Private Key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'GitLab-Token', re: /\bgl(?:pat|dt|rt|ptt|cbt|soat|ffct|imt|oas|agent)-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub-Token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { name: 'Anthropic-Key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI-Key', re: /\bsk-(?:proj-|svcacct-)?(?!ant-)[A-Za-z0-9_-]{32,}/g },
  { name: 'Stripe-Key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { name: 'Stripe-Webhook-Secret', re: /\bwhsec_[A-Za-z0-9]{24,}/g },
  { name: 'AWS-Access-Key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Slack-Token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'Google-API-Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
]

export function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some(({ re }) => (text.match(re)?.length ?? 0) > 0)
}

// The mod's lib is es2023 without DOM types (tsconfig `types: []`), yet Web Crypto and TextEncoder
// are globals in both the mod engine and Node: read them off globalThis in the one shape used here.
type WebGlobals = {
  crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } }
  TextEncoder: new () => { encode(input: string): Uint8Array }
}

async function fingerprint(secret: string): Promise<string> {
  const { crypto, TextEncoder } = globalThis as unknown as WebGlobals
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

/** The text with every secret replaced by its kind and a sha256 fingerprint. */
export async function redactText(text: string, hits: SecretHit[]): Promise<string> {
  let out = text
  for (const { name, re } of SECRET_PATTERNS) {
    for (const secret of new Set(out.match(re) ?? [])) {
      const fp = await fingerprint(secret)
      if (!hits.some(hit => hit.fp === fp)) hits.push({ name, fp })
      out = out.split(secret).join(`[${name} entfernt · sha256:${fp}]`)
    }
  }
  return out
}

/** A copy of any JSON-like value with every string redacted. */
export async function redactDeep(value: unknown, hits: SecretHit[]): Promise<unknown> {
  if (typeof value === 'string') {
    return hasSecret(value) ? redactText(value, hits) : value
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await redactDeep(item, hits))
    return out
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = await redactDeep(item, hits)
    return out
  }
  return value
}
