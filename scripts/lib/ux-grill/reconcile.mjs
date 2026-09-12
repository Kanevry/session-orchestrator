/**
 * ux-grill/reconcile.mjs — route Stufe-1 findings to the issue tracker
 * (PRD § 2 S5, § 3 "Reconcile & Regression" AC 2).
 *
 * This module names NO tracker binary. Every tracker interaction goes
 * through `scripts/lib/test-runner/issue-reconcile.mjs`, which owns the binary
 * allowlist, the `execFile`-not-shell rule (ADR-364 §C5), the arg-boundary
 * validation and the 64 KiB body cap. Grepping this file for the binary name
 * must return zero — that is the invariant, not a coincidence, and it is why the
 * budget gate below reconstructs its command string WITHOUT the binary (the
 * exemption regexes in `issue-budget.mjs` match labels and title templates only,
 * never the program name — measured 2026-09-12 against its `EXEMPT_RULES`).
 *
 * SEVERITY ROUTING (`skills/test-runner/SKILL.md` § Severity Routing / § Batched
 * AUQ Triage, mechanised here):
 *   - `high` (and `critical`, which ux-grill Stufe 1 never emits) → auto-routed
 *     through `triageDecision` → `createFinding` / `updateFinding`.
 *   - `medium` / `low` → NEVER created here. They are returned as `batch` for the
 *     coordinator's ONE bundled AUQ. An agent cannot call `AskUserQuestion`, so
 *     the decision has to travel upward as data.
 *   - `provisional: true` → `batch`, whatever its severity. A dev-build geometry
 *     number is a measurement taken on a basis the PRD declares invalid
 *     (`schema.mjs` § makeFinding), so filing it as a product defect would put a
 *     bundler artefact in the tracker under a `priority::high` label.
 *
 * ISSUE BUDGET. `createFinding` spawns the tracker CLI via `execFile` with
 * `shell: false`, so the `PreToolUse`/Bash hook `hooks/pre-bash-issue-budget.mjs`
 * NEVER sees it —
 * exactly the programmatic hole `scripts/lib/spiral-carryover.mjs` closes by
 * calling `chargeIssueBudget` itself. This module does the same, with the same
 * counting contract and the same ledger: there is one counter, not a second one.
 * A blocked creation is not dropped — it moves to `batch` (so the operator still
 * sees it) and increments `budgetStops`.
 *
 * `dryRun` DEFAULTS TO TRUE. The skill flips it explicitly after the operator has
 * seen the plan. A reconcile helper whose default writes to a live tracker is one
 * mistaken import away from filing issues nobody asked for.
 *
 * Exports:
 *   UX_GRILL_LABELS, buildIssueTitle, buildIssueBody, reconcileFindings
 */

import {
  createFinding as defaultCreateFinding,
  listExistingFindings as defaultListExisting,
  triageDecision,
  updateFinding as defaultUpdateFinding,
} from '../test-runner/issue-reconcile.mjs';
import { chargeIssueBudget } from '../issue-budget.mjs';

/**
 * Labels applied to every auto-created ux-grill issue.
 *
 * Spelling follows `skills/gitlab-ops/SKILL.md` § Label Taxonomy EXACTLY:
 * `from:` is single-colon, `priority::` is double-colon (measured there:
 * 416 `priority::` against 249 `priority:` on the instance). Only `high`
 * findings are auto-created, so the priority label is constant.
 * @type {string}
 */
export const UX_GRILL_LABELS = 'from:ux-grill,priority::high';

/** Label used to QUERY already-filed ux-grill issues (the `from:` axis alone). */
export const UX_GRILL_QUERY_LABEL = 'from:ux-grill';

/** GitLab issue titles are capped well above this; 100 keeps a list readable. */
const TITLE_MAX_LENGTH = 100;

/** Severities that are auto-routed to the tracker. `critical` is future-proofing. */
const AUTO_SEVERITIES = Object.freeze(['critical', 'high']);

/**
 * Neutralise a fingerprint-sentinel literal in free text (#388 SEC-IR-MED-1).
 *
 * `issue-reconcile.mjs` applies this to `recommendation` only, inside
 * `reconcileFinding` — a body built HERE and handed to `createFinding` is not
 * sanitised by anything, so a finding `message` echoing page text could forge
 * the authoritative `**Fingerprint:**` line and make the next run's
 * `triageDecision` dedup against the wrong issue.
 *
 * @param {unknown} text
 * @returns {string}
 */
function sanitizeSentinel(text) {
  return String(text ?? '').replace(/\*\*Fingerprint:\*\*/gi, '__Fingerprint__');
}

/**
 * Strip the characters `createFinding` rejects at the argv boundary, so a
 * multi-line page title in a finding message cannot turn into a VALIDATION
 * failure for the whole reconcile pass.
 *
 * @param {unknown} text
 * @returns {string}
 */
