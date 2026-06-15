# Feature: gsd Pattern Adoption — Quick-Win Bundle

**Date:** 2026-05-22
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Hardened (follow-ups closed in #522-#525, 2026-05-22)
**Appetite:** 2w (Medium Batch)
**Parent Project:** session-orchestrator

## 1. Problem & Motivation

### What
Vier hoch-Hebel-Patterns aus den Repos `gsd-build/gsd-2` (Standalone-Coding-Agent, ~7.7k stars) und `gsd-build/get-shit-done` (Claude-Code-Plugin, ~63.6k stars) als ein gebündeltes Feature in unser `session-orchestrator`-Plugin adoptieren:

1. **STATE.md Lockfile** mit atomic create + PID-Liveness, um Race-Conditions zwischen parallelen Workern (heute durch `autopilot-multi`, künftig durch beliebige Sessions im selben Repo) mechanisch statt durch Verhaltensregel zu verhindern.
2. **Slopcheck / Package-Legitimacy-Gate** — Defense gegen LLM-halluzinierte npm-/pip-/cargo-Package-Namen ("Slopsquatting", dokumentierte Vorfälle 2024/2025), mit Registry-spezifischer Verifikation und `[LEGITIMATE]/[ASSUMED]/[SUS]/[SLOP]`-Klassifikation.
3. **`gh-templates-first` PreToolUse-Hook** — blockt `gh/glab pr|issue|mr create` ohne vorhergehendes Read eines passenden `.github/`- oder `.gitlab/`-Templates; macht aus der `gitlab-ops`-Skill-Dokumentation einen mechanischen Gate.
4. **Verification-Auto-Fix-Loop mit bounded retries (max 2)** — bei Wave-Quality-Gate-Failure bis zu 2 Fixer-Agent-Aufrufe mit Failure-Context-Anreicherung statt sofortigem Abort.

### Why
Die strukturierte Vergleichsanalyse beider gsd-Repos in der Session vom 2026-05-22 hat zwölf Pattern-Lücken identifiziert. Vier davon haben den günstigsten Hebel/Aufwand-Quotient — sie schließen jeweils an bestehende Infrastruktur unseres Plugins an und benötigen keinen Architektur-Shift:

- `scripts/lib/session-lock.mjs` existiert bereits mit `acquire()`/`release()`/`inspect()`, atomic tmp+rename und PID-Liveness-Check. STATE.md-Lock ist eine Erweiterung um eine zweite Lock-Datei, kein neues Modul.
- `hooks/post-tool-failure-corrective-context.mjs` schreibt bereits `corrective_context`-Entries in `.orchestrator/current-session.json`. Auto-Fix-Loop liest diese und reicht sie an den Fixer-Agent weiter.
- 13 Subagents im `agents/`-Verzeichnis (`code-implementer`, `test-writer`, `architect-reviewer`, …) bilden den Auto-Fix-Pool.
- `hooks/pre-bash-destructive-guard.mjs` ist die etablierte Vorlage für einen weiteren PreToolUse-Hook auf `Bash`-Matcher.
- `.npmrc` mit `ignore-scripts=true` (SEC-020) ist Baseline-Defense gegen Postinstall-Malware, aber **erkennt keine halluzinierten Package-Namen** — diese Lücke schließt Pattern 2.

VCS-Recherche (2026-05-22, `glab issue list`): **null Duplikate** in den vier Themenbereichen. Es gibt keine kollidierenden offenen MRs. Grünes Licht zur Issue-Anlage.

Cautionary tale (verifiziert via `CLAUDE.md` "Critical Gotchas"): das 8-Pipeline-silent-regression vom 2026-05-09 wurde durch fehlende mechanische Gates ermöglicht — Verhaltensregeln allein verhindern den Wiederholungsfall nicht. Die vier Patterns dieses PRDs sind alle vom Typ "mechanischer Gate statt Verhaltensregel".

### Who
- **Primärer Konsument:** Operator (Bernhard) — direkter Nutzer von `/autopilot`, `/autopilot-multi`, `/go`, `/plan` mit ≥5 gleichzeitigen Claude-Prozessen (laut Host-Banner dieser Session: 7 aktive Claude-Prozesse, 14% CPU-Load) — also bereits in der parallel-session-Risikozone.
- **Sekundärer Konsument:** Consumer-Repos, die `session-orchestrator` als Plugin installiert haben. Alle vier Features sind opt-in oder additiv — kein Breaking-Change für bestehende Sessions.
- **Tertiärer Konsument:** Plugin-CI selbst — die `npm test`/`npm run lint`/`npm run typecheck`-Trias profitiert direkt von Pattern 4 (Auto-Fix-Loop) wenn opt-in aktiviert.

## 2. Solution & Scope

### In-Scope
- [ ] **Pattern 1 — STATE.md-Lock-Wrapper** in `scripts/lib/session-lock.mjs`: zweite Lock-Datei `.orchestrator/state.lock`, neue Helper `acquireStateLock({ timeoutMs })`/`releaseStateLock()`/`withStateMdLock(fn)`. Alle bestehenden Aufrufe in `scripts/lib/state-md/{frontmatter-mutators,body-sections,mission-status}.mjs` werden auf `withStateMdLock()` umgestellt. Stale-Lock-Override per PID-Liveness wie im bestehenden Modul.
- [ ] **Pattern 2 — Slopcheck-MVP** als neues Modul `scripts/lib/slopcheck.mjs`: `classifyPackages(pkgs[])` → Array `{ name, registry, classification }` mit Werten `LEGITIMATE` (Registry-Existenz + Download-Count > Schwellwert), `ASSUMED` (existiert, aber sehr neu / wenig Downloads), `SUS` (Audit-Warnung), `SLOP` (nicht in Registry). Integration: neue Plan-Skill-Phase 3.5 prüft Packages aus generierten PRDs; neue Discovery-Probe `supply-chain-slopcheck.mjs`; opt-in Pre-Commit-Hook (off by default).
- [ ] **Pattern 3 — `pre-bash-templates-first` Hook** als `hooks/pre-bash-templates-first.mjs`, PreToolUse-Matcher `Bash`, geladen via `hooks/hooks.json`. Inspektion: regex-Match `^\s*(gh|glab)\s+(pr|mr|issue)\s+(create|new)`. Wenn Match und Transcript der laufenden Session keine `Read` auf `.github/PULL_REQUEST_TEMPLATE*` / `.github/ISSUE_TEMPLATE*` / `.gitlab/merge_request_templates/*` / `.gitlab/issue_templates/*` enthält → exit 2 + stderr mit Template-Pfaden. Acknowledgement-Datei `.orchestrator/runtime/templates-acknowledged.json` (per Session) erlaubt nach explizitem Bestätigen das Weitermachen. Policy in `.orchestrator/policy/templates-policy.json` (Allow-List für Hosts, Bypass-Patterns).
- [ ] **Pattern 4 — Verification-Auto-Fix-Loop** in `scripts/lib/quality-gate.mjs` + `skills/wave-executor/SKILL.md`: nach jedem Inter-Wave Quality-Gate-Failure wird, falls Session Config `verification-auto-fix.enabled: true` und Retry-Budget noch nicht erschöpft (default 2), ein Fixer-Subagent dispatched mit (a) Failure-Output, (b) `corrective_context` aus `.orchestrator/current-session.json`, (c) Pfaden der geänderten Files seit letztem Pass. Nach Pass: Wave normal fortgesetzt. Nach 2 erfolglosen Retries: hartes Abort + Diagnostics-Bundle in `.orchestrator/metrics/verification-failures/<timestamp>.json`.
- [ ] **Session Config-Erweiterung** in `CLAUDE.md`: neue Top-Level-Keys `state-md-lock: { enabled: true, timeout-ms: 10000 }`, `slopcheck: { enabled: false, registry-threshold-downloads: 100, sources: [plan, discovery] }`, `templates-first: { enabled: true, hosts: [github, gitlab] }`, `verification-auto-fix: { enabled: false, max-retries: 2 }`. Update von `docs/session-config-template.md` und entsprechende Erweiterung von `claude-md-drift-check` Check 6 (Top-Level-Key-Parity).
- [ ] **Tests:** Vitest-Unit-Tests pro Modul (`session-lock` neue Pfade, `slopcheck.mjs`, Hook-Logic, Auto-Fix-Loop in isolation). Integration-Test: simuliere zwei parallele `withStateMdLock()`-Caller, eines muss warten oder fail-after-timeout. Hook-Integration: planted leak in tmp git repo, assert exit 2.
- [ ] **Dokumentation:** 1 neue Rule-Datei `.claude/rules/quality-gates-autofix.md` (path-scoped). Update von `security.md` SEC-020 um Slopcheck-Referenz. Update von `parallel-sessions.md` um Hinweis "Pattern 1 setzt PSA-003/PSA-004 mechanisch durch". `gitlab-ops` Skill um Hinweis auf `templates-first`-Hook.

### Out-of-Scope
- **Externe Libraries (`proper-lockfile`, `slopcheck`-CLI, `socket-cli`).** Begründung: eigener Stil im Repo (`session-lock.mjs` own-rolled), keine neue npm-Dependency, Slopcheck-CLI hat unklare Maintenance-Lage. Re-evaluation bei Pattern 2 nach 3 Monaten Erfahrung.
- **DB-authoritative State (gsd-2-Pattern).** Zu viel Refactor-Risiko für ein 2-Wochen-Feature; separates "Big Batch"-Vorhaben.
- **Two-Stage Namespace Routing der Skills.** Eigene Feature mit eigenem PRD — siehe Follow-up-Liste in der Vergleichsanalyse.
- **Capability-aware Multi-Provider Routing (gsd-2 ADR-004/005).** Strategisches Vorhaben.
- **Cross-Session Knowledge-Threads (`gsd-thread`-Equivalent).** Eigenes Feature.
- **gsd-2 Drift-Detection-Framework-Refactor.** Eigene Architektur-Diskussion (claude-md-drift-check + vault-sync bleiben getrennt für dieses PRD).
- **autopilot-forensics-Command.** Nice-to-have, kein Quick-Win.
- **`gh-templates-first` für Edit-Operations** (`gh pr edit`, `glab mr edit`). Nur `create`/`new` in Scope; Edit-Workflow ist anders.
- **Slopcheck im Live-`pnpm install`-Hook.** Pre-Commit / Plan / Discovery genügen für MVP. Live-Hook ist Iteration 2.

## 3. Acceptance Criteria

### Pattern 1 — STATE.md-Lock
```gherkin
Given session-orchestrator läuft mit zwei parallelen Worker-Sessions im selben Repo
When beide Sessions versuchen, STATE.md gleichzeitig zu schreiben (via withStateMdLock)
Then akzeptiert genau eine Session den Lock, die andere wartet bis zu 10s
  And nach Lock-Release der ersten Session schreibt die zweite ohne Datenverlust
  And ein Test mit zwei async Promises bestätigt deterministisch serialisierte Schreibreihenfolge
```

```gherkin
Given .orchestrator/state.lock existiert mit einer PID, deren Prozess nicht mehr lebt
When ein neuer Caller acquireStateLock() ruft
Then erkennt der Mechanismus den Stale-Lock per kill(pid, 0)
  And übernimmt den Lock atomar
  And schreibt ein WARN in stderr ("stale state.lock from PID <n> overridden")
```

### Pattern 2 — Slopcheck
```gherkin
Given ein PRD nennt drei npm-Packages: "react", "absolutely-fake-pkg-9z", "next" 
When classifyPackages() aus scripts/lib/slopcheck.mjs auf dieser Liste läuft
Then liefert die Funktion ein Array mit den Klassifikationen
    [{ name: "react", classification: "LEGITIMATE" },
     { name: "absolutely-fake-pkg-9z", classification: "SLOP" },
     { name: "next", classification: "LEGITIMATE" }]
  And das Modul nutzt 'npm view <pkg> versions --json' für die Verifikation
  And cached Antworten in .orchestrator/runtime/slopcheck-cache.json (TTL 24h)
```

```gherkin
Given Session Config hat slopcheck.enabled: true
When ein /plan feature PRD generiert wird, das eine pip-Package "leftpad-helper" listet
Then ruft die plan-Skill in einer neuen Phase 3.5 classifyPackages() auf
  And ein Package mit Klassifikation SLOP führt zu einer AskUserQuestion ("Package nicht in Registry — abbrechen, Name korrigieren, oder als 'experimentell' markieren?")
  And bei Klassifikation ASSUMED wird ein Acknowledgement im PRD-Body als Section "Package Legitimacy Audit" gespeichert
```

### Pattern 3 — gh-templates-first
```gherkin
Given das Repo enthält .gitlab/merge_request_templates/Default.md
  And der Coordinator hat in dieser Session noch keinen Read auf diese Datei ausgeführt
When der Coordinator versucht "glab mr create --title foo --description bar" auszuführen
Then blockt der Hook pre-bash-templates-first die Bash-Ausführung mit exit code 2
  And die stderr-Meldung listet alle gefundenen Template-Pfade
  And empfiehlt: "Read .gitlab/merge_request_templates/Default.md zuerst, oder schreibe '/templates-ack' für Bypass"
```

```gherkin
Given der Coordinator hat "/templates-ack" geschrieben oder den Template-Pfad gelesen
When er denselben "glab mr create" Call wiederholt
Then lässt der Hook den Call passieren (exit 0)
  And das Acknowledgement bleibt für die laufende Session in .orchestrator/runtime/templates-acknowledged.json gespeichert
```

### Pattern 4 — Verification-Auto-Fix-Loop
```gherkin
Given Session Config hat verification-auto-fix.enabled: true (max-retries: 2)
  And eine Wave ist gerade fertig dispatched
  And npm run typecheck failed mit drei TypeScript-Errors
When der wave-executor das Inter-Wave Quality-Gate auswertet
Then sammelt er Failure-Output + corrective_context + geänderte Pfade
  And dispatched einen code-implementer Fixer-Agent mit diesem Bundle
  And nach Agent-Completion läuft das Quality-Gate erneut
  And bei Pass: Wave wird als grün markiert
  And bei zweitem Fail: zweiter Fixer-Agent läuft mit angereichertem Context
  And bei drittem Fail: harter Abort + Diagnostics-Bundle in .orchestrator/metrics/verification-failures/<ts>.json
```

```gherkin
Given Session Config hat verification-auto-fix.enabled: false (Default)
When ein Inter-Wave Quality-Gate fail't
Then verhält sich wave-executor identisch zu heute (sofortiger Abort)
  And keine Fixer-Agents werden dispatched
  And kein Diagnostics-Bundle wird geschrieben
```

## 3.A Acceptance Criteria (EARS)

> Optional — translates Section 3 für `/write-executable-plan` Stub-Generation.

### Feature Area 1 — STATE.md-Lock
- **Ubiquitous:** The state-lock helper shall use atomic tmp-file + rename for lock acquisition.
- **Event-driven:** When `withStateMdLock(fn)` is called, the helper shall acquire `.orchestrator/state.lock` before invoking `fn`, and release on `fn` completion or throw.
- **State-driven:** While a lock is held by a living PID, concurrent `acquireStateLock()` callers shall wait up to `state-md-lock.timeout-ms` (default 10000).
- **Unwanted behaviour:** If the lock-holder PID is not alive, then the helper shall override the lock atomically and write WARN to stderr.

### Feature Area 2 — Slopcheck
- **Ubiquitous:** The classifyPackages helper shall return one classification per input entry, never undefined.
- **Event-driven:** When a package is queried, the helper shall first check `.orchestrator/runtime/slopcheck-cache.json` (TTL 24h) before hitting the registry.
- **Optional feature:** Where Session Config has `slopcheck.enabled: true`, the plan-skill shall invoke classifyPackages() in Phase 3.5 against any package mentions in the generated PRD.
- **Unwanted behaviour:** If `npm view` returns non-zero exit code for a package, then the helper shall classify it as `SLOP`.

### Feature Area 3 — gh-templates-first Hook
- **Ubiquitous:** The hook shall only inspect Bash tool calls; non-Bash tool calls pass through.
- **Event-driven:** When the Bash command matches `^\s*(gh|glab)\s+(pr|mr|issue)\s+(create|new)`, the hook shall check the transcript for prior Reads on matching template paths.
- **State-driven:** While `.orchestrator/runtime/templates-acknowledged.json` contains the current session-id, the hook shall pass create/new calls through.
- **Unwanted behaviour:** If the match succeeds and no Read and no acknowledgement is found, then the hook shall exit 2 with stderr listing template paths.

### Feature Area 4 — Verification-Auto-Fix-Loop
- **Optional feature:** Where Session Config has `verification-auto-fix.enabled: true`, the wave-executor shall enter the retry loop on Quality-Gate failure.
- **State-driven:** While retry-budget > 0 and gate fails, the wave-executor shall dispatch a fixer-agent and re-run the gate.
- **Event-driven:** When retry-budget reaches 0 and gate still fails, the wave-executor shall write a diagnostics bundle and abort the wave.
- **Unwanted behaviour:** If `verification-auto-fix.enabled` is false, then the wave-executor shall abort on first gate failure (current behaviour preserved).

## 4. Technical Notes

### Affected Files

| File | Change Type | Pattern |
|---|---|---|
| `scripts/lib/session-lock.mjs` | extend | 1 — add `acquireStateLock()`/`releaseStateLock()`/`withStateMdLock(fn)` |
| `scripts/lib/state-md/frontmatter-mutators.mjs` | wrap | 1 — route through `withStateMdLock()` |
| `scripts/lib/state-md/body-sections.mjs` | wrap | 1 — route through `withStateMdLock()` |
| `scripts/lib/state-md/mission-status.mjs` | wrap | 1 — route through `withStateMdLock()` |
| `scripts/lib/slopcheck.mjs` | new | 2 — `classifyPackages()` + cache + registry-dispatch |
| `skills/discovery/probes/supply-chain-slopcheck.mjs` | new | 2 — discovery integration (moved from `scripts/lib/discovery/probes/` to canonical skills path in #523 follow-up) |
| `skills/plan/SKILL.md` | extend | 2 — Phase 3.5 Package-Audit |
| `skills/plan/mode-feature.md` | extend | 2 — Package-Mention in PRD-Sections triggers classifyPackages |
| `hooks/pre-bash-templates-first.mjs` | new | 3 — PreToolUse Bash matcher |
| `hooks/hooks.json` | extend | 3 — register new hook |
| `.orchestrator/policy/templates-policy.json` | new | 3 — host allow-list + bypass patterns |
| `scripts/lib/quality-gate.mjs` | extend | 4 — retry-loop + diagnostics-bundle write |
| `skills/wave-executor/SKILL.md` | extend | 4 — inter-wave checkpoint logic |
| `skills/wave-executor/wave-loop.md` | extend | 4 — auto-fix protocol |
| `CLAUDE.md` | extend | all — Session Config keys |
| `docs/session-config-template.md` | extend | all — canonical reference |
| `scripts/parse-config.mjs` | extend | all — schema validation for new keys |
| `skills/claude-md-drift-check/SKILL.md` | extend | all — top-level-key parity Check 6 |
| `.claude/rules/quality-gates-autofix.md` | new | 4 — path-scoped rule documentation |
| `.claude/rules/security.md` | extend | 2 — SEC-020 cross-reference to slopcheck |
| `.claude/rules/parallel-sessions.md` | extend | 1 — note re mechanical enforcement of PSA-003/PSA-004 |
| `tests/unit/state-md-lock.test.mjs` | new | 1 |
| `tests/unit/slopcheck.test.mjs` | new | 2 |
| `tests/unit/hook-templates-first.test.mjs` | new | 3 |
| `tests/unit/quality-gate-autofix.test.mjs` | new | 4 |
| `tests/integration/state-md-lock-concurrent.test.mjs` | new | 1 |
| `tests/integration/templates-first-blocks-create.test.mjs` | new | 3 |

### Architecture

**Pattern 1** folgt dem bestehenden `session-lock.mjs`-Stil: atomic file create per tmp+rename, JSON-Body mit `{ pid, acquiredAt, holder }`, Stale-Detection via `process.kill(pid, 0)`. Neuer Lock-Pfad `.orchestrator/state.lock` als zweite Datei neben `session.lock` — beide Locks sind orthogonal (Session-Lock = "diese Repo-Working-Copy ist von einer aktiven Session belegt"; State-Lock = "STATE.md wird gerade geschrieben"). `withStateMdLock(fn)` ist die Standardschnittstelle für alle Schreiber.

**Pattern 2** lebt als pures Modul in `scripts/lib/slopcheck.mjs` mit Side-Effect-freier `classifyPackages(pkgs)`-API. Registry-Dispatch via `child_process.execFile('npm', ['view', pkg, 'versions', '--json'])` mit 5s-Timeout. Cache: simple JSON-File mit `{ [packageName]: { classification, fetchedAt } }`, TTL 24h. Klassifikations-Regeln im selben Modul, dokumentiert mit Inline-Tests-as-comments. Plan-Skill ruft das Modul in einer neuen Phase 3.5 nach Document Generation; Discovery-Probe als reines Read-only-Probe analog zu bestehenden.

**Pattern 3** ist ein Bash-PreToolUse-Hook nach dem Vorbild `pre-bash-destructive-guard.mjs`. Das Transcript-Tracking läuft über `hooks/_lib/transcript-history.mjs` (neuer Helper), der die laufende Session-Transcript-Datei liest und nach Tool-Calls vom Typ `Read` mit passenden Pfad-Substrings sucht. Acknowledgement-Datei ist ein einfaches JSON mit `{ sessionId, acknowledgedAt }`. Policy-Datei `templates-policy.json` definiert Host-Regex (Default: `github`, `gitlab`) und Template-Pfad-Globs.

**Pattern 4** ist ein Wrapper um die bestehende Quality-Gate-Logik in `scripts/run-quality-gate.mjs`. Der wave-executor ruft jetzt `runQualityGateWithRetry({ maxRetries, dispatchFixer })`, wobei `dispatchFixer` eine Callback ist, die einen `code-implementer`-Agent mit dem Failure-Bundle anstößt. Das Diagnostics-Bundle ist ein JSON-File mit `{ wave, gate, failures, retryAttempts, finalError, changedFiles, correctiveContext }`.

### Data Model Changes
**Keine DB-Änderungen.** Drei neue File-basierte Artefakte:
- `.orchestrator/state.lock` (lock-file, transient)
- `.orchestrator/runtime/slopcheck-cache.json` (cache, TTL 24h, persistent)
- `.orchestrator/runtime/templates-acknowledged.json` (session-scoped, transient)
- `.orchestrator/metrics/verification-failures/<ISO-timestamp>.json` (persistent, opt-in Roll-up)
- `.orchestrator/policy/templates-policy.json` (config, manuell editierbar)

Plus Session Config-Erweiterung in CLAUDE.md (vier neue Top-Level-Keys).

### API Changes
**Keine externen APIs.** Internal API-Erweiterungen:
- `scripts/lib/session-lock.mjs` exportiert zusätzlich `acquireStateLock`, `releaseStateLock`, `withStateMdLock`
- `scripts/lib/slopcheck.mjs` exportiert `classifyPackages`, `getCachedClassification`, `clearCache`
- `scripts/lib/quality-gate.mjs` exportiert `runQualityGateWithRetry({ maxRetries, dispatchFixer })`
- `hooks/_lib/transcript-history.mjs` exportiert `hasReadInSession(pathPattern, sessionId)`

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|---|---|---|
| STATE.md-Lock blockt fälschlich wegen Stale-Lock-Misserkennung | Mittel — Session steht für 10s, dann Override → kein Datenverlust, aber Verzögerung | PID-Liveness-Check + harter Timeout (10s) + Override-Logik wie in bestehendem `session-lock.mjs` |
| `npm view`-Timeout in CI (langsame Networks) hängt Slopcheck | Mittel — würde Plan-Phase blockieren | 5s Timeout pro Package + fail-soft: bei Timeout → Klassifikation `ASSUMED` + WARN in stderr, kein Hard-Block |
| `gh-templates-first`-Hook erzeugt False-Positives bei legitimen Ad-hoc-Calls | Niedrig — Acknowledgement-Mechanik gibt einen 1-Klick-Bypass | Snooze-Datei `templates-acknowledged.json` per Session; Policy-Datei erlaubt Pattern-Bypass für CI/Bot-Calls |
| Auto-Fix-Loop dispatched 2× einen Fixer-Agent ohne Fortschritt → API-Kosten | Mittel — bis zu 2 extra Subagent-Calls pro fehlgeschlagener Wave | max-retries: 2 (gsd-2-default); Diagnostics-Bundle zeigt Stagnation; opt-in Default → keine bestehende Session betroffen |
| Session Config-Schema-Erweiterung bricht `claude-md-drift-check` Check 6 | Mittel — bestehende Sessions würden warnings sehen | Drift-Check selbst erweitern (siehe Affected Files) und in derselben Wave shippen |
| Subagent-Schreiber (z.B. `code-implementer`) schreibt STATE.md ohne `withStateMdLock` | Hoch — Lock wäre umgehbar | Coordinator-only-Konvention; Subagent-Prompts verbieten direkte STATE.md-Writes; Lint-Regel `no-state-md-direct-write` für `scripts/lib/state-md/*` (TODO als follow-up issue) |
| Pattern 2 Klassifikations-Regeln zu strikt → False-Positives auf neuen aber legitimen Packages | Mittel — `next@15.x.0`-RCs könnten als `ASSUMED` markiert werden | Schwellwert konfigurierbar (`registry-threshold-downloads`); `ASSUMED` ist kein Block, nur AUQ |
| Auto-Fix-Loop liefert subtil falschen Fix, der Tests-grünstellt aber Verhalten bricht | Hoch — der "silent-pass"-Anti-Pattern aus BE-012 | Diagnostics-Bundle dokumentiert jeden Retry; opt-in Default; `.claude/rules/test-quality.md` (test-the-mock anti-pattern) wird im Fixer-Prompt erwähnt |

### Dependencies
- **Issue #490** (durableCommit must commit sessions.jsonl + STATE.md): tangential — unsere STATE-Lock-Erweiterung verändert das Schreib-Verhalten in `scripts/lib/state-md/`, nicht den Commit-Pfad. Sollte vor Pattern 1 abgeschlossen sein, sonst möglicherweise Merge-Konflikt in `state-md.mjs`.
- **MR !20** (`parse-config preserve ~/-paths + inline YAML object literals`): blockierend für Session Config-Erweiterung — wir bauen darauf auf, dass YAML-Objects (z.B. `verification-auto-fix: { enabled: false, max-retries: 2 }`) korrekt geparst werden. Wenn !20 noch offen, abwarten oder mit dem Author abstimmen.
- **VCS-Status (verifiziert 2026-05-22 via `glab issue list`):** null kollidierende offene Issues für die vier Themenbereiche.
- **Plugin-Test-Suite:** muss vor jeder Wave grün sein (`npm test` exit 0). Wenn die Wave-Executor-Änderungen das nicht hinbekommen, ist Pattern 4 selbst der erste Test für Pattern 4 — Meta-Bootstrap. Manuelle Verifikation auf einem dedizierten Worktree empfohlen.
- **Owner-Persona-Layer:** unbeeinflusst — keines der vier Patterns berührt `~/.config/session-orchestrator/owner.yaml`.

### Empfohlene Wave-Reihenfolge (für die spätere Session-Plan-Phase)
1. **Wave 1 (Foundation):** Pattern 1 STATE.md-Lock + Session Config-Schema-Erweiterung + `claude-md-drift-check`-Update. Setzt mechanischen Lock vor jeder weiteren Schreib-Operation.
2. **Wave 2 (Hooks):** Pattern 3 `pre-bash-templates-first` Hook + `templates-policy.json`. Niedriges Risiko, klare Test-Bedingung.
3. **Wave 3 (Tooling):** Pattern 2 Slopcheck-MVP + Plan-Skill Phase 3.5 + Discovery-Probe. Unabhängig von Wave 1/2.
4. **Wave 4 (Quality):** Pattern 4 Verification-Auto-Fix-Loop. Höchstes Risiko, muss zuletzt — bauen auf Wave 1 (Lock-Schutz für STATE.md-Schreibvorgänge durch den Fixer).
5. **Wave 5 (Polish):** Dokumentation, Rule-Files, README-Anpassungen, Telemetrie-Roll-up.

## 6. Implementation Summary (2026-05-22)

All four patterns implemented in a 5-wave deep session on 2026-05-22. Closes #517 + sub-issues #518-#521.

### Wave 1 — Foundation (Pattern 1 STATE.md-Lock)
- `scripts/lib/session-lock.mjs` + `withStateMdLock(repoRoot, fn)` (commit `8bc4902`, fix `c0b66da` for cross-process race)
- `scripts/lib/state-md/{frontmatter-mutators,body-sections,mission-status}.mjs` on-disk wrappers
- `tests/unit/state-md-lock.test.mjs` + `tests/integration/state-md-lock-concurrent.test.mjs` + `tests/integration/state-md-lock-cross-process.test.mjs` (21 tests + 2 cross-process tests via child_process spawn)
- `.claude/rules/parallel-sessions.md` PSA-005 (commit `2eb673d`)
- Session Config: `state-md-lock: { enabled: true, timeout-ms: 10000 }` (commit `17569fe`)
- **Cross-process mutex via tmp+linkSync** (POSIX atomic create-or-fail) — initial tmp+rename had TOCTOU race fixed in inter-wave review

### Wave 2 — Hooks (Pattern 3 templates-first)
- `hooks/pre-bash-templates-first.mjs` + `hooks/_lib/transcript-history.mjs` + `.orchestrator/policy/templates-policy.json` (commits `ce86c08`, fix `684c929`)
- `tests/unit/hook-templates-first.test.mjs` + `tests/integration/templates-first-blocks-create.test.mjs` (45 tests)
- `skills/gitlab-ops/SKILL.md` cross-ref (commit `f79de3b`)
- Session Config: `templates-first: { enabled: true, hosts: [github, gitlab] }`

### Wave 3 — Tooling (Pattern 2 Slopcheck)
- `scripts/lib/slopcheck.mjs` `classifyPackages()` + cache + npm dispatch (commit `d14deea`)
- `skills/plan/SKILL.md` Phase 3.5 + `skills/plan/mode-feature.md` integration (commit `65522c1`)
- `skills/discovery/probes/supply-chain-slopcheck.mjs` (originally landed at `scripts/lib/discovery/probes/` in commit `7970877`; moved to canonical skills location in #523 follow-up)
- `tests/unit/slopcheck.test.mjs` (36 tests, commit `beb5aee`)
- Session Config: `slopcheck: { enabled: false, registry-threshold-downloads: 100, sources: [plan, discovery] }`
- **Repo smoke**: 17 packages in own package.json — all LEGITIMATE

### Wave 4 — Quality (Pattern 4 Auto-Fix-Loop)
- `scripts/lib/quality-gate.mjs` `runQualityGateWithRetry()` + diagnostics bundle (commit `7f879fc`)
- `skills/wave-executor/SKILL.md` + `wave-loop.md` integration (commit `b067715`)
- `tests/unit/quality-gate-autofix.test.mjs` (36 tests, commit `1f9efb6`)
- Session Config: `verification-auto-fix: { enabled: false, max-retries: 2 }`
- **Bootstrap-Risk LOW** per W4 architect-reviewer audit (5 failsafes verified: bounded budget, per-gate timeout, fixer-throw absorption, default-disabled, diagnostics-on-abort)

### Wave 5 — Polish + Review (this commit)
- `.claude/rules/quality-gates-autofix.md` (new rule)
- `.claude/rules/security.md` SEC-020 slopcheck cross-ref
- This PRD: status flip + summary

### Test Suite Delta
- Before session: 6502 tests passing (README badge at session-start)
- After session: 6620 tests passing, 12 skipped (verified via `npm test` — 318 test files, exit 0)
- Delta: +118 tests from W1 (state-lock) + W2 (templates-first) + W3 (slopcheck) + W4 (auto-fix-loop)
- Commit delta: 18 commits from pre-wave baseline `6692fdd` to Wave 5 (git log count verified)
- Lint, typecheck: green throughout all waves
- GitLab CI: see post-session pipeline

### Follow-up issues filed

Bundled from W5 architect-reviewer (3 HIGH + 6 MED + 1 LOW), qa-strategist (12 HIGH + 16 MED + 8 LOW), security-reviewer (0 HIGH + 3 MED + 6 LOW). 2 MED security findings landed inline (commit `aebc1df`). Remainder grouped into 4 thematic follow-ups, one per Pattern:

- **#522 — Pattern 1 STATE.md-Lock**: wire skill bodies (still inline `readFileSync`/`writeFileSync` — lock library-only); cross-host + unparseable + holder/sessionId test branches.
- **#523 — Pattern 2 Slopcheck**: integrate discovery probe (path orphan); cache TTL + persistence + npm response variants test gaps; cleanup dead `registry-threshold-downloads` knob + unused `SUS` enum.
- **#524 — Pattern 3 templates-first**: G7 transcript-history happy-path test gap; implement `/templates-ack` command; symlink hardening; YAML form-template recognition.
- **#525 — Pattern 4 Auto-Fix-Loop**: Session Config + last-green-sha + git-diff test gaps; document `*-command` keys as RCE-equivalent + session-start banner; diagnostics bundle redaction; edge-case tests.

In-session security MEDs already fixed (commit `aebc1df`):
- npm argv injection via package.json keys (slopcheck) — validate npm name grammar + prepend `--`
- bypass-pattern prefix-inclusion bypass (templates-first hook) — boundary check on trailing edge

## Follow-up Implementation (2026-05-22 deep session — issues #522-#525)

The four follow-up issues filed at the end of the initial epic (W5 review findings) were closed in a subsequent deep session on 2026-05-22 (5 waves, 24 agents dispatched: 4 Discovery + 6 Impl-Core + 1 Impl-Polish + 6 Quality + 5 W5 reviewers/docs). Each Pattern moved from "Implemented (W5 review pending)" to "Hardened (W5 follow-ups closed)".

### Pattern 1 (#522) — STATE.md-Lock skill body wire-up

Wave W1-A1 audit revealed that the two skill bodies originally targeted for wire-up — `skills/wave-executor/wave-loop.md` and `skills/session-start/SKILL.md` — had no actual STATE.md write code: the prose deviation contracts were already correct. Actual rewires landed in:

- `commands/go.md` — STATE.md writes now routed through `withStateMdLock()`
- `skills/session-end/phase-3-7a-recommendations.md` — final-phase STATE.md writer wrapped

Library-side hardening:

- Added `state-md-lock.enabled: false` short-circuit in `withStateMdLock()` so the Session Config knob is actually respected (previously hard-coded to acquire)
- 10 new tests covering cross-host scenarios, unparseable lock bodies, holder/sessionId mismatch, the structured-error return contract, and the new short-circuit path

### Pattern 2 (#523) — Slopcheck probe relocation + dead-knob cleanup

- Discovery probe moved from `scripts/lib/discovery/probes/supply-chain-slopcheck.mjs` to the canonical `skills/discovery/probes/supply-chain-slopcheck.mjs` location
- New companion doc `skills/discovery/probes-supply-chain.md` documents probe behaviour, classification matrix, and Session Config interactions
- Dead `registry-threshold-downloads` knob removed from `CLAUDE.md`, `docs/session-config-template.md`, and `scripts/lib/config/slopcheck.mjs` (never read by `classifyPackages()` — MVP fixed the threshold inline)
- `SUS` enum value retained for future use, with JSDoc clarification that the MVP classifier never emits it (reserved for npm audit integration in a later iteration)
- 13 new tests for cache TTL boundary, persistence across runs, fail-soft on `npm view` timeout, and four distinct `npm view` response-shape variants (single string version, version array, missing `versions` field, registry-404)

### Pattern 3 (#524) — templates-first hook hardening + `/templates-ack` command

- New `commands/templates-ack.md` — operator-invoked `/templates-ack` writes `.orchestrator/runtime/templates-acknowledged.json` for the active session, allowing the hook to pass create/new calls through
- `statSync` → `lstatSync` at lines 44, 334, 347 of `hooks/pre-bash-templates-first.mjs` — symlinks pointing at template paths are now rejected (closes a symlink-spoofing path)
- `.yml` and `.yaml` GitHub form-template files are now recognized as valid template Reads (issue templates in GitHub form-style use YAML, not Markdown)
- Symmetric bypass-pattern leading-whitespace strip — latent asymmetric bug where the trailing-whitespace check landed in `aebc1df` but the leading-whitespace counterpart was missing; both sides now boundary-checked
- 15 new tests including the critical G7 transcript-history happy-path test gap (Read on `.gitlab/merge_request_templates/Default.md` correctly unblocks subsequent `glab mr create` in the same session)

### Pattern 4 (#525) — Auto-Fix-Loop docs, banner, redaction

- `.claude/rules/quality-gates-autofix.md` extended with RCE-equivalent Session Config warning (the `*-command` keys are remote-code-execution-equivalent because the fixer-agent dispatches them verbatim)
- New `scripts/lib/qg-command-drift-banner.mjs` module — session-start Phase 4 banner surfaces drift between live `package.json` script commands and the Session Config `*-command` keys
- `.orchestrator/metrics/verification-failures/` added to `.gitignore` (diagnostics bundles may contain redacted secrets, never to be committed)
- STATE.md Deviation writer clarified as coordinator-only in `skills/wave-executor/wave-loop.md` and `skills/wave-executor/SKILL.md` (subagents must not write Deviation entries directly)
- Redaction logic extracted from inline `quality-gate.mjs` into dedicated `scripts/lib/quality-gate/diagnostics.mjs` with 12 redaction patterns (API keys, bearer tokens, JWT, etc.) plus `SECRET_ENV_NAME_RE` for env-var-name matching
- 60+ new tests covering `loadCommandsFromSessionConfig()`, `writeLastGreenSha()`, `listChangedFiles()`, `coerceMaxRetries()` variant inputs, `SO_WAVE_ID` env var propagation, `dispatchFixer` default branch, multi-gate cascade (lint → typecheck → test), L3 split-file refactor, and redaction-pattern unit coverage

### Net delta

- **Files**: 28 changed/created across the session
  - 6 new files: `commands/templates-ack.md`, `scripts/lib/qg-command-drift-banner.mjs`, `scripts/lib/quality-gate/diagnostics.mjs`, `skills/discovery/probes-supply-chain.md`, plus 3 new test files (`tests/unit/quality-gate-diagnostics.test.mjs`, `tests/unit/quality-gate-session-config.test.mjs`, `tests/unit/qg-command-drift-banner.test.mjs`)
  - 1 moved file: `supply-chain-slopcheck.mjs` from `scripts/lib/discovery/probes/` → `skills/discovery/probes/`
  - ~20 modified files (code + docs + tests + Session Config)
- **Tests**: 6620 → 6731 net (≈ +111 new tests in merge — intermediate counts during W4 were higher because some agents extended existing test files rather than landing new ones)
- **Waves**: 5, with 24 agents dispatched (4 Discovery + 6 Impl-Core + 1 Impl-Polish + 6 Quality + 5 W5 reviewers/docs)
- **Quality gates**: lint 0 errors, typecheck 212 files OK, full test suite green
- **Coord-direct fixes**: 2 pre-existing meta-test failures resolved (session-lock AGENTS.md alias mention; sessions.jsonl historical record role field backfill)

### Cross-references

- Issues closed by this session: #522 #523 #524 #525
- Original epic PRD: this file (initial commit `6692fdd`)
- Session metrics: `.orchestrator/metrics/sessions.jsonl` (entry lands at session-end)
- Session decisions: vault-mirror to `~/Projects/vault/01-projects/session-orchestrator/decisions.md` (lands at session-end)

## Follow-Up Closeout (deep-session 2026-05-23)

Three W5-review follow-ups from deep-session 2026-05-22 closed:

### #526 (HIGH) — Pattern 4 banner ecosystem coherence — CLOSED
- `qg-command-drift-banner.mjs` refactored to consume `loadCommandsFromSessionConfig(repoRoot)` from `quality-gate.mjs` (single SoT).
- Return shape changed from plain string to `null | { severity: 'warn', message: string }` (mirrors `vault-staleness-banner`).
- session-start Phase 4 rendering snippet updated to consume `.message`.
- 24 test cases migrated to new shape; spurious-drift footgun eliminated (missing `*-command` keys no longer trigger drift).

### #527 (MED) — Pattern 1+4 seam hygiene — CLOSED
- **A**: `opts.stateMdLockEnabled` → `opts._stateMdLockEnabled` (leading-underscore test-only convention; 5 sites, zero behavior change).
- **B**: Removed `REDACTION_PATTERNS` + `SECRET_ENV_NAME_RE` exports from `quality-gate/diagnostics.mjs` (LANGUAGE.md one-adapter rule).
- **B**: Deleted 3 structural-shape tests; added 5 positive E2E tests (AWS, OpenAI, JWT, Slack, Stripe redaction). Net E2E coverage 9 → 14.

### #528 (LOW) — Auto-Fix-Loop polish — CLOSED
- **A**: `appendDeviationOnDisk`, `updateFrontmatterFieldsOnDisk`, `touchUpdatedFieldOnDisk`, `markExpressPathCompleteOnDisk`, `recordAutoCommitOnDisk` now require explicit `repoRoot` (throw on undefined). `commands/go.md` Express-path snippet derives repoRoot via `git rev-parse --show-toplevel`.
- **B**: 7 new tests in `quality-gate-autofix.test.mjs` Group I exercise the 21 MiB stdout overflow path — `runGate` confirmed to handle ENOBUFS gracefully (no node-level crash).
- **C** (broadened): 2 stale `scripts/lib/discovery/probes/` refs fixed outside the PRD scope (`security.md:96`, `slopcheck.mjs:40`). The 4 PRD references at lines 176/274/330/357 are intentional historical context (canonical-with-history).

### Quality outcomes
- Pipeline: deep-session-final commit (pre-push verify pending)
- Tests: +24 W2/W3 modifications + 106 NEW peer-cards tests + 7 NEW maxBuffer-overflow + 24 NEW Q6 gap-fill = +161 net new/updated tests; full suite 6845 passed / 11 skipped / 0 failed.
- Quality gates: lint PASS, typecheck PASS (217 files), Full Gate GREEN.
- Reviewer panel: Q3 security 0 findings, Q4 architect 0 RED / 4 YELLOW (filed as F4 follow-ups), Q5 cross-cutting PROCEED.
