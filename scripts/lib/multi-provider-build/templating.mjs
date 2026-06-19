/**
 * scripts/lib/multi-provider-build/templating.mjs
 *
 * Single-source → many-provider templating (PoC). One source document with
 * provider-conditional blocks + placeholders renders to a provider-specific
 * artifact. This replaces the "maintain N near-identical copies by hand" model
 * our codex-install.mjs / cursor-install.mjs currently imply.
 *
 * Two primitives (clean-room reimplementation of impeccable's mechanic):
 *   1. compileProviderBlocks(content, activeTags)
 *        <codex> … </codex> blocks: keep body iff the tag is active, else drop.
 *        Unknown tags are left untouched (so real HTML/JSX isn't mangled).
 *   2. replacePlaceholders(content, providerKey, opts)
 *        {{model}} {{config_file}} {{command_prefix}} {{ask_instruction}}
 *        {{available_commands}} substitution + optional /cmd → $cmd rewrite.
 *
 * renderForProvider() composes both in the correct order (blocks first, then
 * placeholders — matching impeccable's pipeline).
 */

import { PROVIDERS, ALL_BLOCK_TAGS } from './providers.mjs';

/**
 * Keep `<tag>…</tag>` blocks whose tag is in `activeTags`; strip the rest.
 * Only tags in `knownTags` are treated as conditional blocks — any other
 * `<foo>…</foo>` (e.g. real markup) is left exactly as-is.
 *
 * Tags must sit on their own line, e.g.:
 *   <codex>
 *   Codex-only text.
 *   </codex>
 *
 * @param {string} content
 * @param {Iterable<string>} activeTags
 * @param {Iterable<string>} [knownTags] — defaults to ALL_BLOCK_TAGS
 * @returns {string}
 */
export function compileProviderBlocks(content, activeTags, knownTags = ALL_BLOCK_TAGS) {
  const active = new Set(activeTags);
  const known = new Set(knownTags);
  let compiledAny = false;

  // Match a block: leading newline (or start), <tag> on its own line, body,
  // </tag> on its own line. Non-greedy body; the backreference enforces matching.
  const blockRe = /(^|\r?\n)[ \t]*<([a-z][a-z0-9-]*)>[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<\/\2>[ \t]*(?=\r?\n|$)/g;

  const out = content.replace(blockRe, (match, prefix, tag, body) => {
    if (!known.has(tag)) return match; // not a provider block — leave untouched
    compiledAny = true;
    return active.has(tag) ? `${prefix}${body}` : prefix;
  });

  // Collapse the 3+ blank-line runs that stripping can leave behind.
  return compiledAny ? out.replace(/(\r?\n){3,}/g, '\n\n') : out;
}

/**
 * Substitute {{placeholders}} for a provider and (optionally) rewrite command
 * invocations from `/name` to the provider's prefix.
 *
 * @param {string} content
 * @param {string} providerKey
 * @param {{ commandNames?: string[] }} [opts]
 * @returns {string}
 */
export function replacePlaceholders(content, providerKey, opts = {}) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`Unknown provider: ${providerKey}`);
  const { model, configFile, commandPrefix, askInstruction } = provider.placeholders;
  const commandNames = opts.commandNames ?? [];

  const availableCommands = commandNames.map((n) => `${commandPrefix}${n}`).join(', ');

  let result = content
    .replace(/\{\{model\}\}/g, model)
    .replace(/\{\{config_file\}\}/g, configFile)
    .replace(/\{\{ask_instruction\}\}/g, askInstruction)
    .replace(/\{\{available_commands\}\}/g, availableCommands)
    .replace(/\{\{command_prefix\}\}/g, commandPrefix);

  // Rewrite `/cmd` invocations to the provider prefix (e.g. Codex uses `$`).
  // Longest names first so `/session-end` is rewritten before `/session`.
  if (commandPrefix !== '/' && commandNames.length > 0) {
    const sorted = [...commandNames].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      // `/name` where name is followed by a non-identifier char or end.
      const re = new RegExp(`\\/(${escapeRegex(name)})(?=[^a-zA-Z0-9_-]|$)`, 'g');
      // Use a replacement FUNCTION, not a string — a `$` commandPrefix would
      // otherwise collide with String.replace's `$$`/`$1` escape syntax.
      result = result.replace(re, (_match, g1) => `${commandPrefix}${g1}`);
    }
  }

  return result;
}

/**
 * Render a source document for a single provider: compile blocks, then
 * substitute placeholders.
 *
 * @param {string} source
 * @param {string} providerKey
 * @param {{ commandNames?: string[] }} [opts]
 * @returns {string}
 */
export function renderForProvider(source, providerKey, opts = {}) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`Unknown provider: ${providerKey}`);
  const compiled = compileProviderBlocks(source, provider.tags);
  return replacePlaceholders(compiled, providerKey, opts);
}

/**
 * Render a source for every configured provider.
 * @param {string} source
 * @param {{ commandNames?: string[] }} [opts]
 * @returns {Record<string,string>} keyed by provider key
 */
export function renderAll(source, opts = {}) {
  const out = {};
  for (const key of Object.keys(PROVIDERS)) {
    out[key] = renderForProvider(source, key, opts);
  }
  return out;
}

/** @param {string} s */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