function oneLine(text) {
  return sanitizeSentinel(text).replace(/[\n\r\0]+/g, ' ').trim();
}

/**
 * `route|viewport` — the first two locator segments (`schema.mjs` § makeFinding).
 * @param {string} locator
 * @returns {string}
 */
function locatorScope(locator) {
  return String(locator ?? '').split('|').slice(0, 2).join('|');
}

/**
 * Build the issue title: `[ux-grill] <checkId> — <route|viewport>`, capped at 100.
 *
 * The title is a `triageDecision` input (fuzzy Levenshtein ≤ 2 match), so it must
 * stay stable across runs for one finding — hence checkId + scope and NOT the
 * measured value, which changes with every layout tweak and would make every run
 * look like a new issue.
 *
 * @param {{checkId: string, locator: string}} finding
 * @returns {string}
 */
export function buildIssueTitle(finding) {
  const title = `[ux-grill] ${oneLine(finding?.checkId)} — ${oneLine(locatorScope(finding?.locator))}`;
  return title.slice(0, TITLE_MAX_LENGTH);
}

/**
 * Build the issue body.
 *
 * Carries the authoritative `**Fingerprint:** \`<fp>\`` sentinel in the exact
 * shape `issue-reconcile.mjs`'s `extractFingerprintFromBody` matches —
 * `createFinding` does NOT append it (verified 2026-09-12: its `args` are
 * `['issue','create','--title',…,'--description',body]`, the `fingerprint`
 * parameter is validated and otherwise unused). Without this line the next run
 * cannot dedup and files the same finding again.
 *
 * WHAT MUST NEVER BE IN HERE: an env value (the manifest resolves credentials by
 * ENV NAME and `collect.mjs` never puts them in a finding) and an absolute host
 * path. Evidence paths are already run-dir-relative — `collect()` stores
 * `path.relative(runDir, …)` — and {@link reconcileFindings} rejects a finding
 * carrying an absolute one rather than publishing an operator's home directory
 * to a tracker.
 *
 * @param {object} finding - a `makeFinding` record
 * @param {object} [context]
 * @param {string} [context.runId]
 * @param {string} [context.rubricHash]
 * @returns {string}
 */
export function buildIssueBody(finding, { runId, rubricHash } = {}) {
  const evidence = finding?.evidence ?? {};
  const evidenceLines = Object.entries(evidence)
    .filter(([, value]) => typeof value === 'string' || Array.isArray(value))
    .map(([key, value]) => `- \`${key}\`: ${oneLine(Array.isArray(value) ? value.join(', ') : value)}`);

  return [
    oneLine(finding?.message) || `${oneLine(finding?.checkId)} at ${oneLine(finding?.locator)}`,
    '',
    `**Fingerprint:** \`${oneLine(finding?.fingerprint)}\``,
    `**Severity:** ${oneLine(finding?.severity)}`,
    `**Check:** ${oneLine(finding?.checkId)}`,
    `**Locator:** \`${oneLine(finding?.locator)}\``,
    `**Provisional:** ${finding?.provisional === true}`,
    runId ? `**Run:** \`${oneLine(runId)}\`` : null,
    rubricHash ? `**Rubric hash:** \`${oneLine(rubricHash)}\`` : null,
    evidenceLines.length > 0 ? '' : null,
    evidenceLines.length > 0 ? '**Evidence** (paths are relative to the run directory):' : null,
    ...evidenceLines,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Collect every string in a finding's `evidence` that looks like an absolute
 * host path (POSIX `/…` or Windows `C:\…`).
 *
 * @param {object} finding
 * @returns {string[]}
 */
function absoluteEvidencePaths(finding) {
  const out = [];
  for (const value of Object.values(finding?.evidence ?? {})) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry !== 'string') continue;
      if (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) out.push(entry);
    }
  }
  return out;
}

/**
 * Default budget gate — the SAME `chargeIssueBudget` decision the Bash hook and
 * `spiral-carryover.mjs` apply, against the same per-session ledger.
 *
 * @param {{repoRoot: string, sessionId: string|null, title: string}} opts
 * @returns {{decision: string, count: number, max: number, reason?: string|null}}
 */
function defaultBudget({ repoRoot, sessionId, title }) {
  // classifyExemption() reads a COMMAND string; reconstruct the argv this
  // creation is about to become so exemption classification (`priority::critical`,
  // carryover) sees what it would have seen on the shell path.
  const command = `issue create --title ${JSON.stringify(title)} --label ${UX_GRILL_LABELS}`;
  return chargeIssueBudget({ repoRoot, sessionId, command, title });
}

