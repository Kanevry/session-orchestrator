/** Pure audit of explicitly complete, caller-supplied fleet snapshots (#1462). */
import { validateCheckin } from './fleet-protocol.mjs';

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const FRESHNESS_MS = 15 * 60 * 1000;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.length > 0 && v.trim() === v;

// Require an unambiguous UTC instant and reject Date.parse's calendar rollover.
function instant(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)) return NaN;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v.replace(/Z$/, v.includes('.') ? 'Z' : '.000Z') ? ms : NaN;
}

/** Canonical issue IID, preserving the existing integer/string check-in contract. */
export function normalizeCandidate(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^#?\d{1,9}$/.test(value)) return null;
  return String(Number(value.replace(/^#/, '')));
}

const measurement = (value, reasons) => ({
  status: reasons.length ? 'not-measurable' : 'measured',
  value: reasons.length ? null : value,
  reasons: [...new Set(reasons)],
});

function snapshotProblems(snapshot, name, at) {
  const reasons = [];
  if (!object(snapshot)) return [`${name}:missing-snapshot`];
  if (snapshot.version !== 1) reasons.push(`${name}:unsupported-version`);
  if (snapshot.complete !== true) reasons.push(`${name}:incomplete-population`);
  if (!Array.isArray(snapshot.records)) reasons.push(`${name}:missing-records`);
  if (!Number.isFinite(instant(snapshot.captured_at)) || instant(snapshot.captured_at) !== at) {
    reasons.push(`${name}:capture-time-mismatch`);
  }
  return reasons;
}

function bindRepos(bindings, issues) {
  const keys = new Set();
  const hashes = new Map();
  const names = new Map();
  const reasons = [];
  const fail = (index, code) => {
    issues.push({ source: 'bindings', index, code });
    reasons.push(`bindings:${code}`);
  };
  if (!Array.isArray(bindings)) {
    fail(null, 'missing-bindings');
    return { keys, hashes, names, reasons };
  }
  const insert = (map, value, key, index) => {
    if (map.has(value)) fail(index, 'duplicate-identity');
    else map.set(value, key);
  };
  bindings.forEach((binding, index) => {
    if (!object(binding) || !text(binding.repo_key)
      || !Array.isArray(binding.registry_hashes) || binding.registry_hashes.length === 0
      || !binding.registry_hashes.every((v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
      || !Array.isArray(binding.checkin_repos) || binding.checkin_repos.length === 0
      || !binding.checkin_repos.every(text)) {
      fail(index, 'invalid-binding');
      return;
    }
    if (keys.has(binding.repo_key)) fail(index, 'duplicate-repo-key');
    keys.add(binding.repo_key);
    binding.registry_hashes.forEach((v) => insert(hashes, v, binding.repo_key, index));
    binding.checkin_repos.forEach((v) => insert(names, v, binding.repo_key, index));
  });
  return { keys, hashes, names, reasons };
}

// A session is identified by (id, resolved repo), not the id alone: the semantic
// id `main-<date>-session-<n>` repeats across repos (#1843). Rows with an
// unresolved repo share the `null` key, so equal ids among them stay duplicates.
function duplicates(rows, field, source, issues) {
  const key = (row) => JSON.stringify([row.record?.[field], row.repo ?? null]);
  const counts = new Map();
  for (const row of rows) {
    if (text(row.record?.[field])) counts.set(key(row), (counts.get(key(row)) || 0) + 1);
  }
  for (const row of rows) {
    if (counts.get(key(row)) > 1) {
      row.ambiguous = true;
      issues.push({ source, index: row.index, code: 'duplicate-session' });
    }
  }
}

const usable = (row) => row.errors.length === 0 && !row.ambiguous;
function summarize(rows, present) {
  if (!present) return { raw: null, valid: null, invalid: null, ambiguous: null, stale: null };
  return {
    raw: rows.length,
    valid: rows.filter(usable).length,
    invalid: rows.filter((row) => row.errors.length > 0).length,
    ambiguous: rows.filter((row) => row.ambiguous).length,
    stale: rows.filter((row) => usable(row) && row.stale).length,
  };
}

/**
 * No filesystem, clock, environment, or input mutation. Repo bindings and history
 * completeness are assertions of the caller, never independently discovered.
 * @param {{registry?: object, checkins?: object, repos?: string[], at?: string}} input
 */
export function auditCheckins({ registry, checkins, repos, at } = {}) {
  const now = instant(at);
  const issues = [];
  const common = [];
  if (!Number.isFinite(now)) common.push('audit:invalid-measurement-time');
  const binding = bindRepos(registry?.repo_bindings, issues);
  common.push(...binding.reasons);
  if (!Array.isArray(repos) || repos.length === 0 || !repos.every(text)
    || new Set(repos).size !== repos.length) common.push('audit:invalid-repo-selection');
  const selected = new Set(Array.isArray(repos) ? repos : []);
  if ([...selected].some((repo) => !binding.keys.has(repo))) common.push('audit:unknown-selected-repo');

  const registryReasons = [...common, ...snapshotProblems(registry, 'registry', now)];
  const checkinReasons = [...snapshotProblems(checkins, 'checkins', now)];
  const registryRows = (Array.isArray(registry?.records) ? registry.records : []).map((record, index) => {
    const errors = [];
    if (!object(record) || !text(record.session_id) || /[\\/]/.test(record.session_id) || record.session_id.includes('\x00')
      || record.session_id === '.' || record.session_id === '..'
      || ('mode' in record && record.mode !== null && typeof record.mode !== 'string')
      || ('role' in record && record.role !== null && typeof record.role !== 'string')) errors.push('invalid-registry-record');
    const repo = binding.hashes.get(record?.repo_path_hash);
    if (!repo) errors.push('unknown-repo-identity');
    const start = instant(record?.started_at);
    const heartbeat = instant(record?.last_heartbeat);
    if (!Number.isFinite(start) || !Number.isFinite(heartbeat) || start > heartbeat || heartbeat > now) errors.push('invalid-registry-time');
    return { record, index, repo, start, heartbeat, errors, ambiguous: false, stale: now - heartbeat > FRESHNESS_MS };
  });
  duplicates(registryRows, 'session_id', 'registry', issues);
  for (const row of registryRows) {
    for (const code of row.errors) issues.push({ source: 'registry', index: row.index, code });
    if (!usable(row)) registryReasons.push('registry:invalid-or-ambiguous-records');
  }
  const checkinRows = (Array.isArray(checkins?.records) ? checkins.records : []).map((record, index) => {
    const errors = validateCheckin(record).length ? ['invalid-checkin-record'] : [];
    const repo = binding.names.get(record?.repo);
    if (!repo) errors.push('unknown-repo-identity');
    const time = instant(record?.zeit);
    if (!Number.isFinite(time) || time > now) errors.push('invalid-checkin-time');
    const candidates = Array.isArray(record?.kandidaten) ? record.kandidaten.map(normalizeCandidate) : [];
    if (candidates.includes(null)) errors.push('invalid-candidate');
    const matches = registryRows.filter((r) => usable(r) && r.record.session_id === record?.session && r.repo === repo);
    if (matches.length !== 1) errors.push('unmatched-session-identity');
    else if (time < matches[0].start) errors.push('checkin-before-registration');
    return { record, index, repo, time, candidates, errors, ambiguous: false, registry: matches[0], stale: false };
  });
  duplicates(checkinRows, 'session', 'checkins', issues);
  for (const row of checkinRows) {
    for (const code of row.errors) issues.push({ source: 'checkins', index: row.index, code });
    if (!usable(row)) checkinReasons.push('checkins:invalid-or-ambiguous-records');
  }

  const population = registryRows.filter((row) => usable(row) && selected.has(row.repo));
  const fresh = population.filter((row) => !row.stale);
  const due = fresh.filter((row) => now - row.start >= THIRTY_MINUTES_MS);
  const missing = due.filter((row) => !checkinRows.some((c) => usable(c) && c.registry === row));
  const pointReasons = [...registryReasons, ...checkinReasons];

  const coverage = checkins?.coverage;
  const historyReasons = [...pointReasons];
  const from = instant(coverage?.from);
  const to = instant(coverage?.to);
  if (!object(coverage) || coverage.complete !== true || !Number.isFinite(from)
    || !Number.isFinite(to) || from >= to || to > now) historyReasons.push('history:missing-or-invalid-coverage');
  if (!Array.isArray(checkins?.claims)) historyReasons.push('history:missing-claims');
  const claims = (Array.isArray(checkins?.claims) ? checkins.claims : []).map((claim, index) => {
    const errors = [];
    const start = instant(claim?.from);
    const end = instant(claim?.to);
    const candidate = normalizeCandidate(claim?.candidate);
    if (!object(claim) || !text(claim.session) || !text(claim.repo_key)
      || !text(claim.evidence_ref) || candidate === null) errors.push('invalid-claim');
    const matches = checkinRows.filter((c) => usable(c) && c.record.session === claim?.session
      && c.repo === claim?.repo_key && c.candidates.includes(candidate));
    if (matches.length !== 1) errors.push('unmatched-claim-identity');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > now
      || start < from || end > to || (matches.length === 1 && start < matches[0].time)) errors.push('invalid-claim-interval');
    for (const code of errors) issues.push({ source: 'claims', index, code });
    if (errors.length) historyReasons.push('history:invalid-claims');
    return { index, session: claim?.session, repo_key: claim?.repo_key, candidate, from: start, to: end, errors };
  });
  // Repeated/overlapping evidence for one session is ambiguous; do not multiply
  // collision counts by silently treating those claims as independent starts.
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]; const b = claims[j];
      if (!a.errors.length && !b.errors.length && a.session === b.session
        && a.repo_key === b.repo_key && a.candidate === b.candidate
        && Math.max(a.from, b.from) < Math.min(a.to, b.to)) {
        historyReasons.push('history:duplicate-overlapping-claims');
        issues.push({ source: 'claims', index: b.index, code: 'duplicate-overlapping-claims' });
      }
    }
  }
  const collisions = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]; const b = claims[j];
      if (!a.errors.length && !b.errors.length && a.session !== b.session
        && selected.has(a.repo_key) && a.repo_key === b.repo_key && a.candidate === b.candidate
        && Math.max(a.from, b.from) < Math.min(a.to, b.to)) {
        collisions.push({ repo_key: a.repo_key, candidate: a.candidate, sessions: [a.session, b.session],
          from: new Date(Math.max(a.from, b.from)).toISOString(), to: new Date(Math.min(a.to, b.to)).toISOString() });
      }
    }
  }
  const currentCandidates = [];
  for (const row of checkinRows.filter((c) => usable(c) && selected.has(c.repo) && !c.registry.stale)) {
    for (const candidate of new Set(row.candidates)) {
      currentCandidates.push({ repo_key: row.repo, session: row.record.session, candidate });
    }
  }
  const metrics = {
    selected: measurement(population.length, registryReasons),
    fresh: measurement(fresh.length, registryReasons),
    due: measurement(due.length, registryReasons),
    missing_after_30m: measurement(missing.length, pointReasons),
    collisions: measurement(collisions.length, historyReasons),
  };
  return {
    version: 1,
    status: Object.values(metrics).every((metric) => metric.status === 'measured') ? 'measured' : 'not-measurable',
    at: typeof at === 'string' ? at : null,
    repos: [...selected],
    snapshots: {
      registry: summarize(registryRows, Array.isArray(registry?.records)),
      checkins: summarize(checkinRows, Array.isArray(checkins?.records)),
    },
    metrics,
    coverage: historyReasons.includes('history:missing-or-invalid-coverage') ? null : {
      complete: true, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    },
    issues,
    findings: {
      missing_sessions: pointReasons.length ? [] : missing.map((row) => ({ repo_key: row.repo, session: row.record.session_id })),
      collisions: historyReasons.length ? [] : collisions,
      current_candidates: pointReasons.length ? [] : currentCandidates,
    },
  };
}
