#!/usr/bin/env node
/**
 * vault-integration-watcher.mjs — Daily watcher for vault-integration warn→strict flip (Issue #306).
 *
 * Runs via GitLab CI Scheduled Pipeline (SCHEDULE_NAME=vault-watcher).
 * Reads state of #303 + #304, computes a daily verdict, posts a comment to #305,
 * and triggers a "flip-ready" comment once 3 consecutive ticks are umstellungs-bereit.
 *
 * CLI usage:
 *   node scripts/vault-integration-watcher.mjs [--dry-run] [--issue <id>] [--verbose]
 *     [--glab-bin <path>]        override glab binary (used by tests)
 *     [--issue <id>]             override tracking issue (default: 305)
 *     [--dep-issues <id,id>]     override dependency issues (default: 303,304)
 *     [--dry-run]                compute + print, no glab posts
 *     [--verbose]                extra diagnostics to stderr
 *
 * Exit codes:
 *   0 — success (comment posted or early-exit)
 *   1 — user/input error
 *   2 — system error (glab failure, network)
 *
 * Markers recognised:
 *   <!-- vault-watcher:v1 -->            — daily tick comment
 *   <!-- vault-watcher:v1:flip-ready --> — flip trigger (stops further runs)
 *   <!-- vault-watcher:v1:stagnation --> — stagnation guard (stops further runs)
 *
 * All diagnostics → stderr. Structured actions → stdout (one JSON object per line).
 */

import { spawnSync } from 'node:child_process';

// ── Argument parsing ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getArg(name) {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const TRACKING_ISSUE = getArg('--issue') ?? '305';
const DEP_ISSUES_RAW = getArg('--dep-issues') ?? '303,304';
const DEP_ISSUES = DEP_ISSUES_RAW.split(',').map((s) => s.trim());
const GLAB_BIN = getArg('--glab-bin') ?? process.env.GLAB_BIN ?? 'glab';

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[vault-watcher] ${msg}\n`);
}

function verbose(msg) {
  if (VERBOSE) log(msg);
}

function emit(action) {
  process.stdout.write(JSON.stringify(action) + '\n');
}

// ── glab helpers ──────────────────────────────────────────────────────────────

/**
 * Run a glab command and return parsed JSON output.
 * @param {string[]} args
 * @returns {unknown}
 */
function glabJson(args) {
  verbose(`glab ${args.join(' ')}`);
  const result = spawnSync(GLAB_BIN, args, { encoding: 'utf8', timeout: 30_000 });
  if (result.error) {
    log(`glab spawn error: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    log(`glab exited ${result.status}: ${result.stderr?.trim()}`);
    process.exit(2);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    log(`glab JSON parse error: ${e.message}\nRaw: ${result.stdout.slice(0, 200)}`);
    process.exit(2);
  }
}

/**
 * Post a comment to an issue.
 * @param {string} issueId
 * @param {string} body
 */
