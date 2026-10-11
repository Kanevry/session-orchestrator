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
  de: { red: 'rot', error: 'Fehler', off: 'aus', partial: 'teilweise gemessen', setup: 'nicht eingerichtet', mirror: 'Vault-Spiegel fehlgeschlagen', peer: 'Peer im selben Working Copy', scope: 'Peer ohne bekannten Scope im selben Working Copy', context: 'Kontext', cold: 'Cache kalt' },
  en: { red: 'red', error: 'error', off: 'off', partial: 'partially measured', setup: 'not configured', mirror: 'Vault mirror failed', peer: 'Peer in the same working copy', scope: 'Peer with unknown scope in the same working copy', context: 'Context', cold: 'Cache cold' },
} as const
export function time(at: string | null): string {
  if (!at || !Number.isFinite(Date.parse(at))) return '?'
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
export function statusText(s: SoSnapshot | null, profile: SoProfile, language: keyof typeof tables = 'de'): string {
  const t = tables[language]
  if (!s) return `SO ${t.setup} · ${profile}`
  const g = s.gate.last
  const vault = s.vault
  const bad = vault.last_run && (vault.last_run.aborted || (vault.last_run.failed ?? 0) > 0)
  return [s.state.session_type, s.wave.number !== null ? `W${s.wave.number}/${s.state.total_waves ?? '?'}` : null,
    s.wave.role, s.wave.agents_total !== null ? `${s.wave.agents_total} Agents` : null,
    g ? `Gate ${g.passed === true ? 'ok' : g.passed === false ? t.red : '?'} ${time(g.at)}` : null,
    `${s.degraded.some(d => /discovery|registry/.test(d)) ? '?' : s.peers.length} Peer`, `Vault ${vault.enabled === false ? t.off : bad ? t.error : vault.enabled === true ? time(vault.last_run?.at ?? null) : '?'}`, profile,
    s.degraded.length ? t.partial : null].filter(Boolean).join(' · ')
}
export function findings(s: SoSnapshot | null, context: { percent?: number; tokens?: number }, lastRequest: string | null, now: number): string[] {
  const out: string[] = []
  if (s?.gate.last?.passed === false) out.push(`Gate rot: ${s.gate.last.variant ?? '?'} ${s.gate.last.check_failed === true ? 'check_failed' : s.gate.last.exit_code ?? '?'}`)
  if (s?.peers.some(p => p.gleiches_working_copy)) out.push(s.peers.some(p => p.gleiches_working_copy && p.scope_paths === null) ? tables.de.scope : tables.de.peer)
  if (s?.vault.enabled && s.vault.last_run && (s.vault.last_run.aborted || (s.vault.last_run.failed ?? 0) > 0)) out.push(`${tables.de.mirror}: ${s.vault.last_run.aborted ?? s.vault.last_run.failed}`)
  if ((context.percent ?? -1) >= 80) out.push(`Kontext ${context.percent} %`)
  if (lastRequest && now - Date.parse(lastRequest) >= 3_600_000 && (context.tokens ?? 0) >= 100_000) out.push(tables.de.cold)
  return out
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
