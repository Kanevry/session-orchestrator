# CI Setup — session-orchestrator

> **Maintainer-internal.** This document describes the maintainer's private CI mirror setup. It is not required for using the plugin.

## schema-drift-check job

The `schema-drift-check` job compares the vendored `vault-frontmatter` schema
in this repo against the canonical source in
`infrastructure/projects-baseline` (project ID 52, private).

Because the target repo is on the same private GitLab instance but is a
**different project**, `CI_JOB_TOKEN` is rejected with HTTP 403 unless
project-level Job Token allowlists are explicitly configured — an admin action
in the foreign project that cannot be scripted from here. The fix is a deploy
token or PAT stored as the masked CI variable `SCHEMA_DRIFT_TOKEN`.

### Required CI variable

| Variable | Type | Mask | Protect | Value |
|---|---|---|---|---|
| `SCHEMA_DRIFT_TOKEN` | Variable | Yes | Optional | deploy token or PAT (see below) |

If `SCHEMA_DRIFT_TOKEN` is **not set**, the job prints a `NOT VERIFIED` notice
and exits **3** — which `allow_failure.exit_codes` renders as an amber *warning*,
never as a pass — provided `SCHEMA_DRIFT_OPTIONAL` is still `"true"`. Once that
flag is flipped, the same missing token exits **4** and hard-fails. Set the
variable to activate the real drift check; the full exit taxonomy is the table
in the next section.

Until 2026-07-30 this path exited **0**, so a job that had checked nothing
reported exactly the same green tick as a job that had checked everything. It
was visible in the timings: in pipeline 6815 `schema-drift-check` reported
success after 17 seconds, which is not enough time to clone the baseline repo,
let alone diff a schema against it. Issue #933.

### Activating the hard gate (`SCHEMA_DRIFT_OPTIONAL`)

`schema-drift-check` carries a committed job variable:

```yaml
variables:
  SCHEMA_DRIFT_OPTIONAL: "true"
```

It is the review-visible declaration that "no token" is *currently* an accepted
state. The behaviour matrix:

| `SCHEMA_DRIFT_TOKEN` | `SCHEMA_DRIFT_OPTIONAL` | Exit | State | Pipeline effect |
|---|---|---|---|---|
| unset | `"true"` | 3 | `SKIPPED` | amber warning; `pipeline-gate` prints `schema-drift: NOT VERIFIED` |
| unset | anything else | 4 | `MISCONFIGURED` | hard failure — the token is required and the check never ran |
| set, clone fails | either | 5 | `UNAVAILABLE` | hard failure — token scope/expiry/masking or network, **not** drift |
| set, clone works | either | 0 | `IN-SYNC` | pass; writes the `.ci-markers/schema-drift.ok` marker |
| set, clone works | either | 1 | `DRIFT` | hard failure — **the only code that means drift** |

**One code per fact.** Exit 1 is reserved for a real schema divergence; 3, 4 and
5 all mean NOT VERIFIED and none of them is a drift verdict. That split is the
point of the taxonomy: before it, "you forgot the token" and "the schema has
diverged" were the same red, so the first person to see the failure went hunting
a schema diff that does not exist. Only 3 is listed in
`allow_failure.exit_codes`; 4 and 5 are hard failures by construction. Every
outcome also prints its own `[schema-drift] RESULT: <STATE>` line, so the job log
answers "what happened" without the reader having to know this table.

**After completing the token setup below, change `SCHEMA_DRIFT_OPTIONAL` to
`"false"` in `.gitlab-ci.yml`** — in **both** places: the `schema-drift-check`
job and `pipeline-gate`. One flag, two enforcement points;
`tests/ci/schema-drift-check.test.mjs` asserts the mirroring, so a half-flip
fails the suite locally rather than silently leaving one point advisory. The
flip is what converts a missing token from a tolerated warning into a hard red,
and it is the whole point of the flag: the opt-out is a line in a reviewed file,
not the accidental side effect of an unset CI variable.

