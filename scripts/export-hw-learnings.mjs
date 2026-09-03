#!/usr/bin/env node
/**
 * export-hw-learnings.mjs — anonymize + render hardware-pattern learnings.
 *
 * Part of Sub-Epic #160 / Epic #157 v3.1.0 (C3). Issue #172.
 *
 * Reads `.orchestrator/metrics/learnings.jsonl`, filters to
 * `type: hardware-pattern AND scope: public`, anonymizes per the hard
 * requirements in issue #172, and writes a human-readable markdown doc.
 *
 * Default output target: Epic #774 (docs Public-Split) removed the prior
 * in-repo generated telemetry doc — the default `--output` path now resolves
 * to the private Meta-Vault (`<vault-dir>/01-projects/session-orchestrator/
 * research/hardware-patterns.md`), via the same `vault-integration.vault-dir`
 * resolution `scripts/archive-closed-prds.mjs` uses (findProjectRoot →
 * CLAUDE.md/AGENTS.md → parseSessionConfig; host-resolved: SO_VAULT_DIR env >
 * owner.yaml paths.vault-dir > committed default). Pass `--output <path>` to
 * override.
 *
 * Idempotent: running without new data rewrites the same file byte-for-byte
 * modulo the generated-at line.
 *
 * ## Anonymization pipeline (enforced; no opt-out)
 *
 * - Mask env-derived secret VALUES first (#1025, value-based — orthogonal to the
 *   form-based rules below; see the note above `maskSecretValues`)
 * - Strip all absolute paths (macOS, Linux system paths, Windows)
 * - Redact IPv4 addresses
 * - Redact GitHub/GitLab URLs containing org/repo paths
 * - Replace hostname references with `host_class` label — form-based for
 *   suffixed names, PLUS value-based for this host's own suffix-stripped
 *   `host_id` spellings (#1072 follow-up; see `redactLocalHostNames`)
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

import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
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
import { findProjectRoot, resolveInstructionFile, expandTilde } from './lib/common.mjs';
import { parseSessionConfig } from './lib/config.mjs';
import { createSecretValueMasker } from './lib/secret-masker.mjs';
import { stableHostname, readHostAliases } from './lib/host-identity.mjs';
import { emitEvent, sessionAttribution } from './lib/events.mjs';

// Vault-relative default write target (Epic #774 — docs Public-Split removed
// the prior in-repo generated telemetry doc in favor of the private Meta-Vault).
const DEFAULT_VAULT_SUBPATH = path.join('01-projects', 'session-orchestrator', 'research', 'hardware-patterns.md');

/**
 * Resolve the default `--output` path when the CLI caller does not pass one
 * explicitly. Mirrors the vault-dir resolution `scripts/archive-closed-prds.mjs`
 * uses: findProjectRoot → CLAUDE.md/AGENTS.md → parseSessionConfig →
 * vault-integration.vault-dir (host-resolved: SO_VAULT_DIR env > owner.yaml
 * paths.vault-dir > committed default).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — override for findProjectRoot() (tests).
 * @param {{ env?: Record<string, string|undefined>, ownerConfig?: object }} [opts.hostPaths]
 *   — forwarded to parseSessionConfig (tests pass `{ env: {}, ownerConfig: undefined }`
 *   for hermetic, owner.yaml-free resolution — issue #653 bleed guard).
 * @returns {string|null} the resolved output path, or null when vault-dir is
 *   unconfigured/unresolvable.
 */
export function resolveDefaultOutput({ repoRoot, hostPaths } = {}) {
  const root = repoRoot ?? findProjectRoot();
  const instr = resolveInstructionFile(root);
  if (!instr) return null;

  let vaultDir;
  try {
    const content = readFileSync(instr.path, 'utf8');
    const config = parseSessionConfig(content, hostPaths ? { hostPaths } : undefined);
    vaultDir = config?.['vault-integration']?.['vault-dir'];
  } catch {
    return null;
  }
  if (!vaultDir || typeof vaultDir !== 'string' || vaultDir.trim() === '') return null;

  // Expand a `~`-prefixed vault-dir (e.g. the committed Session Config default
  // `~/Projects/vault`) — this path does NOT route through vault-archive.mjs,
  // so it needs its own expansion seam (issue: architect review finding).
  return path.join(expandTilde(vaultDir), DEFAULT_VAULT_SUBPATH);
}

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

