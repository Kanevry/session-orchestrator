# npm Publish Checklist (Operator Runbook)

First-publish (and every subsequent republish) runbook for `session-orchestrator` on npm. This is an **operator step** — no agent or session may run `npm publish`; publishing requires npm auth credentials that live outside the repo.

Context: publishing to npm is what makes `pi install npm:session-orchestrator` work and gets the package indexed on the [Pi packages gallery](https://pi.dev/packages) via the `pi-package` keyword in `package.json`. See `docs/pi-setup.md` § Installation.

## 1. Pre-flight — npm auth

```bash
npm whoami
```

- If not logged in: `npm login` (interactive) or ensure `NPM_TOKEN` / `~/.npmrc` auth token is set for non-interactive CI publish.
- Confirm the account has publish rights to the `session-orchestrator` package name (first publish claims the name; verify it is not already taken by another party: `npm view session-orchestrator` should 404 before the first publish).

## 2. Version bump

- Confirm `package.json` `version` matches the intended release (this repo follows Conventional Commits + semver per `.claude/rules/development.md` § Package Lifecycle & Versioning).
- Do not hand-edit the version for a routine release — use the project's existing release flow if one exists; otherwise bump manually and commit before tagging.

## 3. Tarball review — Leakage Gate (MANDATORY, block on failure)

```bash
npm pack --dry-run
```

Read the full file listing (or the JSON form: `npm pack --dry-run --json`). **Before publishing, verify zero matches** for every leakage-sensitive path below:

```bash
npm pack --dry-run 2>&1 | grep -cE "npm notice.* tests/"
npm pack --dry-run 2>&1 | grep -c "npm notice.*\.orchestrator/"
npm pack --dry-run 2>&1 | grep -cE "npm notice.*[[:space:]]\.claude/"
npm pack --dry-run 2>&1 | grep -c "npm notice.*\.github/"
npm pack --dry-run 2>&1 | grep -c "node_modules"
npm pack --dry-run 2>&1 | grep -c "\.DS_Store"
```

All six commands MUST print `0`. If any prints non-zero:

- A stray gitignored-but-on-disk directory may be leaking through the `files` whitelist (this happened once with a nested `node_modules` under `skills/claude-md-drift-check/` — fixed via a `!**/node_modules/**` negation entry in `package.json` `files`). Adding a `files` array in `package.json` makes npm **stop** honoring `.gitignore` for exclusion purposes — every new top-level directory added to `files` needs its own gitignore-negation double-check.
- Do NOT publish until the gate is clean. Fix `package.json` `files` (or add a negation pattern), re-run `npm pack --dry-run`, re-verify.

Also sanity-check the total file count and unpacked size are in the expected ballpark (as of the `files`-whitelist introduction: ~750 files, ~6.5 MB unpacked, ~2 MB packed) — a sudden jump is a signal something leaked back in.

## 4. Supporting gates

```bash
node scripts/check-package-manager.mjs   # must exit 0 — npm-canonical guard
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"  # must not throw
npm run typecheck
npm test
```

## 5. Publish

```bash
npm publish --access public
```

`--access public` is required — this is an unscoped package name on a first publish, and npm defaults new packages to restricted access only for scoped (`@scope/name`) packages, but pass it explicitly to avoid any ambiguity.

## 6. Post-publish verification

- `npm view session-orchestrator version` — confirm the published version matches.
- `npm view session-orchestrator` — spot-check `description`, `keywords`, `homepage` rendered correctly.
- Check [pi.dev/packages](https://pi.dev/packages) for the `session-orchestrator` listing. Gallery indexing runs on the Pi team's own sync cadence — it is **not instantaneous**; allow for a delay until the next gallery sync before treating a missing listing as a failure.
- From a scratch directory, smoke-test the real install path: `pi install npm:session-orchestrator` (or `npm view session-orchestrator files` to confirm the expected directory set is present in the published tarball).

## 7. Follow-ups (non-blocking, file as issues if skipped)

- Add an npm version badge to `README.md` once the first publish is live.
- Re-check `docs/pi-setup.md` § Installation — flip the "not yet available" caveat on Option 1 once npm:session-orchestrator is confirmed installable.
- Confirm `docs/pi-setup.md` Option 2/3 (git-clone dev fallback) still work unmodified — the npm path is additive, not a replacement.

## See Also

- `docs/pi-setup.md` — consumer-facing install guide (all options)
- `.claude/rules/security.md` § Supply Chain Security (SEC-020) — general dependency/publish trust model
- `.claude/rules/development.md` § Package Lifecycle & Versioning — semver discipline
