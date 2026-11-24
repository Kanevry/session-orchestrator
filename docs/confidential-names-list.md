# Confidential-names list for publishers

The owner-leakage scanner (`scripts/lib/validate/check-owner-leakage.mjs`) has a rule, CP11, that blocks the names of your private repos and customers. CP11 needs a list of those names. The list lives on your machine, outside every repo, and is never committed.

Without a list, CP11 passes silently. That is fine for a repo that is never published. A repo with `mirror: curated` publishes to GitHub, so there the missing list is an error (see [What is checked where](#what-is-checked-where)).

## Generate the list

You need `glab`, logged in to the GitLab instance that holds your projects.

```bash
node scripts/confidential-names.mjs generate --dry-run   # counts only, writes nothing
node scripts/confidential-names.mjs generate             # writes the list
```

The command reads every project your account is a **member** of (`glab api projects?membership=true`, GET only, paged). It does not read every project the account can see: on gitlab.com that would be every public project. From each project it takes the `path`, the `name` and the segments of its group namespace (see [Group names](#group-names)). It adds the names from the [extra list](#extra-list). The command deduplicates candidates without regard to case and drops names shorter than 3 characters. It writes `<config dir>/confidential-names.json` with mode 0600, via a temporary file and a rename. A config directory it creates gets mode 0700. `<config dir>` is `~/.config/session-orchestrator` unless `SO_CONFIG_HOME` or `XDG_CONFIG_HOME` points somewhere else.

It aborts and writes nothing if any page fails or if no project comes back. An empty list (`[]`) would read as "CP11 switched off on purpose".

The command prints counts only: projects, candidates, distinct group segments that meet the length limits (before exceptions), group segments skipped as generic, extra names, exceptions and names too short. `--out <path>` writes to another file, for example to try a list before you switch it on. `--json` prints the counts as JSON.

## Group names

Group names are often as confidential as project names: a customer group, a venture, a person's handle. So the command also takes every segment of a group namespace's `namespace.full_path` from the same response. Personal namespaces are never taken.

Many group names only describe how the host is organised: `apps`, `tools`, `libs`, `docs`, `sandbox`, `templates`. Those words match hundreds of files in a public tree and protect nothing. The command skips them: `GENERIC_GROUP_SEGMENTS` in `scripts/lib/confidential-names-list.mjs` holds about 70 such English words and is the place to add one that every publisher would skip. The filter applies to group segments only. A project whose path or name is one of these words stays in the list.

`--no-groups` leaves every group segment out. The command still counts them.

## Extra list

Some confidential names are not GitLab projects: a customer, a product that lives in a project note, a client's code name. Put them in `<config dir>/confidential-names-extra.json` as a JSON array of strings:

```json
["example-customer", "example-codename"]
```

The generator adds every name in that file to the list, with the same rules as for project names: at least 3 characters, deduplicated without regard to case. The file is yours: the generator reads it and never writes it. Keep it at mode 0600 next to the list. `--extra <path>` reads a different file. A file that is not a JSON array of strings stops the command, and nothing is written.

The exception list wins: a name in both files stays out of the list. The exception list remains the one place to loosen the list.

To bring in your own sources, such as a project register in your notes or a customer list, write their names into the extra file, by hand or with a small script of your own, then run `generate`. The list picks them up on every run.

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
  confidential-names-file: ~/.config/session-orchestrator/confidential-names.json
```

Use an absolute path or one starting with `~/`, which resolves to your home directory. `SO_CONFIDENTIAL_NAMES_FILE` overrides the setting for a single command and also supports `~/`. Check the setting with `status`.

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
