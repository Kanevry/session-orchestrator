#!/usr/bin/env node
/**
 * check-learning-provenance.mjs — census of DANGLING provenance pointers in
 * `.claude/rules/*.md`.
 *
 * ## The defect class
 *
 * Every rule the reconciliation engine emits carries a `## Provenance` block
 * naming the learning it was derived from:
 *
 *     - learning-key: `anti-pattern/some-subject`
 *     - learning-id: `70c9c7b7-d8f3-4363-b170-0b8973d52df3`
 *
 * That pointer is the ONLY link between a live, always-injected instruction and
 * the evidence that justified it. When the pointer rots, the rule becomes
 * unauditable: nobody can re-confidence it, expire it on purpose, or check
 * whether the evidence it cites still holds. It keeps loading forever on the
 * strength of a citation that resolves to nothing.
 *
 * Measured on this repo at 2026-08-12 (`main`, issue #1017): of 13 rule files
 * carrying provenance, 11 cite an id present in NEITHER the live store NOR the
 * archive — 85% of the pointers point at nothing. The rot is invisible to every
 * other gate because a dangling id is still perfectly well-formed Markdown.
 *
 * This check is deterministic — set membership over two JSONL stores — which is
 * exactly why it is worth having: it needs no model, no network, and no
 * judgement call.
 *
 * ## Resolution: live store OR archive
 *
 * A record legitimately MOVES from `learnings.jsonl` into
 * `learnings-archive.jsonl` when it expires past its grace window
 * (`scripts/sweep-expired-learnings.mjs --apply`). Resolving against the live
 * store alone would therefore report every correctly-archived record as rot.
 * Only "present in neither" is a finding.
 *
 * ## Two axes, because an id is not the only pointer
 *
 * The id is the record's UUID; the key (`${type}/${kebab(title||subject)}`) is
 * its LOGICAL identity, stable across a re-write that mints a new UUID. Checking
 * both separates two findings with very different remedies:
 *
 *   `dangling-learning-id`   — neither the id nor the key resolves. The evidence
 *                              is genuinely gone; the rule needs re-derivation
 *                              or retirement.
 *   `superseded-learning-id` — the id does not resolve but the key DOES. The
 *                              record was re-created under a new UUID; the fix
 *                              is a one-line re-stamp of the id, not a
 *                              re-derivation.
 *   `dangling-learning-key`  — a key-only provenance block whose key resolves
 *                              nowhere (same rot, no id to re-stamp).
 *
 * On 2026-08-12 all 11 findings are `dangling-learning-id` (0 superseded), but
 * `superseded` is the state any backfill that re-mints ids lands in, so the two
 * are distinguished at the point where the operator reads the output.
 *
 * ## Mode: WARN, never blocking
 *
 * Findings print as `WARN:` and the runner returns 0. This is deliberate, and
 * mirrors the rationale already written down in `check-unwired-features.mjs`:
 * 11 of 13 pointers dangle at HEAD, so a blocking gate would be red on arrival,
 * and a gate that is red on arrival gets disabled — the same disease this file
 * exists to treat, one level up. It also decouples the gate's green-ness from a
 * backfill landing: the census reports the number, the operator decides.
 * Only a genuine tool error (an unreadable rules directory) prints `FAIL:` and
 * returns 2 — a check that could not run must be visible.
 *
 * ## Defined behaviour for every degenerate input
 *
 *  - No `.claude/rules/` directory, or no `.md` files → PASS, nothing to audit.
 *  - No rule carries provenance → PASS, nothing to audit.
 *  - BOTH stores missing → a single `stores-absent` WARN instead of N dangling
 *    findings. With no evidence corpus present, "dangling" and "not checkable
 *    here" are indistinguishable, and claiming the former would be a lie in any
 *    consumer repo that has not started collecting learnings.
 *  - One store missing → the other still resolves; absence is reported in the
 *    summary and in `stores.*.present`.
 *  - Unparseable JSONL line → skipped by `readLearnings` and COUNTED into
 *    `summary.malformedStoreLines`, which is surfaced in the summary line. The
 *    rest of the store is still used; a corrupt line never silently swallows
 *    the corpus, and never crashes the gate.
 *  - Provenance block with a key but no id → audited on the key axis.
 *  - A single rule file unreadable → skipped with a per-file `tool-error`
 *    finding (printed as WARN, since the census still completes over the rest).
 *    Only the DIRECTORY being unenumerable sets `toolError` and prints FAIL.
 *
 * ## Named residuals (so nobody over-reads the coverage claim)
 *
 *  - **Structured pointers only.** Scope is the list-item form
 *    (`- learning-id:` / `- learning-key:`), which is what the emitter writes.
 *    A HAND-WRITTEN prose citation is not covered — e.g. `.claude/rules/testing.md`
 *    cites `learning id \`mac-gitlab-runner-cpu-starvation-...\`` mid-sentence
 *    for a record that exists nowhere in the repo. Catching that class needs a
 *    free-text scanner with a false-positive budget; this check deliberately
 *    stays on the machine-written form it can resolve exactly.
 *  - **First pointer wins.** The first `- learning-id:` and the first
 *    `- learning-key:` line in a file are audited (mirroring the `grep -m1`
 *    measurement the finding was reported with). Every emitted rule carries
 *    exactly one of each; a hypothetical second id is not audited.
 *  - **Existence, not agreement.** A resolving id whose record has since been
 *    re-worded, re-confidenced, or contradicted still reads as resolved. This
 *    check answers "does the evidence exist", not "does the rule still match
 *    it".
 *
 * ## Read discipline
 *
 * Files are read with `readFileSync`, never via a `grep` spawn. One NUL byte
 * makes a text file invisible to grep-based audits (exit 1, no output, no
 * warning — see the `anti-pattern-a-nul-byte-in-a-tracked-production-file-...`
 * rule; `scripts/lib/reconcile/emitter.mjs` in this very repo is such a file),
 * and a silently-skipped file reads exactly like a file that passed.
 *
 * ## Usage
 *
 *   check-learning-provenance.mjs [<plugin-root>] [--json] [--help]
 *
 * Exit codes:
 *   0 — census completed (findings are WARN-only and do NOT change this)
 *   1 — usage error (unknown flag)
 *   2 — tool error (the rules directory could not be enumerated)
 *
 * Import-safety: importing this module exposes the inspector and runner only;
 * the CLI path is guarded at the bottom of the file.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLearnings } from '../learnings/io.mjs';

/** Directory holding the rule corpus, relative to the plugin root. */
const RULES_REL = path.join('.claude', 'rules');

