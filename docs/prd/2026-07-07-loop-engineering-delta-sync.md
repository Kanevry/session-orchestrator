# Feature: Loop-Engineering Delta-Sync — Anthropic-Loops-Artikel → Repo-Adoption

> **RECONSTRUCTED 2026-07-07** (Session main-2026-07-07-deep-1): Das Original dieser PRD aus der `/plan`-Session vom 2026-07-07-Vormittag wurde nie committed — diese Datei wurde aus den Issue-Bodies #764–#768 rekonstruiert, damit die dort zitierten Verweise (»§3 ACs«, »§3.A EARS«) auflösen. Die Issue-Bodies sind die normative AC-Quelle; diese Datei ist nachgezogene Dokumentation, keine Wortlaut-Rekonstruktion des Originals. Nichts unterhalb dieses Banners ist erfunden — jede Aussage ist aus den fünf Issue-Bodies abgeleitet oder als explizit rekonstruiert markiert (siehe §3.A).

**Date:** 2026-07-07 (ursprüngliche `/plan`-Session, Vormittag)
**Reconstructed:** 2026-07-07 (Session main-2026-07-07-deep-1, Wave 3)
**Status:** In Umsetzung — FA1–FA4 in Bearbeitung in dieser Session (siehe §5)
**Appetite:** Small Batch (1w) — `appetite:1w` auf allen fünf Issues (#764–#768)
**Parent Epic:** #764 — `[Epic] Loop-Engineering Delta-Sync — Anthropic-Loops-Artikel → Repo-Adoption (PRD 2026-07-07)`

## 1. Kontext & Ziel

**Anlass.** Der Anthropic "designing loops"-Artikel und ein Doc-Sweep vom 2026-07-06 (`/en/goal`, `/en/routines`, `/en/workflows`, `/en/agents`, `/en/scheduled-tasks`, `/en/channels`, `/en/costs`) legten ein Delta zwischen dem im Repo dokumentierten Loop-Engineering-Wissen und dem tatsächlichen Upstream-Stand offen. Betroffen sind vier Wissensflächen: `.claude/rules/loop-and-monitor.md`, `skills/_shared/monitor-patterns.md`, `scripts/lib/loop-readiness-banner.mjs`, und — als angrenzender Live-Defekt aus demselben Sweep — der Agent-Frontmatter-Validator (`scripts/lib/agent-frontmatter.mjs` + `scripts/lib/validate/check-agents.mjs`).

**Ziel.** Alle vier Feature Areas auf den Upstream-Stand 2026-07-06 bringen, ohne die bestehende Repo-Posture zu verändern. Der Sync ist rein additiv/korrektiv: neue Sub-Rules, korrigierte Zahlen/Pfade, neue Detections — keine Neuausrichtung der Loop-Strategie.

**Scope-Abgrenzung.**
- Ausschließlich repo-intern: `.claude/rules/`, `skills/_shared/`, `scripts/lib/`, `agents/AGENTS.md` plus zugehörige Tests.
- Kurs-Material für andere Repos ist explizit **out-of-scope** (Operator-Entscheidung, siehe §4).
- Agent-Teams-Implementierung bleibt bei #484 — hier nur Querverweis, keine Duplikation.
- Alle vier Feature Areas sind voneinander unabhängig; es gibt keine Ordering-Constraints zwischen ihnen (Epic #764). Sub-Issue-Verlinkung erfolgt via `relates_to` — native `blocks`/`is-blocked-by`-Links sind auf diesem GitLab-Host nicht verfügbar (License-Tier).

## 2. Feature Areas

### FA1 — `loop-and-monitor.md` Delta-Sync (#765, `priority:high`, `type:enhancement`)

Delta-Sync von `.claude/rules/loop-and-monitor.md` gegen den Upstream-Stand 2026-07-06:

- **LM-004-Rewrite:** Routines = research preview, Anthropic-Cloud (claude.ai-Pflicht: Pro/Max/Team/Enterprise + Claude-Code-on-web). Drei Trigger-Typen: Scheduled / API `/fire` (Beta-Header `experimental-cc-routine-2026-04-01`) / GitHub (`pull_request.*` + `release.*`). 1h-Mindestintervall, daily-run-cap mit One-off-Exempt, `claude/`-Branch-Safety, Org-Toggle. Repo-Posture bleibt inline dokumentiert: **"teach it, don't run it"**.
- **Neue `/schedule`-Gating-Subrule:** CLI v2.1.81+, claude.ai-Subscription-Login erforderlich; unsichtbar auf Console-API-Key/Bedrock/Vertex/Foundry oder wenn `DISABLE_TELEMETRY`/`DO_NOT_TRACK`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`/`DISABLE_GROWTHBOOK` gesetzt ist; `/schedule list|update|run`.
- **LM-003-Update:** `CLAUDE_CODE_DISABLE_CRON=1` als Total-Kill-Switch, 50-Tasks-pro-Session-Cap, `loop.md`-25.000-Byte-Truncation.
- **LM-008-Update:** `/goal` ohne Argumente = Turns+Token-Introspektion; Restore auch via `--continue` (Turn/Timer/Token-Baseline wird zurückgesetzt); clear-Aliase `stop`/`off`/`reset`/`none`/`cancel` + `/clear`; Surfaces auf Desktop-App/Remote-Control; Workspace-Trust-Gate.
- **LM-002b-Update:** `args` als structured-data-Global (`undefined` wenn weggelassen); `/workflows` Usage-View (per-Phase Agent-Count + Token-Totals, Keys `p`/`x`/`r`/`s`/`f` ab v2.1.186); per-Stage Model-Routing; Resume nur same-session.
- **Agent-Teams-Querverweis:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (experimental, off-by-default) → Pointer auf `parallel-sessions.md` § PSA Scope Axes + ADR-0002/#484. Nur Verweis, keine Duplikation.
- **3 Stale-Fixes:** Zeile :142 und :260 ("verdict open") → RESOLVED → Stay (2026-06-20, #665); Zeile :322 See-Also um Resolution-Status ergänzen.
- **Crosswalk-Tabelle an LM-001:** vier Artikel-Loop-Typen (turn/goal/time/proactive) → Repo-Primitive + Deployment-State, wo möglich über Config-Keys statt hartkodierter Zustände.
- Re-verify-Footer aktualisieren.

**AC-Gate (mechanisch):** `rg -n "open follow-up|verdict open" .claude/rules/loop-and-monitor.md` → 0 Treffer.

### FA2 — `monitor-patterns.md`: 8→10 Kill-Switches + Pattern-3-Modernisierung (#766, `priority:medium`, `type:bug`)

`skills/_shared/monitor-patterns.md` enthält zwei aktiv widersprechende Stale-Spots:

1. Zeile :107 "eight" Kill-Switches → "ten"; Modulpfad korrigieren: `scripts/lib/autopilot.mjs` → `scripts/lib/autopilot/kill-switches.mjs` (frozen enum bei :18–32, 10 Einträge).
2. Pattern 3 modernisieren auf die Spike-#640-Realität (`docs/spikes/2026-06-12-640-background-detachment-test.md`): Bash `run_in_background` + task-id + `TaskStop` als Observability-Seam. Caveat aufnehmen: `TaskList`/`claude agents` listet den Bash-backgrounded Autopilot **nicht**.

**AC-Gate (mechanisch):** grep auf "eight" in der Datei → 0 Treffer im Kill-Switch-Kontext; Pattern 3 nennt task-id/TaskStop-Seam + TaskList-Caveat.

### FA3 — `loop-readiness-banner`: `CLAUDE_CODE_DISABLE_CRON`-Detection + `loop.md`-25KB-Truncation-Check, repo + user (#767, `priority:medium`, `type:enhancement`)

`scripts/lib/loop-readiness-banner.mjs` um zwei Silent-Failure-Detections erweitern:

1. **`CLAUDE_CODE_DISABLE_CRON` gesetzt** → warn-Banner: Cron-Scheduler + `/loop` deaktiviert (env-var-Name im Text nennen).
2. **`loop.md` > 25.000 Bytes** → warn-Banner mit Dateipfad + tatsächlicher Byte-Größe. Gilt für BEIDE Dateien unabhängig: repo-level `.claude/loop.md` UND user-level `~/.claude/loop.md` (Upstream truncatet die jeweils geladene Datei).

**Contract:** null-or-single-banner bleibt erhalten; Signatur backward-kompatibel `{repoRoot, homeDir?, env?}` (`env` default `process.env`, Injection für Tests); mehrere Findings → EIN kombiniertes warn-Banner; never throw.

**Tests:** `tests/lib/loop-readiness-banner.test.mjs` — `DISABLE_CRON` set/unset, Size-Boundary 25.000/25.001 für beide Dateien, Combined-Warning, Bestandstests grün.

**Doku:** `skills/session-start/SKILL.md` Phase-4-Prosa (~Zeilen 683–687) auf neue Banner-Bedingungen anpassen — die bisherige Aussage "Present … silent" gilt nicht mehr uneingeschränkt.

### FA4 — Model-Routing: `fable`-Alias + Claude-5-IDs im Frontmatter-Validator, SSOT-Import, `AGENTS.md`-Cost-Routing-Leitlinie (#768, `priority:high`, `type:bug`)

**Live-Defekt.** Der Validator lehnt upstream-legale Model-Werte ab: `ALLOWED_MODEL_ALIASES` (`scripts/lib/agent-frontmatter.mjs:26`) kennt kein `fable`; `MODEL_ID_RE` (`claude-(opus|sonnet|haiku)-\d+-\d+…`) weist Claude-5-IDs ab (`claude-fable-5`, `claude-sonnet-5`).

1. **`agent-frontmatter.mjs`:** Alias-Set um `fable` erweitern; Regex → `claude-(opus|sonnet|haiku|fable)-\d+(-\d+)?(-\d{8})?` (deckt `claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`). Familie bleibt closed-list, kein Wildcard.
2. **`check-agents.mjs:189`:** Inline-Model-Regex-Redeklaration entfernen → Import von `ALLOWED_MODEL_ALIASES`/`MODEL_ID_RE` aus der SSOT (`agent-frontmatter.mjs`; persona-panel-Konsumenten importieren bereits davon). Danach existiert genau EINE Deklaration im Repo.
3. **`agents/AGENTS.md`:** Cost-Routing-Leitlinie ergänzen (wann `haiku` pinnen — Präzedenz `dialectic-deriver`/`skill-applied-judge` — vs. `sonnet` vs. `inherit`; Resolution-Order `CLAUDE_CODE_SUBAGENT_MODEL` → Invocation-Parameter → Frontmatter) + Alias-Kommentar an Zeile :42 um `fable` + ein Claude-5-ID-Beispiel ergänzen.

**Tests (Negativ-Fälle Pflicht):** `fable` / `claude-fable-5` / `claude-sonnet-5` / `claude-opus-4-8` → PASS; `gpt-4` / `fable-5` / `claude-fable` / `claude-5-fable` → FAIL mit Enum-Error. Testdateien: `tests/lib/agent-frontmatter.test.mjs` + `tests/unit/check-agents.test.mjs` + `tests/scripts/validate/check-agents.test.mjs`.

## 3. Acceptance Criteria

### FA1 (#765)
- `.claude/rules/loop-and-monitor.md` enthält die LM-004-Rewrite mit allen drei Trigger-Typen, dem 1h-Mindestintervall, dem daily-run-cap (One-off-Exempt), der `claude/`-Branch-Safety und dem Org-Toggle.
- Eine neue `/schedule`-Gating-Subrule dokumentiert Versions-Gate (v2.1.81+), Login-Pflicht, die vier Unsichtbarkeits-Bedingungen (Console-API-Key/Bedrock/Vertex/Foundry; die vier env-Var-Kill-Switches) und die drei `/schedule`-Subcommands.
- LM-003 nennt `CLAUDE_CODE_DISABLE_CRON=1`, den 50-Tasks-Cap und die 25.000-Byte-Truncation.
- LM-008 nennt die argumentlose `/goal`-Introspektion, `--continue`-Restore-Verhalten, alle fünf clear-Aliase plus `/clear`, Desktop/Remote-Surfaces und das Workspace-Trust-Gate.
- LM-002b nennt den `args`-Global-Contract, die `/workflows`-Usage-View-Keys (`p`/`x`/`r`/`s`/`f`, v2.1.186+), per-Stage Model-Routing, same-session-Resume.
- Ein Agent-Teams-Pointer verweist auf `parallel-sessions.md` § PSA Scope Axes + ADR-0002/#484, ohne Inhalte zu duplizieren.
- Zeilen :142/:260 sind auf RESOLVED→Stay (#665, 2026-06-20) aktualisiert; :322 See-Also nennt den Resolution-Status.
- Eine Crosswalk-Tabelle an LM-001 mappt die vier Artikel-Loop-Typen auf Repo-Primitive.
- **Mechanisches Gate:** `rg -n "open follow-up|verdict open" .claude/rules/loop-and-monitor.md` → 0 Treffer.

### FA2 (#766)
- Zeile :107 (und jede weitere Fundstelle) nennt "ten" statt "eight" Kill-Switches, mit korrigiertem Pfad `scripts/lib/autopilot/kill-switches.mjs`.
- Pattern 3 ist auf die Spike-#640-Realität umgeschrieben: `run_in_background` + task-id + `TaskStop`, inklusive TaskList-Caveat.
- **Mechanisches Gate:** grep auf "eight" im Kill-Switch-Kontext → 0 Treffer.

### FA3 (#767)
- `loop-readiness-banner.mjs` erkennt `CLAUDE_CODE_DISABLE_CRON` und meldet ein warn-Banner, das den env-var-Namen im Text nennt.
- `loop-readiness-banner.mjs` erkennt `loop.md` > 25.000 Bytes für sowohl `.claude/loop.md` (repo) als auch `~/.claude/loop.md` (user), unabhängig voneinander, und meldet Pfad + Byte-Größe.
- Contract bleibt erhalten: null-or-single-banner, kombiniertes Banner bei mehreren Findings, `{repoRoot, homeDir?, env?}`-Signatur backward-kompatibel, never throw.
- `tests/lib/loop-readiness-banner.test.mjs` deckt: DISABLE_CRON set/unset, Boundary 25.000/25.001 für beide Dateien, Combined-Warning-Fall, alle Bestandstests bleiben grün.
- `skills/session-start/SKILL.md` Phase-4-Prosa ist an die neuen Banner-Bedingungen angepasst.

### FA4 (#768)
- `ALLOWED_MODEL_ALIASES` enthält `fable`; `MODEL_ID_RE` matched `claude-(opus|sonnet|haiku|fable)-\d+(-\d+)?(-\d{8})?` als closed-list ohne Wildcard.
- `check-agents.mjs:189` importiert `ALLOWED_MODEL_ALIASES`/`MODEL_ID_RE` aus der SSOT statt sie inline neu zu deklarieren — genau eine Deklaration im Repo.
- `agents/AGENTS.md` enthält die Cost-Routing-Leitlinie (haiku-Pinning-Präzedenz, Resolution-Order) und den erweiterten Alias-Kommentar an Zeile :42.
- **Positiv-Tests:** `fable`, `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-8` → PASS.
- **Negativ-Tests (Pflicht):** `gpt-4`, `fable-5`, `claude-fable`, `claude-5-fable` → FAIL mit Enum-Error.
- Die Fälle sind in `tests/lib/agent-frontmatter.test.mjs` (Unit, SSOT-Funktionen) und `tests/scripts/validate/check-agents.test.mjs` (CLI-Integration via spawnSync) abgedeckt. **Delivery-Korrektur (Q2-Review, main-2026-07-07-deep-1):** Der Issue-Body #768 nannte zusätzlich `tests/unit/check-agents.test.mjs` — diese Datei ist per eigenem Header ausschließlich auf Check-9-Color-Collision (#443) scoped und trägt bewusst KEINE Model-Fälle; die funktionale Coverage ist mit den zwei tatsächlich erweiterten Dateien vollständig (inkl. SSOT-Drift-Guard mit Fake-Regression-Beleg).

## 3.A EARS-Anforderungen

> **Rekonstruiert — Original-EARS nicht überliefert.** Die Issue-Bodies #767 und #768 verweisen auf "EARS §3.A", enthalten aber keine im EARS-Format (WHEN/WHERE/IF … THE SYSTEM SHALL) vorformulierten Sätze. Die folgenden Anforderungen sind aus den in §2/§3 zitierten Fakten abgeleitet, nicht wortwörtlich aus einem verlorenen Original übernommen. Nur FA3 und FA4 werden von den Issues mit einem EARS-Verweis versehen; FA1 und FA2 haben keinen EARS-Verweis in ihren Issue-Bodies und werden hier folgerichtig ausgelassen.

### FA3 — `loop-readiness-banner.mjs`

- **WHEN** `CLAUDE_CODE_DISABLE_CRON` in der Environment gesetzt ist, **SHALL** `loop-readiness-banner.mjs` ein warn-Banner zurückgeben, das den Cron-Scheduler und `/loop` als deaktiviert benennt und den env-var-Namen im Bannertext nennt.
- **WHERE** eine `loop.md`-Datei (repo-level `.claude/loop.md` ODER user-level `~/.claude/loop.md`) 25.000 Bytes überschreitet, **SHALL** das Modul ein warn-Banner mit Dateipfad und tatsächlicher Byte-Größe zurückgeben.
- **WHEN** mehrere Findings (DISABLE_CRON + eine oder beide übergroße Dateien) gleichzeitig zutreffen, **SHALL** das Modul genau EIN kombiniertes warn-Banner zurückgeben, niemals mehrere separate Banner.
- **IF** kein Finding zutrifft, **THEN SHALL** die Funktion `null` zurückgeben (Contract: null-or-single-banner).
- Die Funktion **SHALL** niemals werfen (never throw), unabhängig vom Input — inklusive fehlender/unlesbarer Dateien.
- Die Funktionssignatur **SHALL** backward-kompatibel bleiben: `{repoRoot, homeDir?, env?}`, mit `env` default `process.env` und Injizierbarkeit für Tests.

### FA4 — `agent-frontmatter.mjs` / `check-agents.mjs`

- **WHEN** ein Agent-Frontmatter-`model`-Feld einen Wert aus der closed-list `opus|sonnet|haiku|fable` gefolgt von einem gültigen Versionsmuster (`\d+(-\d+)?(-\d{8})?`) enthält, **SHALL** `agent-frontmatter.mjs` diesen Wert als PASS validieren.
- **WHERE** das `model`-Feld eine bekannte Alias-Kurzform (u.a. `fable`) referenziert, **SHALL** der Validator dies über `ALLOWED_MODEL_ALIASES` akzeptieren.
- **IF** das `model`-Feld eine Familie außerhalb der closed-list referenziert oder ein ungültiges Muster aufweist (z. B. `gpt-4`, `fable-5`, `claude-fable`, `claude-5-fable`), **THEN SHALL** der Validator dies als FAIL mit einem Enum-Error zurückweisen.
- **WHERE** `check-agents.mjs` Model-Werte prüft, **SHALL** es `ALLOWED_MODEL_ALIASES` und `MODEL_ID_RE` aus der SSOT (`agent-frontmatter.mjs`) importieren und **SHALL NICHT** eine eigene Kopie redeklarieren — nach dem Fix existiert genau eine Deklaration dieser Konstanten im Repo.
- **WHEN** die Modell-Resolution mehrere Quellen betrifft, **SHALL** die Precedence-Order `CLAUDE_CODE_SUBAGENT_MODEL` → Invocation-Parameter → Frontmatter gelten, dokumentiert in `agents/AGENTS.md`.

## 4. Posture-Entscheidungen (Operator, 2026-07-06/07)

1. **Routines = "teach it, don't run it".** ADR-0003 bleibt SUPERSEDED; #485 bleibt won't-do. Das Repo dokumentiert Routines-Mechanik (FA1), betreibt aber keine eigenen Routines.
2. **Kurs-Material für andere Repos ist out-of-scope.** Dieser Sync bleibt repo-intern; keine Vorlagen/Templates für Konsumenten-Repos werden in diesem Epic erzeugt.
3. **Agent-Teams-Implementierung bleibt bei #484.** FA1 fügt nur einen Querverweis ein (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, experimental/off-by-default → `parallel-sessions.md` § PSA Scope Axes + ADR-0002/#484), keine Implementierungsarbeit hier.

## 5. Delivery-Status (Stand: Rekonstruktionszeitpunkt, 2026-07-07, Session main-2026-07-07-deep-1)

| FA | Issue | Priorität/Typ | Status zum Rekonstruktionszeitpunkt |
|---|---|---|---|
| FA1 — `loop-and-monitor.md` Delta-Sync | #765 | high / enhancement | In Bearbeitung in dieser Session (Wave 3) |
| FA2 — `monitor-patterns.md` 8→10 + Pattern-3 | #766 | medium / bug | In Bearbeitung in dieser Session (Wave 3) |
| FA3 — `loop-readiness-banner` Detections | #767 | medium / enhancement | In Bearbeitung in dieser Session (Wave 3) |
| FA4 — Model-Routing Frontmatter-Fix | #768 | high / bug | In Bearbeitung in dieser Session (Wave 3) |
| Epic | #764 | high / enhancement | Offen — schließt erst nach FA1–FA4 |

Live-Status-Quelle für alle fünf Issues: `glab issue view <764|765|766|767|768>`. Diese Tabelle ist ein Snapshot zum Rekonstruktionszeitpunkt der PRD, keine laufend aktualisierte Statusquelle.
