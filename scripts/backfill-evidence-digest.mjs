#!/usr/bin/env node
/**
 * backfill-evidence-digest.mjs — seal existing generated rules (#1101).
 *
 * `.orchestrator/metrics/learnings.jsonl` is GITIGNORED (`.gitignore:40`). Every
 * `.claude/rules/*.md` written by the reconciliation engine before #1101 points
 * at that file through its `learning-key` and carries nothing else, so in a
 * fresh clone the pointer resolves to nothing and the drift-checker's Check 8
 * warns on ALL of them (measured 2026-08-26: 23 of 23; in this working copy 3,
 * whose keys no longer resolve even here).
 *
 * `renderRule` now emits an `evidence-digest` for every NEW rule. This script is
 * the one-off that gives the EXISTING corpus the same seal, computed with the
 * very same {@link computeEvidenceDigest} the renderer uses — one recipe, never
 * two implementations that must be kept in agreement.
 *
 * ── What is reconstructed, and the one honest limit ──────────────────────────
 * Five of the six digest components live in the rule file itself (`learning-key`
 * and `confidence` in frontmatter, `learning-id` and `source-session` in the
 * `## Provenance` block, and the `## Evidence` block verbatim). The sixth,
 * `evidence-recorded-at`, is the learning's `created_at` and exists ONLY in
 * learnings.jsonl. For a key that still resolves there it is read across; for a
 * key that does not, it is emitted as the EMPTY STRING. It is never invented:
 * a fabricated timestamp would make the digest a reference masquerading as
 * evidence, which is the exact failure #1101 exists to close.
 *
 * ── Why the digest input is the `## Evidence` block ONLY ─────────────────────
 * Not "everything between the H1 and `## Provenance`". Several rules carry a
 * hand-written `## Extension Review (…)` section appended after the evidence,
 * and a legitimate future hand-annotation must not break the seal. The seal
 * covers the machine-authored evidence and its provenance header — nothing else.
 *
 * Usage:
 *   node scripts/backfill-evidence-digest.mjs              # dry-run (default)
 *   node scripts/backfill-evidence-digest.mjs --apply      # write
 *   node scripts/backfill-evidence-digest.mjs --verify     # re-check every seal
 *   node scripts/backfill-evidence-digest.mjs --verify <file.md>...
 *
 * `--verify` reads ONLY the `.md` files handed to it. It never opens
 * learnings.jsonl — that is the whole point, and it is what makes the digest
 * verifiable in a fresh clone.
 *
 * Idempotent: a rule that already carries an `evidence-digest:` frontmatter key
 * is left byte-identical and reported as `skipped (already sealed)`.
 *
 * @module scripts/backfill-evidence-digest
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { computeEvidenceDigest } from './lib/reconcile/renderer.mjs';

/** ISO-8601 instant — mirrors the renderer's `EVIDENCE_RECORDED_AT_RE`. */
const EVIDENCE_RECORDED_AT_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/;

/** Shape of the sealed value — mirrors the renderer's `EVIDENCE_DIGEST_RE`. */
const EVIDENCE_DIGEST_RE = /^sha256-v1:[0-9a-f]{64}$/;

/**
 * Split a rule document into its frontmatter block and its body lines.
 *
 * @param {string} content
 * @returns {{ fmLines: string[], bodyLines: string[] }|null} null when the file
 *   has no parseable `--- … ---` frontmatter block.
 */
function splitDocument(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return null;
  const close = lines.indexOf('---', 1);
  if (close === -1) return null;
  return { fmLines: lines.slice(0, close + 1), bodyLines: lines.slice(close + 1) };
}

/**
 * Read a single-line frontmatter scalar's RAW text (no coercion).
 *
 * Raw on purpose: the digest hashes `String(metadata.confidence)`, and the
 * renderer wrote that same string into the frontmatter via template literal —
 * so the bytes on disk ARE the canonical component. Parsing to a Number and
 * re-stringifying would be a second chance to disagree.
 *
 * @param {string[]} fmLines
 * @param {string} key
 * @returns {string|null}
 */
