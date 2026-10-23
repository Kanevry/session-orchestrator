# Read-only fleet check-in audit

`scripts/fleet-checkin-audit.mjs` audits explicitly supplied registry and check-in
snapshot copies for #1462. It reads no ambient registry, host configuration or
referenced repository, writes no input, and sends no check-in, event, webhook or
message. It does not establish authority to start a session or modify a repo.

## Inputs and identity

Both JSON envelopes require `version: 1`, `complete: true`, `records: []` and
`captured_at` equal to the explicit measurement time `--at`. Except for check-in
`zeit` (whole UTC seconds under the existing protocol), instants use
`YYYY-MM-DDTHH:MM:SS[.sss]Z`; invalid calendar dates and future record timestamps
are rejected. An explicit complete empty population is measurable zero; a
missing, unreadable or incomplete population is not.

The registry envelope additionally requires `repo_bindings`. Each binding has:

- `repo_key`: a unique explicit audit identity, selected with `--repo`.
- `registry_hashes`: nonempty array of unique lowercase 64-digit hex hashes.
- `checkin_repos`: nonempty array of unique check-in repo names.

Registry records require `session_id`, `repo_path_hash`, `started_at` and
`last_heartbeat`, with `started_at <= last_heartbeat <= at`. Optional `mode` and
`role` must be strings or null. Check-in records follow `validateCheckin()` in
`scripts/lib/fleet-protocol.mjs`, including its required fields `session`,
`plattform`, `repo`, `modus`, `auftrag_ref`, `kandidaten`, `schreibbereich`,
`rueckfall` and `zeit`.

The join requires the exact raw equality `checkin.session === registry.session_id`
and both repo identities resolving through the explicit binding to the same
`repo_key`. Check-in `repo_id` is not treated as a registry hash. No basename,
path, issue-number or host heuristic supplies a missing identity. Check-ins before
registration are invalid. Duplicate session IDs, invalid records and unmapped
identities make dependent measurements conservative: their values become null
with reasons, rather than silently excluding records to report zero.

## Historical candidate intervals

The check-in envelope additionally requires:

```json
{
  "coverage": {"complete": true, "from": "2026-10-10T11:00:00Z", "to": "2026-10-10T12:00:00Z"},
  "claims": [
    {"session": "example-session", "repo_key": "example", "candidate": "#42",
     "from": "2026-10-10T11:30:00Z", "to": "2026-10-10T12:00:00Z",
     "evidence_ref": "supplied-history-record-1"}
  ]
}
```

Each claim must match one valid check-in for that session, repo and candidate.
Its nonempty `evidence_ref` is only an opaque reference; it is never opened.
Intervals are half-open `[from, to)`, positive in length, wholly inside coverage,
end no later than `at`, and start no earlier than the matching check-in's `zeit`.
Coverage itself must have `from < to <= at`. Integer `42`, `"42"` and `"#42"`
normalize to the same candidate. Equal IIDs in different repos never collide.

Collisions count overlapping pairs of claims from distinct sessions for the same
selected repo and candidate. Touching endpoints do not overlap. Repeated
overlapping claims for one session/repo/candidate make the history ambiguous.
Coverage and completeness are caller assertions about the supplied snapshots,
not independently verified historical fleet coverage or evidence of authority.
Current candidate lists alone do not establish historical concurrency.

## Report

Every `metrics` entry has `status`, `value` and `reasons`. A measurable entry has
an integer value; an unmeasurable entry has `status: "not-measurable"`,
`value: null` and reason codes. The overall status is `measured` only when all
five metrics are measured.

| Metric | Meaning |
| --- | --- |
| `selected` | Valid, unambiguous registry population for selected repo keys |
| `fresh` | Selected records whose heartbeat is at most 15 minutes old |
| `due` | Fresh records registered at least 30 minutes before `at` |
| `missing_after_30m` | Due records without a valid exactly joined check-in |
| `collisions` | Overlapping claim pairs within the supplied historical coverage |

