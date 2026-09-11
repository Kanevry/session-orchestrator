---
auto-generated: true
consolidated: true
alwaysApply: false
description: "npm, husky, NUL bytes and gate wrappers: local verification runs that test a tree other than the one being released."
globs:
  - ".husky/**"
  - "hooks/**"
  - "package-lock.json"
  - "package.json"
  - "scripts/lib/gates/**"
  - "tests/fixtures/**"
  - "tests/hooks/**"
  - "tests/husky/**"
  - "tests/lib/**"
  - "tests/scripts/gates/**"
  - "tests/telemetry/**"
  - "scripts/**"
  - "hooks/_lib/**"
  - "tests/setup/**"
  - "skills/wave-executor/references/**"
  - "scripts/lib/session-identity/**"
  - ".lintstagedrc.mjs"
paths:
  - ".husky/**"
  - "hooks/**"
  - "package-lock.json"
  - "package.json"
  - "scripts/lib/gates/**"
  - "tests/fixtures/**"
  - "tests/hooks/**"
  - "tests/husky/**"
  - "tests/lib/**"
  - "tests/scripts/gates/**"
  - "tests/telemetry/**"
  - "scripts/**"
  - "hooks/_lib/**"
  - "tests/setup/**"
  - "skills/wave-executor/references/**"
  - "scripts/lib/session-identity/**"
  - ".lintstagedrc.mjs"
learning-key: anti-pattern/a-nul-byte-in-a-tracked-production-file-makes-it-invisible-to-every-grep-based-audit
expires-at: 2026-10-01
---

# Toolchain and Build (consolidated)

The unifying failure: the local toolchain reported green over an artefact that was not the artefact under test — a stale `node_modules`, a file grep never read, an env var inherited from the outer gate.

**`expires-at` 2026-10-01 = the EARLIEST of the 10 absorbed dates** (merge contract: `docs/rule-authoring.md` § Consolidated rules).

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A NUL byte makes a tracked file invisible to every grep-based audit — and needs a byte-level pre-commit gate

*(This H3 merges two learnings — the audit blind spot and its detector — because neither is actionable without the other.)*

**The blind spot.** Claude Code grep (`ugrep -I`) skips binary files SILENTLY — exit 1, no output, no warning — and ONE NUL byte is enough to classify a text file as binary. A deliberate, allowlisted NUL in a security hook therefore removes that hook from every audit that greps rather than reads. Allowlisting a NUL must weigh this second-order cost, not just the commit-guard bypass. Use `grep -a` / `rg --text` for any distributional claim over a directory containing one.

**The detector.** NUL bytes written into a source file survive BOTH vitest and eslint, so the only cheap mechanical catch is a byte-level gate over staged text files. The detector must be `LC_ALL=C tr -d '\000' < f | cmp -s - f`: `grep -P` is GNU-only, `$'\x00'` is a bashism `dash` cannot parse, and — worst — `grep -q "$(printf '\000')"` silently matches EVERYTHING because command substitution strips NUL, degrading the gate to a no-op that still exits 0.

**Evidence** — 2026-07-29: the session-start deny-path census missed the `emitDeny` call in `hooks/config-protection.mjs` entirely; the file carried 1 allowlisted NUL. After replacing it with the escape form, a plain grep finds the call at line 502. 2026-07-27 P1: extracted-block dry-run in a tmp git repo — the real POSIX block exits 1 on a staged corrupt `.mjs` and 0 on clean files; the command-substitution variant exits 0 on the SAME corrupt file (fake-regression proof). Wired as stage 2 of `.husky/pre-commit`, executed verbatim by `tests/husky/pre-commit-nul-byte-guard.test.mjs` (4 tests green).

### `npm install` does not refresh `node_modules` when only an `overrides` entry is added

