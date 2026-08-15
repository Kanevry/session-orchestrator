# ADR 0012: Host-Local Pseudonym Map for Owner-Leaky Repo Namespaces

> Status: Accepted · 2026-08-15 · session main-2026-08-15-deep-1 · issue #734a
> Decisions recorded: #725 D5 (pseudonym map consulted at the redaction site) · #660 (per-repo vault namespacing) · #728a (committed-path / host-local-data split)
> Context inherited from: `main-2026-07-02-deep-1` architect-review (refs #725) · rejected alternatives below
> Authoritative implementation: [`scripts/lib/vault-mirror/pseudonym-map.mjs`](../../scripts/lib/vault-mirror/pseudonym-map.mjs) · [`scripts/lib/vault-mirror/namespace.mjs`](../../scripts/lib/vault-mirror/namespace.mjs) · [`scripts/lib/config/host-paths.mjs`](../../scripts/lib/config/host-paths.mjs)
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/\_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

**Why this is an ADR and not a code comment.** This is the decision class a later
simplification quietly breaks. Every element below reads, at its call site, like
incidental defensiveness: the lazy path resolution, the placement of the lookup
*inside* the leak branch, the validation of the *pseudonym* rather than of the
real name, the WARN that names a pattern but never a value. Each one is
load-bearing for a property — **a real repo name never reaches a commit** — that
no test can observe directly, because the failure is a leak into an artefact the
test does not inspect. A green suite is compatible with the leak. An ADR is the
only place where "this looks removable, and is not" survives the next reader.

## Context

### What the namespace layer does, and what redaction cost it

`vault-mirror` writes machine-generated notes into the operator's Meta-Vault
under a per-repo namespace — `40-learnings/<repoNs>/`, `50-sessions/<repoNs>/`
(#660). `resolveRepoNamespace()` derives `<repoNs>` from the git origin (or an
explicit `vault-name`) and sanitises it to a kebab slug.

That slug is then leak-guarded. `isOwnerLeakySegment()`
(`scripts/lib/validate/check-owner-leakage.mjs`) rejects identifiers matching the
owner-privacy patterns — CP1 (a personal home path), CP6 (a private project
slug), CP10 (a personal name in a Projects path). Before #725 D5, every leaky
identifier collapsed to the single literal `redacted-repo`.

That is correct on privacy and wrong on everything else:

1. **Write-isolation collapses.** All owner-leaky repos on the host share ONE
   `redacted-repo/` subdirectory. #660 exists precisely to stop id/slug
   collisions *between* repos; N private repos in one namespace reinstates them,
   so two repos can emit the same learning slug and silently overwrite each
   other.
2. **Cross-repo attribution is destroyed.** A learning mirrored from private
   repo A and one from private repo B become indistinguishable. The vault can no
   longer answer "which repo did this come from" for the private half of the
   fleet — which is the question the whole cross-repo corpus exists to answer.

Two obvious repairs are unacceptable and are worth naming here, because both
look reasonable in review:

- *Write the real name and gitignore the vault.* The vault is a separate git
  repo the operator **does** commit. "It is not committed *here*" is a statement
  about this repo, not a privacy property.
- *Hash the real slug.* Restores isolation, destroys readability. The operator
  can no longer navigate their own vault, and an unreadable namespace is a worse
  artefact than a merged one.

### A second fact this ADR arrived carrying (the numbering collision)

This document was commissioned as `0011-pseudonym-map-privacy.md`. `0011` was
already taken by [`0011-guard-degradation-semantics.md`](0011-guard-degradation-semantics.md)
(#997, 2026-08-05). The number had been **transcribed by hand into the wave
plan** rather than derived from `ls docs/adr/`, so the plan and the directory
each held a claim on `0011` and disagreed. The scope guard caught it — the
implementing agent's write of `0012-…` was refused against an allowlist still
pinned to `0011-…`, which surfaced the conflict *before* a duplicate-numbered
ADR reached disk. The coordinator re-derived the wave scope; this file is the
result.

It is recorded here rather than in a session log because it is the same failure
shape the decisions below are built against: **a fact that must have exactly one
source, maintained in two places.** There, the next free ADR number — derivable
in one command, transcribed instead. Below, the mapping from a real repo name to
its pseudonym — which D1 confines to exactly one host-local file for the same
reason, and which would rot identically if a "convenience copy" were ever
committed alongside it.

## Decision

A **host-local pseudonym map** assigns each owner-leaky repo identifier a stable,
non-leaky pseudonym. Four invariants define it.

### D1 — Real names live outside every repo; only the PATH is committed

The map is a JSON object of `{"<real-slug>": "<pseudonym>"}`, located by
`owner.yaml`'s `paths.namespace-map-path` (env `SO_NAMESPACE_MAP` overrides),
resolved through `scripts/lib/config/host-paths.mjs`. `owner.yaml` itself lives
at `~/.config/session-orchestrator/owner.yaml` — per-user, per-machine, appended
to `~/.gitignore` on first run, never inside any repo.

This is the same committed-path / host-local-data split as
`paths.confidential-names-file` (#728a) and the Owner Persona Layer generally
(`.claude/rules/owner-persona.md`): **the repo may commit where to look, never
what is found there.** What that buys is not "we remembered to gitignore it" but
a structural claim — there is no workflow, correct or misconfigured, under which
the file sits inside a repo working tree at all. The map is therefore invisible
to `git add`, to a worktree copy, and to any `tar`/rsync backup rooted at a repo.

*Do not simplify by* moving the map into the repo behind a `.gitignore` entry. A
gitignored in-repo file is one `git add -f`, one worktree copy, or one
repo-rooted backup away from a commit. A file outside every repo is not.

### D2 — The map is consulted ONLY at the redaction site, and clean repos pay zero I/O

`resolveRepoNamespace()` evaluates `isOwnerLeakySegment()` first and reaches for
the map **only when the identifier is leaky** — inside the leak branch, never
before it. The map path itself is resolved lazily and cached per process
(`currentMapPath()`); the parsed map is cached inside `pseudonym-map.mjs`.

This is a **cost decision, not a stylistic one**, and it must be read as such:

- **A clean repo performs zero additional filesystem I/O.** It never resolves the
  map path, never reads `owner.yaml` for this feature, never opens the map file.
  Its behaviour is byte-identical to pre-#725. `resolveRepoNamespace` is called
  **once per mirrored record**, so hoisting the lookup out of the leak branch
  would put an `owner.yaml` read plus a map read on the hot path of every
  learning and every session note — on the ~99% of hosts that have no map
  configured at all, to change nothing.
- **The map cannot rename a clean repo.** Because it is reachable only through
  the leak branch, a map entry keyed on a non-leaky repo is inert. The map is a
  *redaction refinement*, never a general aliasing mechanism — which is what
  keeps `<repoNs>` for public repos derivable from the git origin alone, with no
  host-local input.

*Do not simplify by* hoisting the lookup to the top of `resolveRepoNamespace()`
"for symmetry" or "to simplify the branch". That silently converts the map into a
global rename table **and** moves fs I/O onto the common path — two regressions,
neither visible in a diff that only moves three lines upward.

### D3 — The PSEUDONYM is validated, not the real name

`loadPseudonymMap()` validates every map **value**: it must be a
filesystem-safe kebab slug (`isValidSlug`) **and** must not itself be owner-leaky
(`isOwnerLeakySegment`). Entries failing either check are dropped with one
aggregate WARN; survivors are cached per process, keyed by map path.

The direction is the entire point, and it inverts the intuition:

| | Role | Validated? |
|---|---|---|
| map **key** (real slug) | input to be *replaced*; never leaves the host | no |
| map **value** (pseudonym) | output *written into the vault*, which may be committed there | full leak-guard |

An operator who writes `{"my-private-thing": "/Users/<name>/x"}` has configured a
leak. Validating the value catches it; validating the key would catch nothing,
since a leaky key is exactly the expected case.

*Do not simplify by* trusting map values because "the operator wrote them
themselves". The operator's own naming **is** the leak source — that is the
premise of the entire owner-privacy rule set (`.claude/rules/owner-persona.md`,
`.claude/rules/security.md` § Owner-Privacy Pre-Commit Hook).

### D4 — Unmapped leaky identifiers still fall back to `redacted-repo`, and the WARN names no value

No map configured, map missing, unreadable, malformed, or simply carrying no
entry for this repo → the pre-#725 behaviour exactly: one stderr WARN naming the
matched pattern, and the namespace `redacted-repo`. The feature is strictly
additive; its absence degrades to the safe old state, **never to the real name**.

The WARN carries the matched *pattern id* (CP1/CP6/CP10) and, for map-loading
failures, the map *path* — the operator's own config path, on the operator's own
terminal. It carries **no real slug and no rejected pseudonym value**. Printing
the offending value to help the operator debug would emit the exact string the
layer exists to suppress, into a terminal whose contents are routinely pasted
into issues, MR descriptions and CI logs. This mirrors the CP11 redaction rule in
`.claude/rules/owner-persona.md`: a hit reports *that* there was a hit, not what
it was.

*Do not simplify by* appending the offending value to the WARN "for
debuggability". That is the leak, re-introduced through the diagnostic channel —
the one channel nobody threat-models.

## Consequences

**Gained.** Owner-leaky repos regain per-repo write isolation (#660) and stable
cross-repo attribution, with no real name reaching the vault. Pseudonyms are
stable across sessions, and across hosts that share the map file, so vault
history stays coherent over time.

**Accepted cost — the map is not portable.** The vault contains pseudonyms; only
a host holding the map can resolve them back to real repos. That is the trade
the design buys, not an oversight: a portable mapping is a committed mapping, and
a committed mapping is the thing D1 forbids.

**Accepted cost — no rotation story.** Changing a pseudonym orphans every note
already written under the old one. Re-namespacing existing vault content is
`scripts/lib/vault-relocation-rules.mjs`'s job and is deliberately **not** wired
to map edits — an automatic rewrite triggered by a config edit is a bulk vault
mutation with no review step. Treat a pseudonym as append-only in practice.

**Failure mode to watch.** A silently-dropped map entry (D3 validation) is
indistinguishable, from the outside, from "no entry configured": the repo lands
in `redacted-repo` alongside the genuinely unmapped ones. The aggregate WARN is
the only signal, and by D4 it names no value. An operator debugging "why is my
repo still redacted" must check their own map file against `isValidSlug` and
`isOwnerLeakySegment` themselves. This is a deliberate diagnosability-for-privacy
trade; if it ever needs improving, the fix is a **local** `--explain` command
that reads the map and prints on the operator's terminal only, never a richer
WARN.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Commit the map in-repo, gitignored | One `git add -f`, worktree copy, or repo-rooted backup from a commit. D1 removes the file from every repo tree instead of trusting a rule to hold. |
| Hash the real slug, no map at all | Restores write-isolation, destroys readability — the operator cannot navigate their own vault. |
| Consult the map for every repo, not only leaky ones | Turns a redaction refinement into a global rename table, **and** puts an `owner.yaml` + map read on the per-record hot path for a feature ~99% of hosts have not configured (D2). |
| Trust operator-supplied pseudonyms unvalidated | The operator's own naming is the leak source; an unvalidated value writes a real path into the vault (D3). |
| Drop the namespace leak-guard, rely on the pre-commit scanner | `check-owner-leakage.mjs` enumerates `git ls-files` in **this** repo. The vault is a different repo — the scanner cannot see the artefact at all. |

## Cross-references

- Implementation: `scripts/lib/vault-mirror/pseudonym-map.mjs` (load + validate + per-path cache) · `scripts/lib/vault-mirror/namespace.mjs` (redaction-site lookup, lazy path, `_setNamespaceMapPath` test seam) · `scripts/lib/config/host-paths.mjs` (env > `owner.yaml` > unset precedence).
- Tests: `tests/lib/vault-mirror/namespace.test.mjs` · `tests/lib/vault-mirror/pseudonym-map.test.mjs`.
- Rules: `.claude/rules/owner-persona.md` (host-local-data contract, CP11 redaction) · `.claude/rules/security.md` § Owner-Privacy Pre-Commit Hook (#494) and § SEC-021.
- Issues: #725 (Epic, D5) · #660 (per-repo vault namespacing) · #728a (`confidential-names-file`, same committed-path split) · #734 (this ADR, plus the cycle break and the `atomicWriteWithBackup` primitive shipped alongside it).
