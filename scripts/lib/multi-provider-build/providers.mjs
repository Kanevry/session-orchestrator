/**
 * scripts/lib/multi-provider-build/providers.mjs
 *
 * Provider configuration for the single-source → many-provider build PoC.
 *
 * Scope: the THREE harnesses session-orchestrator actually targets
 * (Claude Code primary, Codex CLI, Cursor IDE). Inspired by pbakaus/impeccable's
 * 12-provider build (Apache-2.0) — we deliberately keep the templating mechanic
 * and drop the 12-provider breadth (maintenance ≫ value for providers with ~0
 * users; see the linked backlog issue's overengineering verdict).
 *
 * Each provider entry:
 *   {
 *     key,            // canonical id used in build output paths
 *     tags,           // <tag> block markers this provider keeps (rest are stripped)
 *     configDir,      // on-disk harness dir
 *     placeholders: { model, configFile, commandPrefix, askInstruction }
 *   }
 */

/** @typedef {{key:string, tags:string[], configDir:string, placeholders:{model:string, configFile:string, commandPrefix:string, askInstruction:string}}} ProviderConfig */

/** @type {Record<string, ProviderConfig>} */
export const PROVIDERS = {
  'claude-code': {
    key: 'claude-code',
    tags: ['claude-code', 'claude'],
    configDir: '.claude',
    placeholders: {
      model: 'Claude',
      configFile: 'CLAUDE.md',
      commandPrefix: '/',
      askInstruction: 'STOP and call the AskUserQuestion tool to clarify.',
    },
  },
  codex: {
    key: 'codex',
    tags: ['codex'],
    configDir: '.codex',
    placeholders: {
      model: 'GPT',
      configFile: 'AGENTS.md',
      commandPrefix: '$',
      askInstruction: "STOP and use Codex's structured user-input tool to clarify.",
    },
  },
  cursor: {
    key: 'cursor',
    tags: ['cursor'],
    configDir: '.cursor',
    placeholders: {
      model: 'the model',
      configFile: '.cursorrules',
      commandPrefix: '/',
      askInstruction: 'ask the user directly to clarify before proceeding.',
    },
  },
};

/** The full set of recognized provider block tags across ALL providers. */
export const ALL_BLOCK_TAGS = new Set(Object.values(PROVIDERS).flatMap((p) => p.tags));

/** Provider keys in a stable order. */
export const PROVIDER_KEYS = Object.keys(PROVIDERS);
