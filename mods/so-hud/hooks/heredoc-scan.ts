// ---- Heredoc bodies the shell expands (#1696) ---------------------------------
//
// One pass over a command text with an explicit state machine (quotes, `$'…'`, `${…}`, `$(…)`, backticks,
// arithmetic, comments) and a queue of the heredoc operators read on the current line. At a newline that the
// shell reads as a command terminator, the queued bodies follow in order; each body line is read once, so the
// whole scan is linear in the text. The scanner judges nothing itself: `secretIn` names the secret a body line
// expands, `prints` says whether the stage a heredoc feeds reaches the transcript — both supplied by rules.ts.

/** A stage of a pipeline as the scanner cut it: `[start, end)` in the text, -1 while open; `pipe`: the stage after `|`. */
type Stage = { start: number; end: number; pipe: Stage | null; cuts: Array<[number, number]>; verdict: boolean | undefined }

type Pending = { delimiter: string; quoted: boolean; tabs: boolean; stage: Stage; nested: boolean }

/** What a stage feeds: its text without the heredoc operators, and the next stage (`null`: unreadable, `undefined`: none). */
export type HeredocStage = { text: string | null; next: string | null | undefined; nested: boolean }

export type HeredocFinding =
  | { kind: 'body'; name: string; delimiter: string }
  | { kind: 'fail-closed'; reason: 'unbalanced' | 'too-many' | 'no-delimiter' | 'unreadable' }

// Frames of the state machine. `code` frames read commands and heredoc operators; the others only quoting.
type Frame = 'root' | 'subst' | 'paren' | 'procsub' | 'tick' | 'dq' | 'brace' | 'dqbrace' | 'arith' | 'bracket'

// Heredoc operators queued on one line before the bodies are read. Real commands use one or two; past the cap the
// line is not read (the operator count was the lever of the reverted attempt's quadratic run) — fail-closed.
// NAMED CEILING (BV-004): 16; revisit if a legitimate command needs more heredocs on one line.
const MAX_PENDING = 16
// The characters after which an unquoted `#` starts a comment (the start of a word).
const WORD_BREAK = /[\s;&|()<>]/
// Where an unquoted heredoc delimiter word ends. Not `\r`: the shell keeps it in the word, so `<<EOF` on a CRLF line
// closes only at `EOF\r` — ending the word there too keeps the body from running past the shell's closing line.
const WORD_END = /[ \t\n;&|<>()]/

// Reserved words after which the next word is a command again (`if x; then case …`).
const COMMAND_WORDS: ReadonlySet<string> = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'time'])

const CODE: ReadonlySet<Frame> = new Set(['root', 'subst', 'paren', 'procsub', 'tick'])
// Frames whose output a command reads instead of the transcript seeing it directly: judged as printing (fail-closed).
const CAPTURED: ReadonlySet<Frame> = new Set(['subst', 'procsub', 'tick'])

/**
 * Reads every heredoc in `text` and returns the first one whose body expands a secret while its stage prints
 * (`prints`), or a fail-closed finding: an unbalanced quote or construct at the end of the text, more than
 * {@link MAX_PENDING} operators on one line, or an operator without a delimiter word. A quoted delimiter
 * (`<<'EOF'`, `<<"EOF"`, `<<\EOF`, any quote in the word) keeps its body literal and is never a finding. Whether a
 * fail-closed finding matters (a secret named anywhere in the text) is the caller's call. Stops at the first finding.
 */
