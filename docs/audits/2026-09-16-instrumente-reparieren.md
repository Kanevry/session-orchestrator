# Audit 2026-09-16 — Instrumente des Orchestrators reparieren (ultradeep, Synthesis-Gate)

Session `main-2026-09-16-session-6` (deep / Profil ultradeep, 7 Wellen). Alle Zahlen gemessen 2026-09-16 @ `ca214376` durch fünf read-only Wave-1-Agenten (Opus) und vom Koordinator stichprobenhaft nachgemessen. Dieses Dokument ist das Pflicht-Artefakt des Synthesis-Gates (PRD `docs/prd/2026-09-06-ultradeep-session-profile.md` § 6) und friert die Scopes für W3/W4 ein.

## 1. Prämissen-Korrekturen aus W1

| Issue | Prämisse laut Issue | Gemessen | Folge |
|---|---|---|---|
| #1371 | Sweep auf `f1da471f` gelandet, Zensus 0 | `git log --all` kennt den Commit nicht; 49 Idiom-Treffer auf `main`, `scripts/lib/is-main-module.mjs` fehlt | Sweep muss NEU gemacht werden (54 sweepbare Dateien, 9 bereits sicher, 6 kein Guard) | <!-- path-check: example -->
| #1293 | Root-Filter kollidiert auf Basename | Fix bereits auf `main` (`d4c51bd8`, Test `check-unwired-features.test.mjs:596-625`) | Schließen mit Beleg; Rest: `locks/index.mjs` 0 Importer, `export *`-Barrel-Blindheit = neuer Defekt | <!-- path-check: historical -->
| #1289 B2 | `agent_type_meta` fehlt, weil `meta.agentType` fehlt | 1000/1000 Sidecars tragen `agentType`; Feld fehlt genau dann, wenn der Sidecar nicht gefunden wird (542/542 bei `transcript_found:true`) | Umscopen auf `sidecar_missing`-Messbarkeit |
| #1303 | 4 Befunde offen | Punkt 1, 2, 4 SHIPPED mit Test-Beleg; Punkt 3 = drei Doku-Lücken | W7 Doku-Angleich, dann schließen |
| #1370 | „zwei verschiedene Mechanismen“ (Vermutung) | Bewiesen: (1) `/session`, `/plan` = reservierte Terminal-Built-ins; (2) `Unknown command` = `commands/*.md` ohne gleichnamiges `skills/<n>/SKILL.md` | Fix ist Oberflächen-Design, nicht Frontmatter |

## 2. Befunde je Cluster (Kernzahlen)

### Cluster 1 — Regel-Korpus und Reconcile (#1367 #1372 #1308 #1038)
- `pathScoped` 122.763 / 124.000 B (99,0 %), `totalBytes` 118.798 / 121.000 B, `generated` 75.130 B in 8 Dateien mit 77 Einträgen; Provenance-Blöcke allein 16.999 B (22,6 %).
- Konsolidierungsplan: −21.618 B durch Prosa-Löschung bereits mechanisch erzwungener oder doppelter Einträge, **ohne ein Learning zu verlieren** (Provenance-Paar bleibt, sonst re-proposed `/reconcile`).
- Ablauf: `rule-loader.mjs:381-394` filtert `expires-at` nur beim Lesen; kein Codepfad löscht abgelaufene Dateien (3 historische Fälle lagen 16–19 Tage abgelaufen auf Platte, nur per Hand entfernt in `9b0a555e`). Alle 8 Dateien laufen binnen 57 Tagen ab, 4 binnen 21.
- 10 blockierte Vorschläge = 17.965 B guard-Bytes; absorbiert +6.180 B (einer ist bereits materialisiert → ablehnen).
- Arithmetik: 122.763 − 21.618 = 101.145; mit `testing.md`-Trim (−9.072 B Web-Framework-Prosa in einem Node-CLI-Repo: Server Action, E2E, Accessibility, halbe CI-Integration) und +6.180 → **98.253 B**, Kopfraum 25.747 B.
- #1308: 91-State-Replay über alle Commits auf `.claude/rules/`: echter Peak 99.774 B @ `2ae08fe0` (Docblock sagt 89.763); 124.000 feuert 0/91, **95.000 feuert 1/91 (1,1 %)**, 80.000 5/91.
- #1038: 35 B Rest bestätigt (8.190 B Rumpf, Pin 8.225); Empfehlung ~600 B trimmen und den Pin als `measured + 5 %` neu herleiten statt anzuheben.

