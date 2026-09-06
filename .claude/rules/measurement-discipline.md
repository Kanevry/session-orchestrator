---
auto-generated: true
consolidated: true
alwaysApply: false
description: "The measurement was right and the population was wrong: tracked-only greps, hand-typed census lists, proxies that do not correlate, and option tables that cannot enumerate the unknown."
globs:
  - "agents/**"
  - "docs/**"
  - "scripts/lib/**"
  - "scripts/lib/validate/**"
  - "skills/_shared/**"
  - "tests/hooks/**"
  - "tests/integration/**"
  - "tests/lib/**"
  - "tests/lib/validate/**"
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
learning-key: anti-pattern/a-git-grep-drift-sweep-cannot-see-untracked-files-so-a-pre-flight-sweep-run-before-the-commit-measures-a-different-tree-than-the-one-being-released
expires-at: 2026-10-27
---

# Measurement Discipline (consolidated)

PSA-006 says quote the command. These say the command is the easy half — what makes a measurement wrong is almost always the unnamed POPULATION it ran over, a proxy standing in for the thing you actually wanted to know, or a missing measurement DATE that lets a once-true claim age in silence.

**`expires-at` is 2026-10-27 — the EARLIEST of the 9 absorbed dates.** A merged file must not outlive its shortest-lived content: a single date covering several learnings expires when the FIRST of them is due for review, never when the last is.

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A `git grep` drift sweep cannot see untracked files

`git grep` enumerates TRACKED files only. A release drift sweep run while a new file is still untracked reports clean, and the same sweep after the commit that tracks the file reports the hit — from the same working tree, with no edit in between. Any distributional grep claim taken BEFORE a commit must either add `git ls-files --others --exclude-standard` or be re-run after staging. The coordinator who measured and documented this exact blind spot hours earlier still walked into it.

**Evidence** — 2026-08-19: `--publish` aborted with *"still carry 3.20.0: commands/release.md"*. The pre-commit sweep over the same predicate had returned three files, none of them that one, because `commands/release.md` was untracked at measurement time and tracked at `a2e495c`.

### A line-regex frontmatter validator is blind to unparseable YAML and mis-measures block scalars

Validating frontmatter with line-oriented regexes is structurally blind to the defect class it exists to catch: an unquoted single-line `description` containing `': '` is not YAML, but `^description:` matches it perfectly. A second, quieter failure of the same class: a block-scalar extractor whose terminating lookahead offers a bare end-of-line alternative under `/m` captures only the FIRST folded line, reporting 97 chars for a 329-char description and making every length assertion built on it vacuous. Fix both by PARSING (js-yaml `CORE_SCHEMA`), never by tightening the regex. Note the sign flip across surfaces: `check-agents.mjs` BANS `description: >` because the agent loader cannot read it, while for SKILL.md that same form is the only one that makes the `': '` collision structurally impossible — porting the rule across surfaces would have forbidden the fix.

**Evidence** — 2026-08-15: two independent parsers (js-yaml `CORE_SCHEMA` + yaml 2.x) agreed on 46 SKILL.md files: 34 parse, 12 broken, all 12 on the description line; 46/46 after repair. Block-scalar bug proven pre-existing on untouched files: session-start helper=97 vs yaml-truth=329, autopilot 107 vs 555, bootstrap 98 vs 341.

### A parity test with a hand-typed list under a census title is a green tick with no cover

A test whose title promises *"matches every X the codebase emits"* and whose subject is a hand-maintained array only checks itself. It never goes red when reality runs away — and its green tick is read as cover, so the next person ticks the box. The recipe belongs in CODE (a real census over the source directories), not in a list. Plus two guards: a vacuum protection (the census must not be empty) and a ratchet on the allowlist (documenting something FORCES its removal from the debt list).

**Evidence** — 2026-08-23 in this repo: `tests/lib/events-schema.test.mjs` checked against ten literals while 31 event names were emitted — 21 outside it, ten of those with no catalogue line. The test had been green for months. Replaced by census + catalogue parity + allowlist ratchet; falsified by documenting one allowlist entry and watching the test go red.

### PNG file size is no indicator of image content

