---
name: security
description: Use when the operator wants to know which security mechanisms run in a repository, what the dependency advisories of its lockfiles mean, whether its install and publish settings are safe, or what steers the agent in this repo and on this host. Runs the read-only scripts/security.mjs in four modes (status, deps, posture, agent-setup) and routes "review" to the existing security-reviewer agent. Triggered by /security, "security status", "dependency advisories", "npm audit is red", "check the agent setup", "Sicherheitsstatus", "Abhängigkeiten prüfen". Not a vulnerability scanner or diff reviewer of its own, not for answering external advisory reports, and not for configuring the guards or hooks.
user-invocable: true
argument-hint: "[status|deps|posture|agent-setup|review] [--ref <commit>]"
model: inherit
---

# Security

> **Plugin root:** `${CLAUDE_PLUGIN_ROOT}`. Claude Code replaces this with the plugin's absolute path when it loads this file. Where it appears unreplaced — in a file this skill reads with the Read tool, or on Codex, Cursor or Pi — the plugin root is the directory that contains this skill's `skills/` folder (two levels above the folder of this SKILL.md). Write that absolute path literally into every command that starts a plugin script: the Bash tool has no plugin variable, and shell variables do not survive between tool calls.

One entry for the security work that recurs: what is switched on, which advisories need a fix, which install settings are missing, and what in the agent setup looks dangerous. The CLI `scripts/security.mjs` measures and only reads; this skill runs it, records one event, and presents the result. Background and scope: Epic #2200.

The invocation arguments are: **$ARGUMENTS**

## Invocation

```
/security [status|deps|posture|agent-setup|review] [--ref <commit>]
```

- No mode word means `status`.
- `--ref <commit>` judges that commit instead of the default. It must not start with `-`. `status` reads the working tree by default; `deps` and `posture` judge `HEAD` by default; `agent-setup` always reads the files as they are now.
- `review` is not a CLI mode. It branches off before the CLI runs (see § review).
- There are no other flags. Do not invent any.

## Running a mode