/** Live learnings store, relative to the plugin root. */
const LIVE_STORE_REL = path.join('.orchestrator', 'metrics', 'learnings.jsonl');

/** Append-only archive sidecar the expiry sweep moves records into. */
const ARCHIVE_STORE_REL = path.join('.orchestrator', 'metrics', 'learnings-archive.jsonl');

/** First `- learning-id: <value>` list item in a rule body. */
const LEARNING_ID_RE = /^[-*][ \t]+learning-id:[ \t]*(.+)$/m;

/** First `- learning-key: <value>` list item in a rule body. */
const LEARNING_KEY_RE = /^[-*][ \t]+learning-key:[ \t]*(.+)$/m;

/**
 * @typedef {{
 *   kind: 'dangling-learning-id' | 'superseded-learning-id' | 'dangling-learning-key'
 *       | 'stores-absent' | 'tool-error',
 *   file: string,
 *   learningId: string | null,
 *   learningKey: string | null,
 *   message: string,
 * }} Finding
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   summary: {
 *     rulesScanned: number,
 *     rulesWithProvenance: number,
 *     resolved: number,
 *     dangling: number,
 *     superseded: number,
 *     malformedStoreLines: number,
 *   },
 *   stores: {
 *     live: {path: string, present: boolean, records: number},
 *     archive: {path: string, present: boolean, records: number},
 *   },
 *   findings: Finding[],
 *   toolError: boolean,
 * }} Inspection
 */

