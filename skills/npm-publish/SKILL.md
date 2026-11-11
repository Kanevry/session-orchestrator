---
name: npm-publish
user-invocable: false
model: sonnet
description: Use when publishing this package to npm — a version release (npm publish), verifying the registry/pi.dev listing, or diagnosing npm auth failures (E403 2FA/token errors). Token-based flow via NPM_TOKEN in .env.local with a temp userconfig, the leakage gate before every publish, post-publish verification and marker/badge upkeep. Trigger on "publish to npm", "npm release", "E403 publish error".
---

# npm-publish — token auth, and the calls the script cannot make

> **The release itself is `/release` → `scripts/release.mjs`.** That script mechanizes the whole sequence: version surfaces, CHANGELOG gate, drift sweep, tag/registry collision, CI, leakage gate, publish, the target-confirmed npm receipt boundary, tag-after-receipt, push to both remotes (under `mirror: curated` the GitHub side gets the verified export snapshot as main and the tag on that snapshot, never the release commit — `docs/github-mirror-protection.md` § Releases under `mirror: curated`), GitHub-release handling, and live-site poll. This skill does not restate it.
>
> What lives here is the half a script cannot own: the **token setup**, the **auth failure diagnosis**, and the **judgement calls** — which version, what a leak means, when to abort rather than repair.

## Why this skill exists

npm requires 2FA **or** a granular access token with "Bypass 2FA" for every publish (policy active since 2025; legacy tokens were removed Nov 2025 — only granular tokens exist). The failure mode is confusing: `npm publish` fails with **E403 and NO OTP prompt** when the account either has no 2FA enrolled or the supplied token lacks the bypass flag. Three dead ends verified empirically: plain `npm publish` (E403), `--auth-type=web` (no web flow exists for publish), PTY-forced publish (same E403). The ONLY non-interactive path is a correctly-configured granular token.

## Token requirements (all four mandatory)

Create at https://www.npmjs.com/settings/<user>/tokens → Generate New Token → **Granular Access Token**:

1. **Permissions: Read and write** (Packages and scopes).
2. **Packages: "All packages"** for a FIRST publish (the package does not exist yet, so per-package selection cannot include it). After the first publish, re-create scoped to the single package — least privilege.
3. **"Bypass two-factor authentication (2FA)" enabled** — this is the checkbox whose absence produces the E403-without-prompt. npm shows a red security warning here and recommends Trusted Publishing for CI/CD; for interactive operator-assisted releases the short-lived bypass token is acceptable.
4. **Short expiration** — write tokens default to 7 days (90 max). Take the default.

## Auth resolution order

1. `NPM_TOKEN` in `.env.local` at the repo root (gitignored — verify with `git check-ignore .env.local` before writing; also confirm no `.env` pattern in the `files` whitelist of package.json). `scripts/release.mjs` refuses to read the token if that ignore check fails.
2. Interactive fallback: operator runs `npm publish --access public` in a real terminal (only works when account 2FA is enrolled — OTP prompt appears).

`release --check` verifies the token before any publish: `npm-token-live` (`npm whoami`) proves it authenticates, `npm-token-publish` reads `npm token list --json`, finds the token in use by its abbreviated `npm_xxxx...xxxx` form, and goes red when it lacks `bypass_2fa`, write `permissions`, a matching `scopes` entry, or has passed `expiry`/been `revoked` — the 5.13.0 EOTP case, where `whoami` was green. `npm token list` works with a granular token; `npm profile get` does not (npm 11.19.1, 2026-10-21).

**Never** put the token in the tracked `.npmrc` (it holds `ignore-scripts=true` per SEC-020 and is committed), never persist it into `~/.npmrc`, never echo it into logs.

## The three judgement calls

The script gates mechanics. These three are yours, and it will not make them for you.

**1. Which version is the right one.** Semver per `.claude/rules/development.md` § Package Lifecycle & Versioning: patch = fixes/docs/internal refactor; minor = additive and backwards-compatible; major = removed or renamed exports, or changed runtime behaviour — and a major never merges without a migration guide and a `BREAKING CHANGE:` footer. The script validates the *shape* `X.Y.Z` and nothing about whether the number matches the diff. Read the CHANGELOG entry you just wrote and ask whether a consumer pinning `^` would be broken by it; if yes, the bump is a major regardless of how small the diff looks.

