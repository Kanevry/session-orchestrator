---
auto-generated: true
consolidated: true
alwaysApply: false
description: "The measurement was right and the population was wrong: tracked-only greps, hand-typed census lists, proxies that do not correlate, and option tables that cannot enumerate the unknown."
paths:
  - "agents/**"
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
expires-at: 2026-10-02
---

# Measurement Discipline (consolidated)

**`expires-at` 2026-10-02 = the EARLIEST of the 17 absorbed dates** — a merged file must not outlive its shortest-lived content (`docs/rule-authoring.md` § Consolidated rules).

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A `git grep` drift sweep cannot see untracked files

`git grep` enumerates TRACKED files only, so a sweep misses a new file until the commit that tracks it. A grep claim taken BEFORE a commit must add `git ls-files --others --exclude-standard` or be re-run after staging.

**Evidence** — 2026-08-19: `--publish` aborted with *"still carry 3.20.0: commands/release.md"*; the pre-commit sweep missed it — `commands/release.md` was untracked then, tracked at `a2e495c`. <!-- path-check: historical -->

### A parity test with a hand-typed list under a census title is a green tick with no cover

A test titled *"matches every X the codebase emits"* over a hand-maintained array only checks itself — never red when reality runs away, yet read as cover. Recipe in CODE (census over the source dirs) + vacuum guard + allowlist ratchet.

**Evidence** — 2026-08-23: `tests/lib/events-schema.test.mjs` checked 10 literals while 31 event names were emitted (21 outside, 10 uncatalogued); green for months. Replaced by census + catalogue parity + ratchet; documenting one allowlist entry → red.

### Der Messfehler ist fast nie die Messung, sondern die ungenannte Grundgesamtheit

Fuenf Zahlenstreite an einem Tag, beide Seiten korrekt gemessen, ueber verschiedene Mengen: 39 vs 42 Fragen (zeilenverankerter grep verliert Einzeiler), 6 vs 14 Bundle-Treffer (`grep -c` zaehlt ZEILEN, `-o|wc -l` TREFFER; minifiziert Faktor 2,3), 114.758 vs 113.957 Byte (`wc -c` MIT Frontmatter gegen einen Deckel OHNE). Eine Zahl ohne Grundgesamtheit ist eine Behauptung — zum Kommando (PSA-006) gehoert das Scope.

**Evidence** — 2026-08-22 Session #1107: fuenf Faelle (3 Koordinator, 2 Peer), aufgeloest nur durch Kommando UND Pfad-Scope.

### A protocol-migration census keyed on the PAYLOAD misses every consumer that pins only the CHANNEL

A payload-name grep misses consumers asserting only exit code or stream (`expect(code).toBe(2)`, `expect(stderr).toContain(...)`). Enumerate by CONSUMER — who spawns this binary? — and cross-check with a differently-shaped measurement.

**Evidence** — 2026-07-29: a grep on `permissionDecision` → 4-package split; the Full Gate then failed 32 tests in 3 files (blocked-commands-policy 21, templates-first-blocks-create 10, guard-event-eval-e2e 1) pinning exit 2 / stderr.

### Fremdplattform-Aussage ohne Messdatum altert still (Codex-Subagenten)

`skills/_shared/platform-tools.md` nannte Codex-Subagenten bis 2026-08-25 'when available; otherwise execute sequentially' — gemessen falsch (Evidence). Ohne Messdatum+Toolversion wird so eine Aussage nie widerlegt; Gegenmittel ist der Pflicht-Stempel (Datum + Version) an jeder Zeile.

**Evidence** — `codex features list | grep multi_agent` -> 'multi_agent stable true' (2026-08-25, codex-cli 0.141.0); `cd ~/.codex/sessions && grep -rhoE '"(spawn_agent|send_message|wait_agent|list_agents|followup_task|interrupt_agent|close_agent)"' . | sort | uniq -c` -> wait_agent 6041, send_message 2233, spawn_agent 1748, list_agents 836, close_agent 781, followup_task 656, interrupt_agent 109.

### /reconcile output overshoots the generated-rule byte ceiling — consolidate in the same write step

Mechanik: `scripts/lib/reconcile/writer.mjs:575-641` `budgetPreflight` — consolidation into the thematic files is part of the WRITE step, never a later cleanup.

### Coordinator-declared test paths in a wave manifest must be `ls`-verified before materializing

Declared test paths never checked on disk grant write access to phantom paths; real files are covered only by the test-sibling glob. `ls`-verify every declared path before materialize-wave-scope.mjs.