> **Before you flip it, run ONE pipeline with the token present while
> `SCHEMA_DRIFT_OPTIONAL` is still `"true"`, and check the job's DURATION.**
> A `schema-drift-check` that "succeeds" in under ~20 seconds did not clone the
> baseline repo — that is the signature of the exit-3 soft-skip path, i.e. the
> token is still not reaching the job (misspelled key, protected-variable on an
> unprotected branch, or masking rejection). Flipping the flag on that state
> converts a silent skip into a red pipeline whose message points at the wrong
> problem. Confirm a real run first: the log must show
> `RESULT: IN-SYNC (exit 0)` and the job must produce the
> `.ci-markers/schema-drift.ok` artifact. This job has a recorded history of
> exactly this failure — pipeline 6815 reported SUCCESS in 17 s having checked
> nothing (issue #933).

### Option A — Deploy Token (recommended, least-privilege)

1. Open `infrastructure/projects-baseline` on your GitLab instance.
2. Go to **Settings → Repository → Deploy tokens**.
3. Click **Add token**:
   - **Name:** `session-orchestrator-ci-schema-drift`
   - **Expires at:** set a reminder (e.g. 1 year); rotate before expiry
   - **Scopes:** check `read_repository` only
4. Copy the generated token value (shown once).
5. Open `session-orchestrator` on GitLab.
6. Go to **Settings → CI/CD → Variables → Add variable**:
   - **Key:** `SCHEMA_DRIFT_TOKEN`
   - **Value:** paste the deploy token
   - **Type:** Variable
   - **Masked:** Yes
   - **Protected:** Optional (enable if you only need it on protected branches)
7. Save.

### Option B — Personal Access Token (fallback)

Use this if a deploy token is not available for the target project.

1. Go to your GitLab profile → **Access Tokens**.
2. Create a token with scope `read_repository` and a reasonable expiry.
3. Store it in `session-orchestrator` CI/CD variables as `SCHEMA_DRIFT_TOKEN`
   (Masked: Yes) — same steps 5–7 above.

Note: a PAT is scoped to the creating user's access; prefer a deploy token so
the CI credential survives staff changes.

### Verification path

After setting the variable:

1. Push to a feature branch or open an MR against `main`.
2. Observe the `schema-drift-check` job in the pipeline — it should now clone
   `infrastructure/projects-baseline` and run the sync check instead of
   printing the skip warning. Read the job's `[schema-drift] RESULT:` line; it
   names the state directly, and the duration corroborates it (a real run
   clones a repo, so it cannot finish in seconds).
3. Read the exit code against the table above before diagnosing anything:
   - **0 (`IN-SYNC`)** — the vendored schema matches the canonical source.
   - **1 (`DRIFT`)** — and only 1 — means drift was detected. Run
     `node scripts/sync-vault-schema.mjs --update` locally and commit the
     refreshed copy.
   - **3 (`SKIPPED`)** — the token still is not reaching the job. Nothing was
     compared; do not read the amber tick as a pass.
   - **4 (`MISCONFIGURED`)** — `SCHEMA_DRIFT_OPTIONAL` is no longer `"true"` and
     the token is missing. Provision the variable; there is no schema diff to
     look for.
   - **5 (`UNAVAILABLE`)** — the clone failed. Check the token's
     `read_repository` scope, its expiry, and its masking. Also not drift.

### Why not configure the CI Job Token allowlist in projects-baseline?

That approach (Settings → CI/CD → Token Access in the foreign project) is
equally valid and may be preferable if you manage `projects-baseline`.
Documenting it here for completeness:

- Go to `infrastructure/projects-baseline → Settings → CI/CD → Token Access`.
- Under "Allow CI job tokens from the following projects", add
  `infrastructure/session-orchestrator`.
- Once the allowlist entry is saved, the job can use `CI_JOB_TOKEN` directly
  and `SCHEMA_DRIFT_TOKEN` is not needed.
- Issue #279 chose the deploy-token path because it requires no admin action
  in the foreign project and works immediately after variable creation.

## `pipeline-gate` — the fan-in job

The last stage holds one job that depends on every blocking gate. It exists
because until #933 nothing depended on anything: a gate could be deleted, or
ruled out for a whole pipeline type, and the pipeline still went green.

Two mechanisms, because "the gate is gone" and "the gate ran but verified
nothing" are different failures:

1. **Hard `needs:`** on every gate that runs on all non-scheduled pipelines.
   On GitLab 18.11, needing a job that is absent from the pipeline is a
   pipeline-*creation* error, not a silent skip (verified via
   `POST /projects/74/ci/lint` with `dry_run`). Removing a gate from
   `.gitlab-ci.yml` therefore produces no pipeline at all instead of a green
   one — which is exactly the alarm we want, so these needs are intentionally
   **not** `optional`.
2. **Marker artifacts** for the two conditional jobs, `coverage` and
   `schema-drift-check`. Each writes `.ci-markers/<name>.ok` as the final line
   of its script, so the marker is reachable only from the path where the job
   really verified something. `pipeline-gate` reads those markers and prints one
   line per gate. This is what catches an amber `schema-drift-check`: an
   `allow_failure` job never blocks a dependent job, so `needs:` alone is blind
   to it.

Coverage is required only on merge-request and default-branch pipelines (it is
the slowest job at ~148s, and it re-runs a suite `test` has already run). On a
plain branch pipeline `pipeline-gate` states that coverage was not measured —
absent, but never silently absent.

## Local pre-push gate

`.husky/pre-push` runs `npm run quality-gate`
(`scripts/run-quality-gate.mjs --variant full-gate`: typecheck + full vitest
suite + lint) and blocks the push on any non-zero exit.

- `full-gate` is used because it is the only **blocking** variant — the
  `incremental` handler ends in an unconditional `process.exit(0)` and reports
  rather than gates.
- Delete-only pushes skip the gate (no code ships).
- `SKIP_QUALITY_GATE=1 git push` is the named bypass. Prefer it over
  `git push --no-verify`, which disables every hook silently and leaves no
  record of what was skipped.