### Cluster 2 — Close-Pfad (#1368 #1376 #1303)
- `findRecordedSession` (`session-close-backfill.mjs:584`) vergleicht `started_at` auf die Millisekunde; kein Template schreibt `session-id:` (0 Treffer), der native UUID-Pfad des `/close`-Vorchecks kann nie greifen — die 48-min-Drift war kein Randfall, sondern der einzige Pfad.
- `started_at` in STATE.md ist zu 100 % Prosa-geschrieben (`wave-executor-state-init.md:19` ohne Quelle); Lock-`started_at` ≈ `lock.acquired` ≈ `session.started` (1 ms).
- #1376: genau ein falscher Aufrufer `hooks/on-session-end.mjs:622` (eigene Session endet, eigenes Lock live → übersprungen); Migration/Session-Start-Aufrufer sind korrekt. #863 hatte den Blanket-Skip als Gürtel-und-Hosenträger eingeführt.

### Cluster 3 — Guards (#1366 #1289 #1371 #1293)
- #1366 am echten Hook: `eval '…'`, `dd of=`, `env -S <op> …` → ALLOW auf beiden Redirect-Regeln; `env --split-string=` bereits deny. Lexikalisch lösbar: `dd of=`, `env -S`, `eval` mit Literal; `eval "$CMD"` bleibt Decke (BV-004). 5 positionale Lexer-Konsumenten (Issue sagt 6).
- #1289 B1: xargs-Formen liefern 0 Statements; Fix lokal in `hooks/_lib/vcs-create-matcher.mjs` (kein `WRAPPER_UNWRAP`-Eingriff), Bulk → Loop-Deny.
- #1371: 69 `argv[1]`-Dateien: 9 sicher (Template `invokedAsScript()` in 4 Hooks), 6 kein Guard, 54 sweepbar (V1 13 / V2 25 / V3 12 / V4 4); 10 hook-erreichbar. **Kollision:** `isCliEntrypoint()` in `check-unwired-features.mjs:664-669` erkennt Einstiegspunkte am Idiom; der Sweep muss die Regex im selben Commit um `isMainModule\(` erweitern.
- #1293: gefixt; `worktree/index.mjs` ist via `export *`-Barrel verdrahtet, der Checker sieht `export *`-Kanten nicht (neuer Defekt).

### Cluster 4 — FILE-SCOPE-Kette (#1092)
- 609 `scope_checked`-Records (2026-08-28…09-16), 0 mit Digest; 51 `scope_echo_checked`, 100 % match ohne Nenner; Agent-ID-Schnittmenge 0 → Sende- und Empfangshälfte sind nicht verbindbar. session-8: 23 Echos gegen 18 Injektionen.
- Diese Session: 5/5 W1-Dispatches als `unparseable` gezählt, obwohl kein FILE-SCOPE-Block gesendet wurde → Marker-Regex zu weit (Verdacht: „file scope“ im Learnings-Index-Header).

### Cluster 5 — ECC-Strang (MR !39, #1375, #1370)
- #1375: Pack-Lifecycle end-to-end ausgeführt: `npm pack` 15 s, Tarball 3.963.485 B, Install 3 s (67 Pakete), installierter `pre-bash-destructive-guard.mjs` liefert deny auf `rm -rf /` und leise auf benign; Packlist ohne Lücke; Digest-Beleg über `package-lock.json` `integrity` (sha512), nicht Re-Hash des Baums.
- #1370: Reproduktion mit `claude 2.1.273`, `env -u ANTHROPIC_API_KEY`; Minimal-Plugin-Beweis (`/foocmd` unknown, `/minip:foocmd` ok, `/barskill` ok); Blindvorhersage 3/3 (`/harness-audit`, `/portfolio`, `/templates-ack`).
- MR !39: hook-development-Korrekturen decken sich mit Doku und Repo (10 Events, 18 Matcher, 30 Handler; Timeouts 600/30/60 s); Leakage 0. Zwei Edits: unverifizierter `UserPromptSubmit`-Feldname (`prompt` vs `user_prompt`), fehlender PSA-006-Querverweis in `research-evidence.md`.

## 3. Entscheidungen des Koordinators (ohne Rückfrage)