**Evidence** — STATE.md Deviations, main-2026-09-04-session-20, 2026-09-05T06:46:53.496Z: W3-P1 declared tests/lib/qg-command-drift-banner.test.mjs, tests/lib/quality-gate.test.mjs, tests/lib/quality-gate-session-config.test.mjs — none exist; the real suites live under tests/unit/.

### Ein geteilter Wall-Clock-Deadline bestraft die preemptiblen Proben fuer die synchronen Geschwister

Parallele Proben in einem Prozess: `execFileSync` blockiert die Event-Loop, eine danach awaitende Probe verliert gegen den abgelaufenen Timer und wird `timeout` mit verworfenem Ergebnis, der Verursacher `ran-clean` — gemessen wird Asynchronitaet statt Kosten (HR-103 in der Zeitachse). Fix: Budget in EIGENER Arbeitszeit (Wall minus Loop-Blocked, via Timer-Verspaetung); Geliefertes nie verwerfen.

**Evidence** — 2026-09-11: 7 bzw. 5 von 39 `orchestrator.probes.completed` als `timeout`, obwohl isoliert 2.3-3.3ms/40-91ms; die blockierenden Geschwister (3519ms, 314ms) meldeten `ran-clean`. Danach 0 timeouts.

### AST provenance guards must census every reference route, not only recognized direct calls

Census every REFERENCE to the protected binding from the import outward (alias/member/optional/computed routes, shadowing bindings); accept only the exact direct-call shape. An imported loader with zero proven direct calls is ITSELF a finding, else an unsupported route passes as zero contracts.

**Evidence** — 2026-08-06/07 #1006: reviewers reproduced `Reflect.apply(armGuard,…)`, optional/member calls, `class armGuard` shadowing, symlink handlers, inherited Git selectors — each first vanished or gained false provenance. Validator 27/27, validate-plugin 159/0.

### Absolute ms-Zahlen aus verschiedenen Momenten sind unter schwankender Host-Last kein Vergleich

Eine Performance-Regression gegen eine Zahl zu melden, die Stunden vorher unter anderer Last gemessen wurde, misst die Maschine, nicht den Code. Der Vergleich gehoert A/B in EINEN Prozess unter derselben Last: alte Fassung per `git show` in eine Datei, beide importieren, abwechselnd messen.

**Evidence** — 2026-09-12 #1317: f-2 meldete ~235 ms gegen meine frueheren ~142 ms als Blocker; der A/B-Lauf bei load ~9-10 ergab HEAD ~860 ms vs. neue Fassung ~205 ms bei identischem Ergebnis-JSON — die gemeldete Regression war reine Last.

### Reconcile-Dedupe beweist man an `alreadyMaterialized` und der Schluesselliste, nicht an `proposals==0`

`runReconcile({dryRun:true})` liefert pro Lauf hoechstens den Cap an Vorschlaegen aus einem tieferen Backlog; `proposals==0` ist nach einem Merge von Einzelregeln in Sammeldateien daher KEIN Dedupe-Kriterium. Der belastbare Beweis ist zweiteilig: `alreadyMaterialized` bleibt konstant UND keiner der gemergten `learning-key`s taucht in `r.proposals` auf.

**Evidence** — 2026-09-11: vor dem Merge proposals=10 / alreadyMaterialized=60 / capped=81; nach dem Merge der 10 Einzeldateien in 7 Sammeldateien wieder proposals=10 (andere 10 Keys), alreadyMaterialized=60, 0 der gemergten Keys re-proposed; `bySurface.generated` 95414 B/18 Dateien → 87336 B/8 Dateien.

### A fix-pass keyed a pre-registered eval formula on `session_type` and silently changed the rubric

`scripts/lib/eval/engine.mjs` gate-health formulas are pre-registered VERBATIM in `skills/eval/rubric-v1.md`. A fix-pass adding `session_type === 'housekeeping'` flipped 4 real multi-wave records from cannot-determine to not-applicable without touching the rubric. Discriminate on the record SHAPE via one exported predicate, and measure that 0 historical records carry the new shape before clarifying a rubric without a version bump.

**Evidence** — session-17 W4 architect-reviewer HIGH; `jq` over `sessions.jsonl`: 4 multi-wave housekeeping records affected, 0 of 427 carry the all-coordinator-direct shape; fixed in W5 (`isCoordinatorDirectHousekeeping`).

### Ein still ueberspringender JSONL-Parser macht aus einem Teilergebnis ein sauberes Verdikt