A new `overrides` entry in `package.json` changes the lockfile, but npm considers the existing `node_modules` tree current (`node_modules/.package-lock.json` matches structurally) and does NOT reinstall. `npm install --dry-run` accordingly proposes nothing. Every local test/lint run afterwards checks the OLD version and reports green — a worthless verification that looks like a real one. The only sound local proof is `npm ci` in a throwaway directory with exactly this lockfile. Second finding: `npm audit fix` often claims a fix for transitive deps and returns the vulnerability unchanged in dry-run when the fixed version lies outside the parent's semver range — there an `overrides` entry is the only route.

**Evidence** — 2026-08-04 deep-1, twice independently: `fast-uri` 3.1.4 → 3.1.5 (via ajv) and `brace-expansion` 5.0.7 → 5.0.9 (via eslint→minimatch). Both times `node_modules` stayed on the old version; the second time `npm run lint` afterwards falsely reported exit 0. An isolated `npm ci` installed the new version each time; CI (`npm ci` on Linux) confirmed both.

### The quality-gate wrapper needs a large output buffer and env isolation

Full-gate wrapper tests can fail for HARNESS reasons: verbose `npm test` output exceeding the default `execSync` buffer, or outer gate environment variables leaking into nested gate runs. The buffer half is fixed structurally (`RUN_CHECK_MAX_BUFFER_BYTES = 64 * 1024 * 1024`, `gate-helpers.mjs:13`), but the ENV half is a LIVE hazard and carries this rule on its own: `scripts/run-quality-gate.mjs:280-287` builds the child env with `TYPECHECK_CMD`, `TEST_CMD`, `LINT_CMD`, `FILES` and `SESSION_START_REF` all set, and `runCheck` (`scripts/lib/gates/gate-helpers.mjs:58-62`) calls `execSync` with NO `env` option — so the gate's own environment is inherited by `npm test` → vitest → the gate tests.

**Evidence** — The only mitigation is per-file boilerplate (`const env = { ...process.env }; delete env.TYPECHECK_CMD;`), present in exactly 4 files (`tests/scripts/gates/gate-{full,baseline,incremental,per-file}.test.mjs`) and enforced by NOTHING: a 5th gate test file that omits it passes under a bare `npx vitest run tests/scripts/gates/` and fails only inside the nested full gate.

### A green quality gate on the development platform is not evidence the tree builds on CI

CLAUDE.md's "CI status is the source of truth" has two concrete macOS-only shapes, invisible on macOS by construction: (1) `process.env.TMPDIR` carries a TRAILING SLASH on macOS and is UNSET in a Linux container, so `${TMPDIR}name` lands inside the temp root on one platform and outside it on the other — the guard was correct on both, only the test inherited the ambient value; (2) a 200,000-character argv entry fits under macOS `ARG_MAX` and dies with `spawnSync E2BIG` on Linux. PIN the environment shape a case means instead of inheriting it, pass a LENGTH the child expands rather than a payload through argv, and reproduce CI locally with `env -u TMPDIR`.

**Evidence** — 2026-07-30 pipeline 6819 red on `3a27817` with 3 failures while the local gate had reported 12855/0 minutes earlier; after the fix, `env -u TMPDIR npx vitest run tests/hooks/pre-bash-destructive-guard.test.mjs` reproduces the CI environment locally and passes 75/75, pipeline 6821 green on `81e07dd`.

### Der husky Pre-Push-Gate laeuft die Suite im materialisierten Tree unter `$TMPDIR`

`detectSandbox()` sagt dort korrekt `sandbox:temp-root`; zwei Tests in `tests/telemetry/sync.test.mjs` ("real operator shape", `REAL_CWD = process.cwd()`) blockierten jeden Push, waehrend `npx vitest run` im Checkout gruen war. Dieselbe Klasse machte in W4 ein env-Seam (`SO_GATE_LEDGER_ROOT`) sichtbar: der Gate vererbt sein env an die eigenen vitest-Kinder. Regel: umgebungsabhaengige Tests zusaetzlich im materialisierten Tree pruefen (`git archive HEAD | tar -x -C $T`; `ln -s node_modules`) — und Gates nennen die rote Datei (`failed_files[]`).