**2. What a leak means when one is found.** A hit from the leakage gate is not a pattern to silence. Decide which of two it is: a real leak (fix `package.json` `files`, re-pack, re-check) or genuine over-matching (fix `LEAKAGE_PATTERNS` in `scripts/release.mjs` **with a test**). There is no third option, and neither is "publish anyway and clean it up in the next version" — an npm publish is not revocable, and unpublishing burns the version number permanently. Operator handling detail: `docs/distribution/npm-publish-checklist.md` § 3.

**3. When to abort instead of repair.** Abort — do not patch forward — when the failure is upstream of the target-confirmed npm receipt: a red preflight row, a lagging `github` mirror (under `mirror: curated`: github/main is not yet the snapshot of the release commit — run `/close` first), CI not green on the exact commit **on either platform** (`--check` carries both `ci-green-on-head` for GitLab and `ci-green-on-head-github` for the mirror, whose macOS matrix leg has no GitLab equivalent), a dead token, or a publish that did not issue the target receipt. These are cheap to fix and re-run from the top. Repair-in-place is only appropriate *after* that receipt, where the version is already immutable: registry availability (`--reconcile`), a missing GitHub release, or a lagging site deploy can be reconciled because npm already has the correct artifact. When `--publish` reports **Post-publish reconciliation required**, **do not rerun `--publish`**; repair the listed state directly. `skills/release/SKILL.md` § Abort criteria is the operative list.

## Failure-mode table

| Symptom | Cause | Fix |
|---|---|---|
| `E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required` — no OTP prompt | Account has no 2FA enrolled AND token (if any) lacks Bypass-2FA | Create granular token with all four requirements above, or enroll 2FA |
| Same E403 despite a fresh token | Token created without the Bypass-2FA checkbox, or Read-only, or package-scoped on a first publish | Re-create: RW + All packages + Bypass-2FA |
| `EOTP` from `npm publish` while `npm whoami` is green | Granular token without Bypass-2FA (5.13.0) | Re-create with Bypass-2FA; `release --check` row `npm-token-publish` now catches it before the publish |
| `npm whoami` silent or non-zero | Token expired, or `.env.local` missing | Re-create the token; do not proceed — the preflight fails this row on purpose |
| `E404` on `npm view <pkg>@<target>` after a target-confirmed publish receipt (npm answered HTTP 202) | The upload is **accepted, not yet available**. npm scans every new publish before it becomes installable: "typically around five minutes", "up to 15 minutes or more" at peak or depending on content/size, no service guarantee; the outcome may be published, **held for manual review**, or **blocked** (GitHub changelog 2026-07-28, read 2026-10-08, npm CLI 11.19.0). 5.10.0 stayed 404 for more than 25 minutes. A 404 alone does **not** tell you which of these applies — the package token cannot see the scan state | Let the script finish its tag/push/GitHub/site tail, then run `node scripts/release.mjs --reconcile --target <target>` (read-only, resumable; exit 0 only once installable). While still `pending`, check the owner-visible side: npm says a blocked package's publisher "may receive a notification with the option to appeal" — look at the npm account notifications/e-mail of the publishing account and the package page on npmjs.com. Do **not** rerun `--publish` and do not declare it blocked from the 404 |
| `ENEEDAUTH` | No login/token at all | Token flow above, or `npm login` |
| OTP prompt appears but flow is non-interactive (`!`-prefix, script) | No TTY for the prompt | Use the token flow, or a real terminal |

## January 2027: the token route ends (#1906)

npm stops accepting a direct publish with a granular access token that bypasses 2FA in **January 2027** (banner on npmjs.com and on the token page, read 2026-11-01). Everything above — `NPM_TOKEN` in `.env.local`, the temp userconfig, `npm-token-publish` checking `bypass_2fa` — is that route. A token that is still valid on paper stops working on that date, not at its own expiry.

Three ways forward:

