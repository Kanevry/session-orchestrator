/**
 * designer-critique.mjs — thin adapter to the agentic-designer reviewer (#1452).
 *
 * agentic-designer owns the review contract (agentic-designer#75). Its CLI
 * `designer critique --image <png> --viewport <WxH> [--role first-view|section]
 * [--context <file>] [--value <sentence>] --out <file.json>` reads one
 * screenshot (a blind read, then a compare stage with the design context) and
 * writes a rule-derived verdict `ship | fix | rebuild | recapture` plus
 * findings and the image's SHA-256.
 * This module only finds that command, runs it on the screenshots the
 * test-runner driver captured, and maps the verdicts onto the wave flow. It
 * copies none of the contract. Where no `designer` command exists, the wave
 * step falls back to the `ux-evaluator` path and records which reviewer ran.
 */

import { spawn } from './native-command.mjs';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const CRITIQUE_VERDICTS = Object.freeze(['ship', 'fix', 'rebuild', 'recapture']);

/**
 * What the wave flow does with each verdict.
 *   ship      → nothing to do
 *   fix       → findings become tasks of the next wave
 *   rebuild   → an owner decision about the direction; never an automatic loop
 *   recapture → that viewport could not be judged: not reviewable
 */
export const VERDICT_ACTIONS = Object.freeze({
  ship: 'none',
  fix: 'next-wave-tasks',
  rebuild: 'owner-decision',
  recapture: 'not-reviewable',
});

/** Worst first. */
const SEVERITY = ['rebuild', 'recapture', 'fix', 'ship'];

export const VIEWPORT = /^\d{2,5}x\d{2,5}$/;

/** Per-image limit; both viewports run in parallel, so a surface takes at most this long. */
export const DEFAULT_CRITIQUE_TIMEOUT_MS = 240_000;

function isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the `designer` command: the configured path (`design-review.designer`;
 * `~` expands, a relative path resolves against the repo root) first, then
 * `designer` on PATH. A configured path that is not an executable falls back to
 * PATH and is named in `configured_broken`.
 *
 * @param {{ configured?: string|null, repoRoot?: string, homeDir?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ command: string|null, source: 'config'|'path'|null, configured_broken: string|null }}
 */
export function resolveDesignerCommand(opts = {}) {
  const env = opts.env ?? process.env;
  let broken = null;
  if (typeof opts.configured === 'string' && opts.configured.trim()) {
    const raw = opts.configured.trim().replace(/^~(?=\/|$)/, opts.homeDir ?? homedir());
    const p = isAbsolute(raw) ? raw : resolve(opts.repoRoot ?? process.cwd(), raw);
    if (isExecutableFile(p)) return { command: p, source: 'config', configured_broken: null };
    broken = p;
  }
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, 'designer');
    if (isExecutableFile(p)) return { command: p, source: 'path', configured_broken: broken };
  }
  return { command: null, source: null, configured_broken: broken };
}

/**
 * Pure: the verdict of a parsed `designer critique --image … --out` file, or
 * `null`. That file is agentic-designer's `ImageCritique` (`imageCritiqueSchema`
 * in its `src/shared/critique.ts`): verdict and findings sit under `answer`,
 * the image hash under `image.sha256`. Nothing else produces a critique for
 * this adapter, so no other shape is read (MR !413 review 3, H1).
 *
 * `answer.verdict` is the verdict DERIVED by agentic-designer's rule in code
 * (fix needs a high finding, a medium alone gives ship, rebuild needs a high
 * finding on a core criterion; agentic-designer !16); the model's own verdict
 * is the top-level `modelVerdict` and is deliberately not read. Counting and
 * rounds rely on the derived verdict only, so a section run without
 * value-sentence findings changes nothing here. `role` and `contextVersion`
 * are tolerated and ignored.
 *
 * @returns {{ verdict: string, findings: unknown[], image_sha256: string|null } | null}
 */
export function readCritique(output) {
  const answer = output && typeof output === 'object' ? output.answer : null;
  if (!answer || typeof answer !== 'object') return null;
  const verdict = typeof answer.verdict === 'string' ? answer.verdict.trim().toLowerCase() : '';
  if (!CRITIQUE_VERDICTS.includes(verdict)) return null;
  const sha = output.image?.sha256;
  return {
    verdict,
    findings: Array.isArray(answer.findings) ? answer.findings : [],
    image_sha256: typeof sha === 'string' ? sha : null,
  };
}

/**
 * Pure: one result per surface. A viewport whose run failed counts as
 * `recapture` (never `ship`); the worst verdict names the result; findings of
 * every viewport are kept; `actions` lists everything the wave must do, so a
 * `fix` on one viewport and a `recapture` on the other yields both.
 *
 * @param {Array<{ viewport: string, verdict?: string, findings?: unknown[], error?: string }>} critiques
 * @returns {{ verdict: string, action: string, actions: string[], findings: object[], recapture_viewports: string[] } | null}
 *   `null` when no viewport produced a verdict.
 */
export function combineCritiques(critiques) {
  const list = (critiques ?? []).map((c) => (CRITIQUE_VERDICTS.includes(c?.verdict)
    ? c
    : { ...c, verdict: 'recapture', findings: [], error: c?.error ?? 'no verdict' }));
  if (!list.some((c) => !c.error)) return null;
  const verdict = SEVERITY.find((v) => list.some((c) => c.verdict === v));
  const actions = SEVERITY.filter((v) => v !== 'ship' && list.some((c) => c.verdict === v)).map((v) => VERDICT_ACTIONS[v]);
  return {
    verdict,
    action: VERDICT_ACTIONS[verdict],
    actions: actions.length > 0 ? actions : ['none'],
    findings: list.flatMap((c) => (c.findings ?? []).map((f) => ({ viewport: c.viewport, finding: f }))),
    recapture_viewports: list.filter((c) => c.verdict === 'recapture').map((c) => c.viewport),
  };
}