Eine abgeschnittene Zeile ueberspringen ist richtig, sie nicht zu ZAEHLEN nicht: sonst meldet ein Join "alles matched" genau im Instrument, das stille Fehler finden soll. Die Zahl unlesbarer Zeilen gehoert in Report UND Telemetrie (HR-105).

**Evidence** — 2026-09-16 `scope-echo --verify`: `git show HEAD:scripts/lib/scope-echo.mjs | grep -c malformed_lines` → 0; seitdem Feld `malformed_lines`, die neuen Tests sind auf dem alten Stand rot.

### A zero-consumer event audit that greps the full event name misses PREFIX readers

Before removing an `orchestrator.*` event as consumer-less, grep for prefix readers (`startsWith('orchestrator.wave.')`), not only the full name. `scripts/lib/convergence-monitor.mjs` admits every `orchestrator.wave.*` record, so `wave.started` — listed as zero-consumer in the 2026-09-06 audit — is read live, and a `started{N+1}` in the same tail tick as `completed{N}` moves `latestWave` past N, so the (N-1,N) `shrinking_diff` pair is never evaluated.

**Evidence** — `rg WAVE_EVENT_PREFIX scripts/lib/convergence-monitor.mjs` → :156, :220; probe via exported `classify`/`_evaluateSignals`, 2026-09-19 @ `8f6ac022`: with `started` → emitted keys `[]`, without → `shrinking_diff:2`.

<!-- untrusted-content:end -->

## Provenance

Dropping a pair re-proposes its learning.
- learning-key: `anti-pattern/a-git-grep-drift-sweep-cannot-see-untracked-files-so-a-pre-flight-sweep-run-before-the-commit-measures-a-different-tree-than-the-one-being-released`
- learning-id: `802bed34-a71f-4c80-8e24-1b30e6321e76`
- learning-key: `anti-pattern/ein-paritaets-test-mit-handgetippter-liste-unter-einem-zensus-titel-ist-ein-gruener-haken-ohne-deckung`
- learning-id: `3194f2dd-ec1c-4b4e-9419-3324102610f7`
- learning-key: `anti-pattern/png-dateigroesse-ist-kein-indikator-fuer-bildinhalt-ein-leeres-und-ein-voll-gezeichnetes-bild-trennen-unter-200-bytes`
- learning-id: `0c9fd390-8399-4dae-93fe-3bf35b79981e`  <!-- markers only (substance: compressed size tracks entropy, not content — LOOK at the image) -->
- learning-key: `proven-pattern/an-option-table-cannot-enumerate-unknown-flags-parse-both-readings-and-judge-both-never-pick-one`
- learning-id: `ce9b19f8-e1c7-4ca2-b87a-aed6545ce374`  <!-- markers only (substance: fixed — dual-reading parse in `scripts/lib/scope-gate.mjs` / #1000) -->
- learning-key: `anti-pattern/der-messfehler-ist-fast-nie-die-messung-sondern-die-ungenannte-grundgesamtheit`
- learning-id: `7d66e92f-8560-4c4d-82cb-d8d03bd5dda4`
- learning-key: `anti-pattern/a-protocol-migration-census-keyed-on-the-payload-misses-every-consumer-that-pins-only-the-channel`
- learning-id: `a22ce14f-4666-4b91-99be-c680e9903907`
- learning-key: `anti-pattern/fremdplattform-aussage-ohne-messdatum-altert-still-codex-subagenten`
- learning-id: `f7c15517-afe7-4497-b6e1-c59a7d49d25f`
- learning-key: `anti-pattern/release-mjs-drift-sweep-war-ein-substring-match-und-kuerzte-die-trefferliste-still-auf-5`
- learning-id: `lrn-mtrngrpu-3`  <!-- markers only (substance: fixed — token-boundary + lockfile/comment predicates in `scripts/release.mjs`, pinned by `tests/scripts/release.test.mjs`) -->
- learning-key: `recurring-issue/reconcile-output-overshoots-the-generated-rule-byte-ceiling-consolidation-into-the-thematic-files-is-part-of-the-write-step-not-a-later-cleanup`
- learning-id: `5644d60f-c32a-4a4e-b830-5ab09d336c51`
- learning-key: `recurring-issue/coordinator-declared-test-paths-in-a-wave-manifest-must-be-ls-verified-before-materializing`
- learning-id: `eea105c1-674b-4efd-adea-e5b441ba04f0`
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
- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
