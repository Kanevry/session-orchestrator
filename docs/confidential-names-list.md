# Confidential-names list for publishers

The owner-leakage scanner (`scripts/lib/validate/check-owner-leakage.mjs`) has a rule, CP11, that blocks the names of your private repos and customers. CP11 needs a list of those names. The list lives on your machine, outside every repo, and is never committed.

Without a list, CP11 passes silently. That is fine for a repo that is never published. A repo with `mirror: curated` publishes to GitHub, so there the missing list is an error (see [What is checked where](#what-is-checked-where)).

## Generate the list

You need `glab`, logged in to the GitLab instance that holds your projects.

```bash
node scripts/confidential-names.mjs generate --dry-run   # counts only, writes nothing
node scripts/confidential-names.mjs generate             # writes the list
```

The command reads every project your account is a **member** of (`glab api projects?membership=true`, GET only, paged). It does not read every project the account can see: on gitlab.com that would be every public project. From each project it takes the `path` and the `name`, removes duplicates without regard to case, and drops names shorter than 3 characters. It writes `<config dir>/confidential-names.json` with mode 0600, via a temporary file and a rename. A config directory it creates gets mode 0700. `<config dir>` is `~/.config/session-orchestrator` unless `SO_CONFIG_HOME` or `XDG_CONFIG_HOME` points somewhere else.

It aborts and writes nothing if any page fails or if no project comes back. An empty list (`[]`) would read as "CP11 switched off on purpose".

The command prints counts only, never a name. `--out <path>` writes to another file, for example to try a list before you switch it on. `--json` prints the counts as JSON.

## Exceptions

Some project names are ordinary words, or the names of products you advertise publicly. Those match everywhere and make CP11 useless. Put them in `<config dir>/confidential-names-allow.json` as a JSON array of strings:

```json
["example-shop", "toolbox"]
```

The generator leaves out every name in that file, without regard to case. The file is yours: the generator reads it and never writes it. Keep it at mode 0600 next to the list. `--allow <path>` reads a different file.

To find candidates, generate the list into a temporary file and scan your repo with it:

```bash
node scripts/confidential-names.mjs generate --out /tmp/names.json
SO_CONFIDENTIAL_NAMES_FILE=/tmp/names.json node scripts/lib/validate/check-owner-leakage.mjs .
```

The scan prints `file:line` for each hit and redacts the matched text. Open the file to see which name matched. Add a name to the exception file only if it is an ordinary word or a public product. A real confidential name in a public file has to come out of the file.

## Switch it on

Writing the list does not switch it on. Point CP11 at it in `owner.yaml`:

```yaml
paths:
  confidential-names-file: /Users/you/.config/session-orchestrator/confidential-names.json
```

Write the absolute path. A leading `~` is not expanded: the list then counts as missing, and every pre-commit run blocks with "configured but does not exist". `SO_CONFIDENTIAL_NAMES_FILE` overrides the setting for a single command. Check the result:

```bash
node scripts/confidential-names.mjs status
```

Switch it on only once your repo has no real hits. From then on, every pre-commit run blocks on a hit.

## Refresh

New projects do not show up in the list by themselves. Run `generate` again after you create a project. The release preflight warns once the list is older than 7 days. The scanner never makes a network call.

## What is checked where

| Where | Repo without `mirror: curated` | Repo with `mirror: curated` |
|---|---|---|
| Pre-commit | unchanged: CP11 runs if a list is configured | the same, plus one advisory `WARN` line when the list is missing, unusable or older than 7 days. The warning never blocks a commit |
| CI scan | unchanged | unchanged |
| Export (`scripts/github-export.mjs`) | not used | red without a usable list (`--public-export` implies `--require-confidential-names`) |
| Release preflight (`scripts/release.mjs --check` / `--publish`) | `confidential-names` row skipped | `confidential-names` row is red without a usable list and warns when the list is stale. The `leakage-gate` scan also runs with `--require-confidential-names` |

"Usable" means a list with at least one valid name. A configured file that is missing or broken already fails CP11 everywhere, in every repo. An explicit `[]` stays your visible opt-out and passes.
