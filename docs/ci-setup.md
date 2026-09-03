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

> **Armed (2026-09-03, #1175): the hard gate is live.** #531 landed upstream
> — `infrastructure/projects-baseline` commit `cb9ec97` adds `peer-card`,
> `board`, and `source-repo` to the canonical schema (the issue's AC named
> only `peer-card`; the close comment widened scope to all three values
> already vendored ahead here). That closed the vendored-schema divergence
> which had blocked activation since 2026-09-02; `skills/vault-sync/
> validator.mjs` was regenerated and `node scripts/sync-vault-schema.mjs
> --check` now exits 0. The Project Access Token was re-minted (id 53, see
> § Activation status below), the masked `SCHEMA_DRIFT_TOKEN` CI variable is
> set on this project, and `SCHEMA_DRIFT_OPTIONAL` is `"false"` at both
> sites in `.gitlab-ci.yml` — a missing or expired token now hard-fails the
> pipeline (exit 4) instead of printing the amber `NOT VERIFIED` line that
> was the accepted state under the prior (2026-08-28, #1062) decision. Both
> directions were proven before the flip — see below. Revisit trigger for
> the token itself: expiry (2027-09-01) or a scope/rotation need — see
> § Rotation / re-arm sequence.

### Activation status (token re-minted 2026-09-03, id 53)

The Project Access Token was revoked on 2026-09-02 once a control run had
answered the question it was minted for — an unused credential is a
liability per SEC-005's secrets-lifecycle discipline. That control run had
also surfaced the real reason activation was still blocked:
`skills/vault-sync/validator.mjs`'s `vaultNoteTypeSchema` enum carried
`peer-card` and `board`, and `vaultFrontmatterSchema` carried
`source-repo: z.string().optional()`, none of which the canonical
`infrastructure/projects-baseline` source had yet — the documented
vendor-ahead state (`scripts/sync-vault-schema.mjs` header, "Vendor-ahead
state (2026-05-23, #503, I5)"), tracked as upstream-sync-debt in issue #531
(#503 itself was already closed).

**#531 landed upstream** as commit `cb9ec97`: `vaultNoteTypeSchema` gained
`peer-card` and `board`; `vaultFrontmatterSchema` gained `source-repo:
z.string().optional()`. With the canonical source caught up,
`node scripts/sync-vault-schema.mjs --check` exits 0 — no drift.

**Token, re-minted:**

- **Name:** `session-orchestrator-ci-schema-drift`
- **Project:** `infrastructure/projects-baseline` (id 52) — the TARGET repo,
  not this one
- **Token id:** 53
- **Scopes:** `read_repository`
- **Access level:** Reporter (20)
- **Expires:** 2027-09-01

The masked `SCHEMA_DRIFT_TOKEN` CI variable is set on this project (id 74),
**not** Protected — same reasoning as Option A step 3 below.

**Proof pipelines, both directions, run before the flip:**

- **GREEN** — pipeline 8358 @ `dc9522dd` (branch
  `proof/1175-schema-drift-green`): job `schema-drift-check` #84625 ran with
  the token, cloned the baseline, and printed `RESULT: IN-SYNC (exit 0)`;
  `pipeline-gate` succeeded.
- **RED** — pipelines 8355–8357 @ `bca78dae` (branch
  `proof/1175-schema-drift-red`, a deliberately bogus enum value injected
  into the vendored copy): `sync-vault-schema.mjs` reported drift, the job
  failed with exit 1 — outside `allow_failure.exit_codes: [3]` — and
  `pipeline-gate` never ran.

With both proofs recorded, `SCHEMA_DRIFT_OPTIONAL` is `"false"` at both
sites in `.gitlab-ci.yml` — `schema-drift-check` and `pipeline-gate`.
`tests/ci/schema-drift-check.test.mjs` pins the committed value on both
jobs, so a half-revert or a template refresh flipping one site back to
`"true"` fails the suite locally, not silently in a pipeline.

**Rotation / re-arm sequence** (token expiry or replacement):

0. **Re-mint the token.** Run the same `glab api --method POST … --input -`
   recipe as Option A step 1, against the TARGET project (id 52), and copy
   the response's `token` field immediately — it is shown exactly once.
1. `read -rs TOKEN` at the prompt (no echo), then pipe it into `glab variable
   set` rather than passing it as a `--value` argument — a value passed on the
   command line is visible to any other process on the host via `ps`, while
   stdin is not:

   ```bash
   read -rs TOKEN
   printf '%s' "$TOKEN" | glab variable set SCHEMA_DRIFT_TOKEN \
     -R infrastructure/session-orchestrator --masked
   ```

   **Not** `--protected`: `.gate-rules` (`.gitlab-ci.yml:74`) runs the job
   on every branch and every MR pipeline, and a protected-only variable would
   silently reproduce the exit-5 `UNAVAILABLE` failure on every unprotected
   branch. (`glab variable set --help` documents stdin piping directly —
   `cat file.txt | glab variable set SERVER_TOKEN` — but no `-`/dash value
   for `--value`; the flag only accepts a literal string, so omitting it
   entirely and piping the value is the only way to keep the token off argv.)
2. Push an ordinary commit and read the `schema-drift-check` job log for
   `RESULT: IN-SYNC` — and confirm the job DURATION is well over 20 seconds
   (see the pipeline-6815 warning above). A fast "success" is the exit-3
   soft-skip in disguise, not a real run.
3. `SCHEMA_DRIFT_OPTIONAL` stays `"false"` at **both** sites —
   `schema-drift-check` and `pipeline-gate`. A rotation replaces only the
   credential, never the flag; if the flag was ever reverted for an
   emergency, flip it back to `"false"` at both sites in one commit —
   `tests/ci/schema-drift-check.test.mjs` pins the committed value on both
   jobs, so a half-flip fails the suite locally.
4. Local counter-probe before trusting the pipeline: clone
   `infrastructure/projects-baseline` with the token, make a throwaway copy of
   `packages/zod-schemas/src/vault-frontmatter.ts` with one field
   deliberately edited, then run
   `node scripts/sync-vault-schema.mjs --check --canonical <path-to-edited-copy>`
   — expect exit 1 with a diff naming the edited field. That confirms the
   check diffs real content rather than passing on a broken comparison.

Per `.claude/rules/security.md` § SEC-005, this token's lifecycle belongs in
`.claude/docs/SECRETS-INVENTORY.md` once one exists — that file is not present
in this repo (measured 2026-09-02: no `.claude/docs/` directory tracked), so
the inventory is not adopted here and this section remains the sole record.

### Required CI variable

| Variable | Type | Mask | Protect | Value |
|---|---|---|---|---|
| `SCHEMA_DRIFT_TOKEN` | Variable | Yes | No | Project Access Token or PAT — see Option A/B below |

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
  SCHEMA_DRIFT_OPTIONAL: "false"
```

It is the review-visible declaration that "no token" is *no longer* an
accepted state — armed 2026-09-03 (#1175, see § Activation status above).
The behaviour matrix:

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

**Caveat — a second, narrower exit-3 collision (do not change the YAML for
it).** `scripts/sync-vault-schema.mjs` has its own exit 3, for a different
condition: malformed sentinel comments in `validator.mjs` (only one of
`begin`/`end` present). If `--check` ever hit that branch, it would return
exit 3 from the tool itself — and `allow_failure.exit_codes: [3]` reads the
shell's final exit code, not which tool produced it, so a genuine tooling
defect (broken sentinels) would render as the same amber "no token, declared
optional" warning that the missing-token guard produces. This is a caveat to
note, not a blocker: the sentinels are intact today, and the fix — if it is
ever needed — is giving `sync-vault-schema.mjs`'s malformed-sentinel case a
distinct exit code, not a change here.

**This is what the armed state looks like.** `SCHEMA_DRIFT_OPTIONAL` is
`"false"` in `.gitlab-ci.yml` at **both** places: the `schema-drift-check`
job and `pipeline-gate`. One flag, two enforcement points;
`tests/ci/schema-drift-check.test.mjs` asserts the mirroring AND pins the
literal `"false"` value on both jobs, so a half-flip — or a full revert —
fails the suite locally rather than silently leaving one point advisory. A
missing or expired token now hard-fails the pipeline (exit 4) instead of the
tolerated amber warning — that is the whole point of the flag: the opt-out is
a line in a reviewed file, not the accidental side effect of an unset CI
variable.

**To switch it back to amber temporarily** (a token rotation window, or
taking the check offline for an emergency): set `SCHEMA_DRIFT_OPTIONAL` to
`"true"` at **both** sites, in one commit — the same mirrored-pair discipline
applies in reverse, and the same test catches a half-revert. Re-arm by
flipping both sites back to `"false"` once the reason for the amber window is
resolved; see § Rotation / re-arm sequence above for the token side of that
operation.

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

### Option A — Project Access Token (recommended — works with the current clone URL)

GitLab resolves a **deploy token** by its own fixed username
(`gitlab+deploy-token-<n>`, or a custom username if one was set at creation).
The job's clone step hardcodes the login as `oauth2:${SCHEMA_DRIFT_TOKEN}`
(`.gitlab-ci.yml` ~:652) — `oauth2` is the username GitLab expects for a
Personal or Project Access Token, not for a deploy token. A deploy token's
value paired with that hardcoded username fails authentication at clone time
and surfaces as exit 5 `UNAVAILABLE`, which reads as a network/credential
problem rather than "wrong username" (see the demoted Deploy Token option
below). Tokens with **PAT semantics** — GitLab accepts any username alongside
the token value — authenticate correctly with this clone URL: a Personal
Access Token, or, least-privilege, a **Project Access Token** scoped to the
TARGET project (`infrastructure/projects-baseline`). A Project Access Token
is preferred over a personal PAT for the same reason the deploy token used to
be recommended: it belongs to the project, not a person, and survives staff
changes.

1. Create the token via API against the TARGET project (id 52) — GitLab has
   no path to create a Project Access Token FOR a project from outside that
   project's own Settings UI, so use `glab api`:

   ```bash
   glab api --hostname "$GITLAB_HOST" -X POST "projects/52/access_tokens" \
     -H 'Content-Type: application/json' --input - <<'JSON'
   {"name":"session-orchestrator-ci-schema-drift","scopes":["read_repository"],"access_level":20,"expires_at":"2027-09-01"}
   JSON
   ```

   `--input -` plus the explicit `Content-Type: application/json` header is
   required because the payload has a nested type (`scopes` is a JSON array),
   which `glab api`'s `-f`/`-F` flag form cannot express. `access_level: 20`
   is Reporter — the lowest access level that can read repository content.
   `expires_at` is an operator choice, not a fixed value; the token created
   for this document's own dry run (2026-09-02) was set 1 year out
   (`2027-09-01`) — rotate before expiry.

2. The response's `token` field holds the token value and is **shown exactly
   once** — copy it immediately; GitLab will not display it again.

3. Store it in `session-orchestrator` CI/CD variables as `SCHEMA_DRIFT_TOKEN`.
   Prefer stdin over `--value` — a value passed as a command-line argument is
   visible to other processes on the host (`ps`), while stdin is not:

   ```bash
   read -rs TOKEN
   printf '%s' "$TOKEN" | glab variable set SCHEMA_DRIFT_TOKEN \
     -R infrastructure/session-orchestrator --masked
   ```

   **Masked:** Yes. **Not** `--protected` — `.gate-rules` (`.gitlab-ci.yml:74`)
   runs the job on every branch and every MR pipeline, so a protected-only
   variable would silently be absent everywhere the job actually needs it.

### Option B — Personal Access Token (fallback)

The same PAT-semantics reasoning from Option A applies: a personal PAT
authenticates under any username, so it works with the hardcoded `oauth2:`
clone login. Use this only if you cannot create a Project Access Token on
`infrastructure/projects-baseline` (e.g. you lack Owner/Maintainer there).

1. Go to your GitLab profile → **Access Tokens**.
2. Create a token with scope `read_repository` and a reasonable expiry.
3. Store it in `session-orchestrator` CI/CD variables as `SCHEMA_DRIFT_TOKEN`
   (Masked: Yes, **not** Protected — see Option A step 3 above).

A personal PAT is tied to the creating user's account and access; prefer the
Project Access Token in Option A so the CI credential survives staff changes.

### Deploy Token — does not work with the current clone URL

This was the previously recommended option; it is demoted here because, as
the job is written today, it does not authenticate. GitLab deploy tokens
authenticate under their OWN username (`gitlab+deploy-token-<n>`, or a custom
username set at creation) — never as `oauth2`. The job's clone step hardcodes
`oauth2:${SCHEMA_DRIFT_TOKEN}` (`.gitlab-ci.yml` ~:652), so a deploy token's
value paired with the wrong username fails authentication at clone time. This
job reports that as exit 5 `UNAVAILABLE` — read as a network/credential-scope
problem, when the actual cause is the username mismatch.

To use a deploy token instead of Option A, `.gitlab-ci.yml`'s clone step would
need to stop hardcoding `oauth2` — either read the deploy token's own username
from a second CI variable and interpolate it into the clone URL, or create the
deploy token with a custom username of `oauth2` if the GitLab instance allows
choosing one. Neither change is made in this repo; that edit is out of this
document's scope. Option A avoids needing it at all, by using a token whose
username requirement (any username) already matches the hardcoded login.

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
- Issue #279 chose the token-variable path over this allowlist because it
  requires no admin action in the foreign project and works immediately after
  variable creation. The original choice was a deploy token; as documented in
  Option A above, a deploy token does not actually authenticate with this
  job's hardcoded `oauth2:` clone login, so a Project Access Token (or PAT)
  is the variant that delivers on that original reasoning.

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
