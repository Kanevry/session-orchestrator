---
auto-generated: true
consolidated: true
alwaysApply: false
description: "A documented callback signature and a dispatch acknowledgement are both claims about a caller — neither is verified until something compiles or measures against the real call shape."
globs:
  - "hooks/**"
  - "scripts/lib/**"
  - "skills/session-end/**"
  - "skills/wave-executor/**"
  - "tests/skills/session-end/**"
  - "scripts/lib/config/**"
  - "agents/**"
  - "scripts/**"
  - "package.json"
  - "scripts/lib/telemetry/**"
  - "skills/session-start/**"
  - "scripts/lib/reconcile/**"
  - "scripts/lib/validate/**"
paths:
  - "hooks/**"
  - "scripts/lib/**"
  - "skills/session-end/**"
  - "skills/wave-executor/**"
  - "tests/skills/session-end/**"
  - "scripts/lib/config/**"
  - "agents/**"
  - "scripts/**"
  - "package.json"
  - "scripts/lib/telemetry/**"
  - "skills/session-start/**"
  - "scripts/lib/reconcile/**"
  - "scripts/lib/validate/**"
learning-key: anti-pattern/eine-dokumentierte-adapter-schnittstelle-die-nur-in-prosa-geprueft-wurde-passte-nicht-zur-echten-aufrufform
expires-at: 2026-11-12
---

# Review and Adapter Contracts (consolidated)

The first two rules concern an interface described in PROSE that did not match the real call shape, and in both cases every downstream consumer inherited the mistake. The rest name the review postures that find such a mismatch when test, gate and author agree it is fine: a reviewer told to REFUTE rather than to check, an EXTERNAL model judging the shipped artefact instead of the tree, and a read-only Discovery wave testing each issue's premise before the first edit.

**`expires-at` 2026-11-12 = the EARLIEST of the 9 absorbed dates** (merge contract: `docs/rule-authoring.md` § Consolidated rules).

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A documented adapter interface checked only in prose did not match the real call shape

`skills/wave-executor/wave-loop.md` quoted `probeFn: remoteDoctor` as synchronous, taking an object argument and returning a record — but the gate interface that actually calls it is `async (alias) => boolean`. The doc was never COMPILED against the real caller, only read. A new adapter (`remoteReadyProbe()`) closes the gap, and the doc now quotes the adapter instead of the imagined signature. Every documented callback interface needs a compile or type test against the REAL caller, not just a prose description.

**Evidence** — 2026-09-02, W4 panel (RV-ARCH, HIGH), commit `2ae28770`: *"wave-loop.md quoted `probeFn: remoteDoctor` — sync, object argument, record return; the gate interface is `async (alias) => boolean`."*

### A `tool_result` on an Agent dispatch is a LAUNCH ACK under async dispatch, not a completion

Deciding "this subagent has finished" from the presence of a `tool_result` for its `tool_use` id is correct ONLY for the synchronous dispatch shape. Under async dispatch the harness returns a `tool_result` within ~0.2s whose text is *"Async agent launched successfully"* plus an `agentId`; the real completion arrives minutes later as a `<task-notification>` record carrying `<tool-use-id>toolu_…</tool-use-id>` and `<status>completed</status>`. A liveness probe counting the ACK as a completion reports every background agent as done, silently disarming any guard built on it. Discriminate on the ACK TEXT and read the task-notification for the async shape.

**Evidence** — 2026-08-14, 38 archived transcripts of this repo: sync batch 2026-08-06T07:07:39 shows 5 Agent rows within 0.44s and their 5 `tool_result`s 5–11 minutes later; async dispatch *"L2 extract redactSpans primitive"* at 14:14:26.537 has its `tool_result` at 14:14:26.768 (0.23s) and its `<status>completed</status>` task-notification only at 14:24:39.360. Pinned by `tests/hooks/pre-task-scope-disjoint.test.mjs`.

### Ein Reviewer mit ausdruecklichem Widerlegungsauftrag findet, was Test, Gate und Autor gemeinsam durchlassen

