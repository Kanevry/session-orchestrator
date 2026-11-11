/**
 * issue-balance.mjs — what THIS session added to and removed from the backlog,
 * plus the planning rule that bundles LOW follow-ups into one collector (#1947).
 *
 * WHY: measured 2026-11-04 over 52 fleet projects, 35 days: 5,427 issues
 * created vs 4,585 closed (balance +842, ~+24/day); 32 % of new issues were
 * `priority::low`, 17 % follow-ups. Sessions produce most of them themselves,
 * and session-end never showed a session its own contribution. This module
 * renders one balance line for the Phase 6 Final Report and plans the
 * `[Backlog-Sammel]` collector that Phase 5 Step 3b files.
 *
 * ## Three states, never a silent zero
 *
 * Every number is one of
 *   - `measured`   — a value with its population (what was counted) and time
 *   - `no-value`   — the source exists but carries nothing for this session
 *                    (e.g. the record has no `issues_created` field)
 *   - `unreadable` — the source could not be read (CLI missing, timeout,
 *                    corrupt ledger, window full)
 * The formatter prints `kein Wert (…)` / `nicht messbar (…)` for the last two,
 * NEVER `0`: a balance of "+0" for a session whose count was never measured is
 * exactly the false-green the report exists to avoid.
 *
 * ## Sources (BV-001 rung 2 — what the repo already records)
 *
 *   created — `record.issues_created` (the in-memory Phase 3.7 session record),
 *             else the issue-budget ledger as summed by `reconcileIssueBudget`
 *             (`count + exempt`, both accounting keys).
 *   closed  — the per-id JSON lines of
 *             `scripts/lib/issue-close-strip-labels.mjs --close` (only
 *             `closed: true`, i.e. verified by platform re-read), else
 *             `record.issues_closed`.
 *   repo today — ONE `glab api` / `gh api` read of issues updated since local
 *             midnight, behind a timeout; created/closed counted from
 *             `created_at` / `closed_at`.
 *
 * No automatic closing of anything lives here (explicitly rejected in #1947).
 */

import { readFileSync } from 'node:fs';

import { spawnSync } from './native-command.mjs';

/** The three measurement states. */
export const BALANCE_STATE = Object.freeze({
  MEASURED: 'measured',
  NO_VALUE: 'no-value',
  UNREADABLE: 'unreadable',
});

/**
 * Largest page both CLIs serve in one request. A full page means the window
 * may hold more issues than were read — the repo-today value is then reported
 * `unreadable` instead of a lower bound posing as a balance (BV-004: revisit
 * with pagination if a repo routinely touches > 100 issues per day).
 */
export const REPO_TODAY_PAGE = 100;

/** Default timeout for the single repo-today VCS read. */
export const REPO_TODAY_TIMEOUT_MS = 10_000;

const measured = (value, population) => ({ state: BALANCE_STATE.MEASURED, value, population });
const noValue = (reason) => ({ state: BALANCE_STATE.NO_VALUE, reason });
const unreadable = (reason) => ({ state: BALANCE_STATE.UNREADABLE, reason });

/**
 * How many issues did this session create?
 *
 * @param {{ record?: object|null, reconcile?: object|null }} opts
 *   `reconcile` — the result of `reconcileIssueBudget` (Phase 5 Step 3b.2)
 * @returns {{state: string, value?: number, population?: string, reason?: string}}
 */
export function measureSessionCreated({ record = null, reconcile = null } = {}) {
  const created = record?.issues_created;
  if (Array.isArray(created)) {
    return measured(created.length, `issues_created im Session-Record (${created.length} Einträge)`);
  }
  if (created !== undefined && created !== null) {
    return unreadable('issues_created im Session-Record ist keine Liste');
  }
  const sources = Array.isArray(reconcile?.sources) ? reconcile.sources : [];
  if (sources.some((s) => s?.corrupt)) return unreadable('issue-budget-Ledger beschädigt');
  if (sources.some((s) => s?.found)) {
    const n = (reconcile.charged ?? 0) + (reconcile.exempt ?? 0);
    return measured(n, 'issue-budget-Ledger (count + exempt)');
  }
  return noValue('weder issues_created im Session-Record noch ein issue-budget-Ledger');
}

