# Migrating to Session Orchestrator v3.0.0

v3.0.0 swaps the Bash/zx runtime for Node.js 20+ and adds native Windows support without WSL. This guide walks through the upgrade step-by-step for each supported platform (Claude Code, Codex, Cursor IDE) and each OS (macOS, Linux, Windows).

Epic reference: [#124](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues/124). Full change list: [CHANGELOG.md](../CHANGELOG.md).

## 1. What Changes

| Area | v2.x | v3.0.0 |
|------|------|--------|
| Runtime | Bash + `jq` + zx via Bash | Node.js 20+ + zx (native `import`) |
| Hooks | `.sh` files in `hooks/` | `.mjs` files (ES modules) |
| Install step | `git clone` only | `git clone` **then** `npm install` |
| Windows support | Implicit via WSL / Git-Bash | Native (no wrapper shell) |
| CI | Ubuntu-only | Ubuntu + macOS + Windows matrix |
| Test framework | `bats` shell harness | `vitest` |
| Dependencies | `jq`, `bash`, `git` hard deps | Node 20+, `git`; `jq` optional |

Nothing about skills, commands, or session flow changes. `/session`, `/go`, `/close`, `/discovery`, `/plan`, `/evolve`, `/bootstrap` work the same.

## 2. Prerequisites

- **Node.js 20 or later.** Check with `node --version`. Install from [nodejs.org](https://nodejs.org/) or via your package manager (`brew install node`, `winget install OpenJS.NodeJS`, `apt install nodejs`).
- **Git.** Any recent version.
- **`jq` (optional, recommended).** The scope and command enforcement policies are edited as JSON — `jq` makes that easier. No hook invokes `jq` at runtime in v3.

Optional but recommended:
- **`glab`** (GitLab CLI) or **`gh`** (GitHub CLI) for VCS operations — same as v2.

## 3. Upgrade Steps

### 3a. Claude Code

```bash
# 1. Pull the latest plugin
cd "$(claude plugin dir session-orchestrator 2>/dev/null || echo ~/.claude/plugins/session-orchestrator)"
git pull

# 2. Install Node dependencies
npm install

# 3. Restart Claude Code so hooks.json is re-read
```

If you installed via `/plugin marketplace add Kanevry/session-orchestrator`, the plugin lives under `~/.claude/plugins/session-orchestrator`. If you installed from a local clone, use the clone path.

### 3b. Codex

```bash
cd ~/Projects/session-orchestrator
git pull
npm install
bash scripts/codex-install.sh     # re-syncs the codex plugin catalog
# Restart Codex
```

### 3c. Cursor IDE

```bash
cd ~/Projects/session-orchestrator
git pull
npm install
bash scripts/cursor-install.sh /path/to/your/project    # re-syncs rules
# Restart Cursor
```

### 3d. Verify

After restart, run `/session housekeeping` in any configured repo. On session start you should see the host + resource health banner (new in v3). If the banner is missing or hooks report errors, see [Known Issues](#5-known-issues--workarounds) below.

## 4. What Stays the Same

None of the following change in v3. Existing data migrates transparently.

- **`.orchestrator/metrics/*.jsonl`** — learnings, sessions, events files are read-write compatible.
- **`<state-dir>/STATE.md`** — schema v1 frontmatter unchanged.
- **Session memory** (`~/.claude/projects/<project>/memory/`) — untouched.
- **Session Config** in `CLAUDE.md` / `AGENTS.md` / Cursor rules — same field names and defaults. New optional fields (`resource-awareness`, `resource-thresholds`, `allow-destructive-ops`, `worktree-exclude`) default to safe values.
- **All 7 slash commands** — same arguments, same flow.
- **Skill Markdown** — skills are still pure Markdown with YAML frontmatter; no build step.
- **VCS integration** — `glab` / `gh` commands, label taxonomy, issue templates.

## 5. Known Issues & Workarounds

### `npm install` fails with `ERESOLVE` or peer-dep warnings

Use Node 20 or 22 LTS. Odd-numbered Node releases (23, 25) and very old versions (< 20) have both produced peer-dep resolution quirks. If the error persists:

```bash
npm install --legacy-peer-deps
```

### Windows: hooks silently no-op after install

Make sure `node` is on your `PATH` inside the editor process (not just in your terminal). On Windows, Claude Code inherits PATH from the launching shell — if you installed Node via nvm-windows or fnm, relaunch the editor from a shell that has the runtime on PATH.

Verify from inside Claude Code: `!node --version` should print `v20.x` or later.

### EOL issues on Windows (autocrlf)

v3 ships `.gitattributes` with explicit LF rules for `.sh`, `.mjs`, `.md`, `.json`, and `.yaml`. If you cloned before v3, run:

```bash
git config core.autocrlf false
git rm --cached -r .
git reset --hard
```

This re-checks out every file with the correct line endings. Back up any uncommitted work first.

### Permission errors on hook scripts (macOS / Linux)

Pre-v3, hook `.sh` files needed `+x`. v3 `.mjs` files are invoked via `node <path>`, so the executable bit is not required. If your editor reports `Permission denied` on a hook, it is pointing at a stale `.sh` path — re-run the install script for your platform (`scripts/codex-install.sh`, `scripts/cursor-install.sh`) or re-add the plugin in Claude Code.

### `zx` not found

Run `npm install` from the plugin root. The `zx` package is listed under `dependencies` (not `devDependencies`), so it installs in production trees too. If you run `npm install --production` explicitly, zx is still installed — it is only missing if you ran `npm ci --only=dev` or manually pruned runtime deps.

### Hooks report `SyntaxError: Cannot use import statement outside a module`

Your Node version is < 20 or your `package.json` is missing `"type": "module"`. Verify with `node --version` and `jq '.type' package.json`. Both must be present.

## 6. Rollback

If v3 causes blocking problems and you need to revert to v2.x:

```bash
cd /path/to/session-orchestrator
git fetch --tags
git checkout v2.0.0
rm -rf node_modules package-lock.json   # v2 does not use these
# Restart your editor
```

v2.x state files (`STATE.md`, `sessions.jsonl`, `learnings.jsonl`) remain readable on rollback — the formats are stable across the 2.x → 3.0 transition.

Please open an issue (link below) describing the blocker so we can address it in a v3.0.x patch.

## 7. Support

- **GitLab (upstream):** [infrastructure/session-orchestrator/issues](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues) — preferred for bugs and feature requests.
- **GitHub (mirror):** [Kanevry/session-orchestrator/issues](https://github.com/Kanevry/session-orchestrator/issues) — accepted, mirrored to GitLab by maintainers.
- **Homepage:** [gotzendorfer.at/en/session-orchestrator](https://gotzendorfer.at/en/session-orchestrator)

Please include `node --version`, your OS + arch, the editor (Claude Code / Codex / Cursor), and a minimal reproduction when filing a bug. For hook failures, attach the relevant entries from `.orchestrator/metrics/events.jsonl`.
