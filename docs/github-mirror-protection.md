# GitHub-Mirror Branch Protection — Runbook

GitLab issue #1079.

## Why this matters — a mirror push IS a deploy here

`.claude/rules/security.md` § "Session Config Command Trust" argues that
commit-gated files (`test-command`, `custom-phases[].command`, …) are
trustworthy **because** every change lands in `git log` and passes review
before it can run. That argument depends on one premise: the path that
**deploys** the change is the same path that **reviews** it.

For this repo, that premise is broken on the GitHub mirror:

```
$ git remote -v
origin  git@<gitlab-host>:<group>/session-orchestrator.git   # reviewed via MR
github  https://github.com/Kanevry/session-orchestrator.git                  # pushed directly
```

- `origin` (GitLab) is the review path: every change lands via a Merge Request.
- `github` (the mirror) is pushed **directly** by `git push github HEAD` in
  `skills/session-end/SKILL.md` (see the `github-mirror-push` block, roughly
  lines 781–825) — no MR, no review, no gate. Any session's `/close` does this
  the moment a `github` remote exists (the block does not actually re-check the
  `mirror: github` Session Config key at runtime, only the remote's presence).
- The GitHub mirror's `main` branch is what a **Vercel Git integration**
  deploys from. `vercel.json` in this repo sets security headers (CSP, HSTS)
  and redirects. So a push to `github`'s `main` is not "just a mirror update"
  — it is a production deploy of the public website, with no review gate in
  between.

A compromised mirror token, or any admin-scoped push, can therefore:
- Remove `default-src 'self'` from the CSP — the mechanical guard behind the
  "we make zero external requests" claim in the privacy policy, itself hosted
  on the same domain.
- Remove HSTS.
- Add a wildcard redirect (`/(.*)`) to an arbitrary foreign domain.
- Serve arbitrary HTML under the domain that also hosts the Impressum and
  Datenschutzerklärung (German legal-notice pages).

That is an escalation surface, not "just some stale mirror content".

## Current measured state (2026-08-28 @ `70a1ca9`, read-only `gh api`)

```json
{
  "repo": "Kanevry/session-orchestrator",
  "branch": "main",
  "enforce_admins": false,
  "required_status_checks": { "strict": true, "contexts": ["test (ubuntu-latest)", "test (macos-latest)", "security"] },
  "required_pull_request_reviews": false,
  "allow_force_pushes": false,
  "token_scopes": ["admin:public_key", "gist", "read:org", "repo", "workflow"],
  "findings": [
    { "id": "enforce-admins-disabled", "severity": "high", "message": "enforce_admins is false — an admin-scoped push (or token) bypasses required_status_checks entirely." },
    { "id": "token-scope-too-broad", "severity": "medium", "message": "Token scope(s) admin:public_key, repo exceed what a mirror push needs (fine-grained contents:write on this one repo)." }
  ]
}
```

Reproduce with `node scripts/github-protection-audit.mjs` (see § Running the audit below).

Reading this: required status checks ARE configured (3 contexts, `strict:
true`) and force pushes are already disallowed — those two controls are
sound. The gap is `enforce_admins: false`: **the checks above only bind
non-admin pushes.** The mirror push in `skills/session-end/SKILL.md` runs
under the same `gh`/git identity that authenticated the CLI — whatever scope
that identity's token carries, an admin-scoped credential sails straight past
`required_status_checks` because `enforce_admins` is off. Combined with the
current token scopes (`repo` is full read/write across every repo the
account can see, not scoped to this one), the blast radius of a leaked token
is "push anything to `main`, unreviewed, checks or no checks."

**Operator decision for this session (2026-08-28):** audit + runbook only.
`enforce_admins` stays `false` and the token is not rotated or narrowed in
this session — see § Required order below for why flipping it first would be
actively harmful, and do these steps in order, not this one alone.

## Required order — do not skip ahead

Flipping `enforce_admins: true` **before** fixing the push path is a
self-lockout: the mirror push in `skills/session-end/SKILL.md` runs
`git push github HEAD` directly against `main` under an admin-scoped
identity. With `enforce_admins: true` and `required_status_checks` set, that
push would need `main`'s HEAD to already carry a green status check for the
exact SHA being pushed — which a bare `git push` from a local mirror step can
never satisfy (there is no PR, so no check run is ever attached to that SHA
before the push happens). The next `/close` would fail outright.

So the order is load-bearing, not a suggestion:

### Step 1 (repo change, reviewable via MR) — stop pushing straight to protected `main`

Change the `github-mirror-push` block in `skills/session-end/SKILL.md` so it
no longer writes `main` directly. Two options, either is acceptable:

- **Option A — branch + PR.** Push to `mirror/<date>` (or `mirror/<session-id>`)
  instead of `main`, then open (or auto-merge, if the repo's protection allows
  it later) a PR. Keeps the mirror push mechanism simple; adds a PR per close.
- **Option B — deploy-key / bot identity with an explicit admin bypass.** Use a
  dedicated deploy key or GitHub App installation scoped to `contents:write`
  on this one repo, and add that bot identity to the branch protection's
  "allow specified actors to bypass required pull requests" list (GitHub
  Enterprise/Team feature — verify plan tier supports it before committing to
  this path). Keeps the direct-push mechanism but makes the bypass an
  explicit, auditable allowlist entry instead of "any admin token".

This step is a normal code change — it goes through the GitLab MR review path
like everything else in this repo. It is **not** a `gh api` operator action.

### Step 2 (operator action) — narrow the token

Once Step 1 lands (the push path no longer needs a broad admin-capable
token), narrow what actually authenticates the mirror push:

```bash
# operator action — create a fine-grained PAT
# 1. https://github.com/settings/tokens?type=beta
# 2. Resource owner: Kanevry (or the account that owns the mirror)
# 3. Repository access: "Only select repositories" → session-orchestrator
# 4. Permissions: Contents → Read and write (this is the ONLY permission the
#    mirror push needs). Leave every other permission at "No access".
# 5. Set an expiration (this repo's Vercel-deploy blast radius argues for a
#    short one, e.g. 90 days, with a calendar reminder to rotate).

# operator action — verify the new token's actual scope before swapping it in
gh auth status --hostname github.com

# operator action — re-point the local git credential helper / gh auth login
# at the new token, then re-run the audit script to confirm the scope finding
# clears:
node scripts/github-protection-audit.mjs
```

A fine-grained PAT reports differently from a classic PAT under
`gh auth status` (no bracketed scope list — fine-grained tokens carry their
permissions server-side, not as a local scope string). If `token_scopes`
comes back empty for a fine-grained token, treat that as expected, not as a
`parse-error` — the audit script's `token-scope-too-broad` finding is
evaluated against the classic-scope list (`UNSAFE_TOKEN_SCOPES` in
`scripts/github-protection-audit.mjs`) and does not currently classify
fine-grained-token permissions; a human check of the token's configured
permissions (step 4 above) is still required after this step.

### Step 3 (operator action) — only now enable `enforce_admins`

```bash
# operator action — flip enforce_admins on, now that step 1 removed the
# only path that needed to bypass it and step 2 has already narrowed the
# credential that authenticates any remaining admin-scoped access.
gh api -X POST repos/Kanevry/session-orchestrator/branches/main/protection/enforce_admins

# operator action — verify
node scripts/github-protection-audit.mjs
# expect: "enforce_admins": true, and the "enforce-admins-disabled" finding
# gone from the findings array.
```

Do not run this command until Steps 1 and 2 are both confirmed — that is the
entire point of the ordering above.

## Running the audit

```bash
node scripts/github-protection-audit.mjs
```

Read-only. Never calls `gh api -X PUT/PATCH/DELETE`, never touches the token.
Prints exactly one JSON object on stdout:

- **Success** (branch protection was measured, whether or not it found
  anything to flag): the full envelope — `repo`, `branch`, `enforce_admins`,
  `required_status_checks`, `required_pull_request_reviews`,
  `allow_force_pushes`, `token_scopes`, and a `findings` array (may be empty
  — an empty array means "measured and clean", not "did not check"). Exit
  code `0`.
- **Degraded** (the measurement itself could not be taken — `gh` missing, not
  authenticated, timed out, or a query error): `{ "degraded": "<reason>",
  "message": "..." }`. Exit code `2`. **Never read a degraded result as
  "clean" — it means the audit could not run, not that nothing was found.**
  `degraded` reasons: `no-github-remote`, `cli-missing`, `timeout`,
  `auth-error`, `parse-error`, `query-failed`.

Findings the script currently emits:

| id | severity | fires when |
|---|---|---|
| `branch-not-protected` | critical | the branch has NO protection configured at all (HTTP 404 from the protection endpoint) |
| `enforce-admins-disabled` | high | `enforce_admins.enabled` is `false` |
| `token-scope-too-broad` | medium | the authenticated token carries a classic scope broader than a mirror push needs (`repo`, `admin:org`, `admin:repo_hook`, `admin:public_key`, `admin:enterprise`, `delete_repo`, `site_admin`) |
| `no-required-status-checks` | medium | `required_status_checks` is absent or configured with zero contexts |

Run it any time you change branch protection, rotate the mirror token, or
touch the `github-mirror-push` block in `skills/session-end/SKILL.md` — it is
the fastest way to confirm a change had the intended effect without hand
re-deriving the `gh api` output.
