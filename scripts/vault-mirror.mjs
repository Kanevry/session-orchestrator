#!/usr/bin/env node
/**
 * vault-mirror.mjs — JSONL-to-Markdown mirror for the Meta-Vault (Issue #14).
 *
 * Reads a JSONL file (one JSON object per line), produces Markdown notes with
 * valid vaultFrontmatterSchema frontmatter, and writes them into the vault.
 *
 * CLI usage:
 *   node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session>
 *                         [--dry-run] [--strict-schema] [--no-commit] [--force]
 *                         [--session-id <id>] [--repo-root <path>] [--vault-name <name>]
 *                         [--quality-min-narrative-chars <int>]  (sessions only; default 400)
 *                         [--quality-min-confidence <float>]     (learnings only; default 0.5)
 *
 * Exit codes:
 *   0 — success (including idempotent no-op)
 *   1 — validation error (malformed JSON line, bad slug, etc.)
 *   2 — filesystem error, or a pre-loop refusal (missing vault-dir / source,
 *       non-canonical vault, `--source` belonging to a different repo than
 *       `--repo-root` — #1503)
 *
 * Output: one JSON line per action on stdout:
 *   {"action":"created|updated|skipped-noop|skipped-handwritten|skipped-collision-resolved|skipped-foreign-owner|skipped-invalid|skipped-quality-low|skipped-abandoned|skipped-duplicate-session","path":"...","kind":"...","id":"..."}
 *
 * Idempotency rules:
 *   1. File does not exist → create.
 *   2. File exists, has _generator marker, id matches → overwrite only if updated would advance; else skipped-noop.
 *   3. File exists, lacks _generator → skip (hand-written). Log to stderr.
 *   4. File exists, has _generator, id differs → collision-disambiguate by appending -<first8 of uuid>.
 *      (Sessions have no disambiguation: a different-id note is skipped-foreign-owner.)
 *   5. File exists, has _generator, but its `source-record` names a different record
 *      than this write (#1503): learnings → collision-disambiguate as in rule 4;
 *      sessions → skipped-foreign-owner unless the key occurs in this --source ledger.
 *      A leak in such a foreign note is masked IN PLACE (owner, content and
 *      source-record kept; `healed_leak: true` on the action) — never rewritten
 *      from this record. If the masked frontmatter would not parse, it is left
 *      unchanged with a stderr WARN.
 *
 * Repo root (#1503): the namespace is the identity of the repo the --source
 * ledger belongs to — `--repo-root` when given, else the project holding
 * --source (`<root>/.orchestrator/metrics/`), else the git repo containing it,
 * else the cwd (a loose source outside any git repo). It is never the cwd
 * when the source sits in a repo: running from another repo's checkout used to
 * write one project's records over another project's notes.
 *
 * Quality gate (PRD F1.2):
 *   Learnings with confidence < --quality-min-confidence emit `skipped-quality-low`.
 *   Sessions with rendered-narrative length < --quality-min-narrative-chars emit
 *   `skipped-quality-low`. Quality gate runs BEFORE --force; --force does NOT
 *   bypass the filter. Quality-skipped entries emit `path: null` and an
 *   additional `reason` field describing the violated threshold.
 *
 * Excluded sidecars (#502 + #506):
 *   vault-mirror operates EXCLUSIVELY on JSONL sources passed via --source.
 *   The following cross-session sidecars MUST NEVER be mirrored into the
 *   vault, even if a future refactor adds directory-walking. They live under
 *   `.orchestrator/` deliberately so they survive a session close without
 *   being copied into `50-sessions/`:
 *     - `.orchestrator/pending-dream.md` (auto-dream sidecar, PRD F2.2 / #502)
 *     - `.orchestrator/dialectic-pending.md` (auto-dialectic sidecar, PRD F2.5 / #506)
 *   The next session consumes these via `/memory-cleanup --apply-pending`
 *   and `/evolve --dialectic --apply`, respectively — vault-mirror has no
 *   role in their lifecycle.
 *
 * Part of session-orchestrator vault-mirror (Issue #14).
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

import {
  processLearning,
  processSession,
  getMaskerStats,
  emitAction,
} from './lib/vault-mirror/process.mjs';
import { emitMirrorEvent, emitMirrorRunEvent } from './lib/vault-mirror/telemetry.mjs';
import { emitEvent } from './lib/events.mjs';
import { autoCommitVaultMirror } from './lib/vault-mirror/auto-commit.mjs';
import { parseColumnFlags, CliFlagError } from './lib/cli-flags.mjs';
import { resolveRepoNamespace } from './lib/vault-mirror/namespace.mjs';
import { sessionSourceRecord } from './lib/vault-mirror/render-sessions.mjs';
import { checkCanonicalVault, describeOriginForLog, findRepoRoot, normalizeRemote } from './lib/named-vault-resolver.mjs';
import { loadOwnerConfig } from './lib/owner-yaml.mjs';
import { canonicalizeSessions } from './lib/sessions-canonical.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { expandTilde, redactHomeDir } from './lib/common.mjs';

// ── Canonical-vault helpers (#600 D2 / #607 D2) ────────────────────────────────
// These are module-level (above the CLI bootstrap) so the module is import-safe
// for unit tests: importing scripts/vault-mirror.mjs from vitest pulls in these
// exported helpers WITHOUT running the CLI (the CLI bootstrap + main() are gated
// behind an import.meta.url entry-guard at the bottom). The canonical-vault
// guard usage lives in main(); see the rationale block there.

/**
 * Resolve the canonical vault suffix from an env override, defaulting to
 * `/agents/vault` when the override is missing or blank (whitespace-only).
 * Pure helper so the empty-/whitespace-string fallback is unit-testable without
 * mutating process.env (#607 D2). Returns the TRIMMED override when set, so a
 * value like `"  gitlab.example.com/agents/vault  "` matches as expected.
 * @param {string|undefined} envValue
 * @returns {string}
 */