function postComment(issueId, body) {
  if (DRY_RUN) {
    log(`[dry-run] would post comment to #${issueId}:\n${body}`);
    emit({ action: 'comment-dry-run', issue: issueId, body });
    return;
  }
  verbose(`posting comment to #${issueId}`);
  const result = spawnSync(
    GLAB_BIN,
    ['issue', 'note', 'add', issueId, '--message', body],
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (result.error) {
    log(`glab note add spawn error: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    log(`glab note add exited ${result.status}: ${result.stderr?.trim()}`);
    process.exit(2);
  }
  emit({ action: 'comment-posted', issue: issueId });
}

// ── Fetch issue state ─────────────────────────────────────────────────────────

/**
 * Fetch multiple issues at once via individual glab calls.
 * Returns a map of { [id]: { state, closed_at, iid } }
 * @param {string[]} ids
 * @returns {Record<string, {state: string, closed_at: string|null, iid: number}>}
 */
function fetchIssues(ids) {
  const map = {};
  for (const id of ids) {
    const data = glabJson(['issue', 'view', id, '--output', 'json']);
    map[id] = {
      state: data.state,
      closed_at: data.closed_at ?? null,
      iid: data.iid ?? Number(id),
    };
    verbose(`#${id} state=${data.state}`);
  }
  return map;
}

// ── Fetch comments on tracking issue ─────────────────────────────────────────

/**
 * Fetch the last N comments (notes) from the tracking issue.
 * glab issue view --comments --output json returns an array of note objects.
 * @param {string} issueId
 * @returns {Array<{body: string, created_at: string}>}
 */
function fetchComments(issueId) {
  const data = glabJson(['issue', 'view', issueId, '--comments', '--output', 'json']);
  // The response may be an object with a `comments` key or a direct array
  const notes = Array.isArray(data) ? data : (data.comments ?? data.notes ?? []);
  verbose(`fetched ${notes.length} comments from #${issueId}`);
  return notes;
}

// ── Marker logic ──────────────────────────────────────────────────────────────

const MARKER_TICK = '<!-- vault-watcher:v1 -->';
const MARKER_FLIP = '<!-- vault-watcher:v1:flip-ready -->';
const MARKER_STAGNATION = '<!-- vault-watcher:v1:stagnation -->';

/**
 * @param {Array<{body: string}>} comments
 * @returns {{ hasFlip: boolean, hasStagnation: boolean, tickComments: Array<{body: string, created_at: string}> }}
 */
function analyseComments(comments) {
  let hasFlip = false;
  let hasStagnation = false;
  const tickComments = [];

  for (const c of comments) {
    const body = c.body ?? '';
    if (body.includes(MARKER_FLIP)) hasFlip = true;
    if (body.includes(MARKER_STAGNATION)) hasStagnation = true;
    if (body.includes(MARKER_TICK) && !body.includes(MARKER_FLIP) && !body.includes(MARKER_STAGNATION)) {
      tickComments.push(c);
    }
  }

  return { hasFlip, hasStagnation, tickComments };
}

// ── Streak computation ────────────────────────────────────────────────────────

const VERDICT_READY = 'umstellungs-bereit';
const VERDICT_WARN = 'bleibt warn';

/**
 * Parse verdict from a tick comment body.
 * @param {string} body
 * @returns {string|null}
 */
function parseVerdictFromBody(body) {
  if (body.includes(VERDICT_READY)) return VERDICT_READY;
  if (body.includes(VERDICT_WARN)) return VERDICT_WARN;
  return null;
}

/**
 * Count consecutive trailing umstellungs-bereit ticks (sorted ascending by created_at).
 * @param {Array<{body: string, created_at: string}>} tickComments
 * @returns {number}
 */
function countStreak(tickComments) {
  // Sort ascending by created_at
  const sorted = [...tickComments].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  let streak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const verdict = parseVerdictFromBody(sorted[i].body ?? '');
    if (verdict === VERDICT_READY) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// ── Stagnation check ──────────────────────────────────────────────────────────

/**
 * Check if the issue was created more than maxDays ago.
 * @param {string} createdAt ISO timestamp
 * @param {number} maxDays
 * @returns {boolean}
 */
function isStagnant(createdAt, maxDays = 60) {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const diffDays = (now - created) / (1000 * 60 * 60 * 24);
  return diffDays > maxDays;
}

// ── Comment body builders ─────────────────────────────────────────────────────

/**
 * Build the daily tick comment body.
 * @param {{[id: string]: {state: string}}} issueMap
 * @param {string[]} depIds
 * @param {string} verdict
 * @param {number} streak
 * @param {string} date YYYY-MM-DD
 * @returns {string}
 */
function buildTickBody(issueMap, depIds, verdict, streak, date) {
  const stateLines = depIds.map((id) => `#${id}: ${issueMap[id]?.state ?? 'unknown'}`).join(' · ');
  return `${MARKER_TICK}
**${date} watcher tick**
- ${stateLines}
- Streak \`${VERDICT_READY}\`: ${streak}/3
- Verdict: ${verdict}`;
}

/**
 * Build the flip-ready trigger comment body.
 * @param {string[]} repos
 * @returns {string}
 */
function buildFlipBody(repos) {
  const repoList = repos.join(' ');
  // The sed/add/commit one-liner targets the project-instruction file. Most
  // ecosystem repos use CLAUDE.md, but Codex-CLI repos use AGENTS.md as a
  // transparent alias — see skills/_shared/instruction-file-resolution.md.
  // The embedded loop picks whichever exists per repo.
  return `${MARKER_FLIP}
🚦 **BEREIT ZUM FLIP** — manueller Run-Through über die ${repos.length} Repos jetzt legitim.

Lokaler Befehl (ein-Liner pro Repo, aber besser per Session orchestriert; CLAUDE.md and AGENTS.md sind Aliase):
\`\`\`bash
for d in ${repoList}; do
  for f in CLAUDE.md AGENTS.md; do
    [ -s ~/Projects/$d/$f ] || continue
    sed -i.bak 's/mode: warn }/mode: strict }/' ~/Projects/$d/$f
    git -C ~/Projects/$d add $f
    break
  done
  git -C ~/Projects/$d commit -m 'chore(orchestrator): Promote vault-integration to strict mode — closes #305'
done
\`\`\``;
}

/**
 * Build the stagnation comment body.
 * @returns {string}
 */
function buildStagnationBody() {
  return `${MARKER_STAGNATION}
⚠️ **Watcher-Stagnation**: 60 Tage ohne Bewegung — manuelle Triage empfohlen. Watcher pausiert.`;
}

// ── Repos that need the flip ──────────────────────────────────────────────────

const FLIP_REPOS = [
  'launchpad-ai-factory',
  'Codex-Hackathon',
  'EventDrop.at',
  'GotzendorferAT',
  'GotzendorferV2',
  'LeadPipeDACH',
  'WalkAITalkie',
  'aegis',
  'ai-gateway',
  'clank',
  'eventdrop-render-service',
  'feedfoundry',
  'launchpad',
  'mail-assistant',
  'n8n',
  'projects-baseline',
];

// ── Today's date ──────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`starting (dry-run=${DRY_RUN}, tracking=#${TRACKING_ISSUE}, deps=${DEP_ISSUES.join(',')})`);

  // 1. Fetch comments on tracking issue to check for early-exit markers
  const comments = fetchComments(TRACKING_ISSUE);
  const { hasFlip, hasStagnation, tickComments } = analyseComments(comments);

  if (hasFlip) {
    log('early exit — flip-ready marker already present on issue');
    emit({ action: 'early-exit', reason: 'flip-ready' });
    process.exit(0);
  }

  if (hasStagnation) {
    log('early exit — stagnation marker already present on issue');
    emit({ action: 'early-exit', reason: 'stagnation' });
    process.exit(0);
  }

  // 2. Fetch state of dependency issues
  const issueMap = fetchIssues(DEP_ISSUES);

  // 3. Compute verdict
  const allClosed = DEP_ISSUES.every((id) => issueMap[id]?.state === 'closed');
  const verdict = allClosed ? VERDICT_READY : VERDICT_WARN;
  verbose(`verdict=${verdict} (allClosed=${allClosed})`);

  // 4. Compute streak (include today's would-be tick in count if ready)
  //    We count existing ticks first, then the new tick (if ready) adds 1
  const existingStreak = countStreak(tickComments);
  const newStreak = verdict === VERDICT_READY ? existingStreak + 1 : 0;

  verbose(`existingStreak=${existingStreak} newStreak=${newStreak}`);

  // 5. Check stagnation — fetch created_at of the tracking issue
  const trackingIssueData = glabJson(['issue', 'view', TRACKING_ISSUE, '--output', 'json']);
  const createdAt = trackingIssueData.created_at;

  if (verdict === VERDICT_WARN && isStagnant(createdAt, 60)) {
    log('stagnation detected — posting stagnation marker');
    postComment(TRACKING_ISSUE, buildStagnationBody());
    emit({ action: 'stagnation-posted', issue: TRACKING_ISSUE });
    process.exit(0);
  }

  // 6. Post daily tick comment
  const date = todayISO();
  const tickBody = buildTickBody(issueMap, DEP_ISSUES, verdict, newStreak, date);
  postComment(TRACKING_ISSUE, tickBody);
  emit({ action: 'tick-posted', issue: TRACKING_ISSUE, verdict, streak: newStreak, date });

  // 7. If streak == 3 (or more), post flip-ready trigger
  if (newStreak >= 3) {
    log(`streak=${newStreak} >= 3 — posting flip-ready trigger`);
    postComment(TRACKING_ISSUE, buildFlipBody(FLIP_REPOS));
    emit({ action: 'flip-ready-posted', issue: TRACKING_ISSUE });
  }

  log('done');
}

main().catch((err) => {
  log(`unexpected error: ${err.message}`);
  process.exit(2);
});
