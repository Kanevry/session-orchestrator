/**
 * criteria.mjs — pure evaluation core of the backlog checker (#2094).
 *
 * Contract: docs/backlog-refinement.md ("Label taxonomy", "The checks",
 * "Metrics", "Calibration", "Data contract"). No I/O; the only clock is the
 * injected `now`. Family checks normalize scopes. The declared type axis
 * also checks exact, case-sensitive issue labels.
 */

import { normalizeLabel, normalizedLabelSet } from '../label-scope.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const BARE_TYPE_LABELS = new Set([
  'bug',
  'feature',
  'enhancement',
  'chore',
  'docs',
  'documentation',
  'refactor',
  'epic',
  'discovery',
  'carryover',
]);
const FAMILY_ALIASES = new Map([['prio', 'priority']]);

/** Ordered check table; the order is the order of `checks` in the report. */
const CHECKS = [
  { id: 'label.priority-missing', scope: 'open', severity: 'warn', family: 'priority' },
  { id: 'label.type-missing', scope: 'open', severity: 'warn', family: 'type' },
  { id: 'label.status-missing', scope: 'open', severity: 'warn', family: 'status' },
  { id: 'label.status-multiple', scope: 'open', severity: 'warn', family: 'status' },
  { id: 'label.duplicate-spelling', scope: 'open', severity: 'info' },
  { id: 'ready.no-acceptance', scope: 'ready', severity: 'warn', family: 'status' },
  { id: 'ready.no-pointer', scope: 'ready', severity: 'warn', family: 'status' },
  { id: 'ready.no-verification', scope: 'ready', severity: 'info', family: 'status' },
  { id: 'ready.open-question', scope: 'ready', severity: 'info', family: 'status' },
  // Row severity is 'warn'; each finding carries warn (status:ready) or info.
  { id: 'size.too-big', scope: 'open', severity: 'warn' },
  { id: 'link.dependency-closed', scope: 'open', severity: 'warn' },
  { id: 'status.blocked-refs-closed', scope: 'blocked', severity: 'info', family: 'status' },
  { id: 'status.review-mr-merged', scope: 'review', severity: 'warn', family: 'status', mr: true },
  { id: 'status.review-no-mr', scope: 'review', severity: 'info', family: 'status', mr: true },
  { id: 'epic.no-children', scope: 'epic', severity: 'info' },
  { id: 'epic.all-children-closed', scope: 'epic', severity: 'warn' },
  { id: 'epic.candidate-cluster', scope: 'open', severity: 'info' },
  { id: 'closed.status-label-left', scope: 'closed', severity: 'warn' },
  { id: 'closed.partly-checked', scope: 'closed', severity: 'info' },
];

const ACCEPTANCE_RE =
  /acceptance|akzeptanz|done when|fertig,?\s*wenn|definition of done|\bdod\b|abnahme/i;