export function _resolveCanonicalSuffix(envValue) {
  return envValue && envValue.trim() ? envValue.trim() : '/agents/vault';
}

// Kept for documentation; the guard now uses checkCanonicalVault() which
// generalises this to N suffixes. The `_` prefix satisfies the no-unused-vars rule.
const _CANONICAL_VAULT_SUFFIX = _resolveCanonicalSuffix(
  process.env.VAULT_MIRROR_CANONICAL_SUFFIX,
);

/**
 * Normalize a git remote URL to a host/path tail for canonical-suffix matching
 * (#607 D2 — exported for unit tests). Since #1450 the ONE implementation is
 * `normalizeRemote` in lib/named-vault-resolver.mjs, shared with the board
 * writer's guard; this name is kept for the existing test imports.
 * @param {string} url
 * @returns {string}
 */
export function _normalizeRemote(url) {
  return normalizeRemote(url);
}

// ── Mirror telemetry (#1116) ──────────────────────────────────────────────────
//
// The mirror run itself used to be SILENT in `.orchestrator/metrics/events.jsonl`
// (measured 2026-08-23: `jq -r '.event' … | grep -icE 'board|mirror'` → 0 of
// 28 387 records; the only event this CLI emitted was
// `orchestrator.secret_masker.applied`). The expensive consequence is the
// `skipped-invalid` path below: a schema-invalid record is reported on stdout
// and the process still exits 0, so the affected session ends up WITHOUT a vault
// note and nothing durable records which one.
//
// Design constraints, all load-bearing:
//   - Additive only. The stdout JSON protocol is untouched; consumers parse it.
//   - Best-effort. A telemetry failure must never fail a mirror run, so every
//     emit is wrapped and its rejection swallowed (same posture as the masker
//     emit at the end of main()).
//   - "Absent is not zero" (docs/events-schema.md): a field that was not
//     measured is OMITTED, never written as 0/null. Hence no `path` key here —
//     these emit sites are reached BEFORE any target path is resolved, so there
//     is no path to report. `record_id` is likewise omitted when the record
//     carries neither `id` nor `session_id`; `line` is the fallback locator that
//     is always measured.
//   - Same ledger as the masker emit: `emitEvent` is called 2-arg so both events
//     from one run resolve the SAME destination (`SO_PROJECT_DIR`, i.e.
//     `CLAUDE_PROJECT_DIR` or the CWD walk-up). The repo root that decides the
//     vault NAMESPACE (#1503: `--repo-root`, else derived from `--source`) is
//     deliberately NOT used for the ledger — routing telemetry by it would split
//     a single run's records across two ledgers.
//
// #1147 moved both emitters into `scripts/lib/vault-mirror/telemetry.mjs` and
// widened the coverage from "the two skipped-invalid branches" to "every entry,
// plus one run-level roll-up":
//   - `emitMirrorEvent` is now also called from `process.mjs`'s 18 `emitAction`
//     sites, so `created`/`updated`/every `skipped-*` gets a record too.
//   - `emitMirrorRunEvent` adds the DENOMINATOR. Per-entry records alone cannot
//     distinguish "healthy run over an empty source" from "the emitter is
//     broken" — both write nothing (HR-105). The run event is emitted
//     unconditionally, so `total: 0` is a measured zero.

// ── CLI argument parsing ──────────────────────────────────────────────────────
//
// Migrated to scripts/lib/cli-flags.mjs (#510). Behaviour changes vs prior
// hand-rolled getArg() parser:
//   - Unknown flags now exit 1 instead of being SILENTLY IGNORED. This is an
//     intentional uniform reject policy per #510 — grep-verified that no
//     current caller passes unknown flags (3 invocation sites: session-end
//     Phase 1, evolve Phase, vault-mirror SKILL examples; all use known flags
//     only). See W2 STATUS for the grep evidence.
// Behaviour explicitly preserved:
//   - Wet-run is the DEFAULT (omitting --dry-run → live write). This script
//     stays divergent from the other 3 migration scripts on purpose; flipping
//     it to dry-run-default would break every existing invocation in
//     skills/session-end/, skills/evolve/, and skills/vault-mirror/.
//   - --help / -h prints to stdout and exits 0 BEFORE any required-flag check.
//   - Int/float coercion for --quality-min-* (strict — string input → exit 1).

