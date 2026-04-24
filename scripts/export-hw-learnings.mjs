#!/usr/bin/env node
/**
 * export-hw-learnings.mjs — anonymize + render hardware-pattern learnings.
 *
 * Part of Sub-Epic #160 / Epic #157 v3.1.0 (C3). Issue #172.
 *
 * Reads `.orchestrator/metrics/learnings.jsonl`, filters to
 * `type: hardware-pattern AND scope: public`, anonymizes per the hard
 * requirements in issue #172, and writes a human-readable markdown doc to
 * `docs/telemetry/hardware-patterns.md`.
 *
 * Idempotent: running without new data rewrites the same file byte-for-byte
 * modulo the generated-at line.
 *
 * ## Anonymization pipeline (enforced; no opt-out)
 *
 * - Strip all absolute paths (macOS, Linux system paths, Windows)
 * - Redact IPv4 addresses
 * - Redact GitHub/GitLab URLs containing org/repo paths
 * - Replace hostname references with `host_class` label
 * - Redact email, git author, token patterns
 * - No free-form text from user — only structured fields
 * - Round ram/cpu to 1 GB / 10% buckets
 *
 * ## Invocation
 *
 *   node scripts/export-hw-learnings.mjs                # default paths
 *   node scripts/export-hw-learnings.mjs --dry-run      # emit to stdout, no write
 *   node scripts/export-hw-learnings.mjs --input X --output Y
 *   node scripts/export-hw-learnings.mjs --promote      # promote private→public + render
 *   node scripts/export-hw-learnings.mjs --promote --dry-run  # promote without writing
 *
 * npm script: `npm run share:hw-learnings`
 */

import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  readLearnings,
  filterByScope,
  filterByType,
  normalizeLearning,
  validateLearning,
  rewriteLearnings,
  CURRENT_ANONYMIZATION_VERSION,
} from './lib/learnings.mjs';

// ---------------------------------------------------------------------------
// Anonymization
// ---------------------------------------------------------------------------

