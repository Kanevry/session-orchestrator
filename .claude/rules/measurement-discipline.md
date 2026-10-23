---
auto-generated: true
consolidated: true
alwaysApply: false
description: "The measurement was right and the population was wrong: tracked-only greps, hand-typed census lists, proxies that do not correlate, and option tables that cannot enumerate the unknown."
paths:
  - "agents/**"
  - "hooks/**"
  - "docs/**"
  - "scripts/lib/**"
  - "scripts/lib/validate/**"
  - "skills/_shared/**"
  - "tests/hooks/**"
  - "tests/integration/**"
  - "tests/lib/**"
  - "tests/lib/validate/**"
  - "scripts/**"
  - "tests/scripts/**"
  - "scripts/lib/reconcile/**"
  - "skills/wave-executor/**"
  - ".claude/rules/**"
  - "scripts/lib/eval/**"
  - "skills/eval/**"
  - "scripts/lib/session-schema/**"
learning-key: anti-pattern/a-git-grep-drift-sweep-cannot-see-untracked-files-so-a-pre-flight-sweep-run-before-the-commit-measures-a-different-tree-than-the-one-being-released
expires-at: 2026-10-24
---

# Measurement Discipline (consolidated)

**`expires-at` 2026-10-24 = the EARLIEST of the 20 absorbed dates** — a merged file must not outlive its shortest-lived content (`docs/rule-authoring.md` § Consolidated rules).

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A `git grep` drift sweep misses untracked files

`git grep` sees tracked files only. Before commit, include `git ls-files --others --exclude-standard` or rerun after staging.

**Evidence** — 2026-08-19: `--publish` aborted on `commands/release.md` (then untracked, tracked at `a2e495c`); the pre-commit sweep missed it. <!-- path-check: historical -->

### A hand-typed list cannot prove a census

A test claiming “every X emitted” over a hand-maintained array cannot detect new emissions. Census source directories in CODE, with a vacuum guard and allowlist ratchet.

**Evidence** — 2026-08-23: `tests/lib/events-schema.test.mjs` checked 10 literals while 31 event names were emitted; green for months.

### Protocol censuses must enumerate consumers, not payload names

Payload-name greps miss exit-code/stream assertions (`expect(code).toBe(2)`, `expect(stderr).toContain(...)`). Enumerate CONSUMERS spawning the binary; cross-check with a differently-shaped measurement.

**Evidence** — 2026-07-29: grep on `permissionDecision` → 4-package split; Full Gate then failed 32 tests in 3 files pinning exit 2 / stderr.

### Fremdplattform-Aussagen brauchen Messdatum und Toolversion

Jede Fremdplattform-Aussage mit Datum + Toolversion stempeln, damit sie widerlegbar bleibt: `skills/_shared/platform-tools.md` behauptete bis 2026-08-25 sequentielle Codex-Subagenten.

**Evidence** — 2026-08-25, codex-cli 0.141.0: `codex features list | grep multi_agent` → `multi_agent stable true`; `~/.codex/sessions`: spawn_agent 1748, wait_agent 6041.

### /reconcile muss im Schreibschritt konsolidieren

`scripts/lib/reconcile/writer.mjs:575-641` `budgetPreflight`: thematische Konsolidierung gehoert zum WRITE-Schritt, nicht in spaetere Bereinigung.

### Ein gemeinsamer Deadline misst blockierte Event-Loop statt Probenkosten

Bei parallelen Proben blockiert `execFileSync` die Event-Loop: die awaitende Probe verliert die Deadline (`timeout`), der Verursacher bleibt `ran-clean` (HR-103). Budget je Probe in EIGENER Arbeitszeit messen (Wall minus Loop-Blocked). Geliefertes nie verwerfen.

**Evidence** — 2026-09-11: 7 bzw. 5 von 39 Proben `timeout` (isoliert 2-91 ms), Verursacher 3519 ms `ran-clean`; danach 0.

### AST provenance needs every reference route

Trace every REFERENCE from the protected import: alias/member/optional/computed routes and shadowing bindings. Accept only the exact direct-call shape. An imported loader with zero proven direct calls is itself a finding; unsupported routes must not become zero contracts.

**Evidence** — 2026-08-06/07 #1006: `Reflect.apply(armGuard,…)`, optional/member calls, `class armGuard` shadowing each vanished or gained false provenance.

### Performance braucht A/B unter derselben Last

Zeitversetzte absolute ms-Zahlen messen schwankende Host-Last. Alte Fassung per `git show` in eine Datei schreiben; beide Fassungen in EINEM Prozess importieren und abwechselnd messen.

**Evidence** — 2026-09-12 #1317: gemeldete ~235 vs ~142 ms "Regression"; A/B bei load ~9-10: HEAD ~860 vs neu ~205 ms — reine Last.

