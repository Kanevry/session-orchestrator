/**
 * tmux-shell.mjs — tmux availability detection + session-collision helpers.
 *
 * Issue #561 — ADR-0007 tmux-visualization substrate.
 */

import { execSync } from 'node:child_process';

const MIN_MAJOR = 3;
const MIN_MINOR = 0;

/**
 * Detect tmux availability + version.
 *
 * Supports standard version strings ("tmux 3.4", "tmux 3.4a") and the
 * "next-" prefix used in development builds ("tmux next-3.5").
 *
 * @returns {{ available: boolean, version: string|null, satisfiesMin: boolean, major?: number, minor?: number }}
 */
export function detectTmuxVersion() {
  try {
    const raw = execSync('tmux -V', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    // Supports both "tmux 3.4a" (stable) and "tmux next-3.5" (development builds)
    const match = raw.match(/^tmux\s+(?:next-)?(\d+)\.(\d+)([a-z])?/i);
    if (!match) {
      return { available: true, version: raw, satisfiesMin: false };
    }

    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    const satisfiesMin =
      major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);

    return { available: true, version: raw, satisfiesMin, major, minor };
  } catch (err) {
    if (err.code === 'ENOENT' || err.status === 127) {
      return { available: false, version: null, satisfiesMin: false };
    }
    // Other spawn errors — re-classify as unavailable to be safe
    return { available: false, version: null, satisfiesMin: false };
  }
}

/**
 * Check whether a tmux session with the given name already exists.
 *
 * Runs `tmux has-session -t <name>`: exit 0 means session found, exit 1 means not found.
 *
 * @param {string} sessionName
 * @returns {{ exists: boolean, error?: string }}
 */
export function isSessionCollision(sessionName) {
  if (!sessionName || typeof sessionName !== 'string') {
    return { exists: false, error: 'sessionName must be a non-empty string' };
  }

  try {
    execSync(`tmux has-session -t ${shellQuote(sessionName)}`, {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return { exists: true }; // exit 0 means session found
  } catch (err) {
    if (err.status === 1) return { exists: false }; // exit 1 means no such session
    if (err.code === 'ENOENT') return { exists: false, error: 'tmux not installed' };
    return { exists: false, error: `tmux has-session failed: ${err.message}` };
  }
}

/**
 * Shell-quote a string for safe interpolation into a shell command.
 * Uses single-quote wrapping with embedded single-quote escaping.
 *
 * @param {string} s
 * @returns {string}
 */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
