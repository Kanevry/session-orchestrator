---
description: Cut a release — the order the steps must run in, and the criteria that abort a release
disable-model-invocation: true
argument-hint: "[X.Y.Z]"
---

# Release

The user wants to cut a release of this package. Optional argument — the target version: **$ARGUMENTS**.

**Invoke the `release` skill** (`skills/release/SKILL.md`). It carries the seven-step order, the abort-criteria table, and the post-publish reconciliation rule — the two things `scripts/release.mjs` cannot carry.

## The flags this repo's release path uses

The mechanism is `scripts/release.mjs`; `node scripts/release.mjs --help` and the file header are the reference for its internals. The operator-facing entry points, in the order they run:

- `node scripts/release.mjs --set-version X.Y.Z` — rewrite every version surface and sync `package-lock.json`.
- `node scripts/release.mjs --check --json` — the preflight gate; every row must be green.
- `node scripts/release.mjs --publish` — the irreversible step; give it ≥600 s of wall clock.

`--skip-ci` marks the CI row green without checking anything and is **refused by the script** when combined with `--publish`; it is an inspection aid for `--check`, never a release path.
