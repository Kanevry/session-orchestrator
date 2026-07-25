---
description: Classify and apply a version bump to a machine-readable contract (JSON Schema, API spec, config schema) — version literals, consumer compatibility, changelog entry, downstream drift
argument-hint: "[--contract <path>]"
---

# Contract Version Bump

The user wants to bump the version of a machine-readable contract (JSON Schema, API spec, or
config schema) after changing it. Invoke the contract-version-bump skill with arguments:
**$ARGUMENTS**.

Runs six phases: classify the change against the CONTRACT'S OWN versioning rule (not generic
semver instinct), find every version literal and vendored copy across this repo and every repo
in CLAUDE.md's `cross-repos:` list, check whether every known consumer actually evaluates each
new/changed schema keyword, apply the bump consistently (with written exceptions, never silent
ones), write a Keep-a-Changelog entry that calls out breaking-for-consumers risk explicitly
regardless of version tier, and report any dependent repo/copy left un-synced as follow-up work.

**Usage:**

- `/contract-version-bump` — infer the contract file from conversation context
- `/contract-version-bump --contract docs/spec/estate.schema.json` — target a specific contract file explicitly

Codifies three traps from a real case (GitLab issue #17, `aiat-enablement` repo, 2026-07-25): a
missing Patch clause that silently forbade a legitimate constraint tightening, five version-
literal locations including a vendored copy in a different repo, and a `maxLength` keyword a
hand-written consumer would have silently ignored.
