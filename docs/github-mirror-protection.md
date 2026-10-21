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
- `github` (the mirror) is pushed **directly** by `git push github HEAD` in the
  `github-mirror-push` block of `skills/session-end/SKILL.md` (`:238`, measured
  2026-09-09) — no MR, no review, no gate. Any session's `/close` does this
  the moment a `github` remote exists, unless the Session Config sets
  `mirror: none` (#1034: an absent key still pushes, so this repo — which sets
  no `mirror:` key — mirrors on every `/close`).
  **Since #1631 this repo sets `mirror: curated`:** the block no longer pushes
  `HEAD` but one verified snapshot commit (`git push github <sha>:refs/heads/main`)
  built by `scripts/github-export.mjs` without the paths in
  `.orchestrator/policy/public-export.json` and without the private history
  (see § Curated public mirror below). It is still a direct push with no MR.
  Publish only through `/close` (session-end § 4.4): pushing the export by hand
  skips its source anchor, push-URL check and pre-push verification.
  `scripts/release.mjs` (`tagAndPush`) pushes `main` + the tag on every
  `--publish`; under `mirror: curated` it pushes the export snapshot and tags
  that snapshot instead (see § Releases under `mirror: curated`).
- **The push runs on the operator's machine, not in CI.** There is no GitLab CI
  mirror job and no CI variable holding a GitHub token (`glab api
  projects/:id/variables` → only `SCHEMA_DRIFT_TOKEN`, measured 2026-09-09).
  The credential is the local `gh auth git-credential` helper (macOS keychain)
  — a gh-CLI OAuth token (`gho_…`) on account `Kanevry`, not a classic PAT;
  `gh auth status` shows it as `Token: gho_***`. So "rotate the CI secret" is
  not an available mitigation here — the credential lives on one laptop.
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

## Current measured state (2026-09-09 @ `c2e19604`, read-only `gh api`)

```bash
gh api repos/Kanevry/session-orchestrator/branches/main/protection
gh api repos/Kanevry/session-orchestrator/rulesets     # → []  (no ruleset layer at all)
gh auth status --hostname github.com                   # → account Kanevry (keyring), gho_*** OAuth token
```

```json
{
  "repo": "Kanevry/session-orchestrator",
  "branch": "main",
  "enforce_admins": false,
  "required_status_checks": { "strict": true, "contexts": ["test (ubuntu-latest)", "test (macos-latest)", "security"] },
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true,
  "rulesets": [],
  "token_scopes": ["admin:public_key", "gist", "read:org", "repo", "workflow"],
  "findings": [
    { "id": "enforce-admins-disabled", "severity": "high", "message": "enforce_admins is false — an admin-scoped push (or token) bypasses required_status_checks entirely." },
    { "id": "token-scope-too-broad", "severity": "medium", "message": "Token scope(s) admin:public_key, repo exceed what a mirror push needs (fine-grained contents:write on this one repo)." }
  ]
}
```