**Evidence** — 2026-09-06: `w5-push-origin.log` `failed_files [tests/telemetry/sync.test.mjs]` 2 failed; Repro in `$T/tree` gruen nach Fix `432b1871` (`REAL_CWD = join(os.homedir(),...)`); W4-Q3 HIGH: `SO_GATE_LEDGER_ROOT=$L vitest -t "telemetry emission"` → 8 failed | 1 passed.

### hook-import-set drift blocks every parallel agent via vitest globalSetup

When several agents edit hook-reachable modules in one wave, `hooks/_lib/hook-import-set.json` drifts the moment ONE agent adds an import; `validate-plugin` is vitest's globalSetup, so every sibling's `npx vitest run <file>` aborts before workers start. Agents then verify via a `/tmp` vitest config without globalSetup. Coordinator remedy: regenerate the import set mid-wave on the first escalation and again at wave end; better: dispatch hook-graph-changing agents first, alone.

**Evidence** — Session `main-2026-09-09-session-4`: drift reported by C1 (W2), FA/FD/FB/P5/P7 (W3/W4); regenerated 4× (155→156→157 modules). Each report cited `node scripts/generate-hook-import-set.mjs --check` → "committed set differs from a fresh crawl".

### Ein Zwischenstand mit Vorwaertsreferenz in einem hook-importierten Modul sperrt Bash/Edit host-weit

Ein Modul, das ein Live-Hook auf JEDEM Edit/Write importiert (hier `own-session.mjs`, geladen von `hooks/enforce-scope.mjs`), darf nie in einem Zwischenstand gespeichert werden, in dem es auf noch undefinierte Bezeichner verweist. W3-P6 stellte `classifyManifestSession()` auf `manifestSessionBinding`/`MANIFEST_SESSION_KEYS` um und speicherte, bevor beide definiert waren; jeder Bash- und Edit-Aufruf JEDER Session in dieser Arbeitskopie warf danach `ReferenceError`, auch der des Koordinators selbst. `node --check` faengt das nicht (syntaktisch gueltig), nur eine echte Import-Probe (`node --input-type=module -e "await import(...)"`) deckt einen ReferenceError zur Ladezeit auf. Die einzige verfuegbare Reparaturschiene war das Monitor-Tool, weil PreToolUse selbst blockiert war.

**Evidence** — STATE.md Deviations [2026-09-04T17:14:42.025Z]: ~8 Min. host-weite Sperre; `scripts/lib/session-identity/own-session.mjs` importiert von `hooks/enforce-scope.mjs` (jeder Edit/Write); Hotfix ueber das Monitor-Tool, da kein PreToolUse-Matcher existiert; C4/C5/C8 hatten `node --check` + Load-Probe als Auflage und blieben sauber, P6 nicht.

### Ein frischer Worktree ohne `node_modules` laesst lint-staged still scheitern — der Push nimmt den alten HEAD

`git commit` im Wegwerf-Worktree scheiterte in husky/lint-staged an eslint ENOENT, ein grep-Filter verschluckte die Meldung, und der Push schob den unveraenderten HEAD als Beweis hoch; ein Edit VOR dem gescheiterten Commit blieb im Baum und landete im nachgeholten Commit. Regel: `ln -s ../repo/node_modules`, nach jedem Commit `git rev-parse HEAD`, vor dem Push `git show HEAD:<pfad>`.

**Evidence** — 2026-09-03 session-1: `bca78dae` trug den Bogus-Wert (`git diff bca78dae dc9522dd` = 1 Zeile), Pipelines 8352/8354 liefen auf falschem Inhalt.

### Ein literales Steuerzeichen im Test-Sentinel landet als NUL-Byte — vitest und eslint sehen es nicht, nur der Pre-Commit-Guard

