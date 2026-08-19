# npm Publish Checklist (Operator Runbook)

Operator runbook for publishing `session-orchestrator` to npm. Publishing is an **operator step** — it needs npm auth credentials that live outside the repo.

**The executable path is `scripts/release.mjs`, driven by `/release`.** This document is the operator-facing companion: what each phase is *for*, and what to do when one fails. It deliberately does **not** restate the script's lists — a second prose copy of a machine-checked list drifts silently, which is exactly what happened to the leakage greps below (§3).

Context: publishing to npm is what makes `pi install npm:session-orchestrator` work and gets the package indexed on the [Pi packages gallery](https://pi.dev/packages) via the `pi-package` keyword in `package.json`. See `docs/pi-setup.md` § Installation.

## 1. Pre-flight — npm auth

```bash
npm whoami
```

- No answer, or a non-zero exit, means the token is dead or absent — **stop there**. `scripts/release.mjs --check` evaluates this as its own preflight row (`evaluateNpmAuth`); the failure mode this guards is a publish that gets far enough to fail *after* the version surfaces are already committed.
- If not logged in: `npm login` (interactive), or set `NPM_TOKEN` in the gitignored `.env.local` for the non-interactive token flow (`skills/npm-publish/SKILL.md` § Token requirements).
- Confirm the account has publish rights to the `session-orchestrator` package name.

## 2. Version bump

Do **not** hand-edit version literals. They live in more places than memory holds, and the authoritative list is code:

```bash
node scripts/release.mjs --set-version X.Y.Z
```

- The set of version surfaces is `SURFACES` in `scripts/release.mjs` — the single source of truth, shared by the rewrite and the check. A version literal that exists *outside* that table is caught by the drift sweep in `--check`; a table pattern that stops matching its file is a hard error, never a silent pass.
- Editorial surfaces are **not** rewritten mechanically: the dated CHANGELOG entry and the README highlights are yours to write. `--check` enforces their presence.
- Semver discipline: `.claude/rules/development.md` § Package Lifecycle & Versioning.

## 3. Tarball review — Leakage Gate (MANDATORY, block on failure)

**The leak classes are `LEAKAGE_PATTERNS` in `scripts/release.mjs`** — applied to `npm pack --dry-run` output by `checkLeakage()`, run as a preflight row on every `--check` and before every `--publish`. Do not maintain a copy of the list here. This section carried a hand-written copy until 2026-08-19; it had drifted to six patterns against the code's seven, agreeing on neither set.

To inspect the tarball by hand:

```bash
npm pack --dry-run
```

**Why this class is dangerous.** `package.json` has a `files` whitelist, and adding one makes npm **stop honoring `.gitignore` for exclusion**. So a directory that is invisible to git can still be published — this happened once with a nested `node_modules` under `skills/claude-md-drift-check/` (fixed with a `!**/node_modules/**` negation entry). Every new top-level entry added to `files` needs its own gitignore-negation double-check. The classes that matter are the ones that carry operator data or local state: `tests/`, `.orchestrator/`, `.claude/`, `.github/`, `node_modules`, `.env*`, `owner.yaml`.

**What to do when the gate reports a hit:**

1. **Do not publish.** An npm publish is not revocable — a leaked file stays in that tarball version forever, and unpublishing burns the version number.
2. Identify whether the hit is a real leak or a pattern false-positive. Read the matched line: the gate reports the pattern name and the offending `npm notice` line.
3. If it is a real leak: fix `package.json` `files` (add the path, or a `!` negation), re-run `npm pack --dry-run`, and re-run `--check`. Never silence the pattern.
4. If the pattern genuinely over-matches: fix it in `LEAKAGE_PATTERNS` **with a test in `tests/scripts/release.test.mjs`** — never by editing prose in this file.

**Blind-scan guard.** A leak scan that parses *no* entries reports "0 leaks" with total confidence. The gate therefore also asserts a floor on parsed packed entries (`MIN_PACKED_ENTRIES` in `scripts/release.mjs`) — that single number catches an npm output-format change, an `npm notice` prefix rename, and a `files` edit that drops whole trees. Current ballpark, measured with `npm pack --dry-run` at `8984224`: **830 files, 2.9 MB packed, 8.9 MB unpacked.** A sudden drop means the scan went blind; a sudden jump means something leaked back in.

## 4. Supporting gates

These are *not* part of `--check` — run the repo's normal quality gate before the release commit:

```bash
node scripts/check-package-manager.mjs   # must exit 0 — npm-canonical guard
npm run typecheck
npm test
```

CI green on the exact commit being published is a separate, non-negotiable gate — see `commands/release.md` § Abort criteria. Local green is not evidence of CI green.

## 5. Publish

```bash
node scripts/release.mjs --publish
```

Runs the preflight first, then publishes, verifies the registry, creates the annotated tag **after** the verified publish, pushes `main` + tag to `origin` and the `github` mirror, and polls the live site.

- `--access public` is passed by the script. It is required because npm defaults only *scoped* packages to restricted, but passing it explicitly removes the ambiguity.
- The tag is never created before a registry-verified publish. That ordering is what makes the `3.18.0` state — tagged, released on GitHub, absent from npm — unreachable.
- **`--skip-ci` is refused under `--publish`** by the script itself, because it marks the CI row green without checking anything. Use it only to inspect the other preflight surfaces via `--check`.

## 6. Post-publish verification

The registry check and the live-site poll are mechanized inside `--publish`. What remains for a human:

- `npm view session-orchestrator` — spot-check that `description`, `keywords`, `homepage` rendered as intended.
- Check [pi.dev/packages](https://pi.dev/packages) for the listing. Gallery indexing runs on the Pi team's cadence — **not** instantaneous; a missing listing is not a failure until the next sync has passed.
- From a scratch directory, smoke-test the real install path: `pi install npm:session-orchestrator`.
- Confirm the GitHub release for the new tag exists. Four releases (3.15/3.18/3.19/3.20) were backfilled by hand on 2026-08-19, 5 to 31 days late, because this was a prose step.

## 7. Follow-ups (non-blocking, file as issues if skipped)

- Rotate or delete the npm token once the release is done — immediately if the value ever transited a chat, a screenshot, or a log.
- Re-check `docs/pi-setup.md` § Installation — the install options must still reflect reality.
- Confirm `docs/pi-setup.md` Option 2/3 (git-clone dev fallback) still work unmodified — the npm path is additive, not a replacement.

## See Also

- `commands/release.md` — the release order and the abort criteria
- `scripts/release.mjs` — the mechanism (`SURFACES`, `LEAKAGE_PATTERNS`, preflight evaluators)
- `skills/npm-publish/SKILL.md` — token mechanics, auth failure-mode diagnosis, and the judgement calls
- `docs/pi-setup.md` — consumer-facing install guide (all options)
- `.claude/rules/security.md` § Supply Chain Security (SEC-020) — dependency/publish trust model
- `.claude/rules/development.md` § Package Lifecycle & Versioning — semver discipline
