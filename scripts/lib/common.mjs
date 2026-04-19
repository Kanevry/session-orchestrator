/**
 * common.mjs — Shared I/O utilities for session-orchestrator scripts.
 *
 * Pure ESM, Node stdlib only. Replaces the generic helpers from common.sh.
 *
 * Part of v3.0.0 migration (Epic #124, issue #136).
 */

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns a unique temp path (does NOT create the file/directory).
 * @param {string} prefix - non-empty string prepended to the filename
 * @returns {string}
 */
export function makeTmpPath(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('makeTmpPath: prefix must be a non-empty string');
  }
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${rand}`);
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/** Returns the current time as an ISO 8601 UTC string. */
export function utcTimestamp() {
  return new Date().toISOString();
}

/** Returns the current Unix time in milliseconds. */
export function epochMs() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// JSON file helpers
// ---------------------------------------------------------------------------

/**
 * Reads and parses a JSON file; throws on missing file or parse error.
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Serialises obj as pretty-printed JSON and writes it to filePath,
 * creating any missing parent directories automatically.
 * @param {string} filePath
 * @param {unknown} obj
 * @returns {Promise<void>}
 */
export async function writeJson(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Appends obj as a single JSONL line to filePath, creating missing parent
 * directories automatically. Single appendFile call — atomic for lines under
 * PIPE_BUF (4 KiB).
 * @param {string} filePath
 * @param {unknown} obj
 * @returns {Promise<void>}
 */
export async function appendJsonl(filePath, obj) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(obj) + '\n', 'utf8');
}
