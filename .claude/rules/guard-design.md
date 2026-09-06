---
auto-generated: true
consolidated: true
alwaysApply: false
description: "How a guard fails open: self-confirming predicates, bypasses that outlive the matcher they guard, declarations that leak into grants, and censuses that stop at the recognized route."
globs:
  - "hooks/**"
  - "hooks/_lib/**"
  - "scripts/**"
  - "scripts/lib/**"
  - "scripts/lib/validate/**"
  - "tests/_helpers/**"
  - "tests/scripts/**"
  - "tests/scripts/validate/**"
  - "tests/unit/**"
paths:
  - "hooks/**"
  - "hooks/_lib/**"
  - "scripts/**"
  - "scripts/lib/**"
  - "scripts/lib/validate/**"
  - "tests/_helpers/**"
  - "tests/scripts/**"
  - "tests/scripts/validate/**"
  - "tests/unit/**"
learning-key: anti-pattern/ein-peer-record-im-selben-allowedpaths-array-das-per-union-eingesammelt-wird-gewaehrt-statt-zu-markieren
expires-at: 2026-10-04
---

# Guard Design (consolidated)

A guard is judged by its DENY paths, and every rule here records a guard that passed its own tests while permitting the thing it existed to forbid. Two recurring shapes: a check whose predicate is vacuous (it compares a value with itself, or enumerates only the routes it already recognises), and a widening that moved the matcher without moving its bypass.

**`expires-at` is 2026-10-04 — the EARLIEST of the 7 absorbed dates.** A merged file must not outlive its shortest-lived content: a single date covering several learnings expires when the FIRST of them is due for review, never when the last is.

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A declaration and a grant must never share one unfiltered data structure

