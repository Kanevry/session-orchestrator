import type { SoBeacon, SoProfile, SoSnapshot } from '../types/index'

export function ownerQuestion(answer: string): boolean {
  let fence: string | null = null
  const plain = answer.split('\n').filter(line => {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (mark) {
      if (!fence) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
      return false
    }
    return fence === null
  }).join('\n').trim()
  return plain.endsWith('?') || /weiter mit|soll ich|welche option|freigabe für/i.test(plain.slice(-400))
}
export const tables = {
  de: { red: 'rot', error: 'Fehler', off: 'aus', partial: 'teilweise gemessen', setup: 'nicht eingerichtet', norun: 'noch kein Lauf', measurement: 'Messung fehlgeschlagen', mirror: 'Vault-Spiegel fehlgeschlagen', peer: 'Peer im selben Working Copy', scope: 'Peer ohne bekannten Scope im selben Working Copy', context: 'Kontext', cold: 'Cache kalt' },
  en: { red: 'red', error: 'error', off: 'off', partial: 'partially measured', setup: 'not configured', norun: 'no run yet', measurement: 'Measurement failed', mirror: 'Vault mirror failed', peer: 'Peer in the same working copy', scope: 'Peer with unknown scope in the same working copy', context: 'Context', cold: 'Cache cold' },
} as const
/** Bound each displayed field; replace terminal controls and line separators. */
export function displayText(value: unknown, limit = 120): string {
  const plain = String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1)}…`
}
const measurementProblems = new Set(['refresh-failed', 'collector-failed', 'invalid-snapshot'])
function measurementFailure(problems: readonly string[]): string[] {
  return problems.filter(p => measurementProblems.has(p))
}
export function time(at: string | null): string {
  if (!at || !Number.isFinite(Date.parse(at))) return '?'
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
export function statusText(s: SoSnapshot | null, profile: SoProfile, language: keyof typeof tables = 'de', problems: readonly string[] = []): string {
  const t = tables[language]
  if (!s) {
    const failed = measurementFailure(problems)
    return displayText(`SO ${failed.length ? `${t.measurement} (${failed.join(', ')})` : t.setup} · ${profile}`)
  }
  const g = s.gate.last
  const vault = s.vault
  const bad = vault.last_run && (vault.last_run.aborted || (vault.last_run.failed ?? 0) > 0)
  // enabled null has two causes: no vault-integration block (not configured) or an unreadable CLAUDE.md/AGENTS.md (unknown).
  const vaultUnset = s.degraded.includes('config:unreadable') ? '?' : t.setup
  // Enabled but never mirrored is a state, not an unknown; '?' stays for a run whose time does not parse.
  const vaultOn = vault.last_run === null ? t.norun : time(vault.last_run?.at ?? null)
  // A repo where no session ever wrote events is fresh, not partially measured (F13): nothing is missing there.
  const partial = s.degraded.some(d => d !== 'events:absent')
  return displayText([s.state.session_type, s.wave.number !== null ? `W${s.wave.number}/${s.state.total_waves ?? '?'}` : null,
    s.wave.role, agentsText(s.agents),
    g ? `Gate ${g.passed === true ? 'ok' : g.passed === false ? t.red : '?'} ${time(g.at)}` : null,
    `${s.degraded.some(d => /discovery|registry/.test(d)) ? '?' : s.peers.length} Peer`, `Vault ${vault.enabled === false ? t.off : bad ? t.error : vault.enabled === true ? vaultOn : vaultUnset}`, profile,
    partial ? t.partial : null].filter(Boolean).map(value => displayText(value)).join(' · '), 800)
}
/**
 * The running agents of this session from the collector's live map (#1580, #1633): a number is measured, `null`
 * is unknown (`? Agents`, a map older than the session says nothing). Shown not at all without a session
 * (`no-session`: nothing to count for) or from a collector before #1580 that sends no `running` — never as 0.
 */
function agentsText(agents: SoSnapshot['agents'] | undefined): string | null {
  const running = agents?.running
  if (running === undefined || agents?.stale_reason === 'no-session') return null
  const decayed = agents?.decayed
  // Agents without a Stop past 24 h (a parallel collector change): counted apart, shown only when there are some.
  const stale = typeof decayed === 'number' && Number.isSafeInteger(decayed) && decayed > 0 ? ` (+${decayed} ?)` : ''
  return `${typeof running === 'number' && Number.isSafeInteger(running) && running >= 0 ? running : '?'} Agents${stale}`
}
export function findings(s: SoSnapshot | null, context: { percent?: number; tokens?: number }, lastRequest: string | null, now: number, problems: readonly string[] = []): string[] {
  const failed = measurementFailure(problems)
  const out: string[] = failed.length ? [`${tables.de.measurement}: ${failed.join(', ')}`] : []
  if (s?.gate.last?.passed === false) out.push(`Gate rot: ${s.gate.last.variant ?? '?'} ${s.gate.last.check_failed === true ? 'check_failed' : s.gate.last.exit_code ?? '?'}`)
  if (s?.peers.some(p => p.gleiches_working_copy)) out.push(s.peers.some(p => p.gleiches_working_copy && p.scope_paths === null) ? tables.de.scope : tables.de.peer)
  if (s?.vault.enabled && s.vault.last_run && (s.vault.last_run.aborted || (s.vault.last_run.failed ?? 0) > 0)) out.push(`${tables.de.mirror}: ${s.vault.last_run.aborted ?? s.vault.last_run.failed}`)
  if ((context.percent ?? -1) >= 80) out.push(`Kontext ${context.percent} %`)
  if (lastRequest && now - Date.parse(lastRequest) >= 3_600_000 && (context.tokens ?? 0) >= 100_000) out.push(tables.de.cold)
  return out.map(value => displayText(value))
}
export const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(v)
export function validateBeacon(v: unknown): v is SoBeacon {
  if (!v || typeof v !== 'object') return false
  const b = v as SoBeacon
  const date = (s: unknown) => typeof s === 'string' && Number.isFinite(Date.parse(s))
  const nullableString = (s: unknown) => s === null || typeof s === 'string'
  return b.schema_version === 1 && validId(b.session_id) && ['arbeitet', 'wartet', 'bereit', 'blockiert', 'unbekannt'].includes(b.zustand)
    && date(b.seit) && date(b.aktualisiert_at) && (b.letzter_request_at === null || date(b.letzter_request_at))
    && [b.name, b.repo_name, b.branch, b.modell].every(nullableString)
    && (b.pid === null || Number.isSafeInteger(b.pid) && b.pid > 0)
    && (b.welle === null || Number.isSafeInteger(b.welle) && b.welle > 0)
    && (b.kontext_prozent === null || Number.isFinite(b.kontext_prozent) && b.kontext_prozent >= 0 && b.kontext_prozent <= 100)
    && typeof b.heuristisch === 'boolean' && [null, 'dialog', 'freigabe', 'frage'].includes(b.warte_grund)
    && (b.zustand === 'wartet' ? b.warte_grund !== null : b.warte_grund === null)
    && b.heuristisch === (b.warte_grund === 'frage')
}
export function ageBeacon(b: SoBeacon, now: number, alive: boolean): SoBeacon {
  return now - Date.parse(b.aktualisiert_at) > 120_000 && !alive
    ? { ...b, zustand: 'unbekannt', warte_grund: null, heuristisch: false } : b
}
export function completeState(answer: string): Pick<SoBeacon, 'zustand' | 'warte_grund' | 'heuristisch'> {
  return ownerQuestion(answer) ? { zustand: 'wartet', warte_grund: 'frage', heuristisch: true } : { zustand: 'bereit', warte_grund: null, heuristisch: false }
}

// ---- Which hooks the git steps before a push can fire (#1574 proposal 3) ----
// Per step as rules.ts records it (`gitStep`), the hook names githooks(5) of git 2.56 lists for that command.
// A ref update fires reference-transaction, an index write post-index-change; commit and fetch end in
// `gc --auto` (pre-auto-gc); a step that reads the index may query a core.fsmonitor hook. Options a step may carry
// are not seen here (`commit --amend` → post-rewrite, `--no-verify` skips pre-commit), so each entry is the union.
const FIREABLE_HOOKS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['add', ['post-index-change', 'fsmonitor-watchman']],
  ['status', ['post-index-change', 'fsmonitor-watchman']],
  ['diff', ['post-index-change', 'fsmonitor-watchman']],
  ['ls-files', ['fsmonitor-watchman']],
  ['commit', ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-rewrite', 'reference-transaction', 'post-index-change', 'pre-auto-gc', 'fsmonitor-watchman']],
  ['fetch', ['reference-transaction', 'pre-auto-gc']],
  ['checkout -- <paths>', ['post-checkout', 'post-index-change', 'fsmonitor-watchman']],
  ...['log', 'show', 'log [signature]', 'show [signature]', 'rev-parse', 'branch --show-current', 'tag --list'].map((step): [string, readonly string[]] => [step, []]),
])

/**
 * The hook names the git steps earlier on a push's line can fire; null when any step is not in the map, which
 * means any hook may run (fail-closed). Steps outside rules.ts's LOCAL_GIT already ask there, so they need no entry.
 */
export function fireableHooks(steps: readonly string[] | undefined): ReadonlySet<string> | null {
  const names = new Set<string>()
  for (const step of steps ?? []) {
    const fired = FIREABLE_HOOKS.get(step)
    if (fired === undefined) return null
    for (const name of fired) names.add(name)
  }
  return names
}

/**
 * Whether a hook defined in config (`git config --null --get-regexp ^hook\.` output) runs on one of `names`
 * (null: on any event): a `hook.<friendly-name>.event` naming one of them, or a friendly name that is one.
 * `.enabled` is not honoured (a disabled hook still counts). null when the output does not parse or holds a
 * `hook.*` key git 2.56 does not document (asks).
 */
export function configHooksFire(output: string, names: ReadonlySet<string> | null): boolean | null {
  if (!output.endsWith('\0')) return null
  let fires = false
  for (const entry of output.slice(0, -1).split('\0')) {
    const cut = entry.indexOf('\n')
    const key = cut === -1 ? entry : entry.slice(0, cut)
    if (key === 'hook.jobs') continue
    const parts = /^hook\.(.+)\.(command|event|enabled|parallel|jobs)$/.exec(key)
    if (!parts) return null
    const [, friendly = '', variable] = parts
    if (cut === -1 && (variable === 'event' || variable === 'command')) return null
    const value = entry.slice(cut + 1).trim().toLowerCase()
    if (variable === 'event' && value !== '' && (names === null || names.has(value))) fires = true
    if (variable === 'command' && (names === null || names.has(friendly.toLowerCase()))) fires = true
  }
  return fires
}

// ---- Profile band and /profile (#1552). SSOT of the effects: docs/mods.md § Profiles. ----
export const PROFILES: readonly SoProfile[] = ['locker', 'ausgewogen', 'streng']
const PROFILE_EFFECT: Record<SoProfile, string> = {
  locker: 'Regel-Fallen und Kollisionen nur Warnung.',
  ausgewogen: 'Regel-Fallen abgelehnt, Kollision fragt.',
  streng: 'Regel-Fallen und Kollisionen abgelehnt.',
}
const PROFILE_ALWAYS = 'Auf jedem Profil: Secrets ausgeben wird abgelehnt, Außenwirkung wird zweimal bestätigt (interaktiv).'
/** Any value outside the three profiles falls back to the default `ausgewogen`, as the engine does for a stored value outside `options`. */
export function profileOf(value: unknown): SoProfile {
  return value === 'locker' || value === 'streng' ? value : 'ausgewogen'
}
/** The band's lines: the profile (marked when it is only the default), what it loosens or locks, what holds on every profile. */
export function profileLines(profile: SoProfile, chosen: boolean): string[] {
  return [`Profil: ${profile}${chosen ? '' : ' (Vorgabe, noch nicht gewählt)'}`, PROFILE_EFFECT[profile], PROFILE_ALWAYS]
}
/** /profile's output: readable alone in `claude -p "/profile"`, where no band is drawn. */
export function profileText(profile: SoProfile, chosen: boolean): string {
  return [...profileLines(profile, chosen), `Wechseln: im Band über dem Prompt (${PROFILES.join(', ')}) oder in /config, Eintrag strictness von so-hud.`].join('\n')
}
/** Whether settings hold an explicit strictness for this plugin under `pluginConfigs[<plugin>[@<marketplace>]].options`. */
export function holdsProfile(settings: unknown, plugin: string): boolean {
  const configs: unknown = (settings as { pluginConfigs?: unknown } | null)?.pluginConfigs
  if (!configs || typeof configs !== 'object') return false
  return Object.entries(configs).some(([key, entry]) => key.split('@')[0] === plugin
    && (PROFILES as readonly unknown[]).includes((entry as { options?: { strictness?: unknown } } | null)?.options?.strictness))
}