1. **Trusted Publishing (OIDC) from the GitHub mirror** — recommended. npm trusts the identity GitHub Actions issues to a named repository and workflow, so no npm token is stored anywhere. npm supports GitHub Actions, GitLab.com shared runners and CircleCI; our self-hosted GitLab is not supported (research 2026-11-01), so the publish has to run on the public mirror (`mirror: curated`). The workflow `.github/workflows/publish.yml` is armed on a pushed `v*` tag (job `guard`, then job `publish` gated by the GitHub environment `npm-publish`), and `node scripts/release.mjs --publish --trusted` hands the publish to it and verifies the result on the registry (§ Route B). Route C stays the default of `--publish`. Pending: the owner's Trusted Publisher setup on npmjs.com, the first rehearsal and the switch of the default. Two guards in the workflow must stay (SEC-020): the `guard` job fails unless the ref is a tag whose name equals `v` + the `package.json` version, and `npm audit signatures` runs before `npm publish`.
2. **Staged publishing** — a token with "Read and write (stage only)" uploads the version, and the owner approves it under "Staged Packages" on npmjs.com for every release. Works from here without the mirror; good as a bridge while option 1 is built.
3. **Interactive 2FA** — the operator runs `npm publish` in a terminal and types the OTP. No autonomous release any more.

`release --check` reports the configured route in the row `publish-route`: `token` when `.env.local` has an `NPM_TOKEN=` line (presence only, the value is never read into output), `trusted-publishing` when `publish.yml` exists and either grants `id-token: write` or `package.json` sets `publishConfig.provenance`, and `none` otherwise. A present token wins in the default and `--direct` modes, because those still publish with it. Under `--publish --trusted` the row judges the trusted route instead: green only when the workflow is armed and the mirror mode is known and not `none`; the trusted-publisher evidence is named in the detail but never decides. The `token` row is green until 2026-12-31 with the sunset in its detail and red from 2027-01-01 with "switch to trusted publishing (#1906)"; `none` is always red. `SO_RELEASE_NOW=<ISO date>` replaces the clock for a rehearsal.

Before arming Trusted Publishing:

- [ ] Bind the npm Trusted Publisher and the publish job's `environment` to the same GitHub environment with **required reviewers**. A tag push by any account with write access must still require approval before publishing; do not configure publishing without an environment.

