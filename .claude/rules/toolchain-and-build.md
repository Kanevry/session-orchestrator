---
auto-generated: true
consolidated: true
alwaysApply: false
description: "npm, husky, NUL bytes and gate wrappers: local verification runs that test a tree other than the one being released."
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
  - "agents/**"
  - "scripts/lib/wave-executor/**"
  - "skills/wave-executor/**"
  - "tests/lib/wave-executor/**"
  - "scripts/lib/ux-grill/**"
learning-key: anti-pattern/a-nul-byte-in-a-tracked-production-file-makes-it-invisible-to-every-grep-based-audit
expires-at: 2026-10-17
---

# Toolchain and Build (consolidated)

**`expires-at` 2026-10-17 = the EARLIEST of the 13 absorbed dates** (merge contract: `docs/rule-authoring.md` § Consolidated rules).

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A NUL byte makes a tracked file invisible to every grep-based audit — and needs a byte-level pre-commit gate

Ein NUL macht Text binaer: Claude Code grep (`ugrep -I`) ueberspringt die Datei still (exit 1), auch einen Security-Hook mit allowlistetem NUL. Fuer solche Audits `grep -a` / `rg --text` nutzen. Steuerzeichen in Fixtures immer escapen (`\0`, `\x00`); literale Sentinels ueberleben vitest/ESLint, der byteweise Pre-Commit-Guard faengt sie.

**Evidence** — 2026-07-29: the deny-path census missed `emitDeny` in `hooks/config-protection.mjs` (1 allowlisted NUL); after the escape-form fix a plain grep finds it at line 502. 2026-07-27 P1: tmp-repo dry-run — the POSIX block exits 1 on a staged corrupt `.mjs`, 0 on clean files; the substitution variant exits 0 on the same corrupt file. Stage 2 of `.husky/pre-commit`, run verbatim by `tests/husky/pre-commit-nul-byte-guard.test.mjs` (4 tests green).

### `npm install` does not refresh `node_modules` when only an `overrides` entry is added

Adding only `overrides` updates the lockfile while npm may keep OLD `node_modules` (`node_modules/.package-lock.json` matches; install dry-run does nothing). Verify with `npm ci` in a throwaway directory. Outside a parent semver range, `npm audit fix` may claim an unchanged fix; use `overrides` there.

**Evidence** — 2026-08-04 deep-1, twice: `fast-uri` 3.1.4 → 3.1.5 (via ajv), `brace-expansion` 5.0.7 → 5.0.9 (via eslint→minimatch); `node_modules` stayed old both times, the second `npm run lint` falsely exit 0. Isolated `npm ci` installed the new versions; CI (`npm ci` on Linux) confirmed both.

### The quality-gate wrapper needs a large output buffer and env isolation

Gate wrappers need a large buffer (`RUN_CHECK_MAX_BUFFER_BYTES = 64 * 1024 * 1024`, `gate-helpers.mjs:13`) and nested-env isolation. `run-quality-gate.mjs:280-287` sets `TYPECHECK_CMD`, `TEST_CMD`, `LINT_CMD`, `FILES`, `SESSION_START_REF`; `runCheck` (`gate-helpers.mjs:58-62`) uses `execSync` without `env`, so nested vitest gates inherit them.

**Evidence** — Only mitigation: per-file `const env = { ...process.env }; delete env.TYPECHECK_CMD;` in exactly 4 files (`tests/scripts/gates/gate-{full,baseline,incremental,per-file}.test.mjs`), enforced by NOTHING: a 5th file omitting it passes under `npx vitest run tests/scripts/gates/` and fails only inside the nested full gate.

### A green quality gate on the development platform is not evidence the tree builds on CI

Pin platform env shape: macOS `TMPDIR` ends in `/`, Linux containers may leave it UNSET; `${TMPDIR}name` then changes destination. Linux also rejects a 200,000-character argv entry with `E2BIG` despite macOS success. Pass a LENGTH, not payload, via argv; reproduce with `env -u TMPDIR`.

**Evidence** — 2026-07-30 pipeline 6819 red on `3a27817` (3 failures) minutes after a local 12855/0; after the fix `env -u TMPDIR npx vitest run tests/hooks/pre-bash-destructive-guard.test.mjs` 75/75, pipeline 6821 green on `81e07dd`.

### Der husky Pre-Push-Gate laeuft die Suite im materialisierten Tree unter `$TMPDIR`

Pre-Push prueft den materialisierten `$TMPDIR`-Tree: `detectSandbox()` meldet korrekt `sandbox:temp-root`; Tests mit `REAL_CWD = process.cwd()` und vererbtem Gate-env (`SO_GATE_LEDGER_ROOT`) koennen nur dort scheitern. Auch dort testen (`git archive HEAD | tar -x -C $T`; `ln -s node_modules`); Gates nennen `failed_files[]`. Vorbedingung: ein Tree AUSSERHALB des Repos hat kein `.git` — fuer `validate-plugin.mjs` dort `git init` + Commit, sonst exit 1 vor allen 230 Pruefungen (2026-09-18 @ `20a4cbff`). Innerhalb des Repos liest derselbe Tree still dessen Eltern-`.git` und meldet 230/0.

**Evidence** — 2026-09-06: `w5-push-origin.log` `failed_files [tests/telemetry/sync.test.mjs]` 2 failed; Repro in `$T/tree` gruen nach Fix `432b1871` (`REAL_CWD = join(os.homedir(),...)`); W4-Q3 HIGH: `SO_GATE_LEDGER_ROOT=$L vitest -t "telemetry emission"` → 8 failed | 1 passed.

