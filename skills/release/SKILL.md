---
name: release
description: Cut a release — the order the steps must run in, and the criteria that abort a release
user-invocable: true
disable-model-invocation: true
argument-hint: "[X.Y.Z]"
model: inherit
---
# Release

The user wants to cut a release of this package. Optional argument — the target version: **$ARGUMENTS**.

**The mechanism is `scripts/release.mjs`.** It exists, it is executable, and its pure half is unit-tested (`tests/scripts/release.test.mjs`). This skill carries only the two things the script cannot carry: the **order**, and the **criteria that stop a release**. Do not restate the script's internals here — `node scripts/release.mjs --help` and the file header are the reference.

## Invocation

`$ARGUMENTS` is optional and holds the target version `X.Y.Z`. When it is empty, resolve the target from `package.json` and the CHANGELOG before step 2.

The flags this repo's release path uses — the operator-facing entry points, in the order they run:

- `node scripts/release.mjs --set-version X.Y.Z` — rewrite every version surface and sync `package-lock.json`.
- `node scripts/snapshot-probe.mjs --host win-wsl --json` — under `mirror: curated`, run the suite on the exported tree of the release commit before anything is pushed; `--check` requires its receipt.
- `node scripts/release.mjs --check --json` — the preflight gate; every row must be green.
- `node scripts/release.mjs --publish` — the irreversible step; start it in the background, never under a `timeout` wrapper (step 9).

`--skip-ci` marks the CI row green without checking anything and is **refused by the script** when combined with `--publish`; it is an inspection aid for `--check`, never a release path.

## Why the order is written down

`3.18.0` has a git tag, a GitHub release and a CHANGELOG entry — and the npm registry never saw it; a checklist line is not a mechanism.

Verify it yourself before trusting the paragraph above:

```bash
npm view session-orchestrator versions --json          # read 2026-08-19: 3.16.0, 3.17.0, 3.19.0, 3.20.0 — no 3.18.0
git for-each-ref --format='%(refname:short) %(creatordate:short)' refs/tags
gh release list --repo Kanevry/session-orchestrator --limit 12
```

The same reading shows the other half: the GitHub releases for 3.15/3.18/3.19/3.20 were all created on 2026-08-19 within a three-second window — 5 to 31 days after their tags. Every step that lives only in prose gets skipped and backfilled later.

## The order

