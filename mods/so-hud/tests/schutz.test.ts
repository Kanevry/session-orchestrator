import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'
import type { SoBeacon, SoSnapshot } from '../types/index'

// Engine tests for the so-hud protection gates (#1551). Each test names the bug it catches.
const at = '2026-10-10T15:10:00.000Z'
type Peer = SoSnapshot['peers'][number]
type Profile = 'locker' | 'ausgewogen' | 'streng'
type Git = (args: readonly string[]) => { exitCode: number; stdout: string }
const CONFIRM = ['Weiter zur Bestätigung', 'Jetzt genau einmal ausführen']
const peer = (session_id: string, scope_paths: string[] | null): Peer => ({
  session_id, branch: null, status: null, current_wave: 1, last_heartbeat: at, gleiches_working_copy: true, scope_paths,
})
const REPO_KEYS = 'config --null --show-scope --list'
// git in a repo on `main` tracking origin/main, remote known, no tags.
const onMain: Git = (args) => {
  const line = args.join(' ')
  if (line === 'rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n' }
  if (line === 'rev-parse --abbrev-ref @{u}') return { exitCode: 0, stdout: 'origin/main\n' }
  if (line === 'config branch.main.remote') return { exitCode: 0, stdout: 'origin\n' }
  if (line === 'config --get remote.origin.url') return { exitCode: 0, stdout: 'git@example.org:team/repo.git\n' }
  if (line === 'log --oneline -n 10 origin/main..HEAD') return { exitCode: 0, stdout: 'abc1234 fix: eins\n' }
  // The repository's keys (#1573): an everyday clone, nothing that runs a program.
  if (line === REPO_KEYS) return { exitCode: 0, stdout: 'global\0credential.helper\nosxkeychain\0local\0core.bare\nfalse\0local\0remote.origin.url\ngit@example.org:team/repo.git\0' }
  return { exitCode: 1, stdout: '' }
}
// Every other git call, the six `git config --null` reads of the push configuration (#1569) included,
// falls through to onMain's last line: exit 1, nothing printed — unset.
const onFeature: Git = (args) => {
  const line = args.join(' ')
  if (line === 'rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'feat/x\n' }
  if (line === 'rev-parse --abbrev-ref @{u}') return { exitCode: 0, stdout: 'origin/feat/x\n' }
  if (line === 'config branch.feat/x.remote') return { exitCode: 0, stdout: 'origin\n' }
  if (line === 'rev-parse --symbolic-full-name feat/x') return { exitCode: 0, stdout: 'refs/heads/feat/x\n' }
  return onMain(args)
}

// The mod's lib has no DOM types; Web Crypto and TextEncoder are globals here as in the mod engine.
type WebGlobals = {
  crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } }
  TextEncoder: new () => { encode(input: string): Uint8Array }
}
/** lead-session-orchestrator ADR-009's argv_sha256: SHA-256 of the UTF-8 of `JSON.stringify(argv)`, the tool name standing for the program. */
async function argvSha256(argv: string[]): Promise<string> {
  const { crypto, TextEncoder } = globalThis as unknown as WebGlobals
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(argv)))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

