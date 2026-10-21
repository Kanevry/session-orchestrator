# Host-Resource Signals (Always-on)

A signal may only warn if rare; warnings must change a decision.

## HR-101: A Warning Class Above ~10% Is a Broken Instrument
Above ~10% firing: re-aim the instrument, neither obey noise nor silence real protection; never merely raise thresholds.

## HR-102: Judge on the Best Signal Present, Never on a Worse One
Memory precedence: `memory_pressure_pct_free` (OS health) > `ram_available_gb` (free+inactive+speculative+purgeable) > `ram_free_gb` (os.freemem last resort). Better REPLACES worse even when below healthy pressure band, rather than merely suppressing it. Darwin free-only is misleading; Linux/Windows fallback is accurate when better unavailable.

## HR-103: Check the Unit Before the Threshold
Compare same units before tuning. concurrent-sessions-warn counts sessions, not Claude processes. Use `detectPeers()` self-excluded, heartbeat-fresh live peers.

## HR-104: Two Independent Signals Before Any Cap
Hard signal (red memory pressure, or hard-band swap WHILE memory unhealthy): critical, coordinator-direct. Two independent soft signals agreeing: warn, agents cap 2. One soft signal: report reasons, no cap. None: green. Measure prevalence before admitting an axis; usually-present signals (zombies, idle and not causing load) report, NEVER count as second opinion. Cumulative counters are not live pressure: swap counts only when memory already unhealthy. CPU judges `min(1m,5m)`; 1m-only transient spikes report, never cap.

## HR-105: A Rule You Cannot Falsify Is Not a Rule
Session-start persists verdict input signals: memory_pressure_pct_free, ram_available_gb, peer_sessions_count. Re-run firing-rate audit BEFORE threshold changes; above ~10% re-aim per HR-101; 0% across hundreds of samples also needs investigation for rarity versus broken measurement. Audit method uses started events, unique session denominator and actual signal fields, not remembered verdicts.

## HR-106: The Banner Reports What the Rule Judges
Show the number deciding the verdict. SessionStart only surfaces first stdout JSON object: emit ALL banner lines as ONE systemMessage, including working-copy ownership warnings.

## HR-107: Eine Waise ist ein Register-Treffer, kein PPID-Wert
Orphan eligibility requires ALL: own host ancestry-register PID/pgid, ppid==1, age above reaper.min-age-seconds, read-only command signature, identity check immediately before signal. PPID alone never sufficient; unknown/unregistered candidates report, NEVER kill. Unlike idle zombies, registered orphans consume measurable resources. Measure firing against reaper.false-alarm-window before changing thresholds; banner shows register matches+age, not PPID. Defaults reaper.enabled:false, mode:report. Mechanism/rejected alternatives: `docs/adr/0015-process-group-kill-and-orphan-reaper.md`; scoped details `host-resource-details.md`.

## See Also
parallel-sessions.md (PSA-001/002) · verification-before-completion.md · development.md § Guard & Threshold Design · test-value.md § TV-003 · `docs/session-config-reference.md` § resource-thresholds · § `reaper:` · `docs/adr/0015-process-group-kill-and-orphan-reaper.md`