### Reconcile-Dedupe braucht Zaehler UND Schluesselliste

`runReconcile({dryRun:true})` liefert hoechstens den Cap aus einem tieferen Backlog. Nach Konsolidierung beweisen `proposals==0` nichts; pruefen: `alreadyMaterialized` unveraendert UND kein gemergter `learning-key` in `r.proposals`.

**Evidence** — 2026-09-11: vor/nach Merge proposals=10, alreadyMaterialized=60 unveraendert, andere 10 Keys, 0 gemergte re-proposed.

### Eval formulas follow the rubric and record shape

`scripts/lib/eval/engine.mjs` gate-health formulas are pre-registered verbatim in `skills/eval/rubric-v1.md`. Never substitute `session_type` for record SHAPE: use one exported predicate. Before clarifying a rubric without a version bump, measure that zero historical records carry the new shape.

**Evidence** — session-17 W4 HIGH: 0 of 427 `sessions.jsonl` records carry the shape; fix `isCoordinatorDirectHousekeeping`.

### Unlesbare JSONL-Zeilen zaehlen

Abgeschnittene Zeilen ueberspringen UND zaehlen: sonst meldet ein partieller Join “alles matched”. Unlesbare Zeilen gehoeren in Report UND Telemetrie (HR-105).

**Evidence** — 2026-09-16 `scope-echo.mjs`: `malformed_lines` 0× at HEAD before the fix; new tests red on the old state.

### Event consumer censuses include prefix readers

Before removing an `orchestrator.*` event, search prefix readers as well as full names: `scripts/lib/convergence-monitor.mjs` reads every `orchestrator.wave.*`, so `wave.started` is consumed (the 2026-09-06 audit called it consumer-less).

**Evidence** — 2026-09-19 @ `8f6ac022`: `rg WAVE_EVENT_PREFIX scripts/lib/convergence-monitor.mjs` → :156, :220 (a same-tick `started{N+1}` after `completed{N}` skips the (N-1,N) `shrinking_diff` pair); with `started` → `[]`, without → `shrinking_diff:2`.

### Import-Proben brauchen ein Nachlauf-Fenster

`await import(x); console.log("ok")` beweist keine Importsicherheit: `main().finally(() => process.exit(0))` feuert erst einen Macrotask nach Import-Aufloesung. Asynchrone Wirkungen mit Nachlauf-Fenster messen; sonst bleiben Probe und daraus gebauter Waechter vakuumgruen.

**Evidence** — 2026-09-20 #1393: "25/28 importierbar" war falsch; mit 700 ms settle 8/28 (Standardprofil), nach dem Sweep 28/28.

### Vorhanden ist nicht gelesen

Ein Praesenz-Check belegt keine Arbeit: `readEventsWithRotations` darf `existsSync(sibling)` nicht als gelesen werten, wenn nur `ARCHIVE_NAME_RE`-Namen Quellen werden; sonst unterdrueckt eine umbenannte Datei ihren Tombstone. Drei Zustaende: gelesen (`onDisk`), vorhanden-aber-ungelesen (eigene Gap-Art), weg. Fehlender Ledger bedeutet `null`, nicht `complete:true`.

**Evidence** — 2026-09-21 @ `ed3c062d` #1423: complete:true/gaps:0 neben 80 ungelesenen `_archive/`-Records; Mutation M1 → `tests/lib/events.test.mjs` 1/36 rot.

### Hot-Path-Kosten messen, bevor Konsumenten auseinanderlaufen

Ein geteiltes Praedikat nicht wegen ungemessener Hot-Path-Kosten beschneiden: erst A/B im selben Prozess mit echter Aufruf-Kardinalitaet (ein Grant pro Gate-5b-Treffer) messen, sonst divergieren die Verdikte.

**Evidence** — 2026-09-21 #1398: 1 von 9 Grants divergent zwei Monate lang; Kosten +0,067 ms pro Gate-5b-Treffer gegen 5-ms-Schwelle; danach 0/9.

<!-- untrusted-content:end -->

## Provenance

