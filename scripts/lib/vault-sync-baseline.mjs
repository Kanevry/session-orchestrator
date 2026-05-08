/**
 * vault-sync-baseline.mjs — Snapshot writer + diff comparator for vault-sync #327.
 *
 * Pure functions (no top-level side effects). The only function that writes to
 * disk is `writeBaseline()`, which uses an atomic write-temp-then-rename pattern
 * identical to the one used in scripts/lib/learnings.mjs.
 *
 * Exports:
 *   computeSchemaHash(schemaText)                → string (8-char SHA-256 hex prefix)
 *   writeBaseline(filePath, payload)              → void  (atomic fs write)
 *   readBaseline(filePath)                        → object|null
 *   diffBaseline({ baselineErrors, currentErrors }) → DiffResult
 *
 * No external dependencies — Node 20+ stdlib (node:crypto, node:fs, node:path) only.
 *
 * Issue: #327 vault-sync baseline-diff reporting.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// computeSchemaHash
// ---------------------------------------------------------------------------

/**
 * Compute a stable 8-character SHA-256 hex prefix of the given schema text.
 *
 * The caller is responsible for extracting the relevant text (e.g. the block
 * between BEGIN/END GENERATED SCHEMA sentinels in validator.mjs).
 *
 * @param {string} schemaText
 * @returns {string} 8-character lowercase hex prefix of SHA-256 digest
 */
export function computeSchemaHash(schemaText) {
  return createHash('sha256').update(schemaText, 'utf8').digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// writeBaseline
// ---------------------------------------------------------------------------

/**
 * Serialize a baseline snapshot to disk using an atomic write-temp-then-rename
 * pattern. Creates intermediate directories if needed.
 *
 * @param {string} filePath  Absolute path to the target baseline JSON file.
 * @param {{ errors: object[], warnings: object[], schemaHash: string, isoTimestamp: string, vaultDir: string }} payload
 * @returns {void}
 */
export function writeBaseline(filePath, { errors, warnings, schemaHash, isoTimestamp, vaultDir }) {
  const doc = {
    schema_hash: schemaHash,
    generated_at: isoTimestamp,
    vault_dir: vaultDir,
    error_count: errors.length,
    warning_count: warnings.length,
    errors,
    warnings,
  };

  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// readBaseline
// ---------------------------------------------------------------------------

/**
 * Read and parse a baseline snapshot file.
 *
 * Returns null (never throws) if the file is missing, unreadable, or
 * contains malformed JSON or an unexpected shape.
 *
 * @param {string} filePath  Absolute path to the baseline JSON file.
 * @returns {{ schemaHash: string, errors: object[], warnings: object[], generated_at: string, vault_dir: string, error_count: number, warning_count: number } | null}
 */
export function readBaseline(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const doc = JSON.parse(raw);
    if (
      typeof doc !== 'object' ||
      doc === null ||
      typeof doc.schema_hash !== 'string' ||
      !Array.isArray(doc.errors) ||
      !Array.isArray(doc.warnings)
    ) {
      return null;
    }
    return {
      schemaHash: doc.schema_hash,
      generated_at: doc.generated_at ?? '',
      vault_dir: doc.vault_dir ?? '',
      error_count: doc.error_count ?? doc.errors.length,
      warning_count: doc.warning_count ?? doc.warnings.length,
      errors: doc.errors,
      warnings: doc.warnings,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// diffBaseline
// ---------------------------------------------------------------------------

/**
 * Compute a set-difference between a baseline error (or warning) array and the
 * current run's array. Identity is determined by the triple (file, path, message).
 *
 * Call once for errors, once for warnings — the function is symmetric.
 *
 * @param {{ baselineErrors: object[], currentErrors: object[] }} opts
 * @returns {{ newErrors: object[], resolvedErrors: object[], baselineCount: number, currentCount: number }}
 */
export function diffBaseline({ baselineErrors, currentErrors }) {
  /**
   * Build a stable string key from an error/warning entry.
   * Falls back gracefully when fields are missing.
   *
   * @param {object} e
   * @returns {string}
   */
  function entryKey(e) {
    const file = e.file ?? '';
    const path = e.path ?? (e.type ?? '');
    const message = e.message ?? '';
    return `${file}\x00${path}\x00${message}`;
  }

  const baselineSet = new Set((baselineErrors ?? []).map(entryKey));
  const currentSet = new Set((currentErrors ?? []).map(entryKey));

  const newErrors = (currentErrors ?? []).filter((e) => !baselineSet.has(entryKey(e)));
  const resolvedErrors = (baselineErrors ?? []).filter((e) => !currentSet.has(entryKey(e)));

  return {
    newErrors,
    resolvedErrors,
    baselineCount: (baselineErrors ?? []).length,
    currentCount: (currentErrors ?? []).length,
  };
}