type Options = {
  peers?: Peer[]
  git?: Git | 'throws'
  /** The owner's answer per question; null dismisses the dialog. */
  /** Answers the question with a permission deny (the host's Esc), instead of {@link answer}. */
  askDeny?: string
  answer?: (question: string, labels: string[]) => Promise<string | null> | string | null
  output?: { result: unknown; text?: string; isError?: true }
  /** What `$.session.surfaces()` returns; empty is a plain -p run. */
  surfaces?: RenderSurface[] | 'throws'
  /** Answers the `bash -c <cd script> so-hud <dir>` folder probe with this folder; unset: no bash probe expected. */
  cdTo?: string
  /** Answers the `bash -c <list script> so-hud-hooks <dir>` hooks folder listing; unset: no listing expected. */
  hooksDir?: { exitCode: number; stdout: string }
  /** Answers the same listing per folder (`argv[4]`), before {@link hooksDir}: husky's `_` and the folder above it (#1574). */
  hookDirs?: Record<string, { exitCode: number; stdout: string }>
  /** The exit code of the `bash -c <husky check> so-hud-husky <dir> <stub> <prefix> <names…>`; unset: no check expected. */
  husky?: number
  /** Answers the `bash -c <count script> so-hud-gitlinks` gitlink count; unset: none counted (`0`). */
  gitlinks?: { exitCode: number; stdout: string }
}
function world(on: On, o: Options = {}) {
  const runs: string[] = []
  // Every process the gate started, in order: `git <args>` or `bash <name>` for a named script.
  const procs: string[] = []
  const asks: string[] = []
  const toasts: string[] = []
  const receipts: Record<string, unknown>[] = []
  const writes: SoBeacon[] = []
  const state = { idFails: false }
  const clock = mock.clock(on, { now: Date.parse(at) })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  const snapshot = {
    schema_version: 1, measured_at: at, repo: { root: '/repo', name: 'repo' }, lock: null, session: null,
    wave: { running: true, number: 2, role: 'Impl-Core', agents_total: 3, source: null },
    agents: { entries: [], source: null, at: null, degraded: null },
    state: { status: 'active', session_type: 'deep', current_wave: 2, total_waves: 5 },
    gate: { last: null, last_green_sha: null }, peers: o.peers ?? [],
    vault: { enabled: false, mode: 'warn', last_run: null, board: null }, degraded: [],
  }
  on('fs.read', () => ({ value: '' }))
  on('fs.list', () => ({ value: [] }))
  on('session.id', () => { if (state.idFails) throw new Error('session id unavailable'); return { value: 'test-session' } })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'sonnet' }))
  on('session.surfaces', () => { if (o.surfaces === 'throws') throw new Error('surfaces unavailable'); return { value: o.surfaces ?? [] } })
  on('session.usage', () => ({ value: { startedAt: Date.parse(at), context: { window: 200000, tokens: 40000, percent: 20 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('process.run', (_$, e) => {
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const argv = e.argv
    procs.push(argv[0] === 'bash' && argv[3] !== undefined ? `bash ${argv[3]}` : argv.join(' '))
    if (argv[0] === 'git') {
      if (o.git === 'throws') throw new Error('git unavailable')
      const r = (o.git ?? onMain)(argv.slice(1))
      return ok(r.stdout, r.exitCode)
    }
    const listing = argv[0] === 'bash' && argv[3] === 'so-hud-hooks' ? o.hookDirs?.[argv[4] ?? ''] ?? o.hooksDir : undefined
    if (listing !== undefined) return ok(listing.stdout, listing.exitCode)
    if (argv[0] === 'bash' && argv[3] === 'so-hud-husky' && o.husky !== undefined) { procs.push(`husky-names ${argv.slice(7).join(' ')}`); return ok('', o.husky) }
    if (argv[0] === 'bash' && argv[3] === 'so-hud-gitlinks') return ok(o.gitlinks?.stdout ?? '0\n', o.gitlinks?.exitCode ?? 0)
    if (argv[0] === 'bash' && o.cdTo !== undefined) return ok(`${o.cdTo}\n`)
    if (argv.some(a => a.endsWith('/scripts/so-hud.mjs'))) return ok(JSON.stringify(snapshot))
    if (argv.includes('identity')) return ok('{"pid":123}')
    if (argv.includes('alive')) return ok('[123]')
    if (argv.includes('write')) { writes.push(JSON.parse(e.init?.stdin ?? '{}') as SoBeacon); return ok('null') }
    if (argv.includes('aktion')) { receipts.push(JSON.parse(e.init?.stdin ?? '{}') as Record<string, unknown>); return ok('null') }
    throw new Error(`Unexpected process: ${argv.join(' ')}`)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  // Core beneath the plugin: answers the owner's dialog, counts every real tool run.
  on('tool.call', async (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      if (o.askDeny !== undefined) return { deny: o.askDeny } as never
      const q = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions[0]
      asks.push(q?.question ?? '')
      const label = o.answer ? await o.answer(q?.question ?? '', q?.options.map(x => x.label) ?? []) : null
      return (label === null ? { result: {}, text: '' } : { result: { answers: { [q?.question ?? '']: label } }, text: label }) as never
    }
    runs.push(e.tool)
    return (o.output ?? { result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never
  })
  return { runs, asks, toasts, receipts, writes, clock, state, procs }
}
const opts = (strictness: Profile = 'ausgewogen') => ({ options: { soRoot: '/so', strictness } })
const bash = (command: string) => ({ tool: 'Bash' as const, command })
const monitor = (command: string) => ({ tool: 'Monitor' as const, description: 'watch', timeout_ms: 1000, command })
const edit = { tool: 'Edit' as const, file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }

// ---- Traps ------------------------------------------------------------------------
for (const profile of ['locker', 'ausgewogen', 'streng'] as const) {
  // Catches: a SEC-008 trap only warned on some profile, letting `cat .env.local` print secrets.
  test(`SEC-008 trap is refused on ${profile}; core never runs`, opts(profile), async ($, on) => {
    const w = world(on)
    const answer = await $.tool.call(bash('cat .env.local'))
    expect(JSON.stringify(answer)).toContain('sec008-env-datei')
    expect(w.runs).toEqual([])
  })
}
// Catches: the profile dial ignored — a rule trap refused on locker or merely warned on ausgewogen.
test('rule trap warns and runs on locker', opts('locker'), async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('git add -A'))
  expect(w.runs).toEqual(['Bash'])
  expect(w.toasts.join('\n')).toContain('commit-discipline-add')
})
// Catches: a Monitor command bypassing the traps the same text meets in Bash.
test('a Monitor command reading .env is refused; core never runs', opts(), async ($, on) => {
  const w = world(on)
  expect(JSON.stringify(await $.tool.call(monitor('cat .env')))).toContain('sec008')
  expect(w.runs).toEqual([])
})
test('rule trap is refused on ausgewogen', opts(), async ($, on) => {
  const w = world(on)
  expect(JSON.stringify(await $.tool.call(bash('git add -A')))).toContain('commit-discipline-add')
  expect(w.runs).toEqual([])
})

// ---- Outward actions (F9) ----------------------------------------------------------
// Catches: a push to main running without two explicit owner steps, running twice, or leaving no receipt.
test('push to main runs exactly once after both confirmation steps, with a receipt', opts(), async ($, on) => {
  const w = world(on, { answer: (_q, labels) => labels.find(l => CONFIRM.includes(l)) ?? null })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('git push origin main'))
  expect(w.runs).toEqual(['Bash'])
  expect(w.asks).toHaveLength(2)
  expect(w.asks[0]).toContain('abc1234 fix: eins')
  expect(w.asks[1]).toContain('abc1234 fix: eins')
  expect(w.receipts).toHaveLength(1)
  expect(w.receipts[0]).toMatchObject({ aktion: 'aussenwirkung', ergebnis: 'ausgefuehrt', exit: 0, art: 'push', profil: 'ausgewogen', session_id: 'test-session' })
  // Catches: the receipt hashing the bare command string instead of the ADR-009 (lead-session-orchestrator) vector [tool, command].
  expect(w.receipts[0]?.argv_sha256).toBe(await argvSha256(['Bash', 'git push origin main']))
})
// Catches: a declined first step still running the push.
test('push declined at step one never runs', opts(), async ($, on) => {
  const w = world(on, { answer: () => 'Ablehnen' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const answer = JSON.stringify(await $.tool.call(bash('git push origin main')))
  expect(answer).toContain('nicht erneut versuchen')
  expect(w.runs).toEqual([])
  expect(w.receipts[0]).toMatchObject({ ergebnis: 'abgelehnt', exit: null })
})
// Catches: a question that could not be shown being reported to the model as the owner's refusal (#1856).
test('a failed question at step one is not the owner declining; nothing runs', opts(), async ($, on) => {
  const w = world(on, { answer: () => { throw new Error('dialog not available') } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const answer = JSON.stringify(await $.tool.call(bash('git push origin main')))
  expect(answer).toContain('nicht entschieden')
  expect(answer).not.toContain('abgelehnt')
  expect(w.runs).toEqual([])
  expect(w.receipts[0]).toMatchObject({ ergebnis: 'fehler', exit: null })
})
// Catches: the owner's Esc (a permission deny with text) being booked as a failed question instead of a refusal (#1856).
test('Esc on the outward-action dialog stays the owner declining', opts(), async ($, on) => {
  const w = world(on, { askDeny: "The user doesn't want to proceed with this tool use. The tool use was rejected." })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const answer = JSON.stringify(await $.tool.call(bash('git push origin main')))
  expect(answer).toContain('Der Owner hat')
  expect(w.runs).toEqual([])
  expect(w.receipts[0]).toMatchObject({ ergebnis: 'abgelehnt', exit: null })
})
// Catches: the same misreport when only the second confirmation fails to show (#1856).
test('a failed question at step two is not the owner declining; nothing runs', opts(), async ($, on) => {
  const w = world(on, {
    answer: (_q, labels) => {
      if (labels.includes(CONFIRM[1] ?? '')) throw new Error('dialog not available')
      return labels.find(l => CONFIRM.includes(l)) ?? null
    },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const answer = JSON.stringify(await $.tool.call(bash('git push origin main')))
  expect(answer).toContain('nicht entschieden')
  expect(answer).not.toContain('abgelehnt')
  expect(w.asks).toHaveLength(2)
  expect(w.runs).toEqual([])
  expect(w.receipts[0]).toMatchObject({ ergebnis: 'fehler', exit: null })
})
// Catches: step two confirming a push whose outgoing commits changed after step one was answered.
test('push facts that change between the steps are not confirmed; nothing runs', opts(), async ($, on) => {
  let commits = 'abc1234 fix: eins\n'
  const git: Git = args => args.join(' ') === 'log --oneline -n 10 origin/main..HEAD' ? { exitCode: 0, stdout: commits } : onMain(args)
  const w = world(on, { git, answer: (_q, labels) => { commits += 'def5678 fix: zwei\n'; return labels.find(l => CONFIRM.includes(l)) ?? null } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.tool.call(bash('git push origin main')))).toContain('Stand hat sich geändert')
  expect(w.asks).toHaveLength(1)
  expect(w.runs).toEqual([])
  expect(w.receipts[0]).toMatchObject({ ergebnis: 'abgelehnt' })
})
// Catches: a confirmation given long after the facts were shown still running the push.
test('second step after 31 s has expired; nothing runs', opts(), async ($, on) => {
  const w = world(on, {
    answer: async (_q, labels) => {
      if (labels.includes(CONFIRM[1] ?? '')) await w.clock.advance(31_000)
      return labels.find(l => CONFIRM.includes(l)) ?? null
    },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.tool.call(bash('git push origin main')))).toContain('Bestätigung verfallen')
  expect(w.runs).toEqual([])
  expect(w.receipts[0]).toMatchObject({ ergebnis: 'verfallen' })
})
// Catches: every feature-branch push nagging the owner (the gate would be clicked through unread).
test('feature-branch push with measured upstream runs without a dialog', opts(), async ($, on) => {
  const w = world(on, { git: onFeature })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('git push origin feat/x'))
  expect(w.asks).toEqual([])
  expect(w.runs).toEqual(['Bash'])
})
// Catches (#1570): a named source branch git does not resolve to `refs/heads/<name>` running unasked — a symbolic ref
// `refs/heads/feat/x` → `refs/heads/main` (git pushes it as `feat/x -> main`), a `refs/feat/x` that git's DWIM picks
// before `refs/heads/feat/x`, or an ambiguous name (rev-parse exits 0 and prints nothing, measured git 2.56.0).
const SOURCE = 'rev-parse --symbolic-full-name feat/x'
for (const [name, command, answer, asks] of [
  ['a symbolic ref to main as the source asks', 'git push origin feat/x', { exitCode: 0, stdout: 'refs/heads/main\n' }, true],
  ['the same through refs/heads/ asks', 'git push origin refs/heads/feat/x', { exitCode: 0, stdout: 'refs/heads/main\n' }, true],
  ['a refs/feat/x shadowing the branch asks', 'git push origin feat/x', { exitCode: 0, stdout: 'refs/feat/x\n' }, true],
  ['an ambiguous name asks', 'git push origin feat/x', { exitCode: 0, stdout: '' }, true],
  ['a failing read asks', 'git push origin feat/x', { exitCode: 128, stdout: 'feat/x\n' }, true],
  ['a plain branch runs', 'git push origin feat/x', undefined, false],
  ['HEAD on a plain branch runs', 'git push -u origin HEAD', undefined, false],
] as const) {
  test(`push source: ${name}`, opts(), async ($, on) => {
    const source = command.endsWith('refs/heads/feat/x') ? 'rev-parse --symbolic-full-name refs/heads/feat/x' : SOURCE
    const w = world(on, { git: args => (answer !== undefined && args.join(' ') === source ? answer : onFeature(args)), answer: () => null })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash(command))
    expect(w.asks).toHaveLength(asks ? 1 : 0)
    expect(w.runs).toEqual(asks ? [] : ['Bash'])
  })
}
// Catches (#1570): the source read running for a push that already asks, or for HEAD, whose branch `current` already
// names fully resolved (`--abbrev-ref HEAD` follows a symbolic ref; git pushes HEAD to that branch, measured git 2.56.0).
test('the source read runs only where it decides', opts(), async ($, on) => {
  const w = world(on, { git: onFeature, answer: () => null })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('git push origin HEAD'))
  await $.tool.call(bash('git push --force origin feat/x'))
  expect(w.procs.filter(p => p.includes('--symbolic-full-name'))).toEqual([])
})
// Catches (#1569 P2): a push configured by an earlier call to go elsewhere running unasked — the wiring not
// reading the configuration, parsing it wrong, reading it off `origin` instead of the remote pushed to, or
// reading a failed read as unset. Each row is the feature-branch push above plus the git answers named.
const url = { exitCode: 0, stdout: 'git@example.org:team/fork.git\n' }
for (const [name, command, answers, asks] of [
  ['push.default=current makes a bare push ask', 'git push', { 'config --null --get-regexp ^push\\.': { exitCode: 0, stdout: 'push.autosetupremote\ntrue\0push.default\ncurrent\0' } }, true],
  ['a remote.origin.push entry makes a named-branch push ask', 'git push origin feat/x', { 'config --null --get-all remote.origin.push': { exitCode: 0, stdout: 'refs/heads/feat/x:refs/heads/main\0' } }, true],
  ['a config read failing with exit 128 asks', 'git push origin feat/x', { 'config --null --type=bool --get submodule.recurse': { exitCode: 128, stdout: '' } }, true],
  ['a push to a second remote with nothing configured runs', 'git push upstream feat/x', { 'config --get remote.upstream.url': url }, false],
  ['the reads use the remote pushed to, not origin', 'git push upstream feat/x', { 'config --get remote.upstream.url': url, 'config --null --get-all remote.upstream.push': { exitCode: 0, stdout: 'HEAD:refs/heads/main\0' } }, true],
  // A legacy .git/remotes/<name> file answers `git remote get-url`, not the config: its `Push:` line is a mapping no config read sees.
  ['a remote known only through .git/remotes asks', 'git push legacy feat/x', { 'remote get-url legacy': url }, true],
] as const) {
  test(`push configuration: ${name}`, opts(), async ($, on) => {
    const table: Record<string, { exitCode: number; stdout: string }> = answers
    const w = world(on, { git: args => table[args.join(' ')] ?? onFeature(args), answer: () => null })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash(command))
    expect(w.asks).toHaveLength(asks ? 1 : 0)
    expect(w.runs).toEqual(asks ? [] : ['Bash'])
  })
}
// Catches (MR !133, #1569): a hook fired by an earlier `git commit` on the line moving HEAD or the push configuration
// after the facts were measured — the wiring never measuring core.hooksPath, the hooks folder or a hook defined in config
// (`hook.<name>.command`, run by git 2.56), reading a failed read as "no hooks", or asking on every commit+push although
// no hook can run (the gate then gets clicked through unread).
// #1574: only the hooks the earlier steps can fire count — a pre-push or post-merge hook made every husky repo's
// `git commit && git push` ask — but a fireable one still asks, also where core.hooksPath points at a non-husky folder.
const samples = { exitCode: 0, stdout: 'pre-commit.sample\npre-push.sample\n' }
const hookConfig = 'config --null --get-regexp ^hook\\.'
const hooksPathTo = (dir: string) => ({ 'config --get core.hooksPath': { exitCode: 0, stdout: `${dir}\n` }, 'rev-parse --git-path hooks': { exitCode: 0, stdout: `${dir}\n` } })
// husky 9's generated folder: every stub, `h`, husky.sh; the user's hooks sit in the folder above.
const huskyStubs = { exitCode: 0, stdout: '.gitignore\napplypatch-msg\ncommit-msg\nh\nhusky.sh\npost-checkout\npost-commit\npost-merge\npost-rewrite\npre-auto-gc\npre-commit\npre-push\nprepare-commit-msg\n' }
const huskyUser = (...names: string[]) => ({ '.husky/_': huskyStubs, '.husky': { exitCode: 0, stdout: ['_', ...names].join('\n') + '\n' } })
type HookRow = readonly [string, Record<string, { exitCode: number; stdout: string }>, Pick<Options, 'hooksDir' | 'hookDirs' | 'husky'>, boolean, string?]
const hookRows: readonly HookRow[] = [
  ['a core.hooksPath folder holding a fireable pre-commit asks', hooksPathTo('.githooks'), { hooksDir: { exitCode: 0, stdout: 'pre-commit\n' } }, true],
  ['a core.hooksPath folder holding only a pre-push runs', hooksPathTo('.githooks'), { hooksDir: { exitCode: 0, stdout: 'pre-push\n' } }, false],
  ['a hook in the hooks folder asks', {}, { hooksDir: { exitCode: 0, stdout: 'pre-commit.sample\npost-commit\n' } }, true],
  ['a fireable hook with an extension asks', {}, { hooksDir: { exitCode: 0, stdout: 'pre-commit.exe\n' } }, true],
  ['only a post-merge hook in the hooks folder runs', {}, { hooksDir: { exitCode: 0, stdout: 'post-merge\npre-push\n' } }, false],
  ['a hook defined in config asks', { [hookConfig]: { exitCode: 0, stdout: 'hook.sw.command\ngit switch -q main\0hook.sw.event\npost-commit\0' } }, { hooksDir: samples }, true],
  ['a hook defined in config for pre-push only runs', { [hookConfig]: { exitCode: 0, stdout: 'hook.lint.command\nnpm test\0hook.lint.event\npre-push\0' } }, { hooksDir: samples }, false],
  ['an undocumented hook.* key asks', { [hookConfig]: { exitCode: 0, stdout: 'hook.lint.runner\nx\0' } }, { hooksDir: samples }, true],
  ['a hook config read failing with exit 128 asks', { [hookConfig]: { exitCode: 128, stdout: '' } }, { hooksDir: samples }, true],
  ['only *.sample in the hooks folder and no hook in config runs', { [hookConfig]: { exitCode: 1, stdout: '' } }, { hooksDir: samples }, false],
  ['a core.hooksPath read failing with exit 128 asks', { 'config --get core.hooksPath': { exitCode: 128, stdout: '' } }, { hooksDir: samples }, true],
  ['a failing hooks folder listing asks', {}, { hooksDir: { exitCode: 2, stdout: '' } }, true],
  ['husky with only .husky/pre-push runs', hooksPathTo('.husky/_'), { hookDirs: huskyUser('pre-push'), husky: 0 }, false],
  ['husky with .husky/pre-commit asks', hooksPathTo('.husky/_'), { hookDirs: huskyUser('pre-commit', 'pre-push'), husky: 0 }, true],
  ['husky with .husky/post-commit asks', hooksPathTo('.husky/_'), { hookDirs: huskyUser('post-commit'), husky: 0 }, true],
  // W3 review F3: git on a case-insensitive filesystem (APFS, NTFS) runs `PRE-COMMIT` as pre-commit, and husky's `[ -f ]` finds `Pre-Commit`.
  ['a PRE-COMMIT in the hooks folder asks', {}, { hooksDir: { exitCode: 0, stdout: 'PRE-COMMIT\n' } }, true],
  ['husky with .husky/Pre-Commit asks', hooksPathTo('.husky/_'), { hookDirs: huskyUser('Pre-Commit'), husky: 0 }, true],
  // Bypass probes: an `h` or a stub that is not husky's own runs whatever it holds, so it counts like a plain hook.
  ['husky whose h or stub differs from husky 9 asks', hooksPathTo('.husky/_'), { hookDirs: huskyUser('pre-push'), husky: 4 }, true],
  ['husky whose check cannot read h asks', hooksPathTo('.husky/_'), { hookDirs: huskyUser('pre-push'), husky: 3 }, true],
  ['husky whose user folder listing fails asks', hooksPathTo('.husky/_'), { hookDirs: { '.husky/_': huskyStubs, '.husky': { exitCode: 2, stdout: '' } }, husky: 0 }, true],
  ['a folder named _ with h but no core.hooksPath is no husky and asks', { 'rev-parse --git-path hooks': { exitCode: 0, stdout: '.husky/_\n' } }, { hookDirs: huskyUser('pre-push') }, true],
  ['an unreadable hooks listing behind git add asks', {}, { hooksDir: { exitCode: 1, stdout: '' } }, true, 'git add a.ts && git push origin feat/x'],
  // A git subcommand outside the map may fire any hook: `git stash` asks even with only a pre-push hook.
  ['git stash before a push with only a pre-push hook asks', {}, { hooksDir: { exitCode: 0, stdout: 'pre-push\n' } }, true, 'git stash && git push origin feat/x'],
]
for (const [name, answers, dirs, asks, command] of hookRows) {
  test(`hooks before a push: ${name}`, opts(), async ($, on) => {
    const table: Record<string, { exitCode: number; stdout: string }> = { 'rev-parse --git-path hooks': { exitCode: 0, stdout: '.git/hooks\n' }, ...answers }
    const w = world(on, { git: args => table[args.join(' ')] ?? onFeature(args), ...dirs, answer: () => null })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash(command ?? 'git commit -m x && git push origin feat/x'))
    expect(w.asks).toHaveLength(asks ? 1 : 0)
    expect(w.runs).toEqual(asks ? [] : ['Bash'])
  })
}
// Catches (#1574): the husky check fed the wrong names — every hook name, or none — so a stub for a hook the commit
// fires goes unchecked against husky's own content.
test('hooks before a push: the husky check gets exactly the stubs a commit can fire', opts(), async ($, on) => {
  const table: Record<string, { exitCode: number; stdout: string }> = hooksPathTo('.husky/_')
  const w = world(on, { git: args => table[args.join(' ')] ?? onFeature(args), hookDirs: huskyUser('pre-push'), husky: 0, answer: () => null })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('git commit -m x && git push origin feat/x'))
  expect(w.procs).toContain('husky-names pre-commit prepare-commit-msg commit-msg post-commit post-rewrite pre-auto-gc')
  expect(w.runs).toEqual(['Bash'])
})
// Catches (#1573): a key set by an earlier call (core.fsmonitor) making `git diff` run a program that moves HEAD
// after the facts were measured — the wiring never reading the repository's keys, or reading a failed read as none set.
// `git diff --stat` can write the index and fire post-index-change (measured, git 2.56), so these rows measure
// a hooks folder holding only samples.
const withHooksDir = (g: Git): Git => args => (args.join(' ') === 'rev-parse --git-path hooks' ? { exitCode: 0, stdout: '.git/hooks\n' } : g(args))
for (const [name, answer, asks] of [
  ['core.fsmonitor in the repository asks', { exitCode: 0, stdout: 'local\0core.bare\nfalse\0local\0core.fsmonitor\n./x\0' }, true],
  ['a failing read asks', { exitCode: 128, stdout: '' }, true],
  ['an everyday clone runs', undefined, false],
] as const) {
  test(`repository config before a push: ${name}`, opts(), async ($, on) => {
    const w = world(on, { git: withHooksDir(args => (answer !== undefined && args.join(' ') === REPO_KEYS ? answer : onFeature(args))), hooksDir: samples, answer: () => null })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('git diff --stat && git push origin HEAD'))
    expect(w.asks).toHaveLength(asks ? 1 : 0)
    expect(w.runs).toEqual(asks ? [] : ['Bash'])
  })
}
// Catches (#1573 review MITTEL): a submodule or embedded repository with its own core.fsmonitor running during the
// outer `git diff` — the wiring never counting gitlinks, or reading a failed count as none.
for (const [name, gitlinks, asks] of [
  ['a gitlink in the index asks', { exitCode: 0, stdout: '1\n' }, true],
  ['a failing count asks', { exitCode: 128, stdout: '' }, true],
  ['no gitlink runs', { exitCode: 0, stdout: '0\n' }, false],
] as const) {
  test(`gitlinks before a push: ${name}`, opts(), async ($, on) => {
    const w = world(on, { git: withHooksDir(onFeature), gitlinks, hooksDir: samples, answer: () => null })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call(bash('git diff --stat && git push origin HEAD'))
    expect(w.asks).toHaveLength(asks ? 1 : 0)
    expect(w.runs).toEqual(asks ? [] : ['Bash'])
  })
}
// Catches (#1573 second review): the gitlink count (`git ls-files`, which itself runs a configured core.fsmonitor)
// running before the repository's keys were judged, or although they already ask — it would start the program
// the gate exists to keep from running.
test('gitlinks are counted only after the repository keys, and not when those already ask', opts(), async ($, on) => {
  const fsmonitor = { exitCode: 0, stdout: 'local\0core.fsmonitor\n./x\0' }
  const asking = world(on, { git: withHooksDir(args => (args.join(' ') === REPO_KEYS ? fsmonitor : onFeature(args))), hooksDir: samples, answer: () => null })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('git diff --stat && git push origin HEAD'))
  expect(asking.asks).toHaveLength(1)
  expect(asking.procs).toContain(`git ${REPO_KEYS}`)
  expect(asking.procs).not.toContain('bash so-hud-gitlinks')
})
test('on a clean repository the gitlink count follows the repository-key read', opts(), async ($, on) => {
  const w = world(on, { git: withHooksDir(onFeature), hooksDir: samples, answer: () => null })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('git diff --stat && git push origin HEAD'))
  expect(w.runs).toEqual(['Bash'])
  const keys = w.procs.indexOf(`git ${REPO_KEYS}`)
  expect(keys).toBeGreaterThanOrEqual(0)
  expect(w.procs.indexOf('bash so-hud-gitlinks')).toBeGreaterThan(keys)
})
// Catches: a folder the rules could not pin down (`cd` in a subshell) measured anyway on a host where the cd
// into the sentinel succeeds — the facts then describe another repo and a HEAD push of main runs unasked.
test('a push after a subshell cd asks even when the host resolves every folder', opts(), async ($, on) => {
  const w = world(on, { git: onFeature, cdTo: '/repo/other', answer: () => null })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('(cd ../other && git status) && git push origin HEAD'))
  expect(w.asks).toHaveLength(1)
  expect(w.runs).toEqual([])
})
// Catches: a measurement failure read as "nothing to confirm" (fail-open); a dismissed dialog running anyway.
test('unmeasurable push facts ask the owner; a dismissed dialog runs nothing', opts(), async ($, on) => {
  const w = world(on, { git: 'throws', answer: () => null })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('git push origin feat/x'))
  expect(w.asks).toHaveLength(1)
  expect(w.asks[0]).toContain('nicht messbar')
  expect(w.runs).toEqual([])
})
// Catches: a session started non-interactive (SDK host, attached app) passing a push through although a surface can ask.
test('push with a surface but no REPL is asked, not passed through', opts(), async ($, on) => {
  const w = world(on, { surfaces: ['desktop'], answer: () => null })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.tool.call(bash('git push origin main'))
  expect(w.asks).toHaveLength(1)
  expect(w.runs).toEqual([])
  expect(w.receipts[0]).toMatchObject({ ergebnis: 'abgelehnt' })
})
// Catches: a Monitor command pushing to main without the owner's two steps.
test('a Monitor push to main is asked', opts(), async ($, on) => {
  const w = world(on, { answer: () => null })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(monitor('git push origin main'))
  expect(w.asks).toHaveLength(1)
  expect(w.runs).toEqual([])
})
// Catches: the locker fail-open path releasing an outward action when the gate itself fails.
test('a gate failure on locker still refuses git push origin main', opts('locker'), async ($, on) => {
  const w = world(on, { surfaces: 'throws' })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  expect(JSON.stringify(await $.tool.call(bash('git push origin main')))).toContain('Schutz-Hook fehlgeschlagen')
  expect(w.runs).toEqual([])
})
// Catches: a headless run blocked by a dialog nobody can answer, or running without a record.
test('headless push passes to the CLI once and leaves a receipt', opts(), async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
  await $.tool.call(bash('git push origin main'))
  expect(w.asks).toEqual([])
  expect(w.runs).toEqual(['Bash'])
  expect(w.receipts[0]).toMatchObject({ ergebnis: 'ohne-zeichenflaeche', art: 'push' })
})