Ein Test-Sentinel, der ein Steuerzeichen literal statt als Escape-Sequenz im Quelltext traegt, kann zu einem echten NUL-Byte (0x00) im committeten Text werden — Vitest fuehrt den Test trotzdem aus, ESLint meldet nichts, und erst der Pre-Commit-NUL-Guard blockt den Commit. Steuerzeichen in Test-Fixtures gehoeren immer als Escape-Schreibweise (\0, \x00) in den Quelltext, nie literal.

**Evidence** — 2026-09-02, W4 (Commit 2ae28770): 'ein Test-Sentinel mit zwei literalen NUL-Bytes (vom Pre-Commit-NUL-Guard gefangen, von Vitest und ESLint nicht) auf die Escape-Schreibweise umgestellt' (Koordinator-Fix, Full Gate 15869/0 danach unveraendert gruen).

<!-- untrusted-content:end -->

## Provenance

Dedupe anchors — dropping a pair regenerates that learning as its own file (`docs/rule-authoring.md` § Consolidated rules). By hand 2026-09-06 + 2026-09-09 + 2026-09-11.
- learning-key: `anti-pattern/a-nul-byte-in-a-tracked-production-file-makes-it-invisible-to-every-grep-based-audit`
- learning-id: `b42c42b9-4422-43f7-94dc-77021268fa86`
- learning-key: `proven-pattern/nul-byte-corruption-needs-a-byte-level-pre-commit-gate-posix-tr-cmp-is-the-only-portable-detector`
- learning-id: `d2783369-b7d7-414c-9ea7-ba1f463ae9f4`
- learning-key: `anti-pattern/npm-install-aktualisiert-node-modules-nicht-wenn-nur-ein-overrides-eintrag-dazukommt-der-lokale-verifikationslauf-testet-dann-die-alte-version`
- learning-id: `5413d1f3-a492-4127-abbf-1c73254ccba4`
- learning-key: `fragile-file/quality-gate-wrapper-needs-large-output-buffer-and-env-isolation`
- learning-id: `70c9c7b7-d8f3-4363-b170-0b8973d52df3`
- learning-key: `anti-pattern/a-green-quality-gate-on-the-development-platform-is-not-evidence-the-tree-builds-on-ci`
- learning-id: `79734024-70ac-4a3b-8c18-a79d8d44dc92`

- learning-key: `anti-pattern/der-husky-pre-push-gate-laeuft-die-suite-im-materialisierten-tree-unter-tmpdir-tests-die-process-cwd-als-echten-checkout-nehmen-sind-unter-dem-hook-rot-und-im-checkout-gruen`
- learning-id: `af06cd79-e9d0-4d84-9bf3-d4aaf9d9fe3d`
- learning-key: `anti-pattern/hook-import-set-drift-blocks-every-parallel-agent-via-vitest-globalsetup`
- learning-id: `20580fc8-f5b4-4797-bf08-212eade59e67`
- learning-key: `anti-pattern/zwischenstand-mit-vorwaertsreferenz-in-hook-importiertem-modul-sperrt-bash-edit-host-weit`
- learning-id: `31c5c269-e284-4310-9f02-2efb1a462164`

- learning-key: `anti-pattern/ein-frischer-git-worktree-ohne-node-modules-laesst-lint-staged-still-scheitern-der-push-nimmt-den-alten-head`
- learning-id: `ein-frischer-git-worktree-ohne-node-modules-laesst-lint-staged-still-scheitern-der-push-ni-2026-09-04`
- learning-key: `anti-pattern/ein-literales-steuerzeichen-im-test-sentinel-landet-als-nul-byte-vitest-und-eslint-sehen-es-nicht-nur-der-pre-commit-guard`
- learning-id: `382fb8fd-33ba-41d6-af80-02d065ed98d9`

- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