Ein Panel-Agent, dessen Auftrag WIDERLEGEN statt PRUEFEN lautet, findet Zustaende, die Tests, gruener Full Gate und Autor gemeinsam passieren lassen — der Unterschied ist die Fragestellung, nicht die Sorgfalt. Drei Belege derselben Form: (a) ein fail-open Zweig AUSSERHALB eines git-Repos in einem Fix, der genau gegen fail-open geschrieben war (alle 6 Tests pruefen INNERHALB); (b) eine beim prosa→code-Umzug NEU gepraegte Widerspruchslage (`session-shape.mjs` publizierte `isolationDefault:'none'`, `resolveIsolation` lieferte `worktree`) plus eine tautologische Fixture; (c) 1 HIGH + 8 MED in eigenem Wellen-Code, kein einziger testrot. Panels read-only halten, auf den VOLLEN Session-Diff ansetzen und adversarisch briefen.

**Evidence** — (a) 2026-08-19, 8 Behauptungen zur Falsifikation: 3 bestaetigt, 4 eingeschraenkt, 1 widerlegt; der vierte Mirror-Zustand in keinem der 6 Tests. (b) W4 `main-2026-09-09-session-4` bei 17.038/0: `rg -n isolationDefault` → 3 Treffer, alle im Modul + Test; `7 (feature: x)` parste zu 12. (c) W4-Panel bei 16.244/0: `argv[1]`-Main-Guard im Probe, fail-open Husky-Stufe, ESLint stumm in Consumer-Repos, `wave_start_sha` nicht ueber `/clear` erhalten; Fixpass 3 Agenten / ~25 min, alle mit Fake-Regression-Beweis.


### Ein externes Modell als Zweitgutachter prueft das ARTEFAKT, ein Claude-Panel den Tree

Codex (gpt-6-astra, `codex exec -s read-only`) fand am 4.0.0-Cut, dass `.orchestrator/policy/` nicht im npm-Pack lag (npm-Konsumenten hatten seit jeher einen inerten Destructive-Guard) und im Zweitblick den Queue-Bypass der Telemetrie-Whitelist — beides Artefakt-/Laufzeit-Fragen (packlist, flush-Body), die ein Tree-Review strukturell nicht stellt. Vier parallele Claude-Reviewer (Architektur, Security, Migration, Fresh-Install) fanden es nicht. Kosten ~15 min/Lauf; Prompt per stdin (`- < prompt.md`), sonst haengt `codex exec`.

**Evidence** — 2026-09-06 Codex-Reviews: `npm pack --dry-run | grep -c orchestrator/policy` → 0 und `loadEffectivePolicy` → `rules:null`; Queue-Bypass beim flush 1→2→3; 5/8 ACCEPTED. Fix: `package.json` `files[]` + `tests/scripts/pack-policy-floor.test.mjs`, `sync.mjs` `sanitizeQueuedRecord`.

### Discovery-Welle widerlegte 3 von 16 Issue-Praemissen vor dem ersten Edit

Sieben read-only Discovery-Agenten (ein grep pro Claim, Datum + Kommando) fanden vor W2: #1242 Akzeptanz hielt bereits (Dedupe ueber getrackte Provenance-Marker, Fresh-Clone-Simulation 0 Regenerationen), #1257 Sub-Package-Pins sind CI-load-bearing, #1256 der angebliche tote Export war weder exportiert noch ungenutzt, #1262.1 brauchte keinen Code. Ohne W1 haette W2 vier Nicht-Probleme repariert. Praemissen-Check pro Issue ist billiger als ein einziger Fehl-Fix.

**Evidence** — Session `main-2026-09-07-session-11` W1-D1/D6/D7 Reports; CHANGELOG 4.0.1 § Fixed #1242/#1256/#1257; Issue-Notes 2026-09-07.

### Der Agenten-Rueckgabewert ist die LETZTE Nachricht — ein PSA-006-Nachtrag verdraengt den Report

