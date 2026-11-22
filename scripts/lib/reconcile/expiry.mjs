import { deriveExpiresAt } from '../learnings/schema.mjs';

export const DAY_MS = 86400 * 1000;

/**
 * Resolve the shared expiry before the emitter applies its minimum lifetime.
 * An explicit rule-expiry-days stays a flat window for all types. A persisted
 * expires_at can extend the per-type TTL when no override is set (#2119).
 *
 * @param {object} learning
 * @param {number|undefined} ruleExpiryDays
 * @param {number} nowMs - fallback clock for missing or unparseable created_at
 * @returns {number} expiry as epoch milliseconds
 */
export function resolveRuleExpiryMs(learning, ruleExpiryDays, nowMs) {
  if (Number.isFinite(ruleExpiryDays)) {
    const createdMs = Date.parse(learning.created_at);
    const baseMs = Number.isFinite(createdMs) ? createdMs : nowMs;
    return baseMs + ruleExpiryDays * DAY_MS;
  }

  let createdAt = learning.created_at;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    createdAt = new Date(nowMs).toISOString();
  }
  const naturalExpiryMs = Date.parse(deriveExpiresAt(createdAt, learning.type));
  const extendedExpiryMs = typeof learning.expires_at === 'string'
    ? Date.parse(learning.expires_at) : NaN;
  return Number.isFinite(extendedExpiryMs)
    ? Math.max(naturalExpiryMs, extendedExpiryMs) : naturalExpiryMs;
}
