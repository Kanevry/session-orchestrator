---
auto-generated: true
consolidated: true
alwaysApply: false
description: "Tests that are green for the wrong reason: file-wide assertions on a one-block claim, fixtures that are the live repo, and mock state that survives restoreAllMocks."
globs:
  - "tests/ci/**"
  - "tests/lib/**"
  - "tests/lib/autopilot/**"
  - "tests/scripts/**"
  - "tests/skills/**"
  - "tests/skills/session-plan/**"
  - ".claude/rules/**"
  - "tests/lib/validate/**"
  - "tests/husky/**"
paths:
  - "tests/ci/**"
  - "tests/lib/**"
  - "tests/lib/autopilot/**"
  - "tests/scripts/**"
  - "tests/skills/**"
  - "tests/skills/session-plan/**"
  - ".claude/rules/**"
  - "tests/lib/validate/**"
  - "tests/husky/**"
learning-key: anti-pattern/a-file-wide-tocontain-in-a-test-that-judges-one-block-passes-for-states-the-block-never-reaches
expires-at: 2026-10-24
---

# Test Hygiene (consolidated)

Each of these produced a GREEN test over a state it was written to forbid. `.claude/rules/test-value.md` decides whether a test should exist; this file decides whether an existing one means anything. The settling proof shape recurs: restore the defect in a COPY and run the old assertion beside the new one on the same file.

**`expires-at` 2026-10-24 = the EARLIEST of the 8 absorbed dates (read 6 before the 2026-09-11 fold of 2 more)** (merge contract: `docs/rule-authoring.md` § Consolidated rules).

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A file-wide `toContain` in a test that judges one block passes for states the block never reaches

Two assertions in the same CI-gate test were green against exactly the state they were meant to forbid. `expect(yaml).toContain("exit 0")` searched the WHOLE `.gitlab-ci.yml` and matched a COMMENT, so it held after the job stopped exiting 0. `expect(stdout).toBe("")` was a proxy for "warn is not deny" and is satisfied by emitting nothing at all — the very bug it appeared to guard. The fix is not a tighter string: PARSE the artefact and assert against the parsed UNIT (the job block, the envelope object), which also removes the blank-line truncation trap hand-rolled block extraction carries. Settling proof shape: restore the defect in a COPY and run the old assertion beside the new one on the same file.

**Evidence** — 2026-07-30: restored soft-skip in a `$TMPDIR` copy → new test `expected [0] to deeply equal [3,1]` (catches), old `toContain` body → true/true (GREEN, hole undetected). 5 file-wide assertions found in that one file: 3 narrowed to the parsed job block, 2 deleted as vacuous.

### A test that measures against the LIVE repo pins its defect state and punishes the repair

Three gate tests started the CLI against `REPO_ROOT` and presupposed that the corpus contained at least one broken hard boundary — one even asserted it (`expect(broken).toBeGreaterThan(0)`). When the campaign took the corpus from 21/72 to 72/72, all three went red although nothing was broken: the premise had become permanently false BECAUSE the goal was reached. A gate test needs a SYNTHETIC fixture with a deliberate defect; the live repo is the OBJECT of measurement, never its fixture. Tell-tale: the test reads `cwd`/`REPO_ROOT` instead of an `mkdtemp` directory.

**Evidence** — 2026-08-22 `tests/scripts/auq-audit.test.mjs:172/:183/:192` — two independent wave agents reported them separately as out-of-scope, both with the same diagnosis. Fixed via `fixtureRoot(name, mutate)`. Trap: the CLI counts the corpus via `git ls-files`, and a temp dir is not a repo — the fixture run needs `--file`.

### `vi.restoreAllMocks()` does not clear `vi.fn()` call history from a `vi.mock()` factory

A `vi.fn()` instantiated INSIDE a `vi.mock('node:child_process', factory)` factory keeps accumulating `.mock.calls` across sequential tests in the same file, even with a file-level `afterEach(() => vi.restoreAllMocks())`. Symptom: a test asserting exec call count/args fails only as part of the full suite and passes in isolation (`-t` filter). Fix: an explicit `execFileSync.mockClear()` in a scoped `beforeEach` for the describe blocks that assert on that mock's call history.

