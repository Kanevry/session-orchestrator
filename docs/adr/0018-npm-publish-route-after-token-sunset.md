# ADR 0018: npm publish route after the Bypass-2FA token sunset (January 2027)

> Status: Accepted · proposed 2026-11-02, accepted 2026-11-02 (owner decision queue #7906: "B mit C als Brücke: C sofort, B bis Mitte Dezember eingerichtet und einmal geprobt") · issue #1906 · owner question queue #7873 → owner asked for this comparison (queue #7900, 2026-11-02): "welche Optionen haben wir, geht das über GitLab oder ist GitHub das Beste, einfach und unkompliziert, aber so, dass es für npm passt und sauber funktioniert"
> Release path today: [`scripts/release.mjs`](../../scripts/release.mjs) (`--check`, `--publish`, `--reconcile`, `--resume-tail`) · [`skills/npm-publish/SKILL.md`](../../skills/npm-publish/SKILL.md) · curated mirror [`scripts/github-export.mjs`](../../scripts/github-export.mjs) (`mirror: curated`) · draft workflow [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml) (inert, `workflow_dispatch` only)
> Related: `release --check` row `publish-route` (#1906) reports which route is configured and turns the token route red from 2027-01-01.
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

## Context

**What changes at npm.** npm announced (GitHub changelog, 2026-07-31; banner on npmjs.com and on the token page, seen 2026-11-01) that from January 2027 a granular access token with "Bypass 2FA" can no longer publish a version directly. Such a token keeps two abilities: reading private packages and `npm stage publish`, after which a maintainer approves the staged version with 2FA on npmjs.com. The bypass flag does not skip that approval. npm's recommended replacement for unattended publishing is a trust relationship (OIDC "trusted publishing") from a CI provider it knows.

**Which providers npm trusts.** The npm documentation (read 2026-11-02) lists GitHub Actions, GitLab CI/CD pipelines on **GitLab.com** with shared runners, and CircleCI (added 2026-04-06). It states that self-hosted runners are not supported and that trusted publishing works only with cloud-hosted runners. A custom OIDC issuer is an open feature request (npm/cli#9104), not a shipped capability. Our GitLab is self-hosted: it cannot be an npm trusted publisher today.

**How we release today.** `release.mjs --publish` runs in the owner's checkout: 31 preflight rows, `npm publish` with `NPM_TOKEN` from `.env.local` (granular token, Bypass 2FA, 90 days), then the tail: tag after the npm receipt, push main and tag to origin, export the curated snapshot and push it as `github/main` plus the tag, GitHub release, live-site poll, `--reconcile` until installable. The token `m4-release-so-lso-2026-11-01` expires 2027-01-30 but stops publishing with the January change. The 5.17.0 release on 2026-11-01 ran this way end to end.

**Facts that constrain the options.**
- The public mirror is a curated snapshot (`.orchestrator/policy/public-export.json`), not the source tree. Every path in `package.json` `files[]` lies inside the export include list (checked 2026-11-01 by the W3 session review), so `npm pack` on the snapshot yields the same archive as on the source commit. The GitHub mirror already runs CI on every snapshot (`.github/workflows/test.yml`).
- The GitHub remote's push URL is normally blocked (`no_push-blocked-by-lead-…`, #1631); only the release tail and `/close` unblock it. A GitHub-side publish therefore sits behind the same gate the mirror push already has.
- The token path needs an owner action every 90 days (token creation requires a security key) and, after January, an owner click per release (approval of the staged version).
- `release.mjs` has the integrity chain for the token path (`--check` rows, receipt, `--reconcile` hash comparison); any new route must keep "tag only after npm accepted the version" or an equivalent proof.

## Decision

Decided by the owner on 2026-11-02 (queue #7906, the recommendation): **Option B — GitHub Actions trusted publisher on the curated mirror, with Option C as the bridge.** The last step of a release (the `npm publish`) moves into the mirror's workflow, triggered by the tag the release tail already pushes; `release.mjs` keeps every preflight row and the mirror export, hands the publish to GitHub, and verifies the result with `--reconcile` exactly as today. Until that is set up and rehearsed once with a real version, releases use Option C (stage with a token, owner approves on npmjs.com).

**What the decision means in dates and code (lead order queue #8002, 2026-11-02):**

- **C is in force now.** `release.mjs --publish` runs `npm stage publish` on the checked archive, proves the staged version (`+ <pkg>@<version>` line or `npm stage list`), writes the publish proof with `staged: {at, stageId}` and stops. The owner approves the version on npmjs.com with 2FA; every release files that click as an owner-queue item of class `owner-handlung` with `--owner-only 2fa`. After the approval, `--resume-tail --target X.Y.Z` runs `--reconcile` first and only then tags, pushes, creates the GitHub release and checks the site. The direct route stays reachable as `--publish --direct` until npm closes it; the `publish-route` row judges the sunset for that route only.
- **B by 2026-12-15, rehearsed once.** The owner configures the Trusted Publisher on npmjs.com and the GitHub environment with a required reviewer (one bundled owner question with the step list, filed from the lead queue with a `--not-before` that leaves rehearsal time before 15 December). Code: arm `publish.yml` on the tag push, let `release.mjs --publish` hand the publish to the workflow and wait for the registry, keep C as the fallback when GitHub is unreachable. The rehearsal is a real patch version.
- No release during the day (fleet rest rule); merges after announcement to the lead.

Plain words: npm accepts packages from January on only from build systems it knows by name, and GitHub, GitLab.com and CircleCI are the only names on that list, so our own GitLab cannot be one of them; because the release already pushes a tested copy of the code to GitHub, that copy is the right place to run the publish, and until that is switched on, each release ends with one approval click by the owner on npmjs.com.

## Options

### Option A — GitLab CI on our self-hosted GitLab as npm trusted publisher (OIDC)

- **Feasibility:** not available. npm trusts GitLab.com only; a self-hosted instance is not accepted as an OIDC issuer (npm docs 2026-11-02; npm/cli#9104 open). A variant that mirrors the repo to a GitLab.com project just to publish adds a second public mirror next to GitHub for no gain.
- **Effort:** none possible today; revisit when npm ships custom issuers.
- **Risk:** none; it simply does not exist.
- **Mirror dependence:** none.
- **Verdict:** rejected for now. Revisit trigger: npm/cli#9104 closed with a shipped feature, or GitLab.com listed as "any instance".

### Option B — GitHub Actions trusted publisher via the curated mirror (recommended)

- **How:** the owner configures a Trusted Publisher on npmjs.com for `session-orchestrator` (GitHub, repo `Kanevry/session-orchestrator`, workflow `publish.yml`, bound to a GitHub environment with required reviewers). The workflow runs on the pushed release tag (not on dispatch), checks the tag equals `v`+`package.json` version, runs `npm ci`, `npm audit signatures`, `npm publish --provenance --access public`. `release.mjs --publish` changes to: preflight as today, tag the source commit, push origin, export and push the snapshot and the tag to GitHub, then poll the registry (`--reconcile`) until the version is installable. The receipt boundary moves from "npm accepted the upload" to "GitHub run finished and the registry shows the version"; the tag is pushed first, so the rollback for a failed run is to fix forward (new patch version), as it is today after a failed tail.
- **Effort:** medium. Owner: one-time Trusted Publisher setup plus the GitHub environment (two clicks, no secret). Code: arm the workflow trigger (tag push), restructure `release.mjs --publish` (drop the local `npm publish`, keep the tail, add the GitHub-run wait), update `skills/npm-publish/SKILL.md` and the public-release runbook of the lead repository, one rehearsal release before 2027-01-01 (AC 1 of #1906). Estimate: one session.
- **Risk:** the publish now depends on the GitHub mirror being reachable and on the snapshot CI; a GitHub outage delays a release instead of the owner's laptop. Anyone with write access to the mirror could trigger the workflow — mitigated by the environment with required reviewers (the owner approves the run) and by the tag check. Provenance attestations will reference the public repository, which is what consumers can verify.
- **Mirror dependence:** total — the publish IS the mirror push. The pre-push smoke (#1911) and the `head-pushed-github` preflight rows already make that push a gated step.
- **What is already there:** the inert workflow draft (#1906), the `publish-route` row that reports `trusted-publishing` once the workflow is live, the checklist in the workflow comment and the skill.

### Option C — granular token, stage and approve (bridge, and the fallback)

- **How:** keep a granular token (read-write, scoped to the package, no bypass flag needed after January). `release.mjs --publish` calls `npm stage publish` instead of `npm publish`; the owner approves the staged version on npmjs.com with 2FA; `--reconcile` waits for the version to become installable, the tail runs after that.
- **Effort:** small. `release.mjs`: use the stage command, poll for the approval, keep the receipt logic; skill text; token rotation every ≤90 days with a security key (owner).
- **Risk:** every release waits for a human click, so an unattended night release stops at the staging step until the owner is awake. The token stays a secret on the release host (`.env.local`), rotated by hand; the approval step is the control npm wants.
- **Mirror dependence:** none for the publish; the mirror push stays the tail step as today.
- **Verdict:** the bridge until Option B is rehearsed, and the fallback when GitHub is unavailable.

### Option D — interactive 2FA OTP in a terminal

Rejected: no autonomous release at all, and the OTP prompt does not work in the session shells (verified in `skills/npm-publish/SKILL.md` failure table).

## Consequences

- With Option B the release has two verifiable halves: GitLab (source commit, preflight, tag) and GitHub (publish with provenance). `release --check` must grow a row that the Trusted Publisher is configured (npm exposes it on the package page; the CLI has `npm trust` in v12 — to be checked when implementing).
- The `publish-route` row flips from `token` to `trusted-publishing` as soon as the workflow is armed; the token row's red state after 2027-01-01 then no longer matters.
- Option C keeps working after January without code beyond the `stage` call, so it is also the safety net if Option B's rehearsal fails late in December.
- Owner-only steps in both: Trusted Publisher configuration and environment reviewers (B), token minting with a security key and per-release approval (C). Neither can be done by a session.

## Alternatives considered

Covered above as Options A and D. A fourth idea, publishing from the m5 host instead of the owner's laptop, changes nothing about the token sunset and was not pursued.

## Sources

- npm docs, Trusted publishing for npm packages (read 2026-11-02): GitHub Actions, GitLab.com pipelines, CircleCI; cloud-hosted runners only.
- GitHub changelog 2026-07-31, Restricting npm bypass-2FA granular access tokens: January 2027 target, tokens keep read and `stage publish`, approval needs 2FA.
- GitHub changelog 2026-04-06, npm trusted publishing now supports CircleCI.
- npm/cli#9104, Support custom OIDC Identity Provider for Trusted Publishing (open).
- npm docs, `npm stage` (v11/v12): staging never prompts for 2FA, approval does.

## Implementation note (2026-11-02)

Option B is built as an opt-in route; the decision above is unchanged. The default `--publish` stays Option C.

- `.github/workflows/publish.yml` is armed. It runs on a pushed tag `v*` only. Job `guard` has no environment: it checks the tag against the `package.json` version and asks the registry; HTTP 200 ends the run without publishing, 404 runs the `publish` job, anything else fails. Job `publish` uses the environment `npm-publish` (required reviewer: the owner), has `id-token: write` only there, checks npm >= 11.5.1, and runs `npm ci`, `npm audit signatures` and `npm publish --provenance --access public`. No npm token or secret.
- The guard job exists because the tag push can come after npm already has the version (a route C or `--direct` release whose tail pushes the tag afterwards). Without it that run would wait for an approval and then fail on a version that already exists.
- `scripts/lib/release-trusted.mjs` checks the receipt from public registry data. Two facts were measured on sigstore@5.0.0: the public provenance binds the workflow repository, workflow path and ref, the git commit and the tarball sha512; and the packument's `_npmUser.trustedPublisher` marks an OIDC publish. On top of that the receipt requires the downloaded tarball's sha512 to equal `dist.integrity` (the fetcher refuses redirects and accepts only the exact tarball URL) and reads the git commit only from the provenance entry of this repository. Content is compared per file because GitHub packs its own tarball. Ceiling: no local sigstore signature verification; consumers run `npm audit signatures`.
- The GitHub environment `npm-publish` has a required reviewer (the owner) and a deployment rule that admits only tags `v*`, so a run from a branch cannot reach it.
- `release.mjs --publish --trusted` (refused with `--direct`) writes the proof, pushes the tag and the curated snapshot, waits up to a deadline for the registry and verifies the receipt. Under route B the tag is pushed before npm has the version, as accepted above; a failed run is fixed forward with a new patch version, never by re-tagging. The `publish-route` row reports the armed workflow; `release --check --trusted` adds the trusted-publisher evidence (a plain `--check` shows only the token route plus whether the workflow is armed); it is evidence only, because npm does not show the trusted-publisher configuration without a 2FA login. This is how the Consequences item "`release --check` must grow a row that the Trusted Publisher is configured" was resolved: the row cannot prove the configuration, so the first `--trusted` release does, through the receipt's `_npmUser.trustedPublisher` marker.

Remaining: the owner's one-time Trusted Publisher setup on npmjs.com (environment `npm-publish`, workflow `publish.yml`), the first rehearsal with a real patch version, and the later switch of the default to route B (own issue). `publish.yml` reaches GitHub with the next curated export.