// ---- Collisions (F8) -----------------------------------------------------------------
const collide = [peer('peer-b', ['src/'])]
// Catches: the collision guard ignoring the profile dial.
test('collision warns and writes on locker', opts('locker'), async ($, on) => {
  const w = world(on, { peers: collide })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(edit)
  expect(w.runs).toEqual(['Edit'])
  expect(w.toasts.join('\n')).toContain('peer-b')
})
test('collision is refused on streng with a worktree hint', opts('streng'), async ($, on) => {
  const w = world(on, { peers: collide })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.tool.call(edit))).toContain('git worktree add')
  expect(w.runs).toEqual([])
})
// Catches: a dismissed collision dialog being booked as a failed question instead of a refusal (#1856).
test('collision: a dismissed dialog stays the owner declining', opts(), async ($, on) => {
  const w = world(on, { peers: collide, answer: () => null })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.tool.call(edit))).toContain('Abgebrochen')
  expect(w.runs).toEqual([])
  expect(w.receipts[0]).toMatchObject({ aktion: 'kollision', ergebnis: 'abgelehnt' })
})
// Catches: a collision question that could not be shown being booked as the owner's "Abbrechen" (#1856).
test('collision: a failed question is not the owner declining; nothing is written', opts(), async ($, on) => {
  const w = world(on, { peers: collide, answer: () => { throw new Error('dialog not available') } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const answer = JSON.stringify(await $.tool.call(edit))
  expect(answer).toContain('nicht entschieden')
  expect(answer).not.toContain('Abgebrochen')
  expect(w.runs).toEqual([])
  expect(w.receipts[0]).toMatchObject({ aktion: 'kollision', art: 'edit', ergebnis: 'fehler' })
})
for (const [choice, runs, says] of [['Trotzdem', ['Edit'], ''], ['Worktree vorschlagen', [], 'git -C /repo worktree add'], ['Abbrechen', [], 'Abgebrochen']] as const) {
  // Catches: the owner's collision answer not deciding whether the write happens (or the worktree hint lost).
  test(`collision on ausgewogen: ${choice}`, opts(), async ($, on) => {
    const w = world(on, { peers: collide, answer: () => choice })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(JSON.stringify(await $.tool.call(edit))).toContain(says)
    expect(w.asks).toHaveLength(1)
    expect(w.runs).toEqual([...runs])
    expect(w.receipts[0]).toMatchObject({ aktion: 'kollision', art: 'edit', ergebnis: choice === 'Trotzdem' ? 'ausgefuehrt' : 'abgelehnt' })
    expect(w.receipts[0]?.argv_sha256).toBe(await argvSha256(['Edit', '/repo/src/a.ts']))
  })
}
// Catches: a headless collision refusal claiming the owner chose to abort.
test('headless collision on ausgewogen is refused with its own text', opts(), async ($, on) => {
  const w = world(on, { peers: collide })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const answer = JSON.stringify(await $.tool.call(edit))
  expect(answer).toContain('niemand zum Fragen da')
  expect(answer).not.toContain('Abgebrochen')
  expect(w.runs).toEqual([])
})
// Catches: the session colliding with itself through its own peer record.
test('own session id as peer is no collision', opts(), async ($, on) => {
  const w = world(on, { peers: [peer('test-session', ['src/'])] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(edit)
  expect(w.asks).toEqual([])
  expect(w.runs).toEqual(['Edit'])
})

// ---- Secret shield, fail-closed, order ---------------------------------------------------
// Catches: a token in a tool's output reaching the model and the transcript — also from a hook's own { result } without
// text, and from a `result` whose `text` is empty or clean (the shield must not check `text` alone).
for (const [label, text] of [['with token', 'TOKEN='], ['absent', undefined], ['empty', ''], ['clean', 'ok']] as const) {
  test(`a secret in a tool result reaches the model redacted (text ${label})`, opts(), async ($, on) => {
    const token = ['gl', 'pat-'].join('') + 'x7'.repeat(12)
    const result = { stdout: `TOKEN=${token}\n`, stderr: '', interrupted: false }
    world(on, { output: text === undefined ? { result } : { result, text: text === 'TOKEN=' ? `${text}${token}` : text } })
    const seen = JSON.stringify(await $.tool.call(bash('cat config.txt')))
    expect(seen.includes(token)).toBe(false)
    expect(seen).toContain('sha256:')
  })
}
// Catches: a crashing gate failing open on ausgewogen (the call would run unchecked).
test('a failure inside the gate refuses the call on ausgewogen', opts(), async ($, on) => {
  const w = world(on, { peers: collide })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  w.state.idFails = true
  expect(JSON.stringify(await $.tool.call(edit))).toContain('Schutz-Hook fehlgeschlagen')
  expect(w.runs).toEqual([])
})
// Catches: one tool_use_id executed twice (a replay after a hook failure).
test('a repeated tool_use_id is refused', opts(), async ($, on) => {
  const w = world(on)
  await $.tool.call({ ...bash('ls'), tool_use_id: 'toolu_same' })
  expect(JSON.stringify(await $.tool.call({ ...bash('ls'), tool_use_id: 'toolu_same' }))).toContain('nicht erneut')
  expect(w.runs).toEqual(['Bash'])
})
// Catches: the gate standing beneath the beacon hook (a refused call would still mark the session working).
test('the gate is outermost: a refused call never reaches the beacon hook', opts(), async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Los', turnId: 'turn-1' })
  const before = w.writes.length
  await $.tool.call(bash('cat .env.local'))
  expect(w.writes.length).toBe(before)
  await $.tool.call(bash('ls'))
  expect(w.writes.length).toBe(before + 1)
})