**Evidence** — `tests/lib/autopilot/mr-draft.test.mjs` Gap-3 blocks: failed with *"expected [...4] to have a length of 1 but got 4"* in the full file (86 passed/1 failed), passed in isolation (1/1). Root cause confirmed via `-t "Gap 3"`: 4 accumulated calls = 1+2+1. Full file green (87/87) across 3 repeat runs after the fix.

### Prose-presence pin tests are mechanically identifiable — and safely deletable in bulk

Test files that import zero product code, spawn no process, and only `readFileSync` markdown to assert prose presence are structure pins, not tests. The triple filter (no product import + no spawn + fs-only) identifies them mechanically; per-file classification then separates machine contracts (version locksteps, dangling-ref sweeps, placeholder parity — KEEP) from prose pins (DELETE). 43 files / ~600 tests / 5.7k LOC deleted with the full suite green afterward. One trap: mixed-form files (a real structural guard inside a prose-pin file) need individual reading — the diet missed one such guard (psa-007 wiring), caught by the review panel and ported to validate-plugin.

**Evidence** — 2026-07-27 I5/I6: 45 deletions, full gate 12599/0 after; MED-7 review finding on `psa-007-wiring.test.mjs` proves the mixed-form residual risk.

The same pins are also the TAX of every prose→code migration: a test parsing a SKILL.md table or a numbered-list marker goes red the moment that prose is rewritten to cite code. Rewrite it onto the prose→code seam (the CLI is cited, no competing table survives) plus the code's own behaviour; delete pure list-marker pins.

**Evidence** — 2026-09-09 session-4: 5 red after W3 — `tests/skills/session-plan/ultradeep-wave-shape.test.mjs` (4, rewritten onto `resolveSessionShape`), `tests/skills/express-path-write-back.test.mjs` (1, deleted). Full Gate afterwards 17,062/0.

### vitest in-process ERR_MODULE_NOT_FOUND traegt kein `err.url` — Plattform-Pins in einem echten node-Child messen

Ein Test, der die Node-24-Eigenschaft err.url (gesetzt fuer relative Specifier, nicht fuer bare Packages) in-process unter vitest prueft, misst den vite-node-Runner statt der Plattform und ist vakuumgruen/rot. Der CP11-Sibling-Detektor haengt an genau dieser Eigenschaft. Regel: Plattform-Annahmen ueber Modul-Aufloesungsfehler nur per spawnSync(node, ...) pinnen.

**Evidence** — W3-P1 Report 2026-09-07: erster Entwurf in-process → err.url undefined; per node-Child → string; tests/lib/validate/check-owner-leakage.test.mjs § #1260.

### Ein ueberlebender Mutant ist nicht immer eine Testluecke — der mutierte Guard kann unerreichbar sein

Bevor ein Mutation-Testing-Befund als Testluecke behandelt wird, muss die ERREICHBARKEIT des mutierten Zweigs gemessen werden: instrumentiere den Zweig (throw beim Betreten) und fahre eine erschoepfende Eingabematrix. Ist er unerreichbar, ist die Mutation ein equivalent mutant — kein Verhaltenstest kann sie rot faerben, und der Versuch produziert genau die vakuumgruenen Tests, die TV-001 verbietet. Der richtige Ertrag ist dann der Befund am PRODUKTIONSCODE (toter Guard, falscher Docblock), nicht ein neuer Test.

**Evidence** — 2026-09-11, `scripts/lib/session-record-repair.mjs`: qa-strategist meldete, dass das Loeschen von `if (rescued.has(sidecar)) return;` die Suite gruen laesst (reproduziert: 51/51, dann 52/52). Instrumentierte Probe ueber 2.580.480 Eingabekombinationen (alle 6 reparierten Felder + 6 eingabeseitige Sidecars): `guard_reached=0` — beide Zweige pro Feld (`waves` not-array vs renumber, `agent_summary` absent vs field-missing) sind konstruktiv exklusiv, entgegen dem Docblock-Satz "Within ONE pass the Set still gives first-write-wins". Die REALE Regression (Rueckfall auf `sidecar in out`) faerbt dagegen 2 Tests rot.

