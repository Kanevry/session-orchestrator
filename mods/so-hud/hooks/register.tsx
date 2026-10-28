import type { EngineInterface, Register } from 'claude-code'
import type { SoBeacon, SoProfile, SoSnapshot } from '../types/index'
import { ageBeacon, completeState, configHooksFire, displayText, findings, fireableHooks, holdsProfile, PROFILES, profileLines, profileOf, profileText, statusText, validId, validateBeacon } from './logic'
import { CD_SCRIPT, classifyAllOutward, collisionVerdict, findCollisions, findTraps, GITLINKS_SCRIPT, gitlinksFromRun, hasSecret, KIND_LABEL, plainSourceRefs, pushDestinations, pushNeedsConfirm, pushRemote, pushSources, redactDeep, redactText, REPO_CONFIG_READ, repoConfigEntries, trapVerdict, UNKNOWN_DIR, type Outward, type PushConfig, type PushFacts, type RepoConfig, type SecretHit } from './rules'

// Only these closures cross helper boundaries; the engine table never does.
type IO = {
  run: EngineInterface['process']['run']
  read: (path: string) => Promise<string>
  list: EngineInterface['fs']['list']
  now: EngineInterface['clock']['now']
  env: () => ReturnType<EngineInterface['env']['get']>
  storeGet: EngineInterface['store']['get']
  storeSet: EngineInterface['store']['set']
  sessionId: EngineInterface['session']['id']
  cwd: EngineInterface['session']['cwd']
  model: EngineInterface['session']['model']
  usage: EngineInterface['session']['usage']
  pluginRoot: () => string
}

// `tool` and `text` form the hashed vector (ADR-009 "Klick-Provenienz" of lead-session-orchestrator): the tool name stands where a CLI program would.
type Receipt = { aktion: 'aussenwirkung' | 'kollision'; tool: string; text: string; art: string }
type Assessed = { hit: Outward; cwd: string | null; facts: PushFacts | null; needs: boolean }