### hook-import-set drift blocks every parallel agent via vitest globalSetup

Ein neuer Import in einem hook-erreichbaren Modul laesst `hooks/_lib/hook-import-set.json` driften. Weil validate-plugin vitest-globalSetup ist, blockiert das die Tests ALLER Geschwister vor Worker-Start. Bei erster Eskalation und Wellenende regenerieren oder Importgraph-Aenderungen zuerst allein dispatchen.

**Evidence** — Session `main-2026-09-09-session-4`: 6 agents reported the drift across W2-W4; regenerated 4× (155→157 modules) via `node scripts/generate-hook-import-set.mjs`.

### Ein Zwischenstand mit Vorwaertsreferenz in einem hook-importierten Modul sperrt Bash/Edit host-weit

Hook-importierte Module nie mit undefinierten Vorwaertsreferenzen speichern: ein von `enforce-scope.mjs` geladenes Modul blockiert dann jeden Bash/Edit/Write aller Sessions. `node --check` reicht nicht; zusaetzlich Import-Probe (`node --input-type=module -e "await import(...)"`).

**Evidence** — STATE.md Deviations [2026-09-04T17:14:42.025Z]: ~8 Min. host-weite Sperre; Hotfix via Monitor-Tool, da kein PreToolUse-Matcher existiert; C4/C5/C8 hatten `node --check` + Load-Probe als Auflage und blieben sauber, P6 nicht.

### Ein frischer Worktree ohne `node_modules` laesst lint-staged still scheitern — der Push nimmt den alten HEAD

Frischen Worktree vor lint-staged mit `ln -s ../repo/node_modules` versorgen. Commit-Fehler (eslint ENOENT) nicht per grep-Filter verschlucken: nach jedem Commit `git rev-parse HEAD`, vor Push `git show HEAD:<pfad>` pruefen, sonst geht alter HEAD oder ein spaeteres Edit mit.

**Evidence** — 2026-09-03 session-1: `bca78dae` trug den Bogus-Wert (`git diff bca78dae dc9522dd` = 1 Zeile), Pipelines 8352/8354 liefen auf falschem Inhalt.

### In a linked worktree the gitdir `rev-parse` returns is not the one git reads excludes from

Linked worktrees read `info/exclude` from `--git-common-dir`, not `rev-parse --git-dir`; changing per-worktree excludes is inert, changing shared `.git/info/exclude` violates PSA-003. Filter at query time: `git ls-files --others --exclude-standard --exclude=node_modules`. `git diff` sees only TRACKED files: include untracked enumeration in all-new-file runs.

**Evidence** — 2026-08-25 synthetic repo: `node_modules` in `/tmp/so-wtx-Gd9z/.git/worktrees/wt/info/exclude` → `git -C wt status --porcelain` still `?? node_modules/`; in `/tmp/so-wtx-Gd9z/.git/info/exclude` → empty. `git -C wt diff --name-only` empty for `brand-new.mjs`, `ls-files --others --exclude-standard` lists it. `tests/lib/wave-executor/foreign-dispatch.test.mjs` (33 passed, exit 0).

### `agent-browser eval` serialisiert selbst — `JSON.stringify` im Page-Skript kodiert doppelt

agent-browser 0.37.1 serialisiert `eval`-Completion-Werte bereits als mehrzeiliges JSON. Plain Objekte zurueckgeben, stdout KOMPLETT parsen; `JSON.stringify` im Page-Skript erzeugt einen doppelt kodierten String.

**Evidence** — gemessen 2026-09-12 mit agent-browser 0.37.1: `(() => ({n: window.innerWidth}))()` druckte mehrzeilig `{"n": 1280}`; `(() => JSON.stringify({n:1}))()` den gequoteten String; `document.title` druckte `""` statt einer leeren Zeile.

<!-- untrusted-content:end -->

## Provenance

Dropping a pair re-proposes its learning.
- learning-key: `anti-pattern/a-nul-byte-in-a-tracked-production-file-makes-it-invisible-to-every-grep-based-audit`
- learning-id: `b42c42b9-4422-43f7-94dc-77021268fa86`
- learning-key: `proven-pattern/nul-byte-corruption-needs-a-byte-level-pre-commit-gate-posix-tr-cmp-is-the-only-portable-detector`
- learning-id: `d2783369-b7d7-414c-9ea7-ba1f463ae9f4`  <!-- markers only (substance: enforced — `.husky/pre-commit` stage 2, run verbatim by `tests/husky/pre-commit-nul-byte-guard.test.mjs`) -->
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
- learning-id: `382fb8fd-33ba-41d6-af80-02d065ed98d9`  <!-- markers only (substance: folded into the NUL-byte entry above) -->
- learning-key: `anti-pattern/in-a-linked-worktree-the-gitdir-that-rev-parse-returns-is-not-the-one-git-reads-excludes-from`
- learning-id: `9c6cd166-8798-471a-a952-7694e9a7857b`
- learning-key: `recurring-issue/git-stash-fuer-eine-baseline-ist-die-wiederkehrende-psa-007-form-zwei-vorfaelle-in-einer-session`
- learning-id: `5e0c5809-a713-4b4b-9c96-342d230dee72`  <!-- markers only (substance: `parallel-sessions.md` § PSA-007; the stash-free baseline is `git show HEAD:<file>`) -->
- learning-key: `convention/agent-browser-eval-json-serialisiert-selbst-json-stringify-im-page-skript-kodiert-doppelt`
- learning-id: `227c2261-0c9c-45f6-a8d5-7b67969756e2`
- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
