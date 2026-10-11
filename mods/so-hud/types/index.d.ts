/** Standalone public wire contract; null means unmeasured. Engine nouns are asynchronous. */
export type SoProfile = 'locker' | 'ausgewogen' | 'streng'
export type SoState = 'arbeitet' | 'wartet' | 'bereit' | 'blockiert' | 'unbekannt'
export interface SoBeacon {
  schema_version: 1; session_id: string; name: string | null; repo_name: string | null
  branch: string | null; pid: number | null; zustand: SoState; seit: string
  warte_grund: 'dialog' | 'freigabe' | 'frage' | null; heuristisch: boolean
  kontext_prozent: number | null; letzter_request_at: string | null; modell: string | null
  welle: number | null; aktualisiert_at: string
}
export interface SoSnapshot {
  schema_version: 1; measured_at: string; age_ms: number
  repo: { root: string; name: string }
  lock: { session_id: string | null; live: boolean; last_heartbeat: string | null } | null
  session: { session_id: string; semantic_session_id: string | null } | null
  wave: { running: boolean | null; number: number | null; role: string | null; agents_total: number | null; source: string | null }
  agents: { entries: { id: string; typ: string | null; modellfamilie: string | null; status: string | null; tokens: null; letzter_request_at: null; quelle: string }[]; source: string | null; at: string | null; degraded: unknown }
  state: { status: string | null; session_type: string | null; current_wave: number | null; total_waves: number | null }
  gate: { last: { variant: string | null; passed: boolean | null; check_failed: boolean | null; exit_code: number | null; at: string | null } | null; last_green_sha: string | null }
  peers: { session_id: string; branch: string | null; status: string | null; current_wave: number | null; last_heartbeat: string | null; gleiches_working_copy: boolean; scope_paths: string[] | null }[]
  vault: { enabled: boolean | null; mode: string | null; last_run: { at: string | null; created: number | null; updated: number | null; failed: number | null; aborted: string | null } | null; board: { action: string | null; at: string | null } | null }
  degraded: string[]
}
export interface So {
  version(): 1
  snapshot(): Promise<SoSnapshot | null>
  beacons(): Promise<SoBeacon[]>
  profile(): SoProfile
}
declare module 'claude-code' { interface EngineInterface { so: So } }
