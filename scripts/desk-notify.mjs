#!/usr/bin/env node
/**
 * desk-notify.mjs — the Notification hook of this repo's `.claude/settings.json`,
 * gated by the Orchestrator Desk presence (#2176, Desk contract § Zustellung).
 *
 * Shows the macOS notification only when `notificationAllowed()` says so: at
 * the desk, when away only with `unblock = reach`, and as before when the desk
 * files do not exist at all. Night, vacation and a broken or stale desk file
 * stay silent. Records the read in `desk/gelesen/so-notify.json` (≤ 1/min).
 *
 * Never fails the hook: every error ends in exit 0 without output.
 */

import process from 'node:process';

import { markRead, notificationAllowed, readDeskFiles, ruleValue } from './lib/desk-rules.mjs';
import { execFile } from './lib/native-command.mjs';

const MESSAGE = 'Claude Code wartet auf Input';
const TITLE = 'Claude Code';

try {
  const now = new Date();
  const reading = readDeskFiles();
  const verdict = notificationAllowed(reading, now);
  // gelesen carries a rule value; delivery hangs on `unblock` (reach) beside the presence.
  markRead('so-notify', ruleValue('unblock', reading, now), { now });
  if (verdict.show && process.platform === 'darwin') {
    execFile('osascript', ['-e', `display notification "${MESSAGE}" with title "${TITLE}"`], () => {});
  }
} catch { /* a notification is never worth a failing hook */ }
