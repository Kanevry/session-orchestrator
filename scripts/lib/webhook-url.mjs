/**
 * webhook-url.mjs — Centralized webhook URL resolution for session-orchestrator.
 *
 * Replaces ad-hoc hardcoded personal-domain URL fallbacks with a single
 * resolution function that reads from environment variables and Session Config.
 * No personal-domain default exists — callers that need a URL must supply one
 * explicitly via env or config.
 *
 * Resolution order (env wins over config):
 *   1. Environment variable:  SO_WEBHOOK_<KIND>_URL   (e.g. SO_WEBHOOK_SLACK_URL)
 *   2. Session Config field:  webhooks.<kind>.url
 *   3. Error: WebhookConfigError is thrown — no silent fallback to a personal domain.
 *
 * Supported kinds: 'slack' | 'discord' | 'generic' | 'gitlab-pipeline-status'
 *
 * Issue #228 — centralize webhook URL resolution + drop personal-domain default.
 */

// ---------------------------------------------------------------------------
// Named error
// ---------------------------------------------------------------------------

/**
 * Thrown by `resolveWebhookUrl` when no URL source (env or config) provides a
 * webhook URL for the requested kind. Callers should catch this and surface an
 * actionable message to the user.
 */
export class WebhookConfigError extends Error {
  /**
   * @param {string} kind  - The webhook kind that was requested.
   * @param {string} [message] - Optional override; defaults to a descriptive message.
   */
  constructor(kind, message) {
    super(
      message ??
        `No webhook URL configured for kind "${kind}". ` +
          `Set SO_WEBHOOK_${kind.toUpperCase().replace(/-/g, '_')}_URL ` +
          `or add webhooks.${kind}.url to Session Config.`,
    );
    this.name = 'WebhookConfigError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Supported kinds
// ---------------------------------------------------------------------------

/** @type {ReadonlySet<string>} */
const SUPPORTED_KINDS = new Set([
  'slack',
  'discord',
  'generic',
  'gitlab-pipeline-status',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a webhook URL for the given kind.
 *
 * Resolution order:
 *   1. `SO_WEBHOOK_<KIND>_URL` environment variable (e.g. `SO_WEBHOOK_SLACK_URL`)
 *      — kind is upper-cased and hyphens become underscores.
 *   2. `config.webhooks.<kind>.url` — when a Session Config object is provided.
 *   3. Throws {@link WebhookConfigError} — no silent personal-domain fallback.
 *
 * @param {{ kind: string, config?: object }} options
 *   - `kind`   — One of the supported webhook kinds (see SUPPORTED_KINDS).
 *   - `config` — Parsed Session Config object (optional). Must have a `webhooks`
 *                sub-object if a config-based URL is desired.
 * @returns {string}  The resolved webhook URL (guaranteed non-empty string).
 * @throws {WebhookConfigError}  When kind is unsupported or no URL is found.
 * @throws {TypeError}  When `kind` is not a string.
 */
export function resolveWebhookUrl({ kind, config } = {}) {
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError('resolveWebhookUrl: "kind" must be a non-empty string');
  }

  if (!SUPPORTED_KINDS.has(kind)) {
    throw new WebhookConfigError(
      kind,
      `Unsupported webhook kind "${kind}". Supported kinds: ${[...SUPPORTED_KINDS].join(', ')}.`,
    );
  }

  // 1. Environment variable: SO_WEBHOOK_<KIND>_URL
  const envKey = `SO_WEBHOOK_${kind.toUpperCase().replace(/-/g, '_')}_URL`;
  const envUrl = process.env[envKey];
  if (typeof envUrl === 'string' && envUrl.length > 0) {
    return envUrl;
  }

  // 2. Session Config: webhooks.<kind>.url
  const configUrl = config?.webhooks?.[kind]?.url;
  if (typeof configUrl === 'string' && configUrl.length > 0) {
    return configUrl;
  }

  // 3. No source provided a URL — throw rather than fall back to a personal domain.
  throw new WebhookConfigError(kind);
}