// Unix absolute paths: covers macOS /Users, Linux home dirs, and Linux system
// paths (/root, /var, /opt, /tmp, /mnt, /srv, /etc, /usr, /proc, /run).
// Character class [^\s"'<>]+ after the root prefix captures path components
// including @, +, ~, spaces are explicitly excluded as path terminators.
const UNIX_PATH_RE = /(?:\/(?:Users|home|root|var|opt|tmp|mnt|srv|etc|usr|proc|run))[/A-Za-z0-9._@+~-][^\s"'<>]*/g;

// Windows paths: both backslash (`C:\Program Files\...`) and forward-slash
// normalized variants (`C:/Users/foo`). Spaces allowed in path components.
const WIN_PATH_RE = /[A-Z]:[/\\][^\s"'<>]*/g;

const ABS_PATH_RES = [UNIX_PATH_RE, WIN_PATH_RE];

// IPv4 address: four dot-separated octets, word-boundary anchored.
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

// GitHub / GitLab URLs that expose an org/repo path. Redact the full URL to
// avoid leaking username or private repo names. The pattern matches
// https://(github|gitlab).<tld>/<org>/<repo> (with optional trailing path).
const VCS_URL_RE = /https?:\/\/(?:github|gitlab)\.[^/\s]+\/[\w.-]+\/[\w.-][^\s"']*/g;

const EMAIL_RE = /[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Token-shape heuristic: base64-ish/hex-ish runs ≥ 20 chars with at least one
// digit and one letter. Intentionally broad — it's better to over-redact.
const TOKEN_RE = /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g;

// Common git-author patterns: "First Last <email@...>" or "Signed-off-by: X"
const GIT_AUTHOR_RE = /\b([A-Z][a-zA-Z-]+ ){1,3}<[^>]+>/g;
const SIGNED_OFF_RE = /Signed-off-by:[^\n]+/g;

// Bare hostname patterns (mDNS / private LAN TLDs that are user-chosen and
// identifying). Keeps `host_class` strings like 'macos-arm64-m3pro' safe —
// those never appear with a .local/.lan/.home suffix.
const HOSTNAME_RE = /\b[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)*\.(?:local|lan|home|internal|corp)\b/g;

/**
 * Scrub a free-form string of PII / host-identifying content.
 * Order matters: author/signoff patterns first (they contain emails), then
 * emails, then paths/IPs/VCS-URLs, then hostnames, then tokens.
 * @param {string} s
 * @returns {string}
 */
export function anonymizeString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  out = out.replace(GIT_AUTHOR_RE, '<redacted-author>');
  out = out.replace(SIGNED_OFF_RE, '<redacted-signoff>');
  out = out.replace(EMAIL_RE, '<redacted-email>');
  // VCS URLs before generic path handling (they start with https://, not a path root)
  out = out.replace(VCS_URL_RE, '<VCS-URL>');
  for (const re of ABS_PATH_RES) out = out.replace(re, '<redacted-path>');
  out = out.replace(IPV4_RE, '<IP>');
  out = out.replace(HOSTNAME_RE, '<redacted-hostname>');
  out = out.replace(TOKEN_RE, '<redacted-token>');
  return out;
}

/**
 * Round to 1 GB bucket (nearest integer).
 */
export function bucketRamGb(gb) {
  if (typeof gb !== 'number' || Number.isNaN(gb)) return null;
  return Math.round(gb);
}

/**
 * Round to 10% bucket.
 */
export function bucketCpuPct(pct) {
  if (typeof pct !== 'number' || Number.isNaN(pct)) return null;
  return Math.round(pct / 10) * 10;
}

/**
 * Anonymize a single learning entry's free-form fields.
 * Drops `source_session` entirely (session IDs are host-correlated).
 * Stamps `anonymized: true` and `anonymization_version` so the result passes
 * the privacy-contract check in `validateLearning` for scope=public entries.
 * @param {object} entry
 * @returns {object} anonymized entry (safe for public export)
 */
export function anonymizeLearning(entry) {
  const e = normalizeLearning(entry);
  const out = {
    ...e,
    insight: anonymizeString(e.insight),
    evidence: anonymizeString(e.evidence),
    // Stamp after redaction so callers that write back through validateLearning
    // do not hit the scope=public contract check.
    anonymized: true,
    anonymization_version: CURRENT_ANONYMIZATION_VERSION,
  };
  // Session IDs contain branch names + timestamps → host-correlated, remove
  delete out.source_session;
  // Round numeric buckets if present in anonymization samples
  if (Array.isArray(out.samples)) {
    out.samples = out.samples.map((s) => ({
      ...s,
      ram_free_gb: bucketRamGb(s.ram_free_gb),
      cpu_load_pct: bucketCpuPct(s.cpu_load_pct),
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Group learnings by host_class, then by signal inside each host.
 * Returns a map keyed on host_class with ordered signal entries.
 */
export function groupByHost(entries) {
  const byHost = new Map();
  for (const e of entries) {
    const host = e.host_class ?? '<unknown>';
    let entry = byHost.get(host);
    if (!entry) {
      entry = { host_class: host, report_count: 0, signals: new Map() };
      byHost.set(host, entry);
    }
    entry.report_count += 1;
    const sig = (e.subject.split('::')[0]) || 'unknown';
    const sigBucket = entry.signals.get(sig) || { signal: sig, items: [] };
    sigBucket.items.push(e);
    entry.signals.set(sig, sigBucket);
  }
  return byHost;
}

/**
 * Render the grouped map as a human-readable markdown document.
 * Deterministic ordering: host_class alphabetical, signals alphabetical within.
 * @param {Map<string, object>} grouped
 * @param {string} generatedAt — ISO 8601 timestamp (caller-provided for determinism in tests)
 * @returns {string} markdown body
 */
export function renderMarkdown(grouped, generatedAt) {
  const lines = [];
  lines.push('# Hardware Pattern Telemetry');
  lines.push('');
  lines.push('> Anonymized community-shared hardware patterns. Generated from opt-in learnings.');
  lines.push('> See CONTRIBUTING.md for how to opt-in / opt-out / inspect before share.');
  lines.push('');
  lines.push(`_Generated: ${generatedAt}_`);
  lines.push('');

  const hosts = Array.from(grouped.keys()).sort();
  if (hosts.length === 0) {
    lines.push('_No public hardware-pattern learnings to report._');
    lines.push('');
    return lines.join('\n');
  }

  for (const host of hosts) {
    const h = grouped.get(host);
    lines.push(`## ${host} (${h.report_count} reports)`);
    lines.push('');
    const signals = Array.from(h.signals.keys()).sort();
    for (const sig of signals) {
      const bucket = h.signals.get(sig);
      const occurrences = bucket.items.reduce((n, e) => {
        const m = /occurrences=(\d+)/.exec(e.evidence || '');
        return n + (m ? parseInt(m[1], 10) : 1);
      }, 0);
      lines.push(`- **${sig}** — ${occurrences} occurrences across ${bucket.items.length} report${bucket.items.length === 1 ? '' : 's'}`);
      for (const item of bucket.items) {
        lines.push(`  - ${item.insight}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    dryRun: false,
    promote: false,
    input: '.orchestrator/metrics/learnings.jsonl',
    output: 'docs/telemetry/hardware-patterns.md',
    generatedAt: new Date().toISOString(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--promote') out.promote = true;
    else if (a === '--input') out.input = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--generated-at') out.generatedAt = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: export-hw-learnings.mjs [--dry-run] [--promote] [--input FILE] [--output FILE]\n' +
        '\n' +
        '  (no flags)       Render already-public hardware-pattern entries to markdown.\n' +
        '  --promote        Anonymize scope=private hardware-pattern entries and promote\n' +
        '                   them to scope=public, then render. Writes back to learnings.jsonl\n' +
        '                   (backup created first). Use with --dry-run to preview.\n' +
        '  --dry-run        Print markdown to stdout; do not write any files.\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Promotion pipeline (Part C)
// ---------------------------------------------------------------------------

/**
 * Promote scope=private hardware-pattern entries to scope=public after
 * anonymization. Creates a twin public entry; the original private entry is
 * preserved. Backs up the JSONL before writing.
 *
 * @param {object} opts
 * @param {string} opts.input — path to learnings.jsonl
 * @param {boolean} opts.dryRun — if true, do not write any files
 * @returns {Promise<{promoted: number, skipped: number, flags: string[]}>}
 */
export async function promoteHwLearnings(opts) {
  const { entries, malformed } = await readLearnings(opts.input);

  const hwPrivate = filterByScope(filterByType(entries, 'hardware-pattern'), 'private');
  const hwPublicExisting = filterByScope(filterByType(entries, 'hardware-pattern'), 'public');

  const flags = [];
  if (malformed.length > 0) {
    flags.push(`${malformed.length} malformed line(s) in learnings.jsonl were skipped`);
  }

  if (hwPrivate.length === 0) {
    return { promoted: 0, skipped: hwPublicExisting.length, flags };
  }

  // Build promoted entries: anonymize + flip scope to public.
  // Validate EACH entry through validateLearning before any write — a contract
  // violation is a fatal error; we do not partial-write.
  const promotedEntries = [];
  for (const e of hwPrivate) {
    const anon = anonymizeLearning(e);
    const candidate = {
      ...anon,
      // anonymizeLearning strips source_session (host-correlated), but
      // validateLearning requires it as a legacy field. Restore a redacted
      // placeholder so the validator accepts the promoted entry.
      source_session: '<redacted>',
      scope: 'public',
      anonymized: true,
      anonymization_version: CURRENT_ANONYMIZATION_VERSION,
    };
    if (!candidate.host_class) {
      throw new Error(
        `Cannot promote learning id=${e.id}: host_class is not set (required for scope=public). ` +
        'Set host_class on the private entry before promoting.'
      );
    }
    // validateLearning throws ValidationError on any contract violation.
    // We let it propagate — no partial writes.
    validateLearning(candidate);
    promotedEntries.push(candidate);
  }

  if (!opts.dryRun) {
    // Backup before rewrite
    if (existsSync(opts.input)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${opts.input}.bak-${ts}`;
      await copyFile(opts.input, backup);
    }

    // Rewrite: all original entries + new public twins appended at the end.
    // Original private entries are preserved (the twin is a new record).
    const allEntries = [...entries, ...promotedEntries];
    await rewriteLearnings(opts.input, allEntries);
  }

  return { promoted: promotedEntries.length, skipped: hwPublicExisting.length, flags };
}

export async function exportHwLearnings(opts) {
  const { entries } = await readLearnings(opts.input);
  const hwPublic = filterByScope(filterByType(entries, 'hardware-pattern'), 'public');
  const anonymized = hwPublic.map((e) => anonymizeLearning(e));
  const grouped = groupByHost(anonymized);
  const md = renderMarkdown(grouped, opts.generatedAt);
  if (!opts.dryRun) {
    await mkdir(path.dirname(opts.output), { recursive: true });
    await writeFile(opts.output, md, 'utf8');
  }
  return { markdown: md, count: hwPublic.length };
}

// Run as CLI when invoked directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));

  const run = async () => {
    if (opts.promote) {
      const { promoted, skipped, flags } = await promoteHwLearnings(opts);
      const label = opts.dryRun ? '[dry-run] ' : '';
      process.stdout.write(
        `${label}Promotion complete: ${promoted} promoted, ${skipped} already public (skipped).\n`
      );
      for (const f of flags) process.stdout.write(`  warning: ${f}\n`);
    }
    const { markdown, count } = await exportHwLearnings(opts);
    if (opts.dryRun) process.stdout.write(markdown);
    else process.stdout.write(`Wrote ${count} hardware-pattern learnings to ${opts.output}\n`);
  };

  run().catch((err) => {
    process.stderr.write(`export failed: ${err.message}\n`);
    process.exit(1);
  });
}