The `peer-session-<id>` record (#1195) was meant as a pure DECLARATION — it should make the peer VISIBLE, never hand out rights. Because `unionFileScopes()` treated every record in the array alike, the peer record flowed through `--union` straight into `allowedPaths` and thereby GRANTED the peer's paths to every agent in the wave; the peer-write branch in `post-bash-write-verify` became unreachable. Fix: `unionFileScopes()` actively skips peer records, `--assert-disjoint` keeps them, and materialize writes no per-agent file for them.

**Evidence** — 2026-09-02, W4 panel (RV-ARCH, HIGH), commit `2ae28770`. Fix in `scope-gate.mjs` (`PEER_RECORD_PREFIX` as SSOT) + `materialize-wave-scope.mjs`; four red proofs.

### A security fix that follows an unreviewed security fix opens a hole of the same class

When one wave closes a guard gap and the next builds on the same surface with no independent reviewer in between, a new hole of the SAME class is highly likely. The reason is structural: the implementer thinks inside the surface being repaired and does not carry the invariant to the neighbouring branches. The quality gate does NOT catch this — it measures test-green, and the new holes are by construction untested. The countermeasure is a read-only panel on the FULL SESSION diff, not the wave diff, briefed ADVERSARIALLY (refute the hardening), not confirmingly.

**Evidence** — 2026-08-04 deep-1: W3/A3 removed the backslash continuation only in the unquoted branch → `bash -c "git push \<LF>--force"` stayed ALLOW. W3/A4 introduced a once-marker that could be pre-created → two PERMITTED commands silently disabled the guard entirely, and the same `writeFileSync` followed symlinks (arbitrary file truncate). Only the W4 panel found either; the suite was green throughout (13372/0).

### An ownership check that compares the fallback value is self-fulfilling

A reader that first does `if (id === null) id = recordedId` and THEN checks `id === recordedId` has an empty predicate: with a missing or non-UUID-shaped stdin id it compares the just-copied value with itself and always reports "I am the recorded session". The ACTOR identity may fall back; the ownership CLAIM never may — it must be decided from the RAW input value. Otherwise a repo-global artefact like `current-session.json` describes a foreign, still-live peer whose identity and wave completion you adopt.

**Evidence** — 2026-09-02, census `grep -rn "= recordedId;" hooks/ scripts/`: exactly 2 sites, both with the same defect — `hooks/on-session-end.mjs:147` (gated `durationMs`, `semanticSessionId` AND the final `wave.completed`: a live repro in /tmp wrote `last_wave_completed:3` into a PEER's file) and `hooks/on-stop.mjs:284`. Both fake-regressed red: 4 and 1 test respectively.

### Widening a matcher without narrowing its bypass opens a hole the narrow version did not have

When a command matcher is widened from "start of line" to "any statement in the chain", EVERY check hanging off it must get the same scoping — above all the bypass/exemption check. If the bypass stays a boolean over the WHOLE command, one appended exemption statement suffices to lift the gate for a real invocation. The narrow version was immune, because a TRAILING pattern never hit its prefix comparison.

**Evidence** — 2026-08-23, after the #1106 fix: `glab issue create --title REAL; glab issue create --label ci --title junk` measured ALLOW while `glab issue create --title REAL` alone measured DENY — with a pattern live in the policy. Found by the security review panel, reproduced against old and new versions. Fixed by binding the bypass to the statement the create matched on.

### AST provenance guards must census every reference route, not only recognized direct calls

A fail-closed AST guard is incomplete when it validates recognized direct calls but omits other REFERENCES to the protected binding. Build the census from the import origin outward: record the loader import, every alias/member/optional/computed/reference route, and every shadowing binding; accept only the exact direct-call shape. An imported loader with zero proven direct calls must ITSELF be a finding — otherwise an unsupported route disappears as zero contracts and passes green.

**Evidence** — 2026-08-06/07 #1006: independent reviewers reproduced `Reflect.apply(armGuard,…)`, optional/member calls, `class armGuard` shadowing, nested class modules shadowing, symlink handlers and inherited Git selectors. Each initially vanished or acquired false provenance. Focused validator suite 27/27 and validate-plugin 159/0.

### Moving a guard from exit-code signalling to stdout-JSON inverts its failure direction

`exit 2` blocks regardless of what stdout did, so bugs in the payload path were harmless. Under `exit 0` + JSON the payload IS the decision: any malformed, truncated or absent envelope reads as NO-decision and the action proceeds. Every crash, throw and short-circuit path that used to be fail-closed must be re-examined — and allow-assertions in tests stop discriminating, because allow and deny now share an exit code.

**Evidence** — 2026-07-29 #906: three independent agents each found that `expect(code).toBe(0)` had become assert-nothing; the panel then found the pipe-truncation fail-open, a bridge that had lost its second block signal, and 23 residual bare exit-0 assertions in one already-migrated file.

### An exemption marker that only works same-line is visually identical to one in a comment block

`check-untracked-test-deps:ignore` is honoured ONLY on the same line as the flagged call. A marker in the comment block directly above reads exactly like an exemption, changes nothing, and the guard keeps failing — which looks like the GUARD being wrong rather than the marker being misplaced. Three independent occurrences in one session (coordinator, then a fix agent, then a sibling agent). Any marker-based exemption needs its placement rule stated AT the marker, and the inert form is worth PROVING by measurement rather than asserting.

**Evidence** — 2026-08-19, measured on `tests/scripts/site-numbers.test.mjs`: removing the comment-block marker leaves validate-plugin at 172 passed / 0 failed (inert); removing the same-line marker on the `readPackageVersion` call drops it to 171 / 2 (load-bearing).

<!-- untrusted-content:end -->

## Provenance

Consolidated 7 generated rules into this file (2026-09-06, 43→8 rule consolidation).
The reconcile engine dedupes on these markers — removing a pair regenerates that learning as a standalone file.

Frontmatter `learning-key:` is a scalar and duplicates only the FIRST bullet; `defaultReadMaterializedProvenance()` unions frontmatter with body, so every bullet below is load-bearing.
- learning-key: `anti-pattern/ein-peer-record-im-selben-allowedpaths-array-das-per-union-eingesammelt-wird-gewaehrt-statt-zu-markieren`
- learning-id: `c8993344-8cf9-4dc2-9b4a-3cac32afe4ec`
- learning-key: `anti-pattern/ein-sicherheitsfix-der-ungeprueft-auf-einen-sicherheitsfix-folgt-oeffnet-ein-loch-derselben-klasse`
- learning-id: `467042df-c0a5-445a-bf45-f052e5b89192`
- learning-key: `anti-pattern/eine-ownership-pruefung-die-den-fallback-wert-vergleicht-ist-selbsterfuellend`
- learning-id: `7d574cce-303c-4edc-ada6-f572260765bd`
- learning-key: `anti-pattern/einen-matcher-verbreitern-ohne-seinen-bypass-mitzuverengen-oeffnet-ein-loch-das-die-enge-fassung-nicht-hatte`
- learning-id: `97b3532e-6693-4d73-9e92-060b562952ce`
- learning-key: `proven-pattern/ast-provenance-guards-must-census-every-reference-route-not-only-recognized-direct-calls`
- learning-id: `960fd50b-aae5-4595-83c2-c184015c60de`
- learning-key: `proven-pattern/moving-a-guard-from-exit-code-signalling-to-stdout-json-inverts-its-failure-direction-re-verify-every-deny-path-afterwards`
- learning-id: `ed5ad563-dc22-4759-83c3-308afe5e37c8`
- learning-key: `recurring-issue/an-exemption-marker-that-only-works-same-line-is-visually-identical-to-one-in-a-comment-block`
- learning-id: `d86c9b5f-bdd3-4f48-b37e-b5b751e78486`

- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