/** Marker for every host-identifying redaction — form-based AND value-based. */
const HOSTNAME_MARKER = '<redacted-hostname>';

// ---------------------------------------------------------------------------
// Value-based host-identity redaction (#1072 follow-up)
// ---------------------------------------------------------------------------
//
// HOSTNAME_RE above is FORM-based and fires only on a name that still carries a
// `.local` / `.lan` / `.home` / `.internal` / `.corp` suffix. The session-lock
// body's `host_id` field is exactly the suffix-STRIPPED lowercase form that
// `stableHostname()` produces, so a `host_id` value reaching a learning passes
// through un-redacted. Measured on the reference host 2026-08-24, before this
// block existed:
//
//   anonymizeString('ferdinands-macbook-pro') → 'ferdinands-macbook-pro'  (no match)
//   anonymizeString('mac')                   → 'mac'                    (no match)
//
// Widening HOSTNAME_RE to bare labels is NOT the fix: once the suffix is gone a
// machine name is shape-identical to any other word, so a form rule broad
// enough to catch it would redact ordinary prose. The discriminating
// information is not the shape but the VALUE — and the values are known at
// runtime: `stableHostname(os.hostname())` plus every spelling this machine has
// recorded about ITSELF in the self-alias ledger (`readHostAliases()`, the
// #1072 lock-identity ledger). Exact strings, case-insensitive, word-boundary
// anchored: this host's identifiers precisely, which is the privacy contract.
//
// WHERE IT RUNS, AND WHY NOT BESIDE `maskSecretValues` — measured, because the
// obvious "all value-based rules go first" placement LEAKS. A secret is an
// opaque span nothing else owns; a hostname is routinely a SUBSTRING of a
// larger PII span that another rule owns. Two reachable cases, measured
// 2026-08-24 on the two orderings:
//
//   'ferdinand@Ferdinands-MacBook-Pro.local'
//     value-first → 'ferdinand@<redacted-hostname>'   ← email local-part leaks
//     host-slot   → '<redacted-email>'
//   '/Users/ferdinands-macbook-pro/Projects/secret-client/app.js'
//     value-first → '<redacted-path><redacted-hostname>/Projects/secret-client/app.js'
//     host-slot   → '<redacted-path>'
//
// The second is the sharper one: UNIX_PATH_RE's tail class is `[^\s"'<>]*`, so
// the ANGLE BRACKETS of an early marker truncate the path match and strand the
// rest of the path in the output. (`[REDACTED]`, the #1025 marker, is
// bracket-free — which is why that one is safe to run first.) Running LAST
// among the span rules can never lose a hostname in exchange: every rule here
// only ever replaces a span WITH the hostname inside it, so the name is gone
// either way.
//
// CEILING (BV-004): on a host whose stable name is an ordinary word — a Mac
// literally named `mac`, a Raspberry Pi named `pi` — every standalone
// occurrence of that word in an insight is redacted too. Accepted deliberately,
// and without a minimum-length floor: over-redaction in a PUBLIC export is the
// cheap direction, and a length floor would be a silent hole for exactly the
// short names that are most common. Revisit trigger: an exported document whose
// readability is measurably degraded by this collateral.

/** Optional trailing local-network suffix, so `mac.local` is consumed whole. */
const LOCAL_SUFFIX_GROUP = '(?:\\.(?:local|lan|home|localdomain|internal|corp))?';

/**
 * Escape regex metacharacters so a hostname is matched as a literal.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one alternation over the given names, or `null` when nothing is left
 * to match. Longest name first, because regex alternation is leftmost-first:
 * with `mac` ahead of `mac-pro`, the shorter name would win and strand `-pro`.
 *
 * @param {string[]} names — raw or normalised hostnames; normalised here.
 * @returns {RegExp|null}
 */
function compileHostNameRe(names) {
  const uniq = [
    ...new Set(names.map((n) => stableHostname(typeof n === 'string' ? n : '')).filter(Boolean)),
  ].sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (uniq.length === 0) return null;
  return new RegExp(`\\b(?:${uniq.map(escapeRegExp).join('|')})${LOCAL_SUFFIX_GROUP}\\b`, 'gi');
}