1. #1368: STATE.md-Init schreibt `started_at` aus `session.lock` (Helper `resolveSessionStartedAt`) **und** `session-id:` (raw UUID, additiv); `commands/close.md` fällt auf `readLock().session_id` zurück; Reader bekommt 6-h-Toleranz mit Negativtest (9 h → abgelehnt).
2. #1376: Parameter `ownSessionIsEnding: true` nur aus `on-session-end.mjs` unter dem #863-Mismatch-Guard; `planSessions` schließt die laufende Session (Live-Lock + prozesslokale ID) aus.
3. #1366: `dd of=` inkl. `conv=notrunc`/`oflag=append` als `mode: append`; `eval` teilt das bestehende Payload-Budget (kein Sub-Budget); unlösbare Formen als benannte Decke in `rationale`.
4. #1289 B1: xargs-Bulk → derselbe Loop-Deny-Pfad (mode-respektierend); B2 umscopen auf `sidecar_missing`-Flag + Nenner-Reporting.
5. #1371: Klasse A (9 sichere Dateien) unangetastet; `ecosystem-wizard.mjs`/`fetch-baseline.mjs` (`endsWith`-Guards) als Follow-up-Issue; Sweep-Agent besitzt zusätzlich `check-unwired-features.mjs` (Regex-Erweiterung) — #1293 ist dort bereits gelandet, kein zweiter Schreiber.
6. #1293: mit Beleg schließen; `scripts/lib/locks/index.mjs` löschen, wenn kein Test es importiert (W4 P2 prüft); `export *`-Barrel-Blindheit als neues Issue. <!-- path-check: historical -->
7. #1092: Hook importiert `scopeDigest` aus `scope-echo.mjs` (eine Normalisierung; Koordinator regeneriert `hook-import-set.json` einmal nach W3); Discovery-Wellen schreiben weiterhin keine leeren Scope-Dateien; Marker-Regex wird auf den exakten Marker `FILE-SCOPE — exactly these:` verschärft.
8. #1375: eigener Script `test:pack` + CI-Job (Netz nur in CI), nicht in `npm test`.
9. MR !39: nach Panel-Verdikt (W5) mergen; die zwei Edits landen danach auf `main` (W7 docs-writer).

## 4. Operator-Entscheidungen (die eine AUQ dieses Gates)

1. `testing.md` um 9.072 B trimmen (sonst Ziel ≤ 100.000 B nur durch Streichen von vier echten Learnings).
2. Ablauf-Policy für generierte Regeln: lauter Test jetzt + Sweeper als Follow-up, Sweeper jetzt, oder `expires-at` beim Konsolidieren verlängern.
3. #1370: 6 Skill-Spiegel (Produktoberfläche, Adapter folgen per Generator) ± Alias-Skills für `/session`/`/plan`.
4. #1092 AC-2: E2E-Test rot (Hook bleibt ALLOW) oder Hook-DENY bei fehlendem Block (41 % der gemessenen Dispatches).

## 5. Finale Scopes W3 (Impl-Core, 5 Agenten, isolation none, strict)

| Agent | Issues | Files (disjunkt) |
|---|---|---|
| I1 | #1367 #1372 #1308 #1038 | `.claude/rules/{git-and-worktrees,identity-and-locks,guard-design,measurement-discipline,process-contracts,test-hygiene,review-and-adapter-contracts,toolchain-and-build,testing,receiving-review}.md`, `scripts/lib/instruction-budget-guard.mjs`, `tests/scripts/instruction-budget-guard.test.mjs`, `tests/rules/**` (neu: `generated-corpus-expiry.test.mjs`), Zitat-Sweep von `git-and-worktrees` (17 Stellen, außerhalb anderer Agenten-Scopes) | <!-- path-check: example -->
| I2 | #1368 #1376 | `skills/wave-executor/references/wave-executor-state-init.md`, `skills/wave-executor/SKILL.md`, `skills/_shared/state-ownership.md`, `commands/close.md`, `scripts/lib/session-close-backfill.mjs`, `scripts/backfill-abandoned-sessions.mjs`, `hooks/on-session-end.mjs`, `scripts/lib/state-md.mjs` (Helper), `tests/lib/session-close-backfill*.test.mjs`, `tests/hooks/on-session-end*.test.mjs`, `tests/scripts/backfill-abandoned-sessions*.test.mjs`, `tests/lib/state-md*.test.mjs` |
| I3 | #1366 #1289 | `scripts/lib/command-blocker.mjs`, `hooks/_lib/vcs-create-matcher.mjs`, `hooks/pre-bash-issue-budget.mjs`, `hooks/on-stop.mjs`, `.orchestrator/policy/blocked-commands.json`, `tests/lib/command-blocker*.test.mjs`, `tests/hooks/{vcs-create-matcher,blocked-commands-policy,pre-bash-issue-budget,on-stop}*.test.mjs` |
| I4 | #1371 (+#1293-Regex) | neu `scripts/lib/is-main-module.mjs`, neu `scripts/lib/validate/check-entry-guard.mjs`, `scripts/validate-plugin.mjs`, `scripts/lib/validate/check-unwired-features.mjs` (nur `isCliEntrypoint`), die 54 sweepbaren Dateien MINUS `scripts/lib/scope-echo.mjs` (I5) MINUS `hooks/on-stop.mjs`?? (nicht in der Liste), MINUS `scripts/backfill-abandoned-sessions.mjs` (I2 — I2 tauscht den Guard dort selbst), `tests/lib/is-main-module.test.mjs`, `tests/lib/validate/check-entry-guard.test.mjs` | <!-- path-check: example -->
| I5 | #1092 | `scripts/lib/scope-echo.mjs` (inkl. eigenem Guard-Tausch), `hooks/pre-task-scope-disjoint.mjs`, `scripts/materialize-wave-scope.mjs`, `skills/wave-executor/references/{wave-loop-dispatch,wave-loop-review}.md`, `scripts/lib/events-schema.mjs`, `docs/events-schema.md`, `docs/scope-collision-guard.md`, `tests/lib/scope-echo.test.mjs`, `tests/hooks/pre-task-scope-disjoint*.test.mjs`, neu `tests/hooks/pre-task-scope-injection-e2e.test.mjs`, `tests/skills/wave-loop-scope-marker.test.mjs` | <!-- path-check: example -->