At 29:59 a fresh session is not due; at 30:00 it is due. A heartbeat exactly
15 minutes old is fresh. Stale sessions remain in `selected`, but not in `fresh`
or `due`. Missing history makes `collisions` unmeasurable without erasing
otherwise measured point-in-time metrics. Invalid check-ins can invalidate
missing-check-in measurements while registry-only metrics remain measurable.

`snapshots` reports raw, valid, invalid, ambiguous and stale record counts;
invalid and ambiguous categories can overlap. `issues` identifies source, record
index and problem code. `findings` contains missing sessions, measured collisions
and current candidates when their required evidence is measurable. Findings do
not imply an automatic repair or a session-start permission.

## Minimal complete empty example

Place these two stable, trusted copies inside an explicit input directory.
`registry.json`:

```json
{
  "version": 1, "captured_at": "2026-10-10T12:00:00Z", "complete": true,
  "repo_bindings": [{"repo_key": "example",
    "registry_hashes": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    "checkin_repos": ["example-name"]}],
  "records": []
}
```

`checkins.json`:

```json
{
  "version": 1, "captured_at": "2026-10-10T12:00:00Z", "complete": true,
  "records": [], "claims": [],
  "coverage": {"complete": true, "from": "2026-10-10T11:00:00Z", "to": "2026-10-10T12:00:00Z"}
}
```

```sh
node scripts/fleet-checkin-audit.mjs --input-root /tmp/audit-input \
  --registry registry.json --checkins checkins.json --repo example \
  --at 2026-10-10T12:00:00Z --json
```

This read-only audit reports all five metrics as zero with exit 0. `--repo` may
repeat with distinct keys. All five input flags are required. `--help` and
`--version` are standalone commands; version reads the package manifest.
Without `--json`, stdout contains a human-readable report. With it, stdout
contains one JSON report plus a newline. stderr contains only diagnostics, not
snapshot bytes or input paths.

| Exit | Meaning |
| --- | --- |
| 0 | Measured report, including reports with findings; help or version |
| 1 | Invalid arguments, rejected paths, malformed JSON or UTF-8 |
| 2 | Unavailable input or system/output I/O |
| 3 | Incomplete or otherwise unmeasurable snapshot evidence |

## File boundary and API

The CLI accepts only regular files strictly inside `--input-root`. It checks both
paths before reading either file's contents, rejects lexical escapes, symlinks
in the root, parents or final component, and nonregular inputs. Opening uses
native `O_NOFOLLOW` and `O_NONBLOCK` where the platform has them. Where it lacks
them (win32), the reader lstats the final path, opens it read-only and compares
the handle's device/inode (bigint) with the lstat. A swap, a symlink or a
nonregular file found at open time reports `changed-input-file` (exit 1). It
verifies the opened file's device/inode against the inspected file. Concurrent parent
directory renames are not atomically secured by this portable path-based reader:
use stable trusted snapshot copies. A Linux result is not a universal Windows or
macOS portability proof.

The pure library exports `auditCheckins({ registry, checkins, repos, at })` and
`normalizeCandidate(value)`. It reads no filesystem, clock or environment and
does not mutate inputs. Importing the CLI is inert; `main(argv, io)` returns its
exit code and supports caller-supplied stdout/stderr streams.

## Verification

Run the targeted existing harness with fresh temporary `HOME`,
`NAVIGATOR_CONFIG_DIR` and `SO_VAULT_DIR`; child processes explicitly inherit
that isolation:

```sh
env HOME=/tmp/audit-test-home NAVIGATOR_CONFIG_DIR=/tmp/audit-test-config \
  SO_VAULT_DIR=/tmp/audit-test-vault timeout -k 30 300 \
  node node_modules/vitest/vitest.mjs run \
  tests/lib/fleet-checkin-audit.test.mjs tests/scripts/fleet-checkin-audit.test.mjs
```

Do not bypass globalSetup or count a timeout with zero tests as a pass. Sandbox
EPERM/EACCES marks these native subprocess cases skipped and not measurable:
`native success and byte preservation`, `native error stream and exit`,
`native symlink refusal`, and `native import remains inert`. They need Lead
verification on a native runner; in-process tests do not replace that evidence.