/**
 * Lazily-built, process-wide alternation over THIS host's own names — the same
 * once-per-process shape as `_secretMasker` below, for the same reason:
 * `readHostAliases()` is a synchronous file read, and rebuilding per record
 * would put one read on EVERY insight and EVERY evidence string.
 *
 * Tests either pass `names` to {@link redactLocalHostNames} directly, or
 * re-import the module after `vi.resetModules()` to rebuild it against a
 * stubbed `SO_HOST_ALIASES_FILE` (the shape the #1025 block in
 * `tests/scripts/export-hw-learnings.test.mjs` already uses).
 *
 * @type {RegExp|null|undefined} `undefined` = not built yet; `null` = nothing to redact.
 */
let _localHostRe;

/**
 * Redact THIS machine's own hostnames — any recorded spelling, with or without
 * a local-network suffix — from a free-form string.
 *
 * Fail-soft: a non-string passes through by reference, and an unresolvable host
 * identity makes this the identity function. Redaction must never be the reason
 * an export dies.
 *
 * @param {string} s
 * @param {string[]} [names] — override the name set (tests). Omitted → this
 *   host's `os.hostname()` plus the self-alias ledger, resolved once.
 * @returns {string}
 */
export function redactLocalHostNames(s, names) {
  if (typeof s !== 'string' || s === '') return s;

  let re;
  if (Array.isArray(names)) {
    re = compileHostNameRe(names);
  } else {
    if (_localHostRe === undefined) {
      try {
        _localHostRe = compileHostNameRe([stableHostname(os.hostname()), ...readHostAliases()]);
      } catch {
        _localHostRe = null;
      }
    }
    re = _localHostRe;
  }

  return re ? s.replace(re, HOSTNAME_MARKER) : s;
}

// ---------------------------------------------------------------------------
// Value-based secret masking (#1025) — the SECOND half of the pipeline
// ---------------------------------------------------------------------------
//
// `anonymizeString` below is FORM-based: eight regexes over the SHAPE of a
// string. `createSecretValueMasker` is VALUE-based: it looks for the literal
// values of secret-NAMED env vars. The two are orthogonal and BOTH are needed —
// measured on four probe secrets:
//
//   AWS secret key (with slashes)   FORM: secret survives   VALUE: [REDACTED]
//   DB password (short, symbols)    FORM: secret survives   VALUE: [REDACTED]
//   GitLab PAT (token shape)        FORM: <redacted-token>  VALUE: [REDACTED]
//   all-letter passphrase           FORM: secret survives   VALUE: [REDACTED]
//
// The AWS key is the sharpest case: `/` is outside TOKEN_RE's character class,
// so the key breaks into runs of 13/7/18 characters — every one of them BELOW
// the 20-character floor, hence not a single match. Conversely the form catches
// tokens of FOREIGN hosts that were never in `process.env`, which the value
// masker cannot see. Neither subsumes the other.
//
// ORDER IS LOAD-BEARING: mask FIRST, anonymize SECOND. `[REDACTED]` is 8
// characters with no digit, so it passes through `anonymizeString` untouched
// (TOKEN_RE requires ≥20 chars AND a digit). The reverse order blinds the
// masker: a value that `anonymizeString` has already rewritten to
// `<redacted-token>` is no longer findable as a literal, so a secret that only
// the VALUE filter would catch — because the form leaves a residue rather than
// the whole span — can no longer be matched.

/**
 * Lazily-built, process-wide masker. `createSecretValueMasker` scans the whole
 * env and compiles one RegExp per needle, so it is built ONCE per process and
 * reused for every entry — never rebuilt per record.
 *
 * @type {{ mask: (text: string) => string, needleCount: number } | null}
 */
let _secretMasker = null;

/**
 * Learning entries handed to `anonymizeLearning` this process. Counts only
 * (#1028 residue 2) — mirrors `_maskedRecords` in
 * `scripts/lib/vault-mirror/process.mjs`.
 */
let _maskedRecords = 0;
/** String values this process that masking actually CHANGED. Counts only. */
let _maskHits = 0;

/**
 * Mask env-derived secret VALUES in a free-form string.
 *
 * Fail-soft: non-strings pass through by reference, and a zero-needle env makes
 * `mask` the identity — the masker must never be the reason an export dies.
 *
 * @param {string} s
 * @returns {string}
 */
function maskSecretValues(s) {
  if (typeof s !== 'string') return s;
  if (_secretMasker === null) _secretMasker = createSecretValueMasker(process.env);
  const masked = _secretMasker.mask(s);
  if (masked !== s) _maskHits++;
  return masked;
}