Koordinator nach W3: `node scripts/generate-hook-import-set.mjs` einmal (I2/I3/I4/I5 berühren hook-erreichbare Module), Gate: typecheck + lint + betroffene Testdateien.

## 6. Finale Scopes W4 (Impl-Polish)

- Koordinator (seriell vor Dispatch): `/reconcile`-Write-Run der 9 verbleibenden Vorschläge (einer abgelehnt) nach AUQ-Freigabe.
- P1 Fix-Pass W3-Befunde (Scope am Checkpoint).
- P2 #1293-Rest: `locks/index.mjs`-Löschung nach Test-Grep; Issue-Kommentar mit Beleg. Plus die 4 Klasse-A-Hooks? — nein, unangetastet (Entscheidung 5). <!-- path-check: historical -->
- P3 #1375: `tests/scripts/pack-install-lifecycle.test.mjs`, `package.json` (`test:pack`), `.gitlab-ci.yml` (Job). <!-- path-check: example -->
- P4 #1370 nach Operator-Entscheidung 3: `skills/{close,go,harness-audit,portfolio,release,test}/SKILL.md`, `commands/*.md`-Delegation, `tests/commands/headless-bare-command-availability.test.mjs`, Generatoren-Nachlauf (`generate-agents-skills.mjs`, `generate-codex-skills.mjs`), README/`docs/install.md` (#1369 nur falls derselbe Befund). <!-- path-check: example -->

## 7. Risiken

- I1 berührt hand-geschriebene Always-on-Dateien nur mit ≤ 80 B Zuwachs (Always-on-Kopfraum 2.202 B).
- `tests/rules/receiving-review.test.mjs` wird in Zwischenständen rot (misst das Live-Repo, gewollt) — nicht lockern.
- Der Sweep (I4) ändert ~54 Dateien mechanisch; Rollback = ein Commit. `session-shape.mjs` und `peer-discovery.mjs` liegen darin, kein anderer W3-Agent fasst sie an.
- Issue-Budget 12: geplante Neu-Issues 4 (Barrel-Blindheit, Ablauf-Sweeper, `endsWith`-Guards, evtl. `session_type unknown`-STATE.md-Fallback).

## 8. Ergebnis (W3–W7)

Gemessen 2026-09-16 nach W6. Zahlenquelle: Wave History in `.claude/STATE.md`, Gate-Läufe des Koordinators.

