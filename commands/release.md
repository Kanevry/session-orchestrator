---
description: Cut a release — the order the steps must run in, and the criteria that abort a release
disable-model-invocation: true
argument-hint: "[X.Y.Z]"
---

# Release

The user wants to cut a release of this package. Optional argument — the target version: **$ARGUMENTS**.

**The mechanism is `scripts/release.mjs`.** It exists, it is executable, and its pure half is unit-tested (`tests/scripts/release.test.mjs`). This command carries only the two things the script cannot carry: the **order**, and the **criteria that stop a release**. Do not restate the script's internals here — `node scripts/release.mjs --help` and the file header are the reference.

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

1. **Preconditions.** Working tree clean, on `main`, and `origin/main` **and** `github/main` both level with `HEAD`. The mirror is checked because the site deploy hangs off `github`, not `origin`.
2. **Set the version.** `node scripts/release.mjs --set-version X.Y.Z` — rewrites every version surface, syncs `package-lock.json`, re-stamps the measured census on the site.
3. **Write the editorial half.** The dated `## [X.Y.Z] - YYYY-MM-DD` CHANGELOG entry, `[Unreleased]` folded, README highlights. The script does not write these; `--check` enforces them.
4. **Preflight.** `node scripts/release.mjs --check --json` — every row green. This runs *after* step 2, never before: `--check` derives its target from `package.json`, so on the pre-bump version the registry- and tag-collision rows are red by construction.
5. **Gate, commit, push.** Full quality gate, then commit and push to **both** remotes.
6. **CI green — on the commit that will be published.** Not on its predecessor. A green pipeline from before step 5's commit is evidence about a different tree.
7. **Publish.** `node scripts/release.mjs --publish` — publishes, verifies the registry, tags **after** the verified publish, pushes `main` + tag to both remotes, then polls the live site. Add the GitHub release for the new tag (`gh release create`) as part of this step, not "later" — "later" is what produced the three-second backfill above.

Steps 2–7 are one continuous act. A release left parked between step 5 and step 7 is exactly the `3.18.0` state: every surface says released, the registry disagrees.

## Abort criteria

Stop and report. Do not work around, do not "fix it after the publish" — an npm publish is not revocable.

| Signal | Why it stops the release |
|---|---|
| Any red row in `--check` | The preflight is the gate. A red row is a fact about this tree, not a formality. |
| `github/main` behind `origin/main` or `HEAD` | The mirror carries the site deploy and the GitHub release. Publishing over a lagging mirror is how the site falls a release behind. |
| `npm whoami` returns nothing or non-zero | The token is dead or absent. Publishing proceeds far enough to fail loudly *after* surfaces are committed. |
| CI not green on the exact commit being published | Green-on-the-previous-commit is the silent-regression class this repo exists to catch. |
| `--skip-ci` together with `--publish` | **Refused by the script** (`validateFlags`), not merely discouraged. `--skip-ci` marks the CI row green without checking anything; a green tick that verified nothing must never authorise an irreversible publish. It is an inspection aid for `--check`, never a release path. |
| Working tree dirty, or not on `main` | The published tarball would not correspond to any pushed commit. |

## After

`--publish` prints the remaining manual items (token rotation, async gallery indexing). Rotate the npm token — write tokens are short-lived by policy, and a token that transited a log or a chat is burned.

## See Also

- `scripts/release.mjs` — the mechanism; `SURFACES` and `LEAKAGE_PATTERNS` are the single sources of truth for version surfaces and the tarball leak classes.
- `skills/npm-publish/SKILL.md` — the human decisions: which version, what a leak means, when to abort instead of repair.
- `docs/distribution/npm-publish-checklist.md` — operator runbook and post-publish verification.