### Ein Test, der eine Importkette in ein tmp-Repo kopiert, macht die Importliste zum Vertrag

`tests/husky/pre-commit-owner-leakage.test.mjs` kopiert `check-owner-leakage.mjs` + `confidential-names.mjs` + `host-paths.mjs` + `owner-yaml.mjs` einzeln in ein tmp-Repo, damit CP11 dort aktiv wird. Ein NEUER repo-lokaler Import in einem dieser Module ist dann ein stiller Bruch: die Importkette scheitert, CP11 degradiert zu inert, der Commit wird NICHT blockiert — und die einzige rote Assertion ist ein `expected +0 not to be +0` im Husky-Test, weit weg vom Verursacher. Konsequenz fuer geteilte Resolver: das Modul, das eine Funktion BESITZT, muss das Blatt der Importkette sein; die schwereren Konsumenten importieren von dort, nie umgekehrt.

**Evidence** — 2026-09-05 #1223: `resolvePrivateConfigDir` zuerst in `host-identity.mjs` exportiert, `owner-yaml.mjs` importierte es → `tests/husky/pre-commit-owner-leakage.test.mjs` CP11 rot (1 failed | 593 passed ueber 19 Konsumenten-Dateien), obwohl alle direkten Owner-Tests gruen waren. Richtung umgedreht (Resolver in `owner-yaml.mjs` als Blatt, `host-identity` delegiert) → 594 passed / 0 failed.

<!-- untrusted-content:end -->

## Provenance

Dedupe anchors — dropping a pair regenerates that learning as its own file (`docs/rule-authoring.md` § Consolidated rules). By hand 2026-09-06 + 2026-09-09 + 2026-09-11.
- learning-key: `anti-pattern/a-file-wide-tocontain-in-a-test-that-judges-one-block-passes-for-states-the-block-never-reaches`
- learning-id: `1652166b-b67b-4ff3-9ee8-6c2268629cb3`
- learning-key: `anti-pattern/ein-test-der-gegen-das-lebende-repo-misst-pinnt-dessen-defektzustand-und-bestraft-die-reparatur`
- learning-id: `496cc3f2-f0d2-4edd-b618-ecebd7989a48`
- learning-key: `anti-pattern/vi-restoreallmocks-doesn-t-clear-vi-fn-call-history-from-a-vi-mock-factory`
- learning-id: `980150b3-4635-47df-ad55-cf398c017392`
- learning-key: `anti-pattern/prose-presence-pin-tests-mechanically-identifiable-no-product-import-no-spawn-fs-only-and-safely-deletable-in-bulk`
- learning-id: `f46ab2a5-fe55-46ac-a4ca-b73a57b6fc0c`

- learning-key: `recurring-issue/prose-pinning-tests-are-the-tax-of-every-prose-code-migration`
- learning-id: `5bd0d09e-6953-429d-bab8-9077752fed0b`
- learning-key: `convention/vitest-in-process-err-module-not-found-traegt-kein-err-url-plattform-pins-in-einem-echten-node-child-messen`
- learning-id: `lrn-mtrngrpu-4`

- learning-key: `anti-pattern/ein-ueberlebender-mutant-ist-nicht-immer-eine-testluecke-der-mutierte-guard-kann-unerreichbar-sein`
- learning-id: `cd39efb2-4612-46ba-8796-ed1f20414a21`
- learning-key: `anti-pattern/ein-test-der-eine-importkette-in-ein-tmp-repo-kopiert-macht-die-importliste-zum-vertrag`
- learning-id: `4545c87a-5de1-485a-9335-a7454a1fd628`

- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