For `status`, `deps`, `posture` and `agent-setup`, run from the project root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/security.mjs" --mode <mode> [--ref <commit>] --json --repo-root "<project root>" \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/security-emit.mjs" --repo-root "<project root>"
```

The second command passes the JSON through unchanged and records one event `orchestrator.security.command` (mode, status, counts only) in that repo.

The pipe hides the CLI's exit code (0 ok or findings, 1 degraded, 2 usage error). Judge the run by the JSON instead:

- `status` is one of `ok`, `findings`, `degraded`, `skipped`. `degraded` and `skipped` always carry a `reason`; quote it.
- Empty stdout means the CLI failed (usage error or crash). Report its stderr and stop. Do not retry with other flags.
- `notChecked` counts items that were in scope but not measurable. Say how many; never present them as clean.
- `basis` says what was judged: the working tree or a commit, and a `note` such as "uncommitted changes are not included". Show the note.

## status

Answers: which security mechanisms run in this repo — CI audit job, CI signature check, secret scan, close-time security delta, hallucinated-package check, advisory pulse, mirror-protection audit, update automation.

Each check has one state:

| State | Meaning |
|-------|---------|
| `on` | configured and called in this repo |
| `off` | present and disabled by a config value; the detail names it (only the close-time delta and the hallucinated-package check can be `off`) |
| `not-wired` | a measured absence: no CI file in the repo, a CI file without the job, no Renovate or Dependabot config, or the mirror-protection audit is called nowhere |
| `not-measurable` | could not be read, always with a reason: a read error, a CI file that pulls jobs in through `include:`, no pulse cache entry for this checkout (normal in a git worktree), or a pulse refresh cached as degraded |

Next step: for `off`, name the key and its current value; turning it on is the operator's decision. For `not-wired`, say what would call it (a CI job, a config file or a script). For `not-measurable`, quote the reason; it is not a gap.

## deps

Answers: which advisories in every lockfile of the tree need a fix, and which fix. Results stay split per lockfile, one check per lockfile with counts; the `audit threshold` check names the threshold and where it came from (`.npmrc`, a CI audit argument, or `default` = high).

Each finding has a `class`:

| Class | Meaning |
|-------|---------|
| `fix-now` | a malicious package (always), or severity at or above the audit threshold and not dev-only |
| `can-wait` | below the threshold |
| `not-reachable` | dev-only in the lockfile, or a direct dependency with no static import found |
| `severity-not-measurable` | severity could not be read; no rank and no fix, listed and never dropped |

`not-reachable` is granted only for `package-lock.json`, where the dev flag is measured. Other lockfile formats rank by severity and say "reachability not measurable for this lockfile format". A malicious package is always `fix-now`, its fix is "remove the package (malicious)", and no exception is offered.

Every ranked finding carries its basis (`detail`) and a `fix`: `bump to <version>` (direct dependency), `override to <version>` (transitive) or `replace (no patched release)`. `can-wait` and `not-reachable` add `or exception with date`.

A lockfile that exists but could not be checked makes the whole result `degraded` (all lockfiles) or adds a `lockfile-unchecked` finding (some). A lockfile holding only private-scope packages is `skipped`, because nothing is sent. `degraded` exits 1 and is never "no advisories".

Next step: for each `fix-now` entry, propose the fix as text (the `package.json` change or override line). Never edit a lockfile or `package.json` unasked, and never open an update MR from this skill.

## posture

Answers: are the install and publish settings safe for this repo's package manager. Checks: script execution (`ignore-scripts=true`, or a pnpm build allowlist), release-age cooldown, floating tags, runtime floor, update automation (Renovate or Dependabot), mirror protection, and a baseline comparison.

States: `pass`, `fail`, `skipped` (with the reason), `not-measurable`. Mirror protection runs only with a GitHub remote and an authenticated `gh`, otherwise it is `skipped`; the output shows the audit's finding ids, never token scopes. The baseline comparison is `skipped` without a configured baseline, or when the repo has no cooldown at all.

For pnpm, an `allowBuilds` object in `pnpm-workspace.yaml` or under `pnpm` in `package.json` passes the script-execution check. An `onlyBuiltDependencies` array in either location counts as an allowlist when `packageManager` pins pnpm below 12 or the version is unknown. With pnpm 12+ the check passes with a migration hint. pnpm 12.21.0 ignored the legacy list and blocked unapproved builds.

Fix forms printed: `set ignore-scripts=true in .npmrc` (or add a pnpm build allowlist), `set <key> (<unit>)` or `raise <key> to at least <n>`, `pin a concrete tag or a sha256 digest`, `bump to <version>`, `add a Renovate or Dependabot config`, `see docs/github-mirror-protection.md`. The cooldown key differs: npm `min-release-age` is in days; pnpm `minimum-release-age` or `minimumReleaseAge` is in minutes.

Next step: for each `fail`, show its `fix` line. Mirror protection is read live from GitHub, not at the judged commit; say so when it fails.

## agent-setup

Answers: what steers the agent here — repo instruction files, `.claude/settings*.json`, `.mcp.json`, repo skills, and on the host (under HOME, or USERPROFILE) the Claude Code user settings, installed plugins and skills, and the MCP servers of `~/.claude.json` — and whether it falls into six finding classes. It always reads the working tree, never `--ref`. From the user-level MCP config it reads only the top-level servers and this repo's own project entry.

| Class | Meaning |
|-------|---------|
| `endpoint-override` | a settings env key such as `ANTHROPIC_BASE_URL`, a `*_BASE_URL` key or `HTTPS_PROXY` points to a non-loopback host |
| `fetch-and-execute` | a hook pipes `curl`/`wget` output into a shell or interpreter, or into `eval` |
| `approval-off` | a setting switches an approval prompt off, or an MCP server auto-approves tools |
| `wildcard-allow` | a permission allow entry such as `*`, `Bash`, `Bash(*)` or `mcp__*` |
| `token-in-allowlist` | an allow entry contains a token shape (SEC-025) |
| `hidden-unicode` | an instruction file contains a hidden Unicode character |

A seventh kind, `surface-unread`, marks a settings, MCP, instruction or Codex config file that exists and could not be read (symlink out of the repo, over the size cap, unparsable). Its settings are not judged. Codex `config.toml` is reported this way in this build.

Output carries file, key name and class, never a value. Changing the user's own settings is the operator's decision: report and propose, do not edit.

## review

A router only. It adds no review logic of its own.

1. Collect the diff: `git diff HEAD --stat` (staged and unstaged together) and `git status --porcelain` for untracked files. If both are empty, say there is nothing to review and stop.
2. **Claude Code:** dispatch the existing agent and show its report unchanged:

   ```
   Agent({ subagent_type: "session-orchestrator:security-reviewer",
           description: "Security review of the current diff",
           prompt: "Review the uncommitted changes against HEAD (git diff HEAD) plus these untracked files: <list>. Changed files: <list>. Report findings with file and line." })
   ```

3. **Codex CLI:** the plugin ships no `security-reviewer` agent for Codex (`.codex-plugin/agents/` holds `explorer`, `session-reviewer`, `wave-worker`). Say the agent is unavailable and print the harness's own command: `codex review --uncommitted` (measured 2026-11-21 on `codex-cli 0.169.0`).
4. **Cursor IDE and Pi:** no native review command is known for either harness. Show the diff summary and untracked paths collected in step 1, and ask the operator to review the changes manually.

`review` runs no CLI mode and records no event.

## Rules

- The CLI only reads. This skill writes nothing except the one event the emit step records.
- Counts only from the pulse cache; never print a package name taken from it.
- Never print a value from a settings env entry, a permission allowlist or `.npmrc` — key names, classes and counts only.
- Baseline-dependent checks report `skipped` without a baseline; present that as "not judged", not as a pass.
- `degraded` is never reported as "no advisories" or "clean".
- Defence, review and configuration only. No exploit code, no attack steps.

## Output

Present the result in the operator's language as one compact table per mode: check, state, detail. Lead with what needs action — `fix-now` entries, `fail` checks, agent-setup findings — each with its proposed fix. Then the rest of the table, then `notChecked` and the basis note. No summary prose beyond one line on what to do next.
