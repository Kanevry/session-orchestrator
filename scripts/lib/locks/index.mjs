/**
 * locks/index.mjs — convenience barrel for the short-lived lock protocols split
 * out of session-lock.mjs in #630 (A1 barrel-preserving split).
 *
 * Re-exports both protocol modules so a consumer can `import { withStateMdLock,
 * withStagingFenceLock } from '@lib/locks/index.mjs'` in one statement. This is
 * a nice-to-have: session-lock.mjs remains the canonical barrel that preserves
 * the original 22-symbol import surface, and the two protocol modules are also
 * importable directly.
 *
 * Pure re-export leaf — imports only the two sibling modules, never
 * session-lock.mjs, so there is no import cycle.
 */

export {
  STATE_LOCK_PATH,
  DEFAULT_STATE_LOCK_TIMEOUT_MS,
  STATE_LOCK_POLL_MS,
  acquireStateLock,
  releaseStateLock,
  withStateMdLock,
} from './state-md-lock.mjs';

export {
  STAGING_FENCE_LOCK_PATH,
  DEFAULT_STAGING_FENCE_LOCK_TIMEOUT_MS,
  STAGING_FENCE_LOCK_POLL_MS,
  acquireStagingFenceLock,
  releaseStagingFenceLock,
  withStagingFenceLock,
} from './staging-fence-lock.mjs';
