---
auto-generated: true
consolidated: true
alwaysApply: false
description: "How a guard fails open: self-confirming predicates, bypasses that outlive the matcher they guard, declarations that leak into grants, and censuses that stop at the recognized route."
paths:
  - "hooks/**"
  - "hooks/_lib/**"
  - "scripts/**"
  - "scripts/lib/**"
  - "scripts/lib/validate/**"
  - "tests/_helpers/**"
  - "tests/scripts/**"
  - "tests/scripts/validate/**"
  - "CLAUDE.md"
  - "skills/wave-executor/**"
  - "tests/unit/**"
  - "scripts/lib/vault-mirror/**"
  - "scripts/lib/vault-status/**"
  - "scripts/lib/config/**"
  - "tests/lib/**"
  - "skills/wave-executor/references/**"
  - "scripts/lib/reconcile/**"
  - "tests/rules/**"
learning-key: anti-pattern/ein-peer-record-im-selben-allowedpaths-array-das-per-union-eingesammelt-wird-gewaehrt-statt-zu-markieren
expires-at: 2026-10-04
---

# Guard Design (consolidated)

Each guard here passed its own tests while permitting what it existed to forbid — a vacuous predicate, or a matcher widened without its bypass.

**`expires-at` 2026-10-04 = the EARLIEST of the 17 absorbed dates** — a merged file must not outlive its shortest-lived content (`docs/rule-authoring.md` § Consolidated rules).

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A declaration and a grant must never share one unfiltered data structure