Unchanged since the 2026-08-28 reading: same two findings, same values. Note
`required_pull_request_reviews` and `restrictions` are `null` (absent), not
`false` — there is no review requirement and no push allowlist on the mirror.

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
**Re-confirmed 2026-09-09 (#1079):** still docs-only. The push-path change
(Step 1) is a separate follow-up issue; `enforce_admins` stays `false` until it
lands.

## Required order — do not skip ahead

Flipping `enforce_admins: true` **before** fixing the push path is a
self-lockout: the mirror push in `skills/session-end/SKILL.md` runs
`git push github HEAD` directly against `main` under an admin-scoped
identity. With `enforce_admins: true` and `required_status_checks` set, that
push would need `main`'s HEAD to already carry a green status check for the
exact SHA being pushed — which a bare `git push` from a local mirror step can
never satisfy (there is no PR, so no check run is ever attached to that SHA
before the push happens). The next `/close` would fail outright.

So the order is load-bearing, not a suggestion. Exactly three steps, in this
sequence — (1) push path, (2) token, (3) `enforce_admins`:

### Step 1 (repo change, reviewable via MR) — stop pushing straight to protected `main`

Change **both** direct writers so neither targets `main`: the
`github-mirror-push` block in `skills/session-end/SKILL.md` (`:238`) and the
remote loop in `scripts/release.mjs` (`tagAndPush`). Two options, either is
acceptable:

- **Option A — `mirror/<session-id>` branch + PR with auto-merge.** Push to
  `mirror/<session-id>` instead of `main`, open a PR, and enable auto-merge so
  the required status checks gate the merge rather than blocking the push.
  Keeps the mirror push mechanism simple; adds a PR per close.
- **Option B — bot identity on a ruleset bypass list.** Use a dedicated deploy
  key or GitHub App installation scoped to `contents:write` on this one repo,
  and add that bot identity to a repository **ruleset**'s bypass-actors list.
  Note `gh api .../rulesets` → `[]` today (2026-09-09), so this option means
  creating the ruleset layer, not editing one — and verify the plan tier
  supports bypass actors before committing to this path. Keeps the direct-push
  mechanism but makes the bypass an explicit, auditable allowlist entry
  instead of "any admin token".

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

**Revoking the old credential:** it is a gh-CLI OAuth token, not a PAT, so it
is not managed at `https://github.com/settings/tokens` — revoke it with
`gh auth logout --hostname github.com` or from the account's OAuth-App
authorisation list at `https://github.com/settings/applications` (revoke the
"GitHub CLI" entry), never the PAT settings page. Swap the git credential
helper onto the new fine-grained PAT first, then revoke the OAuth token, so
the mirror push keeps working throughout. A later `gh auth login` re-requests
gh CLI's own OAuth scopes from scratch — that re-grant is unrelated to, and
does not restore, the token revoked here.

A fine-grained PAT reports differently from a gh-CLI OAuth token under
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

## Curated public mirror (`mirror: curated`, #1631, #1594)

GitLab stays the full private repository. The GitHub mirror receives a curated
state: `scripts/github-export.mjs` builds ONE squash commit per export with
plumbing on a temporary index (the real index, working tree and `HEAD` are
untouched):

1. Graph integrity: every git call runs with `GIT_NO_REPLACE_OBJECTS=1`, and
   the export refuses when `refs/replace/*` or `info/grafts` exist — either
   would let the checks read a different object graph than `git push` sends.
2. Remote anchor: the parent is ALWAYS the public GitHub main.
   `refs/remotes/github/main` must resolve and must equal
   `git ls-remote github refs/heads/main` (one read-only network call); a
   mismatch or a failed call refuses ("fetch github first").
   `refs/heads/github-export` is only the output slot — overwritten each run,
   never read as a parent — so no older, forged or stale export commit can sit
   between the public main and the new snapshot.
3. `read-tree <source>^{tree}`, drop every path the policy excludes (exact
   file, or directory prefix ending in `/` — `docs/audits/` never drops a
   sibling file whose name merely starts with `docs/audits`), `write-tree`.
4. `commit-tree <tree> -p <verified github main>` with the trailer
   `Source-Commit: <full source sha>`.
5. Strict leakage scan of the snapshot (`check-owner-leakage.mjs
   --public-export` in a temporary detached worktree, removed afterwards),
   then the citation guard on the same worktree: validate-plugin's path-check
   and relative-link modules run on the snapshot, and any finding that points
   into an excluded path refuses the export — the GitHub CI runs the same
   checks, so a public doc citing a private path would otherwise turn it red.
6. `update-ref refs/heads/github-export <new> <old-or-zero>` — compare-and-swap.

The anchor in step 2 is read through the FETCH URL, but `git push github` goes
to the PUSH URL (`remote.github.pushurl`, `url.*.pushInsteadOf`). When the two
differ, the verified main describes a different repository than the one that
receives the push, so the export refuses (a `--dry-run` only warns, because it
publishes nothing). The URLs are compared, never printed.

**This repo today:** `remote.github.pushurl` is deliberately set to a blocking
placeholder, so a real curated export refuses here until that block is lifted.
That is intended — mirror pushes stay blocked until #1645 — and lifting the
pushurl block (so the push URL equals the fetch URL again) is a required step
before the first curated push.

Exit codes: `0` created (prints the sha), `3` nothing to publish (the curated
tree equals github main's; the export ref is not touched), `1` refused with a
one-line reason (graph integrity, remote anchor, the published snapshot's
`Source-Commit` not an ancestor of the source, an excluded path surviving in
the written tree, the leakage scan, an excluded-path citation, or a lost
compare-and-swap). `--dry-run` prints the counts and scans without moving the
ref.

Session-end (`skills/session-end/SKILL.md` § 4.4) adds the source anchor and a
final check:

- It exports only when `HEAD` is on branch `main` AND equals
  `git ls-remote origin refs/heads/main` (after the 4.3 push), and passes that
  sha as `--source`. A feature branch, or a local main ahead of origin's main,
  skips with exit 0 and pushes nothing — GitHub main deploys production, so
  only the reviewed GitLab main may reach it. An unreadable origin is a WARN
  with exit 1.
- The push is bound to the scanned commit: the block reads the export sha from
  the CLI's stdout only (stderr goes straight to the operator), requires the
  push URL to equal the fetch URL, and runs
  `github-export.mjs --verify <sha> --source <origin main>` right before the
  push — graph integrity, github main re-verified via `ls-remote`, exactly one
  commit on it with `Source-Commit: <origin main>`, and no excluded path in
  `git ls-tree -r <sha>`. It then pushes that sha, never the export ref name,
  so moving the ref after the scan changes nothing.
- The push is a plain `git push github <sha>:refs/heads/main`.
  No lease and no force flag: the new commit's parent IS the verified sha, and
  a plain push is fast-forward-only, so GitHub itself rejects it when its main
  moved to anything that is not an ancestor of that sha — the same anchor a
  lease would enforce, and branch protection (`allow_force_pushes: false`)
  stays untouched.

A blob that only exists under an excluded path is never reachable from GitHub:
the one new commit's tree omits it and its parent is already public. The
harness-audit check `github-mirror-sync` counts "ahead" from the
`Source-Commit` trailer of `github/main` in this mode, not from `github/main`
itself.

### Releases under `mirror: curated` (#1645)

`scripts/release.mjs` reads `mirror` the same way session-end does
(`readMirrorSetting` in `scripts/lib/github-export.mjs`, i.e. `parse-config.mjs`
inside the repo):

- Preflight `head-pushed-github` compares github/main's `Source-Commit` trailer
  with `HEAD`, not the shas (the public main is a snapshot and never equals
  `HEAD`). The GitHub CI row asks about that snapshot sha, the commit GitHub
  actually built. A release therefore needs `/close` to have published the
  snapshot of the release commit first; otherwise the row is red.
- Preflight `github-push-url` (#1693) is red while `remote.github.pushurl` or
  `pushInsteadOf` diverges from the fetch URL (the #1631 lock). Without it the
  lock surfaced only in the publish tail, after the irreversible npm receipt.
  Lift the lock before `--check`, and set it again only after `--publish` ends.
- `--publish` pushes `main` and the annotated tag to `origin` as before. To
  `github` it never pushes `main`, `HEAD` or the release commit: it fetches
  github main, runs the export with `--source <release commit>`, re-verifies a
  newly built snapshot by sha and pushes that sha to `refs/heads/main` (normally
  nothing is built: github main already is the snapshot of the release commit).
- Before `git tag`, the publish tail refuses (nothing tagged, nothing pushed)
  unless `HEAD` is still the commit the preflight checked, on branch `main`,
  and equal to `git ls-remote origin refs/heads/main` — the npm publish sits
  between preflight and tag, and a parallel session switching branch in that
  window would otherwise get an unreviewed commit snapshotted onto GitHub main.
- `mirror: none` skips GitHub entirely: no push, no tag, no GitHub release; the
  github preflight rows report `skipped`.
- **Tag decision: same tag name, different target sha.** On GitLab `v<X.Y.Z>`
  is the annotated tag on the release commit; on GitHub `v<X.Y.Z>` is a
  lightweight tag on the public snapshot whose `Source-Commit` is that release
  commit. The GitHub release (`gh release create --verify-tag`) attaches to the
  GitHub tag. A snapshot whose tree matches but whose trailer names another
  commit is refused rather than tagged.

### Keyless checkouts are fail-closed (#1645)

The `mirror` key lives in the working tree's CLAUDE.md, so a branch or checkout
cut before the repo adopted `mirror: curated` has no key and used to fall back
to `git push github HEAD` — the full private history. Every plain push (key
absent or `mirror: github`) now first runs `github-export.mjs --plain-guard`
(session-end § 4.4) or `plainPushGuard` (release preflight row
`github-mirror-mode` and the publish tail): when `HEAD` or origin's main
(`git ls-remote`, fetched when the object is not local) carries
`.orchestrator/policy/public-export.json`, the plain push is refused with a
WARN and exit 1, and nothing is pushed. An unreadable origin refuses too, and
so does a repo with a `github` but no `origin` remote unless `mirror: github`
is set explicitly — there is no upstream policy to check against.

Why the policy file and not `origin/main:CLAUDE.md`: the policy file is the one
artefact that exists exactly when the repo publishes curated, its presence is a
single `git cat-file -e`, and it needs none of parse-config's file resolution
(CLAUDE.md vs AGENTS.md, `SO_CONFIG_FILE`). Reading the key from origin would
also override an intended branch-local config, while the guard only ever
blocks.

**Still not covered:** a hand-typed `git push github …` bypasses all of this;
only the pushurl block stops it.