Fuenf Agenten dieser Session (D1, C8, P1, Q2, Q3) beendeten mit einem PSA-006-Korrektur-Nachtrag als letzter Nachricht (ausgeloest vom discovery-validator-Hook); der Koordinator sah nur den Nachtrag und musste den Report per SendMessage nachfordern (je ~2-5 min). Prompt-Zeile "LAST message = COMPLETE report" allein reicht nicht, wenn ein Hook nach dem Report noch eine Nachricht provoziert. Gegenmittel: Agenten anweisen, PSA-006-Nachtraege IN den Report zu integrieren und den Report als letzte Nachricht erneut komplett zu senden.

**Evidence** — Session main-2026-09-04-session-20: 5 SendMessage-Nachforderungen (a248e1a6, ab22bbdb, a633b545, a5487814, a373087d), jeweils Addendum-only als final result; hooks/post-subagent-discovery-validator.mjs ist der Ausloeser.

### Ohne `exports`-Map ist JEDER Export oeffentlich — Return-Typ-Aenderung ist dann ein Major, kein Patch

package.json hat kein exports-Feld, also kann jeder Consumer scripts/lib/** direkt importieren. loadConfidentialNames() von string[]|null auf {status,names} zu drehen war ein Major in einem Patch — nur Codex (Artefakt-Review des npm-Packs) fand es, kein Claude-Reviewer. Loesung: neue additive Funktion inspectConfidentialNames(), alter Name bleibt als duenner Wrapper. Regel: bei fehlendem exports-Map ist JEDER Export oeffentlich.

**Evidence** — Codex gpt-6-astra Review 2026-09-07 P1 #2: "4.0.0 caller: TypeError: result.map is not a function"; node -p "require('./package.json').exports" → undefined.

<!-- untrusted-content:end -->

## Provenance

Markers below are the reconcile engine's dedupe anchors — removing a pair regenerates that learning as a standalone file (`docs/rule-authoring.md` § Consolidated rules). Consolidated by hand 2026-09-06 + 2026-09-09.
- learning-key: `anti-pattern/eine-dokumentierte-adapter-schnittstelle-die-nur-in-prosa-geprueft-wurde-passte-nicht-zur-echten-aufrufform`
- learning-id: `f91ce630-765a-481f-8744-ef05ede66ea8`
- learning-key: `anti-pattern/a-tool-result-on-an-agent-dispatch-is-a-launch-ack-under-async-dispatch-not-a-completion`
- learning-id: `1151305b-7b16-4fbd-ada6-f481b985d3a6`
- learning-key: `proven-pattern/ein-reviewer-mit-ausdruecklichem-widerlegungsauftrag-findet-was-test-gate-und-autor-gemeinsam-durchlassen`
- learning-id: `f100ef22-a6f4-481a-a0b2-39b8bc11ca14`

- learning-key: `proven-pattern/a-refute-briefed-review-panel-finds-machine-made-contradictions-a-green-gate-cannot`
- learning-id: `a5c39859-3565-4d04-a412-9b918f1f10b5`
- learning-key: `proven-pattern/widerlegungsauftrag-im-review-panel-1-high-8-med-in-eigenem-wellen-code-bei-gruenem-full-gate`
- learning-id: `8666f264-4705-4696-8b3a-2e312d269716`
- learning-key: `proven-pattern/ein-externes-modell-als-zweitgutachter-prueft-das-artefakt-ein-claude-panel-den-tree-codex-fand-den-p1-den-vier-claude-reviewer-nicht-sahen`
- learning-id: `7485603f-c174-41cb-b42f-a8fea9465d0c`
- learning-key: `proven-pattern/discovery-welle-widerlegte-3-von-16-issue-praemissen-vor-dem-ersten-edit`
- learning-id: `lrn-mtrngrpt-0`
- learning-key: `anti-pattern/der-agenten-rueckgabewert-ist-die-letzte-nachricht-ein-psa-006-nachtrag-verdraengt-den-report`
- learning-id: `9a89d77c-8837-46e9-8a3e-3c55c399f561`
- learning-key: `anti-pattern/return-typ-eines-deep-importierbaren-moduls-in-einem-patch-release-aendern-kein-exports-map`
- learning-id: `lrn-mtrngrpu-2`

- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