/**
 * Counts-only view of the masking that happened in this process (#1028
 * residue 2). FORCE-BUILDS the masker rather than reporting 0 for an unbuilt
 * one — same reasoning as `getMaskerStats()` in
 * `scripts/lib/vault-mirror/process.mjs`: at 0 anonymized entries the lazy
 * build in `maskSecretValues` above never fires, and a `needle_count: 0` from
 * that path would be indistinguishable from "this channel has no masking
 * wired at all" — the exact ambiguity the telemetry exists to remove.
 *
 * NEVER returns a needle, a prefix of one, or any masked text — only cardinals.
 *
 * @returns {{ needleCount: number, records: number, hits: number }}
 */
function getExportMaskerStats() {
  if (_secretMasker === null) _secretMasker = createSecretValueMasker(process.env);
  return { needleCount: _secretMasker.needleCount, records: _maskedRecords, hits: _maskHits };
}

/**
 * Emit this channel's `orchestrator.secret_masker.applied` record — the third
 * of the three masker channels (`vault-mirror`, `narrative-mirror`,
 * `export-hw-learnings`) to wire it (#1028 residue 2). Same core field set as
 * the sibling channels (`channel`, `needle_count`, `records`, `hits`,
 * `dry_run`), plus `session_id`/`semantic_session_id` via `sessionAttribution`
 * — matching the `narrative-mirror` channel's shape, since this CLI (like
 * `mirrorNarrative`) always resolves a concrete `repoRoot` to attribute
 * against, unlike the `vault-mirror` CLI's 2-arg `emitEvent` call.
 *
 * `repoRoot` is REQUIRED here rather than left to `emitEvent`'s own
 * cwd-derived default (#941/#1147) — a bare 2-arg call would attribute a run
 * to whatever directory the process happens to sit in rather than to the repo
 * whose `learnings.jsonl` was actually exported.
 *
 * Best-effort: never throws, never alters the export/promote result.
 *
 * @param {{ repoRoot: string, dryRun: boolean }} opts
 * @returns {Promise<void>}
 */