const CONFIRM_WINDOW_MS = 30_000
// Ceiling for retrying `claude plugin list` without a Session Orchestrator root (F13): an install made mid-session shows
// within 5 minutes, `so-hud.mjs --register-root` at the next refresh (that file is read every time). Revisit if 5 minutes is too slow.
const PLUGIN_LIST_RETRY_MS = 5 * 60_000
const STEP_ONE = ['Weiter zur Bestätigung', 'Ablehnen'] as const
const STEP_TWO = ['Jetzt genau einmal ausführen', 'Ablehnen'] as const
// The engine's rejection texts for a question the owner answered without a label (#1856); see askOwner below.
// The engine builds `$.ui.ask: no answer (<deny or text, else "the dialog was dismissed">)`: an empty answer gives
// the default, Esc on the dialog the permission deny text (claude-code 2.1.312 binary, read 2026-10-28).
const DIALOG_DISMISSED = /no answer \((?:the dialog was dismissed|The user doesn't want to proceed)/
// Tools whose `command` is a shell line: traps, outward classification and receipts apply to each.
const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor', 'PowerShell'])
// The push configuration nobody set: the most permissive one pushNeedsConfirm accepts (#1569).
const UNSET_PUSH_CONFIG: PushConfig = { push: [], remotePush: [], remoteMirror: null, remotePushDefault: null, branchPushRemote: null, submoduleRecurse: null }
// A repository with no key set (#1573): the most permissive repoConfig pushNeedsConfirm accepts.
const NO_REPO_CONFIG: RepoConfig = []
// Lists the hooks folder one name per line, prints nothing when no such path exists, and exits 2 when something
// other than a folder is there. The folder is passed as an argument, never as source.
const HOOKS_SCRIPT = `d="$1"; if [ -d "$d" ]; then ls -A -- "$d/"; elif [ -e "$d" ] || [ -L "$d" ]; then exit 2; fi`
// husky v9 (#1574): core.hooksPath is `<dir>/_`, each `_/<name>` a generated stub sourcing `_/h`, and `h` runs the user's
// `<dir>/<name>` when that file exists, else exits 0 before anything else runs. Verifies `h` starts with that exact
// prefix and every named stub is byte-for-byte husky's (trailing newlines aside): exit 0 when both hold, 4 when either
// differs (not recognisably husky), anything else when a read failed. Folder, stub, prefix and names are arguments.
const HUSKY_SCRIPT = `d="$1"; stub="$2"; prefix="$3"; shift 3; h=$(cat -- "$d/h") || exit 3; case "$h" in "$prefix"*) ;; *) exit 4 ;; esac; for n in "$@"; do if [ -e "$d/$n" ] || [ -L "$d/$n" ]; then s=$(cat -- "$d/$n") || exit 3; [ "$s" = "$stub" ] || exit 4; fi; done`
// What husky 9.1 writes (node_modules/husky/index.js and its `husky` file, measured 9.1.7); another version asks.
const HUSKY_STUB = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"'
const HUSKY_H_PREFIX = '#!/usr/bin/env sh\n[ "$HUSKY" = "2" ] && set -x\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n\n[ ! -f "$s" ] && exit 0\n'
// The raw session id the collector accepts for --session-id (#1730): the same form as UUID_RE in
// scripts/lib/session-id.mjs (version 1-8, RFC variant). Any other id is not passed on, so it cannot read as an
// older collector and switch the flag off.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// The mod's lib has no DOM types; Web Crypto and TextEncoder are globals in the mod engine (as in rules.ts).
type WebGlobals = {
  crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } }
  TextEncoder: new () => { encode(input: string): Uint8Array }
}
async function sha256(text: string): Promise<string> {
  const { crypto, TextEncoder } = globalThis as unknown as WebGlobals
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const register: Register = (on, options) => {
  let io: IO
  let current: SoSnapshot | null = null
  let own: SoBeacon | null = null
  let interactive = false
  let refreshing = false
  let sessionIdFlag = true
  let ending = false
  let cancel: (() => void) | undefined
  let beaconWrites: Promise<unknown> = Promise.resolve()
  const problems = new Set<string>()
  // Calls already passed downstream; a repeated id never runs twice. One entry per tool call — a session's
  // few thousand calls stay small; revisit if sessions ever run unbounded.
  const passed = new Set<string>()
  // What the gate read off a call before anything could fail, for its `.catch` (dropped once the call settles).
  const classes = new Map<string, { outward: boolean; sec008: boolean }>()
  const profile: SoProfile = profileOf(options.strictness)
  // Profile band (#1552). Closure state, because $.state refuses writes while a render hook draws. `chosen` stays
  // null until session.start has read it, so a chosen profile never flashes the band; `opened` is /profile's.
  let chosen: boolean | null = null
  let opened = false
  // "Schließen" hides the band for this session only; it returns at the next session start while nothing is chosen.
  let dismissed = false
  let choosing = false
  // When root() last asked `claude plugin list`; a miss is never stored, so without this every 15-second refresh spawned it.
  let pluginListAt: number | null = null
  const helper = async (io: IO, action: string, id = '', input: unknown = null) => {
    const result = await io.run(['node', `${io.pluginRoot()}/hooks/beacon-io.mjs`, action, id], { stdin: JSON.stringify(input), timeoutMs: 3000 })
    if (result.exitCode !== 0) throw new Error('beacon-io')
    return JSON.parse(result.stdout) as unknown
  }
  const snapshot = async (io: IO): Promise<SoSnapshot | null> => current ? {
    ...current, age_ms: Math.max(0, await io.now() - Date.parse(current.measured_at)),
    degraded: [...new Set([...current.degraded, ...problems])],
  } : null
  const root = async (io: IO): Promise<string | null> => {
    if (typeof options.soRoot === 'string' && options.soRoot.startsWith('/')) {
      await io.storeSet('so-root', options.soRoot)
      return options.soRoot
    }
    const cached = await io.storeGet('so-root')
    if (typeof cached === 'string' && cached.startsWith('/')) return cached
    const home = await io.env()
    let found: string | null = null
    if (home) {
      try { const p = (await io.read(`${home}/.config/session-orchestrator/hud/so-root`)).trim(); if (p.startsWith('/')) found = p } catch { /* try installed plugins */ }
    }
    // At most one `claude plugin list` per PLUGIN_LIST_RETRY_MS while no root is found, whatever its outcome.
    const now = found ? null : await io.now()
    if (now !== null && (pluginListAt === null || now - pluginListAt >= PLUGIN_LIST_RETRY_MS)) {
      pluginListAt = now
      const result = await io.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 3000 })
      if (result.exitCode === 0) {
        const data = JSON.parse(result.stdout)
        const rows: unknown[] = Array.isArray(data) ? data : Array.isArray(data.plugins) ? data.plugins : []
        for (const row of rows) {
          const p = row as { name?: string; id?: string; installPath?: string }
          if ((p.name ?? p.id ?? '').split('@')[0] === 'session-orchestrator' && p.installPath?.startsWith('/')) { found = p.installPath; break }
        }
      }
    }
    if (found) await io.storeSet('so-root', found)
    return found
  }
  const write = async (io: IO, change: Partial<SoBeacon> = {}) => {
    if (ending || !own) return
    const now = new Date(await io.now()).toISOString()
    if (ending || !own) return
    own = { ...own, ...change, seit: change.zustand && change.zustand !== own.zustand ? now : own.seit, aktualisiert_at: now }
    const value = { ...own }
    beaconWrites = beaconWrites.catch(() => undefined).then(() => helper(io, 'write', value.session_id, value))
    await beaconWrites.catch(() => { problems.add('beacon-write-failed') })
  }
  const readBeacons = async (io: IO): Promise<SoBeacon[]> => {
    const home = await io.env()
    if (!home) return []
    const dir = `${home}/.config/session-orchestrator/hud/beacons`
    const entries = await io.list(dir).catch(() => [])
    const beacons: SoBeacon[] = []
    for (const f of entries) {
      if (f.kind !== 'file' || f.isLink || f.size > 4096 || !f.name.endsWith('.json')) continue
      try { const b: unknown = JSON.parse(await io.read(`${dir}/${f.name}`)); if (validateBeacon(b) && f.name === `${b.session_id}.json`) beacons.push(b) } catch { /* skip unreadable */ }
    }
    const alive = await helper(io, 'alive', '', beacons.map(b => b.pid)).catch(() => []) as number[]
    const now = await io.now()
    return beacons.map(b => ageBeacon(b, now, b.pid !== null && alive.includes(b.pid)))
  }
  const refresh = async (io: IO) => {
    if (refreshing || ending) return
    refreshing = true
    try {
      const soRoot = await root(io)
      if (!soRoot) throw new Error('not-configured')
      // #1730: the session's agents are read beside its own lock, which need not be the cwd's checkout. A collector
      // older than #1730 refuses the unknown flag with the usage exit 2: then it is dropped for the rest of the session.
      const argv = ['node', `${soRoot}/scripts/so-hud.mjs`, '--json', '--repo-root', await io.cwd()]
      const sid = await io.sessionId()
      const withId = sessionIdFlag && UUID_RE.test(sid)
      let result = await io.run(withId ? [...argv, '--session-id', sid] : argv, { timeoutMs: 3000 })
      if (withId && result.exitCode === 2) {
        sessionIdFlag = false
        result = await io.run(argv, { timeoutMs: 3000 })
      }
      if (result.exitCode !== 0) throw new Error('collector-failed')
      const value = JSON.parse(result.stdout) as SoSnapshot
      if (value.schema_version !== 1 || !Number.isFinite(Date.parse(value.measured_at)) || !value.wave || !value.state || !value.gate || !value.vault || !Array.isArray(value.peers) || !Array.isArray(value.degraded)) throw new Error('invalid-snapshot')
      current = value
      for (const reason of ['not-configured', 'refresh-failed', 'collector-failed', 'invalid-snapshot']) problems.delete(reason)
    } catch (error) {
      for (const reason of ['not-configured', 'refresh-failed', 'collector-failed', 'invalid-snapshot']) problems.delete(reason)
      const reason = error instanceof Error ? error.message : ''
      problems.add(['not-configured', 'collector-failed', 'invalid-snapshot'].includes(reason) ? reason : 'refresh-failed')
    }
    finally { refreshing = false }
    try {
      const usage = await io.usage()
      await write(io, { kontext_prozent: usage.context.percent ?? null, welle: current?.wave.number ?? null })
    } catch { problems.add('usage-unavailable') }
  }

  // ---- Protection gates (#1551): host reads for one call ----------------------------
  const resolveCwd = async (io: IO, dir: string | null): Promise<string | null> => {
    const sessionCwd = await io.cwd()
    if (dir === null) return sessionCwd
    // A folder the rules could not pin down asks without relying on how the host resolves the sentinel.
    if (dir === UNKNOWN_DIR || dir.startsWith(`${UNKNOWN_DIR}/`)) return null
    const ran = await io.run(['bash', '-c', CD_SCRIPT, 'so-hud', dir], { cwd: sessionCwd, timeoutMs: 5000 })
    const out = ran.exitCode === 0 ? ran.stdout.trim() : ''
    return out.startsWith('/') ? out : null
  }
  const pushFacts = async (io: IO, hit: Outward, cwd: string): Promise<PushFacts> => {
    const git = async (args: string[]) => {
      const ran = await io.run(['git', ...args], { cwd, timeoutMs: 5000 })
      const out = ran.exitCode === 0 ? ran.stdout.trim() : ''
      return { ok: ran.exitCode === 0, value: out === '' ? null : out }
    }
    const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).value
    const upstream = (await git(['rev-parse', '--abbrev-ref', '@{u}'])).value
    const remote = current !== null && current !== 'HEAD' ? (await git(['config', `branch.${current}.remote`])).value : null
    const target = pushRemote(hit, remote)
    // Config-defined remotes only: `git remote get-url` also answers a legacy .git/remotes/<name> file, whose `Push:` line
    // can send a branch to main without any `remote.<name>.push` the configuration read below could see (#1569).
    const remoteUrlKnown = !target.startsWith('-') && (await git(['config', '--get', `remote.${target}.url`])).value !== null
    const dsts = pushDestinations(hit, current, upstream, target)
    let tagRefs: string[] | null = null
    if (dsts !== null) {
      tagRefs = []
      for (const dst of dsts) if ((await git(['rev-parse', '--verify', '--quiet', `refs/tags/${dst}`])).ok) tagRefs.push(dst)
    }
    const facts: PushFacts = { current, upstream, remote, remoteUrlKnown, tagRefs, pushConfig: null }
    // Each later fact as measured, or else its most permissive value: what a fact decides is judged with the rest clean.
    const clean = (): PushFacts => ({ hooks: false, repoConfig: NO_REPO_CONFIG, gitlinks: false, sourceRefs: plainSourceRefs(hit), ...facts })
    // Read only what decides: a push that asks with nothing configured and no hooks asks whatever is there.
    if (!pushNeedsConfirm(hit, { ...clean(), pushConfig: UNSET_PUSH_CONFIG })) {
      facts.pushConfig = await pushConfig(io, cwd, target, current)
      // #1570: each named source as git resolves it — a symbolic ref or a `refs/<name>` must not stand in for the branch.
      if (!pushNeedsConfirm(hit, clean()) && pushNeedsConfirm(hit, { ...clean(), sourceRefs: undefined })) {
        const sourceRefs: (string | null)[] = []
        for (const src of pushSources(hit)) sourceRefs.push((await git(['rev-parse', '--symbolic-full-name', src])).value)
        facts.sourceRefs = sourceRefs
      }
      // Each of the rest only where it decides: the push runs with it clean and asks with it unread.
      if (!pushNeedsConfirm(hit, clean()) && pushNeedsConfirm(hit, { ...clean(), hooks: undefined })) facts.hooks = await hooksFact(io, cwd, hit.gitBefore)
      // The repository's keys (#1573): only a push behind a git step reads them.
      if (!pushNeedsConfirm(hit, clean()) && pushNeedsConfirm(hit, { ...clean(), repoConfig: undefined })) facts.repoConfig = await repoConfig(io, cwd)
      // …and whether a step can walk into a submodule or embedded repository (#1573 review). Order matters: the count
      // runs `git ls-files`, which itself runs a configured core.fsmonitor, so it must come after repoConfig — a
      // program-carrying fsmonitor makes clean() ask there and this read is skipped. Pinned by schutz.test.ts.
      if (!pushNeedsConfirm(hit, clean()) && pushNeedsConfirm(hit, { ...clean(), gitlinks: undefined })) facts.gitlinks = await gitlinksFact(io, cwd)
    }
    return facts
  }
  /** Whether the push folder's index holds a gitlink; null when the count failed (asks). */
  const gitlinksFact = async (io: IO, cwd: string): Promise<boolean | null> => {
    const ran = await io.run(['bash', '-c', GITLINKS_SCRIPT, 'so-hud-gitlinks'], { cwd, timeoutMs: 5000 })
    return ran.isStdoutTruncated ? null : gitlinksFromRun(ran.exitCode, ran.stdout)
  }
  /** Every configured key with its scope (#1573), one `git config` call; null when it fails, warns or does not parse (asks). */
  const repoConfig = async (io: IO, cwd: string): Promise<RepoConfig | null> => {
    const ran = await io.run(['git', ...REPO_CONFIG_READ], { cwd, timeoutMs: 5000 })
    if (ran.exitCode !== 0 || ran.isStdoutTruncated || ran.stderr !== '') return null
    return repoConfigEntries(ran.stdout)
  }
  /**
   * Whether a git step earlier on the line may run a hook that moves HEAD or the push configuration (MR !133), judged
   * only on the hook names those steps can fire (#1574, {@link fireableHooks}; an unmapped step: any name):
   * true when a hook defined in config runs on one of them, or the effective hooks folder (`git rev-parse --git-path
   * hooks`, which follows core.hooksPath) holds a file of that name (or `<name>.<ext>`, `*.sample` aside). In a
   * husky v9 folder ({@link HUSKY_SCRIPT}) a stub counts only when the user's `<dir>/<name>` beside `_` exists.
   * false only when all of that was measured absent; null when any read failed or did not parse. Measured in the
   * push's folder, so a step run in another repo (`cd ../b && git commit && cd - && git push`) is judged by this
   * repo's hooks; revisit if that form shows up.
   */
  const hooksFact = async (io: IO, cwd: string, steps: readonly string[] | undefined): Promise<boolean | null> => {
    const names = fireableHooks(steps)
    const hooksPath = await io.run(['git', 'config', '--get', 'core.hooksPath'], { cwd, timeoutMs: 5000 })
    const hooksPathSet = hooksPath.exitCode === 0 && hooksPath.stdout.trim() !== ''
    if (!hooksPathSet && (hooksPath.exitCode !== 1 || hooksPath.stdout !== '' || hooksPath.stderr !== '')) return null
    // Hooks defined in config (`hook.<name>.command` + `.event`, any level, includes followed) run like a file in the
    // folder (measured, git 2.56). Exit 1 with nothing printed is none set.
    const configured = await io.run(['git', 'config', '--null', '--get-regexp', '^hook\\.'], { cwd, timeoutMs: 5000 })
    if (configured.stderr !== '' || configured.isStdoutTruncated) return null
    if (configured.exitCode === 0 && configured.stdout !== '') {
      const fires = configHooksFire(configured.stdout, names)
      if (fires !== false) return fires
    } else if (configured.exitCode !== 1 || configured.stdout !== '') return null
    // `.git/hooks`, core.hooksPath, or the common folder's in a worktree; a relative path is relative to cwd, where the listing runs.
    const where = await io.run(['git', 'rev-parse', '--git-path', 'hooks'], { cwd, timeoutMs: 5000 })
    const dir = where.exitCode === 0 && !where.isStdoutTruncated ? where.stdout.replace(/\n$/, '') : ''
    if (dir === '') return null
    const list = async (folder: string): Promise<string[] | null> => {
      const listed = await io.run(['bash', '-c', HOOKS_SCRIPT, 'so-hud-hooks', folder], { cwd, timeoutMs: 5000 })
      // A name holding a newline splits, but its last part ends as the name does, so it still counts.
      return listed.exitCode !== 0 || listed.isStdoutTruncated ? null : listed.stdout.split('\n').filter(name => name !== '')
    }
    const entries = await list(dir)
    if (entries === null) return null
    const wanted = names === null ? null : [...names]
    // Case-insensitive: on APFS or NTFS git runs `PRE-COMMIT` as pre-commit, and husky's `[ -f ]` finds `.husky/Pre-Commit`.
    // On a case-sensitive filesystem this over-counts, which only asks (fail-closed).
    const fires = (name: string): boolean => {
      const lower = name.toLowerCase()
      return !lower.endsWith('.sample') && (wanted === null || wanted.some(n => lower === n || lower.startsWith(`${n}.`)))
    }
    const hooks = entries.filter(fires)
    const folder = dir.replace(/\/+$/, '')
    const husky = hooksPathSet && (folder === '_' || folder.endsWith('/_')) && entries.includes('h')
    if (!husky || wanted === null || hooks.length === 0) return hooks.length > 0
    // husky: a `<name>.<ext>` beside the stubs is no husky file; a stub is checked, then the user's file beside `_`.
    const stubs = wanted.filter(n => entries.includes(n))
    if (hooks.length > stubs.length) return true
    const verified = await io.run(['bash', '-c', HUSKY_SCRIPT, 'so-hud-husky', folder, HUSKY_STUB, HUSKY_H_PREFIX, ...stubs], { cwd, timeoutMs: 5000 })
    if (verified.exitCode === 4) return true
    if (verified.exitCode !== 0) return null
    // `h` runs `$(dirname "$(dirname "$0")")/<name>`: the folder above `_`, taken as written, as `dirname` does.
    const user = await list(folder === '_' ? '.' : folder.slice(0, -2) || '/')
    return user === null ? null : user.some(name => stubs.includes(name.toLowerCase()))
  }
  /** The push configuration (#1569 P2), each key read with `git config --null`; null when any read failed. */
  const pushConfig = async (io: IO, cwd: string, target: string, current: string | null): Promise<PushConfig | null> => {
    // The entries of one read: [] for unset (exit 1, nothing printed), null for any other failure.
    const read = async (args: string[]): Promise<string[] | null> => {
      const ran = await io.run(['git', 'config', '--null', ...args], { cwd, timeoutMs: 5000 })
      if (ran.isStdoutTruncated) return null
      if (ran.exitCode === 1 && ran.stdout === '' && ran.stderr === '') return []
      return ran.exitCode === 0 && ran.stdout.endsWith('\0') ? ran.stdout.slice(0, -1).split('\0') : null
    }
    // A key read with --get: one entry, or none when unset; undefined when the output does not parse.
    const one = (entries: string[] | null): string | null | undefined => entries === null || entries.length > 1 ? undefined : entries[0] ?? null
    const push = await read(['--get-regexp', '^push\\.'])
    const remotePush = await read(['--get-all', `remote.${target}.push`])
    const remoteMirror = one(await read(['--type=bool', '--get', `remote.${target}.mirror`]))
    const remotePushDefault = one(await read(['--get', 'remote.pushDefault']))
    const branchPushRemote = current === null || current === 'HEAD' ? null : one(await read(['--get', `branch.${current}.pushRemote`]))
    const submoduleRecurse = one(await read(['--type=bool', '--get', 'submodule.recurse']))
    if (push === null || remotePush === null || remoteMirror === undefined || remotePushDefault === undefined || branchPushRemote === undefined || submoduleRecurse === undefined) return null
    // `key\nvalue`, or the key alone when it was written without `=`.
    const entries = push.map(entry => entry.includes('\n') ? [entry.slice(0, entry.indexOf('\n')), entry.slice(entry.indexOf('\n') + 1)] as const : [entry, null] as const)
    return { push: entries, remotePush, remoteMirror, remotePushDefault, branchPushRemote, submoduleRecurse }
  }
  const assess = async (io: IO, hit: Outward): Promise<Assessed> => {
    let cwd: string | null = null
    let facts: PushFacts | null = null
    try {
      cwd = await resolveCwd(io, hit.dir)
      if (hit.kind === 'push' && cwd !== null) facts = await pushFacts(io, hit, cwd)
    } catch { facts = null } // a failed measurement only ever asks (fail-closed)
    return { hit, cwd, facts, needs: hit.kind !== 'push' || facts === null || pushNeedsConfirm(hit, facts) }
  }
  // The commits a push sends, measured — never guessed. Only a single destination that is the branch
  // checked out has a known source (HEAD); every other shape says it could not be measured.
  const effect = async (io: IO, a: Assessed): Promise<string[]> => {
    const head = `${KIND_LABEL[a.hit.kind]}: ${displayText(a.hit.label)}`
    if (a.hit.kind !== 'push') return [head]
    const unmeasured = [head, 'Ausgehende Commits: nicht messbar']
    if (a.cwd === null || a.facts === null || a.hit.args.some(arg => !arg.startsWith('-') && arg.includes(':'))) return unmeasured
    const remote = pushRemote(a.hit, a.facts.remote)
    const dsts = pushDestinations(a.hit, a.facts.current, a.facts.upstream, remote)
    if (dsts?.length !== 1 || dsts[0] !== a.facts.current || remote.startsWith('-')) return unmeasured
    const ran = await io.run(['git', 'log', '--oneline', '-n', '10', `${remote}/${dsts[0]}..HEAD`], { cwd: a.cwd, timeoutMs: 5000 }).catch(() => null)
    if (ran?.exitCode !== 0) return unmeasured
    const lines = ran.stdout.split('\n').map(line => line.trim()).filter(Boolean)
    return [head, `Ausgehende Commits nach ${remote}/${dsts[0]}: ${lines.length === 0 ? 'keine' : lines.length}`, ...lines.map(line => `  ${displayText(line)}`)]
  }
  /** Appends one receipt; false when it could not be written. Never throws: a write failure must not deny or re-run. */
  const receipt = async (io: IO, r: Receipt, ergebnis: 'ausgefuehrt' | 'abgelehnt' | 'verfallen' | 'ohne-zeichenflaeche' | 'fehler', exit: number | null): Promise<boolean> => {
    try {
      const sessionId = await io.sessionId()
      await helper(io, 'aktion', sessionId, { zeit: new Date(await io.now()).toISOString(), session_id: sessionId, vorgang: 'pane-aktion',
        aktion: r.aktion, argv_sha256: await sha256(JSON.stringify([r.tool, r.text])), exit, profil: profile, ergebnis, art: r.art })
      return true
    } catch {
      problems.add('receipt-failed')
      return false
    }
  }

  const initialize = async (io: IO, cwd: string) => {
    ending = false
    const id = await io.sessionId()
    if (own?.session_id !== id) current = null
    if (validId(id)) {
      const now = new Date(await io.now()).toISOString()
      const identity = await helper(io, 'identity').catch(() => null) as { pid: number } | null
      own = { schema_version: 1, session_id: id, name: null, repo_name: cwd.split('/').at(-1) ?? null, branch: null,
        pid: identity?.pid ?? null, zustand: 'unbekannt', seit: now, warte_grund: null, heuristisch: false,
        kontext_prozent: null, letzter_request_at: null, modell: await io.model().catch(() => null), welle: null, aktualisiert_at: now }
    }
    await refresh(io)
  }

  // Register the whole chain before any engine call. engine.create is post-order, never caught.
  on('engine.create', async (_$, e, next) => {
    const beneath = await next(e)
    io = {
      run: (argv, init) => beneath.process.run(argv, init),
      read: (path) => beneath.fs.read(path),
      list: (path) => beneath.fs.list(path),
      now: () => beneath.clock.now(),
      env: () => beneath.env.get('HOME'),
      storeGet: (key) => beneath.store.get(key),
      storeSet: (key, value) => beneath.store.set(key, value),
      sessionId: () => beneath.session.id(),
      cwd: () => beneath.session.cwd(),
      model: () => beneath.session.model(),
      usage: () => beneath.session.usage(),
      pluginRoot: () => beneath.plugin.root,
    }
    return { ...beneath, so: { version: () => 1 as const, snapshot: () => snapshot(io), beacons: () => readBeacons(io), profile: () => profile } }
  })
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    // Band and /profile need no Session Orchestrator root, collector or vault (F13), so they come before initialize.
    await $.command.register({ name: 'profile', description: 'so-hud: Profil zeigen und wechseln (locker, ausgewogen, streng)', immediate: true })
      .catch(() => { try { $.ui.toast('[so-hud] /profile ließ sich nicht anlegen; Profil in /config wechseln.', { timeoutMs: 8000 }) } catch { /* best effort */ } })
    // Chosen = this mod stored a choice, or any settings source holds one (also set in /config by hand). A failed read shows the band.
    try { chosen = await $.store.get('profile-chosen') === true || holdsProfile(await $.settings.read(), $.plugin.name) }
    catch { chosen = false }
    dismissed = false
    if (interactive) $.ui.invalidate('ui.render')
    await initialize(io, e.cwd)
    const updateUI = async () => {
      if (interactive && !ending) {
        $.ui.status(statusText(await snapshot(io), profile, 'de', [...problems]))
        $.ui.invalidate('ui.render')
      }
    }
    await updateUI()
    cancel?.()
    const timer = $.clock.every(15_000, async () => {
      try { await refresh(io); await updateUI() }
      catch { problems.add('refresh-failed') }
    })
    cancel = () => timer.cancel()
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.start', async ($, e, next) => {
    if (ending || !own || own.session_id !== await io.sessionId()) {
      await initialize(io, await io.cwd())
      const updateUI = async () => {
        if (interactive && !ending) {
          $.ui.status(statusText(await snapshot(io), profile, 'de', [...problems]))
          $.ui.invalidate('ui.render')
        }
      }
      await updateUI()
      cancel?.()
      const timer = $.clock.every(15_000, async () => {
        try { await refresh(io); await updateUI() }
        catch { problems.add('refresh-failed') }
      })
      cancel = () => timer.cancel()
    }
    await write(io, { zustand: 'arbeitet', warte_grund: null, heuristisch: false, letzter_request_at: new Date(await io.now()).toISOString() })
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await write(io, completeState(e.answer))
    return next(e)
  }).catch(($, e, next) => next(e))
  // The protection gate (#1551). Registered before the beacon hook: a plugin's registrations nest in order,
  // first outermost, so a deny here never reaches the beacon and a confirmed call runs through it once.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    if (passed.has(id)) return { deny: '[so-hud] Dieser Aufruf wurde bereits weitergereicht und läuft nicht erneut.' }
    const args = e as unknown as Record<string, unknown>
    const command = COMMAND_TOOLS.has(e.tool) && typeof args.command === 'string' ? args.command : null
    const traps = command === null ? [] : findTraps(command)
    const outward = command === null ? [] : classifyAllOutward(command)
    classes.set(id, { outward: outward.length > 0, sec008: traps.some(trap => trap.klasse === 'sec008') })
    const done = <T,>(value: T): T => { classes.delete(id); return value }
    const toast = (text: string) => { try { $.ui.toast(text, { timeoutMs: 8000 }) } catch { /* best effort, never a deny */ } }
    // A question that could not be asked is no answer from the owner (#1856): `.catch(() => null)` made it
    // look like a closed dialog, and the gate then told the model the owner had declined. Keep both apart.
    // The engine rejects in both cases with the same HooksError and no code (measured, claude-code 2.1.312 kit):
    // a dismissed dialog or Esc (DIALOG_DISMISSED) stays an answer, the owner refused; any other or unknown
    // wording counts as a failed question, so a changed message never invents a decision.
    const askOwner = (text: string, options: Parameters<typeof $.ui.ask>[1]) =>
      $.ui.ask(text, options).then(
        answer => ({ asked: true as const, answer }),
        (err: unknown) => (DIALOG_DISMISSED.test(String((err as Error)?.message ?? ''))
          ? { asked: true as const, answer: null }
          : { asked: false as const, answer: null }))
    type Ergebnis = Parameters<typeof receipt>[2]
    const record = async (list: readonly Receipt[], ergebnis: Ergebnis, exit: number | null) => {
      let ok = true
      for (const r of list) ok = await receipt(io, r, ergebnis, exit) && ok
      if (!ok) toast('[so-hud] Aktionsbeleg ließ sich nicht schreiben.')
    }
    const after: Receipt[] = []
    // Who can be asked is decided per call: an SDK host or an attached app draws although the session started
    // non-interactive. Only a run with no surface at all (plain -p) has nobody to ask. A failing read throws
    // into the gate's `.catch`, which refuses (fail-closed).
    let askable: boolean | null = null
    const canAsk = async () => {
      if (askable === null) askable = interactive || (await $.session.surfaces()).length > 0
      return askable
    }

    // Traps the rules name (SEC-008 refuses on every profile).
    const verdict = trapVerdict(traps, profile)
    if (verdict.aktion === 'ablehnen') return done({ deny: verdict.text })
    if (verdict.aktion === 'warnen') toast(verdict.text)

    // Actions with an effect outside (F9): two steps inside the held call, never deny-and-rerun.
    if (command !== null && outward.length > 0) {
      const measure = async () => {
        const all: Assessed[] = []
        for (const hit of outward) all.push(await assess(io, hit))
        const needing = all.filter(a => a.needs)
        const effects: string[][] = []
        for (const a of needing) effects.push(await effect(io, a))
        return { needing, effects, key: JSON.stringify([all.map(a => [a.needs, a.cwd, a.facts]), effects]) }
      }
      const { needing, effects, key } = await measure()
      const receipts = needing.map(a => ({ aktion: 'aussenwirkung' as const, tool: e.tool, text: command, art: a.hit.kind }))
      if (needing.length > 0 && !await canAsk()) {
        // No surface to confirm on: the CLI's own gates decide; the mod only records.
        await record(receipts, 'ohne-zeichenflaeche', null)
      } else if (needing.length > 0) {
        const labels = [...new Set(needing.map(a => KIND_LABEL[a.hit.kind]))].join(' + ')
        const lines = [`Befehl: ${displayText(await redactText(command, []), 300)}`]
        needing.forEach((a, i) => lines.push(`Ordner: ${displayText(a.cwd ?? 'nicht auflösbar', 300)}`, ...effects[i] ?? []))
        const decline = async (ergebnis: 'abgelehnt' | 'verfallen' | 'fehler', text: string) => {
          await record(receipts, ergebnis, null)
          return done({ deny: text })
        }
        const refused = `[so-hud] Der Owner hat ${labels} abgelehnt; nichts ausgeführt. Denselben Aufruf nicht erneut versuchen.`
        const notAsked = '[so-hud] Die Rückfrage an den Owner ließ sich nicht stellen; nichts ausgeführt. Der Owner hat nicht entschieden; erneut versuchen, sobald gefragt werden kann.'
        const first = await askOwner([...lines, `${labels} freigeben?`].join('\n'), { options: [...STEP_ONE], header: 'Außenwirkung' })
        if (!first.asked) return decline('fehler', notAsked)
        if (first.answer !== STEP_ONE[0]) return decline('abgelehnt', refused)
        const firstAt = await io.now()
        // Step two shows the facts measured again; a push whose facts moved since step one is not confirmed on old ones.
        const again = await measure()
        if (again.key !== key) return decline('abgelehnt', '[so-hud] Stand hat sich geändert; neu bestätigen. Nichts ausgeführt.')
        const second = await askOwner([...again.effects.flat(), `${labels} jetzt genau einmal ausführen?`].join('\n'), { options: [...STEP_TWO], header: 'Bestätigen' })
        if (!second.asked) return decline('fehler', notAsked)
        if (await io.now() - firstAt > CONFIRM_WINDOW_MS) return decline('verfallen', '[so-hud] Bestätigung verfallen; nichts ausgeführt.')
        if (second.answer !== STEP_TWO[0]) return decline('abgelehnt', refused)
        after.push(...receipts)
      }
    }

    // Collisions with a peer's wave scope (F8), on the cached snapshot only: no process start here.
    const filePath = ['Edit', 'Write', 'NotebookEdit'].includes(e.tool)
      ? typeof args.file_path === 'string' ? args.file_path : typeof args.notebook_path === 'string' ? args.notebook_path : null : null
    if (filePath !== null && current !== null) {
      const { hits } = findCollisions({ filePath, repoRoot: current.repo.root, ownSessionId: await io.sessionId(), peers: current.peers })
      const collision = collisionVerdict(hits, profile)
      if (collision.aktion === 'ablehnen') return done({ deny: collision.text })
      if (collision.aktion === 'warnen') toast(collision.text)
      if (collision.aktion === 'fragen') {
        const r: Receipt = { aktion: 'kollision', tool: e.tool, text: filePath, art: e.tool.toLowerCase() }
        const asking = await canAsk()
        const asked = asking ? await askOwner(`${collision.text}\nTrotzdem in ${displayText(filePath)} schreiben?`, { options: [...collision.optionen], header: 'Kollision' }) : null
        const answer = asked?.answer ?? null
        if (answer === 'Trotzdem') after.push(r)
        else {
          if (!asking) {
            const who = [...new Set(hits.map(hit => hit.session_id))].join(', ')
            return done({ deny: `[so-hud] Kollision mit ${who} und niemand zum Fragen da (kopfloser Lauf); nichts geschrieben.` })
          }
          if (asked !== null && !asked.asked) {
            await record([r], 'fehler', null)
            return done({ deny: `${collision.text}\n[so-hud] Die Rückfrage an den Owner ließ sich nicht stellen; nichts geschrieben. Der Owner hat nicht entschieden.` })
          }
          await record([r], 'abgelehnt', null)
          const sid = (await io.sessionId()).slice(0, 8)
          return done({ deny: answer === 'Worktree vorschlagen'
            ? `${collision.text}\nNichts geschrieben. Vorschlag: git -C ${current.repo.root} worktree add ${current.repo.root}-${sid} -b wt/${sid} — dort weiterarbeiten.`
            : `${collision.text}\n[so-hud] Abgebrochen; nichts geschrieben. Nicht erneut versuchen, ohne den Owner zu fragen.` })
        }
      }
    }

    passed.add(id)
    const ran = await next(e)
    if (after.length > 0) {
      const outcome = ran.deny !== undefined ? 'abgelehnt' : 'ausgefuehrt'
      const code = (ran.result as { exitCode?: unknown } | undefined)?.exitCode
      const exit = ran.deny !== undefined ? null : typeof code === 'number' && Number.isSafeInteger(code) ? code : ran.isError === true ? 1 : 0
      await record(after, outcome, exit)
    }
    if (ran.deny !== undefined) return done(ran)

    // Secret shield (SEC-008): what reaches the model never carries a token.
    // Both channels are checked: a hook's own `{ result }` carries no `text`, and an empty or clean `text` says
    // nothing about `result` — either may be what the model reads.
    const serialized = JSON.stringify(ran.result ?? null)
    if (!hasSecret(ran.text ?? '') && !hasSecret(serialized)) return done(ran)
    const hits: SecretHit[] = []
    const kinds = () => [...new Set(hits.map(hit => hit.name))].join(', ')
    if (ran.isError === true) {
      const text = await redactText(ran.text || serialized, hits)
      toast(`[so-hud] Secret in der Ausgabe geschwärzt (${kinds()}); rotieren.`)
      return done({ deny: `[so-hud] Fehlerausgabe enthielt ein Secret und ist geschwärzt:\n${text}` })
    }
    const result = await redactDeep(ran.result, hits) as typeof ran.result
    const text = ran.text === undefined ? {} : { text: await redactText(ran.text, hits) }
    toast(`[so-hud] Secret in der Ausgabe geschwärzt (${kinds()}); rotieren.`)
    return done({ result, ...text, context: [`[so-hud] Die Ausgabe enthielt ein Secret (${kinds()}) und ist geschwärzt. Den Wert nicht erneut ausgeben; den Owner auf Rotation hinweisen.`] })
  }).catch(($, e) => {
    const id = e.tool_use_id
    const seen = classes.get(id)
    classes.delete(id)
    if (passed.has(id)) return { deny: '[so-hud] Ausgabe zurückgehalten (Fehler im Schutz-Hook).' }
    if (profile === 'locker' && seen !== undefined && !seen.outward && !seen.sec008) {
      try { $.ui.toast('[so-hud] Schutz-Hook fehlgeschlagen; der Aufruf läuft ungeprüft (Profil locker).', { timeoutMs: 8000 }) } catch { /* best effort */ }
      return undefined
    }
    return { deny: '[so-hud] Schutz-Hook fehlgeschlagen; der Aufruf läuft nicht.' }
  })
  // The engine refuses a second unmatched registration of one event; this match-all matcher (every tool name)
  // lets the beacon hook stand beneath the gate. The gate itself stays unmatched, so no call can slip past it.
  on('tool.call', { tool: /^/ }, async ($, e, next) => {
    if (e.agentId) return next(e)
    if (e.tool === 'AskUserQuestion') await write(io, { zustand: 'wartet', warte_grund: 'dialog', heuristisch: false })
    else if (own?.warte_grund === 'freigabe') await write(io, { zustand: 'arbeitet', warte_grund: null, heuristisch: false })
    const result = await next(e)
    // No telemetry error can cause this tool to execute twice.
    await write(io, { zustand: 'arbeitet', warte_grund: null, heuristisch: false }).catch(() => { problems.add('beacon-write-failed') })
    return result
  }).catch(($, e, next) => next(e))
  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    if (result.decision === 'ask' && !e.agentId && e.tool_use_id && e.tool !== 'AskUserQuestion') await write(io, { zustand: 'wartet', warte_grund: 'freigabe', heuristisch: false }).catch(() => { problems.add('beacon-write-failed') })
    return result
  }).catch(($, e, next) => next(e))
  on('session.end', async ($, e, next) => {
    ending = true
    cancel?.()
    await beaconWrites.catch(() => undefined)
    if (own) await helper(io, 'remove', own.session_id).catch(() => { problems.add('beacon-remove-failed') })
    own = null
    return next(e)
  }).catch(($, e, next) => next(e))
  // /profile (#1552): answered here without next, so it runs no model turn and adds no `context`; the `text` row is stored
  // in the transcript, so the model reads it on its next turn.
  on('command.run', { command: 'profile' }, async ($) => {
    opened = true
    try { $.ui.invalidate('ui.render') } catch { /* nothing drawn to refresh (claude -p) */ }
    return { text: profileText(profile, chosen === true) }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e)
    let lines: string[] = []
    try {
      const usage = await io.usage()
      lines = findings(await snapshot(io), usage.context, own?.letzter_request_at ?? null, await io.now(), [...problems])
    } catch { /* the profile band still draws */ }
    const showProfile = opened || (chosen === false && !dismissed)
    if (!lines.length && !showProfile) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const toast = (text: string) => { try { $.ui.toast(text, { timeoutMs: 8000 }) } catch { /* best effort */ } }
    // Persists through the /config row of this plugin's strictness field; a successful set reloads the plugin.
    const choose = async (value: SoProfile) => {
      if (choosing) return
      choosing = true
      // The flag is written before $.config.set: a successful set reloads the plugin, so this instance may
      // never run past it, and the default profile may leave no setting holdsProfile can see. Every path
      // that stores nothing puts the flag back as it was.
      let before: unknown
      const restore = async () => {
        try { await (before === undefined ? $.store.delete('profile-chosen') : $.store.set('profile-chosen', before)) } catch { /* best effort */ }
      }
      try {
        before = await $.store.get('profile-chosen').catch(() => undefined)
        await $.store.set('profile-chosen', true).catch(() => undefined)
        const name = $.plugin.name
        const row = (await $.config.list()).find(r => r.key === `${name}.strictness` || (r.provider.plugin === name && r.key.endsWith('.strictness')))
        if (!row) {
          await restore()
          return toast('[so-hud] Profil nicht gespeichert: /config hat keinen Eintrag strictness von so-hud.')
        }
        const set = await $.config.set({ key: row.key, value })
        if (set.deny !== undefined) {
          await restore()
          return toast(`[so-hud] Profil nicht gespeichert: ${displayText(set.deny)}`)
        }
        chosen = true
        opened = false
        toast(`[so-hud] Profil ${value} gespeichert (/config).`)
      } catch {
        await restore()
        toast('[so-hud] Profil nicht gespeichert (Fehler beim Schreiben).')
      }
      finally {
        choosing = false
        try { $.ui.invalidate('ui.render') } catch { /* instance already reloaded */ }
      }
    }
    // No hotkeys on the profile buttons: a bare digit typed into an empty prompt presses a band Button, and a
    // letter can take another mod's band hotkey — either would change the host-wide profile by accident.
    const band = showProfile ? <Box flexDirection="column">
      {profileLines(profile, chosen === true).map((line, i) => <Text key={`profil-zeile-${i}`} dimColor={i > 0}>{line}</Text>)}
      <Box gap={2}>
        {PROFILES.map(p => <Button key={`profil-${p}`} label={p} variant={p === profile ? 'primary' : undefined} onPress={() => void choose(p)} />)}
        {opened ? <Button key="profil-schliessen" label="Schließen" role="dismiss" onPress={() => { opened = false; dismissed = true; $.ui.invalidate('ui.render') }} /> : null}
      </Box>
    </Box> : null
    return <Box flexDirection="column">{band}{lines.length ? <Text color="yellow">{lines.join(' · ')}</Text> : null}{below}</Box>
  }).catch(($, e, next) => next(e))
}
