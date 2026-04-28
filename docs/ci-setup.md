# CI Setup — session-orchestrator

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

If `SCHEMA_DRIFT_TOKEN` is **not set**, the job prints a warning and exits 0
(no pipeline failure). Set the variable to activate the real drift check.

### Option A — Deploy Token (recommended, least-privilege)

1. Open `infrastructure/projects-baseline` on GitLab
   (`gitlab.gotzendorfer.at/infrastructure/projects-baseline`).
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
   printing the skip warning.
3. A passing job (exit 0) means the vendored schema matches the canonical
   source. A failing job (exit 1) means drift was detected — run
   `node scripts/sync-vault-schema.mjs --update` locally and commit the
   refreshed copy.

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
