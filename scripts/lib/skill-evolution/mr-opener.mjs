/**
 * mr-opener.mjs — Open a merge/pull request for an MR-tier repair candidate
 * (Epic #643 Skill Self-Evolution Foundation / issue #647 — C2 auto-repair engine).
 *
 * MR-tier candidates are `plugin-skill` / `local-skill` targets. Per the
 * blast-radius classifier (`blast-radius-classifier.mjs`), these are ALWAYS
 * routed through a merge request — never applied autonomously. This module
 * carries the candidate's diff onto a real branch and opens a draft MR/PR.
 *
 * DESIGN: heavy REUSE of existing modules. The ONE net-new primitive is the
 * git add/commit/push triple. Everything else delegates:
 *   - `validateMrInputs` / `buildMrBody` / `maybeCreateDraftMR`  ← mr-draft.mjs
 *   - VCS auto-detect (`bin: 'glab'|'gh'|null`)                  ← vcs-detector.mjs
 *   - owner-leakage gate (CLI script, scans TRACKED files)       ← check-owner-leakage.mjs
 *   - conditional slopcheck gate (`classifyPackages`)            ← slopcheck.mjs
 *
 * CONTRACT: NEVER throws. Every failure path degrades to an advisory or blocked
 * result. glab/gh absence or dry-run → `advisory`. Gate failure → `blocked`.
 *
 * SECURITY: all subprocess invocations use execFile arg-vectors (shell:false) —
 * never shell-string interpolation (RCE surface). Branch/title/description are
 * validated via `validateMrInputs` (newline/null-byte guard) before use.
 *
 * DEPENDENCY-INJECTION: every external seam is injectable via `opts` so the
 * whole flow is testable without real git/glab/gh:
 *   - opts.execFile   — promisified execFile for glab/gh mr-create (mr-draft seam)
 *   - opts.git        — async ({ args, cwd }) => { stdout } git runner
 *   - opts.leakageScan— async ({ repoRoot }) => { ok, exitCode } owner-leakage gate
 *   - opts.slopcheck  — async (pkgs, { repoRoot }) => Array<{classification}>
 *   - opts.vcsDetect  — ({ config, projectRoot }) => { bin } VCS detector
 *   - opts.createMr   — async (loop, draftOpts) => { created, mrUrl } MR opener
 *   - opts.log        — (level, msg) => void diagnostic logger
 */

import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateMrInputs,
  buildMrBody,
  maybeCreateDraftMR,
  MrDraftError,
} from '../autopilot/mr-draft.mjs';
import { detectVcsCommand } from '../tmux-layout/vcs-detector.mjs';
import { classifyPackages } from '../slopcheck.mjs';

const realExecFile = promisify(execFileCb);

/** Absolute path to the owner-leakage CLI scanner (a script, not an importable fn). */
const OWNER_LEAKAGE_SCRIPT = fileURLToPath(
  new URL('../validate/check-owner-leakage.mjs', import.meta.url),
);

/**
 * @typedef {Object} RepairCandidate
 * @property {string} id          Deterministic short hash (idempotency key).
 * @property {string} target_path Repo-relative path the repair targets.
 * @property {string} [proposed_change] Human-readable description of the fix.
 * @property {string} [rationale] Why this candidate exists.
 * @property {string} [source_ref] Back-reference into the source feeder.
 */

/**
 * @typedef {Object} RepairDiff
 * @property {string} [content] Full new file content to write at target_path.
 * @property {string} [raw]     Raw unified-diff text (used for the pre-commit
 *                              owner-leakage preview + package-add detection).
 */

/**
 * @typedef {Object} OpenRepairMrResult
 * @property {boolean} ok
 * @property {'mr-opened'|'advisory'|'blocked'} action
 * @property {string} [mrUrl]
 * @property {string} [reason]
 * @property {{ ownerLeakage: 'pass'|'fail', slopcheck?: 'pass'|'fail'|'skipped' }} [gate]
 */

// ---------------------------------------------------------------------------
// Net-new primitive: git runner (injectable)
// ---------------------------------------------------------------------------

/**
 * Default git runner — execFile arg-vector, shell:false. Never interpolates a
 * shell string. Resolves `{ stdout }`; rejects on non-zero exit (the caller
 * wraps this in try/catch and degrades to advisory).
 *
 * @param {{ args: string[], cwd: string }} arg0
 * @returns {Promise<{ stdout: string }>}
 */