1. **Preconditions.** Working tree clean, on `main`, `origin/main` level with `HEAD`, and the GitHub mirror current. The mirror is checked because the site deploy hangs off `github`, not `origin`. What "current" means follows Session Config `mirror` (`--check` row `github-mirror-mode` names it): under `mirror: github` (or unset), `github/main` equals `HEAD`; under `mirror: curated` (#1645), GitHub never receives `HEAD` — `github/main` is a squash snapshot whose `Source-Commit:` trailer must name `HEAD` (publish it with `/close` on `main`, session-end § 4.4). `docs/github-mirror-protection.md` § Releases under `mirror: curated`.
2. **Set the version.** `node scripts/release.mjs --set-version X.Y.Z` — rewrites every version surface, syncs `package-lock.json`, re-stamps the measured census on the site.
3. **Write the editorial half.** The dated `## [X.Y.Z] - YYYY-MM-DD` CHANGELOG entry, `[Unreleased]` folded, README highlights. The script does not write these; `--check` enforces them.
4. **Gate, commit.** Full quality gate, then commit. Do not push yet.
5. **Probe the export (under `mirror: curated`), before the push.** `node scripts/snapshot-probe.mjs --host win-wsl --json` — builds the curated tree of `HEAD` (the release commit), runs validate-plugin on it locally and the full suite on it remotely (the pre-push router's gate on that host). It needs no remote and no pushed commit. Run it here, not after the push: 5.13.0 found three blockers only after its first curated push (#1712), when the release commit was already on `main`, and the fixes took two more MRs (!223, !224). A red probe here is fixed before anything leaves this machine.
   - **Host:** `win-wsl` is where the 5.13.0 red-proof and the green probe ran (#1712); the m5 gate timed out during that release. A host that is unknown, not ready or falls back exits 2 and writes no receipt. If win-wsl is asleep, run `node scripts/snapshot-probe.mjs --host m5-remote --json` only while the offload banner shows m5 without load. `--local` only with the owner's explicit consent: full suites do not run on the M4.
   - **Receipt:** only a run with a suite step writes one, at `.orchestrator/tmp/snapshot-probe/<tree>.json`. It is keyed by the snapshot **tree**: a commit that changes only excluded files keeps it valid; any change to a public file, a test or the export policy invalidates it. `--check` row `snapshot-probe` reads it and never runs the suite itself.
6. **Push** to **both** remotes — under `mirror: curated` the second "push" is the curated snapshot from `/close`, never a plain push of `main` (session-end § 4.4 refuses it).
7. **CI green — on the commit that will be published, on BOTH platforms.** Not on its predecessor: a green pipeline from before step 4's commit is evidence about a different tree. And not on GitLab alone — `--check` carries two CI rows, `ci-green-on-head` (GitLab, via `origin`) and `ci-green-on-head-github` (the mirror). The GitLab pipeline is Linux-only; the **macOS** matrix leg exists solely in `.github/workflows/test.yml`, i.e. on the operator's own platform. The github row self-disables (`skipped — no github remote`) in a checkout without a mirror, and fails on `unknown`/`degraded` exactly like the GitLab one — "could not read the mirror" is not "the mirror is green".
8. **Preflight.** `node scripts/release.mjs --check --json` — every row green. Run this after the release commit is pushed and its CI succeeds: the preflight requires a clean working tree, HEAD parity on both remotes (on GitHub under `mirror: curated`: the snapshot's `Source-Commit` trailer, row `head-pushed-github`) and green CI on that commit (on GitHub under `mirror: curated`: on the snapshot). It derives its target from `package.json`, so checking the pre-bump version instead produces registry- and tag-collision failures.
9. **Publish.** `node scripts/release.mjs --publish` — **start it in the background and do not wrap it in `timeout`.** No fixed number of seconds is enough: each `git push` of the tail re-runs the husky pre-push full gate (up to ~8 min per push under load), plus up to 120 s of live-site polling. The script sets no spawn timeout on purpose (a kill mid-`npm publish` or mid-push is the very failure the receipt boundary exists to avoid). For 5.13.0 a `timeout 580` killed the tail after the receipt: npm had the version, the tag was local only, no GitHub release (#1753).

   Once the receipt is target-confirmed the script prints `publish tail running for … (npm accepted it)`, defers SIGTERM, SIGINT and SIGHUP, and starts every further child in its own process group. GNU `timeout` signals the whole group, so without that a handler alone kept node alive while the `git push` child still died (measured 2026-10-24). Exit 124 from a `timeout` wrapper says nothing about the tail; read the outcome lines instead. Deferred signals are listed there as `deferred <SIGNAL> at <iso>; the tail ran to its end`. `kill -KILL <pid>` and `timeout -k` still kill it, and the tail then stops wherever it is (see § Tail interrupted). Claude Code 2.1.310 does not signal a Bash command at its tool timeout; it moves the command to the background (measured 2026-10-24).

   The target-confirmed npm receipt is the irreversible boundary. Before that receipt, any failure aborts normally. After it, never rerun `--publish`: the script writes the publish proof `.orchestrator/runtime/release-<target>.json` (checked archive sha256 + sha512 integrity, receipt time, commit, tag), and a registry availability timeout/query/wait failure is reconciliation while the script still tags, pushes `main` + tag to both remotes (under `mirror: curated`: `main` + tag to `origin`, the verified snapshot + a tag on that snapshot to `github`), handles the GitHub release, and polls the live site. If tag/push fails after the receipt, the dependent GitHub-release and site steps are skipped and the script returns structured reconciliation guidance instead. Add the GitHub release for the new tag (`gh release create`) as part of this step, not "later" — "later" is what produced the three-second backfill above.

Steps 2–9 are one continuous act. A release left parked between step 6 and step 9 is exactly the `3.18.0` state: every surface says released, the registry disagrees.

## Abort criteria

**Before a target-confirmed npm publish receipt:** stop and report. Do not work around, do not "fix it after the publish" — an npm publish is not revocable.

| Signal | Why it stops the release |
|---|---|
| Any red row in `--check` | The preflight is the gate. A red row is a fact about this tree, not a formality. |
| `github/main` behind `origin/main` or `HEAD` (under `mirror: curated`: its `Source-Commit` trailer is not `HEAD`, or it carries none) | The mirror carries the site deploy and the GitHub release. Publishing over a lagging mirror is how the site falls a release behind. |
| `github-push-url` red: the push URL of `github` differs from its fetch URL (`pushurl`/`pushInsteadOf`, e.g. the #1631 push lock) | Every github check reads the fetch URL; the push would go elsewhere. The publish tail refuses it too, but only after npm publish — unrecoverable then. |
| `snapshot-probe` red: no receipt for `HEAD`'s export tree, a red step, or no suite step (`test`/`remote-gate`) | The exported tree differs from the private one; only a suite run on it proves the public mirror is green. A validate-plugin-only receipt ran no test. The detail names the fix: `node scripts/snapshot-probe.mjs --host <alias>`. |
| `npm whoami` returns nothing or non-zero | The token is dead or absent. Publishing proceeds far enough to fail loudly *after* surfaces are committed. |
| `npm-token-publish` red: the token in use lacks Bypass-2FA, write, scope or has expired (read from `npm token list`) | `whoami` was green for 5.13.0 and publish still died with EOTP. See `skills/npm-publish/SKILL.md` § Token requirements. |
| CI not green on the exact commit being published (`ci-green-on-head`) | Green-on-the-previous-commit is the silent-regression class this repo exists to catch. |
| GitHub mirror CI not green (`ci-green-on-head-github`) | The GitLab pipeline is Linux-only; the macOS matrix leg runs only on the mirror, and macOS is the operator's own platform. An `unknown`/`degraded` reading stops the release too — it means the mirror was never read. Only a checkout with no `github` remote passes this row, as `skipped`. |
| `--skip-ci` together with `--publish` | **Refused by the script** (`validateFlags`), not merely discouraged. `--skip-ci` marks the CI row green without checking anything; a green tick that verified nothing must never authorise an irreversible publish. It is an inspection aid for `--check`, never a release path. |
| Working tree dirty, or not on `main` | The published tarball would not correspond to any pushed commit. |

## After

`--publish` reports either **Release complete** or **Post-publish reconciliation required**. The latter means npm accepted the target release but registry propagation, tag/push, GitHub-release handling, or the live-site check still needs repair; a tag/push failure explicitly skips its dependent GitHub-release and site steps. **Do not rerun `--publish`**: reconcile the listed state directly, because a second publish cannot replace the immutable version. For the registry state run `node scripts/release.mjs --reconcile --target X.Y.Z [--json]` — read-only (no publish, tag, push or repo pack), bounded and resumable: it reports `installable` (exit 0) only when the exact version is served as `latest` with the proof's integrity AND a consumer download hashes to it, or `superseded` (exit 0: same checks pass, but `latest` already points at a later release); otherwise `pending` (rerun later), `failed` (integrity mismatch) or `proof-missing` (exit 1 — success is never inferred from `latest`). See `skills/npm-publish/SKILL.md` § Failure-mode table for why an accepted upload can stay unavailable. Exit `1` means a preflight/check failure or post-publish reconciliation is required; exit `2` remains a system/usage failure before the receipt.

After a complete release, `--publish` prints the remaining manual items (token rotation, async gallery indexing). Rotate the npm token — write tokens are short-lived by policy, and a token that transited a log or a chat is burned.

## Tail interrupted

The tail after the receipt was killed (SIGKILL, `timeout -k`, a host crash) and `--publish` printed no outcome, or it ended with a `tag-and-push` reconciliation item. **Never rerun `--publish`.** Finish it with one command:

```
node scripts/release.mjs --resume-tail --target X.Y.Z
```

It reads `commit` from `.orchestrator/runtime/release-X.Y.Z.json` (the HEAD at the receipt; HEAD now does not matter). Before it creates or pushes anything it runs `--reconcile`: a registry that serves different bytes than the proof records ends the run as `RESUME REFUSED`, and a registry that does not serve the version yet ends it as `RECONCILIATION` with nothing tagged (run it again later). Then it refuses unless that commit is contained in origin `main`. It creates the annotated tag on it if missing, pushes the tag to `origin` and, by mirror mode, to `github` (`curated`: onto github `main` when its `Source-Commit:` trailer names that commit), one push per remote. Then it runs the GitHub release and the live-site check. A tag that already exists is skipped, but only at the recorded commit (`curated`: only when the github tag's snapshot carries `Source-Commit:` of that commit); a tag at any other commit, local or remote, ends the run as `RESUME REFUSED` and nothing after it changes. A second run changes nothing. It never publishes and never pushes `main`, because the preflight already proved `main` on both remotes. Exit 0 means the tail is complete. Exit 1 with `RECONCILIATION` means a step failed (run it again); with `RESUME REFUSED` it means a person has to look.

Each push, fetch and `ls-remote` of a tail, in `--publish` and in `--resume-tail`, runs in its own process group with a 900 s deadline (`TAIL_CHILD_TIMEOUT_MS`; the pre-push gate takes ~2.5 min per remote). Its PID, which is also its process group, goes to stderr as `tail child pid <pid> (process group <pid>)`. At the deadline the group gets SIGTERM, then SIGKILL 10 s later while any process of the group is still alive (even after the push itself exited), and the push ends as a `timed out` reconciliation item. If the group still lives 5 s after SIGKILL, the item ends with `still alive after SIGKILL: process group <pid>`; list its processes with `ps -ax -o pid,pgid,command | awk '$2 == <pid>'`. To stop a push earlier: `kill -TERM -<pid>`. One exception: the `ls-remote` of the anchor check in `--publish` has no deadline.

Fallback, if `--resume-tail` refuses or the proof has no `commit`: catch up by hand in the order the script runs.

1. **Tag.** Read `commit` from `.orchestrator/runtime/release-X.Y.Z.json`. If `git tag -l vX.Y.Z` is empty, create the annotated tag on that commit (`git tag -a vX.Y.Z <commit> -m vX.Y.Z`). Push it to `origin` on its own (`git push origin vX.Y.Z`): the pre-push gate blocks one push that carries refs on more than one commit (#1787).
2. **GitHub.** Under `mirror: github` push `main`, then the tag, in two pushes. Under `mirror: curated` push a lightweight tag on the snapshot whose `Source-Commit:` trailer names that commit: `git push github <snapshot-sha>:refs/tags/vX.Y.Z`.
3. **GitHub release.** `gh release create vX.Y.Z --repo Kanevry/session-orchestrator --verify-tag --title vX.Y.Z --notes-file <the X.Y.Z CHANGELOG section>`. Check first with `gh release view vX.Y.Z --repo Kanevry/session-orchestrator`; the script's own step is idempotent and so is this check.
4. **Live site.** `https://session-orchestrator.com/llms.txt` must carry `Version: X.Y.Z` once the deploy is done.
5. **Registry.** `node scripts/release.mjs --reconcile --target X.Y.Z` must answer `installable`.

## See Also

- `scripts/release.mjs` — the mechanism; `SURFACES` and `LEAKAGE_PATTERNS` are the single sources of truth for version surfaces and the tarball leak classes.
- `skills/npm-publish/SKILL.md` — the human decisions: which version, what a leak means, when to abort instead of repair.
- `docs/distribution/npm-publish-checklist.md` — operator runbook and post-publish verification.