Concluding from 3653 vs 3793 bytes that an SVG rendered EMPTY produced a wrong root cause (reveal-gate instead of wrapper). The control test — a trivially visible SVG — came in at 3761 bytes, practically the same size. In compressed formats file size correlates with ENTROPY, not with content; a large flat area compresses almost as well as one with thin lines. The only valid test is to LOOK at the image.

**Evidence** — 2026-08-19: `_coord-B-figure.png` 3793 B (empty) vs `_svgtest.png` 3761 B (visible: black frame + red line + text). Inferring from size gave the wrong cause; only the Read tool on both images settled it.

### An option table cannot enumerate unknown flags — parse both readings and judge both

A wrapper-flag table (which flags take a value) is unenumerable by construction: every platform variant or new release adds a value-taking flag the table lacks, and the skipped operand then lands in VERB position, silently hiding the interpreter behind it. Adding table rows fixes one instance and leaves the class open (#992 patched `env -P` and `time -f` by hand; #1000 reopened the same bypass with any unlisted flag). The structural fix: read the segment TWICE — unknown flag as boolean, unknown flag as value-taking — keep the old reading PRIMARY so every existing consumer stays byte-identical, and expose the second as an OPTIONAL alt key that judging consumers UNION. Two rules make it safe: alt is OMITTED (not null) when the readings agree, so strict `toEqual` pins survive; and consumers needing a token POSITION read the primary index only.

**Evidence** — 2026-08-05 #1000: `env -Q /bin:/usr/bin bash -c 'rm -rf /etc'` measured ALLOW (verb resolved to `bin`), TRUE after. Fake-regression collapsing parse B onto parse A turned 3 tests RED. Union, not replacement, is load-bearing in BOTH directions. 300/300 lib + 274/274 hook/scope-gate green with zero consumer-file changes.

### Der Messfehler ist fast nie die Messung, sondern die ungenannte Grundgesamtheit

Fuenf Zahlenstreitigkeiten an einem Tag, alle mit derselben Form: beide Seiten hatten korrekt gemessen, aber ueber verschiedene Mengen. 39 vs 42 Fragen (zeilenverankerter grep verliert kompakte Einzeiler). 9 vs 20 sicherheitsrelevante Beschreibungen (Population A vs alle). 26/42 vs 24/41 Kopfzeilen (Literale vs Fragen). 6 vs 14 Bundle-Treffer (grep -c zaehlt ZEILEN, -o|wc -l zaehlt TREFFER; auf minifizierten Bundles Faktor 2,3). 114.758 vs 113.957 Byte (rohe wc -c MIT Frontmatter gegen einen Deckel OHNE). Keine dieser Zahlen war falsch gemessen. Die Konsequenz: eine Zahl ohne mitgelieferte Grundgesamtheit ist keine Messung, sondern eine Behauptung — und zwei Parteien koennen daraufhin endlos streiten, ohne dass eine von beiden irrt.

**Evidence** — 2026-08-22 Session #1107: fuenf unabhaengige Faelle, drei davon vom Koordinator verursacht, zwei von einer Peer-Session. Jeder wurde erst durch das Zitieren des Kommandos UND des Pfad-Scopes aufgeloest, nie durch Nachmessen allein.

### A protocol-migration census keyed on the PAYLOAD misses every consumer that pins only the CHANNEL

When migrating an output protocol, grepping for the payload field name enumerates the wrong population. Consumers that assert only the exit code or the stream (`expect(code).toBe(2)`, `expect(stderr).toContain(...)`) never name the payload and are structurally invisible to that census. Enumerate by CONSUMER instead — who spawns this binary? — and cross-check with a second, differently-shaped measurement.

**Evidence** — 2026-07-29: a grep on `permissionDecision` produced a 4-package work split; the Full Gate then failed with 32 tests across 3 files (blocked-commands-policy 21, templates-first-blocks-create 10, guard-event-eval-e2e 1) that pin exit 2 / stderr without ever naming the payload.

### Fremdplattform-Aussage ohne Messdatum altert still (Codex-Subagenten)

`skills/_shared/platform-tools.md` beschrieb Codex-Subagenten bis 2026-08-25 als 'when available; otherwise execute sequentially'. Gemessen ist das falsch: codex-cli 0.141.0 meldet 'multi_agent stable true', und der collaboration-Namespace (spawn_agent/list_agents/wait_agent/send_message/followup_task/interrupt_agent/close_agent) laeuft auf diesem Host produktiv. Klasse: eine Aussage ueber eine FREMDE Plattform ohne Messdatum+Toolversion wird nie widerlegt, weil niemand weiss, wann sie zuletzt stimmte — Gegenmittel ist der Pflicht-Stempel (Datum + Version) an jeder solchen Zeile, nicht eine Re-Verify-Erinnerung.

**Evidence** — `codex features list | grep multi_agent` -> 'multi_agent stable true' (2026-08-25, codex-cli 0.141.0); `cd ~/.codex/sessions && grep -rhoE '"(spawn_agent|send_message|wait_agent|list_agents|followup_task|interrupt_agent|close_agent)"' . | sort | uniq -c` -> wait_agent 6041, send_message 2233, spawn_agent 1748, list_agents 836, close_agent 781, followup_task 656, interrupt_agent 109.

<!-- untrusted-content:end -->

## Provenance

Consolidated 9 generated rules into this file (2026-09-06, 43→8 rule consolidation; 4 of them restored 2026-09-06 after the first pass dropped their prose and markers).

`anti-pattern/agents-md-description-frontmatter-must-be-inline-string-not-yaml-block-scalar` is carried as MARKERS ONLY: its substance ("`check-agents.mjs` BANS `description: >` because the agent loader cannot read it", plus the sign flip against SKILL.md) already stands verbatim in *A line-regex frontmatter validator is blind to unparseable YAML and mis-measures block scalars* above, so restoring the prose a second time would duplicate a live section. The bullets below keep the reconcile dedupe honest. Its address moved once already: the check is no longer "validate-plugin Check 11" but `scripts/lib/agent-frontmatter.mjs:152` (second consumer: `scripts/lib/description-surface.mjs`).
The reconcile engine dedupes on these markers — removing a pair regenerates that learning as a standalone file.

Frontmatter `learning-key:` is a scalar and duplicates only the FIRST bullet; `defaultReadMaterializedProvenance()` unions frontmatter with body, so every bullet below is load-bearing.
- learning-key: `anti-pattern/a-git-grep-drift-sweep-cannot-see-untracked-files-so-a-pre-flight-sweep-run-before-the-commit-measures-a-different-tree-than-the-one-being-released`
- learning-id: `802bed34-a71f-4c80-8e24-1b30e6321e76`
- learning-key: `anti-pattern/a-line-regex-frontmatter-validator-is-blind-to-unparseable-yaml-and-mis-measures-block-scalars`
- learning-id: `6d8224c9-0e36-434b-9127-e38ca0988fb6`
- learning-key: `anti-pattern/ein-paritaets-test-mit-handgetippter-liste-unter-einem-zensus-titel-ist-ein-gruener-haken-ohne-deckung`
- learning-id: `3194f2dd-ec1c-4b4e-9419-3324102610f7`
- learning-key: `anti-pattern/png-dateigroesse-ist-kein-indikator-fuer-bildinhalt-ein-leeres-und-ein-voll-gezeichnetes-bild-trennen-unter-200-bytes`
- learning-id: `0c9fd390-8399-4dae-93fe-3bf35b79981e`
- learning-key: `proven-pattern/an-option-table-cannot-enumerate-unknown-flags-parse-both-readings-and-judge-both-never-pick-one`
- learning-id: `ce9b19f8-e1c7-4ca2-b87a-aed6545ce374`
- learning-key: `anti-pattern/der-messfehler-ist-fast-nie-die-messung-sondern-die-ungenannte-grundgesamtheit`
- learning-id: `7d66e92f-8560-4c4d-82cb-d8d03bd5dda4`
- learning-key: `anti-pattern/a-protocol-migration-census-keyed-on-the-payload-misses-every-consumer-that-pins-only-the-channel`
- learning-id: `a22ce14f-4666-4b91-99be-c680e9903907`
- learning-key: `anti-pattern/fremdplattform-aussage-ohne-messdatum-altert-still-codex-subagenten`
- learning-id: `f7c15517-afe7-4497-b6e1-c59a7d49d25f`
- learning-key: `anti-pattern/agents-md-description-frontmatter-must-be-inline-string-not-yaml-block-scalar`
- learning-id: `agent-md-description-must-be-inline-string`

- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
