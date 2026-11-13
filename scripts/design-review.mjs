#!/usr/bin/env node
/**
 * design-review.mjs — trigger and close gate of the default-on design review
 * (#1452). Logic: `scripts/lib/design-review.mjs`, `scripts/lib/ui-touch.mjs`,
 * `scripts/lib/designer-critique.mjs`, `scripts/lib/design-review-host.mjs`.
 *
 * Subcommands (all take --repo-root <dir>; default: git toplevel of the cwd):
 *   detect      UI touched? Renderable? Inputs, reviewer, rounds per surface.
 *   record      One record covering the session's current UI files.
 *   check       Close gate (session-end Phase 2.7). `close-gate: warn` (default
 *               no automatic switch, #1452) prints "would refuse" and exits 0.
 *   critique    agentic-designer's `designer critique` on the screenshots.
 *   would-refuse  Lists recorded would-refuse closes for the lead's classification.
 *
 * Exit codes: 0 ok (check: pass, skip, warn-only "would refuse", not reviewable
 * or unmeasured — the last three print a WARNING and write a record), 1 bad
 * arguments or a refused record, 2 a record could not be written or read back,
 * 3 check refused the close (only with close-gate: refuse).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { emitEvent, sessionAttribution } from './lib/events.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { spawnSync } from './lib/native-command.mjs';
import { readConfigFile } from './lib/config/io.mjs';
import { readLock } from './lib/session-lock.mjs';
import { _parseDesignReview, resolveDesignReviewSettings } from './lib/config/design-review.mjs';
import { DECISION_ID, readOwnerDesignReviewBlock, sessionKind } from './lib/design-review-host.mjs';
import { SAFE_REF, classifyUiPaths, resolveSessionChangeSet } from './lib/ui-touch.mjs';
import { VIEWPORT, combineCritiques, effectiveActions, resolveDesignerCommand, runCritique } from './lib/designer-critique.mjs';
import {
  MAX_REVIEW_ROUNDS,
  NOT_JUDGED_VERDICTS,
  REVIEW_EVENT,
  REVIEW_STATUSES,
  REVIEWER_VERDICTS,
  appendRecord,
  checkEvidence,
  countRounds,
  coverKeys,
  evaluateCloseGate,
  findDesignInputs,
  normalizeSurface,
  probeRenderedTarget,
  readOwnIds,
  readRecords,
  readWorkTreeKey,
  recordsFilePath,
  recordsWritable,
  resolveSinceTime,
  selectOwnReviews,
} from './lib/design-review.mjs';

const HELP = `Usage: design-review.mjs <detect|record|check|critique|would-refuse> [options]

  detect   [--files <a,b> | --files-from <file>] [--since <ref>] [--since-time <iso>] [--json]
  record   --status <reviewed|not-reviewable|owner-override> [--surface <route>]
           reviewed:       --reviewer <designer|ux-evaluator> --verdict <v> --run-dir <dir with this session's PNGs> [--findings <n>]
           not-reviewable: --reason <text>
           owner-override: --reason "<owner's words>" [--decision <owner-queue id>] [--lead-guided]
           [--wave <n>] [--since <ref>] [--since-time <iso>] [--json]
  check    [--since <ref>] [--since-time <iso>] [--json]
  critique --image <page-top png> --viewport <WxH> [--image … --viewport …]
           [--section-image <png> --section-viewport <WxH> …] [--context <file>] [--value <s>] [--json]
           --value reaches only --image (the first viewport-height shot of a page), never a section
  would-refuse [--repos <dir,dir>] [--json]   recorded would-refuse closes, for classification
  --repo-root <dir>  repo to read (default: git toplevel of the cwd)

Settings (env > owner.yaml design-review.* > committed design-review: block > default):
  SO_DESIGN_REVIEW=on|off                    enabled (default on)
  SO_DESIGN_REVIEW_CLOSE_GATE=warn|refuse    close gate (default warn: "would refuse", exit 0)
  SO_DESIGN_REVIEW_ACT_ON_VERDICTS=on|off    review findings create work (default off)
Exit codes: 0 ok, 1 bad arguments or refused record, 2 system error, 3 check refused the close.
`;

const MAX_REASON = 300;
const CRITIQUE_CONCURRENCY = 2;
const OLDEST_SINCE = Date.parse('2020-01-01T00:00:00Z');
const FUTURE_SLACK_MS = 5 * 60_000;
const STALE_SLACK_MS = 5 * 60_000;
const ESCAPE = 'Switch off without a commit: SO_DESIGN_REVIEW=off, or design-review.enabled: false in owner.yaml.';

class InputError extends Error {}

function repoToplevel() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

/** Committed block (shared reader: SO_PLATFORM, AGENTS.md), then env > owner.yaml > committed. */
export async function readDesignReviewConfig(repoRoot, env = process.env) {
  let committed;
  try {
    committed = _parseDesignReview(await readConfigFile(repoRoot));
  } catch {
    committed = _parseDesignReview('');
  }
  const owner = readOwnerDesignReviewBlock(env);
  const settings = resolveDesignReviewSettings({ committed, env, ownerBlock: owner.block });
  const notes = [...settings.warnings, ...(owner.note ? [owner.note] : [])];
  return { ...committed, ...settings, notes };
}

