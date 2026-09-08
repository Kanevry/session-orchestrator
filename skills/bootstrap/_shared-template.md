# Bootstrap Shared Template Partials

> This file is NOT a standalone template. It contains shared step definitions
> referenced from `standard-template.md` and `deep-template.md` via
> `<!-- @include _shared-template.md#section-name -->` markers.
>
> When the bootstrap skill reads a tier template, sections marked with an
> include marker must be sourced from the corresponding heading in this file.
> The tier templates remain fully readable on their own — the markers serve as
> an editorial cross-reference so the canonical text lives in one place.

---

## #parallel-sessions-rule — Step 3a: Install Canonical Rules

Vendor the canonical always-on rules from the plugin's `rules/` library into `$REPO_ROOT/.claude/rules/`. `rules/` is the single source of truth for every distributable rule — never `cp` a rule file from anywhere else (see "Why one writer" below).

Idempotency is handled by the writer itself:
- Missing → create
- Exists, plugin-owned (first line is the `<!-- source: session-orchestrator plugin ... -->` header) and byte-identical → skip silently
- Exists, plugin-owned and stale → overwrite (the plugin copy is canonical)
- Exists WITHOUT that header → preserved untouched (a repo-private rule the operator authored)

Shell:
```bash
mkdir -p "$REPO_ROOT/.claude"
export PLUGIN_ROOT REPO_ROOT CONFIRMED_ARCHETYPE
RULES_RESULT=$(node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
const { syncBootstrapRules } = await import(pathToFileURL(`${process.env.PLUGIN_ROOT}/scripts/lib/baseline-archetypes.mjs`));
const result = await syncBootstrapRules({ repoRoot: process.env.REPO_ROOT, archetype: process.env.CONFIRMED_ARCHETYPE || undefined });
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === 'error') process.exitCode = 2;
NODE
) || exit 2
printf '%s\n' "$RULES_RESULT"
while IFS= read -r _file; do BOOTSTRAP_FILES+=("$_file"); done \
  < <(printf '%s\n' "$RULES_RESULT" | jq -r '.created[]')
if [[ ! -e "$REPO_ROOT/.claude/loop.md" && ! -L "$REPO_ROOT/.claude/loop.md" ]]; then
  cp "$PLUGIN_ROOT/templates/_shared/loop.md" "$REPO_ROOT/.claude/loop.md"
  BOOTSTRAP_FILES+=(.claude/loop.md)
fi
```

The command prints a JSON report (`written` / `skipped` / `preserved` / `errors` / `warnings` / `sanitizer`) and exits non-zero on any error. Surface `errors[]` to the operator; a non-empty `preserved[]` is normal and means a repo-private rule was left alone.