/**
 * Display form of a store path: repo-relative when it sits inside the plugin
 * root, absolute otherwise (a test override or an out-of-tree store).
 *
 * @param {string} pluginRoot
 * @param {string} absolutePath
 * @returns {string}
 */
function displayPath(pluginRoot, absolutePath) {
  const rel = path.relative(pluginRoot, absolutePath);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? absolutePath : rel;
}

/**
 * Slugify into the stable kebab token the reconcile layer uses for learning
 * keys. Duplicated (third copy: `reconcile/renderer.mjs` `kebab()` and
 * `reconcile/engine.mjs` `rejectedLearningKey()`) because neither is exported
 * and both live in modules outside this change's file scope — consolidating the
 * three into one shared helper is a follow-up, not a silent divergence.
 *
 * @param {string} value
 * @returns {string}
 */
function kebab(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Logical key of a learning record: `${type}/${kebab(title||subject)}`, the
 * shape `reconcile/emitter.mjs` stamps into the rule's `learning-key` field.
 * Returns null when either half is unusable, so an unkeyable record simply does
 * not participate in key resolution.
 *
 * @param {Record<string, unknown>} record
 * @returns {string|null}
 */
function learningKeyOf(record) {
  const type = typeof record.type === 'string' ? record.type : '';
  const subjectOrTitle =
    (typeof record.title === 'string' && record.title !== '' ? record.title : '') ||
    (typeof record.subject === 'string' && record.subject !== '' ? record.subject : '');
  if (type === '' || subjectOrTitle === '') return null;
  return `${type}/${kebab(subjectOrTitle)}`;
}

/**
 * Strip the decoration the emitter writes around a provenance value: trailing
 * CR (CRLF files), surrounding backticks, surrounding quotes, and whitespace.
 *
 * @param {string} raw
 * @returns {string}
 */
function cleanValue(raw) {
  return raw
    .replace(/\r$/, '')
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim();
}

/**
 * Extract the first structured provenance pointer pair from a rule body.
 *
 * @param {string} body raw rule-file contents
 * @returns {{id: string|null, key: string|null}}
 */
export function extractProvenance(body) {
  const idMatch = LEARNING_ID_RE.exec(body);
  const keyMatch = LEARNING_KEY_RE.exec(body);
  const id = idMatch ? cleanValue(idMatch[1]) : '';
  const key = keyMatch ? cleanValue(keyMatch[1]) : '';
  return { id: id === '' ? null : id, key: key === '' ? null : key };
}

/**
 * Read one JSONL store into id + logical-key index sets.
 *
 * Never throws: a missing file yields an empty, `present: false` index, and an
 * unparseable line is counted rather than fatal (`readLearnings` isolates it).
 *
 * @param {string} absolutePath
 * @returns {Promise<{present: boolean, records: number, malformed: number, ids: Set<string>, keys: Set<string>}>}
 */
async function indexStore(absolutePath) {
  const present = existsSync(absolutePath);
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {Set<string>} */
  const keys = new Set();
  if (!present) return { present, records: 0, malformed: 0, ids, keys };

  /** @type {{entries: Record<string, unknown>[], malformed: string[]}} */
  let read;
  try {
    read = await readLearnings(absolutePath);
  } catch {
    // An unreadable-but-existing store (permissions, a directory in its place)
    // must not crash the gate. Report it as present-but-empty; every pointer
    // then resolves against the OTHER store, and the zero record count in the
    // summary line is the visible signal that something is wrong here.
    return { present, records: 0, malformed: 0, ids, keys };
  }

  const { entries, malformed } = read;
  for (const entry of entries) {
    if (entry && typeof entry.id === 'string' && entry.id !== '') ids.add(entry.id);
    const key = entry && typeof entry === 'object' ? learningKeyOf(entry) : null;
    if (key !== null) keys.add(key);
  }
  return { present, records: entries.length, malformed: malformed.length, ids, keys };
}

/**
 * Census every `.claude/rules/*.md` provenance pointer against the live store
 * and the archive. Pure with respect to the repo: reads only, writes nothing.
 *
 * @param {string} pluginRoot absolute plugin root
 * @param {{livePath?: string, archivePath?: string}} [opts] store overrides (tests)
 * @returns {Promise<Inspection>}
 */
export async function inspectLearningProvenance(pluginRoot, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const livePath = opts.livePath ?? path.join(pluginRoot, LIVE_STORE_REL);
  const archivePath = opts.archivePath ?? path.join(pluginRoot, ARCHIVE_STORE_REL);

  /** @type {Inspection} */
  const result = {
    ok: false,
    summary: {
      rulesScanned: 0,
      rulesWithProvenance: 0,
      resolved: 0,
      dangling: 0,
      superseded: 0,
      malformedStoreLines: 0,
    },
    stores: {
      live: { path: displayPath(pluginRoot, livePath), present: false, records: 0 },
      archive: { path: displayPath(pluginRoot, archivePath), present: false, records: 0 },
    },
    findings,
    toolError: false,
  };

  const rulesDir = path.join(pluginRoot, RULES_REL);
  if (!existsSync(rulesDir)) {
    result.ok = true;
    return result;
  }

  /** @type {string[]} */
  let ruleFiles;
  try {
    ruleFiles = readdirSync(rulesDir)
      .filter((name) => name.endsWith('.md'))
      .sort();
  } catch (error) {
    result.toolError = true;
    findings.push({
      kind: 'tool-error',
      file: RULES_REL,
      learningId: null,
      learningKey: null,
      message: `cannot enumerate the rules directory: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }
  result.summary.rulesScanned = ruleFiles.length;

  // Collect the pointers BEFORE touching the stores: a corpus with no
  // provenance at all needs no store read.
  /** @type {{file: string, id: string|null, key: string|null}[]} */
  const pointers = [];
  for (const name of ruleFiles) {
    let body;
    try {
      // readFileSync, never a grep spawn — see § Read discipline in the header.
      body = readFileSync(path.join(rulesDir, name), 'utf8');
    } catch (error) {
      findings.push({
        kind: 'tool-error',
        file: path.join(RULES_REL, name),
        learningId: null,
        learningKey: null,
        message: `cannot read rule file: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const { id, key } = extractProvenance(body);
    if (id === null && key === null) continue;
    pointers.push({ file: path.join(RULES_REL, name), id, key });
  }
  result.summary.rulesWithProvenance = pointers.length;

  const [live, archive] = await Promise.all([indexStore(livePath), indexStore(archivePath)]);
  result.stores.live.present = live.present;
  result.stores.live.records = live.records;
  result.stores.archive.present = archive.present;
  result.stores.archive.records = archive.records;
  result.summary.malformedStoreLines = live.malformed + archive.malformed;

  if (pointers.length === 0) {
    result.ok = findings.length === 0;
    return result;
  }

  // No evidence corpus at all → "dangling" is not a claim this check can honestly
  // make. Report the absence once instead of N times.
  if (!live.present && !archive.present) {
    findings.push({
      kind: 'stores-absent',
      file: RULES_REL,
      learningId: null,
      learningKey: null,
      message:
        `${pointers.length} rule file(s) carry provenance but neither ${result.stores.live.path} nor ` +
        `${result.stores.archive.path} exists — pointers cannot be resolved here (not reported as dangling)`,
    });
    return result;
  }

  const idResolves = (/** @type {string} */ id) => live.ids.has(id) || archive.ids.has(id);
  const keyResolves = (/** @type {string} */ key) => live.keys.has(key) || archive.keys.has(key);

  for (const { file, id, key } of pointers) {
    if (id !== null) {
      if (idResolves(id)) {
        result.summary.resolved += 1;
        continue;
      }
      if (key !== null && keyResolves(key)) {
        result.summary.superseded += 1;
        findings.push({
          kind: 'superseded-learning-id',
          file,
          learningId: id,
          learningKey: key,
          message:
            `learning-id \`${id}\` resolves in neither store, but learning-key \`${key}\` does — the record was ` +
            're-created under a new id; re-stamp the learning-id from the record carrying this key',
        });
        continue;
      }
      result.summary.dangling += 1;
      findings.push({
        kind: 'dangling-learning-id',
        file,
        learningId: id,
        learningKey: key,
        message:
          `learning-id \`${id}\`${key === null ? '' : ` (key \`${key}\`)`} resolves in neither the live store ` +
          'nor the archive',
      });
      continue;
    }

    // Key-only provenance block: audit the axis that IS present.
    const presentKey = /** @type {string} */ (key);
    if (keyResolves(presentKey)) {
      result.summary.resolved += 1;
      continue;
    }
    result.summary.dangling += 1;
    findings.push({
      kind: 'dangling-learning-key',
      file,
      learningId: null,
      learningKey: presentKey,
      message:
        `learning-key \`${presentKey}\` matches no record in the live store or the archive, and the block ` +
        'carries no learning-id to resolve instead',
    });
  }

  result.ok = findings.length === 0;
  return result;
}

/**
 * Run the human-readable validator CLI.
 *
 * WARN-ONLY: findings print as WARN and still return 0. See § Mode in the
 * header for why a blocking gate would be red on arrival on this repo.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {Promise<number>} 0 = census completed, 2 = tool error
 */
export async function runCheckLearningProvenance(pluginRoot) {
  console.log('--- Check: learning provenance pointers in .claude/rules/ (WARN-only) ---');
  const inspection = await inspectLearningProvenance(pluginRoot);

  if (inspection.toolError) {
    for (const item of inspection.findings) {
      console.log(`  FAIL: ${item.file} — ${item.message}`);
    }
    console.log('');
    console.log(`Results: 0 passed, ${inspection.findings.length} failed`);
    return 2;
  }

  for (const item of inspection.findings) {
    console.log(`  WARN: [${item.kind}] ${item.file} — ${item.message}`);
  }

  const { rulesScanned, rulesWithProvenance, resolved, dangling, superseded, malformedStoreLines } =
    inspection.summary;
  if (dangling > 0) {
    console.log(
      `  WARN: ${dangling} of ${rulesWithProvenance} provenance pointer(s) resolve in neither ` +
        `${inspection.stores.live.path} nor ${inspection.stores.archive.path} — those rules cite evidence ` +
        'that no longer exists and cannot be re-confidenced, audited, or expired on purpose',
    );
  }
  const storeNote =
    `${inspection.stores.live.records} live + ${inspection.stores.archive.records} archived record(s)` +
    (malformedStoreLines > 0 ? `, ${malformedStoreLines} unparseable store line(s) skipped` : '');
  console.log(
    `  PASS: checked ${rulesWithProvenance} provenance pointer(s) across ${rulesScanned} rule file(s) ` +
      `against ${storeNote} — ${resolved} resolved, ${dangling} dangling, ${superseded} superseded`,
  );
  console.log('');
  console.log('Results: 1 passed, 0 failed');
  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const usage =
    'Usage: check-learning-provenance.mjs [<plugin-root>] [--json]\n' +
    '  --json  emit the inspection envelope as a single JSON object on stdout\n' +
    'Exit: 0 census completed (findings are WARN-only) · 1 usage error · 2 tool error';

  if (flags.has('--help')) {
    console.log(usage);
    process.exitCode = 0;
  } else {
    const unknown = [...flags].filter((f) => f !== '--json' && f !== '--help');
    if (unknown.length > 0) {
      console.error(`Unknown flag(s): ${unknown.join(', ')}\n${usage}`);
      process.exitCode = 1;
    } else {
      const pluginRoot = path.resolve(positional[0] ?? process.cwd());
      if (flags.has('--json')) {
        const inspection = await inspectLearningProvenance(pluginRoot);
        // Data on stdout, diagnostics on stderr (cli-design.md).
        console.log(JSON.stringify(inspection, null, 2));
        process.exitCode = inspection.toolError ? 2 : 0;
      } else {
        process.exitCode = await runCheckLearningProvenance(pluginRoot);
      }
    }
  }
  // Deliberately NOT `process.exit()`: on a pipe, exiting discards stdout writes
  // still queued in the async write buffer (the `--json` envelope can outgrow the
  // ~64 KiB pipe capacity). Setting exitCode lets the writes drain first.
}