function readFileList(values) {
  if (typeof values.files === 'string') return values.files.split(',').map((s) => s.trim()).filter(Boolean);
  if (typeof values['files-from'] === 'string') {
    const text = readFileSync(values['files-from'], 'utf8').trim();
    if (text.startsWith('[')) return JSON.parse(text).filter((s) => typeof s === 'string');
    return text.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function out(values, data, human) {
  process.stdout.write(values.json ? `${JSON.stringify(data)}\n` : `${human}\n`);
}

function validateSinceTime(raw) {
  if (raw === undefined) return;
  const text = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new InputError(`--since-time "${raw}" is not a full ISO timestamp (YYYY-MM-DDTHH:MM…); omit the flag when STATE.md has no started_at`);
  }
  const ms = Date.parse(text);
  if (ms > Date.now() + FUTURE_SLACK_MS) throw new InputError(`--since-time "${raw}" lies in the future`);
  if (ms < OLDEST_SINCE) throw new InputError(`--since-time "${raw}" is before 2020`);
}

/** The confirmed own lock's start, or null (a peer's or missing lock proves nothing). */
function ownLockStart(repoRoot) {
  if (!sessionAttribution(repoRoot).session_id) return null;
  try {
    const ms = Date.parse(readLock({ repoRoot })?.started_at);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/** Validated window and change set shared by every subcommand. */
function sessionContext(repoRoot, values, config) {
  if (values.since !== undefined && !SAFE_REF.test(values.since)) {
    throw new InputError(`--since "${values.since}" is not a git revision`);
  }
  validateSinceTime(values['since-time']);
  const notes = [];
  let sinceRef = values.since ?? null;
  let sinceTimeArg = values['since-time'];
  const lockStart = ownLockStart(repoRoot);
  if (lockStart !== null && sinceTimeArg !== undefined && Date.parse(sinceTimeArg) < lockStart - STALE_SLACK_MS) {
    notes.push(`STATE.md values predate this session's lock (${new Date(lockStart).toISOString()}): a previous session's STATE.md, ignored; using the lock window`);
    sinceRef = null;
    sinceTimeArg = undefined;
  }
  const window = resolveSinceTime(repoRoot, sinceTimeArg);
  const changeSet = resolveSessionChangeSet({ repoRoot, sinceRef, sinceTime: window.sinceTime });
  const ui = changeSet.ok ? classifyUiPaths(changeSet.files, config) : { touched: false, paths: [] };
  if (changeSet.ok) notes.push(...(changeSet.notes ?? []));
  const key = readWorkTreeKey(repoRoot);
  const ledger = readRecords(repoRoot);
  if (ledger.torn > 0) notes.push(`${ledger.torn} unreadable line(s) in ${recordsFilePath(repoRoot)} skipped`);
  const reviews = selectOwnReviews(ledger.records, { ownIds: readOwnIds(repoRoot), sinceTime: window.sinceTime, tree: key.tree });
  return { window, changeSet, ui, key, ledger, reviews, notes, inRepo: changeSet.ok || !['not-a-git-repo', 'git-unavailable'].includes(changeSet.reason) };
}

async function writeRecord(repoRoot, ctx, fields) {
  if (!ctx.inRepo) return { ok: false, error: 'not a git repository: nothing recorded', record: null };
  const keys = ctx.ui.paths.length > 0 ? coverKeys(repoRoot, ctx.ui.paths) : [];
  const res = appendRecord(repoRoot, {
    ...fields,
    tree: ctx.key.tree,
    branch: ctx.key.branch,
    head: ctx.key.head,
    window_since: ctx.window.sinceTime,
    covers: fields.status === 'unmeasured' || fields.status === 'would-refuse' ? [] : (keys ?? []),
    ui_files: ctx.ui.paths.length,
    ...sessionAttribution(repoRoot),
  });
  if (res.ok) {
    // Slim event: no free text, no paths — the optional webhook forwards payloads verbatim.
    const slim = { status: fields.status, surface: fields.surface ?? null, auto: fields.auto === true, ui_files: ctx.ui.paths.length };
    for (const k of ['reviewer', 'verdict', 'judged', 'round', 'findings', 'wave_number', 'session_kind', 'override_like', 'uncovered_count']) {
      if (fields[k] !== undefined) slim[k] = fields[k];
    }
    try {
      await emitEvent(REVIEW_EVENT, slim, { repoRoot });
    } catch {
      /* the record is the source of truth; the event is telemetry */
    }
  }
  return { ...res, unhashed: keys === null };
}

function describeChangeSet(ctx) {
  const cs = ctx.changeSet;
  if (!cs.ok) return `unmeasured (${cs.reason})`;
  return `${cs.source}${cs.base ? ` from ${cs.base.slice(0, 12)}` : ''}${cs.minus ? ` minus ${cs.minus}` : ''}`;
}

function runDetect(repoRoot, values, config) {
  const wave = readFileList(values);
  const ctx = sessionContext(repoRoot, values, config);
  const ui = wave ? classifyUiPaths(wave, config) : ctx.ui;
  const target = probeRenderedTarget(repoRoot, ui.paths);
  const inputs = findDesignInputs(repoRoot);
  const designer = resolveDesignerCommand({ configured: config.designer, repoRoot });
  const data = {
    enabled: config.enabled,
    enabled_source: config.enabled_source,
    touched: config.enabled && ui.touched,
    paths: ui.paths,
    change_set: wave ? 'files' : describeChangeSet(ctx),
    reviewable: target.renderable.length > 0,
    renderable: target.renderable,
    reviewable_reason: target.renderable.length > 0 ? target.reason : notRenderableReason(target),
    design_context: inputs.design_context,
    review_contract: inputs.review_contract,
    designer: designer.command ? { command: designer.command, source: designer.source } : null,
    designer_configured_broken: designer.configured_broken,
    act_on_verdicts: config.act_on_verdicts,
    rounds: countRounds(ctx.reviews, { windowKnown: ctx.window.sinceTime !== null }),
    max_rounds: MAX_REVIEW_ROUNDS,
    window_source: ctx.window.source,
    notes: [...config.notes, ...ctx.notes],
  };
  const human = !config.enabled
    ? `design-review: off (${config.enabled_source})`
    : !wave && !ctx.changeSet.ok
      ? `design-review: WARNING change set unmeasured (${ctx.changeSet.reason})`
      : !ui.touched
        ? 'design-review: no UI files touched'
        : [
          `design-review: ${ui.paths.length} UI file(s) touched: ${ui.paths.join(', ')}`,
          data.reviewable ? `rendered result: ${target.reason}` : `not reviewable: ${data.reviewable_reason}`,
          `reviewer: ${designer.command ? `designer (${designer.command})` : 'ux-evaluator'}; findings ${config.act_on_verdicts ? 'create work' : 'are recorded and shown only (act-on-verdicts off)'}`,
          `rounds so far: ${data.rounds === null ? 'unknown (session window unknown)' : JSON.stringify(data.rounds)} (max ${MAX_REVIEW_ROUNDS} per surface)`,
          ...data.notes.map((n) => `note: ${n}`),
        ].join('\n');
  out(values, data, human);
  return 0;
}

function notRenderableReason(target) {
  return target.configs.length > 0
    ? `no playwright.config covers these paths (configs: ${target.configs.join(', ')})`
    : target.reason;
}

function intFlag(values, flag) {
  if (values[flag] === undefined) return undefined;
  const n = Number(values[flag]);
  if (!Number.isInteger(n) || n < 0) throw new InputError(`--${flag} must be a non-negative integer`);
  return n;
}

async function runRecord(repoRoot, values, config) {
  const status = values.status;
  if (!REVIEW_STATUSES.includes(status)) throw new InputError(`--status must be one of ${REVIEW_STATUSES.join(', ')}`);
  const reason = typeof values.reason === 'string' ? values.reason.trim().slice(0, MAX_REASON) : '';
  if (status !== 'reviewed' && !reason) throw new InputError(`--status ${status} needs --reason`);
  const ctx = sessionContext(repoRoot, values, config);
  if (!recordsWritable(repoRoot)) {
    process.stderr.write(`design-review: ${recordsFilePath(repoRoot)} is not writable. ${ESCAPE}\n`);
    return 2;
  }
  const surface = normalizeSurface(values.surface);
  const fields = { status, surface };
  if (reason) fields.reason = reason;
  const findings = intFlag(values, 'findings');
  const wave = intFlag(values, 'wave');
  if (findings !== undefined) fields.findings = findings;
  if (wave !== undefined) fields.wave_number = wave;

  if (status === 'reviewed') {
    const reviewer = values.reviewer;
    if (!Object.hasOwn(REVIEWER_VERDICTS, reviewer ?? '')) throw new InputError('reviewed needs --reviewer designer|ux-evaluator');
    if (!REVIEWER_VERDICTS[reviewer].includes(values.verdict)) {
      throw new InputError(`reviewed by ${reviewer} needs --verdict ${REVIEWER_VERDICTS[reviewer].join('|')}`);
    }
    if (typeof values['run-dir'] !== 'string') throw new InputError('reviewed needs --run-dir <dir> holding this session\'s screenshots');
    const runDir = resolve(repoRoot, values['run-dir']);
    const evidence = checkEvidence(runDir, { repoRoot, sinceMs: ctx.window.sinceTime ? Date.parse(ctx.window.sinceTime) : null });
    if (!evidence.ok) throw new InputError(`reviewed needs screenshots in --run-dir: ${evidence.reason} (${runDir})`);
    const rounds = countRounds(ctx.reviews, { windowKnown: ctx.window.sinceTime !== null });
    const round = rounds === null ? null : (rounds[surface] ?? 0) + 1;
    if (round !== null && round > MAX_REVIEW_ROUNDS) {
      // With act-on-verdicts off (default) findings are only recorded: no owner decision (MR !413 review 3, M2).
      throw new InputError(config.act_on_verdicts
        ? `${surface} already had ${MAX_REVIEW_ROUNDS} review rounds this session: the owner decides (accept as is = owner-override, or change direction)`
        : `${surface} already had ${MAX_REVIEW_ROUNDS} review rounds this session: no further round; its findings stay recorded (act-on-verdicts is off)`);
    }
    Object.assign(fields, {
      reviewer,
      verdict: values.verdict,
      judged: !NOT_JUDGED_VERDICTS.includes(values.verdict),
      run_dir: runDir,
      screenshots: evidence.pngs.slice(0, 20).map((p) => p.sha256),
      round,
    });
  }
  if (status === 'not-reviewable') {
    const target = probeRenderedTarget(repoRoot, ctx.ui.paths);
    if (target.renderable.length > 0) fields.override_like = true;
  }
  if (status === 'owner-override') {
    const { kind, steering } = sessionKind({ leadGuidedFlag: values['lead-guided'] === true });
    const decision = typeof values.decision === 'string' ? values.decision.trim() : '';
    if (decision && !DECISION_ID.test(decision)) throw new InputError(`--decision "${decision}" is not an owner-queue id`);
    if (kind !== 'interactive' && !decision) {
      throw new InputError(`owner-override refused in a ${kind} session (steering: ${steering ?? 'unknown'}): nobody can give the owner's words here; pass --decision <owner-queue id>`);
    }
    Object.assign(fields, { session_kind: kind, steering, actor: decision ? `owner-queue:${decision}` : 'owner-via-agent' });
  }

  const res = await writeRecord(repoRoot, ctx, fields);
  if (!res.ok) {
    process.stderr.write(`design-review: ${res.error}. ${ESCAPE}\n`);
    return 2;
  }
  const limit = typeof fields.round === 'number' && fields.round >= MAX_REVIEW_ROUNDS;
  const limitAction = limit ? (config.act_on_verdicts ? 'owner-decision' : 'record-only') : null;
  const notes = [...ctx.notes];
  if (!ctx.changeSet.ok) notes.push(`WARNING change set unmeasured (${ctx.changeSet.reason}): the record covers no file`);
  if (res.unhashed) notes.push('WARNING UI files could not be hashed: the record covers no file');
  if (fields.round === null) notes.push('session window unknown: rounds not counted');
  if (fields.judged === false) notes.push(`verdict ${fields.verdict} judged nothing: reported as "not judged" at close`);
  if (fields.override_like) notes.push('this repo can render the change: a manual not-reviewable is reported at close like an override');
  out(
    values,
    { recorded: true, id: res.record.id, ...fields, covers: res.record.covers.length, limit_reached: limit, limit_action: limitAction, notes },
    [`design-review: recorded ${status} for ${surface}, covering ${res.record.covers.length} UI file(s)` +
      (fields.round ? ` (round ${fields.round} of ${MAX_REVIEW_ROUNDS})` : '') +
      (limitAction === 'owner-decision' ? ' — round limit reached: open findings go to the owner as a decision' : '') +
      (limitAction === 'record-only' ? ' — round limit reached: findings stay recorded only (act-on-verdicts is off)' : ''), ...notes].join('\n'),
  );
  return 0;
}

function shown(list) {
  return list.slice(0, 5).join(', ') + (list.length > 5 ? `, … (+${list.length - 5})` : '');
}

async function runCheck(repoRoot, values, config) {
  if (!config.enabled) {
    out(values, { verdict: 'skip', reason: 'disabled', enabled_source: config.enabled_source, notes: config.notes },
      [`Design review: off (${config.enabled_source}).`, ...config.notes.map((n) => `note: ${n}`)].join('\n'));
    return 0;
  }
  const ctx = sessionContext(repoRoot, values, config);
  const keys = ctx.ui.paths.length > 0 ? coverKeys(repoRoot, ctx.ui.paths) : [];
  const target = probeRenderedTarget(repoRoot, ctx.ui.paths);
  const gate = evaluateCloseGate({
    enabled: true,
    changeSet: ctx.changeSet,
    uiPaths: ctx.ui.paths,
    keys,
    reviews: ctx.reviews,
    renderable: target.renderable,
    reviewableReason: notRenderableReason(target),
    ledgerReadable: ctx.ledger.readable,
    ledgerWritable: recordsWritable(repoRoot),
  });
  const warnOnly = gate.verdict === 'refuse' && config.close_gate !== 'refuse';
  const verdict = warnOnly ? 'would-refuse' : gate.verdict;

  let recorded = null;
  if (['not-reviewable', 'unmeasured', 'would-refuse'].includes(verdict)) {
    const sig = [...gate.uncovered].sort().join('\n');
    const dup = verdict === 'would-refuse' && ctx.reviews.find((r) => r.status === 'would-refuse' && r.uncovered_sig === sig);
    if (dup) recorded = { status: verdict, id: dup.id, existing: true };
    else {
      const extra = verdict === 'would-refuse'
        ? { uncovered: gate.uncovered.slice(0, 50), uncovered_count: gate.uncovered.length, uncovered_sig: sig, change_set: describeChangeSet(ctx) }
        : {};
      const res = await writeRecord(repoRoot, ctx, { status: verdict, surface: 'all', reason: gate.reason, auto: true, ...extra });
      recorded = res.ok ? { status: verdict, id: res.record.id } : { error: res.error };
    }
  }

  const listed = (status) => ctx.reviews.filter((r) => r.status === status);
  const overrides = listed('owner-override')
    .map((r) => ({ reason: r.reason, actor: r.actor ?? null, session_kind: r.session_kind ?? null, at: r.timestamp }));
  const manualNotReviewable = listed('not-reviewable').filter((r) => !r.auto)
    .map((r) => ({ reason: r.reason, override_like: r.override_like === true, at: r.timestamp }));
  const notJudged = listed('reviewed').filter((r) => r.judged === false)
    .map((r) => ({ surface: r.surface, reviewer: r.reviewer, verdict: r.verdict, at: r.timestamp }));
  const coveringBy = [...new Set(ctx.reviews.filter((r) => REVIEW_STATUSES.includes(r.status) && (r.covers ?? []).length > 0)
    .map((r) => (r.status === 'reviewed' ? `reviewed by ${r.reviewer ?? '?'}${r.judged === false ? ', not judged' : ''}` : r.status)))];
  const recordedText = recorded?.id ? (recorded.existing ? 'already recorded' : 'recorded automatically') : `NOT recorded (${recorded?.error})`;
  const refuseWhy = `this session changed ${gate.uncovered.length} UI file(s) that the repo can render and no design review covers ` +
    `(${shown(gate.uncovered)}; configs: ${target.configs.join(', ')})`;
  const message = {
    pass: gate.reason === 'no-ui-touch' ? 'Design review: not needed, no UI files changed.' : `Design review: covered (${coveringBy.join('; ')}).`,
    refuse: `Close refused: ${refuseWhy}. Run the design review (wave-loop-review.md step 5b). ` +
      `Owner override only with the owner's own words: design-review.mjs record --status owner-override --reason "<words>". ${ESCAPE}`,
    'would-refuse': `WARNING Design review: would refuse (close gate in warn mode, #1452): ${refuseWhy}. ` +
      `Close continues; ${recordedText} for the lead's classification.`,
    'not-reviewable': `WARNING Design review: not reviewable — ${gate.reason}; ${gate.uncovered.length} UI file(s) unreviewed (${shown(gate.uncovered)}). ${recordedText}.`,
    unmeasured: `WARNING Design review: unmeasured — ${gate.reason}. ${recordedText}.`,
  }[verdict];
  const lines = [`${message} [change set: ${describeChangeSet(ctx)}]`];
  for (const o of overrides) lines.push(`Owner override on record: "${o.reason}" (${o.actor}, ${o.session_kind} session, ${o.at})`);
  for (const m of manualNotReviewable) {
    lines.push(`Marked not reviewable by hand: "${m.reason}" (${m.at})${m.override_like ? ' — although the repo can render it: treat like an override' : ''}`);
  }
  for (const j of notJudged) lines.push(`Not judged: ${j.surface} reviewed by ${j.reviewer} with verdict ${j.verdict} (${j.at})`);
  if (ctx.changeSet.ok && ctx.changeSet.preexisting.length > 0) {
    lines.push(`Not counted (changed before the session started): ${shown(ctx.changeSet.preexisting)}`);
  }
  for (const n of [...config.notes, ...ctx.notes]) lines.push(`note: ${n}`);
  out(values, {
    ...gate,
    verdict,
    close_gate: config.close_gate,
    close_gate_source: config.close_gate_source,
    paths: ctx.ui.paths,
    change_set: describeChangeSet(ctx),
    preexisting: ctx.changeSet.ok ? ctx.changeSet.preexisting : [],
    renderable: target.renderable,
    reviews: ctx.reviews.length,
    overrides,
    manual_not_reviewable: manualNotReviewable,
    not_judged: notJudged,
    recorded,
    window_source: ctx.window.source,
    enabled_source: config.enabled_source,
    notes: [...config.notes, ...ctx.notes],
  }, lines.join('\n'));
  return verdict === 'refuse' ? 3 : 0;
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

async function runCritiqueCmd(repoRoot, values, config) {
  // role: a section shot is judged without the page value sentence (designer --role section)
  const pairs = (imgs, vps, flag, value) => {
    const a = imgs ?? [];
    const b = vps ?? [];
    if (a.length !== b.length) throw new InputError(`critique needs one ${flag === 'section' ? '--section-viewport per --section-image' : '--viewport per --image'}`);
    return a.map((image, i) => ({ image, viewport: b[i], value, role: flag === 'section' ? 'section' : 'first-view' }));
  };
  const shots = [
    ...pairs(values.image, values.viewport, 'page', values.value ?? null),
    ...pairs(values['section-image'], values['section-viewport'], 'section', null),
  ];
  if (shots.length === 0 || (values.image ?? []).length === 0) throw new InputError('critique needs at least one --image (the first viewport-height shot of the page)');
  const bad = shots.find((s) => !VIEWPORT.test(s.viewport));
  if (bad) throw new InputError(`--viewport "${bad.viewport}" is not WxH`);
  const designer = resolveDesignerCommand({ configured: config.designer, repoRoot });
  const broken = designer.configured_broken ? `configured designer not executable: ${designer.configured_broken}` : null;
  if (!designer.command) {
    const reason = broken ?? 'no designer command (PATH or design-review.designer)';
    out(values, { reviewer: 'none', fallback: 'ux-evaluator', reason }, `critique: ${reason} — fall back to ux-evaluator`);
    return 0;
  }
  const context = values.context ?? findDesignInputs(repoRoot).design_context;
  const results = await mapLimited(shots, CRITIQUE_CONCURRENCY, (s) => runCritique({
    command: designer.command, image: resolve(repoRoot, s.image), viewport: s.viewport, context, value: s.value, role: s.role,
  }));
  const critiques = results.map((res, i) => (res.ok ? { viewport: shots[i].viewport, ...res.critique } : { viewport: shots[i].viewport, error: res.error }));
  const errors = critiques.filter((c) => c.error).map(({ viewport, error }) => ({ viewport, error }));
  const roleFallback = results.find((r) => r.role_fallback)?.role_fallback ?? null;
  const roleNote = roleFallback && shots.some((s) => s.role === 'section')
    ? `WARNING ${roleFallback}: the role flag was not passed; section shots were judged as first views, which measures them against the page value sentence when the context names one; update designer (agentic-designer !16)`
    : roleFallback;
  const combined = combineCritiques(critiques);
  if (!combined) {
    out(values, { reviewer: 'none', fallback: 'ux-evaluator', reason: 'designer produced no verdict', errors, configured_broken: designer.configured_broken },
      `critique: designer produced no verdict (${errors.map((e) => e.error).join('; ')}) — fall back to ux-evaluator`);
    return 0;
  }
  const effective = effectiveActions(combined, config.act_on_verdicts);
  out(values, {
    reviewer: 'designer',
    source: designer.source,
    configured_broken: designer.configured_broken,
    ...combined,
    ...effective,
    act_on_verdicts: config.act_on_verdicts,
    act_on_verdicts_source: config.act_on_verdicts_source,
    critiques: critiques.map(({ viewport, verdict, image_sha256, error }, i) => ({
      viewport, section: shots[i].value === null && i >= (values.image ?? []).length, role: shots[i].role, verdict: verdict ?? 'recapture', image_sha256: image_sha256 ?? null,
      ...(results[i].role_fallback ? { role_passed: false } : {}), ...(error ? { error } : {}),
    })),
    errors,
    role_fallback: roleNote,
  }, `critique: ${combined.verdict} → ${effective.actions.join(' + ')}` +
    (config.act_on_verdicts ? '' : ` (would be: ${effective.advisory_actions.join(' + ') || 'none'}; act-on-verdicts off)`) +
    ` (${combined.findings.length} finding(s)` +
    `${errors.length ? `, ${errors.length} image(s) failed and count as recapture` : ''})` + (broken ? `\n${broken}; used ${designer.command}` : '') +
    (roleNote ? `\n${roleNote}` : ''));
  return 0;
}

function runWouldRefuse(repoRoot, values) {
  const roots = typeof values.repos === 'string' && values.repos.trim()
    ? values.repos.split(',').map((s) => resolve(s.trim())).filter(Boolean)
    : [repoRoot];
  const rows = [];
  for (const root of roots) {
    const { records, readable } = readRecords(root);
    if (!readable) {
      rows.push({ repo: root, error: 'records unreadable' });
      continue;
    }
    for (const r of records.filter((x) => x?.status === 'would-refuse')) {
      rows.push({
        repo: root, id: r.id, at: r.timestamp, session: r.semantic_session_id ?? r.session_id ?? null, branch: r.branch ?? null,
        change_set: r.change_set ?? null, uncovered_count: r.uncovered_count ?? null, uncovered: r.uncovered ?? [],
      });
    }
  }
  const human = rows.length === 0
    ? 'design-review: no would-refuse records'
    : ['| repo | at | session | branch | files | change set | uncovered (first 3) | classification |', '|---|---|---|---|---|---|---|---|',
      ...rows.map((r) => (r.error
        ? `| ${r.repo} | — | — | — | — | — | ${r.error} | |`
        : `| ${r.repo.split('/').pop()} | ${r.at} | ${r.session ?? '—'} | ${r.branch ?? '—'} | ${r.uncovered_count} | ${r.change_set ?? '—'} | ${r.uncovered.slice(0, 3).join(', ')} | |`))].join('\n');
  out(values, { count: rows.filter((r) => !r.error).length, rows }, human);
  return 0;
}

/** @param {string[]} argv @returns {Promise<number>} */
export async function main(argv = process.argv.slice(2)) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help')) {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        'repo-root': { type: 'string' },
        repos: { type: 'string' },
        since: { type: 'string' },
        'since-time': { type: 'string' },
        files: { type: 'string' },
        'files-from': { type: 'string' },
        status: { type: 'string' },
        surface: { type: 'string' },
        verdict: { type: 'string' },
        findings: { type: 'string' },
        'run-dir': { type: 'string' },
        reason: { type: 'string' },
        wave: { type: 'string' },
        reviewer: { type: 'string' },
        decision: { type: 'string' },
        'lead-guided': { type: 'boolean', default: false },
        image: { type: 'string', multiple: true },
        viewport: { type: 'string', multiple: true },
        'section-image': { type: 'string', multiple: true },
        'section-viewport': { type: 'string', multiple: true },
        context: { type: 'string' },
        value: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`design-review: ${err.message}\n`);
    return 1;
  }
  const repoRoot = values['repo-root'] ? resolve(values['repo-root']) : repoToplevel();
  if (!existsSync(repoRoot)) {
    process.stderr.write(`design-review: repo root not found: ${repoRoot}\n`);
    return 1;
  }
  try {
    if (sub === 'would-refuse') return runWouldRefuse(repoRoot, values);
    const config = await readDesignReviewConfig(repoRoot);
    if (sub === 'detect') return runDetect(repoRoot, values, config);
    if (sub === 'record') return await runRecord(repoRoot, values, config);
    if (sub === 'check') return await runCheck(repoRoot, values, config);
    if (sub === 'critique') return await runCritiqueCmd(repoRoot, values, config);
  } catch (err) {
    process.stderr.write(`design-review: ${err?.message ?? err}\n`);
    return err instanceof InputError || err instanceof SyntaxError || err?.code === 'ENOENT' ? 1 : 2;
  }
  process.stderr.write(`design-review: unknown subcommand "${sub}"\n${HELP}`);
  return 1;
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