Also surface `sanitizer[]` (issue #1098) — `{file, line, kind, text}` records for citations that read fine inside the plugin repo and dangle once vendored (`repo-local-path`, `unresolvable-see-also`). The CLI additionally prints each one to stderr as `rules-sync: sanitizer <kind> <file>:<line> — <text>`. **Report it to the operator; do not act on it automatically** — the sanitizer never rewrites content and never changes the exit code, because silently stripping a citation would change a rule's meaning at vendoring time. A human decides whether the citation is a leak.

The wrapper re-reads a configured private contract and passes its required plugin
basenames into the canonical writer. The full set must resolve uniquely before
any rule is written; source/provenance validation and local preservation still
apply. On the public path, normal archetype filtering is unchanged. The selected
ID is explicit during bootstrap; later `/bootstrap --sync-rules` can use the lock.

Why: PSA-003 destructive-command safeguards require every consumer repo to carry the parallel-sessions rule. See issue #155. The `loop.md` vendor gives bare `/loop` a repo-aware maintenance prompt (issue #633 Hebel 3).

Why one writer (issue #1060): a literal `cp` from a second source directory bypasses the pre-write validator AND lands a file carrying no provenance header. On the next `--sync-rules` a headerless file is classified as a repo-private override and preserved forever — so the plugin can never update it again, and whichever rival copy is smaller silently wins. For every basename declared in `rules/_index.md`, `rules-sync.mjs` is the sole writer: it owns the manifest, archetype scoping, basename-collision guard and pre-write validation. S99 may deliver baseline-only rules after excluding all plugin-owned basenames.

Note: This step runs before S99/D99. Both the private local rule projection and the optional public fetch filter every basename in `rules/_index.md`, including currently nonmatching scoped entries. `parallel-sessions.md` and any future plugin-owned rule therefore remain under the same single writer.

---

## #agents-scaffold — Step: .claude/agents/ Scaffold (#189)

Copy the opinionated agent templates into the consumer repo:

```bash
mkdir -p "$REPO_ROOT/.claude/agents"
for _source in "$PLUGIN_ROOT/skills/bootstrap/templates/agents/"*.md; do
  _target=".claude/agents/$(basename "$_source")"
  if [[ ! -e "$REPO_ROOT/$_target" && ! -L "$REPO_ROOT/$_target" ]]; then
    cp "$_source" "$REPO_ROOT/$_target"
    BOOTSTRAP_FILES+=("$_target")
  fi
done
```

This scaffolds 3 opinionated agents (`project-discovery`, `project-code-review`, `project-quality-gate`) following CLAUDE.md Agent Authoring Rules. Consumer repos should edit descriptions/bodies to match project specifics — but keep the frontmatter structure intact (validated by `agent-frontmatter-invalid` probe).

**Idempotency:** Existing files under `.claude/agents/` are not overwritten — skip any file that already exists.

---

## #vault-registration — Step: Vault-Registration Prompt (Product Repos) (#190)

If this repo shows product-repo signals (framework dep + personas/content dir + product env vars), offer to register a vault entry in Session Config.

**Detection (via `scripts/lib/product-repo-detect.mjs`):**

```bash
node --input-type=module -e "
import { detectProductRepo, hasVaultConfig } from '${PLUGIN_ROOT}/scripts/lib/product-repo-detect.mjs';
const result = detectProductRepo({ repoRoot: process.cwd() });
const already = hasVaultConfig('$REPO_ROOT/CLAUDE.md') || hasVaultConfig('$REPO_ROOT/AGENTS.md');
if (!result.isProductRepo || already) process.exit(0);
process.stdout.write(JSON.stringify(result, null, 2));
process.exit(10);  // signal: prompt user
"
```

When the script exits 10 (product signals detected, no vault yet): prompt the user:

> Repo appears to carry product data (framework: \<detected>, signals: \<list>). Create vault registration in Session Config? [Y/n]

**On Y (default):** Append the following block to the `## Session Config` section of CLAUDE.md:

```yaml
vault:
  path: ${VAULT_PATH:-$HOME/Projects/vault}
  product-domain: <prompt user for a short domain tag, e.g. "buchhaltung", "lead-gen">
  persona-db: <optional: path to persona data file, blank if N/A>
```

**On N:** skip silently. The detection may re-run on next bootstrap; idempotency comes from `hasVaultConfig` — once `vault:` exists in Session Config, the prompt is skipped.

**Examples from real repos:**

| Repo | Framework | Signals | Vault Entry |
|------|-----------|---------|-------------|
| ExampleSaaS | Next.js | supabase, stripe, personas/ | `product-domain: accounting` |
| ExampleLeadGen | Next.js | stripe, posthog | `product-domain: lead-gen` |
| ExamplePortfolio | Nuxt | postgres, sentry | `product-domain: portfolio` |

**Idempotent.** If CLAUDE.md already has a `vault:` key inside Session Config, the prompt is skipped.

---

## #baseline-fetch — Step S99: (Optional) Fetch Canonical Rules + Agents from Baseline

For `PATH_TYPE = private` and a confirmed archetype, this step applies only the
validated local contract rule targets from `private-contract.md`. It is offline,
rechecks conditional dependencies after scaffolding, preserves existing files,
and fails closed on an invalid configured contract.

For `PATH_TYPE = public`, the existing remote fetch remains OPT-IN and only
executes when ALL of the following are true:
- `baseline-ref` is present in Session Config (e.g., `baseline-ref: main`)
- `GITLAB_TOKEN` env var is set
- The session-orchestrator plugin includes `scripts/lib/fetch-baseline.mjs`
- A GitLab host is resolvable (`gitlab-host` Session Config key or `GITLAB_HOST` env)

When triggered, this step pulls the canonical `.claude/rules/*.md` and (optionally) `.claude/agents/*.md` files directly from the baseline GitLab project (project 52 by default) into the new repo, then writes `.claude/.baseline-fetch.lock` recording the fetch.

Without this step, rules arrive in the repo via Clank's weekly baseline sync MRs (the legacy path). This step short-circuits that delay so a freshly-bootstrapped repo starts with current rules immediately.

**Implementation:**

```bash
if [[ "${PATH_TYPE:-public}" = "private" ]]; then
  export PLUGIN_ROOT REPO_ROOT CONFIRMED_ARCHETYPE
  BASELINE_RULES_RESULT=$(node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
const { applyBaselineRules } = await import(pathToFileURL(`${process.env.PLUGIN_ROOT}/scripts/lib/baseline-archetypes.mjs`));
const result = await applyBaselineRules({
  repoRoot: process.env.REPO_ROOT,
  archetype: process.env.CONFIRMED_ARCHETYPE,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === 'error') process.exitCode = 2;
NODE
) || exit 2
  printf '%s\n' "$BASELINE_RULES_RESULT"
  while IFS= read -r _file; do BOOTSTRAP_FILES+=("$_file"); done \
    < <(printf '%s\n' "$BASELINE_RULES_RESULT" | jq -r '.created[]')
else
BASELINE_REF=$(echo "$CONFIG" | jq -r '."baseline-ref" // empty')
BASELINE_PROJECT_ID=$(echo "$CONFIG" | jq -r '."baseline-project-id" // "52"')

# The .mjs fetcher requires a GitLab host (it fails closed with no private default).
# Resolve it from Session Config (`gitlab-host`) or the GITLAB_HOST env var — never a hardcoded default.
GITLAB_HOST_CFG=$(echo "$CONFIG" | jq -r '."gitlab-host" // empty')
export GITLAB_HOST="${GITLAB_HOST:-$GITLAB_HOST_CFG}"

if [[ -n "$BASELINE_REF" && -n "${GITLAB_TOKEN:-}" && -n "${GITLAB_HOST:-}" && -f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs" ]]; then
  # Default rule manifest — superset will harmlessly 404 individual files
  # if the baseline ever drops one (cache will keep last-known-good).
  RULES_MANIFEST=$(mktemp)
  cat > "$RULES_MANIFEST" <<MANIFEST
.claude/rules/development.md
.claude/rules/security.md
.claude/rules/security-web.md
.claude/rules/security-compliance.md
.claude/rules/testing.md
.claude/rules/test-quality.md
.claude/rules/frontend.md
.claude/rules/backend.md
.claude/rules/backend-data.md
.claude/rules/infrastructure.md
.claude/rules/swift.md
.claude/rules/mvp-scope.md
.claude/rules/cli-design.md
.claude/rules/ai-agent.md
.claude/rules/claude-code-usage.md
MANIFEST
  # Every plugin-owned basename is excluded, including currently unmatched scoped
  # rules. rules-sync is their sole writer; ownership does not depend on scope.
  export PLUGIN_ROOT RULES_MANIFEST
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { pluginRuleTargets } = await import(pathToFileURL(`${process.env.PLUGIN_ROOT}/scripts/lib/baseline-archetypes.mjs`));
const owned = new Set(pluginRuleTargets(process.env.PLUGIN_ROOT));
const files = readFileSync(process.env.RULES_MANIFEST, 'utf8').split('\n')
  .filter(file => file && !owned.has(path.posix.basename(file)));
writeFileSync(process.env.RULES_MANIFEST, files.join('\n') + '\n');
NODE

  echo "Fetching canonical rules from baseline (project $BASELINE_PROJECT_ID, ref $BASELINE_REF)…"
  # The .mjs CLI is single-file: it prints ONE file body to stdout, exit 0 on success
  # (1=auth, 2=404, 3=network). There is no batch and no lock-write in the CLI — the
  # bootstrap layer orchestrates the per-rule loop and writes the lock itself.
  SUCCESS_LOG=$(mktemp)
  while IFS= read -r rule_path; do
    [[ -z "$rule_path" ]] && continue
    _RULE_CREATED=false
    [[ -e "$REPO_ROOT/$rule_path" || -L "$REPO_ROOT/$rule_path" ]] || _RULE_CREATED=true
    mkdir -p "$REPO_ROOT/$(dirname "$rule_path")"
    if node "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs" \
         "$BASELINE_PROJECT_ID" "$rule_path" "$BASELINE_REF" > "$REPO_ROOT/$rule_path"; then
      printf '%s\n' "$rule_path" >> "$SUCCESS_LOG"
      if [[ "$_RULE_CREATED" = true ]]; then BOOTSTRAP_FILES+=("$rule_path"); fi
    else
      # A 404 (or any error) for one rule must not abort the batch — drop the empty
      # target the redirect created and continue with the next manifest line.
      rm -f "$REPO_ROOT/$rule_path"
    fi
  done < "$RULES_MANIFEST"

  if [[ -s "$SUCCESS_LOG" ]]; then
    FETCHED_JSON=$(jq -R . < "$SUCCESS_LOG" | jq -s .)
    LOCK_FILE="$REPO_ROOT/.claude/.baseline-fetch.lock"
    _FETCH_LOCK_CREATED=false
    [[ -e "$LOCK_FILE" || -L "$LOCK_FILE" ]] || _FETCH_LOCK_CREATED=true
    mkdir -p "$REPO_ROOT/.claude"
    FETCHED_JSON="$FETCHED_JSON" BASELINE_PROJECT_ID="$BASELINE_PROJECT_ID" \
      BASELINE_REF="$BASELINE_REF" LOCK_FILE="$LOCK_FILE" \
      node --input-type=module -e "
      import { writeFileSync } from 'node:fs';
      const files = JSON.parse(process.env.FETCHED_JSON);
      const lock = {
        version: 1,
        project_id: Number(process.env.BASELINE_PROJECT_ID),
        baseline_ref: process.env.BASELINE_REF,
        fetched_at: new Date().toISOString().replace(/\.\d{3}Z\$/, 'Z'),
        files,
      };
      writeFileSync(process.env.LOCK_FILE, JSON.stringify(lock, null, 2) + '\n');
    "
    echo "Wrote .claude/.baseline-fetch.lock ($(wc -l < "$SUCCESS_LOG" | tr -d ' ') files)"
    if [[ "$_FETCH_LOCK_CREATED" = true ]]; then BOOTSTRAP_FILES+=(.claude/.baseline-fetch.lock); fi
  else
    echo "WARNING: baseline fetch produced no files; rules will arrive via Clank sync MRs (legacy path)" >&2
  fi
  rm -f "$SUCCESS_LOG"
  rm -f "$RULES_MANIFEST"
else
  echo "Skipping baseline fetch: baseline-ref / GITLAB_TOKEN / GITLAB_HOST not configured (legacy Clank-sync path)"
fi
fi
```

**Failure handling:** A private contract/apply error aborts bootstrap. For the public optional remote path, if the fetch fails, this step DOES NOT abort bootstrap. The repo still has its scaffold; rules will arrive via the legacy Clank weekly sync MR. The user is informed via stderr.

**Idempotency:** Private local rules preserve existing files and report them for review. On the public optional remote path, re-running bootstrap on an existing repo will overwrite `.claude/rules/*.md` files. Local edits to baseline rules in a repo will be lost on re-fetch — this is intentional (rules are canonical). Repo-specific extensions belong in `.claude/rules/local/*.md` (not fetched).

---

## #quality-gate-policy — Step 6.5: Quality-Gate Policy File (#183)

Write canonical commands to `.orchestrator/policy/quality-gates.json`. A private
contract supplies exact test/typecheck/lint IDs, with `false` and an unavailable
reason for absent IDs. Public bootstrap retains package-manager defaults.

**Idempotency:** Skip this step if `.orchestrator/policy/quality-gates.json` already exists. Do not overwrite user edits.

```bash
POLICY_FILE="$REPO_ROOT/.orchestrator/policy/quality-gates.json"
if [[ "${PATH_TYPE:-public}" = private ]]; then
  export PLUGIN_ROOT REPO_ROOT CONFIRMED_ARCHETYPE
  POLICY_RESULT=$(node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
const { writeBaselineQualityPolicy } = await import(pathToFileURL(`${process.env.PLUGIN_ROOT}/scripts/lib/baseline-archetypes.mjs`));
const result = await writeBaselineQualityPolicy({ repoRoot: process.env.REPO_ROOT, archetype: process.env.CONFIRMED_ARCHETYPE });
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === 'error') process.exitCode = 2;
NODE
) || exit 2
  printf '%s\n' "$POLICY_RESULT"
  while IFS= read -r _file; do BOOTSTRAP_FILES+=("$_file"); done \
    < <(printf '%s\n' "$POLICY_RESULT" | jq -r '.created[]')
elif [[ ! -e "$POLICY_FILE" && ! -L "$POLICY_FILE" ]]; then
  mkdir -p "$REPO_ROOT/.orchestrator/policy"
  # Detect package manager via scripts/lib/package-manager.mjs (falls back to npm defaults)
  PM_JSON="$(node --input-type=module -e "
    import { detectPackageManager, defaultQualityGateCommands } from '$PLUGIN_ROOT/scripts/lib/package-manager.mjs';
    const pm = detectPackageManager('$REPO_ROOT');
    process.stdout.write(JSON.stringify(defaultQualityGateCommands(pm)));
  " 2>/dev/null)"

  # Fallback if node helper unavailable: hardcode npm defaults
  if [[ -z "$PM_JSON" ]]; then
    PM_JSON='{"test":{"command":"npm test","required":true},"typecheck":{"command":"npm run typecheck","required":true},"lint":{"command":"npm run lint","required":true}}'
  fi

  jq -n --argjson cmds "$PM_JSON" '{
    "version": 1,
    "rationale": "Canonical quality-gate commands. Generated by bootstrap. Edit to change test/typecheck/lint invocations across skills. Schema: .orchestrator/policy/quality-gates.schema.json",
    "commands": $cmds
  }' > "$POLICY_FILE"
  BOOTSTRAP_FILES+=(.orchestrator/policy/quality-gates.json)
  echo "Wrote $POLICY_FILE"
fi
```

---

## #state-md-scaffold — Step 6.6: STATE.md Scaffold (#184)

Scaffold a placeholder `.claude/STATE.md`. <!-- path-check: example -->
Use the template at `skills/bootstrap/STATE.md.template`; the placeholder records `status: idle` — sessions overwrite it at Pre-Wave 1b.

**Idempotency:** Skip if `.claude/STATE.md` already exists. <!-- path-check: example -->

```bash
STATE_FILE="$REPO_ROOT/.claude/STATE.md"
if [[ ! -e "$STATE_FILE" && ! -L "$STATE_FILE" ]]; then
  mkdir -p "$REPO_ROOT/.claude"
  ISO_NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sed "s|<ISO>|$ISO_NOW|g" "$PLUGIN_ROOT/skills/bootstrap/STATE.md.template" > "$STATE_FILE"
  BOOTSTRAP_FILES+=(.claude/STATE.md)
  echo "Wrote $STATE_FILE"
fi
```

On Codex CLI / Cursor IDE, substitute `.codex/` or `.cursor/` for `.claude/` per the platform state-directory convention.