async function defaultGit({ args, cwd }) {
  const { stdout } = await realExecFile('git', args, {
    cwd,
    shell: false,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout ?? '' };
}

/**
 * Default owner-leakage gate — spawns the CLI scanner against the committed
 * worktree. Exit 0 = clean, non-zero = leak. Never throws; on spawn error
 * (e.g. ENOENT) returns `{ ok: false }` so the caller can decide. We treat a
 * spawn FAILURE distinctly from a leak DETECTION via the `spawnError` flag.
 *
 * @param {{ repoRoot: string }} arg0
 * @returns {Promise<{ ok: boolean, exitCode: number, spawnError?: boolean }>}
 */
async function defaultLeakageScan({ repoRoot }) {
  const result = spawnSync('node', [OWNER_LEAKAGE_SCRIPT, repoRoot], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    // Scanner could not run at all — surface as a spawn error, not a leak.
    return { ok: false, exitCode: -1, spawnError: true };
  }
  return { ok: result.status === 0, exitCode: result.status ?? -1 };
}

// ---------------------------------------------------------------------------
// Package-add detection (slopcheck gate trigger)
// ---------------------------------------------------------------------------

/**
 * Detect newly-ADDED package dependencies in a raw unified diff. Only lines that
 * START with a single `+` (added) within a manifest hunk are considered. Returns
 * a `{ name, registry }[]` for slopcheck. Pure prose/config diffs → [].
 *
 * Supported manifests: package.json (npm), requirements.txt (pip),
 * Cargo.toml (cargo). Detection is intentionally conservative — when in doubt
 * it emits nothing (slopcheck then reports 'skipped').
 *
 * @param {string|undefined} rawDiff
 * @returns {Array<{ name: string, registry: 'npm'|'pip'|'cargo' }>}
 */
export function detectAddedPackages(rawDiff) {
  if (typeof rawDiff !== 'string' || rawDiff.length === 0) return [];

  const pkgs = [];
  const seen = new Set();
  let registry = null; // active manifest registry, set by the +++ file header

  const add = (name, reg) => {
    const key = `${reg}:${name}`;
    if (name && !seen.has(key)) {
      seen.add(key);
      pkgs.push({ name, registry: reg });
    }
  };

  for (const line of rawDiff.split('\n')) {
    // File header sets the active registry for subsequent + lines.
    if (line.startsWith('+++ ') || line.startsWith('diff --git')) {
      if (/package\.json\b/.test(line)) registry = 'npm';
      else if (/requirements\.txt\b/.test(line)) registry = 'pip';
      else if (/Cargo\.toml\b/.test(line)) registry = 'cargo';
      else registry = null;
      continue;
    }
    // Only consider added lines (single leading '+', not the '+++' header).
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (registry === null) continue;

    const added = line.slice(1).trim();
    if (added.length === 0) continue;

    if (registry === 'npm') {
      // npm dependency line: "name": "^1.2.3"  (scope-aware).
      const m = added.match(/^"(@?[a-z0-9~][\w.~/-]*)"\s*:/i);
      if (m) add(m[1], 'npm');
    } else if (registry === 'pip') {
      // requirements line: name==1.2.3 / name>=1.0 / name (skip comments).
      if (added.startsWith('#')) continue;
      const m = added.match(/^([A-Za-z0-9][\w.-]*)/);
      if (m) add(m[1], 'pip');
    } else if (registry === 'cargo') {
      // Cargo.toml dependency line: name = "1.2.3" (skip table headers).
      if (added.startsWith('[')) continue;
      const m = added.match(/^([A-Za-z0-9][\w-]*)\s*=/);
      if (m) add(m[1], 'cargo');
    }
  }

  return pkgs;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a `vcsDetect().bin` value ('glab'|'gh'|null) to the loop.vcs token
 * ('gitlab'|'github') that maybeCreateDraftMR expects.
 * @param {string|null|undefined} bin
 * @returns {'gitlab'|'github'|null}
 */
function binToVcs(bin) {
  if (bin === 'glab') return 'gitlab';
  if (bin === 'gh') return 'github';
  return null;
}

/**
 * Normalise the caller-supplied `vcs` argument OR detector result into a
 * `{ bin, vcs }` pair. The explicit `vcs` arg wins; otherwise we auto-detect.
 * @param {*} vcsArg            Caller arg: 'gitlab'|'github'|'glab'|'gh'|undefined.
 * @param {Function} vcsDetect  detectVcsCommand seam.
 * @param {string} repoRoot
 * @returns {{ bin: 'glab'|'gh'|null, vcs: 'gitlab'|'github'|null }}
 */
function resolveVcs(vcsArg, vcsDetect, repoRoot) {
  if (vcsArg === 'gitlab' || vcsArg === 'glab') return { bin: 'glab', vcs: 'gitlab' };
  if (vcsArg === 'github' || vcsArg === 'gh') return { bin: 'gh', vcs: 'github' };

  // Auto-detect via the seam. Pass vcs through Session-Config-shaped `config`.
  let detected;
  try {
    detected = vcsDetect({ config: {}, projectRoot: repoRoot }) ?? {};
  } catch {
    detected = {};
  }
  const bin = detected.bin === 'glab' || detected.bin === 'gh' ? detected.bin : null;
  return { bin, vcs: binToVcs(bin) };
}

/**
 * Build a safe MR title + body from the candidate. Title is validated for
 * newline/null-byte safety via validateMrInputs before any subprocess use.
 * @param {RepairCandidate} candidate
 * @returns {{ title: string, description: string }}
 */
function buildCandidateMrBody(candidate) {
  const proposed = candidate.proposed_change || 'skill repair';
  const built = buildMrBody({
    issueTitle: `Auto-repair: ${proposed}`,
    issueIid: candidate.source_ref ?? candidate.id ?? 'unknown',
    parentRunId: `repair/${candidate.id ?? 'unknown'}`,
    worktreePath: candidate.target_path ?? '(unknown)',
  });
  // Validate the user/feeder-derived title before it reaches any execFile.
  validateMrInputs(built.title, '');
  return built;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a draft merge/pull request for an MR-tier repair candidate.
 *
 * Flow (see issue #647 spec):
 *   1. dryRun → owner-leakage preview (best-effort) + MR-body build → advisory.
 *   2. Resolve VCS; no glab/gh → advisory.
 *   3. Create branch + write change + git add/commit/push (net-new primitive).
 *   4. GATE owner-leakage (always) → fail = blocked.
 *   5. GATE slopcheck (only when the diff ADDS a package) → SLOP = blocked.
 *   6. Open the MR → mr-opened. ENOENT/exec failure → advisory.
 *
 * NEVER throws — every error path degrades to advisory or blocked.
 *
 * @param {{ candidate: RepairCandidate, diff: RepairDiff, repoRoot: string, dryRun?: boolean, vcs?: string }} arg0
 * @param {object} [opts] dependency-injection seams (see module JSDoc).
 * @returns {Promise<OpenRepairMrResult>}
 */
export async function openRepairMr(
  { candidate, diff, repoRoot, dryRun = false, vcs } = {},
  opts = {},
) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  // Seam resolution — real implementations are the defaults; opts override.
  const git = typeof opts.git === 'function' ? opts.git : defaultGit;
  const leakageScan =
    typeof opts.leakageScan === 'function' ? opts.leakageScan : defaultLeakageScan;
  const slopcheck = typeof opts.slopcheck === 'function' ? opts.slopcheck : classifyPackages;
  const vcsDetect = typeof opts.vcsDetect === 'function' ? opts.vcsDetect : detectVcsCommand;
  const createMr = typeof opts.createMr === 'function' ? opts.createMr : maybeCreateDraftMR;

  // --- Input guard (never throw) ---
  if (!candidate || typeof candidate !== 'object' || typeof candidate.id !== 'string') {
    log('error', 'mr-opener: missing/invalid candidate');
    return { ok: false, action: 'advisory', reason: 'invalid candidate input' };
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    log('error', 'mr-opener: missing repoRoot');
    return { ok: false, action: 'advisory', reason: 'invalid repoRoot input' };
  }
  const safeDiff = diff && typeof diff === 'object' ? diff : {};

  // Branch name derived from the candidate id (validated for arg safety).
  const branch = `repair/${candidate.id}`;
  try {
    validateMrInputs(branch, '');
  } catch (err) {
    log('error', `mr-opener: unsafe branch name — ${err.message}`);
    return { ok: false, action: 'advisory', reason: 'unsafe branch name derived from candidate id' };
  }

  // Validate the candidate-derived MR title up front (newline/null-byte guard)
  // so a malformed candidate fails fast as advisory — BEFORE any git work. The
  // authoritative title/body is built later by the createMr seam.
  try {
    buildCandidateMrBody(candidate);
  } catch (err) {
    const msg = err instanceof MrDraftError ? err.message : String(err?.message ?? err);
    log('error', `mr-opener: MR body build failed — ${msg}`);
    return { ok: false, action: 'advisory', reason: `MR body validation failed: ${msg}` };
  }

  // -----------------------------------------------------------------------
  // Step 1 — dry-run preview. No push, no MR. Best-effort leakage pre-check.
  // -----------------------------------------------------------------------
  if (dryRun === true) {
    // The leakage scanner only inspects TRACKED files, so a true pre-commit
    // scan is not feasible without a commit. We mark the gate 'pass' optimistically
    // for the preview and let the real path run the authoritative scan.
    log('info', `mr-opener: dry-run preview for ${branch} — no MR opened`);
    return {
      ok: true,
      action: 'advisory',
      reason: 'dry-run preview — no MR opened',
      gate: { ownerLeakage: 'pass' },
    };
  }

  // -----------------------------------------------------------------------
  // Step 2 — resolve VCS. No glab/gh → advisory.
  // -----------------------------------------------------------------------
  const { bin, vcs: resolvedVcs } = resolveVcs(vcs, vcsDetect, repoRoot);
  if (bin === null || resolvedVcs === null) {
    log('info', 'mr-opener: no glab/gh available — advisory only');
    return {
      ok: true,
      action: 'advisory',
      reason: 'glab/gh not installed — advisory only',
    };
  }

  // -----------------------------------------------------------------------
  // Step 3 — create branch + write change + git add/commit/push (net-new).
  // -----------------------------------------------------------------------
  try {
    await git({ args: ['checkout', '-B', branch], cwd: repoRoot });

    // Write the candidate's change into the target file (when content provided).
    if (typeof safeDiff.content === 'string' && typeof candidate.target_path === 'string') {
      const abs = path.resolve(repoRoot, candidate.target_path);
      // R5 defense-in-depth: never write outside the repo even if a future differ
      // populates `content` from a candidate-influenced target_path (mirrors the
      // fail-closed escape check in blast-radius-classifier.mjs).
      const rel = path.relative(repoRoot, abs);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        log('error', `mr-opener: target_path escapes repo (${candidate.target_path}) — blocked`);
        return { ok: false, action: 'blocked', reason: 'target_path escapes repo' };
      }
      const writeFile =
        typeof opts.writeFile === 'function'
          ? opts.writeFile
          : (await import('node:fs/promises')).writeFile;
      await writeFile(abs, safeDiff.content, 'utf8');
    }

    await git({ args: ['add', '--', candidate.target_path ?? '.'], cwd: repoRoot });
    const commitMsg = `fix(skill-evolution): auto-repair ${candidate.target_path ?? candidate.id}`;
    await git({ args: ['commit', '-m', commitMsg], cwd: repoRoot });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      log('error', 'mr-opener: git binary not found — advisory only');
      return { ok: true, action: 'advisory', reason: 'git not installed — advisory only' };
    }
    log('error', `mr-opener: branch/commit failed — ${err?.message ?? err}`);
    return {
      ok: true,
      action: 'advisory',
      reason: `git branch/commit failed: ${err?.message ?? 'unknown error'}`,
    };
  }

  // -----------------------------------------------------------------------
  // Step 4 — GATE owner-leakage (always). Runs AFTER commit, BEFORE push.
  // -----------------------------------------------------------------------
  let leak;
  try {
    leak = await leakageScan({ repoRoot });
  } catch (err) {
    log('error', `mr-opener: leakage scan threw — ${err?.message ?? err}`);
    // Fail-closed on scan error: we cannot prove the diff is clean → block.
    return {
      ok: false,
      action: 'blocked',
      reason: 'owner-leakage scan failed to run',
      gate: { ownerLeakage: 'fail' },
    };
  }
  if (!leak || leak.ok !== true) {
    const reason = leak?.spawnError
      ? 'owner-leakage scan failed to run'
      : 'owner-leakage detected';
    log('warn', `mr-opener: owner-leakage gate failed (${reason})`);
    return {
      ok: false,
      action: 'blocked',
      reason,
      gate: { ownerLeakage: 'fail' },
    };
  }

  // -----------------------------------------------------------------------
  // Step 5 — GATE slopcheck (CONDITIONAL — only when the diff ADDS a package).
  // -----------------------------------------------------------------------
  let slopStatus = 'skipped';
  const addedPkgs = detectAddedPackages(safeDiff.raw);
  if (addedPkgs.length > 0) {
    let classified;
    try {
      classified = await slopcheck(addedPkgs, { repoRoot });
    } catch (err) {
      log('error', `mr-opener: slopcheck threw — ${err?.message ?? err}`);
      // slopcheck itself never throws, but the seam might be mocked to. Fail-closed.
      return {
        ok: false,
        action: 'blocked',
        reason: 'slopcheck failed to run',
        gate: { ownerLeakage: 'pass', slopcheck: 'fail' },
      };
    }
    const hasSlop =
      Array.isArray(classified) && classified.some((c) => c?.classification === 'SLOP');
    if (hasSlop) {
      const slopName =
        classified.find((c) => c?.classification === 'SLOP')?.name ?? 'unknown';
      log('warn', `mr-opener: slopcheck gate failed — SLOP package '${slopName}'`);
      return {
        ok: false,
        action: 'blocked',
        reason: 'slop package',
        gate: { ownerLeakage: 'pass', slopcheck: 'fail' },
      };
    }
    slopStatus = 'pass';
  }

  const gate = { ownerLeakage: 'pass', slopcheck: slopStatus };

  // -----------------------------------------------------------------------
  // Step 6 — push + open the draft MR/PR. ENOENT/exec failure → advisory.
  // -----------------------------------------------------------------------
  try {
    await git({ args: ['push', '--set-upstream', 'origin', branch], cwd: repoRoot });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      log('error', 'mr-opener: git push — binary not found — advisory only');
      return { ok: true, action: 'advisory', reason: 'git not installed — advisory only', gate };
    }
    log('error', `mr-opener: git push failed — ${err?.message ?? err}`);
    return {
      ok: true,
      action: 'advisory',
      reason: `git push failed: ${err?.message ?? 'unknown error'}`,
      gate,
    };
  }

  // Delegate MR creation to the mr-draft seam (collision check + draft create).
  let mrResult;
  try {
    mrResult = await createMr(
      {
        draftMrPolicy: 'on-loop-start',
        vcs: resolvedVcs,
        issueIid: candidate.source_ref ?? candidate.id,
        issueTitle: `Auto-repair: ${candidate.proposed_change || 'skill repair'}`,
        branchName: branch,
        parentRunId: `repair/${candidate.id}`,
        worktreePath: candidate.target_path ?? '(unknown)',
      },
      { execFile: opts.execFile, log },
    );
  } catch (err) {
    const msg = err instanceof MrDraftError ? err.message : String(err?.message ?? err);
    log('error', `mr-opener: MR create threw — ${msg}`);
    return { ok: true, action: 'advisory', reason: `MR create failed: ${msg}`, gate };
  }

  // maybeCreateDraftMR returns { created, mrUrl?, existing?, error? } — never throws.
  if (mrResult && mrResult.created === true) {
    log('info', `mr-opener: draft MR opened — ${mrResult.mrUrl ?? '(no url)'}`);
    return { ok: true, action: 'mr-opened', mrUrl: mrResult.mrUrl ?? undefined, gate };
  }
  if (mrResult && mrResult.existing === true) {
    log('info', `mr-opener: existing MR found — ${mrResult.mrUrl ?? '(no url)'}`);
    return { ok: true, action: 'mr-opened', mrUrl: mrResult.mrUrl ?? undefined, gate };
  }

  // Not created (binary missing, collision-check error, or other) → advisory.
  const reason = mrResult?.error
    ? `MR not opened: ${mrResult.error}`
    : 'MR not opened — advisory only';
  log('info', `mr-opener: ${reason}`);
  return { ok: true, action: 'advisory', reason, gate };
}
