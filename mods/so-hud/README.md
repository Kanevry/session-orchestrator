# so-hud 0.2.0

A native Session Orchestrator display for Claude Code (package A, #1508): a status line for the running session, a warning band when something needs attention, and one beacon file per session that other sessions can read through `$.so.beacons()`. The status line shows how many peer sessions are running (from the session registry). Since 0.2.0 it also checks tool calls before they run (#1551, see [Protection gates](#protection-gates)).

## Requirements

- Claude Code with mod support; tested with **2.1.296**. Claude Code only — Codex, Cursor and Pi do not load this mod.
- **Node.js 24** or later.
- **Session Orchestrator** from the release that ships this mod or later, as the plugin or as a checkout set through `soRoot`: the mod reads all state through its `scripts/so-hud.mjs`, which earlier releases do not have.

## Install

```text
/plugin marketplace add Kanevry/session-orchestrator
/plugin install so-hud@kanevry
```

The mod finds the Session Orchestrator installation in this order: the `soRoot` setting (an absolute path), then the path cached from an earlier lookup, then a root registered with `node scripts/so-hud.mjs --register-root` inside that installation, then `claude plugin list --json`. The first hit is cached, so after a move only `soRoot` replaces it. None of these install actions is run by the development tests. For a local checkout you can also load this directory directly with `claude --plugin-dir ./mods/so-hud`.

Settings: `strictness` is `locker` (relaxed), `ausgewogen` (balanced, the default) or `streng` (strict); it is shown in the status line, returned by `$.so.profile()` and decides how the protection gates react. Until one is chosen, a band above the prompt shows the current profile with one button per profile (no hotkeys: a digit typed into an empty prompt would press one); a press saves it in this mod's `strictness` row of `/config`, used by every new session. `/profile` shows the profile and its effect without a model turn and opens the band, with `Schließen` to hide it for the session (#1552). The profile steers only these gates, not Session Orchestrator's own guards. `soRoot` is optional.

**Upgrading from 0.1.0:** 0.1.0 only displayed state; 0.2.0 adds the [protection gates](#protection-gates), so outward actions such as push, merge, release and publish ask for two confirmations within 30 seconds, and commands that would print a secret are refused. `/plugin install` uses scope `user` by default, and an update at that scope changes every Claude Code session on the host at once, including lead sessions that merge through the API on the owner's word. Set `strictness` per host first (0.1.0 already has the row in `/config`), try 0.2.0 in one session (`claude --plugin-dir ./mods/so-hud`, or an install at project scope), and only then update the user-scope install: [docs/mods.md § Upgrading from 0.1.0 with scope user](../../docs/mods.md#upgrading-from-010-with-scope-user).

## What it does

Session Orchestrator state comes only from `scripts/so-hud.mjs`, called as `--json --repo-root <cwd> --session-id <raw-uuid>` every 15 seconds with a 3-second timeout. With `--session-id` the collector counts the session's agents beside its own `session.lock`, which can sit in another checkout than the cwd (#1730). A collector older than #1730 rejects the flag with exit 2; the mod then calls it without the flag for the rest of the session. STATE.md, locks, dispatch and events are never changed. The mod writes only its own beacon file, its install-path cache, the receipt lines in `aktionen.jsonl` (see below), and, when a profile is picked in the band, its own `strictness` row in `/config` and the store key `profile-chosen`. Without a Session Orchestrator root it asks `claude plugin list` at most once every 5 minutes.

The status line says `nicht eingerichtet` for a part that is not set up (no Session Orchestrator installation found, no `vault-integration` block) and `noch kein Lauf` for an enabled vault mirror that never ran; a repository where no session has written events yet is not shown as `teilweise gemessen`.

`$.so.version()` is 1; `snapshot()` and `beacons()` are asynchronous engine calls (`await`); `profile()` returns `locker`, `ausgewogen` or `streng`. A cold snapshot is `null`; an old one keeps its measurement time and carries `age_ms`; after a failed refresh it is kept and marked `degraded`.

**Language:** the status texts and the texts of the protection gates are German. An English text table is prepared but not selectable yet, because JSON v1 has no field for the owner's language.

Beacons: the `$.fs` API of this Claude Code build offers no rename, chmod or unlink, so `hooks/beacon-io.mjs` is called through `$.process.run` with argv and JSON on stdin: temporary file plus rename, mode 0600, beacon directory 0700, at most 4 KB. `hud/` and `hud/beacons/` must be real directories owned by the user, not symlinks, checked through an `O_NOFOLLOW` handle; where Node has no `O_NOFOLLOW` (native Windows) an `lstat` check stands in, and a link swapped in between check and `chmod` would be followed. Removing a beacon follows no symlink. The helper's parent PID stands for the starting engine process; that mapping still has to be confirmed in a real engine host. Foreign beacons are validated; one older than 120 seconds whose PID cannot be shown to be alive becomes state unknown. `tool.check: ask` means handing the decision on (also in auto mode), not proof that a dialog was shown.

## Protection gates

Before a shell command (`Bash`, `Monitor`, `PowerShell`) or a file edit runs, so-hud checks it, and it checks tool results before they reach the model (#1551). This is a behaviour change against 0.1.0: outward actions now ask twice by default, secret-printing commands are refused, and on the default profile `ausgewogen` rule traps such as `git add -A` are refused too.

- **SEC-008 traps** (commands that would print a secret, such as `cat .env`, a bare `env`, `echo $TOKEN`, `docker inspect` without `--format`, a token in curl arguments or in a curl URL) are refused on every profile; the refusal names the safe replacement command.
- **Rule traps** (`git add .`/`-A`/`--all`, `claude -p` without `env -u ANTHROPIC_API_KEY`, `${PIPESTATUS[`, `grep -c … || echo 0`) show a toast on `locker` and are refused on `ausgewogen` and `streng`.
- **Outward actions** (push to `main`/`master`, force, tags or delete; merge; release; publish; production deploy) are held wherever a surface is attached (terminal, desktop, IDE, phone) until the owner confirms twice within 30 seconds; declining, closing the dialog or letting the time run out refuses the call. Only a plain push of a feature branch runs without a question (#1569): `git push [-u] origin feat/x`, `HEAD` or a bare `git push`; exact options; every earlier command on the line a local git call from an allowlist (`fetch` with no option and no `::` word, `log`/`show`/`diff` with display options only — `--output`, `--ext-diff`, `--textconv`, `--upload-pack` ask), so any earlier command that is not git (`npm test && git push origin feat/x`), and any earlier output redirection other than onto exactly `/dev/null` or between stdout and stderr (`git log … >> .git/config`, also on `cd`, an assignment or `exec`), makes every push form ask; after `add`, `commit`, `status`, `diff`, `fetch` or `checkout -- <paths>` on the line, only when so-hud measured that none of the hooks those steps can fire exists (a hook file of that name, in husky v9 the user's `.husky/<name>`, or a `hook.*` config entry for that event; see docs/mods.md § Limits) and the step ran in the push's own folder as written (`git -C ../b commit && git push …` asks; in a husky repository with a `.husky/pre-commit`, `git commit … && git push …` on one line asks); behind any git call, only when that call ran in the push's own folder as written and every key of the repository's own git config is on an allowlist (`core.fsmonitor`, `diff.external`, filters, textconv, `core.sshCommand`, `credential.helper`, `include.path` and any other key ask, and so does any submodule or embedded repository in the index, #1573); no earlier step that changes the branch, git config or the folder; harmless variable names only; a remote defined in git config; and the standard push configuration (`push.*`, `remote.<r>.push`, `remote.<r>.mirror`, push remotes and `submodule.recurse` are read). Lowercase `head`, `--no-verify` and every other shape ask. A run with no surface at all (a plain `claude -p`) cannot ask: so-hud writes a receipt and lets the call run, and there merges, releases, publishes and deploys are checked by no Session Orchestrator gate.
- **Collision guard:** an edit of a file in the declared wave scope of another live Session Orchestrator session in the same working copy gives a toast on `locker`, a question on `ausgewogen` and a refusal on `streng`. Sessions that do not run Session Orchestrator are invisible to it.
- **Secret shield:** a token in a tool result reaches the model as `[<kind> entfernt · sha256:<12 hex>]`, with a toast to rotate it.

Every decision on an outward action appends one receipt line per held action, and every asked collision one line, to `~/.config/session-orchestrator/hud/aktionen.jsonl` (0600, append-only, a regular file with one link); it carries the SHA-256 of `JSON.stringify([tool, command])` — `[tool, file path]` for a collision — never the command. If the gate itself fails, the call is refused, except on `locker` for calls that are neither outward nor SEC-008. The gates are a hurdle, not the authority: pre-push hook, destructive-command guard and CI stay authoritative where they exist. Profiles, receipt fields, the full list of checked commands and the limits: [docs/mods.md](../../docs/mods.md).

## Limits

- A status without a session or wave binding is not attributed to the current wave.
- Dispatch records do not always carry agent type or model; those fields stay null.
- Peer scope is unknown when either scope source is missing or the scope signals have gaps.
- Events are read only from the last 512 KB, reported as `events:tail-only`. There is no complete history.

## Checks

`npx vitest --run tests/so-hud` in the Session Orchestrator repo (CI job `test`). The CI job `mods:plugin` runs `claude plugin validate --strict --json` and `claude plugin test` for every mod. Engine integration separately with `claude plugin test mods/so-hud`; under Claude Code 2.1.296 the kit tests pass. `tsconfig.json` follows the header of the type file; the engine creates `.claude-plugin/types` when it loads the mod. No rollout, no commands from later packages and no second Session Orchestrator state.