/**
 * Read the saved stdout of `issue-close-strip-labels.mjs --close` (one JSON
 * object per line). Three outcomes, kept apart on purpose:
 *   - no path given, or the file does not exist (ENOENT) → `undefined`: there
 *     is no close output, so {@link measureSessionClosed} falls back to
 *     `record.issues_closed`;
 *   - the file exists but cannot be read or holds a malformed JSON line →
 *     `'unreadable'`: "nicht messbar", never a silent fallback;
 *   - the file exists but holds no JSON line → `'unreadable'` as well: the
 *     Step-1 redirect creates the file before the close CLI runs, so a CLI that
 *     died before printing (usage error, missing module) leaves it empty, and
 *     Step 1 only runs with at least one id — zero lines is never a result;
 *   - otherwise → the parsed lines.
 *
 * @param {string|undefined} file
 * @returns {object[]|'unreadable'|undefined}
 */
export function readCloseResults(file) {
  if (!file) return undefined;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? undefined : 'unreadable';
  }
  let lines;
  try {
    lines = text
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l));
  } catch {
    return 'unreadable';
  }
  return lines.length === 0 ? 'unreadable' : lines;
}

/**
 * How many issues did this session close (verified)?
 *
 * @param {{ record?: object|null, closeResults?: unknown }} opts
 *   `closeResults` — parsed JSON lines of the close CLI, `undefined` when the
 *   CLI did not run this close.
 * @returns {{state: string, value?: number, population?: string, reason?: string}}
 */
export function measureSessionClosed({ record = null, closeResults = undefined } = {}) {
  if (closeResults !== undefined && closeResults !== null) {
    if (!Array.isArray(closeResults)) return unreadable('Ausgabe von issue-close-strip-labels nicht lesbar');
    const verified = closeResults.filter((r) => r && r.closed === true).length;
    return measured(
      verified,
      `issue-close-strip-labels --close: ${verified} von ${closeResults.length} IDs per Re-Read geschlossen`,
    );
  }
  const closed = record?.issues_closed;
  if (Array.isArray(closed)) {
    return measured(closed.length, `issues_closed im Session-Record (${closed.length} Einträge)`);
  }
  if (closed !== undefined && closed !== null) {
    return unreadable('issues_closed im Session-Record ist keine Liste');
  }
  return noValue('weder Close-Ausgabe noch issues_closed im Session-Record');
}

/**
 * Combine created and closed into a balance. Measured only when BOTH halves
 * are measured; an unreadable half wins over a missing one.
 *
 * @param {object} created
 * @param {object} closed
 * @returns {{state: string, value?: number, population?: string, reason?: string}}
 */
export function combineBalance(created, closed) {
  if (created?.state === BALANCE_STATE.MEASURED && closed?.state === BALANCE_STATE.MEASURED) {
    return measured(created.value - closed.value, 'angelegt minus geschlossen');
  }
  if (created?.state === BALANCE_STATE.UNREADABLE || closed?.state === BALANCE_STATE.UNREADABLE) {
    return unreadable('eine Hälfte nicht messbar');
  }
  return noValue('eine Hälfte ohne Wert');
}

/**
 * Local midnight of `now` as an ISO string — the "heute" window start.
 *
 * @param {Date} now
 * @returns {string}
 */