const CHECKBOX_RE = /^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]/m;
const URL_RE = /https?:\/\/\S/i;
// One whitespace-delimited token that contains `/` and ends in a file
// extension (optionally `:line`, then closing punctuation). Tested per token and
// anchored: the earlier unanchored form went quadratic on long descriptions
// (31 KB of `a.b/` took ~1 s; a tracker description may be 1 MB).
const PATH_TOKEN_RE = /^[^\s]*\/[^\s]*\.[a-z0-9]{1,8}(?::\d+)?[`'")\].,;:]*$/i;
const MAX_PATH_TOKEN = 300;

/** @param {string} text */
function hasPathToken(text) {
  for (const token of text.split(/\s+/)) {
    if (token.length <= MAX_PATH_TOKEN && token.includes('/') && PATH_TOKEN_RE.test(token))
      return true;
  }
  return false;
}
const SOURCE_DIR_RE =
  /(?:^|[\s`'"([])(?:src|scripts|lib|tests?|hooks|skills|docs|commands|agents|app|packages|bin|config)\//m;
const COMMAND_RE =
  /(?:^|[\s$(;&|])(?:node |npm |pnpm |npx |pytest|cargo |go test|make |glab |gh |rg |curl )/m;
const TEST_FILE_RE = /\.(?:test|spec)\./i;
const OPEN_QUESTION_CS_RE = /\bTBD\b|\bTODO\b/;
const OPEN_QUESTION_CI_RE = /to be decided|zu klären|offene frage/i;
const DEPENDENCY_RE =
  /(?<!\p{L})(?:blocked by|blockiert durch|depends on|hängt ab von|wartet auf|waits for|requires)(?!\p{L})/giu;
// `#N` not preceded by a word char, `/`, `.` or `-` (cross-project `name#N`,
// `group/name#N`) nor `&` (HTML entity). `!N` MR references carry no `#`.
const LOCAL_REF_RE = /(?<![\w/.&-])#(\d+)(?!\w)/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const SIZE_TITLE_RE = /\[plan\]|sammel|collector|\bepic\b/i;
const EPIC_TITLE_RE = /^\s*\[?Epic\b/;
const TABLE_DELIMITER_RE = /^:?-+:?$/;
const LABEL_TOKEN_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_.+-]*(?:::?(?:[\p{L}\p{N}_./+-]+|\*))?$/u;
const TYPE_LABEL_RE = /^type::?[^:]+$/;
const TYPE_NOT_MEASURED = 'Typ-Achse nicht messbar';

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : '');
/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Coerce one tracker issue into the shape the checks read; odd or missing
 * fields become empty values. Returns null when there is no usable iid.
 *
 * @param {any} raw
 */
function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const iid = Number(raw.iid);
  if (!Number.isInteger(iid)) return null;
  const tasks = raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {};
  const count = num(tasks.count);
  const completed = Math.min(num(tasks.completed), count);
  const rawLabels = Array.isArray(raw.labels) ? raw.labels.filter((l) => typeof l === 'string') : [];
  const labels = normalizedLabelSet(rawLabels);
  return {
    iid,
    projectId: num(raw.project_id),
    title: str(raw.title),
    description: str(raw.description),
    url: str(raw.web_url),
    labels,
    rawLabels,
    createdMs: Date.parse(str(raw.created_at)),
    closedMs: Date.parse(str(raw.closed_at)),
    tasks: { count, completed, unchecked: count - completed },
    mrCount: typeof raw.merge_requests_count === 'number' ? raw.merge_requests_count : null,
  };
}

/**
 * Family and value of a normalized label, or null when it belongs to none.
 *
 * @param {string} label normalized label
 * @returns {{ family: string, value: string } | null}
 */
function familyOf(label) {
  const i = label.indexOf(':');
  if (i > 0) {
    const prefix = label.slice(0, i);
    return { family: FAMILY_ALIASES.get(prefix) ?? prefix, value: label.slice(i + 1) };
  }
  if (BARE_TYPE_LABELS.has(label)) return { family: 'type', value: label };
  return null;
}

/** @param {Set<string>} labels @param {string} family */
function labelsOfFamily(labels, family) {
  return [...labels].filter((l) => familyOf(l)?.family === family);
}