Dropping a pair re-proposes its learning.
- learning-key: `anti-pattern/a-git-grep-drift-sweep-cannot-see-untracked-files-so-a-pre-flight-sweep-run-before-the-commit-measures-a-different-tree-than-the-one-being-released`
- learning-id: `802bed34-a71f-4c80-8e24-1b30e6321e76`
- learning-key: `anti-pattern/ein-paritaets-test-mit-handgetippter-liste-unter-einem-zensus-titel-ist-ein-gruener-haken-ohne-deckung`
- learning-id: `3194f2dd-ec1c-4b4e-9419-3324102610f7`
- learning-key: `anti-pattern/png-dateigroesse-ist-kein-indikator-fuer-bildinhalt-ein-leeres-und-ein-voll-gezeichnetes-bild-trennen-unter-200-bytes`
- learning-id: `0c9fd390-8399-4dae-93fe-3bf35b79981e`  <!-- markers only (PNG size tracks entropy, not content — LOOK at the image) -->
- learning-key: `proven-pattern/an-option-table-cannot-enumerate-unknown-flags-parse-both-readings-and-judge-both-never-pick-one`
- learning-id: `ce9b19f8-e1c7-4ca2-b87a-aed6545ce374`  <!-- markers only (fixed: `scripts/lib/scope-gate.mjs`) -->
- learning-key: `anti-pattern/der-messfehler-ist-fast-nie-die-messung-sondern-die-ungenannte-grundgesamtheit`
- learning-id: `7d66e92f-8560-4c4d-82cb-d8d03bd5dda4`  <!-- markers only (swept 2026-10-02) -->
- learning-key: `anti-pattern/a-protocol-migration-census-keyed-on-the-payload-misses-every-consumer-that-pins-only-the-channel`
- learning-id: `a22ce14f-4666-4b91-99be-c680e9903907`
- learning-key: `anti-pattern/fremdplattform-aussage-ohne-messdatum-altert-still-codex-subagenten`
- learning-id: `f7c15517-afe7-4497-b6e1-c59a7d49d25f`
- learning-key: `anti-pattern/release-mjs-drift-sweep-war-ein-substring-match-und-kuerzte-die-trefferliste-still-auf-5`
- learning-id: `lrn-mtrngrpu-3`  <!-- markers only (fixed: `scripts/release.mjs`) -->
- learning-key: `recurring-issue/reconcile-output-overshoots-the-generated-rule-byte-ceiling-consolidation-into-the-thematic-files-is-part-of-the-write-step-not-a-later-cleanup`
- learning-id: `5644d60f-c32a-4a4e-b830-5ab09d336c51`
- learning-key: `recurring-issue/coordinator-declared-test-paths-in-a-wave-manifest-must-be-ls-verified-before-materializing`
- learning-id: `eea105c1-674b-4efd-adea-e5b441ba04f0`  <!-- markers only (substance: expired 2026-10-20, prose swept 2026-10-22) -->
- learning-key: `anti-pattern/ein-geteilter-wall-clock-deadline-bestraft-die-preemptiblen-proben-fuer-die-synchronen-geschwister`
- learning-id: `7df84b5c-ff14-43e4-9c57-3fc58d9497ab`
- learning-key: `proven-pattern/ast-provenance-guards-must-census-every-reference-route-not-only-recognized-direct-calls`
- learning-id: `960fd50b-aae5-4595-83c2-c184015c60de`
- learning-key: `anti-pattern/absolute-ms-zahlen-aus-verschiedenen-momenten-sind-unter-schwankender-host-last-kein-vergleich`
- learning-id: `f4b7368e-9195-415a-b659-98cd0b259f5f`
- learning-key: `proven-pattern/reconcile-dedupe-beweist-man-an-alreadymaterialized-und-der-schluesselliste-nicht-an-proposals-0`
- learning-id: `e1c225b2-6852-4f64-994b-3cc382dfbe1f`
- learning-key: `anti-pattern/a-fix-pass-keyed-a-pre-registered-eval-formula-on-session-type-and-silently-changed-the-rubric`
- learning-id: `bcd1dfeb-46db-43de-9a97-c2752e9e4d7a`
- learning-key: `anti-pattern/ein-still-ueberspringender-jsonl-parser-macht-aus-einem-teilergebnis-ein-sauberes-verdikt`
- learning-id: `c64ca428-66c6-45e4-810e-af9a9b6b38a2`
- learning-key: `anti-pattern/a-zero-consumer-event-audit-that-greps-the-event-name-misses-prefix-readers`
- learning-id: `277a5f1a-6a64-4366-937d-1975ee846da0`
- learning-key: `anti-pattern/eine-koordinator-probe-ohne-nachlauf-fenster-misst-den-moment-vor-der-wirkung`
- learning-id: `7972faad-365c-4343-8e16-ffcd725dc299`
- learning-key: `anti-pattern/existssync-als-beleg-fuer-gelesen-macht-aus-einer-luecke-ein-stilles-complete-true`
- learning-id: `1e77cd2e-7ae8-49c3-a51d-21afd71c1157`
- learning-key: `anti-pattern/ein-ungemessener-kostenvorbehalt-haelt-zwei-konsumenten-eines-praedikats-dauerhaft-auseinander`
- learning-id: `8faf69af-c95e-48e8-8ea7-a722849124fb`
- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