export function localMidnightIso(now) {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Count created/closed issues since `windowStart` out of one VCS page. Pure.
 *
 * @param {{ issues: unknown, windowStart: string, vcs: string, page?: number }} opts
 * @returns {{state: string, value?: number, created?: number, closed?: number, population?: string, reason?: string}}
 */
export function summarizeRepoToday({ issues, windowStart, vcs, page = REPO_TODAY_PAGE }) {
  if (!Array.isArray(issues)) return unreadable(`${vcs}-Antwort ist keine Liste`);
  if (issues.length >= page) {
    return unreadable(`mehr als ${page - 1} Issues seit ${windowStart} geändert, Fenster voll`);
  }
  const start = Date.parse(windowStart);
  const since = (iso) => typeof iso === 'string' && Date.parse(iso) >= start;
  let created = 0;
  let closed = 0;
  for (const it of issues) {
    if (!it || typeof it !== 'object' || it.pull_request) continue; // gh lists PRs as issues
    if (since(it.created_at)) created += 1;
    if (since(it.closed_at)) closed += 1;
  }
  return {
    ...measured(created - closed, `${vcs}: Issues mit Änderung seit ${windowStart} (n=${issues.length})`),
    created,
    closed,
  };
}

/** @param {string} bin @param {string[]} args @param {{cwd: string, timeout: number}} opts */
function defaultRun(bin, args, opts) {
  return spawnSync(bin, args, { encoding: 'utf8', cwd: opts.cwd, timeout: opts.timeout });
}

/**
 * Thin data-gathering wrapper: ONE `glab api` / `gh api` read, behind a timeout.
 * Never throws.
 *
 * @param {{ repoRoot: string, vcs?: string|null, now?: Date, run?: Function, timeoutMs?: number }} opts
 */
export function fetchRepoToday({
  repoRoot,
  vcs = null,
  now = new Date(),
  run = defaultRun,
  timeoutMs = REPO_TODAY_TIMEOUT_MS,
} = {}) {
  if (vcs !== 'gitlab' && vcs !== 'github') return noValue('vcs nicht gitlab/github');
  const windowStart = localMidnightIso(now);
  const q = `state=all&per_page=${REPO_TODAY_PAGE}`;
  const [bin, endpoint] =
    vcs === 'gitlab'
      ? ['glab', `projects/:fullpath/issues?${q}&scope=all&updated_after=${encodeURIComponent(windowStart)}`]
      : ['gh', `repos/{owner}/{repo}/issues?${q}&since=${encodeURIComponent(windowStart)}`];
  try {
    const r = run(bin, ['api', endpoint], { cwd: repoRoot, timeout: timeoutMs });
    if (r?.error?.code === 'ENOENT') return unreadable(`${bin} nicht installiert`);
    if (r?.error?.code === 'ETIMEDOUT' || r?.signal) return unreadable(`${bin} api nach ${timeoutMs} ms abgebrochen`);
    if (r?.status !== 0) return unreadable(`${bin} api Exit ${r?.status ?? 'unbekannt'}`);
    let issues;
    try {
      issues = JSON.parse(String(r.stdout ?? ''));
    } catch {
      return unreadable(`${bin} api lieferte kein JSON`);
    }
    return summarizeRepoToday({ issues, windowStart, vcs });
  } catch (err) {
    return unreadable(`${bin} api: ${err?.code ?? 'Fehler'}`);
  }
}

/**
 * Build the full balance object.
 *
 * @param {{ record?: object|null, reconcile?: object|null, closeResults?: unknown, repoToday?: object|null, now?: Date }} opts
 */
export function computeIssueBalance({
  record = null,
  reconcile = null,
  closeResults = undefined,
  repoToday = null,
  now = new Date(),
} = {}) {
  const created = measureSessionCreated({ record, reconcile });
  const closed = measureSessionClosed({ record, closeResults });
  return {
    created,
    closed,
    balance: combineBalance(created, closed),
    repoToday: repoToday ?? noValue('nicht abgefragt'),
    measuredAt: now.toISOString(),
  };
}

const MINUS = '−';

function signed(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `${MINUS}${Math.abs(n)}`;
  return '±0';
}

function notMeasured(v) {
  return v?.state === BALANCE_STATE.UNREADABLE
    ? `nicht messbar (${v.reason})`
    : `kein Wert (${v?.reason ?? 'unbekannt'})`;
}

/**
 * Render the Final Report line. A non-measured value is printed as its state
 * plus reason — never as a number.
 *
 * @param {ReturnType<typeof computeIssueBalance>} b
 * @returns {string}
 */
export function formatIssueBalance(b) {
  const isM = (v) => v?.state === BALANCE_STATE.MEASURED;
  const created = isM(b.created) ? `+${b.created.value} angelegt` : `angelegt: ${notMeasured(b.created)}`;
  const closed = isM(b.closed) ? `${MINUS}${b.closed.value} geschlossen` : `geschlossen: ${notMeasured(b.closed)}`;
  const saldo = isM(b.balance) ? `Saldo ${signed(b.balance.value)}` : `Saldo: ${notMeasured(b.balance)}`;
  const repo = isM(b.repoToday) ? `Repo heute: ${signed(b.repoToday.value)}` : `Repo heute: ${notMeasured(b.repoToday)}`;
  const pops = [
    isM(b.created) ? `angelegt = ${b.created.population}` : null,
    isM(b.closed) ? `geschlossen = ${b.closed.population}` : null,
    isM(b.repoToday) ? `Repo = ${b.repoToday.population}` : null,
  ].filter(Boolean);
  const popText = pops.length ? ` — Grundgesamtheit: ${pops.join('; ')}` : '';
  return `Issues dieser Session: ${created}, ${closed}, ${saldo} (${repo})${popText}; gemessen ${b.measuredAt}`;
}

// ---------------------------------------------------------------------------
// LOW follow-up bundling (#1947 part 2)
// ---------------------------------------------------------------------------

/**
 * Normalise a finding's priority/severity to `critical|high|medium|low|null`.
 *
 * @param {object} f
 * @returns {string|null}
 */
export function findingPriority(f) {
  const raw = String(f?.priority ?? f?.severity ?? '').toLowerCase().replace(/^priority::?/, '').trim();
  if (raw === 'med') return 'medium';
  return ['critical', 'high', 'medium', 'low'].includes(raw) ? raw : null;
}

/** Collector command-text ceiling for an overflow entry without a title. */
export const COLLECTOR_COMMAND_MAX = 120;

function overflowLines(entry, thisRepo) {
  const label =
    typeof entry?.title === 'string' && entry.title
      ? entry.title
      : String(entry?.command ?? '').slice(0, COLLECTOR_COMMAND_MAX);
  const lines = [`- [ ] ${label}${entry?.at ? ` (${entry.at})` : ''}`];
  const foreign = typeof entry?.repo === 'string' && entry.repo && thisRepo && entry.repo !== thisRepo;
  if (typeof entry?.repo === 'string' && entry.repo) lines.push(`  Ziel: ${entry.repo}`);
  if (foreign) {
    lines.push('  Beschreibung zurückgehalten (Ziel-Repo abweichend) — liegt im Budget-Zustand');
    return lines;
  }
  if (typeof entry?.description === 'string' && entry.description) {
    const summary = entry.truncated ? 'Beschreibung (gekürzt)' : 'Beschreibung';
    lines.push(`  <details><summary>${summary}</summary>`, '', entry.description, '', '  </details>');
  } else if (entry?.truncated) {
    lines.push('  Beschreibung zu groß, nicht übernommen');
  }
  if (entry?.descriptionUnresolved === 'cwd-changed') {
    lines.push('  Beschreibung nicht aufgelöst (cd in der Kette)');
  }
  return lines;
}

function findingLine(f) {
  const where = f?.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : '';
  const src = f?.source ? ` [${f.source}]` : '';
  return `- [ ] ${String(f?.title ?? f?.description ?? '').trim()}${where}${src}`;
}

/**
 * Plan which findings become single issues and which go into the session's
 * ONE `[Backlog-Sammel]` collector. Pure — no VCS call.
 *
 * Rule (#1947): a finding at `priority::low` that would otherwise be filed is
 * a checklist line in the collector; MEDIUM and above stay single issues; an
 * unknown priority stays single (never hide a finding we cannot classify).
 * The issue-budget overflow (`overflow[]`, Phase 5 Step 3b) lands in the SAME
 * collector, so a session files at most one.
 *
 * @param {{ sessionId: string, findings?: object[], overflow?: object[], thisRepo?: string|null }} opts
 * @returns {{ single: object[], bundled: object[], collector: {title: string, labels: string[], body: string, items: number}|null }}
 */
export function planBacklogCollector({ sessionId, findings = [], overflow = [], thisRepo = null }) {
  const list = Array.isArray(findings) ? findings : [];
  const parked = Array.isArray(overflow) ? overflow : [];
  const bundled = list.filter((f) => findingPriority(f) === 'low');
  const single = list.filter((f) => findingPriority(f) !== 'low');
  const items = bundled.length + parked.length;
  if (items === 0) return { single, bundled, collector: null };

  const body = [];
  if (bundled.length) {
    body.push('## LOW-Folgepunkte (gebündelt, #1947)', '', ...bundled.map(findingLine), '');
  }
  if (parked.length) {
    body.push('## Zurückgestellt (issue-budget)', '', ...parked.flatMap((e) => overflowLines(e, thisRepo)), '');
  }
  return {
    single,
    bundled,
    collector: {
      title: `[Backlog-Sammel] ${sessionId}, ${items} zurückgestellte Punkte`,
      labels: ['type::backlog', 'priority::low'],
      body: body.join('\n'),
      items,
    },
  };
}