**Cluster 1 — Regel-Korpus (#1367 #1372 #1308 #1038).** `pathScoped` 122.763 → 109.932 B, `generated` 75.130 → 69.941 B über 7 konsolidierte Dateien; 92/92 Provenance-Paare erhalten, 9 Reconcile-Vorschläge absorbiert, 1 als bereits materialisiert abgelehnt. `testing.md` −7.717 B, `receiving-review.md` −562 B mit neu hergeleitetem Pin 8.009. `git-and-worktrees.md` gelöscht (4 Globs nach `toolchain-and-build.md`, 21/21 ls-verifiziert). <!-- path-check: historical --> Deckel `DEFAULT_GENERATED_BYTE_CEILING` 124.000 → 95.000 mit 91-State-Replay (echter Peak 99.774 B @ `2ae08fe0`, feuert 1/91). Widerlegt: der Konsolidierungsplan sagte −21.618 B auf der `generated`-Achse voraus; ausgeführt wurden −13.093 B — jede aufgezählte Kürzung landete, die Vorhersage überschätzte die Eintragsgrößen. Instrument-Hälfte: Signal 7 `generated-rules-expiring` im maintenance-due-Banner (Horizont 7 Tage) statt einer Kalender-Zeitbombe im blockierenden Gate.

**Cluster 2 — Close-Pfad (#1368 #1376).** `resolveSessionStartedAt`/`resolveSessionIds` in `state-md.mjs`, additives `session-id:` im STATE.md-Template, `close.md`-Fallback auf `readLock().session_id`, `STARTED_AT_DRIFT_TOLERANCE_MS` 6 h mit Negativtest (9 h → abgelehnt). `ownSessionIsEnding` nur aus `on-session-end.mjs` unter dem #863-Guard; `planSessions` schließt den eigenen Prozess aus. 341/341 auf dem normalen Pfad, Fake-Regression 2 rot.

**Cluster 3 — Guards (#1366 #1289 #1371 #1293).** 6 vorher offene Formen (`eval`-Literal, `dd of=` inkl. `conv=notrunc`/`oflag=append`, `env -S <op>`) denyen jetzt auf BEIDEN Redirect-Regeln, benign bleibt ALLOW; `eval "$CMD"` bleibt benannte Decke. `findLoopedIssueCreate` + xargs-Bulk-Deny am verursachenden Statement; `sidecar_missing` als Nenner auf `orchestrator.agent.stopped`. #1371-Sweep: `is-main-module.mjs` neu, 51 Dateien gesweept, blockierender `check-entry-guard.mjs` registriert (0 fragil von 508), 15 statt 17 Textvarianten, 39 statt 36 Validatoren. #1293-Rest: `locks/index.mjs` gelöscht (0 Importer) <!-- path-check: historical -->, `export *`-Barrel-Kanten im Checker sichtbar, Zensus unerreichbarer Module 2 → 0.

**Cluster 4 — FILE-SCOPE-Kette (#1092).** Marker case-sensitiv (Ursache der 5 `unparseable`: „file scope" im Learnings-Index-Header). `scope_checked` trägt `scope_digest`/`marker_found`/`echo_instruction_present`/`instructed_digest`/`digest_consistent`; `scope-echo.mjs --verify` joint über den Digest (6 Verdikte + `echo-only`, `malformed_lines` als Boden); neue Events `scope_materialized` und `scope_verified`. Live-Beweis aus dem echten Hook: `scope_digest=782af20e`; Welle 4 5/5 `matched`. Schreibweise `injection_missing` → `injection-missing` vereinheitlicht, ohne Dual-Emit — Historie trägt beide.

**Cluster 5 — ECC-Strang (MR !39, #1375, #1370).** MR !39 gemergt als `1c02346a`; die zwei Panel-Edits (Provenance des `UserPromptSubmit`-Feldnamens, PSA-006-Querverweis) sind in W7 nachgezogen. #1375: `test:pack` + CI-Job `pack-lifecycle`, hart in `pipeline-gate` verdrahtet. #1370: 6 Skill-Spiegel, `/session` und `/plan` bleiben reservierte Built-ins und bekommen die namespaced Form dokumentiert.

**Widerlegte Prämissen (drei, alle in W1 gemessen).** #1289 B2: die Phantom-Klasse existiert nicht — 1000/1000 Sidecars tragen `agentType`, das Feld fehlt genau dann, wenn der Sidecar nicht gefunden wird (542/542 bei `transcript_found`); Issue auf `sidecar_missing`-Messbarkeit umgescopet. #1293: bereits auf `main` gefixt (`d4c51bd8`) — offen war nur der Rest. #1371: der im Issue als gelandet geführte Sweep (`f1da471f`) ist `git log --all` unbekannt; er musste neu gemacht werden.

**Full Gate (W6, lokal).** 684 Testdateien / 17.486 Tests, 76 s, typecheck + lint grün. Der Zwischenstand davor war 5 Dateien / 11 Tests rot — sämtlich Folgekosten eigener Umbauten, kein Fremdbefund.

**Review-Panels (W5).** Security 0 HIGH / 1 MED / 2 LOW · Architect 1 / 6 / 2 · QA 2 HIGH / 4 MED. Daraus zwei verdiente Schreiber in W6 (Exemption-Bypass im Issue-Budget, Docblock-Korrekturen); der Rest wurde als `follow-up` klassifiziert, nicht im Zyklus gepatcht.

**Follow-ups.** #1377, #1378, #1379.
