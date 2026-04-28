/**
 * tests/lib/webhook-url.test.mjs
 *
 * Unit tests for scripts/lib/webhook-url.mjs
 * Issue #228 — centralize webhook URL resolution + drop personal-domain default.
 *
 * Covers:
 *   - env-precedence over Session Config
 *   - config-fallback when env is absent
 *   - missing config throws WebhookConfigError
 *   - unknown kind throws WebhookConfigError with descriptive message
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveWebhookUrl,
  WebhookConfigError,
} from '../../scripts/lib/webhook-url.mjs';

// ---------------------------------------------------------------------------
// Env-variable cleanup helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'SO_WEBHOOK_SLACK_URL',
  'SO_WEBHOOK_DISCORD_URL',
  'SO_WEBHOOK_GENERIC_URL',
  'SO_WEBHOOK_GITLAB_PIPELINE_STATUS_URL',
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

// ---------------------------------------------------------------------------
// 1. WebhookConfigError — named error class
// ---------------------------------------------------------------------------

describe('WebhookConfigError', () => {
  it('is an instance of Error', () => {
    const err = new WebhookConfigError('slack');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name "WebhookConfigError"', () => {
    const err = new WebhookConfigError('generic');
    expect(err.name).toBe('WebhookConfigError');
  });

  it('exposes the kind field', () => {
    const err = new WebhookConfigError('discord');
    expect(err.kind).toBe('discord');
  });

  it('includes the kind and env var name in the default message', () => {
    const err = new WebhookConfigError('slack');
    expect(err.message).toContain('slack');
    expect(err.message).toContain('SO_WEBHOOK_SLACK_URL');
  });

  it('accepts a custom message override', () => {
    const err = new WebhookConfigError('generic', 'custom message');
    expect(err.message).toBe('custom message');
  });
});

// ---------------------------------------------------------------------------
// 2. env-precedence over Session Config
// ---------------------------------------------------------------------------

describe('resolveWebhookUrl — env takes precedence over config', () => {
  it('returns the env var URL when SO_WEBHOOK_SLACK_URL is set', () => {
    process.env.SO_WEBHOOK_SLACK_URL = 'https://hooks.slack.com/env-test';
    const config = { webhooks: { slack: { url: 'https://config.example.com/slack' } } };
    const url = resolveWebhookUrl({ kind: 'slack', config });
    expect(url).toBe('https://hooks.slack.com/env-test');
  });

  it('returns the env var URL when SO_WEBHOOK_DISCORD_URL is set', () => {
    process.env.SO_WEBHOOK_DISCORD_URL = 'https://discord.com/api/webhooks/env';
    const url = resolveWebhookUrl({ kind: 'discord' });
    expect(url).toBe('https://discord.com/api/webhooks/env');
  });

  it('hyphenated kind maps to underscored env key', () => {
    process.env.SO_WEBHOOK_GITLAB_PIPELINE_STATUS_URL = 'https://gitlab.example.com/hook';
    const url = resolveWebhookUrl({ kind: 'gitlab-pipeline-status' });
    expect(url).toBe('https://gitlab.example.com/hook');
  });
});

// ---------------------------------------------------------------------------
// 3. config-fallback when env is absent
// ---------------------------------------------------------------------------

describe('resolveWebhookUrl — config fallback', () => {
  it('returns config URL when env var is absent', () => {
    const config = { webhooks: { slack: { url: 'https://config.example.com/slack' } } };
    const url = resolveWebhookUrl({ kind: 'slack', config });
    expect(url).toBe('https://config.example.com/slack');
  });

  it('returns config URL for discord kind', () => {
    const config = { webhooks: { discord: { url: 'https://discord.config.example.com/hook' } } };
    const url = resolveWebhookUrl({ kind: 'discord', config });
    expect(url).toBe('https://discord.config.example.com/hook');
  });

  it('returns config URL for generic kind', () => {
    const config = { webhooks: { generic: { url: 'https://generic.example.com/hook' } } };
    const url = resolveWebhookUrl({ kind: 'generic', config });
    expect(url).toBe('https://generic.example.com/hook');
  });

  it('returns config URL for gitlab-pipeline-status kind', () => {
    const config = {
      webhooks: { 'gitlab-pipeline-status': { url: 'https://gitlab.example.com/pipeline-hook' } },
    };
    const url = resolveWebhookUrl({ kind: 'gitlab-pipeline-status', config });
    expect(url).toBe('https://gitlab.example.com/pipeline-hook');
  });
});

// ---------------------------------------------------------------------------
// 4. missing config throws WebhookConfigError
// ---------------------------------------------------------------------------

describe('resolveWebhookUrl — throws when no source provides a URL', () => {
  it('throws WebhookConfigError when neither env nor config provides a URL', () => {
    expect(() => resolveWebhookUrl({ kind: 'slack' })).toThrow(WebhookConfigError);
  });

  it('throws WebhookConfigError when config is undefined', () => {
    expect(() => resolveWebhookUrl({ kind: 'discord', config: undefined })).toThrow(
      WebhookConfigError,
    );
  });

  it('throws WebhookConfigError when config.webhooks is missing', () => {
    const config = {};
    expect(() => resolveWebhookUrl({ kind: 'generic', config })).toThrow(WebhookConfigError);
  });

  it('throws WebhookConfigError when config.webhooks.<kind> is missing', () => {
    const config = { webhooks: {} };
    expect(() => resolveWebhookUrl({ kind: 'slack', config })).toThrow(WebhookConfigError);
  });

  it('throws WebhookConfigError when config.webhooks.<kind>.url is empty string', () => {
    const config = { webhooks: { slack: { url: '' } } };
    expect(() => resolveWebhookUrl({ kind: 'slack', config })).toThrow(WebhookConfigError);
  });

  it('error message contains the kind name', () => {
    let err;
    try {
      resolveWebhookUrl({ kind: 'generic' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WebhookConfigError);
    expect(err.message).toContain('generic');
    expect(err.message).toContain('SO_WEBHOOK_GENERIC_URL');
  });
});

// ---------------------------------------------------------------------------
// 5. unknown kind throws WebhookConfigError
// ---------------------------------------------------------------------------

describe('resolveWebhookUrl — unknown kind', () => {
  it('throws WebhookConfigError for an unknown kind', () => {
    expect(() => resolveWebhookUrl({ kind: 'teams' })).toThrow(WebhookConfigError);
  });

  it('error message mentions "Unsupported webhook kind" for unknown kind', () => {
    let err;
    try {
      resolveWebhookUrl({ kind: 'teams' });
    } catch (e) {
      err = e;
    }
    expect(err.message).toContain('Unsupported webhook kind');
    expect(err.message).toContain('teams');
  });

  it('throws TypeError when kind is not a string', () => {
    expect(() => resolveWebhookUrl({ kind: 42 })).toThrow(TypeError);
  });

  it('throws TypeError when kind is empty string', () => {
    expect(() => resolveWebhookUrl({ kind: '' })).toThrow(TypeError);
  });
});