async function emitMaskerTelemetry({ repoRoot, dryRun }) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return;
  try {
    const stats = getExportMaskerStats();
    await emitEvent(
      'orchestrator.secret_masker.applied',
      {
        channel: 'export-hw-learnings',
        needle_count: stats.needleCount,
        records: stats.records,
        hits: stats.hits,
        dry_run: !!dryRun,
        ...sessionAttribution(repoRoot),
      },
      { repoRoot },
    );
  } catch {
    /* Best-effort telemetry — a broken ledger must never fail the export. */
  }
}

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
  // Both host rules occupy the SAME slot — after every rule that owns a span a
  // hostname can sit inside (email domain, home directory, VCS URL), before
  // TOKEN_RE. The value rule runs first of the two so it consumes name+suffix
  // whole; see the "WHERE IT RUNS" measurement above for why neither may move
  // to the front of the chain.
  out = redactLocalHostNames(out);
  out = out.replace(HOSTNAME_RE, HOSTNAME_MARKER);
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
  // #1028 residue 2: counted BEFORE the masking calls below, unconditionally —
  // "records handed to the masker choke-point" must not depend on whether this
  // particular entry's insight/evidence happened to contain a needle. Mirrors
  // `_maskedRecords++` in `scripts/lib/vault-mirror/process.mjs`.
  _maskedRecords++;
  const out = {
    ...e,
    // #1025: value-mask BEFORE form-anonymize — see the ORDER IS LOAD-BEARING
    // note above `maskSecretValues`. This is the choke-point for BOTH write
    // paths (promoteHwLearnings and exportHwLearnings both route through here);
    // wiring at exportHwLearnings alone would leave the promote path unhardened.
    insight: anonymizeString(maskSecretValues(e.insight)),
    evidence: anonymizeString(maskSecretValues(e.evidence)),
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
    output: undefined, // resolved lazily below (default = vault-dir target)
    generatedAt: new Date().toISOString(),
    // #1028 residue 2: resolved explicitly HERE, at the CLI boundary, so the
    // masker-telemetry emit in promoteHwLearnings/exportHwLearnings gets a
    // real repoRoot — those library functions deliberately never default it
    // themselves (see their opts.repoRoot doc for why).
    repoRoot: findProjectRoot(),
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
        '  --dry-run        Print markdown to stdout; do not write any files.\n' +
        '  --output FILE    Override the default write target. Default: resolved from\n' +
        '                   vault-integration.vault-dir (see script header doc).\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  if (!out.output && !out.dryRun) {
    const resolved = resolveDefaultOutput();
    if (!resolved) {
      process.stderr.write(
        'export-hw-learnings: could not resolve vault-integration.vault-dir for the default ' +
        '--output path (no CLAUDE.md/AGENTS.md found, or vault-dir is unset). ' +
        'Pass --output <path> explicitly.\n'
      );
      process.exit(1);
    }
    out.output = resolved;
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
 * @param {string} [opts.repoRoot] — repo whose ledger the masker-telemetry
 *   event (#1028 residue 2) is pinned to. EXPLICIT ONLY — never defaulted to
 *   `findProjectRoot()`/cwd inside this library function (#941/#1147: a
 *   silent cwd-derived default is exactly what let earlier callers, including
 *   plain test invocations, write into whichever repo the process happened to
 *   sit in). The CLI entrypoint below resolves and passes it explicitly;
 *   library callers that omit it simply get no masker-telemetry emit — see
 *   `emitMaskerTelemetry`'s own repoRoot guard.
 * @returns {Promise<{promoted: number, skipped: number, flags: string[]}>}
 */
export async function promoteHwLearnings(opts) {
  const repoRoot = opts.repoRoot;
  const { entries, malformed } = await readLearnings(opts.input);

  const hwPrivate = filterByScope(filterByType(entries, 'hardware-pattern'), 'private');
  const hwPublicExisting = filterByScope(filterByType(entries, 'hardware-pattern'), 'public');

  const flags = [];
  if (malformed.length > 0) {
    flags.push(`${malformed.length} malformed line(s) in learnings.jsonl were skipped`);
  }

  if (hwPrivate.length === 0) {
    // #1028 residue 2: emitted here too — a run that anonymizes 0 entries
    // still ran, and `getExportMaskerStats()` force-builds the masker so
    // `needle_count` is real even though `_maskedRecords` stays 0.
    await emitMaskerTelemetry({ repoRoot, dryRun: !!opts.dryRun });
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
    // Rewrite: all original entries + new public twins appended at the end.
    // Original private entries are preserved (the twin is a new record).
    // The `.bak-<ISO>` backup (keep 3) is created inside rewriteLearnings (#721);
    // the script-level dryRun gate above is what suppresses it on a dry run.
    const allEntries = [...entries, ...promotedEntries];
    await rewriteLearnings(opts.input, allEntries);
  }

  // #1028 residue 2: one masker-telemetry record per promote run.
  await emitMaskerTelemetry({ repoRoot, dryRun: !!opts.dryRun });

  return { promoted: promotedEntries.length, skipped: hwPublicExisting.length, flags };
}

/**
 * @param {object} opts
 * @param {string} opts.input — path to learnings.jsonl
 * @param {string} opts.output — write target
 * @param {boolean} opts.dryRun — if true, do not write any files
 * @param {string} opts.generatedAt — ISO timestamp for the rendered doc
 * @param {string} [opts.repoRoot] — see `promoteHwLearnings` opts.repoRoot doc.
 * @returns {Promise<{markdown: string, count: number}>}
 */
export async function exportHwLearnings(opts) {
  const repoRoot = opts.repoRoot;
  const { entries } = await readLearnings(opts.input);
  const hwPublic = filterByScope(filterByType(entries, 'hardware-pattern'), 'public');
  const anonymized = hwPublic.map((e) => anonymizeLearning(e));
  const grouped = groupByHost(anonymized);
  const md = renderMarkdown(grouped, opts.generatedAt);
  if (!opts.dryRun) {
    await mkdir(path.dirname(opts.output), { recursive: true });
    await writeFile(opts.output, md, 'utf8');
  }
  // #1028 residue 2: one masker-telemetry record per export run, whether or
  // not any hardware-pattern entry was actually public (`hwPublic.length`
  // can legitimately be 0 — `getExportMaskerStats()` still force-builds the
  // masker so `needle_count` is a real measured value).
  await emitMaskerTelemetry({ repoRoot, dryRun: !!opts.dryRun });
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
