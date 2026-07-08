# Feature: docs/ Public-Split & Staleness-Sanierung

**Date:** 2026-07-08
**Author:** Bernhard + Claude (AI-assisted planning)
**Status:** Approved (Reviewer-Iteration 2/3 + Operator-Freigabe 2026-07-08) — Epic #774, Slices #775–#782
**Appetite:** 2w
**Parent Project:** session-orchestrator (standalone Epic)

## 1. Problem & Motivation

### What
`docs/` (Snapshot Grill-Audit 2026-07-08: ~103 Dateien, ~1,7 MB, 19 Subdirs) wird in zwei klar getrennte Klassen saniert: **lebende Referenz** (bleibt public, wird korrigiert und indiziert) und **Prozess-Records** (~68 Move-Kandidaten VOR der Aktiv/Closed-Triage: PRDs, Research, Spike-Probes, Test-Runs, Submissions, Audits, Baseline-Diffs, Experiments, Plans, Migrations — wandern in den privaten Meta-Vault; effektiver Move ist kleiner, da PRDs offener Epics bleiben). Dazu kommen zwei mechanische Rot-Schutz-Guards und eine dauerhafte Epic-Close-Archivierungsroutine, damit der Zustand nicht wieder entsteht.

### Why
Der Grill-Audit vom 2026-07-08 (`docs/specs/2026-07-08-docs-public-split-grill.md`, gitignored/lokal) hat verifiziert: 5 der 17 lebenden Root-Docs tragen **aktive Falschinformationen** (falsche Metrics-Pfade in USER-GUIDE, 3 falsche Zähl-Claims in components.md, 4 fehlende Config-Blöcke in session-config-reference.md, ein nicht existierender Schema-Contract in plugin-architecture-v3.md, validation-checklist.md komplett auf v2.0 eingefroren). Gleichzeitig liegen ~68 interne Prozess-Records undifferenziert public neben der Referenz — ohne Index kann weder ein Mensch noch dessen Agent lebend von historisch unterscheiden. Jeder weitere public Record vergrößert zudem die Leak-Oberfläche (Präzedenz: openclaw-Infra-Leak 2026-06-10; #728, #732).

### Who
1. **Public-Repo-Besucher** (GitHub Kanevry/session-orchestrator): sehen ein kuratiertes, korrektes docs/. 2. **Agenten von Nutzern** (Claude Code / Codex / Cursor, die docs/ als Kontext laden): bekommen einen Router und keine widersprüchlichen Snapshots. 3. **Maintainer/Operator**: behalten die Records privat browsebar im Meta-Vault, mit dauerhafter Routine statt manueller Disziplin.

## 2. Solution & Scope

### In-Scope
- [ ] **S1 — Living-Doc-Reparaturen:** USER-GUIDE.md (3× Metrics-Pfad), components.md (3 Zähl-Claims + `/reconcile` ergänzen), session-config-reference.md (+`slopcheck`, `templates-first`, `verification-auto-fix`, `state-md-lock`), plugin-architecture-v3.md (Schema-Contract), migration-v3.md (2 Korrekturen), examples/-Refresh (Stand April).
- [ ] **S2 — Sensitivitäts-Scan** über die 68 Move-Kandidaten (check-owner-leakage-basiert + manuelle Stichprobe); Ergebnis entscheidet, ob ein separater History-Rewrite-Entscheid nötig wird.
- [ ] **S3 — Record-Move → Meta-Vault:** ~68 Dateien nach `<vault>/01-projects/session-orchestrator/<typ>/` (bestehende Typ-Ordner-Konvention), skriptgeneriertes Minimal-Frontmatter (`type: reference`, `status: archived`), `git rm` aus dem Plugin-HEAD; `validation-checklist.md` wird dabei retired. **Aktive PRDs bleiben** in `docs/prd/` (Triage: Epic offen = aktiv).
- [ ] **S4 — Referenz-Fixes:** 3 load-bearing Stellen (instruction-budget-guard Pfad+Test, write-executable-plan Existenz-Test, owner-leakage-Allowlist-Cleanup) + ~15 JSDoc/Rule-Zitate auf die Konvention „Titel + Issue-# + Vault-Hinweis".
- [ ] **S5 — docs/README.md-Router** (lebend vs. historisch vs. „archiviert im Vault") + README-Politur (Router-Link, Docs-Sektion).
- [ ] **S6 — drift-check „Check 10: docs-parity":** Zähl-Claims components.md vs. ls-Realität, Config-Block-Parität reference vs. template, Metrics-Pfad-Liveness; inkl. Config-Key `check-docs-parity` in Template UND CLAUDE.md (Check-6-Gotcha).
- [ ] **S7 — /discovery docs-staleness-Probe:** mtime-Tiers analog `vault-narrative-staleness.mjs`, config-getriebene Thresholds, JSONL-Sidecar.
- [ ] **S8 — Epic-Close-Archiv-Routine:** `scripts/archive-closed-prds.mjs` + Custom-Phase-Eintrag (#637, `when: both`) — verschiebt PRDs geschlossener Epics in den Vault, shell-safe-Contract.

### Out-of-Scope
- **ADRs bleiben public** — Entscheidungs-Ergebnisse, Industriestandard, 33 externe Referenzen (Grill-Beschluss D1).
- **History-Rewrite/BFG** — Löschen ist kein Un-Publishing; nur falls S2 echte Funde liefert, wird das ein separater Entscheid außerhalb dieses Epics.
- **#761 (pm-skills companion), #763 (gitlab-ops 403-Doku), #734 (pseudonym-map ADR)** — inhaltlich neue Doku, nicht Sanierung; nur `relates_to`-Links vom Epic.
- **Die 3 untracked PRDs der Handover-Gate-Arbeit (#769–773)** — gehören einer anderen Session, werden nicht angefasst (PSA-001).
- **`docs/specs/`- und `docs/_private/`-Regime** — bereits gitignored/lokal, kein Handlungsbedarf.
- **Neue Feature-Doku jenseits der Fix-Liste** — kein Gold-Plating an Docs, die der Sweep als `current` eingestuft hat.

## 3. Acceptance Criteria

### S1 — Living-Doc-Reparaturen
```gherkin
Given der Staleness-Sweep-Befund vom 2026-07-08
When die 5 Drift-Docs + examples/ korrigiert sind
Then enthält kein lebendes Doc mehr den Pfad ".claude/metrics/"
  And components.md nennt 42 Skills, 22 Commands, 9 Kategorien/36 Checks (grep-verifiziert gegen ls)
  And session-config-reference.md dokumentiert slopcheck, templates-first, verification-auto-fix, state-md-lock
  And plugin-architecture-v3.md beschreibt validateSessionConfig + REQUIRED_STRING_FIELDS korrekt
```

### S2 — Sensitivitäts-Scan (Gate vor S3)
```gherkin
Given die enumerierte Move-Kandidatenliste (~68 Dateien, Stand Triage)
When check-owner-leakage + manuelle Stichprobe über ALLE Kandidaten der Move-Liste gelaufen sind
Then liegt ein Scan-Protokoll mit 0 offenen Funden vor (oder Funde sind als separater History-Rewrite-Entscheid eskaliert)
  And S3 startet erst nach diesem Gate
```

### S3 — Record-Move → Meta-Vault
```gherkin
Given das Scan-Gate aus S2 ist grün
When die Records mit generiertem Frontmatter in die Typ-Ordner des Vault-Projektordners verschoben und aus dem Plugin-HEAD entfernt sind
Then enthält docs/ nur noch: lebende Root-Docs, adr/, examples/, recipes/, templates/, telemetry/telemetry-claims.md, aktive PRDs in prd/
  And vault-sync (mode: strict) läuft grün über den Vault
  And PRDs offener Epics liegen weiterhin in docs/prd/
  And validation-checklist.md existiert nicht mehr im Plugin-HEAD
```

### S4 — Referenz-Fixes
```gherkin
Given der Move aus S3 ist vollzogen
When alle Referenzen umgestellt sind
Then läuft npm test grün (inkl. instruction-budget-guard- und write-executable-plan-Tests)
  And grep -rnE "docs/(spike-probes|spikes|test-runs|submissions|marketplace|baseline-diffs|audit|experiments|plans|research|migrations)/" über CLAUDE.md, .claude/, skills/, agents/, scripts/, hooks/, tests/ liefert 0 Treffer auf entfernte Pfade (ERE-Flag -E ist Teil des Kriteriums — BRE wäre vacuous-green)
  And eine Fake-Regression (temporär wieder eingefügter toter Pfad) macht den grep nachweislich rot, danach Revert
  And JSDoc-Zitate folgen der Konvention "Titel + Issue-# + Vault-Hinweis"
```

### S5 — Router + README
```gherkin
Given der Ziel-Zustand von docs/ aus S3
When docs/README.md existiert und README.md aktualisiert ist
Then erklärt docs/README.md die Klassen (lebende Referenz / public ADR-Historie / Vault-Archiv) mit Verzeichnis-Tabelle
  And alle README.md-Links auf docs/ lösen auf existierende Dateien auf
```

### S6 — Check 10 docs-parity
```gherkin
Given ein absichtlich falscher Zähl-Claim in docs/components.md (Fake-Regression)
When claude-md-drift-check läuft
Then meldet Check docs-parity einen Error mit file/line/extracted und der Check erscheint in checks_run
  And nach Revert ist der Lauf grün
  And check-docs-parity ist in docs/session-config-template.md UND CLAUDE.md eingetragen (Check 6 bleibt grün)
```

### S7 — docs-staleness-Probe
```gherkin
Given ein lebendes Doc mit mtime älter als der Tier-Threshold
When /discovery mit aktivierter docs-staleness-Probe läuft
Then erscheint ein Finding mit severity nach Eskalationsstufen (1×/2×/3× Threshold)
  And die Probe schreibt einen JSONL-Summary-Record und wirft nie (fail-soft)
```

### S8 — Epic-Close-Archiv-Routine
```gherkin
Given ein PRD in docs/prd/, dessen Epic geschlossen ist
When die Custom-Phase archive-closed-prds bei session-end oder housekeeping läuft
Then wird das PRD mit Frontmatter in den Vault verschoben und aus docs/prd/ entfernt (Dry-Run-Modus vorhanden)
  And PRDs offener Epics bleiben unberührt
  And der Custom-Phase-Eintrag besteht die Shell-Metacharacter-Validierung aus custom-phases.mjs
```

## 3.A Acceptance Criteria (EARS)

_Leer — die Gherkin-Szenarien in §3 sind für dieses Hygiene-Epic ausreichend deterministisch; kein /write-executable-plan-Stub-Bedarf._

## 4. Technical Notes

### Affected Files
- `docs/USER-GUIDE.md`, `docs/components.md`, `docs/session-config-reference.md`, `docs/plugin-architecture-v3.md`, `docs/migration-v3.md`, `docs/examples/*` — S1-Korrekturen
- `docs/{prd,research,spike-probes,spikes,test-runs,submissions,marketplace,baseline-diffs,audit,experiments,plans,migrations}/`, `docs/telemetry/hardware-patterns.md`, `docs/validation-checklist.md` — S3 `git rm` (aktive PRDs ausgenommen; `migrations/` ist historischer Rename-Record → Move)
- `<vault>/01-projects/session-orchestrator/{prd,research,test-runs,spikes,audits,submissions,…}/` — S3 Ziel (Typ-Ordner, `type: reference`-Frontmatter; effektiver Vault host-lokal via owner.yaml — Konvention: `<vault>`)
- `scripts/lib/instruction-budget-guard.mjs:326` + `tests/scripts/instruction-budget-guard.test.mjs:280` — Laufzeit-Pfad `docs/audit/…` folgt dem Move
- `tests/skills/write-executable-plan.test.mjs:175` — Existenz-Assertion auf `docs/plans/…` umstellen
- `scripts/lib/validate/check-owner-leakage.mjs:554-561` — tote Allowlist `docs/marketplace/**`+`docs/submissions/**` entfernen
- `scripts/autopilot.mjs`, `scripts/autopilot-multi.mjs`, `scripts/lib/session-id.mjs`, `scripts/lib/quality-gate.mjs`, `scripts/lib/slopcheck.mjs`, `scripts/lib/session-end/worktree-cleanup.mjs`, `tests/agents/persona-reviewers.test.mjs:5` (JSDoc-Ref auf `docs/migrations/…`) u.a. — JSDoc-Zitier-Konvention (S4)
- `skills/claude-md-drift-check/checker.mjs` (neue IIFE `runDocsParity()` bei ~955, Wiederverwendung `buildSurfaceDescriptors` + `extractSessionConfigBlock`/`extractTopLevelKeys`), `skills/claude-md-drift-check/SKILL.md`, `scripts/lib/config/drift-check.mjs`, `skills/session-end/drift-operations.md`, `docs/session-config-template.md`, `CLAUDE.md` — S6
- `skills/discovery/probes/docs-staleness.mjs` (Clone-Skelett `vault-narrative-staleness.mjs`), `skills/discovery/probes-docs.md` (neu), `skills/discovery/SKILL.md` Phase-3-Dispatch — S7
- `scripts/archive-closed-prds.mjs` (neu) + `CLAUDE.md` `custom-phases:`-Eintrag — S8
- `docs/README.md` (neu), `README.md` — S5

### Architecture
Split per Kriterium „Verwenden/Verstehen = public, Prozess = privat" (Grill D1). Kein physisches Archiv im Repo (Link-Topologie: 48 prd- + 33 adr-Referenzen), sondern Vault als privater Ort — beide Git-Remotes teilen dieselben Commits, pro-Pfad-Mirroring existiert nicht. Guards docken an bestehende Mechanik an (drift-check-IIFE-Muster, runProbe-Contract, Custom-Phases-#637-Contract) — null always-on-Kosten, Instruction-Budget (437/480) unberührt. Frontmatter-Generierung als committetes Skript (idempotent, kollisionsfreie kebab-IDs), damit vault-sync `strict` grün bleibt.

### Data Model Changes
None (Markdown-Moves + Frontmatter; JSONL-Sidecar der Probe folgt bestehendem Schema).

### API Changes
None (Check-10 erweitert das bestehende drift-check-JSON-Contract nur um einen `checks_run`-Eintrag; Exit-Codes unverändert).

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| Records bleiben in public git-History (kein Un-Publishing) | Sensible Inhalte wären weiter auffindbar | S2-Scan als hartes Gate vor S3; echte Funde → separater History-Rewrite-Entscheid |
| vault-sync `strict` schlägt auf 68 generierte Frontmatter an | Session-Close im Vault-Repo blockiert | Generator-Skript mit Schema aus `skills/vault-sync/validator.mjs` testen; Probelauf über 5 Dateien vor Massenlauf |
| Parallel-Session-Kollision: `/plan` schreibt aktiv nach docs/prd/; #769–773-PRDs untracked | Move räumt fremde Arbeit weg | Aktiv/Closed-Triage vor S3; untracked Dateien sind per Definition nicht Move-Gegenstand (nur getrackte); PSA-003 |
| Check-6-Selbst-Flag beim neuen Config-Key | drift-check rot direkt nach S6 | `check-docs-parity` atomar in Template UND CLAUDE.md (ein Commit) |
| Externe Bookmarks auf entfernte docs-Pfade → 404 | Verwirrung bei Alt-Lesern | docs/README.md erklärt das Archiv-Schema; ADRs (meistverlinkte Klasse) bleiben |
| Fake-Regression-Pflicht für neue Guards vergessen | Guard, der nie rot wird (testing.md Negative-Assertion-Regel) | S6/S7-Akzeptanzkriterien verlangen Red-on-Drift-Nachweis explizit |

### Dependencies
- **S2 → S3 → S4/S5** (harte Kette); S1, S6, S7, S8 sind unabhängig parallelisierbar.
- `relates_to`: #761, #763, #734 (Doc-Neuschreibungen, eigenständig); #737 (Instruction-Budget-Watch — Guards sind bewusst nicht always-on); #727 Epic F (VCS-/Mirror-Policy-Kontext).
- Keine externen Blocker; kein Paket-Zukauf (Slopcheck-Phase entfällt: keine neuen Dependencies).