/** Description with fenced code blocks removed (line structure kept). */
function stripFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      out.push('');
    } else if (m) {
      fence = m[1];
      out.push('');
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** @param {string} cell */
const axisName = (cell) => cell.replace(/^(\*\*|__)(.+)\1$/, '$2').trim();

/** @param {string} markdown */
function declaredLabelAxes(markdown) {
  // Ceiling (BV-004): an unescaped pipe splits cells even inside backticks.
  // Revisit when a committed taxonomy rule needs a pipe in a backticked label.
  const rows = stripFences(markdown).split('\n').map((line) =>
    line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim()),
  );
  let axes = null;
  for (let index = 0; index < rows.length; index++) {
    const cells = rows[index];
    if (cells.length < 2) {
      if (axes) break;
      continue;
    }
    const name = axisName(cells[0]);
    const next = rows[index + 1];
    if (next?.length === cells.length && next.every((cell) => TABLE_DELIMITER_RE.test(cell))) {
      if (axes) break;
      if (name.toLowerCase() === 'achse') axes = [];
      index++;
      continue;
    }
    if (!axes || !name) continue;
    const labels = [...cells[1].matchAll(/`([^`]+)`/g)]
      .map(([, label]) => label)
      .filter((label) => LABEL_TOKEN_RE.test(label));
    axes.push({ name, labels: [...new Set(labels)] });
  }
  return axes;
}

/** Text inside fences and inline code spans. */
function codeText(text) {
  const parts = [];
  let fence = null;
  const prose = [];
  for (const line of text.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      else parts.push(line);
    } else if (m) {
      fence = m[1];
    } else {
      prose.push(line);
    }
  }
  for (const span of prose.join('\n').matchAll(/(`+)([^`]+?)\1/g)) parts.push(span[2]);
  return parts.join('\n');
}

/**
 * Local `#N` references outside fenced code, with their position.
 *
 * @param {string} text fence-stripped description
 * @returns {{ iid: number, index: number }[]}
 */
function localRefsWithIndex(text) {
  return [...text.matchAll(LOCAL_REF_RE)].map((m) => ({ iid: Number(m[1]), index: m.index }));
}

/** @param {any} mr @param {ReturnType<typeof normalizeIssue>} issue */
function titleIdentifiesIssue(mr, issue) {
  const projectId = num(mr.project_id);
  if (projectId && issue.projectId && projectId !== issue.projectId) return false;
  const title = str(mr.title).trim().replace(/\s+/g, ' ').toLowerCase();
  const issueTitle = issue.title.trim().replace(/\s+/g, ' ').toLowerCase();
  return title !== '' &&
    (title === issueTitle || localRefsWithIndex(title).some((ref) => ref.iid === issue.iid));
}

/**
 * Dependency targets: a dependency phrase followed within 40 characters by a
 * local `#N` reference (the reference must start inside that window).
 *
 * @param {string} text fence-stripped description
 * @returns {{ phrase: string, iid: number }[]}
 */
function dependencies(text) {
  const refs = localRefsWithIndex(text);
  const out = [];
  for (const m of text.matchAll(DEPENDENCY_RE)) {
    const end = m.index + m[0].length;
    for (const r of refs) {
      if (r.index >= end && r.index <= end + 40) out.push({ phrase: m[0], iid: r.iid });
    }
  }
  return out;
}

/** Title prefix for clustering, or '' when the title has none. */
function clusterPrefix(title) {
  const i = title.indexOf(':');
  if (i <= 0) return '';
  return title
    .slice(0, i)
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Linear-interpolated quantile of a sorted array (null when empty). */
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const v = sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  return Math.round(v * 10) / 10;
}

const isEpic = (issue) =>
  issue.labels.has('epic') || issue.labels.has('type:epic') || EPIC_TITLE_RE.test(issue.title);

/**
 * Select the `status:review` issues whose related merge requests the caller
 * should look up. Over `max` → nothing is looked up and `capped` is true, so
 * both `status.review-*` checks report `not-measured` (reason `lookup-cap`).
 *
 * @param {{ open: unknown[], max?: number }} input
 * @returns {{ iids: number[], capped: boolean }}
 */
export function selectMrLookups({ open, max = 50 }) {
  const iids = (Array.isArray(open) ? open : [])
    .map(normalizeIssue)
    .filter((i) => i && i.labels.has('status:review'))
    .map((i) => i.iid);
  const limit = typeof max === 'number' && Number.isFinite(max) ? max : 50;
  if (iids.length > limit) return { iids: [], capped: true };
  return { iids, capped: false };
}

/**
 * Evaluate a backlog against every check of docs/backlog-refinement.md.
 *
 * @param {object} input
 * @param {unknown[]} input.open normalized open issues
 * @param {unknown[]} input.closed normalized closed issues (closed inside the window)
 * @param {ReturnType<typeof import('./fetch.mjs').fetchRelatedMrs>} [input.relatedMrs]
 * @param {boolean} [input.mrLookupCapped]
 * @param {Date|number|string} input.now
 * @param {number} [input.closedDays] window in days (default 30)
 * @param {number} [input.newestIid] iid of the project's newest issue across all states
 * @param {string|null} [input.taxonomyMarkdown] committed taxonomy rule, or null if unavailable.
 *   A null or omitted value uses the legacy type heuristic.
 * @returns {{ population: object, taxonomy: object, checks: object[], findings: object[], metrics: object, epics: object[] }}
 */
export function evaluateBacklog({
  open,
  closed,
  relatedMrs,
  mrLookupCapped = false,
  now,
  closedDays = 30,
  newestIid,
  taxonomyMarkdown,
}) {
  const nowMs =
    now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(str(now));
  const openIssues = (Array.isArray(open) ? open : []).map(normalizeIssue).filter(Boolean);
  const windowStart = nowMs - num(closedDays) * DAY_MS;
  // fetch.mjs already filters the window; re-filter defensively but keep
  // issues whose closed_at cannot be parsed (no evidence they fall outside).
  const closedIssues = (Array.isArray(closed) ? closed : [])
    .map(normalizeIssue)
    .filter(
      (i) =>
        i && (Number.isNaN(i.closedMs) || Number.isNaN(windowStart) || i.closedMs >= windowStart),
    );
  const openIids = new Set(openIssues.map((i) => i.iid));
  const mrMap = relatedMrs instanceof Map ? relatedMrs : new Map();

  // ---- taxonomy -------------------------------------------------------
  const useTypeHeuristic = typeof taxonomyMarkdown !== 'string';
  const axes = useTypeHeuristic ? null : declaredLabelAxes(taxonomyMarkdown);
  const declared = axes && new Set(axes.flatMap(({ labels }) => labels
    .filter((label) => label.includes(':'))
    .map((label) => familyOf(normalizeLabel(label)).family)));
  const typeRows = axes?.filter(({ name }) => /^(typ|type)$/i.test(name));
  const typeLabels = new Set(typeRows?.length === 1
    ? typeRows[0].labels.filter((label) => !label.endsWith(':*'))
    : []);
  const typeNotMeasured = !useTypeHeuristic && typeLabels.size === 0;
  const matchesType = (label) => TYPE_LABEL_RE.test(label) || typeLabels.has(label);

  const famIssues = new Map(); // family -> Set(iid) over open issues
  const famLabels = new Map(); // family -> Set(label) over open issues
  const recordFamily = (family, label, iid) => {
    if (!famIssues.has(family)) famIssues.set(family, new Set());
    if (!famLabels.has(family)) famLabels.set(family, new Set());
    famIssues.get(family).add(iid);
    famLabels.get(family).add(label);
  };
  for (const issue of openIssues) {
    for (const label of issue.labels) {
      const family = familyOf(label)?.family;
      if (family && (family !== 'type' || useTypeHeuristic)) recordFamily(family, label, issue.iid);
    }
    if (typeLabels.size > 0) {
      for (const label of issue.rawLabels) {
        if (matchesType(label)) recordFamily('type', label, issue.iid);
      }
    }
  }
  const threshold = Math.max(5, 0.1 * openIssues.length);
  const familyNames = new Set(['priority', 'type', 'status', ...famIssues.keys(), ...(declared ?? [])]);
  const families = Object.fromEntries([...familyNames].map((name) => {
    if (name === 'type' && typeNotMeasured) return [name, { used: false }];
    const issues = famIssues.get(name)?.size ?? 0;
    const used = name === 'type' && typeLabels.size > 0
      ? true
      : declared ? declared.has(name) : issues >= threshold;
    return [name, {
      used,
      issues,
      labels: [...(famLabels.get(name) ?? [])].sort(),
    }];
  }));
  const used = (family) => families[family]?.used === true;

  const spellings = new Map(); // "family\0value" -> Set(label) over open + closed
  const labelUse = new Map(); // label -> number of issues carrying it (open + closed)
  for (const issue of [...openIssues, ...closedIssues]) {
    for (const l of issue.labels) {
      const f = familyOf(l);
      if (!f) continue;
      const key = `${f.family}\0${f.value}`;
      if (!spellings.has(key)) spellings.set(key, new Set());
      spellings.get(key).add(l);
      labelUse.set(l, (labelUse.get(l) ?? 0) + 1);
    }
  }
  const duplicateSpellings = [];
  // minority spelling -> the spelling the repository uses most for the same
  // family and value. Only the minority side is a finding: flagging the
  // prevailing spelling too fired on 102 of 196 issues (measured 2026-11-14).
  const duplicateOf = new Map();
  for (const [key, set] of spellings) {
    if (set.size < 2) continue;
    const [family, value] = key.split('\0');
    const labels = [...set].sort();
    duplicateSpellings.push({ family, value, labels });
    const top = Math.max(...labels.map((l) => labelUse.get(l)));
    const leaders = labels.filter((l) => labelUse.get(l) === top);
    if (leaders.length !== 1) continue; // a tie has no prevailing spelling: listed above, no finding
    for (const l of labels) if (l !== leaders[0]) duplicateOf.set(l, leaders[0]);
  }
  duplicateSpellings.sort((a, b) =>
    `${a.family}:${a.value}`.localeCompare(`${b.family}:${b.value}`),
  );

  // ---- scopes ----------------------------------------------------------
  const ready = openIssues.filter((i) => i.labels.has('status:ready'));
  const review = openIssues.filter((i) => i.labels.has('status:review'));
  const blocked = openIssues.filter((i) => i.labels.has('status:blocked'));
  const epicIssues = openIssues.filter(isEpic).sort((a, b) => a.iid - b.iid);
  const nonEpic = openIssues.filter((i) => !isEpic(i));

  const findings = [];
  const fired = new Map(CHECKS.map((c) => [c.id, 0]));
  const add = (check, severity, issue, detail) => {
    findings.push({ check, severity, iid: issue.iid, title: issue.title, url: issue.url, detail });
    fired.set(check, fired.get(check) + 1);
  };

  // ---- labels ------------------------------------------------------------
  for (const issue of openIssues) {
    if (used('priority') && labelsOfFamily(issue.labels, 'priority').length === 0) {
      add('label.priority-missing', 'warn', issue, 'no priority label');
    }
    if (used('type')) {
      const hasType = useTypeHeuristic
        ? labelsOfFamily(issue.labels, 'type').length > 0
        : issue.rawLabels.some(matchesType);
      if (!hasType) add('label.type-missing', 'warn', issue, 'no type label');
    }
    if (used('status')) {
      const status = labelsOfFamily(issue.labels, 'status');
      const ageDays = (nowMs - issue.createdMs) / DAY_MS;
      if (status.length === 0 && ageDays > 7) {
        add(
          'label.status-missing',
          'warn',
          issue,
          `no status label; ${Math.floor(ageDays)} days old`,
        );
      }
      if (status.length > 1) {
        add('label.status-multiple', 'warn', issue, `status labels: ${status.sort().join(', ')}`);
      }
    }
    const dups = [...issue.labels].filter((l) => duplicateOf.has(l)).sort();
    if (dups.length > 0) {
      const detail = dups
        .map((l) => `${l}: the repository mostly uses ${duplicateOf.get(l)}`)
        .join('; ');
      add('label.duplicate-spelling', 'info', issue, detail);
    }
  }

  // ---- readiness -------------------------------------------------------
  if (used('status')) {
    for (const issue of ready) {
      const d = issue.description;
      if (!ACCEPTANCE_RE.test(d) && !CHECKBOX_RE.test(d) && issue.tasks.count === 0) {
        add('ready.no-acceptance', 'warn', issue, 'no acceptance phrase or task-list checkbox');
      }
      if (!hasPathToken(d) && !SOURCE_DIR_RE.test(d) && !URL_RE.test(d)) {
        add('ready.no-pointer', 'warn', issue, 'no file path or URL');
      }
      if (!COMMAND_RE.test(codeText(d)) && !TEST_FILE_RE.test(d)) {
        add('ready.no-verification', 'info', issue, 'no command in code and no test file named');
      }
      const q = OPEN_QUESTION_CS_RE.exec(d) ?? OPEN_QUESTION_CI_RE.exec(d);
      if (q) add('ready.open-question', 'info', issue, `contains "${q[0]}"`);
    }
  }

  // ---- size ----------------------------------------------------------------
  for (const issue of nonEpic) {
    const signals = [];
    if (issue.tasks.unchecked >= 8) signals.push(`${issue.tasks.unchecked} unchecked items`);
    const marker = SIZE_TITLE_RE.exec(issue.title);
    if (marker) signals.push(`title marker "${marker[0]}"`);
    if (issue.description.length > 6000)
      signals.push(`description ${issue.description.length} chars`);
    const appetite = ['appetite:2w', 'appetite:6w'].find((l) => issue.labels.has(l));
    if (appetite) signals.push(`label ${appetite}`);
    if (signals.length >= 2) {
      const severity = used('status') && issue.labels.has('status:ready') ? 'warn' : 'info';
      add('size.too-big', severity, issue, signals.join('; '));
    }
  }

  // ---- dependencies and status ---------------------------------------------
  const strippedOf = new Map();
  const stripped = (issue) => {
    if (!strippedOf.has(issue.iid)) strippedOf.set(issue.iid, stripFences(issue.description));
    return strippedOf.get(issue.iid);
  };
  // The newest issue is latest by created_at, not necessarily the maximum iid.
  // Bound references by its iid and all loaded iids; absent metadata preserves
  // the loaded-only bound. Higher numbers are treated as other tracker refs.
  const maxIid = Math.max(
    Number.isSafeInteger(newestIid) && newestIid >= 0 ? newestIid : 0,
    ...openIssues.map((i) => i.iid),
    ...closedIssues.map((i) => i.iid),
  );
  const refsCache = new Map();
  const refsOf = (issue) => {
    if (!refsCache.has(issue)) {
      const refs = new Set(
        localRefsWithIndex(stripped(issue))
          .map((r) => r.iid)
          .filter((n) => n <= maxIid),
      );
      refs.delete(issue.iid);
      refsCache.set(issue, [...refs]);
    }
    return refsCache.get(issue);
  };

  for (const issue of openIssues) {
    const seen = new Set();
    const closedDeps = [];
    for (const dep of dependencies(stripped(issue))) {
      if (dep.iid === issue.iid || dep.iid > maxIid || openIids.has(dep.iid) || seen.has(dep.iid))
        continue;
      seen.add(dep.iid);
      closedDeps.push(`${dep.phrase} #${dep.iid} (not open)`);
    }
    if (closedDeps.length > 0) add('link.dependency-closed', 'warn', issue, closedDeps.join('; '));
  }

  if (used('status')) {
    for (const issue of blocked) {
      const refs = refsOf(issue);
      if (refs.length > 0 && !refs.some((n) => openIids.has(n))) {
        add(
          'status.blocked-refs-closed',
          'info',
          issue,
          `no referenced issue open: ${refs.map((n) => `#${n}`).join(', ')}`,
        );
      }
    }
  }

  let reviewUnmeasured = 0;
  let closingUnmeasured = 0;
  if (used('status') && !mrLookupCapped) {
    for (const issue of review) {
      const entry = mrMap.get(issue.iid);
      if (!entry || entry.state !== 'measured' || !Array.isArray(entry.mrs)) {
        reviewUnmeasured += 1;
        continue;
      }
      const titleMatches = entry.mrs.filter((mr) => mr?.state === 'merged' && titleIdentifiesIssue(mr, issue));
      const merged = new Set(
        [...(entry.closedBy ?? []), ...titleMatches]
          .filter((mr) => mr?.state === 'merged' && Number.isSafeInteger(mr.iid) && mr.iid > 0)
          .map((mr) => mr.iid),
      );
      if (merged.size > 0) {
        add(
          'status.review-mr-merged',
          'warn',
          issue,
          `merged MR ${[...merged].map((iid) => `!${iid}`).join(', ')}`,
        );
      } else {
        if (entry.closedBy === null) closingUnmeasured += 1;
        if (entry.mrs.length === 0)
          add('status.review-no-mr', 'info', issue, 'no related merge request');
      }
    }
  }

  // ---- epics ---------------------------------------------------------------
  const epics = [];
  const childOfEpic = new Set();
  for (const epic of epicIssues) {
    const children = new Set(refsOf(epic));
    for (const other of [...openIssues, ...closedIssues]) {
      if (other.iid !== epic.iid && refsOf(other).includes(epic.iid)) children.add(other.iid);
    }
    children.delete(epic.iid);
    const sorted = [...children].sort((a, b) => a - b);
    const openChildren = sorted.filter((n) => openIids.has(n));
    const closedChildren = sorted.filter((n) => !openIids.has(n));
    for (const n of sorted) childOfEpic.add(n);
    epics.push({
      iid: epic.iid,
      title: epic.title,
      open_children: openChildren,
      closed_children: closedChildren,
    });
    if (sorted.length === 0)
      add('epic.no-children', 'info', epic, 'no child issue references or is referenced');
    else if (openChildren.length === 0) {
      add('epic.all-children-closed', 'warn', epic, `all ${closedChildren.length} children closed`);
    }
  }

  const clusters = new Map();
  for (const issue of nonEpic) {
    const prefix = clusterPrefix(issue.title);
    if (!prefix) continue;
    if (!clusters.has(prefix)) clusters.set(prefix, []);
    clusters.get(prefix).push(issue);
  }
  for (const [prefix, members] of [...clusters].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length < 5 || members.some((m) => childOfEpic.has(m.iid))) continue;
    const ordered = [...members].sort((a, b) => {
      const ca = Number.isNaN(a.createdMs) ? Infinity : a.createdMs;
      const cb = Number.isNaN(b.createdMs) ? Infinity : b.createdMs;
      return ca - cb || a.iid - b.iid;
    });
    const iids = [...members].map((m) => m.iid).sort((a, b) => a - b);
    add(
      'epic.candidate-cluster',
      'info',
      ordered[0],
      `${members.length} open issues share prefix "${prefix}": ${iids.map((n) => `#${n}`).join(', ')}`,
    );
  }

  // ---- closed --------------------------------------------------------------
  for (const issue of closedIssues) {
    const status = labelsOfFamily(issue.labels, 'status');
    if (status.length > 0)
      add('closed.status-label-left', 'warn', issue, `still labelled ${status.sort().join(', ')}`);
    if (issue.tasks.completed > 0 && issue.tasks.unchecked > 0) {
      add(
        'closed.partly-checked',
        'info',
        issue,
        `${issue.tasks.completed} of ${issue.tasks.count} items checked`,
      );
    }
  }

  // ---- check rows ----------------------------------------------------------
  const scopeSize = {
    'size.too-big': nonEpic.length,
    'epic.candidate-cluster': nonEpic.length,
  };
  const sizeOf = {
    open: openIssues.length,
    ready: ready.length,
    review: review.length,
    blocked: blocked.length,
    epic: epicIssues.length,
    closed: closedIssues.length,
  };
  const checks = CHECKS.map((c) => {
    const row = { id: c.id, scope: c.scope, severity: c.severity };
    if (c.family === 'type' && typeNotMeasured)
      return { ...row, state: 'not-measured', reason: TYPE_NOT_MEASURED };
    if (c.family && !used(c.family))
      return { ...row, state: 'not-measured', reason: 'family-not-used' };
    if (c.mr && mrLookupCapped) return { ...row, state: 'not-measured', reason: 'lookup-cap' };
    const of = scopeSize[c.id] ?? sizeOf[c.scope];
    const n = fired.get(c.id);
    const measured = { ...row, state: 'measured', fired: n, of, noisy: of >= 10 && n / of > 0.3 };
    if (c.mr) {
      const unmeasured = reviewUnmeasured + (c.id === 'status.review-mr-merged' ? closingUnmeasured : 0);
      if (unmeasured > 0) measured.unmeasured = unmeasured;
    }
    return measured;
  });

  const rank = { warn: 0, info: 1 };
  findings.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] || a.check.localeCompare(b.check) || a.iid - b.iid,
  );

  // ---- metrics -------------------------------------------------------------
  const ages = openIssues
    .filter((i) => !Number.isNaN(i.createdMs))
    .map((i) => Math.max(0, Math.floor((nowMs - i.createdMs) / DAY_MS)))
    .sort((a, b) => a - b);
  const warnIids = new Set(findings.filter((f) => f.severity === 'warn').map((f) => f.iid));
  const inProgress = openIssues.filter(
    (i) => i.labels.has('status:in-progress') || i.labels.has('status:in_progress'),
  );
  const metrics = {
    ready: ready.length,
    in_progress: inProgress.length,
    review: review.length,
    blocked: blocked.length,
    age_days: {
      q1: quantile(ages, 0.25),
      median: quantile(ages, 0.5),
      q3: quantile(ages, 0.75),
      max: ages.length ? ages[ages.length - 1] : null,
    },
    older_than_90_days: ages.filter((a) => a > 90).length,
    // null, not 0, when readiness was not measured (status family unused).
    ready_clean: used('status') ? ready.filter((i) => !warnIids.has(i.iid)).length : null,
    closed_all_unchecked: closedIssues.filter((i) => i.tasks.count > 0 && i.tasks.completed === 0)
      .length,
    closed_without_mr: closedIssues.filter((i) => i.mrCount === 0).length,
  };

  return {
    population: { open: openIssues.length, closed_in_window: closedIssues.length },
    taxonomy: {
      families,
      duplicate_spellings: duplicateSpellings,
      ...(axes && { axes }),
      ...(typeLabels.size > 0 && { type_labels: [...typeLabels] }),
    },
    checks,
    findings,
    metrics,
    epics,
  };
}
