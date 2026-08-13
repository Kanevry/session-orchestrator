#!/usr/bin/env node
/**
 * backfill-learnings-from-vault.mjs — reconstruct learning records that the
 * store lost, from the vault mirror, and report what WOULD be restored.
 *
 * Issue #1017. `skills/evolve/SKILL.md` pruned `learnings.jsonl` by rewriting it
 * with `>` and no archive append, so pruned records vanished from every local
 * store. Their `learning-id` provenance pointers still sit in
 * `.claude/rules/*.md`, pointing at nothing. The vault mirror
 * (`<vault>/40-learnings/**`, written by `scripts/lib/vault-mirror/render-*.mjs`)
 * kept a rendered copy — this tool reverses that rendering.
 *
 * DEFAULT IS DRY-RUN. Nothing is written unless `--apply` is passed, and even
 * then the only write is an APPEND (`appendLearning`) of records that are
 * absent from BOTH the store and the archive at apply time. This tool never
 * rewrites the store (the rewrite path is what destroyed the data in the first
 * place) and never writes to the vault, which is read-only input here.
 *
 * ── Honesty contract (the point of the tool) ────────────────────────────────
 * A reconstruction that silently fills gaps is worse than a missing record,
 * because it looks authoritative. So every field of every reconstructed record
 * carries an ORIGIN label, reported per record (never aggregated):
 *
 *   vault             verbatim from the mirror note (body/frontmatter)
 *   rule-provenance   verbatim from the rule's Provenance block / H1 — the
 *                     reconcile engine copied these from the original record
 *   derived:<how>     a LOSSY derivation (e.g. the mirror stores `created` as a
 *                     DATE, so the time-of-day is gone and midnight UTC is used)
 *   absent            not reconstructed; no value is invented. Where
 *                     `validateLearning` applies its own default (scope /
 *                     host_class / anonymized) that is labelled explicitly.
 *
 * `file_paths` is deliberately NOT reconstructed: the rule's `globs:` are a
 * lossy projection of it, and inverting that projection would be a guess. The
 * globs are quoted in the report as a hint only.
 *
 * Every candidate is gated through `validateLearning` from the schema SSOT
 * (`scripts/lib/learnings/schema.mjs`). A record that would not validate is NOT
 * a restore candidate and says so, per record.
 *
 * Restored records are stamped `_restored_from: 'vault'` + `_restored_at` +
 * `_restored_fidelity`, so a later audit can always tell a reconstruction from
 * a record that never left.
 *
 * Idempotence: dry-run is pure (reads only). `--apply` re-checks store+archive
 * membership per record immediately before appending, so a second `--apply`
 * appends nothing and a later dry-run reports 0 orphans.
 *
 * NOTE on discovery: every file here is read through `node:fs`, never grep — a
 * single NUL byte makes a tracked file invisible to grep (silent skip, exit 1,
 * no warning) and the counting is done in Node, so `grep -c`'s no-match exit-1
 * double-print trap cannot apply.
 *
 * Usage:
 *   node scripts/backfill-learnings-from-vault.mjs [--json] [--apply]
 *        [--vault-dir PATH] [--rules-dir PATH] [--store PATH] [--archive PATH]
 *
 * Exit codes: 0 completed (dry-run or apply) · 1 usage/config error · 2 system error.
 * Output: report on stdout, diagnostics on stderr.
 *
 * Exports (for tests): main, parseRuleProvenance, vaultSlugFor,
 *   parseVaultNote, indexVaultNotes, locateNote, reconstructRecord.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findProjectRoot, resolveInstructionFile, expandTilde } from './lib/common.mjs';
import { parseSessionConfig } from './lib/config.mjs';
import { subjectToSlug, parseFrontmatter } from './lib/vault-mirror/utils.mjs';
import { kebab } from './lib/learnings/kebab.mjs';
import { validateLearning } from './lib/learnings/schema.mjs';
import { appendLearning } from './lib/learnings/io.mjs';

const DEFAULT_RULES_DIR = '.claude/rules';
const DEFAULT_STORE = '.orchestrator/metrics/learnings.jsonl';
const DEFAULT_ARCHIVE = '.orchestrator/metrics/learnings-archive.jsonl';
const DEFAULT_VAULT_SUBDIR = '40-learnings';

/** Sentinel the vault mirror writes when the source record had no evidence. */
const MIRROR_EVIDENCE_SENTINEL = '(none recorded)';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Derive the vault note slug for a v1 learning subject, mirroring
 * `vault-mirror/process.mjs` (whitespace → hyphen, then `subjectToSlug`).
 * This is the reverse-lookup key for finding a learning's mirror note.
 *
 * @param {string} subject
 * @returns {string}
 */
export function vaultSlugFor(subject) {
  if (typeof subject !== 'string' || subject.trim() === '') return '';
  return subjectToSlug(subject.trim().replace(/\s+/g, '-'));
}

