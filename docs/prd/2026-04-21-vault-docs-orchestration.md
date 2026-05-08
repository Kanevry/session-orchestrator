# Feature: Vault & Docs Orchestration — End-to-End Integration

**Date:** 2026-04-21
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Complete (2026-05-01, Epic #229 closed)
**Appetite:** 6w (end-to-end, 3 Sub-Epics parallel/sequenziell shippable)
**Parent Project:** session-orchestrator (plugin-repo) + cross-repo projects-baseline

## 1. Problem & Motivation

### What

Ein durchgängiges **Dokumentations-Orchestrations-Layer** über session-orchestrator, das bei jeder `/go`-Session automatisch prüft, was im aktuellen Scope an Doku, Vault-Narrative und SSOT-Pflege anfällt — und es via dediziertem `docs-writer` Agent ausführt. Flankiert von (a) automatischem Vault-Provisioning bei Repo-Anlage über `projects-baseline` und (b) Backfill-Migration für die 22 historisch driftenden GitLab-Repos.

Drei trennbare, kombinierbare Sub-Epics:

- **Sub-Epic A — Docs-Orchestrator + docs-writer Agent** (im session-orchestrator Plugin)
- **Sub-Epic B — Vault-Auto-Provisioning in projects-baseline** (Cross-Repo, setup-project.sh + CLAUDE.md Template)
- **Sub-Epic C — Stale-Detection + Backfill-Migration** (discovery-probe + `/plan retro` Erweiterung + Migrations-Skript)

### Why

Harte Evidenz aus Research-Wave vom 2026-04-21:

- **Nur 7 %** (2/30) der zuletzt erstellten GitLab-Repos wurden via `projects-baseline/scripts/setup-project.sh` angelegt. Die restlichen 93 % sind manuelle Ad-hoc-Erstellungen ohne Baseline-Enforcement.
- **Nur 23 %** (7/30) der letzten 30 Repos haben einen Vault-Eintrag unter `01-projects/<slug>/`. 22 Repos driften unbemerkt.
- **`setup-project.sh` vererbt `.vault.yaml` nicht** — Vault-Onboarding ist heute expliziter Nachschritt, wird regelmäßig vergessen.
- **Kein `docs-writer` Agent** im Plugin (`agents/` hat 6 Rollen — code-implementer, test-writer, ui-developer, db-specialist, security-reviewer, session-reviewer — keine Doku-Rolle).
- **Kein Docs-Planning-Step** in session-start/session-plan. Doku wird erst in session-end Phase 3.1 als Catch-All berührt; Scope-Kontext ist dann teilweise schon verloren.
- **Keine Stale-Detection-Automation** — weder `lastCommit` vs. `lastSync` noch Frontmatter-`updated`-Alter werden ausgewertet.
- **4 isolierte Skills** (`vault-sync`, `vault-mirror`, `claude-md-drift-check`, `daily`) ohne gemeinsames Dach — dem User ist unklar, was wann greift.
- Gekoppelter Offline-Impact: #223 (CLAUDE.md narrative sync Epic), #217 (mode-semantik bug), #187 (vault-mirror promote) sind alle Symptome desselben fehlenden Dachs.

### Who

- **Primary — Bernhard (Einzelnutzer-Workflow):** Betreibt 14 aktive Projekte, täglich mehrere `/go`-Sessions, Vault lokal unter `/Users/bernhardgoetzendorfer/Projects/vault`. Braucht „nichts vergessen"-Garantie ohne mentale Last pro Session.
- **Secondary — zukünftige Team-Nutzung:** Plugin ist marketplace-published (kanevry). Team-Member, die das Plugin adoptieren, brauchen denselben Loop ohne Bernhard-spezifisches Setup.
- **Tertiary — Audiences des produzierten Contents:**
  - *User-Docs* (README, `docs/user/`) → externe / interne Nutzer der jeweiligen Repos
  - *Dev-Docs* (`CLAUDE.md`, `docs/dev/`, ADRs) → Kontributoren (inkl. Claude-Sessions)
  - *Vault/Ops-Narrative* (`context.md`, `decisions.md`, `people.md`) → strategische Kontinuität über Sessions hinweg

## 2. Solution & Scope

### In-Scope

**Sub-Epic A — Docs-Orchestrator + docs-writer Agent (session-orchestrator repo)**

- [x] **A1**: Neuer `docs-writer` Agent in `agents/docs-writer.md` (frontmatter: `name`, `description` mit `<example>`, `model: inherit`, `color`, `tools: Read, Edit, Write, Glob, Grep, Bash`)
- [x] **A2**: Neue Skill `skills/docs-orchestrator/SKILL.md` — orchestriert Audience-Split (User / Dev / Vault-Ops), Scope→Doku-Mapping, und dispatched `docs-writer` mit klar umrissenem Prompt
- [x] **A3**: session-start Integration — Phase 2.5 "Docs Planning" nach Alignment, vor session-plan. Fragt: „Welche Audiences berührt dieser Scope?" → schreibt Docs-Tasks in Wave-Plan
- [x] **A4**: session-plan Integration — `docs-writer` erscheint im Agent-Mapping, kriegt eigene Wave oder Inline-Tasks je Komplexität
- [x] **A5**: session-end Integration — Phase 3.2 "Docs Verify" nach SSOT-Update: reviewed, ob Docs-Tasks aus dem Plan tatsächlich umgesetzt wurden
- [x] **A6**: Session Config-Felder: `docs-orchestrator.enabled` (bool, default `false`), `docs-orchestrator.audiences` (list, default `[user, dev, vault]`), `docs-orchestrator.mode` (`warn`/`hard`, default `warn`)
- [x] **A7**: Konsolidierungs-Docs — `docs/vault-docs-architecture.md`: Dach-Narrativ über die 4 Skills + 1 neuer + 1 Agent (vault-sync, vault-mirror, claude-md-drift-check, daily, docs-orchestrator, docs-writer)
- [x] **A8**: CLAUDE.md Update im session-orchestrator Repo — dokumentiert neuen docs-orchestrator Flow + Agent

**Sub-Epic B — Vault-Auto-Provisioning in projects-baseline (Cross-Repo)**

- [x] **B1**: `scripts/setup-project.sh` erweitern um `.vault.yaml`-Generation (Step 4.5, nach Template-Copy) — Hard-Default, Opt-out via `--no-vault` Flag
- [x] **B2**: `templates/shared/.vault.yaml.template` — vorbefüllt mit `{{PROJECT_NAME}}`, `{{PROJECT_TYPE}}`, `tier: active`, `status: idea`
- [x] **B3**: `templates/shared/CLAUDE.md.template` erweitern — Abschnitt „Vault Integration" mit slug + tier + Hinweis auf Clank-Sync
- [x] **B4**: `scripts/setup-project.sh` ruft optional Vault-Folder-Create auf (wenn `$VAULT_DIR` in env gesetzt): legt `$VAULT_DIR/01-projects/<slug>/context.md` mit Stub an
- [x] **B5**: Alle 8 Archetypes (`nextjs-saas`, `express-service`, `docker-service`, `monorepo-oss`, `swift-app`, `swift-menubar-app`, `cli-tool`, `shared`) bekommen `docs/prd/.gitkeep` und `docs/retro/.gitkeep`
- [x] **B6**: `.gitlab/issue_templates/vault-registration.md` wird durch eingebauten Auto-Flow obsolet → archivieren oder als Troubleshooting-Doku re-purposen
- [x] **B7**: ADR-Update: `docs/adr/004-meta-vault-architecture.md` ergänzen um "Auto-Provisioning seit YYYY-MM-DD"
- [x] **B8**: Tests für `setup-project.sh` (bats) — decken neuen Vault-Step ab, inkl. `--no-vault` Opt-out

**Sub-Epic C — Stale-Detection + Backfill-Migration (session-orchestrator + Migrations-Tool)**

- [x] **C1**: `skills/discovery/probes/vault-staleness.mjs` — Probe: scannt `01-projects/*/_overview.md`, vergleicht `lastCommit` (im Repo via `git log`) vs. `lastSync` (aus Frontmatter). Flaggt Repos mit Δ > 24h.
- [x] **C2**: `skills/discovery/probes/vault-narrative-staleness.mjs` — Probe: prüft `context.md`/`decisions.md`/`people.md` auf `updated`-Feld. Threshold per Tier: `top: 30d`, `active: 60d`, `archived: 180d`.
- [x] **C3**: `/plan retro` Mode-Erweiterung: neuer Sub-Mode `vault-backfill` der GitLab-Gruppen scannt und ein Backfill-PRD erzeugt
- [x] **C4**: Neues CLI-Tool `scripts/vault-backfill.mjs` — nimmt GitLab-Gruppen-Liste, findet Repos ohne `.vault.yaml`, generiert interaktiv (oder `--yes` headless) `.vault.yaml` + Vault-Stubs. Live dry-run default.
- [x] **C5**: Integration in `session-end` Phase 2.3 (nach drift-check, neu): stale-check als optionale Phase, gated auf `vault-staleness.enabled: true`
- [x] **C6**: Session Config-Felder: `vault-staleness.enabled`, `vault-staleness.thresholds.top/active/archived` (Tage), `vault-staleness.mode` (`warn`/`hard`)
- [x] **C7**: Closing-Report-Integration: session-end produziert „Docs Health"-Zeile neben Quality-Gates (X/Y Projekte stale, Z needs backfill)

### Out-of-Scope

- **Team-Vault-Sharing (shared vault für Teams)** — Heute Einzelnutzer-lokal unter `/Users/bernhardgoetzendorfer/Projects/vault`. Team-Sharing verlangt eigene Infra (Sync-Mechanismus, Permissions, Conflict-Resolution) und ist ein eigenständiges Epic. Als Follow-up-Issue registriert.
- **Zweiwege-Sync (Vault → Repo)** — Heute One-way (Repo → Vault via `.vault.yaml` + Clank). Umkehr würde Ownership-Modell (`_overview.md` = Clank-owned, `context.md` = manuell) brechen. Nicht auf der Roadmap.
- **LLM-Autogenerierte User-Docs ohne Quelle** — `docs-writer` Agent schreibt nur aus existierenden Quellen (Code, Git-Log, Session-Memory, Wave-Outputs). Keine freie Halluzination. Quellenlose Abschnitte werden mit `<!-- REVIEW: source needed -->` markiert.
- **Vollständige ADR-Autogenerierung** — ADRs entstehen weiterhin manuell durch Human-Decision. `docs-writer` kann bei Bedarf Skeletons vorschlagen, aber nicht autonom committen.
- **Migration der historischen 50-sessions/40-learnings-Einträge** — Bestehender vault-mirror funktioniert, nur vorwärts-kompatibel.

## 3. Acceptance Criteria

### Sub-Epic A — Docs-Orchestrator + docs-writer Agent

```gherkin
Given ein Repo mit Session Config `docs-orchestrator.enabled: true`
When der Nutzer `/session feature` aufruft und Alignment abschließt
Then fragt das Plugin vor dem Wave-Plan: "Welche Audiences berührt dieser Scope?"
And schreibt basierend auf Auswahl User/Dev/Vault-Tasks in den Plan
And diese Tasks werden dem docs-writer Agent zugewiesen
```

```gherkin
Given eine feature-session mit Scope "neues API-Endpoint"
When /go ausgeführt wird und eine Wave den docs-writer Agent dispatched
Then liest der Agent git-diff + session-memory + affected-files
And aktualisiert README.md (User-Audience), CLAUDE.md-Abschnitt "API" (Dev-Audience)
And schreibt Vault-Narrative-Update nach `context.md` (Vault-Audience)
And markiert quellenlose Abschnitte mit `<!-- REVIEW: source needed -->`
```

```gherkin
Given session-end Phase 3.2 "Docs Verify"
When Docs-Tasks aus dem Plan existieren
Then prüft das Plugin, ob jede Task einen Diff produziert hat
And flaggt nicht-umgesetzte Tasks im Session-Summary
And blockiert Close wenn `docs-orchestrator.mode: hard` und Tasks offen
```

```gherkin
Given Session Config ohne docs-orchestrator.enabled
When /session feature läuft
Then läuft alles wie bisher, kein Docs-Planning-Step, kein docs-writer
And zero-overhead (Opt-in design)
```

### Sub-Epic B — Vault-Auto-Provisioning in projects-baseline

```gherkin
Given ein User führt `scripts/setup-project.sh` aus
When Projekt-Typ und Slug gewählt sind
Then erstellt das Script automatisch `.vault.yaml` im Repo-Root
And CLAUDE.md enthält einen "Vault Integration"-Abschnitt mit dem Slug
And wenn $VAULT_DIR gesetzt ist, wird `$VAULT_DIR/01-projects/<slug>/context.md` mit Stub angelegt
```

```gherkin
Given `setup-project.sh --no-vault`
When das Script läuft
Then wird keine `.vault.yaml` generiert
And CLAUDE.md enthält keinen Vault-Abschnitt
And Exit-Code 0
```

```gherkin
Given ein neues Repo, angelegt via setup-project.sh mit Default-Settings
When der nächste Clank-Cron-Run um 06:00/10:00/14:00/18:00 läuft
Then findet Clank die neue `.vault.yaml`
And generiert `_overview.md` im Vault
And das Repo ist ohne manuelle Nacharbeit vollständig Vault-registriert
```

### Sub-Epic C — Stale-Detection + Backfill-Migration

```gherkin
Given ein Vault mit 14 aktiven Projekten
When `/discovery` mit enabled vault-staleness probe läuft
Then wird für jedes Projekt lastCommit vs. lastSync verglichen
And Projekte mit Δ > 24h werden als "sync-stale" geflaggt
And Projekte mit context.md `updated` > Threshold-Tage werden als "narrative-stale" geflaggt
And ein JSON-Report wird in `.orchestrator/metrics/vault-staleness.jsonl` geschrieben
```

```gherkin
Given 22 GitLab-Repos ohne `.vault.yaml`
When `/plan retro vault-backfill` gestartet wird
Then scannt das Plugin alle konfigurierten GitLab-Gruppen
And präsentiert eine Drift-Tabelle (Repo, Erstellungsdatum, Sichtbarkeit)
And für jedes driftende Repo kann der User slug/tier interaktiv bestätigen
And `scripts/vault-backfill.mjs --yes` kann headless ausgeführt werden mit vorbereitetem JSON-Manifest
```

```gherkin
Given session-end mit vault-staleness.mode: hard und 3 stale Projekten
When /close aufgerufen wird
Then wird session-end Phase 2.3 den Close blockieren
And der User bekommt die Liste der stale Projekte + Handlungsempfehlung
And kann mit --override fortfahren (dokumentiert im Session-Log)
```

### Edge Cases / Error Handling

```gherkin
Given docs-writer Agent hat keine Quelle für einen User-Doc-Abschnitt
When der Agent den Abschnitt schreibt
Then wird `<!-- REVIEW: source needed -->` eingefügt
And der Abschnitt erscheint im Session-Summary als "needs review"
And es wird kein erfundener Inhalt produziert
```

```gherkin
Given ein Repo ohne `.vault.yaml` aber mit `vault-integration.enabled: true`
When vault-sync läuft
Then gibt das Skill einen Hinweis "kein .vault.yaml gefunden — run setup-project.sh oder vault-backfill"
And blockiert nicht (graceful degradation)
```

```gherkin
Given clank-vault-sync.sh Cron läuft und findet Konflikt (context.md manuell editiert + neue Version in Repo)
When der Sync ausgeführt wird
Then bleibt die manuelle Version im Vault unberührt (Ownership-Regel)
And nur _overview.md wird überschrieben
And ein Log-Eintrag dokumentiert die Entscheidung
```

## 4. Technical Notes

### Affected Files

**Sub-Epic A (session-orchestrator repo):**

- `agents/docs-writer.md` — NEU: Agent-Definition
- `skills/docs-orchestrator/SKILL.md` — NEU: Orchestration-Skill
- `skills/docs-orchestrator/audience-mapping.md` — NEU: User/Dev/Vault-Audience-Regeln
- `skills/session-start/SKILL.md` — Phase 2.5 "Docs Planning" einhängen
- `skills/session-plan/SKILL.md` — docs-writer in Agent-Mapping aufnehmen
- `skills/session-end/SKILL.md` — Phase 3.2 "Docs Verify" einhängen
- `skills/wave-executor/SKILL.md` — docs-writer dispatch-support
- `docs/session-config-reference.md` — neue Config-Felder dokumentieren
- `docs/vault-docs-architecture.md` — NEU: Dach-Narrativ
- `CLAUDE.md` — Feature-Dokumentation im "v2.0 Features"/neuen "v2.1 Features" Abschnitt

**Sub-Epic B (projects-baseline repo):**

- `scripts/setup-project.sh` — Lz. ~300 nach Template-Copy: `.vault.yaml`-Generation + Vault-Folder-Create
- `templates/shared/.vault.yaml.template` — NEU
- `templates/shared/CLAUDE.md.template` — Vault-Abschnitt
- `templates/*/` (alle 8 Archetypes) — `docs/prd/.gitkeep`, `docs/retro/.gitkeep`
- `docs/adr/004-meta-vault-architecture.md` — Addendum
- `tests/setup-project.bats` — neue Testfälle

**Sub-Epic C (session-orchestrator repo + cross-repo migration tool):**

- `skills/discovery/probes/vault-staleness.mjs` — NEU
- `skills/discovery/probes/vault-narrative-staleness.mjs` — NEU
- `skills/plan/mode-retro.md` — `vault-backfill` Sub-Mode
- `scripts/vault-backfill.mjs` — NEU: CLI-Tool
- `skills/session-end/SKILL.md` — Phase 2.3 staleness-check
- `docs/session-config-reference.md` — neue Config-Felder

### Architecture

**Layering (von oben nach unten):**

```
┌─────────────────────────────────────────────────────────┐
│ User invokes: /session feature, /go, /close             │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ session-start → Phase 2.5 docs-orchestrator (NEU)       │
│  → fragt Audiences → schreibt Tasks in session-plan     │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ wave-executor → dispatched docs-writer Agent (NEU)      │
│  → Agent liest Scope-Sources (diff, memory, affected)   │
│  → Agent schreibt audience-spezifisch (User/Dev/Vault)  │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ session-end                                             │
│  Phase 2.1 vault-sync         (EXISTIERT)              │
│  Phase 2.2 claude-md-drift    (EXISTIERT)              │
│  Phase 2.3 vault-staleness    (NEU — Sub-Epic C)       │
│  Phase 3.2 docs-verify        (NEU — Sub-Epic A)       │
│  Phase 3.7 vault-mirror       (EXISTIERT)              │
└─────────────────────────────────────────────────────────┘

Auf der Repo-Anlage-Seite (einmalig pro Repo):
┌─────────────────────────────────────────────────────────┐
│ projects-baseline/scripts/setup-project.sh              │
│  → Step 4.5 (NEU): .vault.yaml + optional Vault-Stub    │
│  → 4×/Tag Clank-Cron zieht Repos → Vault (EXISTIERT)    │
└─────────────────────────────────────────────────────────┘
```

**Komponenten-Ownership:**

| Komponente | Owner | Status |
|------------|-------|--------|
| `vault-sync` (Frontmatter + Wiki-Link Validation) | session-orchestrator | EXISTIERT |
| `vault-mirror` (JSONL → Vault) | session-orchestrator | EXISTIERT |
| `claude-md-drift-check` (4 Checks) | session-orchestrator | EXISTIERT |
| `daily` (Daily-Note) | session-orchestrator | EXISTIERT |
| **`docs-orchestrator` (NEU — Dach)** | session-orchestrator | Sub-Epic A |
| **`docs-writer` Agent (NEU)** | session-orchestrator | Sub-Epic A |
| **`vault-staleness` Probe (NEU)** | session-orchestrator | Sub-Epic C |
| **`vault-backfill` CLI (NEU)** | session-orchestrator (mirrors baseline) | Sub-Epic C |
| `setup-project.sh` Vault-Step (ERWEITERT) | projects-baseline | Sub-Epic B |
| `clank-vault-sync.sh` (4×/Tag Cron) | projects-baseline | EXISTIERT |

### Data Model Changes

**Session Config — neue Felder (alle opt-in, default disabled):**

```yaml
docs-orchestrator:
  enabled: false                 # Phase 2.5 session-start + Phase 3.2 session-end
  audiences: [user, dev, vault]  # welche Audiences abfragen
  mode: warn                     # warn | hard
  agent: docs-writer             # Agent-Name (erlaubt Override)

vault-staleness:
  enabled: false                 # Phase 2.3 session-end + discovery probe
  mode: warn                     # warn | hard
  thresholds:
    top: 30                      # Tage, ab wann `top`-Tier-Projekte als stale gelten
    active: 60
    archived: 180
```

**Vault-Frontmatter — keine Schema-Änderungen.** Vorhandene Felder (`updated`, `lastSync`, `lastCommit`, `tier`, `expires`) reichen für Stale-Detection.

**`.vault.yaml` Schema (projects-baseline) — unverändert.** Existiert seit ADR-004.

### API Changes

Keine öffentlichen APIs. Alle Änderungen sind intern zu den beiden Repos oder über CLI-Flags exponiert:

- `scripts/setup-project.sh --no-vault` (neuer Opt-out-Flag)
- `scripts/vault-backfill.mjs [--yes] [--gitlab-group=<name>] [--dry-run]` (neues CLI)

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| docs-writer produziert halluzinierten Inhalt ohne Quelle | Falsche Docs, Trust-Erosion | Hart: nur aus explizit übergebenen Sources (diff, memory, files). Fehlende Quelle → `<!-- REVIEW: source needed -->` statt Inhalt. |
| Cross-Repo-Koordination (projects-baseline MR + session-orchestrator MR) | Sync-Problem, eine Seite mergt ohne die andere | Sub-Epic B wird als separater MR gemerged, ist **additiv** (Opt-out via `--no-vault`). Sub-Epic A/C können unabhängig landen. |
| Docs-Overhead pro Session wird zu groß | User schaltet docs-orchestrator wieder ab | `warn`-mode als Default, klare Escape-Hatches. Audiences selektiv abschaltbar. Messung: Session-Dauer-Tracking via `.orchestrator/metrics/sessions.jsonl` (vor/nach). |
| Stale-Detection False-Positives (Repo ohne echte Doku-Not-To-Do) | User deaktiviert Feature | Thresholds pro Tier konfigurierbar. `archived: 180d` großzügig. Manueller Override pro Projekt via `context.md` Frontmatter `staleness-opt-out: true`. |
| Backfill-Skript überschreibt manuelle Dateien | Datenverlust | Dry-run default. Vor jedem Write: Existenz-Check, nie überschreiben. Ownership-Regel aus ADR-004 einhalten. |
| Bestehende 14 Vault-Projekte inkompatibel mit neuem Flow | Migration-Arbeit | Keine — bestehendes Schema bleibt. Nur additive Felder. Opt-in per Session Config. |
| `docs-writer` Agent-Quality uneinheitlich über Audiences | User-Docs okay, Vault-Narrative schwach | Audience-spezifische Prompts in `audience-mapping.md`. Evolve-Skill lernt aus Session-Feedback. |
| Marketplace-Kompatibilität (kanevry) | Feature-Block | Alle neuen Config-Felder opt-in mit sicherem Default → zero-impact für bestehende Plugin-User. |

### Dependencies

**Blocking (müssen vor oder parallel gelöst werden):**

- **#217** (ready) — `vault-sync.mode` + `drift-check.mode` Semantik-Bug `hard`/`strict` — sollte vor oder mit Sub-Epic C gefixt werden, sonst erbt `vault-staleness.mode` denselben Bug.
- **#223** (ready, Epic) — Discovery: CLAUDE.md narrative sync — überlappt mit Sub-Epic A "Docs Verify"-Phase. Ggf. unter diesen neuen Epic subsumieren.

**Non-blocking, related:**

- **#187** (in-progress) — vault-mirror als Standard-Flow promoten. Unabhängig shippable, stärkt aber Sub-Epic A's "Dach"-Narrativ.
- **#209, #201, #96** (ready) — CLAUDE.md drift cleanups. Werden durch neues Feature tendenziell obsolet / in Tests überführt.
- **#185** (done) — harness-retro W3 — learnings auto-init + vault prompt. Vorarbeit auf der Learning-Seite.

**Cross-repo:**

- **projects-baseline MR** (Sub-Epic B) — muss vom User manuell gereviewt und gemerged werden. Roll-out nach session-orchestrator Sub-Epic A/C, damit das Plugin den neuen Flow versteht.

**Ecosystem:**

- Clank-Vault-Sync (Repo → Vault, 4×/Tag Cron) bleibt unverändert. Bernhard-only, da Clank heute lokal läuft.

### Follow-up Issues (nach Cycle-Ende zu erstellen)

- Team-Vault-Sharing Epic — wenn das Plugin in Teams adoptiert wird
- `docs-writer` Auto-ADR-Vorschläge — aus Decision-Log in session-memory
- Cross-Repo-Dependency-Visualization im Vault (welche Projekte teilen Packages?)

## Sub-Epic Status (2026-05-01)

All 23 deliverables verified shipped via Wave 1 D2 audit (`.orchestrator/audits/prd-229-audit.md`). PRD checkboxes updated to reflect on-disk state. Epic close-out comment posted on issue #229.

### Sub-Epic A — Docs-Orchestrator + docs-writer Agent (8/8 shipped)
Reference commit: `771b99c` (session-orchestrator)

| Item | Deliverable | Evidence |
|------|-------------|----------|
| A1 | docs-writer agent | `agents/docs-writer.md` |
| A2 | docs-orchestrator skill | `skills/docs-orchestrator/SKILL.md` + `audience-mapping.md` |
| A3 | session-start Phase 2.5 | `skills/session-start/phase-2-5-docs-planning.md` |
| A4 | session-plan integration | `skills/session-plan/SKILL.md` Step 1.5/1.8 |
| A5 | session-end Phase 3.2 Docs Verify | `skills/session-end/SKILL.md` |
| A6 | Session Config fields | `docs/session-config-template.md` (`docs-orchestrator.enabled/audiences/mode`) |
| A7 | Architecture narrative | `docs/vault-docs-architecture.md` |
| A8 | CLAUDE.md flow doc | `CLAUDE.md` (project root) |

### Sub-Epic B — Vault-Auto-Provisioning (projects-baseline) (8/8 shipped)
Reference commit: `356c4f9` (in projects-baseline repo)

| Item | Deliverable | Evidence |
|------|-------------|----------|
| B1 | setup-project.sh --no-vault | `scripts/setup-project.sh` Step 2b |
| B2 | .vault.yaml.template | `templates/shared/.vault.yaml.template` |
| B3 | CLAUDE.md.template Vault section | `templates/shared/CLAUDE.md.template` |
| B4 | $VAULT_DIR auto-stub | `scripts/setup-project.sh` (idempotent) |
| B5 | Archetype gitkeeps | 22 `.gitkeep` files across 8 archetypes |
| B6 | vault-registration template repurposed | `.gitlab/issue_templates/vault-registration.md` (fallback-only) |
| B7 | ADR addendum | `docs/adr/004-meta-vault-architecture.md` |
| B8 | bats tests | `scripts/tests/setup-project.bats` (15 tests) |

### Sub-Epic C — Stale-Detection + Backfill-Migration (7/7 shipped)
Reference commit: `fff35f7` (session-orchestrator)

| Item | Deliverable | Evidence |
|------|-------------|----------|
| C1 | vault-staleness probe | `skills/discovery/probes/vault-staleness.mjs` |
| C2 | vault-narrative-staleness probe | `skills/discovery/probes/vault-narrative-staleness.mjs` |
| C3 | /plan retro vault-backfill | `skills/plan/mode-retro.md` Phase 1.6 |
| C4 | vault-backfill CLI | `scripts/vault-backfill.mjs` (15.4 KB) |
| C5 | session-end staleness gate | `skills/session-end/SKILL.md` Phase 2.3 |
| C6 | Session Config fields | `vault-staleness.enabled/mode/thresholds.{top,active,archived}` |
| C7 | Docs Health closing report | `skills/session-end/SKILL.md` Phase 6 |

### Cross-reference: closed sub-issues

Plugin: #233, #234, #235, #236, #241, #242, #243 (closed against #229).
Baseline: #231, #238, #239, #240 (closed against #229 in projects-baseline).
