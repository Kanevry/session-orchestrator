# Configured Baseline Bootstrap

Use this flow only after `public-fallback.md` returned `PATH_TYPE = private`.
The configured local baseline owns the archetype catalog. The plugin consumes
its validated, reduced export; it carries no private archetype table.

## Select

For Standard/Deep, use the `selected.id` returned by Phase 0.5 when repository
markers match. An explicit owner-supplied ID takes precedence: validate it with
`--archetype` before accepting it. A user description can help present choices,
but cannot invent a catalog ID. When `selected` is null, present the returned
`archetypes` in `order`, showing their runtime, package manager, UI/API and deploy
metadata. Ask for the needed selection; paginate if the UI limits option count.
Do not substitute a public default for missing evidence or an invalid choice.

Once selected, set `CONFIRMED_ARCHETYPE` and refresh the contract:

```bash
BOOTSTRAP_CONTRACT=$(node "$PLUGIN_ROOT/scripts/baseline-archetypes.mjs" \
  --repo "$REPO_ROOT" --archetype "$CONFIRMED_ARCHETYPE") || exit 2
export BOOTSTRAP_CONTRACT
```

`status: error` aborts before scaffolding. Its reason is safe to report; do not
print baseline paths, raw producer diagnostics, or private catalog files.
`insufficient-evidence` is a selection state, not permission to use `node-minimal`.
Fast tier has no archetype; use the plugin's minimal instruction-file flow and
skip this file's scaffold/rules actions until upgrading to Standard/Deep.

## Scaffold

Execute this before Standard inherits the Fast steps. It runs only the local
baseline's `render_archetype_dir`, `render_shared_and_substitute`, and
`render_archetype_metadata` functions in temporary staging. It excludes all
staged rules; S99 below and `rules-sync` own rule delivery. It never invokes the
interactive setup script, package installation, Git, or a remote service.

```bash
export PLUGIN_ROOT REPO_ROOT CONFIRMED_ARCHETYPE REPO_NAME
SCAFFOLD_RESULT=$(node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
const { scaffoldBaselineArchetype } = await import(pathToFileURL(`${process.env.PLUGIN_ROOT}/scripts/lib/baseline-archetypes.mjs`));
const result = await scaffoldBaselineArchetype({
  repoRoot: process.env.REPO_ROOT,
  archetype: process.env.CONFIRMED_ARCHETYPE,
  projectName: process.env.REPO_NAME,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === 'error') process.exitCode = 2;
NODE
) || exit 2
printf '%s\n' "$SCAFFOLD_RESULT"
while IFS= read -r _file; do BOOTSTRAP_FILES+=("$_file"); done \
  < <(printf '%s\n' "$SCAFFOLD_RESULT" | jq -r '.created[]')
```

The report lists relative `created` and `preserved` files plus `unavailableGates`. Add only `created`
files to `BOOTSTRAP_FILES`; an existing file is preserved for owner review.
All sources and destinations are checked for symlinks before the first copy.
The renderer's commands are fixed function calls; exported `commands` and
`qualityGates[].command` remain data throughout lookup and staging.

Continue Fast's common steps, preserving the rendered instruction files,
README, manifests and configuration. Then skip Standard's four public stack
sections and continue at Step 3a, S99 and the lock/quality-policy steps.

## Expectations

Use `selected.runtimes`, `packageManagers`, `ui`, `api`, `deploy`, `commands`,
`qualityGates`, `ci`, and `browserAutomation` as the scaffold expectations.
Keep rendered command documentation and CI. Staging normalizes new Session
Config `test-command`, `typecheck-command`, and `lint-command` from exactly
matching `qualityGates[].id` values (`test`, `typecheck`, `lint`). An absent gate
gets the literal failing command `false` and an unavailable explanation, so a
later generic gate runner cannot report an unsupported check as passing. No
other ID is silently relabeled. Existing owner instruction files are preserved.

For private verification, enumerate the selected `qualityGates` and report each
declared result. Separately report absent test/typecheck/lint slots as
unavailable; do not execute their `false` placeholders as if they were declared
checks, or claim that all three generic checks passed. Command execution is a
later explicit bootstrap step, separate from lookup and staging. Step 6.5 writes
the same exact mapping to a new quality policy, whose commands take precedence
at runtime. Existing owner policy is preserved; report any divergence for review.
The generic quality runner is unchanged.

Deep D1 preserves the baseline CI and its `ci.profile`. If `ci.required` is
false, do not create a public Node CI pipeline. If true and the baseline did
not render CI, staging fails. VCS mismatch or a required translation needs an
explicit owner choice; do not silently replace the canonical CI with a public
template. The remaining Deep governance steps apply normally.

## Rules

S99 re-reads the selected contract after rendering, so dependency-conditional
targets include the new package manifest. `ruleTargets` is the exported union;
`pluginRuleTargets` is its intersection with all basenames in `rules/_index.md`.
Only `baselineRules` may be copied from the local baseline. Every source is a
validated relative file under `.claude/rules/` or
`templates/shared/.claude/rules/`, and every target belongs to that union.
Existing rules are preserved. Plugin rule basenames, including
`parallel-sessions.md`, are written only by `rules-sync.mjs`. Step 3a invokes
`syncBootstrapRules`, which reloads the contract and passes `pluginRuleTargets`
as the writer's validated required basenames. This delivers private requirements
even when plugin scope tags do not name that archetype. The same action backs
later `/bootstrap --sync-rules`, resolving the explicit ID, then the lock ID,
then repository markers. Public/default rule selection remains unchanged.
Later sync of a valid Fast/null lock without stack markers also uses ordinary
plugin rules; a configured contract must still validate before that refresh.

## Created files

Keep one `BOOTSTRAP_FILES` array throughout inherited Fast/Standard/Deep steps.
Each writer appends only relative files it actually creates; do not replace the
array with a stack-specific list. Existing owner files and directories are never
added merely because they exist. A repeated writer reporting `created: []`
leaves accumulated paths intact. New governance files are appended individually
at creation, and commit steps consume this accumulated list without broad globs.