// Entry-guard (#607 D2): run the CLI bootstrap (arg parsing, validation, and
// main()) ONLY when this file is invoked directly as a subprocess
// (`node vault-mirror.mjs ...`). When imported from a unit test, argv belongs to
// the test runner — parsing it would spuriously process.exit. The exported
// helpers above are unaffected by this guard.
const _isDirectInvocation =isMainModule(import.meta.url);

if (_isDirectInvocation) {
  let parsedFlags;
  try {
    parsedFlags = parseColumnFlags({
    knownBool: {
      help: { short: 'h', default: false },
      'dry-run': false,
      'strict-schema': false,
      'no-commit': false,
      force: false,
    },
    knownString: {
      'vault-dir': null,
      source: null,
      kind: null,
      'session-id': null,
      'vault-name': null,
      'repo-root': null,
      'quality-min-narrative-chars': null,
      'quality-min-confidence': null,
    },
  });
} catch (err) {
  if (err instanceof CliFlagError) {
    process.stderr.write(`vault-mirror: ${redactHomeDir(err.message)}\n`);
    process.exit(1);
  }
  throw err;
}

const flagValues = parsedFlags.values;

// --help support: print usage and exit 0 (no other validation runs).
if (flagValues.help === true) {
  process.stdout.write(
    [
      'Usage: node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session>',
      '                              [--dry-run] [--strict-schema] [--no-commit] [--force]',
      '                              [--session-id <id>] [--repo-root <path>] [--vault-name <name>]',
      '                              [--quality-min-narrative-chars <int>]',
      '                              [--quality-min-confidence <float>]',
      '',
      'Options:',
      '  --vault-dir <path>                    Absolute path to the Meta-Vault root (required).',
      '  --source <path>                       Path to a JSONL file to mirror (required).',
      '  --kind <learning|session>             Entry kind to process (required).',
      '  --dry-run                             Parse + render but write nothing.',
      '  --strict-schema                       Abort with exit 1 if any entry was skipped-invalid.',
      '  --no-commit                           Suppress the auto-commit phase (default if --session-id is omitted).',
      '  --force                               Re-render existing notes even when updated would not advance.',
      '                                        NOTE: --force does NOT bypass the quality gate (PRD F1.2).',
      '  --session-id <id>                     Opt-in: also auto-commit mirror artifacts on success.',
      '  --vault-name <name>                   Override the repo-derived namespace segment in the vault.',
      '                                        When set, mirrors write under <vault-name>/ instead of the',
      '                                        git-derived repo identifier. Maps to vault-integration.vault-name',
      '                                        in Session Config. Sanitised to a lowercase kebab slug.',
      '  --repo-root <path>                    The repo whose ledger --source is (#1503). Its .vault.yaml',
      '                                        slug / git remote decides the vault namespace. Default: the',
      '                                        project holding --source (<root>/.orchestrator/metrics/), else',
      '                                        the git repo containing it, else the cwd. Refused (exit 2,',
      '                                        "source-repo-mismatch") when --source lies in a different repo.',
      '  --quality-min-narrative-chars <int>   Sessions: minimum rendered-narrative length (default 400).',
      '                                        Entries below the threshold emit "skipped-quality-low".',
      '  --quality-min-confidence <float>      Learnings: minimum confidence threshold (default 0.5).',
      '                                        Entries below the threshold emit "skipped-quality-low".',
      '',
      'See skills/vault-mirror/SKILL.md for full action semantics.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

// Expand a leading `~` before anything touches the path: owner.yaml `vault-dirs:` /
// `paths.vault-dir` and the committed Session Config all accept `~/…`, and a quoted
// `--vault-dir "~/…"` reaches us literally. `resolve('~/x')` would yield `<cwd>/~/x`
// and the existsSync check below would abort with `missing-vault-dir` (agents/vault#319).
const vaultDir = expandTilde(flagValues['vault-dir']);
const source = flagValues.source;
const kind = flagValues.kind;
const dryRun = flagValues['dry-run'] === true;
const strictSchema = flagValues['strict-schema'] === true;
const noCommit = flagValues['no-commit'] === true;
const force = flagValues.force === true;
const sessionIdArg = flagValues['session-id'];
const vaultName = flagValues['vault-name'] ?? null;
const repoRootArg = flagValues['repo-root'] ?? null;

// Quality-gate thresholds (PRD F1.2). Parse as numbers; reject malformed input
// loudly so CI cannot accidentally pass a string ("400px") and silently fall
// back to NaN comparisons (NaN < anything === false → quality gate disabled).
const QUALITY_MIN_NARRATIVE_DEFAULT = 400;
const QUALITY_MIN_CONFIDENCE_DEFAULT = 0.5;

function parseIntFlag(name, raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== String(raw).trim()) {
    process.stderr.write(`vault-mirror: invalid integer for ${name}: "${raw}"\n`);
    process.exit(1);
  }
  return n;
}

function parseFloatFlag(name, raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    process.stderr.write(`vault-mirror: invalid number for ${name}: "${raw}"\n`);
    process.exit(1);
  }
  return n;
}

const qualityMinNarrativeChars = parseIntFlag(
  '--quality-min-narrative-chars',
  flagValues['quality-min-narrative-chars'],
  QUALITY_MIN_NARRATIVE_DEFAULT,
);
const qualityMinConfidence = parseFloatFlag(
  '--quality-min-confidence',
  flagValues['quality-min-confidence'],
  QUALITY_MIN_CONFIDENCE_DEFAULT,
);

if (!vaultDir || !source || !kind) {
  process.stderr.write(
    'Usage: node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session> [--dry-run] [--strict-schema] [--no-commit] [--force] [--session-id <id>] [--repo-root <path>] [--vault-name <name>] [--quality-min-narrative-chars <int>] [--quality-min-confidence <float>]\n',
  );
  process.exit(1);
}

if (kind !== 'learning' && kind !== 'session') {
  process.stderr.write(`vault-mirror: invalid --kind "${kind}" (expected learning or session)\n`);
  process.exit(1);
}

// ── Canonical Meta-Vault guard (#600 D2) ───────────────────────────────────────
//
// vault-dir-drift proximate cause: the existsSync(vaultDir) check below passes for
// ANY directory that happens to exist on disk. When a stray wrong-target path
// existed (e.g. a typo'd vault location), mirror writes succeeded SILENTLY into
// it — the wrong vault accumulated notes and the real Meta-Vault drifted.
//
// Defense: probe the vault-dir's git origin and refuse to mirror unless its URL
// ends with the canonical-vault path suffix (default `/agents/vault`; override
// via env VAULT_MIRROR_CANONICAL_SUFFIX, e.g. `<host>/agents/vault` for a strict
// host-qualified check). A wrong vault is a WHOLE-RUN failure (process.exit(2)),
// not a per-entry skip — mirroring even one note into the wrong place is the bug.
//
// `git remote get-url origin` exit codes (probed): 128 = not a git repo,
// 2 = git repo without an origin remote, 0 = prints the URL. Any non-zero exit or
// a non-matching URL fails closed.
//
// The VAULT_MIRROR_SKIP_CANONICAL_CHECK=1 escape hatch is load-bearing for the
// test suite: vault-mirror's own tests mirror into non-git tmp dirs and must
// bypass this network-of-trust check. It is NOT documented as an operator flag —
// production callers (session-end Phase 3.7, evolve) always target the real vault.
// Apply the same trim-as-truthy-probe pattern as #601 getConfinementRoot: a
// whitespace-only env override would otherwise short-circuit `||` and yield a
// meaningless suffix. Fail-safe (a non-matching suffix only widens rejection),
// but the bug class is recurring — fix at the source. The helpers + the
// CANONICAL_VAULT_SUFFIX const live near the top of the module (just after the
// imports) so they are import-safe and unit-testable; see _resolveCanonicalSuffix
// / _normalizeRemote there (#607 D2).

/**
 * Render a CLI path flag for a stderr line as its basename only (#1479).
 *
 * This CLI's stderr lands in CI logs and session transcripts, and an absolute
 * `--vault-dir` / `--source` carries the operator's home directory — the
 * owner-leakage class `.claude/rules/security.md` § Owner-Privacy guards. The
 * basename still says WHICH value was wrong; the caller passed the full path
 * and already knows it.
 * @param {string} p
 * @returns {string}
 */
function pathForLog(p) {
  return `.../${basename(String(p ?? ''))}`;
}

/**
 * The project a ledger belongs to (#1503): the directory that holds it under
 * the `.orchestrator/metrics/` convention, else the git repo containing it,
 * else `null`.
 *
 * The convention comes FIRST because the git toplevel is the wrong answer for
 * a project nested inside a repo — a monorepo package with its own
 * `.orchestrator/` and `.vault.yaml` (measured: `--repo-root <package>` was
 * refused against the monorepo's namespace, and without the flag the package's
 * notes moved to the monorepo's folder). Every producer writes the ledgers to
 * `<project>/.orchestrator/metrics/`, which is also exactly the directory whose
 * `.vault.yaml` named the namespace before #1503 (callers ran from it).
 *
 * Named ceiling: a ledger stored under some project's `.orchestrator/metrics/`
 * is attributed to that project whoever wrote its records — a foreign ledger
 * COPIED there is not detected here; the session `source-record` guard in
 * process.mjs is the remaining defence for that shape.
 *
 * @param {string} realSource - the source path after `realpathSync`.
 * @returns {string|null}
 */
function ledgerOwnerRoot(realSource) {
  const metricsDir = dirname(realSource);
  const orchestratorDir = dirname(metricsDir);
  if (basename(metricsDir) === 'metrics' && basename(orchestratorDir) === '.orchestrator') {
    return dirname(orchestratorDir);
  }
  return findRepoRoot(dirname(realSource));
}

// ── Run-level accounting + run close-out (#1147) ──────────────────────────────
//
// Deliberately OUTSIDE main(): the run event's whole contract is that it is
// written ONCE PER RUN and that its ABSENCE is the broken-emitter signal
// (HR-105). Seven exits bypass main's normal tail — the four PRE-LOOP aborts at
// the top of main (missing vault-dir, non-canonical vault, missing source,
// source/repo-root mismatch), the malformed-JSON abort and the filesystem-error
// abort inside the loop (all six `process.exit`, which no `finally` and no
// `catch` can intercept), and the top-level `main().catch`, which runs in a
// scope where main's locals no longer exist. Keeping the counters and the
// emitter out here is what lets all seven
// close the run out through ONE function instead of each re-deriving the
// payload.
const runState = {
  /** Non-blank JSONL lines the run ATTEMPTED — the denominator. */
  total: 0,
  /** Entries that produced `skipped-invalid` (validation error or mapper crash). */
  skippedInvalid: 0,
  /** Per-`action` tally, keyed by the same strings the entries wrote to stdout. */
  actions: new Map(),
  /** Latch: the run may only be closed out once. */
  finished: false,
};

/** Count one entry action into {@link runState}. Ignores a non-string action. */
const tally = (action) => {
  if (typeof action !== 'string' || action.length === 0) return;
  runState.actions.set(action, (runState.actions.get(action) ?? 0) + 1);
};

/**
 * Close the run out: emit the run-level roll-up AND the masking roll-up,
 * exactly once. Never throws, never exits — the caller owns the exit code.
 *
 * Both emits are documented as unconditional, and both used to sit only on the
 * happy tail: an abort skipped them, so the very runs an operator most wants
 * counted were the ones that vanished from the ledger, in the one shape
 * ("no record") that the docstring reserves for a broken emitter.
 *
 * @param {'missing-vault-dir'|'vault-not-canonical'|'missing-source'|'source-repo-mismatch'|'malformed-json'|'filesystem-error'|'unexpected-error'} [aborted]
 *   Omitted on a complete run. When present it LABELS the counters as partial:
 *   every line after the abort was never attempted, so the classes no longer
 *   partition `total`. On the PRE-LOOP values (#1151, #1503) nothing was
 *   attempted at all — `total` is a measured 0 and the label is what separates
 *   "never started" from "ran over an empty source".
 * @returns {Promise<void>}
 */
async function finishRun(aborted) {
  if (runState.finished) return;
  runState.finished = true;

  const countOf = (action) => runState.actions.get(action) ?? 0;
  const actionBreakdown = Object.fromEntries(runState.actions);
  await emitMirrorRunEvent({
    kind,
    total: runState.total,
    created: countOf('created'),
    updated: countOf('updated'),
    // Every non-failure skip class, summed from the SAME map the breakdown is
    // built from — `skipped-invalid` is deliberately excluded and reported as
    // `failed`, because those are the entries whose session silently ends up
    // without a vault note.
    skipped: [...runState.actions].reduce(
      (sum, [action, n]) =>
        action.startsWith('skipped-') && action !== 'skipped-invalid' ? sum + n : sum,
      0,
    ),
    failed: runState.skippedInvalid,
    actionBreakdown,
    dryRun,
    ...(aborted ? { aborted } : {}),
  });

  // ── Masking telemetry (#1025) ───────────────────────────────────────────────
  //
  // Emitted here, at the END of the run, rather than at the lazy build site
  // inside process.mjs. The build site is only reached once a record is actually
  // processed, so a run over an empty/fully-skipped source would emit nothing and
  // "the masker never ran" would be indistinguishable from "this channel has no
  // masker wired".
  //
  // Counts only — never a needle, never a prefix of one, never masked text.
  // Best-effort: a telemetry write must never be the reason a mirror run fails.
  try {
    const maskerStats = getMaskerStats();
    await emitEvent('orchestrator.secret_masker.applied', {
      channel: 'vault-mirror',
      needle_count: maskerStats.needleCount,
      records: maskerStats.records,
      hits: maskerStats.hits,
      dry_run: dryRun,
    });
  } catch {
    // Silent no-op — see the note above.
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // The PRE-LOOP aborts below (#1151, #1503) close the run out through the same
  // `finishRun` every other exit uses. They are the runs that never reached
  // their first entry — a bad vault-dir, a wrong vault, a missing source — and
  // until now they were the only outcomes that left NO record at all, which is
  // the one shape the run event reserves for a broken emitter. Their counters
  // are all `0`, and `aborted` is what makes that zero readable as "never
  // started" rather than "ran over an empty source".
  if (!existsSync(resolve(vaultDir))) {
    process.stderr.write(`vault-mirror: vault-dir not found: ${pathForLog(vaultDir)}\n`);
    await finishRun('missing-vault-dir');
    process.exit(2);
  }

  // The check itself — origin probe, suffix match, the SKIP_CANONICAL_CHECK
  // escape hatch — is the shared `checkCanonicalVault` (#1450), the same one the
  // board writer applies, so the two vault writers cannot drift apart again.
  const canonical = checkCanonicalVault({
    vaultDir: resolve(vaultDir),
    ownerConfig: loadOwnerConfig().config,
    env: process.env,
  });
  if (!canonical.ok) {
    process.stderr.write(
      `vault-mirror: refusing to mirror — vault is not the canonical Meta-Vault (expected git origin ending in one of: ${canonical.expected.join(', ')}; got ${describeOriginForLog(canonical.got) || 'no git origin'})\n`,
    );
    await finishRun('vault-not-canonical');
    process.exit(2);
  }

  if (!existsSync(resolve(source))) {
    process.stderr.write(`vault-mirror: source file not found: ${pathForLog(source)}\n`);
    await finishRun('missing-source');
    process.exit(2);
  }

  // ── Repo root + source/repo-root agreement (#1503) ──────────────────────────
  //
  // The namespace every note is written under is the identity of `repoRoot`.
  // Until #1503 that was hard-wired to the invocation cwd, while `--source` was
  // free to name ANY ledger: a session that ran this CLI from another repo's
  // checkout with `--source <ThisRepo>/.orchestrator/metrics/sessions.jsonl`
  // wrote 130 of this repo's records under the OTHER repo's namespace and
  // overwrote 3 of its notes — slug and session-id collisions are routine across
  // repos. The fix is to stop asking the cwd:
  //   1. `--repo-root` when given — the caller states which repo it mirrors;
  //   2. else the ledger's own project — see {@link ledgerOwnerRoot};
  //   3. else the cwd — only for a source that is neither a project ledger nor
  //      inside a git repo (a copied ledger, the test suites' mkdtemp sources),
  //      where nothing better is knowable.
  // Step 2's answer is also what an explicit `--repo-root` is checked against.
  //
  // The ledger's REAL path decides, not the path it was handed under: a symlink
  // inside repo A that points at repo B's ledger is B's ledger. `realpathSync`
  // falls back to the lexical path only when it throws (the file was just
  // proven to exist, so that is a race or a permission edge, not a normal case).
  // The same holds for `--repo-root`: a remote-less, slug-less repo is named by
  // its directory, so a root reached through a symlink would otherwise carry the
  // LINK's name and be refused against its own ledger.
  const realOrLexical = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const sourceRealPath = realOrLexical(resolve(source));
  const sourceRepoRoot = ledgerOwnerRoot(sourceRealPath);
  const repoRoot = repoRootArg
    ? realOrLexical(resolve(expandTilde(repoRootArg)))
    : (sourceRepoRoot ?? process.cwd());

  // A source with no owning project cannot be checked against anything: the
  // namespace then rests on the cwd or on an unverifiable `--repo-root`, and a
  // ledger copied out of ANOTHER repo would be written over this repo's notes
  // without a refusal. Say so once — the run proceeds, because a loose ledger
  // (a copy, a test fixture) is a legitimate input.
  if (sourceRepoRoot === null) {
    const ns = resolveRepoNamespace({ vaultName, repoRoot });
    process.stderr.write(
      repoRootArg
        ? `WARN vault-mirror: --source ${pathForLog(source)} is neither a project ledger (.orchestrator/metrics/) nor inside a git repo, so --repo-root cannot be checked against it; writing under namespace '${ns}'\n`
        : `WARN vault-mirror: --source ${pathForLog(source)} is neither a project ledger (.orchestrator/metrics/) nor inside a git repo; the namespace '${ns}' comes from the cwd — pass --repo-root to state which repo this ledger belongs to\n`,
    );
  }

  // Fail closed when the two disagree: an explicit `--repo-root` whose identity
  // differs from the repo the ledger lives in is exactly the incident shape
  // (callers pass `--repo-root "$PWD"`, so a run from the wrong checkout lands
  // here instead of in another project's notes). NAMESPACES are compared, not
  // paths — a worktree and its main checkout are different directories that
  // share one `.vault.yaml` slug and one remote. `vaultName` is left out on
  // purpose: it overrides the FOLDER, and the question here is whether the
  // ledger belongs to the repo being mirrored. Named ceiling: two owner-leaky
  // repos without a pseudonym-map entry both resolve to `redacted-repo` and pass
  // this check — they already share that one folder (#725 D5), so the refusal
  // could not keep them apart anyway.
  if (repoRootArg && sourceRepoRoot !== null) {
    const repoNs = resolveRepoNamespace({ repoRoot });
    const sourceNs = resolveRepoNamespace({ repoRoot: sourceRepoRoot });
    if (repoNs !== sourceNs) {
      // Both values are leak-guarded namespaces — safe for logs, unlike the paths.
      process.stderr.write(
        `vault-mirror: refusing to mirror — --source ${pathForLog(source)} belongs to repo namespace '${sourceNs}', but --repo-root resolves to '${repoNs}'. Run with the repo root the ledger belongs to.\n`,
      );
      await finishRun('source-repo-mismatch');
      process.exit(2);
    }
  }

  const rl = createInterface({
    input: createReadStream(resolve(source), 'utf8'),
    crlfDelay: Infinity,
  });

  // Collect all lines first, then process sequentially to avoid mkdirSync/writeFileSync races
  const lines = [];
  for await (const line of rl) {
    lines.push(line);
  }

  let lineNum = 0;
  // The run-level denominator lives in `runState` above: `runState.total` counts
  // every NON-BLANK line the run attempted, so
  // `created + updated + skipped + failed === runState.total` for any run that
  // does not abort — and an aborted run says so with the `aborted` field rather
  // than publishing a partial count as a complete one. The breakdown is keyed by
  // the same `action` string the entry wrote to stdout, so no second vocabulary
  // is introduced.
  const ctx = {
    vaultDir,
    dryRun,
    kind,
    force,
    vaultName,
    // #1389/#1503: the repo whose identity (`.vault.yaml` slug, else git remote)
    // is the namespace — resolved ONCE above from `--repo-root` / `--source`,
    // and shared by every processor call and the auto-commit below.
    repoRoot,
    // #1503: every `source-record` key the `--kind session` source carries,
    // superseded duplicates included — filled while buffering below, read by
    // processSession's owner guard (a key from this ledger is never foreign).
    sourceRecordKeys: new Set(),
    qualityMinNarrativeChars,
    qualityMinConfidence,
  };

  /**
   * Dispatch one already-parsed entry to its processor and account for the
   * result. Extracted (#1186c) so the `--kind session` path below can call it
   * AFTER a whole-file dedup pass instead of once per raw line; every branch
   * is byte-identical to the pre-#1186c per-line loop body.
   * @param {unknown} entry — parsed JSONL value (usually an object; a bare
   *   `null`/primitive line is a real shape this must keep handling, see the
   *   #1186c session branch below for why it is never filtered out here).
   * @param {number} entryLineNum — 1-based JSONL line number, or (for the
   *   `--kind session` dedup path) the line of the record that WON the
   *   collapse. `_lineNum` is read ONLY for telemetry (process.mjs
   *   `emitEntryAction` → `line:` on the per-entry ledger event), never to
   *   derive content — process.mjs itself tolerates a non-finite value by
   *   suppressing just that one ledger record, but every call site here
   *   always supplies a real line number.
   * @returns {Promise<void>}
   */
  async function dispatchEntry(entry, entryLineNum) {
    try {
      // Both processors return the `action` string they emitted (every one of
      // their exit paths is an `emitAction` call), so the tally needs no second
      // census of the 18 call sites in process.mjs — a census that would go
      // stale the first time a branch is added.
      const action =
        kind === 'learning'
          ? await processLearning(entry, entryLineNum, ctx)
          : await processSession(entry, entryLineNum, ctx);
      tally(action);
    } catch (err) {
      // Validation errors (missing required fields) → per-entry skip, not a global failure
      if (err.message.startsWith('vault-mirror:')) {
        process.stderr.write(`${redactHomeDir(err.message)}\n`);
        const entryId = entry?.id ?? entry?.session_id ?? null;
        process.stdout.write(
          JSON.stringify({ action: 'skipped-invalid', path: null, kind, id: entryId }) + '\n',
        );
        runState.skippedInvalid++;
        tally('skipped-invalid');
        await emitMirrorEvent({
          action: 'skipped-invalid',
          kind,
          line: entryLineNum,
          recordId: entryId,
          skipClass: 'validation',
          reason: redactHomeDir(err.message),
          dryRun,
        });
        return;
      }
      // #718: discriminate genuine filesystem/system errors (which must still
      // abort the whole run — a partially-written vault is worse than a loud
      // failure) from mapper crashes on malformed producer data (a native
      // TypeError/RangeError thrown while rendering ONE record, e.g. a shape
      // the mapper didn't defensively guard). Node system errors always carry
      // a non-empty `err.code` (EACCES/ENOSPC/EROFS/ENOENT/...) and/or
      // `err.syscall` — a plain TypeError/RangeError from JS-level property
      // access has neither, so this check is a reliable discriminator even in
      // --dry-run mode (no writes happen, so a mapper crash there can only be
      // a data-shape defect, never a real FS error).
      const isSystemError =
        (typeof err.code === 'string' && err.code.length > 0) || Boolean(err.syscall);
      if (!isSystemError) {
        process.stderr.write(
          `vault-mirror: mapper crash on line ${entryLineNum} (${redactHomeDir(err.message)}) — record skipped\n`,
        );
        const entryId = entry?.id ?? entry?.session_id ?? null;
        process.stdout.write(
          JSON.stringify({
            action: 'skipped-invalid',
            path: null,
            kind,
            id: entryId,
            reason: 'mapper-crash',
          }) + '\n',
        );
        runState.skippedInvalid++;
        tally('skipped-invalid');
        await emitMirrorEvent({
          action: 'skipped-invalid',
          kind,
          line: entryLineNum,
          recordId: entryId,
          skipClass: 'mapper-crash',
          reason: redactHomeDir(err.message),
          dryRun,
        });
        return;
      }
      // Unexpected filesystem errors → fatal
      process.stderr.write(`vault-mirror: filesystem error on line ${entryLineNum}: ${redactHomeDir(err.message)}\n`);
      await finishRun('filesystem-error');
      process.exit(2);
    }
  }

  // #1186c: for `--kind session`, every parsed entry is buffered here instead
  // of dispatched inline — the dedup pass below needs the WHOLE file before it
  // can tell which of several same-`session_id` lines is the winner. `--kind
  // learning` is unaffected: it still dispatches per line, inline, immediately
  // below (a malformed line further down the file must not undo an already-
  // dispatched learning — pinned by the existing `total: 2, created: 1` abort
  // test in tests/unit/vault-mirror.test.mjs).
  const sessionEntries = [];
  const sessionLineNums = [];

  for (const line of lines) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    runState.total++;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (err) {
      process.stderr.write(`vault-mirror: malformed JSON on line ${lineNum}: ${redactHomeDir(err.message)}\n`);
      // Close the run out BEFORE exiting: `process.exit` runs no `finally`, so
      // without this the abort is the one outcome that leaves no run record —
      // exactly the shape reserved for a broken emitter.
      await finishRun('malformed-json');
      process.exit(1);
    }

    if (kind === 'session') {
      sessionEntries.push(entry);
      const recordKey = sessionSourceRecord(entry);
      if (recordKey !== null) ctx.sourceRecordKeys.add(recordKey);
      sessionLineNums.push(lineNum);
      continue;
    }

    await dispatchEntry(entry, lineNum);
  }

  if (kind === 'session') {
    // Only an OBJECT entry carrying a non-empty `session_id` is eligible for
    // the dedup collapse — the same predicate canonicalizeSessions itself uses
    // internally (sessions-canonical.mjs `isRecordObject` + `isNonEmptyString`,
    // not exported, so re-stated here rather than reached into). Everything
    // else — a bare `null`/primitive JSONL line, or a legacy record with no
    // `session_id` field — is dispatched EXACTLY as before: unaffected, in
    // original file order, through the SAME validation/mapper-crash paths
    // process.mjs already has for those shapes. Two regression-guard tests in
    // tests/unit/vault-mirror.test.mjs depend on this (a bare `null` line and a
    // legacy `session`-keyed record both still reach processSession() and its
    // existing error handling, never silently vanish into the collapse).
    const isIdentifiable = (e) =>
      e !== null &&
      typeof e === 'object' &&
      !Array.isArray(e) &&
      typeof e.session_id === 'string' &&
      e.session_id.length > 0;
    const identifiable = sessionEntries.filter(isIdentifiable);
    // canonicalizeSessions never clones — the survivors are the SAME object
    // references as in `sessionEntries`, so reference identity below is exact,
    // never a guess (scripts/lib/sessions-canonical.mjs header, "RULE ORDER").
    const survivors = new Set(canonicalizeSessions(identifiable));

    for (let i = 0; i < sessionEntries.length; i++) {
      const entry = sessionEntries[i];
      if (isIdentifiable(entry) && !survivors.has(entry)) {
        // A losing duplicate: an earlier line whose `session_id` a LATER line
        // in this same batch supersedes or overwrites (crash-recovery
        // re-append, #1068 stub/supersede pair). Never dispatched — the winning
        // occurrence (dispatched below, at its own position) produces the ONE
        // note this physical session gets. It is still ACCOUNTED for (#1291):
        // `skipped-duplicate-session` goes through the same per-entry path as
        // every other skip (stdout line + per-entry ledger record, no `path`
        // because no target file exists for it) and into the tally, so
        // `created+updated+skipped+failed === total` partitions a `--kind
        // session` run that collapsed duplicates, and the ledger names WHICH
        // lines were collapsed, not just how many notes were written.
        tally(
          await emitAction({
            action: 'skipped-duplicate-session',
            path: null,
            kind,
            id: entry.session_id,
            vaultDir: ctx.vaultDir,
            meta: { line: sessionLineNums[i] },
            line: sessionLineNums[i],
            dryRun,
          }),
        );
        continue;
      }
      await dispatchEntry(entry, sessionLineNums[i]);
    }
  }

  // ── Run close-out (#1147) ───────────────────────────────────────────────────
  //
  // The happy tail. Both roll-ups live in `finishRun` above, which every abort
  // path also calls, so "the run ended" is emitted from ONE place regardless of
  // HOW it ended. Placed BEFORE the --strict-schema abort so a failing run still
  // reports its denominator — that run is precisely the one an operator wants
  // counted.
  await finishRun();

  // --strict-schema: abort with exit 1 when any entry was skipped-invalid.
  // Useful in CI to catch producer-side schema drift early (issue #249).
  if (strictSchema && runState.skippedInvalid > 0) {
    process.stdout.write(
      JSON.stringify({ action: 'strict-schema-abort', skipped: runState.skippedInvalid, kind }) + '\n',
    );
    process.stderr.write(
      `vault-mirror: --strict-schema: ${runState.skippedInvalid} entries failed validation — exiting 1\n`,
    );
    process.exit(1);
  }

  // Auto-commit phase (issue #31): commit mirror artifacts so they don't pile up.
  // Opt-in: triggers only when --session-id is provided. Callers (session-end, evolve)
  // pass it explicitly; bare invocations stay quiet to preserve legacy behaviour.
  if (!dryRun && !noCommit && sessionIdArg) {
    autoCommitVaultMirror(
      resolve(vaultDir),
      sessionIdArg,
      resolveRepoNamespace({ vaultName, repoRoot: ctx.repoRoot }),
    );
  }
}

  main().catch(async (err) => {
    process.stderr.write(`vault-mirror: unexpected error: ${redactHomeDir(err.message)}\n`);
    // Same reason as the two in-loop aborts: an unexpected throw is a run that
    // ENDED, and the ledger has to say so. `finishRun` never throws, so this
    // cannot turn a diagnosable crash into a silent one.
    await finishRun('unexpected-error');
    process.exit(2);
  });
}