**Decided (owner, queue #7906, 2026-11-02; ADR-0018 Accepted):** option 2 (staged publishing) is in force now as the bridge, option 1 (Trusted Publishing from the mirror) is due by 2026-12-15 with one rehearsed release. Option 3 stays rejected.

## Route C: staged publish, owner approval (the default of `--publish`)

`node scripts/release.mjs --publish` no longer publishes directly. It runs every preflight row as before, then `npm stage publish <checked archive> --ignore-scripts --access public` through the temp userconfig, proves the staged version (the `+ session-orchestrator@X.Y.Z` line, or `npm stage list session-orchestrator --json` naming the version), writes `.orchestrator/runtime/release-X.Y.Z.json` with `staged: {at, stageId}`, prints the next steps and exits 0. Nothing is tagged or pushed. The token needs write permission and the package scope; **the Bypass-2FA flag is no longer required** (`npm-token-publish` reports `stage-capable`), and the `publish-route` row stays green after January 2027 for this route.

The session that ran `--publish` then:

1. Files the approval as an owner action, text from the script output (`queue:<id>` into the release issue):

   ```
   owner-queue add --repo session-orchestrator --class owner-handlung --owner-only 2fa --ref 'session-orchestrator#<release-issue>' \
     --title 'Release X.Y.Z: staged version on npmjs.com approve (Staged packages, 2FA)' \
     --options 'Approve on npmjs.com|Reject (npm stage reject, 2FA)' --recommendation 'Approve on npmjs.com'
   ```

   The owner approves under "Staged packages" on npmjs.com (or `npm stage approve <stage-id>` in a real terminal; both prompt for 2FA). A rejected stage frees nothing: the version number stays used, the next release takes the next patch number.
2. After the click: `node scripts/release.mjs --resume-tail --target X.Y.Z`. It runs `--reconcile` first and refuses while the registry does not serve the proof's integrity (`pending` → run it again later), then tags the recorded commit, pushes the tags, creates the GitHub release and polls the site — exactly the tail of the direct route. **Run it after the approval, not before:** `--reconcile` polls the registry 20 times, 60 s apart, so a `--resume-tail` started before the click waits about 20 minutes and then ends with `RECONCILIATION` and nothing tagged. Never rerun `--publish` for that version; the preflight row `staged-proof-absent` turns red as long as the proof carries a `staged` block.

An exit 0 of `npm stage publish` that matches neither receipt signal still writes the proof, with `staged.confirmed: false` and the reason, and ends with exit 2: the version may be staged although the script could not prove it. Check `npm stage list session-orchestrator`; if the version is there, let the owner approve it and run `--resume-tail` (the registry check inside it is the real gate). A non-zero exit staged nothing and writes no proof; `--publish` can be rerun.
3. Rotate the token as before (§ Post-publish).

`--publish --direct` keeps the pre-2027 route (direct `npm publish` with a Bypass-2FA token, tail in one run) for the time npm still accepts it; its `publish-route` row turns red on 2027-01-01. **While the token in `.env.local` carries Bypass-2FA, `--direct` publishes with no owner step at all.** "Never unattended" (the owner's decision #7906) therefore holds only once the token is replaced by one without the bypass flag (write, scoped to the package); that swap is an owner action with a security key, filed as queue:8022. Until then `--direct` is the emergency route, not a routine one.

Ceilings, to be measured on the first real staged release: the stdout of `npm stage publish` and the JSON of `npm stage list` are documented as commands, not as shapes (npm 11.19.1, read 2026-11-02). The receipt therefore accepts either the `+ pkg@version` line (parity with `npm publish`) or any list object whose `version` equals the target; an exit 0 with neither is reported as "inspect `npm stage list`", never as success. Whether `npm stage publish` takes a tarball path like `npm publish` does is the second unmeasured point; if it refuses, nothing is staged and the preflight state is unchanged.

## Route B: trusted publishing from the GitHub mirror (opt-in, #1906)

`node scripts/release.mjs --publish --trusted` (refused together with `--direct`) hands the publish to `.github/workflows/publish.yml` on the public mirror. Route C stays the default of `--publish`; use route B for a rehearsal, or once the owner has set up the Trusted Publisher on npmjs.com (one-time, owner-only, still pending; see ADR-0018 § Implementation note).

**What the workflow does.** It runs on a pushed tag `v*` only; there is no manual dispatch. The script treats the workflow as armed only for a pure tag-push trigger: any other event, or a `push.branches`/`paths` key beside `tags`, counts as not armed. Job `guard` (no environment, so no review prompt) fails unless the tag equals `v` + the `package.json` version, then asks the registry for that version: HTTP 200 means the version is already on npm (a route C or `--direct` release whose tail pushed the tag afterwards) and the run ends without publishing; 404 starts the `publish` job; any other answer fails the run. Job `publish` is bound to the GitHub environment `npm-publish`, whose required reviewer is the owner account and whose deployment rule admits only tags `v*`. Only this job has `id-token: write`, and every `uses:` in it must be pinned to a 40-hex commit SHA for the script to count the workflow as armed. It checks that npm is at least 11.5.1, runs `npm ci` and `npm audit signatures`, then `npm publish --provenance --access public`. No npm token or secret exists anywhere in the workflow.

**What the script does.** Preflight as usual, except the two npm token rows report `not used under --trusted (no npm token involved)`. No local `npm publish`. It writes the proof before the first push, tags, pushes `origin`, pushes the curated GitHub snapshot and the tag (the tag push on GitHub starts the workflow), then waits for the registry with a deadline (default 20 minutes; `SO_RELEASE_TRUSTED_WAIT_MS` overrides it with a positive integer in ms, anything else is an error). When the version appears it checks the trusted-publish receipt from public registry data (`scripts/lib/release-trusted.mjs`, no login): `_npmUser.trustedPublisher.id` is `github`, and the SLSA provenance names the repository `https://github.com/Kanevry/session-orchestrator`, the workflow `.github/workflows/publish.yml`, the ref `refs/tags/vX.Y.Z`, the snapshot commit the script pushed and a GitHub-hosted builder, and its subject sha512 equals `dist.integrity`; the downloaded tarball's sha512 must equal `dist.integrity` too (the fetcher refuses redirects and accepts only the exact tarball URL `.../session-orchestrator/-/session-orchestrator-X.Y.Z.tgz`). Content is compared per file (sha256 over the unpacked tarball), not by tarball checksum, because GitHub packs its own tarball. Receipt states: `pending` and `unreadable` keep waiting; `mismatch`, `content-mismatch` and `refused` (no expected commit recorded) are final; `confirmed` ends the wait. Then GitHub release and live site, as in the other routes.

**What the owner does.** Approve the run in the GitHub environment `npm-publish` (the Actions run of the tag, "Review deployments"). File it as an owner action like the route C approval.

**The order differs from the other routes.** Under route B the tag is pushed BEFORE npm has the version (ADR-0018 accepts this). A failed run is fixed forward with a new patch version, never by re-tagging.

| Situation | What it means | What to do |
|---|---|---|
| Script ends `awaiting-workflow`, exit 1 | No approval, or the run still runs, within the deadline | Approve the run on GitHub, then `node scripts/release.mjs --resume-tail --target X.Y.Z`. Do not rerun `--publish` |
| Script ends `receipt-mismatch`, exit 1 (receipt state `mismatch`, `content-mismatch` or `refused`) | The registry serves something other than this tag, commit or content | Stop. Do not re-tag. Inspect the run and the version on npm; fix forward with a new patch version |
| Run fails at the npm check | The npm bundled with the runner's Node 24 is below 11.5.1 | Nothing was published. Fix the workflow, release a new patch version |
| Guard job fails | Tag and `package.json` version differ, or the registry answered neither 200 nor 404 | Nothing was published. Re-run the jobs once the cause is gone, or fix forward |
| Script ends `handoff-incomplete`, exit 1 | Tag or push failed, or `mirror: none` (no GitHub tag, so the workflow never runs) | Finish the pushes with `node scripts/release.mjs --resume-tail --target X.Y.Z`; nothing was published locally |
| Receipt `unreadable` | Registry data could not be read | Retry with `--reconcile` or `--resume-tail`; do not declare failure from this alone |

`--reconcile` and `--resume-tail` verify a trusted proof through the receipt, not through the tarball checksum; `--resume-tail` writes the confirmed receipt into the proof (`receiptAt`). Under `mirror: curated`, `--resume-tail` and `--reconcile` first check that the snapshot commit's `Source-Commit:` trailer names the release commit, before they push the GitHub tag or confirm a receipt. `--resume-tail` also refuses before any push when the `package.json` of the release commit (and, under curated, of the snapshot) does not carry version X.Y.Z. A pending receipt still pushes missing tags (the GitHub tag starts the workflow); the GitHub release and the site wait for a confirmed receipt. The `publish-route` row of a plain `release --check` shows only the token route plus whether the route B workflow is armed; `release --check --trusted` (refused with `--direct`, `--reconcile`, `--resume-tail`, `--set-version`) runs the trusted preflight and adds the trusted-publisher evidence (verified by vX, not yet verified, or not measurable). It is evidence only, never a gate, because npm does not show the trusted-publisher configuration without a 2FA login.

Ceiling: the script does not verify the sigstore signature itself. It relies on TLS to `registry.npmjs.org`; consumers verify with `npm audit signatures`.

Not done yet: the owner's Trusted Publisher setup on npmjs.com, the first rehearsal with a real patch version, and the later switch of the default to route B (own issue). `publish.yml` reaches GitHub with the next curated export.

## Post-publish — the human half

`--publish` attempts registry verification and polls the live site itself. A target-confirmed receipt plus a delayed registry result is a reconciliation outcome, not a failed publish or a retry instruction: the receipt is persisted as `.orchestrator/runtime/release-<target>.json`, and `--reconcile` resumes from it. The proof lives in the gitignored runtime dir of the checkout or worktree that ran `--publish`: run `--reconcile` from that same checkout, because any other checkout reports `proof-missing`. What still needs a person:

1. **Rotate/delete the token** at https://www.npmjs.com/settings/<user>/tokens. A token that ever transited a conversation, a screenshot, or any log is burned — rotate immediately.
2. **pi.dev gallery**: indexing is asynchronous — check https://pi.dev/packages later; do not block on it.
3. **Marker upkeep** on a first publish only (done in v3.16.0): README install matrix + npm badge, `site/index.html` install section, `docs/pi-setup.md` availability paragraph.
4. Update the release issue if the publish was part of tracked work.

## Security invariants

- `.env.local` is gitignored AND absent from the npm `files` whitelist — verify both before writing a token into it.
- Temp userconfig: `chmod 600`, deleted in a `finally` block immediately after publish.
- The leakage gate runs before EVERY publish, not only the first.
- npm's own recommendation for unattended CI/CD is **Trusted Publishing** (OIDC) — evaluate it if publishing ever moves into CI (ref: https://docs.npmjs.com/about-access-tokens).