function fmScalar(fmLines, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`);
  for (const line of fmLines) {
    const m = re.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Read a `- <key>: \`<value>\`` line out of the `## Provenance` block.
 *
 * @param {string[]} bodyLines
 * @param {string} key
 * @returns {string|null}
 */
function provenanceToken(bodyLines, key) {
  const re = new RegExp(`^- ${key}: \`(.*)\`\\s*$`);
  for (const line of bodyLines) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * Extract the `## Evidence` block verbatim — the bytes the renderer wrote.
 *
 * Bounded by the next `## ` heading or the next HTML comment
 * (`<!-- untrusted-content:end -->` / the provenance marker), whichever comes
 * first, with trailing blank lines trimmed. Both shapes occur on disk: only 10
 * of the 23 generated rules carry the untrusted envelope; the older ones run
 * straight from `## Evidence` into the next heading.
 *
 * @param {string[]} bodyLines
 * @returns {string|null} null when there is no `## Evidence` heading.
 */
export function extractEvidenceBlock(bodyLines) {
  const start = bodyLines.findIndex((l) => l.trim() === '## Evidence');
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (line.startsWith('## ') || line.startsWith('<!-- ')) break;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

/**
 * Recompute a rule document's digest from ITS OWN BYTES.
 *
 * Opens no other file. This is the offline verification path: five header
 * fields out of `## Provenance` + frontmatter, plus the `## Evidence` block.
 *
 * @param {string} content - the full `.md` document.
 * @returns {{ ok: boolean, reason?: string, stored?: string, computed?: string }}
 */
export function verifyDocument(content) {
  const split = splitDocument(content);
  if (!split) return { ok: false, reason: 'no parseable frontmatter block' };
  const { fmLines, bodyLines } = split;

  const stored = fmScalar(fmLines, 'evidence-digest');
  if (!stored) return { ok: false, reason: 'no evidence-digest frontmatter key' };
  if (!EVIDENCE_DIGEST_RE.test(stored)) {
    return { ok: false, reason: `evidence-digest is malformed: ${stored}` };
  }

  const evidenceBlock = extractEvidenceBlock(bodyLines);
  if (evidenceBlock === null) return { ok: false, reason: 'no ## Evidence block' };

  const recordedLine = bodyLines.find((l) => l.startsWith('- evidence-recorded-at:'));
  const evidenceRecordedAt = recordedLine
    ? recordedLine.slice('- evidence-recorded-at:'.length).trim()
    : '';

  const computed = computeEvidenceDigest({
    learningKey: fmScalar(fmLines, 'learning-key') ?? '',
    learningId: provenanceToken(bodyLines, 'learning-id') ?? '',
    sourceSession: provenanceToken(bodyLines, 'source-session') ?? '',
    evidenceRecordedAt,
    confidence: fmScalar(fmLines, 'confidence') ?? '',
    evidenceBlock,
  });

  return computed === stored
    ? { ok: true, stored, computed }
    : { ok: false, reason: 'digest mismatch — the sealed content changed', stored, computed };
}

/**
 * kebab() as the emitter derives learning keys — mirrors checker.mjs Check 8.
 *
 * @param {string} s
 * @returns {string}
 */
const kebab = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Build `learning-key → created_at` from the (gitignored, possibly absent)
 * learnings store.
 *
 * @param {string} repoRoot
 * @returns {Map<string, string>}
 */
function loadCreatedAtByKey(repoRoot) {
  const map = new Map();
  const p = join(repoRoot, '.orchestrator', 'metrics', 'learnings.jsonl');
  if (!existsSync(p)) return map;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const type = typeof entry.type === 'string' ? entry.type : '';
    const subjectOrTitle =
      (typeof entry.title === 'string' && entry.title !== '' ? entry.title : '') ||
      (typeof entry.subject === 'string' && entry.subject !== '' ? entry.subject : '');
    if (!type || !subjectOrTitle) continue;
    const createdAt = typeof entry.created_at === 'string' ? entry.created_at : '';
    map.set(`${type}/${kebab(subjectOrTitle)}`, createdAt);
  }
  return map;
}

/**
 * Compute the sealed form of one rule document.
 *
 * @param {string} content
 * @param {Map<string, string>} createdAtByKey
 * @returns {{ status: 'sealed'|'skipped'|'unsealable', content?: string,
 *            digest?: string, recordedAt?: string, reason?: string }}
 */
export function sealDocument(content, createdAtByKey) {
  const split = splitDocument(content);
  if (!split) return { status: 'unsealable', reason: 'no parseable frontmatter block' };
  const { fmLines, bodyLines } = split;

  if (fmScalar(fmLines, 'evidence-digest') !== null) {
    return { status: 'skipped', reason: 'already sealed' };
  }

  const learningKey = fmScalar(fmLines, 'learning-key');
  const confidence = fmScalar(fmLines, 'confidence');
  const expiresAtIdx = fmLines.findIndex((l) => l.startsWith('expires-at:'));
  const sourceSessionIdx = bodyLines.findIndex((l) => l.startsWith('- source-session:'));
  const evidenceBlock = extractEvidenceBlock(bodyLines);

  if (!learningKey) return { status: 'unsealable', reason: 'no learning-key' };
  if (confidence === null) return { status: 'unsealable', reason: 'no confidence' };
  if (expiresAtIdx === -1) return { status: 'unsealable', reason: 'no expires-at line' };
  if (sourceSessionIdx === -1) return { status: 'unsealable', reason: 'no - source-session: line' };
  if (evidenceBlock === null) return { status: 'unsealable', reason: 'no ## Evidence block' };

  const rawCreatedAt = createdAtByKey.get(learningKey) ?? '';
  // Never invented. A key that no longer resolves, or a `created_at` that is not
  // an ISO instant, contributes the empty string — see the module doc.
  const evidenceRecordedAt = EVIDENCE_RECORDED_AT_RE.test(rawCreatedAt) ? rawCreatedAt : '';

  const learningId = provenanceToken(bodyLines, 'learning-id') ?? '';
  const sourceSession = provenanceToken(bodyLines, 'source-session') ?? '';

  const digest = computeEvidenceDigest({
    learningKey,
    learningId,
    sourceSession,
    evidenceRecordedAt,
    confidence,
    evidenceBlock,
  });

  // Frontmatter: AFTER `expires-at`, so every key before it keeps its byte
  // position (the renderer appends in the same place, for the same reason).
  const nextFm = [...fmLines];
  nextFm.splice(expiresAtIdx + 1, 0, `evidence-digest: ${digest}`);

  // Body: the same three lines the renderer emits, right after `- source-session:`.
  const nextBody = [...bodyLines];
  nextBody.splice(
    sourceSessionIdx + 1,
    0,
    `- evidence-digest: \`${digest}\``,
    `- evidence-recorded-at: ${evidenceRecordedAt}`,
    '- evidence-digest-input: learning-key \\n learning-id \\n source-session \\n evidence-recorded-at \\n confidence \\n <the `## Evidence` block above, verbatim UTF-8, LF-joined, no trailing newline>',
  );

  return {
    status: 'sealed',
    content: [...nextFm, ...nextBody].join('\n'),
    digest,
    recordedAt: evidenceRecordedAt,
  };
}

/**
 * List every `.claude/rules/*.md` carrying `auto-generated: true`.
 *
 * @param {string} repoRoot
 * @returns {string[]} absolute paths
 */
function generatedRuleFiles(repoRoot) {
  const dir = join(repoRoot, '.claude', 'rules');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => join(dir, f))
    .filter((p) => /^auto-generated:\s*true\s*$/m.test(readFileSync(p, 'utf8')));
}

function main(argv) {
  const apply = argv.includes('--apply');
  const verify = argv.includes('--verify');
  const repoRoot = resolve(process.cwd());
  const explicit = argv.filter((a) => !a.startsWith('--'));

  if (verify) {
    const files = explicit.length > 0 ? explicit.map((f) => resolve(f)) : generatedRuleFiles(repoRoot);
    let ok = 0;
    let bad = 0;
    for (const abs of files) {
      const r = verifyDocument(readFileSync(abs, 'utf8'));
      const rel = relative(repoRoot, abs);
      if (r.ok) {
        ok++;
        console.log(`  VERIFIED  ${rel}`);
      } else {
        bad++;
        console.log(`  FAILED    ${rel} — ${r.reason}`);
        if (r.stored && r.computed) {
          console.log(`            stored:   ${r.stored}`);
          console.log(`            computed: ${r.computed}`);
        }
      }
    }
    console.log(`\nverified ${ok}, failed ${bad}, of ${files.length} file(s) — no learnings.jsonl consulted`);
    process.exit(bad === 0 ? 0 : 1);
  }

  const createdAtByKey = loadCreatedAtByKey(repoRoot);
  const files = generatedRuleFiles(repoRoot);
  let sealed = 0;
  let skipped = 0;
  let unsealable = 0;
  const noDate = [];

  for (const abs of files) {
    const rel = relative(repoRoot, abs);
    const before = readFileSync(abs, 'utf8');
    const r = sealDocument(before, createdAtByKey);
    if (r.status === 'skipped') {
      skipped++;
      continue;
    }
    if (r.status === 'unsealable') {
      unsealable++;
      console.log(`  UNSEALABLE ${rel} — ${r.reason}`);
      continue;
    }
    sealed++;
    if (r.recordedAt === '') noDate.push(rel);
    if (apply) writeFileSync(abs, r.content, 'utf8');
    console.log(
      `  ${apply ? 'SEALED  ' : 'WOULD-SEAL'} ${rel}${r.recordedAt === '' ? '  [evidence-recorded-at: EMPTY — created_at unavailable]' : ''}`,
    );
  }

  console.log(
    `\n${apply ? 'sealed' : 'would seal'} ${sealed}, skipped ${skipped} (already sealed), unsealable ${unsealable}, of ${files.length} auto-generated rule(s)`,
  );
  if (noDate.length > 0) {
    console.log(`\n${noDate.length} rule(s) sealed WITHOUT an evidence-recorded-at (learning-key no longer resolves;`);
    console.log('the date is emitted as the empty digest component and is NEVER invented):');
    for (const rel of noDate) console.log(`  - ${rel}`);
  }
  if (!apply) console.log('\n(dry-run — pass --apply to write)');
  process.exit(unsealable === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