/**
 * Route a run's findings to the issue tracker.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute repo root (ledger root AND the cwd
 *   `issue-reconcile.mjs` auto-detects the `--repo` spec from)
 * @param {string} [opts.runId] - stamped into every body
 * @param {string} [opts.rubricHash] - stamped into every body
 * @param {Array<object>} opts.findings - `makeFinding` records
 * @param {string} [opts.project] - explicit GitLab project path; omitted → the
 *   spine auto-detects it from `repoRoot`'s git remotes
 * @param {boolean} [opts.dryRun=true] - TRUE by default; see module header
 * @param {Function} [opts.execFile] - DI seam handed straight to the spine
 * @param {string|null} [opts.sessionId=null] - issue-budget accounting key
 * @param {Function} [opts.budget] - budget gate; defaults to `chargeIssueBudget`
 * @param {Function} [opts.listExisting=listExistingFindings]
 * @param {Function} [opts.create=createFinding]
 * @param {Function} [opts.update=updateFinding]
 * @returns {Promise<{
 *   created: object[], updated: object[], ignored: object[], batch: object[],
 *   errors: object[], budgetStops: number, dryRun: boolean
 * }>} `batch` is the medium/low + provisional + budget-stopped set the
 *   coordinator turns into ONE AUQ. `errors` carries per-finding refusals and a
 *   tracker-query failure (`code: 'list-failed'`) — a failed query means the
 *   dedup set is unknown, so NOTHING is created and every auto finding moves to
 *   `batch` rather than risking duplicates.
 * @throws {TypeError} on a missing `repoRoot` or a non-array `findings`
 */
export async function reconcileFindings({
  repoRoot,
  runId,
  rubricHash,
  findings,
  project,
  dryRun = true,
  execFile,
  sessionId = null,
  budget = defaultBudget,
  listExisting = defaultListExisting,
  create = defaultCreateFinding,
  update = defaultUpdateFinding,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('reconcileFindings: repoRoot must be a non-empty string');
  }
  if (!Array.isArray(findings)) {
    throw new TypeError('reconcileFindings: findings must be an array');
  }

  const created = [];
  const updated = [];
  const ignored = [];
  const batch = [];
  const errors = [];
  let budgetStops = 0;

  const auto = [];
  for (const finding of findings) {
    const isAuto = AUTO_SEVERITIES.includes(finding?.severity) && finding?.provisional !== true;
    (isAuto ? auto : batch).push(finding);
  }
  // Deterministic order: the budget cap decides WHICH findings get filed, so the
  // order must not depend on how the findings array happened to be built.
  auto.sort((a, b) => (a?.fingerprint < b?.fingerprint ? -1 : a?.fingerprint > b?.fingerprint ? 1 : 0));

  if (auto.length === 0) {
    return { created, updated, ignored, batch, errors, budgetStops, dryRun };
  }

  const existing = await listExisting({
    project,
    label: UX_GRILL_QUERY_LABEL,
    repoRoot,
    execFile,
  });
  if (!existing?.ok) {
    errors.push({ code: 'list-failed', error: existing?.error ?? null });
    batch.push(...auto);
    return { created, updated, ignored, batch, errors, budgetStops, dryRun };
  }
  const candidates = existing.issues ?? [];

  for (const finding of auto) {
    const leaked = absoluteEvidencePaths(finding);
    if (leaked.length > 0) {
      errors.push({
        code: 'absolute-evidence-path',
        fingerprint: finding?.fingerprint ?? null,
        paths: leaked,
      });
      batch.push(finding);
      continue;
    }

    const title = buildIssueTitle(finding);
    const body = buildIssueBody(finding, { runId, rubricHash });
    const decision = triageDecision({ fingerprint: finding?.fingerprint, title }, candidates);

    if (decision.action === 'ignore') {
      ignored.push({ finding, decision });
      continue;
    }

    if (decision.action === 'update') {
      const result = await update({
        project,
        iid: decision.target,
        comment: `Still present in ux-grill run \`${oneLine(runId)}\`.\n\n${body}`,
        dryRun,
        execFile,
        repoRoot,
      });
      if (result?.ok) updated.push({ finding, decision, iid: decision.target, result });
      else errors.push({ code: 'update-failed', fingerprint: finding?.fingerprint ?? null, error: result?.error ?? null });
      continue;
    }

    // create — the only action the budget bounds.
    const verdict = budget({ repoRoot, sessionId, title, finding });
    if (verdict?.decision === 'block') {
      budgetStops += 1;
      batch.push(finding);
      continue;
    }

    const result = await create({
      project,
      fingerprint: finding?.fingerprint,
      title,
      body,
      labels: UX_GRILL_LABELS,
      dryRun,
      execFile,
      repoRoot,
    });
    if (result?.ok) created.push({ finding, decision, result, budget: verdict?.decision ?? null });
    else errors.push({ code: 'create-failed', fingerprint: finding?.fingerprint ?? null, error: result?.error ?? null });
  }

  return { created, updated, ignored, batch, errors, budgetStops, dryRun };
}
