/**
 * telemetry/paths.mjs — host-local telemetry paths (Epic #841).
 *
 * Host-local telemetry paths — constants only, imported by both consent.mjs
 * (policy) and queue.mjs (storage) to avoid a wrong-direction dependency.
 *
 * This module holds NO logic and performs NO I/O beyond computing three path
 * constants under `~/.config/session-orchestrator/` at import time. Because it
 * depends on nothing else in the telemetry tree, both the policy layer
 * (consent.mjs) and the storage layer (queue.mjs) single-source their paths
 * here without either importing the other. The earlier queue.mjs → consent.mjs
 * edge was a wrong-direction dependency — the generic offline queue must not
 * hang off the telemetry consent policy; routing both through this leaf module
 * removes that coupling while keeping a single source of truth for the paths.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

/** Host-local config directory holding all telemetry state. */
export const TELEMETRY_DIR = join(homedir(), '.config', 'session-orchestrator');

/** Default path for the persisted consent record. */
export const TELEMETRY_JSON_PATH = join(TELEMETRY_DIR, 'telemetry.json');

/** Default path for the pending-events send queue (owned by queue.mjs). */
export const TELEMETRY_QUEUE_PATH = join(TELEMETRY_DIR, 'telemetry-queue.ndjson');