/** Strip hyphens for a hyphenation-insensitive slug comparison. */
const dehyphen = (s) => String(s).replace(/-/g, '');

/**
 * Extract the section of a markdown body between `startRe` and the next
 * `## `-heading (or an HTML comment / end of input).
 *
 * @param {string} body
 * @param {RegExp} startRe — must match the heading line
 * @returns {string|null} trimmed section text, or null when the heading is absent
 */
function sectionAfter(body, startRe) {
  const m = body.match(startRe);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const stop = rest.search(/\n(?:## |<!-- )/);
  return (stop === -1 ? rest : rest.slice(0, stop)).trim();
}

/**
 * Parse an auto-generated `.claude/rules/*.md` file into the provenance facts
 * the reconcile engine transcribed from the original learning record.
 *
 * Returns null for hand-authored rules (no `## Provenance` block).
 *
 * @param {string} content — full file text
 * @returns {{
 *   learningKey: string|null, learningId: string|null, sourceSession: string|null,
 *   confidence: number|null, expiresAt: string|null, subject: string|null,
 *   globs: string[], insight: string|null, evidence: string|null
 * }|null}
 */
export function parseRuleProvenance(content) {
  if (!/^##\s+Provenance\s*$/m.test(content)) return null;

  const pick = (re) => {
    const m = content.match(re);
    return m ? m[1].trim() : null;
  };

  const learningId = pick(/^- learning-id:\s*`([^`]*)`/m);
  const learningKey = pick(/^- learning-key:\s*`([^`]*)`/m);
  const sourceSession = pick(/^- source-session:\s*`([^`]*)`/m);
  const confidenceRaw = pick(/^- confidence:\s*(.+)$/m);
  const expiresAt = pick(/^- expires-at:\s*(.+)$/m);
  const subject = pick(/^#\s+Auto-generated rule:\s*(.+)$/m);

  const confidence =
    confidenceRaw !== null && confidenceRaw !== '' && Number.isFinite(Number(confidenceRaw))
      ? Number(confidenceRaw)
      : null;

  // `globs:` is a YAML block list — parseFrontmatter drops the `- "..."` items
  // (no colon), so collect them here for the report's hint line.
  const globs = [];
  const fmEnd = content.indexOf('\n---', 3);
  if (content.startsWith('---') && fmEnd !== -1) {
    const fmLines = content.slice(3, fmEnd).split('\n');
    let inGlobs = false;
    for (const line of fmLines) {
      if (/^globs:\s*$/.test(line)) {
        inGlobs = true;
        continue;
      }
      if (inGlobs) {
        const item = line.match(/^\s+-\s*"?([^"]*)"?\s*$/);
        if (item) {
          globs.push(item[1]);
          continue;
        }
        inGlobs = false;
      }
    }
  }

  // Body insight: between the H1 and the `## Evidence` heading.
  const h1 = content.match(/^#\s+Auto-generated rule:.*$/m);
  let insight = null;
  if (h1) {
    const afterH1 = content.slice(h1.index + h1[0].length);
    const stop = afterH1.search(/\n## /);
    insight = (stop === -1 ? afterH1 : afterH1.slice(0, stop)).trim() || null;
  }
  const evidence = sectionAfter(content, /^##\s+Evidence\s*$/m);

  // The renderer writes its own placeholders when the source learning had no
  // insight/evidence. Mapping them to null keeps them out of the cross-check as
  // "not-possible" rather than counting a placeholder as a differing second copy.
  const unplaceholder = (v, placeholder) => (v === placeholder ? null : v);

  return {
    learningKey,
    learningId,
    sourceSession,
    confidence,
    expiresAt,
    subject,
    globs,
    insight: unplaceholder(insight, '(no insight recorded)'),
    evidence: unplaceholder(evidence, '(no evidence recorded)'),
  };
}

/**
 * Parse a vault learning note (as rendered by `render-learnings.mjs`) back into
 * the record fields it carries. Fields the renderer never wrote (`subject`,
 * `file_paths`, `scope`, …) are simply absent — never guessed.
 *
 * @param {string} content
 * @param {string} absPath
 * @returns {object|null} null when the file has no parseable frontmatter
 */
export function parseVaultNote(content, absPath) {
  const fm = parseFrontmatter(content);
  if (!fm) return null;

  const bodyStart = content.indexOf('\n---', 3);
  const body = bodyStart === -1 ? content : content.slice(bodyStart + 4);

  const bullet = (label) => {
    const m = body.match(new RegExp(`^-\\s+\\*\\*${label}:\\*\\*\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };

  const rawConfidence = bullet('Confidence');
  const sourceSessionRaw = fm.source_session ?? bullet('Source session');

  return {
    path: absPath,
    slug: typeof fm.id === 'string' && fm.id !== '' ? fm.id : basename(absPath, '.md'),
    fileStem: basename(absPath, '.md'),
    noteType: fm.type ?? null,
    sourceRepo: fm['source-repo'] ?? null,
    generator: fm._generator ?? null,
    type: bullet('Type'),
    confidence:
      rawConfidence !== null && Number.isFinite(Number(rawConfidence)) ? Number(rawConfidence) : null,
    // Strip Obsidian wikilink brackets — the renderer emits `[[session-id]]`
    // when the session note exists, plain text otherwise.
    sourceSession:
      typeof sourceSessionRaw === 'string'
        ? sourceSessionRaw.replace(/^\[\[|\]\]$/g, '').trim() || null
        : null,
    created: fm.created ?? null,
    expires: fm.expires ?? null,
    insight: sectionAfter(body, /^##\s+Insight\s*$/m),
    evidence: sectionAfter(body, /^##\s+Evidence\s*$/m),
  };
}

/**
 * Recursively index every learning note under `<vaultDir>/<subdir>`.
 * Read via `node:fs` (not grep) so a NUL-corrupted note is still seen.
 *
 * @param {string} rootDir — absolute path of the learnings directory
 * @returns {{ notes: object[], unreadable: string[] }}
 */
export function indexVaultNotes(rootDir) {
  const notes = [];
  const unreadable = [];
  if (!existsSync(rootDir)) return { notes, unreadable };

  const entries = readdirSync(rootDir, { withFileTypes: true, recursive: true });
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const abs = join(ent.parentPath ?? ent.path ?? rootDir, ent.name);
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (err) {
      unreadable.push(`${abs}: ${err.message}`);
      continue;
    }
    const note = parseVaultNote(content, abs);
    if (!note || note.noteType !== 'learning') continue;
    note.relPath = relative(rootDir, abs);
    notes.push(note);
  }
  return { notes, unreadable };
}

/**
 * Locate the mirror note for one orphaned learning. Strategies are tried in
 * descending fidelity order; the first that yields candidates wins.
 *
 * A strategy that yields MORE than one candidate is narrowed by `source-repo`
 * and, failing that, reported as ambiguous — a silent pick would be exactly the
 * "looks like it recovered something" failure this tool exists to avoid.
 *
 * @param {object[]} notes — from indexVaultNotes
 * @param {{subject: string|null, keySlug: string|null, learningId: string|null, repoHint?: string|null}} q
 * @returns {{note: object|null, strategy: string|null, ambiguous: object[]|null}}
 */
export function locateNote(notes, { subject, keySlug, learningId, repoHint = null }) {
  const strategies = [];
  const subjSlug = subject ? vaultSlugFor(subject) : '';
  if (subjSlug) {
    strategies.push(['slug-from-rule-subject', (n) => n.slug === subjSlug || n.fileStem === subjSlug]);
  }
  if (keySlug) {
    strategies.push(['slug-from-learning-key', (n) => n.slug === keySlug || n.fileStem === keySlug]);
  }
  if (subjSlug || keySlug) {
    const targets = new Set([dehyphen(subjSlug), dehyphen(keySlug ?? '')].filter(Boolean));
    strategies.push([
      'slug-hyphen-insensitive',
      (n) => targets.has(dehyphen(n.slug)) || targets.has(dehyphen(n.fileStem)),
    ]);
  }
  if (learningId) {
    strategies.push(['note-named-by-learning-id', (n) => n.fileStem === learningId || n.slug === learningId]);
  }

  for (const [strategy, pred] of strategies) {
    let hits = notes.filter(pred);
    if (hits.length === 0) continue;
    if (hits.length > 1 && repoHint) {
      const narrowed = hits.filter((n) => n.sourceRepo === repoHint);
      if (narrowed.length === 1) hits = narrowed;
    }
    if (hits.length > 1) return { note: null, strategy, ambiguous: hits };
    return { note: hits[0], strategy, ambiguous: null };
  }
  return { note: null, strategy: null, ambiguous: null };
}

/**
 * Convert a vault date (`YYYY-MM-DD`, the mirror's lossy `toDate` output) to an
 * ISO timestamp at midnight UTC. Returns the input verbatim when it already
 * carries a time component (then it is ORIGINAL, not derived).
 *
 * @param {string|null} value
 * @returns {{iso: string|null, lossy: boolean}}
 */
function dateToIso(value) {
  if (typeof value !== 'string' || value.trim() === '') return { iso: null, lossy: false };
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { iso: `${v}T00:00:00.000Z`, lossy: true };
  const ms = Date.parse(v);
  if (Number.isFinite(ms)) return { iso: new Date(ms).toISOString(), lossy: false };
  return { iso: null, lossy: false };
}

/**
 * Reconstruct one learning record from its vault note + rule provenance, label
 * every field's origin, and gate it through `validateLearning`.
 *
 * Never invents a value: a field that is in neither source stays absent, which
 * makes the validator reject the record — the intended outcome.
 *
 * @param {{rule: object, note: object|null, now?: string}} args
 * @returns {{record: object|null, fidelity: object, conflicts: string[], crossChecks: object, validates: boolean, validationError: string|null}}
 */
export function reconstructRecord({ rule, note, now = new Date().toISOString() }) {
  const fidelity = {};
  const conflicts = [];
  /**
   * Per-field corroboration between the two independent copies (vault note vs
   * rule provenance). Recorded EXPLICITLY so an empty `conflicts` list can
   * never be read as "corroborated" when in truth no comparison was possible.
   */
  const crossChecks = {};
  const crossCheck = (field, ruleVal, vaultVal) => {
    if (ruleVal === null || ruleVal === undefined || ruleVal === '') {
      crossChecks[field] = 'not-possible (rule side carries no value)';
    } else if (vaultVal === null || vaultVal === undefined || vaultVal === '') {
      crossChecks[field] = 'not-possible (vault side carries no value)';
    } else {
      crossChecks[field] = ruleVal === vaultVal ? 'match' : 'DIFFER';
    }
    return crossChecks[field];
  };

  if (!note) {
    return {
      record: null,
      fidelity,
      conflicts,
      crossChecks,
      validates: false,
      validationError: 'no vault note located — nothing to reconstruct from',
    };
  }

  /** @type {Record<string, unknown>} */
  const rec = {};

  // id — verbatim from the rule provenance (the engine copied the record's id).
  if (rule.learningId) {
    rec.id = rule.learningId;
    fidelity.id = 'rule-provenance (verbatim learning-id)';
  } else {
    fidelity.id = 'absent (rule carries no learning-id)';
  }

  // type — from the mirror note body; cross-checked against the learning-key prefix.
  // Reading the prefix AS the type is only sound because the key's type half is
  // verbatim, never slugged (`learnings/kebab.mjs::learningKeyOf` decision 1) —
  // the subject half below is the lossy one, which is why it can only ever be
  // labelled `derived:learning-key-slug`.
  const keyType = rule.learningKey ? rule.learningKey.split('/')[0] : null;
  if (note.type) {
    rec.type = note.type;
    fidelity.type = 'vault (note body **Type:**)';
    if (crossCheck('type', keyType, note.type) === 'DIFFER') {
      conflicts.push(`type: vault=${note.type} vs learning-key prefix=${keyType} (vault wins)`);
    }
  } else if (keyType) {
    rec.type = keyType;
    fidelity.type = 'rule-provenance (learning-key prefix; note carried no Type bullet)';
  } else {
    fidelity.type = 'absent';
  }

  // subject — the rule H1 carries the original prose subject. Confirmed when it
  // kebabs back to the learning-key's second segment; otherwise the key slug is
  // used and labelled derived (a slug, not the original prose).
  const keySubjectSlug = rule.learningKey ? rule.learningKey.split('/').slice(1).join('/') : null;
  const subjectCheck = crossCheck(
    'subject',
    keySubjectSlug,
    rule.subject ? kebab(rule.subject) : null
  );
  if (rule.subject && subjectCheck === 'match') {
    rec.subject = rule.subject;
    fidelity.subject = 'rule-provenance (H1, confirmed against learning-key)';
  } else if (rule.subject) {
    rec.subject = rule.subject;
    fidelity.subject = 'rule-provenance (H1, NOT confirmed against learning-key — may be a title alias)';
    if (subjectCheck === 'DIFFER') {
      conflicts.push(`subject: kebab(H1)=${kebab(rule.subject)} != learning-key subject=${keySubjectSlug}`);
    }
  } else if (keySubjectSlug) {
    rec.subject = keySubjectSlug;
    fidelity.subject = 'derived:learning-key-slug (original prose subject not recoverable)';
  } else {
    fidelity.subject = 'absent';
  }

  // insight — full text from the note; cross-checked against the rule body.
  if (note.insight) {
    rec.insight = note.insight;
    fidelity.insight = 'vault (## Insight, full text)';
    if (crossCheck('insight', rule.insight, note.insight) === 'DIFFER') {
      conflicts.push('insight: vault text differs from the rule body text (vault wins)');
    }
  } else if (rule.insight) {
    rec.insight = rule.insight;
    fidelity.insight = 'rule-provenance (rule body; note had no ## Insight section)';
  } else {
    fidelity.insight = 'absent';
  }

  // evidence — the mirror writes a "(none recorded)" sentinel when the source
  // record had none, so that sentinel must NOT be restored as content.
  if (note.evidence && note.evidence !== MIRROR_EVIDENCE_SENTINEL) {
    rec.evidence = note.evidence;
    fidelity.evidence = 'vault (## Evidence, full text)';
    if (crossCheck('evidence', rule.evidence, note.evidence) === 'DIFFER') {
      conflicts.push('evidence: vault text differs from the rule body text (vault wins)');
    }
  } else if (note.evidence === MIRROR_EVIDENCE_SENTINEL) {
    rec.evidence = '';
    fidelity.evidence =
      'absent (mirror wrote the "(none recorded)" sentinel — the original evidence was empty; empty string used, schema requires the key)';
  } else if (rule.evidence && rule.evidence !== '(no evidence recorded)') {
    rec.evidence = rule.evidence;
    fidelity.evidence = 'rule-provenance (rule body; note had no ## Evidence section)';
  } else {
    fidelity.evidence = 'absent (no evidence in either source)';
  }

  // confidence — the note body carries the exact value.
  if (typeof note.confidence === 'number') {
    rec.confidence = note.confidence;
    fidelity.confidence = 'vault (note body **Confidence:**)';
    if (crossCheck('confidence', rule.confidence, note.confidence) === 'DIFFER') {
      conflicts.push(`confidence: vault=${note.confidence} vs rule=${rule.confidence} (vault wins)`);
    }
  } else if (typeof rule.confidence === 'number') {
    rec.confidence = rule.confidence;
    fidelity.confidence = 'rule-provenance (note carried no Confidence bullet)';
  } else {
    fidelity.confidence = 'absent';
  }

  // source_session
  if (note.sourceSession) {
    rec.source_session = note.sourceSession;
    fidelity.source_session = 'vault (frontmatter source_session)';
    if (crossCheck('source_session', rule.sourceSession, note.sourceSession) === 'DIFFER') {
      conflicts.push(`source_session: vault=${note.sourceSession} vs rule=${rule.sourceSession} (vault wins)`);
    }
  } else if (rule.sourceSession) {
    rec.source_session = rule.sourceSession;
    fidelity.source_session = 'rule-provenance (note carried no source_session)';
  } else {
    fidelity.source_session = 'absent';
  }

  // created_at — the mirror stores a DATE; the time-of-day is gone for good.
  const created = dateToIso(note.created);
  if (created.iso) {
    rec.created_at = created.iso;
    fidelity.created_at = created.lossy
      ? `derived:vault-date (${note.created} → midnight UTC; original time-of-day lost)`
      : 'vault (full timestamp)';
  } else {
    fidelity.created_at = 'absent (no created date in the vault note)';
  }

  // expires_at — same lossy date treatment as created_at.
  //
  // The rule's `expires-at` is NOT a second copy of this field: the reconcile
  // emitter RECOMPUTES a rule ACTIVATION WINDOW from created_at + the per-type
  // TTL, with a floor (`emitter.mjs::computeExpiresAt`). A difference is
  // therefore expected and is reported as information — never as a data
  // conflict, and never used in preference to the vault value.
  const expires = dateToIso(note.expires);
  if (expires.iso) {
    rec.expires_at = expires.iso;
    fidelity.expires_at = expires.lossy
      ? `derived:vault-date (${note.expires} → midnight UTC; original time-of-day lost)`
      : 'vault (full timestamp)';
  } else {
    const fromRule = dateToIso(rule.expiresAt);
    if (fromRule.iso) {
      rec.expires_at = fromRule.iso;
      fidelity.expires_at =
        `derived:rule-activation-window (${rule.expiresAt} → midnight UTC) — NOT the record's original ` +
        'expires_at; the emitter recomputes this window from created_at + type TTL';
    } else {
      fidelity.expires_at = 'absent (no expiry in either source)';
    }
  }
  if (!rule.expiresAt) {
    crossChecks.expires_at_vs_rule_window = 'not-possible (rule carries no expires-at)';
  } else if (!note.expires) {
    crossChecks.expires_at_vs_rule_window = 'not-possible (vault note carries no expires)';
  } else if (rule.expiresAt === note.expires) {
    crossChecks.expires_at_vs_rule_window = 'match';
  } else {
    crossChecks.expires_at_vs_rule_window =
      `differs (vault=${note.expires}, rule window=${rule.expiresAt}) — expected: the rule window is ` +
      'emitter-derived, not a copy of the record field; the vault value is used';
  }

  // schema_version — not recorded by the mirror. Stamped with the writer's
  // current version and labelled as such (validateLearning accepts 0 or 1).
  rec.schema_version = 1;
  fidelity.schema_version = 'derived:writer-default (the mirror never recorded the original schema_version)';

  // Deliberately NOT reconstructed.
  fidelity.file_paths =
    rule.globs.length > 0
      ? `absent (NOT reconstructed — the rule globs [${rule.globs.join(', ')}] are a lossy projection of file_paths, not its inverse)`
      : 'absent (no source)';
  fidelity.scope = 'absent → validateLearning default "local" applied';
  fidelity.host_class = 'absent → validateLearning default null applied';
  fidelity.anonymized = 'absent → validateLearning default false applied';
  fidelity.updated_at = 'absent (the mirror sets updated = created; carries no independent value)';

  // Restore stamps — make a reconstruction distinguishable from an original.
  rec._restored_from = 'vault';
  rec._restored_at = now;
  rec._restored_by = 'scripts/backfill-learnings-from-vault.mjs';
  rec._restored_source_note = note.relPath ?? note.path;
  // Store the origin CODE per field, not the report's prose — the record is a
  // store line, not a document. The full wording stays in the report (and is
  // reproducible from it), while the record keeps enough for a later audit to
  // ask "where did this field come from?" without re-running the tool.
  const code = (v) => String(v).split(' (')[0].split(' →')[0];
  rec._restored_fidelity = Object.fromEntries(Object.entries(fidelity).map(([k, v]) => [k, code(v)]));
  rec._restored_cross_checks = Object.fromEntries(
    Object.entries(crossChecks).map(([k, v]) => [k, code(v)])
  );

  let validated = null;
  let validationError = null;
  try {
    validated = validateLearning(rec);
  } catch (err) {
    validationError = err.message;
  }

  return {
    record: validated,
    fidelity,
    conflicts,
    crossChecks,
    validates: validationError === null,
    validationError,
  };
}

// ---------------------------------------------------------------------------
// Store membership
// ---------------------------------------------------------------------------

/**
 * Collect learning ids from a JSONL store. Counting happens in Node (never via
 * `grep -c`, whose no-match exit-1 makes `|| echo 0` double-print).
 *
 * @param {string} filePath
 * @returns {Set<string>}
 */
function idsInStore(filePath) {
  const ids = new Set();
  if (!existsSync(filePath)) return ids;
  const raw = readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.id === 'string' && obj.id !== '') ids.add(obj.id);
    } catch {
      // Malformed line — not an id source. Never rewritten by this tool.
    }
  }
  return ids;
}

/** List `<store>.bak-*` siblings (a verbatim original beats any reconstruction). */
function backupPaths(storePath) {
  const dir = dirname(storePath);
  const base = basename(storePath);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    // Missing dir, or a --store path whose parent is not a directory. Neither is
    // fatal: the backup sweep is an enrichment, not a prerequisite.
    return [];
  }
  return names
    .filter((n) => n.startsWith(`${base}.bak-`))
    .sort()
    .map((n) => join(dir, n));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(`backfill-learnings-from-vault — reconstruct lost learning records from the vault mirror

USAGE
  node scripts/backfill-learnings-from-vault.mjs [options]

OPTIONS
  --json               machine-readable report on stdout
  --apply              APPEND the restorable records to the store (default: dry-run,
                       writes nothing). Never rewrites the store, never touches the vault.
  --vault-dir PATH     override vault-integration.vault-dir
  --vault-subdir PATH  learnings subdir inside the vault (default: ${DEFAULT_VAULT_SUBDIR})
  --rules-dir PATH     rules directory (default: ${DEFAULT_RULES_DIR})
  --store PATH         learnings store (default: ${DEFAULT_STORE})
  --archive PATH       learnings archive (default: ${DEFAULT_ARCHIVE})
  -h, --help           this text

EXIT CODES
  0 completed · 1 usage/config error · 2 system error
`);
}

function printHuman(report) {
  const out = [];
  const s = report.summary;
  out.push(`Learning backfill from vault ${report.dry_run ? '(dry-run — nothing written)' : '(APPLY)'}`);
  out.push(`  rules dir : ${report.rules_dir}`);
  out.push(`  store     : ${report.store}`);
  out.push(`  archive   : ${report.archive}`);
  out.push(`  vault     : ${report.vault_learnings_dir} (${s.vault_notes_indexed} learning notes indexed)`);
  out.push('');
  out.push(
    `Rules with provenance: ${s.rules_with_provenance} · resolved in store: ${s.present_in_store} · in archive: ${s.present_in_archive} · recoverable verbatim from a .bak: ${s.recoverable_from_backup} · ORPHANED: ${s.orphans}`
  );
  out.push('');

  for (const r of report.records) {
    if (r.status !== 'orphan') continue;
    const head = `[${r.index}/${s.orphans}] ${r.learning_id}  ${r.learning_key ?? '(no key)'}`;
    out.push(head);
    out.push(`   rule       : ${r.rule_file}`);
    if (r.vault_note) {
      out.push(`   vault note : ${r.vault_note}  (match: ${r.match_strategy})`);
    } else if (r.ambiguous_candidates) {
      out.push(`   vault note : AMBIGUOUS — ${r.ambiguous_candidates.length} candidates via ${r.match_strategy}:`);
      for (const c of r.ambiguous_candidates) out.push(`                  - ${c}`);
    } else {
      out.push('   vault note : NOT FOUND — no note matched by subject slug, learning-key slug, or id');
    }
    out.push(`   validates  : ${r.validates ? 'yes' : `NO — ${r.validation_error}`}`);
    out.push(`   restorable : ${r.restorable ? 'yes' : 'NO'}`);
    if (Object.keys(r.fidelity).length > 0) {
      out.push('   fidelity   :');
      for (const [field, origin] of Object.entries(r.fidelity)) {
        out.push(`                  ${field.padEnd(15)} ${origin}`);
      }
    }
    // Cross-checks are printed BEFORE conflicts so an empty conflicts list is
    // read together with the evidence that a comparison was actually possible.
    const cc = Object.entries(r.cross_checks ?? {});
    if (cc.length > 0) {
      out.push('   cross-check:  (vault copy vs rule-provenance copy)');
      for (const [field, verdict] of cc) out.push(`                  ${field.padEnd(15)} ${verdict}`);
    }
    if (r.conflicts.length > 0) {
      out.push('   conflicts  :');
      for (const c of r.conflicts) out.push(`                  ! ${c}`);
    } else {
      out.push('   conflicts  : none');
    }
    out.push('');
  }

  const nonOrphan = report.records.filter((r) => r.status !== 'orphan');
  if (nonOrphan.length > 0) {
    out.push('Not orphaned (no reconstruction needed):');
    for (const r of nonOrphan) {
      out.push(`   ${r.status.padEnd(24)} ${r.learning_id}  [${r.found_in.join(', ')}]`);
    }
    out.push('');
  }

  out.push(
    `RESTORABLE: ${s.restorable} of ${s.orphans} orphans` +
      (s.restorable < s.orphans ? ` — ${s.orphans - s.restorable} NOT recoverable (see per-record reasons above)` : '')
  );
  if (report.dry_run) {
    out.push('Dry-run: no file was written. Re-run with --apply to append the restorable records.');
  } else {
    out.push(`Applied: ${s.applied} appended · ${s.skipped_already_present} skipped (already present at apply time)`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

/**
 * @param {string[]} argv
 * @param {{repoRoot?: string, vaultDir?: string, now?: string, hostPaths?: object}} [deps]
 * @returns {Promise<{code: 0|1|2, report?: object}>}
 */
export async function main(argv = [], deps = {}) {
  let json = false;
  let apply = false;
  let help = false;
  let vaultDirArg = deps.vaultDir ?? null;
  let vaultSubdir = DEFAULT_VAULT_SUBDIR;
  let rulesDir = DEFAULT_RULES_DIR;
  let storeArg = DEFAULT_STORE;
  let archiveArg = DEFAULT_ARCHIVE;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--apply') apply = true;
    else if (a === '--dry-run') apply = false;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--vault-dir') vaultDirArg = argv[++i];
    else if (a === '--vault-subdir') vaultSubdir = argv[++i];
    else if (a === '--rules-dir') rulesDir = argv[++i];
    else if (a === '--store') storeArg = argv[++i];
    else if (a === '--archive') archiveArg = argv[++i];
    else {
      process.stderr.write(`backfill-learnings-from-vault: unknown argument: ${a}\n`);
      return { code: 1 };
    }
  }
  if (help) {
    printHelp();
    return { code: 0 };
  }
  for (const [flag, value] of [
    ['--vault-dir', vaultDirArg],
    ['--vault-subdir', vaultSubdir],
    ['--rules-dir', rulesDir],
    ['--store', storeArg],
    ['--archive', archiveArg],
  ]) {
    if (value === undefined || value === '') {
      process.stderr.write(`backfill-learnings-from-vault: ${flag} requires a value.\n`);
      return { code: 1 };
    }
  }

  const root = deps.repoRoot ?? findProjectRoot();
  const now = deps.now ?? new Date().toISOString();

  // ── Resolve the vault dir (flag > Session Config) ────────────────────────
  let vaultDir = vaultDirArg;
  if (!vaultDir) {
    const instr = resolveInstructionFile(root);
    if (!instr) {
      process.stderr.write(`backfill-learnings-from-vault: no CLAUDE.md/AGENTS.md at ${root}.\n`);
      return { code: 1 };
    }
    try {
      const config = parseSessionConfig(readFileSync(instr.path, 'utf8'), deps.hostPaths ? { hostPaths: deps.hostPaths } : undefined);
      vaultDir = config?.['vault-integration']?.['vault-dir'];
    } catch (err) {
      process.stderr.write(`backfill-learnings-from-vault: failed to parse Session Config: ${err.message}\n`);
      return { code: 2 };
    }
  }
  if (!vaultDir || typeof vaultDir !== 'string' || vaultDir.trim() === '') {
    process.stderr.write('backfill-learnings-from-vault: vault-integration.vault-dir is not configured — nothing to recover from.\n');
    return { code: 1 };
  }
  vaultDir = expandTilde(vaultDir);

  // `resolve` (not `join`) so an ABSOLUTE --store/--archive/--rules-dir wins over
  // the repo root instead of being silently nested under it.
  const rulesAbs = resolve(root, rulesDir);
  const storeAbs = resolve(root, storeArg);
  const archiveAbs = resolve(root, archiveArg);
  const learningsAbs = resolve(vaultDir, vaultSubdir);

  if (!existsSync(rulesAbs)) {
    process.stderr.write(`backfill-learnings-from-vault: rules dir not found: ${rulesAbs}\n`);
    return { code: 1 };
  }
  if (!existsSync(learningsAbs)) {
    process.stderr.write(`backfill-learnings-from-vault: vault learnings dir not found: ${learningsAbs}\n`);
    return { code: 1 };
  }

  // ── Load inputs ──────────────────────────────────────────────────────────
  const storeIds = idsInStore(storeAbs);
  const archiveIds = idsInStore(archiveAbs);
  const backups = backupPaths(storeAbs).map((p) => ({ path: p, ids: idsInStore(p) }));
  const { notes, unreadable } = indexVaultNotes(learningsAbs);
  for (const u of unreadable) process.stderr.write(`backfill-learnings-from-vault: WARN unreadable vault note ${u}\n`);

  const repoHint = basename(root);

  const rules = readdirSync(rulesAbs)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => ({ name: n, content: readFileSync(join(rulesAbs, n), 'utf8') }))
    .map((f) => ({ name: f.name, prov: parseRuleProvenance(f.content) }))
    .filter((f) => f.prov !== null && f.prov.learningId);

  // ── Classify + reconstruct ───────────────────────────────────────────────
  const records = [];
  let orphanIndex = 0;
  for (const { name, prov } of rules) {
    const id = prov.learningId;
    const foundIn = [];
    if (storeIds.has(id)) foundIn.push('store');
    if (archiveIds.has(id)) foundIn.push('archive');
    for (const b of backups) if (b.ids.has(id)) foundIn.push(basename(b.path));

    let status;
    if (storeIds.has(id)) status = 'present-in-store';
    else if (archiveIds.has(id)) status = 'present-in-archive';
    else if (foundIn.length > 0) status = 'recoverable-verbatim-from-backup';
    else status = 'orphan';

    const base = {
      learning_id: id,
      learning_key: prov.learningKey,
      rule_file: join(rulesDir, name),
      status,
      found_in: foundIn,
    };

    if (status !== 'orphan') {
      records.push({ ...base, fidelity: {}, conflicts: [], validates: null, restorable: false, index: null });
      continue;
    }

    orphanIndex += 1;
    const keySubjectSlug = prov.learningKey ? prov.learningKey.split('/').slice(1).join('/') : null;
    const { note, strategy, ambiguous } = locateNote(notes, {
      subject: prov.subject,
      keySlug: keySubjectSlug,
      learningId: id,
      repoHint,
    });

    const { record, fidelity, conflicts, crossChecks, validates, validationError } = reconstructRecord({
      rule: prov,
      note,
      now,
    });

    records.push({
      ...base,
      index: orphanIndex,
      vault_note: note ? note.relPath : null,
      match_strategy: strategy,
      ambiguous_candidates: ambiguous ? ambiguous.map((n) => n.relPath) : null,
      validates,
      validation_error: validationError,
      restorable: validates,
      fidelity,
      cross_checks: crossChecks,
      conflicts,
      record,
    });
  }

  // ── Apply (append-only, re-checked) ──────────────────────────────────────
  let applied = 0;
  let skippedAlreadyPresent = 0;
  if (apply) {
    for (const r of records) {
      if (r.status !== 'orphan' || !r.restorable || !r.record) continue;
      // Re-check membership at apply time — this is what makes a second
      // --apply a no-op rather than a duplicate append.
      if (idsInStore(storeAbs).has(r.learning_id) || idsInStore(archiveAbs).has(r.learning_id)) {
        skippedAlreadyPresent += 1;
        r.applied = false;
        continue;
      }
      try {
        await appendLearning(storeAbs, r.record);
        applied += 1;
        r.applied = true;
      } catch (err) {
        r.applied = false;
        r.apply_error = err.message;
        process.stderr.write(`backfill-learnings-from-vault: append failed for ${r.learning_id}: ${err.message}\n`);
      }
    }
  }

  const orphans = records.filter((r) => r.status === 'orphan');
  const report = {
    dry_run: !apply,
    repo_root: root,
    rules_dir: rulesDir,
    store: storeArg,
    archive: archiveArg,
    vault_learnings_dir: learningsAbs,
    summary: {
      rules_with_provenance: rules.length,
      vault_notes_indexed: notes.length,
      present_in_store: records.filter((r) => r.status === 'present-in-store').length,
      present_in_archive: records.filter((r) => r.status === 'present-in-archive').length,
      recoverable_from_backup: records.filter((r) => r.status === 'recoverable-verbatim-from-backup').length,
      orphans: orphans.length,
      located_in_vault: orphans.filter((r) => r.vault_note).length,
      restorable: orphans.filter((r) => r.restorable).length,
      applied,
      skipped_already_present: skippedAlreadyPresent,
    },
    records,
  };

  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printHuman(report);

  return { code: 0, report };
}

/* c8 ignore start — CLI entrypoint */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then(({ code }) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`backfill-learnings-from-vault: ${err.stack ?? err.message}\n`);
      process.exit(2);
    });
}
/* c8 ignore stop */