/**
 * Pure: the wave's consequences of a combined critique. With `act: false`
 * (`design-review.act-on-verdicts`, default; agentic-designer#85 measured 23 of
 * 37 findings wrong) verdicts and findings are recorded and shown only: no
 * next-wave tasks, no automatic owner decision.
 *
 * @param {{ actions: string[] }} combined
 * @param {boolean} act
 * @returns {{ actions: string[], advisory_actions: string[] }}
 */
export function effectiveActions(combined, act) {
  if (act) return { actions: combined.actions, advisory_actions: [] };
  return { actions: ['record-only'], advisory_actions: combined.actions.filter((a) => a !== 'none') };
}

/** Image roles of `designer critique --image --role` (agentic-designer !16). */
export const CRITIQUE_ROLES = Object.freeze(['first-view', 'section']);

/**
 * Pure: did an older `designer` reject `--role`? Only exit 2 with the CLI's
 * error JSON on stdout, code `INVALID_ARGUMENTS`, whose message names the flag
 * ("Unbekanntes oder mehrfaches Flag: --role"). Any other failure, even one
 * that echoes `--role`, is a normal failure.
 */
export function rejectsRoleFlag(code, stdout) {
  if (code !== 2) return false;
  const text = String(stdout ?? '').trim();
  for (const candidate of [text, ...text.split('\n')]) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const error = parsed?.error;
    if (error?.code === 'INVALID_ARGUMENTS' && /Flag: --role\b/.test(String(error.message ?? ''))) return true;
  }
  return false;
}

/** Kill a designer's whole process group (POSIX), so a designer → pnpm → node chain leaves no orphans. */
function killGroup(child) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Run `designer critique` on one screenshot. Never rejects. On timeout the
 * whole process group is killed, so a `designer` → pnpm → node chain leaves no
 * orphans (POSIX).
 *
 * `role` is passed as `--role first-view|section`: a section shot is judged on
 * its own statement and craft, not against the page's value sentence (24 false
 * findings in the first production test, agentic-designer#85). A `designer`
 * that predates the flag rejects it (`rejectsRoleFlag`); the run is then
 * repeated once without it and `role_fallback` says so. Never a failed wave for
 * that reason. `timeoutMs` is one deadline per shot: the rerun gets only what
 * the rejected attempt left, and a failed rerun keeps the first error.
 *
 * @returns {Promise<{ ok: true, critique: object, role_fallback?: string } | { ok: false, error: string }>}
 */
export async function runCritique({ command, image, viewport, context = null, value = null, role = null, timeoutMs = DEFAULT_CRITIQUE_TIMEOUT_MS }) {
  if (!VIEWPORT.test(String(viewport))) return { ok: false, error: `invalid viewport "${viewport}" (want WxH)` };
  if (!existsSync(image)) return { ok: false, error: `screenshot not found: ${image}` };
  if (role !== null && !CRITIQUE_ROLES.includes(role)) return { ok: false, error: `invalid role "${role}" (want ${CRITIQUE_ROLES.join('|')})` };
  const deadline = Date.now() + timeoutMs;
  const plain = ({ roleRejected: _, ...rest }) => rest;
  const first = await critiqueOnce({ command, image, viewport, context, value, role, timeoutMs });
  if (role === null || first.ok || !first.roleRejected) return plain(first);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, error: `${first.error}; no time left to rerun without --role` };
  const retry = plain(await critiqueOnce({ command, image, viewport, context, value, role: null, timeoutMs: remaining }));
  return retry.ok
    ? { ...retry, role_fallback: `designer does not know --role; ${role} shot judged without it` }
    : { ok: false, error: `${retry.error} (rerun without --role, after: ${first.error})` };
}

async function critiqueOnce({ command, image, viewport, context, value, role, timeoutMs }) {
  const dir = mkdtempSync(join(tmpdir(), 'so-critique-'));
  const out = join(dir, 'critique.json');
  const args = ['critique', '--image', image, '--viewport', viewport, '--out', out];
  if (role) args.push('--role', role);
  if (context) args.push('--context', context);
  if (value) args.push('--value', value);
  try {
    const exit = await new Promise((done) => {
      let stderr = '';
      let stdout = '';
      let child;
      try {
        child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      } catch (err) {
        done({ error: `designer did not run: ${err.message}` });
        return;
      }
      // designer prints its error JSON on stdout; keep only the head of it
      child.stdout.on('data', (d) => { if (stdout.length < 4096) stdout += d; });
      const timer = setTimeout(() => {
        killGroup(child);
        done({ error: `designer timed out after ${timeoutMs} ms` });
      }, timeoutMs);
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => { clearTimeout(timer); done({ error: `designer did not run: ${err.message}` }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        // a failed designer may leave children behind; clean up like the timeout path
        if (code !== 0) killGroup(child);
        done({ code, stderr, stdout });
      });
    });
    if (exit.error) return { ok: false, error: exit.error };
    if (exit.code !== 0) {
      return { ok: false, error: `designer exited ${exit.code}: ${String(exit.stderr || exit.stdout).trim().slice(0, 200)}`, roleRejected: role !== null && rejectsRoleFlag(exit.code, exit.stdout) };
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      return { ok: false, error: 'designer wrote no readable JSON to --out' };
    }
    const critique = readCritique(parsed);
    return critique ? { ok: true, critique } : { ok: false, error: 'designer output has no ship|fix|rebuild|recapture verdict' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