`unionFileScopes()` treated the peer-VISIBILITY record `peer-session-<id>` (#1195) like any other, so `--union` put it into `allowedPaths`, GRANTING its paths to the whole wave and making the peer-write branch of `post-bash-write-verify` unreachable. Fix: union skips peer records, `--assert-disjoint` keeps them, materialize writes no per-agent file.

**Evidence** — 2026-09-02 W4 panel (RV-ARCH, HIGH), commit `2ae28770`; `scope-gate.mjs` (`PEER_RECORD_PREFIX` as SSOT) + `materialize-wave-scope.mjs`; four red proofs.

### An ownership check that compares the fallback value is self-fulfilling

`if (id === null) id = recordedId` then `id === recordedId` compares a copy with itself — always "mine". The ACTOR identity may fall back; the ownership CLAIM is decided from the RAW input, else `current-session.json` hands you a live peer's identity and wave completion.

**Evidence** — 2026-09-02 `grep -rn "= recordedId;" hooks/ scripts/` → exactly 2 sites, both defective: `hooks/on-session-end.mjs:147` (gated `durationMs`, `semanticSessionId`, final `wave.completed`; a /tmp repro wrote `last_wave_completed:3` into a PEER's file), `hooks/on-stop.mjs:284`. Fake-regressed red: 4 and 1 test.

### Widening a matcher without narrowing its bypass opens a hole the narrow version did not have

Every check on a widened matcher needs the same per-statement scoping, the bypass first: judged over the WHOLE command, one appended exemption statement lifts it. Fix: bind the bypass to the statement the matcher hit.

**Evidence** — 2026-08-23 after #1106: `glab issue create --title REAL; glab issue create --label ci --title junk` → ALLOW, `glab issue create --title REAL` → DENY, pattern live; security panel, reproduced on old and new versions.

### A declaration mechanism with two required shapes fails silently when only one is written

#1020 needs per-agent path files AND the per-wave `{id,files}` aggregate (CLAUDE.md § Critical Gotchas); aggregate-only errors nowhere — no injection, `pre-task-scope-disjoint` permits all and writes NO ledger entry. A missing second artefact must be a loud error, never an empty read.

Fix-pass BATCHES need the same manifest step as waves: W4-F8 ran without `w4-f8.json` + aggregate + union, `pre-task-scope-disjoint` blocked it, and the agent escalated by SendMessage — the HOOK is the catcher, not the coordinator.

**Evidence** — 2026-08-19 GitLab #1083: six waves / ~29 dispatches aggregate-only; `.orchestrator/wave-dispatch-scopes.json` held a two-day-old foreign waveKey. 2026-09-06 STATE.md Deviations: *"W4-F8 dispatched WITHOUT materialising its scope"*, `w4-f8.json` written after the fact, `--assert-subset` ok. Matrix: `docs/scope-collision-guard.md`.

### Ein Masker-Guard, der nur einen von zwei Generatoren deckt, liest sich als geschlossene Klasse

W2 guardete nur `processLearning` (`maskerWouldChange` vor jedem skipped-noop, Kommentar "every skipped-noop return in processLearning"); `processSession` (groessere Leckflaeche) blieb date-only, der Legacy-Flat-Zweig liess das Klartext-Original liegen. Bei einem Skip-Site-Fix `rg` nach ALLEN Sites der Aktion, je Generator eine Fixture.

Die DRITTE Senke hat die Luecke der ersten beiden NICHT: `writeNarrative` (`vault-status/narrative-mirror.mjs`) vergleicht das GANZE Dokument statt fuenf kanonische Felder, und ihr Kandidat lief schon durch den aktuellen Masker — eine `maskerWouldChange`-Probe schriebe dort jeden Lauf neu, ohne zu heilen. Je Senke die VERGLEICHSFORM pruefen, nicht nur die Guard-Praesenz.

**Evidence** — `scripts/lib/vault-mirror/process.mjs` guarded :687, :739, :763; unguarded :904, :929 (`rg -n skipped-noop`, 2026-09-03 @ `e22a702e`). Fixpass `37169158`: 4 Tests, rot auf HEAD 2/66, gruen 68/68. Dritte Senke: PROBE 2026-09-04 @ `cd785003`, `tests/lib/vault-status/narrative-mirror.test.mjs` — getauschte Argumente in `matchesModuloRedaction(existing, candidate)` → beide `skipped-noop` (Fake-Regression, 2 failed).

### Deleting an unreachable-module ROOT promotes its dragged members to new roots

`check-unwired-features` reports only cluster ROOTS, so an agent scoped to them never reaches 0. Brief dead-code sweeps by CLUSTER (`--list` plus the drag chain).

**Evidence** — 2026-09-09 session-10: W1-A2 stalled at 5→2, W2-B4 deleted the 2 promoted roots (17 files, 157 tests), a third pair surfaced behind a bare-basename collision in the roots filter (#1293).

### Fail-closed fuer einen Block-PARSER ist fail-OPEN fuer einen Bypass-SCANNER derselben Datei

Unterminierter `<!--` in `## Session Config`: der PARSER liefert die Zeilen ungefiltert, der Bypass-SCANNER liest "Kommentarende unbestimmbar" als NICHT ARMIERT, sonst reaktiviert ein auskommentiertes `allow-config-weakening: true` den Aus-Schalter. Die Richtung folgt dem Schadensmodell.

**Evidence** — `scripts/lib/config/config-protection.mjs:108-136` gegen `scripts/lib/config/block-preprocess.mjs`; Fixpass X3 (2026-09-04 session-12) fand den Bypass zunaechst via Kommentar ARMIERT.

### Ein Config-Key, den nur der Konsument kennt: Leser mit Default, aber kein Producer emittiert ihn

`checkInstructionBudget` las `cfg['generated-byte-ceiling']`/`cfg['path-scoped-byte-ceiling']` mit Default; der einzige Producer `_parseInstructionBudget` kannte beide nie. Fuer jeden `cfg['<key>']`-Leser den Producer greppen.

**Evidence** — `grep -n "cfg\['" scripts/lib/instruction-budget-guard.mjs` (2026-09-11): 3 gelesene Keys, der Parser kannte nur 4 andere; die 79er-Suite blieb vor #1309 gruen.

Dieselbe Deckel-Linie, andere Richtung: eine nur beratende Achse in ein Aggregat-Verdikt zu falten, macht jeden Konsumenten dieses Verdikts zum Stolperdraht. `tests/rules/receiving-review.test.mjs` pinnt `overBudget===false` am LIVE-Korpus, also wurde die naechste `/reconcile`-Regel (2,2-2,8 KB gegen 1.237 B Luft) zu einem roten `npm test` ohne Hinweis zur Schreibzeit. Vor dem Falten jeden Konsumenten zensieren und den Fold mit einem Write-Time-Preflight im Producer paaren.

**Evidence** — session-17 W4 architect-reviewer HIGH (`receiving-review.test.mjs:54-57` + `instruction-budget-guard.mjs:1058`); behoben in W5 durch `budgetPreflight` in `scripts/lib/reconcile/writer.mjs`.

<!-- untrusted-content:end -->

## Provenance

Dedupe anchors — dropping a pair regenerates that learning.
- learning-key: `anti-pattern/ein-peer-record-im-selben-allowedpaths-array-das-per-union-eingesammelt-wird-gewaehrt-statt-zu-markieren`
- learning-id: `c8993344-8cf9-4dc2-9b4a-3cac32afe4ec`
- learning-key: `anti-pattern/eine-ownership-pruefung-die-den-fallback-wert-vergleicht-ist-selbsterfuellend`
- learning-id: `7d574cce-303c-4edc-ada6-f572260765bd`
- learning-key: `anti-pattern/einen-matcher-verbreitern-ohne-seinen-bypass-mitzuverengen-oeffnet-ein-loch-das-die-enge-fassung-nicht-hatte`
- learning-id: `97b3532e-6693-4d73-9e92-060b562952ce`
- learning-key: `recurring-issue/an-exemption-marker-that-only-works-same-line-is-visually-identical-to-one-in-a-comment-block`
- learning-id: `d86c9b5f-bdd3-4f48-b37e-b5b751e78486`  <!-- markers only (substance: state the placement rule AT the marker; `check-untracked-test-deps:ignore` counts same-line only) -->
- learning-key: `anti-pattern/a-declaration-mechanism-with-two-required-shapes-fails-silently-when-only-one-is-written`
- learning-id: `726397dd-7657-4eee-bea9-a6891cb04e1a`
- learning-key: `anti-pattern/ein-masker-guard-der-nur-einen-von-zwei-generatoren-deckt-liest-sich-als-geschlossene-klasse`
- learning-id: `ein-masker-guard-der-nur-einen-von-zwei-generatoren-deckt-liest-sich-als-geschlossene-klas-2026-09-04`
- learning-key: `anti-pattern/ein-short-circuit-vor-einem-geschwaetzigen-loader-loeschen-zieht-dessen-diagnostik-auf-den-fail-pfad`
- learning-id: `lrn-mtrngrpu-1`  <!-- markers only (substance: redact WARN paths to `basename()`; fixed in `check-owner-leakage.mjs` FX1) -->
- learning-key: `anti-pattern/deleting-an-unreachable-module-root-promotes-its-dragged-members-to-new-roots-size-a-dead-code-sweep-by-cluster-not-by-reported-root`
- learning-id: `aad72bc6-104f-4ea8-b913-77e075d14f02`
- learning-key: `anti-pattern/fail-closed-fuer-einen-block-parser-ist-fail-open-fuer-einen-bypass-scanner-im-selben-dokument`
- learning-id: `f2042774-8d2b-44eb-9c95-96567a5e8a09`
- learning-key: `anti-pattern/await-import-probe-misses-call-time-referenceerror-in-hoisted-exported-functions`
- learning-id: `9300dc8f-5d66-4068-92dc-64826a378ce8`  <!-- markers only (substance: `toolchain-and-build.md` § Zwischenstand mit Vorwaertsreferenz — ESLint `no-undef` is the catcher) -->
- learning-key: `anti-pattern/eine-flag-ueberspringende-regex-kann-wertaufnehmende-git-globalflags-nicht-erraten`
- learning-id: `6b60f6b5-a63b-42dd-9f78-2808d78dfe11`  <!-- markers only (substance: fixed — `isGitWrite()` is argument-aware since C3, `wave-transcript-tail.mjs:107-129`) -->
- learning-key: `anti-pattern/ein-agent-ohne-materialisierten-scope-1020-der-koordinator-dispatcht-der-hook-blockt-der-agent-eskaliert-der-koordinator-merkt-es-erst-per-sendmessage`
- learning-id: `e18f28d9-d47e-43a1-99eb-3631a7147ed8`
- learning-key: `anti-pattern/ein-deckel-dessen-key-name-eine-teilmenge-behauptet-die-sein-zaehler-nie-filtert`
- learning-id: `088151eb-6623-462d-a6ed-6c558e9a362b`  <!-- markers only (substance: `scripts/lib/instruction-budget-guard.mjs` DEFAULT_GENERATED_BYTE_CEILING docblock (#1297)) -->
- learning-key: `anti-pattern/ein-config-key-den-nur-der-konsument-kennt-leser-mit-default-aber-kein-producer-emittiert-ihn`
- learning-id: `2226b36f-3568-4131-8a13-97e76e673312`
- learning-key: `recurring-issue/der-tailer-meldet-git-stash-version-als-psa007-git-write-der-psa-007-regex-ist-argument-blind`
- learning-id: `der-tailer-meldet-git-stash-version-als-psa007-git-write-der-psa-007-regex-ist-argument-bl-2026-09-04`  <!-- markers only (substance: same fix as the flag-skipping regex — `isGitWrite()` argument-aware, #1215) -->
- learning-key: `anti-pattern/die-dritte-masker-senke-hat-die-luecke-der-ersten-beiden-nicht-feldvergleich-vs-dokumentvergleich`
- learning-id: `5949e882-0d7e-40be-afa8-aa7c1fd4832c`
- learning-key: `anti-pattern/folding-a-banner-only-budget-axis-into-overbudget-turns-a-live-corpus-test-pin-into-a-ci-trip-wire-the-writer-cannot-see`
- learning-id: `6f0caca5-689d-494d-83a1-020b0ca2b3e8`
- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