export function scanHeredocs(
  text: string,
  secretIn: (line: string) => string | undefined,
  prints: (stage: HeredocStage) => boolean,
): HeredocFinding | null {
  const frames: Frame[] = ['root']
  // One open stage per code frame, parallel to `frames` (null for quoting frames).
  const stages: Array<Stage | null> = [newStage(0)]
  let pending: Pending[] = []
  // Per frame: `(`/`[` inside arithmetic, `{` inside a brace, open `case` words inside a code frame.
  const depth: number[] = [0]
  const n = text.length
  // The `)` that ended the last case pattern: the word after it is a command (`a) case y in …`), unlike after `$(x)`.
  let patternClose = -1

  const top = (): Frame => frames[frames.length - 1] ?? 'root'
  const push = (frame: Frame, at: number): void => {
    frames.push(frame)
    stages.push(CODE.has(frame) ? newStage(at) : null)
    depth.push(0)
  }
  const pop = (at: number): void => {
    const stage = stages[stages.length - 1]
    if (stage !== null && stage !== undefined && stage.end === -1) stage.end = at
    frames.pop()
    stages.pop()
    depth.pop()
  }
  // Ends the open stage of the current code frame at `at`; a pipe links it to the stage that starts at `from`.
  const cut = (at: number, from: number, pipe: boolean): void => {
    const stage = stages[stages.length - 1]
    if (stage === null || stage === undefined) return
    stage.end = at
    const next = newStage(from)
    if (pipe) stage.pipe = next
    stages[stages.length - 1] = next
  }
  const nested = (): boolean => frames.some(frame => CAPTURED.has(frame))

  for (let i = 0; i < n; i += 1) {
    const ch = text[i] ?? ''
    const next = text[i + 1] ?? ''
    const frame = top()

    if (frame === 'dq' || frame === 'dqbrace' || frame === 'brace') {
      if (ch === '\\') i += 1
      else if (frame === 'dq' && ch === '"') pop(i)
      else if (frame !== 'dq' && ch === '}') pop(i)
      // A raw `{` inside `${…}` (`"${x:-{}"`): the shells disagree on which `}` closes it — fail-closed (#1696 M2).
      // A nested `${` opens its own frame through openDollar.
      else if (frame !== 'dq' && ch === '{') return { kind: 'fail-closed', reason: 'unreadable' }
      else if (frame !== 'dq' && ch === '"') push('dq', i)
      else if (frame === 'brace' && ch === "'") {
        const close = text.indexOf("'", i + 1)
        if (close === -1) return { kind: 'fail-closed', reason: 'unbalanced' }
        i = close
      } else if (ch === '$' || ch === '`') i = openDollar(i, frame === 'brace' ? 'brace' : 'dqbrace')
      continue
    }
    if (frame === 'arith' || frame === 'bracket') {
      const [open, close] = frame === 'arith' ? ['(', ')'] : ['[', ']']
      const d = depth[depth.length - 1] ?? 0
      // A newline, or `$((`/`((` closed by `) )` instead of `))`, is a command in a subshell, not arithmetic: the
      // shells run `$((cat <<EOF … ) )` (#1696 M1) — fail-closed rather than reading its heredoc as arithmetic.
      if (ch === '\n') return { kind: 'fail-closed', reason: 'unreadable' }
      if (ch === open) depth[depth.length - 1] = d + 1
      else if (ch === close && d > 0) depth[depth.length - 1] = d - 1
      else if (ch === close) {
        if (frame === 'arith' && next !== ')') return { kind: 'fail-closed', reason: 'unreadable' }
        if (frame === 'arith') i += 1
        pop(i)
      }
      continue
    }

    // A code frame.
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === "'") {
      const close = text.indexOf("'", i + 1)
      if (close === -1) return { kind: 'fail-closed', reason: 'unbalanced' }
      i = close
      continue
    }
    if (ch === '"') {
      push('dq', i)
      continue
    }
    if (ch === '$' || ch === '`') {
      if (ch === '`' && frame === 'tick') pop(i)
      else i = openDollar(i, 'code')
      continue
    }
    if (ch === '#' && (i === 0 || WORD_BREAK.test(text[i - 1] ?? ''))) {
      const nl = text.indexOf('\n', i)
      i = (nl === -1 ? n : nl) - 1
      continue
    }
    if (ch === '<' && next === '<' && text[i + 2] === '<') {
      i += 2
      continue
    }
    if (ch === '<' && next === '<') {
      const op = readOperator(i + 2)
      if (op === null) return { kind: 'fail-closed', reason: 'no-delimiter' }
      if (op === 'unbalanced') return { kind: 'fail-closed', reason: 'unbalanced' }
      const stage = stages[stages.length - 1] ?? newStage(i)
      stage.cuts.push([i, op.end])
      pending.push({ delimiter: op.delimiter, quoted: op.quoted, tabs: op.tabs, stage, nested: nested() })
      if (pending.length > MAX_PENDING) return { kind: 'fail-closed', reason: 'too-many' }
      i = op.end - 1
      continue
    }
    if ((ch === '<' || ch === '>') && next === '(') {
      push('procsub', i + 2)
      i += 1
      continue
    }
    if (ch === '(' && next === '(') {
      push('arith', i)
      i += 1
      continue
    }
    if (ch === '(') {
      cut(i, i + 1, false)
      push('paren', i + 1)
      continue
    }
    if ((ch === 'c' || ch === 'e') && (i === 0 || WORD_BREAK.test(text[i - 1] ?? '')) && commandPosition(i)) {
      // In a code frame the depth counts open `case` words: the `)` after a pattern closes no `$(` (#1696:
      // `"$(case x in x) cat <<A;; esac …)"` read the `)` as the end and the heredoc as quoted text). Only in
      // command position: `echo esac` is an argument and closes nothing (M3).
      const word = /^(?:case|esac)(?=[ \t\n;&|<>()]|$)/.exec(text.slice(i, i + 5))?.[0]
      const d = depth[depth.length - 1] ?? 0
      if (word === 'case') depth[depth.length - 1] = d + 1
      else if (word === 'esac' && d > 0) depth[depth.length - 1] = d - 1
      if (word !== undefined) i += 3
      continue
    }
    if (ch === ')') {
      if ((depth[depth.length - 1] ?? 0) > 0) patternClose = i
      else if (frame === 'subst' || frame === 'paren' || frame === 'procsub') pop(i)
      continue
    }
    if (ch === '|') {
      if (next === '|') {
        cut(i, i + 2, false)
        i += 1
      } else {
        cut(i, i + (next === '&' ? 2 : 1), true)
        if (next === '&') i += 1
      }
      continue
    }
    if (ch === ';' || ch === '&') {
      // `&&`, `;;`, a lone `&` end the command; `&>` / `>&` / `<&` are redirections, read with the stage.
      if (ch === '&' && (next === '>' || text[i - 1] === '>' || text[i - 1] === '<')) continue
      const width = next === ch ? 2 : 1
      cut(i, i + width, false)
      i += width - 1
      continue
    }
    if (ch === '\n') {
      cut(i, i + 1, false)
      if (pending.length === 0) continue
      const found = readBodies(i + 1)
      if (typeof found !== 'number') return found
      pending = []
      // The bodies end at `found`, the start of the next command line; the code frame is unchanged.
      const stage = stages[stages.length - 1]
      if (stage !== null && stage !== undefined) stage.start = found
      i = found - 1
    }
  }
  // Operators on the last line with no newline after them have no body.
  return frames.length === 1 ? null : { kind: 'fail-closed', reason: 'unbalanced' }

  /**
   * Whether the word at `at` stands where a command starts: at the text start, after `;`, `&`, `|`, `(`, `{`, a
   * backtick, a newline or the `)` of a case pattern, or after a reserved word that takes a command (`then`, `do`, …). Reads back over the
   * blanks and the one word before `at` only, so every character is read back at most once (linear).
   */
  function commandPosition(at: number): boolean {
    let p = at - 1
    while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p -= 1
    if (p < 0 || p === patternClose || /[;&|({`\n]/.test(text[p] ?? '')) return true
    let w = p
    while (w >= 0 && /[a-z!]/.test(text[w] ?? '')) w -= 1
    if (w >= 0 && !/[\s;&|({`]/.test(text[w] ?? '')) return false
    return COMMAND_WORDS.has(text.slice(w + 1, p + 1))
  }

  /** Opens the construct a `$` or backtick at `at` starts; returns the index the loop continues from. */
  function openDollar(at: number, context: 'code' | 'brace' | 'dqbrace'): number {
    const ch = text[at]
    const next = text[at + 1]
    if (ch === '`') {
      push('tick', at + 1)
      return at
    }
    if (next === '(' && text[at + 2] === '(') {
      push('arith', at)
      return at + 2
    }
    if (next === '(') {
      push('subst', at + 2)
      return at + 1
    }
    if (next === '[') {
      push('bracket', at)
      return at + 1
    }
    if (next === '{') {
      push(context === 'code' || context === 'brace' ? 'brace' : 'dqbrace', at)
      return at + 1
    }
    if (next === "'" && context !== 'dqbrace') {
      // `$'…'`: a backslash escapes the next character, `\'` included.
      for (let j = at + 2; j < n; j += 1) {
        if (text[j] === '\\') j += 1
        else if (text[j] === "'") return j
      }
      return n
    }
    return at
  }

  /** The delimiter word after `<<` at `from`; null when there is none, 'unbalanced' for an open quote in it. */
  function readOperator(from: number): { delimiter: string; quoted: boolean; tabs: boolean; end: number } | null | 'unbalanced' {
    let j = from
    const tabs = text[j] === '-'
    if (tabs) j += 1
    while (text[j] === ' ' || text[j] === '\t') j += 1
    const parts: string[] = []
    let quoted = false
    for (; j < n; j += 1) {
      const c = text[j] ?? ''
      if (WORD_END.test(c)) break
      // A substitution in the delimiter word (`<<$(x)`): the shells take it literally, this reading would end the
      // word at its `(` — fail-closed instead of guessing (#1696 M4).
      if ((c === '$' && text[j + 1] === '(') || c === '`') return null
      if (c === '\\') {
        // `\` + newline continues the line and quotes nothing: `<<EO\<LF>F` is the unquoted delimiter EOF.
        if (text[j + 1] !== '\n') {
          quoted = true
          parts.push(text[j + 1] ?? '')
        }
        j += 1
      } else if (c === "'" || c === '"') {
        quoted = true
        let k = j + 1
        for (; k < n && text[k] !== c; k += 1) {
          if (c === '"' && text[k] === '\\') k += 1
        }
        if (k >= n) return 'unbalanced'
        parts.push(text.slice(j + 1, k))
        j = k
      } else parts.push(c)
    }
    const delimiter = parts.join('')
    return delimiter === '' && !quoted ? null : { delimiter, quoted, tabs, end: j }
  }

  /**
   * Reads the queued bodies from `from` in order: each runs to its closing line or to the end of the text. Returns
   * the index past the last closing line, or the first finding. Each stage is judged at most once (its verdict is
   * kept), so many heredocs feeding one stage cost one judgement.
   */
  function readBodies(from: number): number | HeredocFinding {
    let at = from
    for (const doc of pending) {
      let hit = false
      let closed = false
      // An unquoted body joins a line that ends in an odd run of `\` with the next one, as the shell does: neither
      // `foo\` + `EOF` closes the body nor does `$T_TO\` + `KEN` hide the name. A quoted body keeps every line.
      let carried = ''
      // Whether the current physical line continues an earlier one: `carried` alone cannot tell, because a continued
      // line that was only `\` leaves it empty (#1696 R2: `<<-EOF`, `\`, `<tab>EOF` does not close in zsh).
      let continued = false
      while (at <= n) {
        const nl = text.indexOf('\n', at)
        const end = nl === -1 ? n : nl
        let physical = text.slice(at, end)
        at = nl === -1 ? n + 1 : nl + 1
        // `<<-` strips the tabs at the start of the logical line only: a continued line keeps its own (#1696 M5).
        if (doc.tabs && !continued) physical = physical.replace(/^\t+/, '')
        if (!doc.quoted && nl !== -1 && oddSlashes(physical)) {
          carried += physical.slice(0, -1)
          continued = true
          continue
        }
        const line = carried + physical
        carried = ''
        continued = false
        if (line === doc.delimiter) {
          closed = true
          break
        }
        if (hit) continue
        const name = secretIn(line)
        if (name === undefined) continue
        hit = true
        if (!doc.quoted && judge(doc)) return { kind: 'body', name, delimiter: doc.delimiter }
      }
      // A literal body that never closes swallowed the rest of the text unread: if the shell closed it where this
      // reading did not (a delimiter told apart differently), a secret behind it went unseen — fail-closed.
      if (doc.quoted && hit && !closed) return { kind: 'fail-closed', reason: 'unbalanced' }
    }
    return Math.min(at, n)
  }

  function judge(doc: Pending): boolean {
    const { stage } = doc
    if (stage.verdict === undefined) {
      const pipe = stage.pipe
      stage.verdict = prints({
        text: stage.end === -1 ? null : stageText(stage),
        next: pipe === null ? undefined : pipe.end === -1 ? null : stageText(pipe),
        nested: doc.nested,
      })
    }
    return stage.verdict
  }

  function stageText(stage: Stage): string {
    let out = ''
    let from = stage.start
    for (const [a, b] of stage.cuts) {
      out += `${text.slice(from, a)} `
      from = b
    }
    return out + text.slice(from, stage.end)
  }
}

/** Whether a line ends in an odd run of backslashes (the last one escapes the newline). */
function oddSlashes(line: string): boolean {
  let count = 0
  for (let j = line.length - 1; j >= 0 && line[j] === '\\'; j -= 1) count += 1
  return count % 2 === 1
}

function newStage(start: number): Stage {
  return { start, end: -1, pipe: null, cuts: [], verdict: undefined }
}
