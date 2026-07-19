import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const MANIFEST_KEYS = new Set([
  'name',
  'version',
  'description',
  'keywords',
  'skills',
  'mcpServers',
  'apps',
  'hooks',
  'interface',
]);

const INTERFACE_KEYS = new Set([
  'displayName',
  'shortDescription',
  'longDescription',
  'developerName',
  'category',
  'capabilities',
  'websiteUrl',
  'websiteURL',
  'privacyPolicyUrl',
  'privacyPolicyURL',
  'termsOfServiceUrl',
  'termsOfServiceURL',
  'defaultPrompt',
  'brandColor',
  'composerIcon',
  'logo',
  'logoDark',
  'screenshots',
]);

const REQUIRED_CODEX_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
];

const FORBIDDEN_CODEX_EVENTS = new Set([
  'SessionEnd',
  'PostToolUseFailure',
  'PostToolBatch',
  'CwdChanged',
]);

const DISALLOWED_EDIT_HANDLERS = [
  'enforce-scope.mjs',
  'config-protection.mjs',
  'post-edit-validate.mjs',
  'post-tooluse-frontend-slop.mjs',
];

const CODEX_HOOK_WRAPPER_COMMAND =
  /^SO_PLATFORM=codex CODEX_PLUGIN_ROOT="\$\{PLUGIN_ROOT\}" sh "\$\{PLUGIN_ROOT\}\/hooks\/run-node\.sh" "\$\{PLUGIN_ROOT\}\/hooks\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.mjs)"$/;

/**
 * Parse the exact trusted Codex hook wrapper grammar.
 *
 * @param {unknown} command
 * @returns {{handlerRelativePath: string} | null}
 */
export function parseCodexHookWrapperCommand(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(CODEX_HOOK_WRAPPER_COMMAND);
  return match ? { handlerRelativePath: match[1] } : null;
}

/**
 * Validate the tracked Codex plugin manifest and hook surface.
 *
 * @param {{pluginRoot: string, expectedBaseVersion: string}} options
 * @returns {{ok: boolean, errors: Array<{path: string, rule: string, message: string}>}}
 */
export function validateCodexPluginContract({ pluginRoot, expectedBaseVersion }) {
  const errors = [];
  const root = resolve(String(pluginRoot ?? ''));

  if (typeof pluginRoot !== 'string' || pluginRoot.trim() === '') {
    addError(errors, '$.pluginRoot', 'non-empty-string', 'pluginRoot must be a non-empty string');
    return { ok: false, errors };
  }
  if (typeof expectedBaseVersion !== 'string' || expectedBaseVersion.trim() === '') {
    addError(
      errors,
      '$.expectedBaseVersion',
      'non-empty-string',
      'expectedBaseVersion must be a non-empty string',
    );
  }

  const manifest = readJson(
    resolve(root, '.codex-plugin', 'plugin.json'),
    '.codex-plugin/plugin.json',
    errors,
  );
  if (manifest !== null) validateManifest(manifest, root, expectedBaseVersion, errors);

  const hooksFile = readJson(
    resolve(root, 'hooks', 'hooks-codex.json'),
    'hooks/hooks-codex.json',
    errors,
  );
  if (hooksFile !== null) validateHooksFile(hooksFile, root, expectedBaseVersion, errors);

  return { ok: errors.length === 0, errors };
}

function validateManifest(manifest, root, expectedBaseVersion, errors) {
  if (!isRecord(manifest)) {
    addError(errors, '$.manifest', 'object', '.codex-plugin/plugin.json must contain an object');
    return;
  }

  rejectUnknownKeys(manifest, MANIFEST_KEYS, '$.manifest', errors);

  if (manifest.name !== 'session-orchestrator') {
    addError(errors, '$.manifest.name', 'exact-value', 'name must equal "session-orchestrator"');
  }
  requireNonEmptyString(manifest.description, '$.manifest.description', errors);
  validateVersion(manifest.version, expectedBaseVersion, errors);
  validateStringArray(manifest.keywords, '$.manifest.keywords', errors, { requireNonEmpty: true });

  validatePathCollection(manifest.skills, '$.manifest.skills', 'directory', root, errors, {
    required: true,
  });
  validateMcpServers(manifest.mcpServers, root, errors);
  if (manifest.apps !== undefined) {
    validateContractPath(manifest.apps, '$.manifest.apps', 'file', root, errors);
  }
  validatePathCollection(manifest.hooks, '$.manifest.hooks', 'file', root, errors, {
    required: true,
  });
  validateInterface(manifest.interface, root, errors);
}

function validateVersion(version, expectedBaseVersion, errors) {
  if (typeof version !== 'string') {
    addError(errors, '$.manifest.version', 'version', 'version must be a string');
    return;
  }

  const match = version.match(/^([^+]+)\+codex\.(\d{14})$/);
  if (!match) {
    addError(
      errors,
      '$.manifest.version',
      'codex-cachebuster',
      'version must use <base>+codex.<YYYYMMDDHHmmss>',
    );
    return;
  }

  if (match[1] !== expectedBaseVersion) {
    addError(
      errors,
      '$.manifest.version',
      'base-version',
      `version base '${match[1]}' must equal package version '${expectedBaseVersion}'`,
    );
  }
  if (!isUtcTimestamp(match[2])) {
    addError(
      errors,
      '$.manifest.version',
      'utc-cachebuster',
      `Codex cachebuster '${match[2]}' is not a valid UTC timestamp`,
    );
  }
}

function isUtcTimestamp(value) {
  const parts = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function validateMcpServers(value, root, errors) {
  if (value === undefined) {
    addError(errors, '$.manifest.mcpServers', 'required', 'mcpServers is required');
    return;
  }
  if (isRecord(value)) return;
  validateContractPath(value, '$.manifest.mcpServers', 'file', root, errors);
}

function validateInterface(value, root, errors) {
  if (!isRecord(value)) {
    addError(errors, '$.manifest.interface', 'object', 'interface must be an object');
    return;
  }

  rejectUnknownKeys(value, INTERFACE_KEYS, '$.manifest.interface', errors);
  for (const key of [
    'displayName',
    'shortDescription',
    'longDescription',
    'developerName',
    'category',
    'brandColor',
  ]) {
    if (value[key] !== undefined)
      requireNonEmptyString(value[key], `$.manifest.interface.${key}`, errors);
  }
  for (const key of [
    'websiteUrl',
    'websiteURL',
    'privacyPolicyUrl',
    'privacyPolicyURL',
    'termsOfServiceUrl',
    'termsOfServiceURL',
  ]) {
    if (value[key] !== undefined)
      validateHttpsUrl(value[key], `$.manifest.interface.${key}`, errors);
  }
  if (value.capabilities !== undefined) {
    validateStringArray(value.capabilities, '$.manifest.interface.capabilities', errors);
  }
  validateDefaultPrompts(value.defaultPrompt, errors);

  if (value.composerIcon === undefined) {
    addError(
      errors,
      '$.manifest.interface.composerIcon',
      'required',
      'interface.composerIcon is required',
    );
  } else {
    validateComposerIcon(value.composerIcon, root, errors);
  }
  for (const key of ['logo', 'logoDark']) {
    if (value[key] !== undefined) {
      validateContractPath(value[key], `$.manifest.interface.${key}`, 'file', root, errors);
    }
  }
  if (value.screenshots !== undefined) {
    validatePathCollection(
      value.screenshots,
      '$.manifest.interface.screenshots',
      'file',
      root,
      errors,
    );
  }
}

function validateComposerIcon(value, root, errors) {
  const path = '$.manifest.interface.composerIcon';
  const errorCount = errors.length;
  validateContractPath(value, path, 'file', root, errors);
  if (errors.length !== errorCount) return;

  const target = resolve(root, value.slice(2));
  let content;
  try {
    content = readFileSync(target, 'utf8');
  } catch (error) {
    addError(
      errors,
      path,
      'read-file',
      `cannot read composerIcon file '${value}': ${error.message}`,
    );
    return;
  }

  const trimmed = content.trimStart();
  if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<svg')) {
    addError(
      errors,
      path,
      'svg-content',
      `composerIcon file '${value}' must begin with <?xml or <svg after trimming`,
    );
  }
}

function validateDefaultPrompts(value, errors) {
  if (value === undefined) return;
  const prompts = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(prompts) || prompts.length === 0 || prompts.length > 3) {
    addError(
      errors,
      '$.manifest.interface.defaultPrompt',
      'prompt-list',
      'defaultPrompt must contain one to three strings',
    );
    return;
  }
  prompts.forEach((prompt, index) => {
    if (typeof prompt !== 'string' || prompt.trim() === '' || [...prompt].length > 128) {
      addError(
        errors,
        `$.manifest.interface.defaultPrompt[${index}]`,
        'prompt-string',
        'default prompts must be non-empty strings of at most 128 characters',
      );
    }
  });
}

function validateHooksFile(value, root, expectedBaseVersion, errors) {
  if (!isRecord(value)) {
    addError(errors, '$.hooksFile', 'object', 'hooks/hooks-codex.json must contain an object');
    return;
  }

  rejectUnknownKeys(value, new Set(['description', 'hooks']), '$.hooksFile', errors);
  requireNonEmptyString(value.description, '$.hooksFile.description', errors);
  if (!isRecord(value.hooks)) {
    addError(errors, '$.hooksFile.hooks', 'object', 'hooks must be an object');
    return;
  }

  const eventNames = Object.keys(value.hooks).sort();
  for (const required of REQUIRED_CODEX_EVENTS) {
    if (!Object.hasOwn(value.hooks, required)) {
      addError(
        errors,
        `$.hooksFile.hooks.${required}`,
        'required-event',
        `required Codex event '${required}' is missing`,
      );
    }
  }
  for (const eventName of eventNames) {
    if (FORBIDDEN_CODEX_EVENTS.has(eventName)) {
      addError(
        errors,
        `$.hooksFile.hooks.${eventName}`,
        'unsupported-event',
        `Claude-only event '${eventName}' is unsupported by Codex 0.144.4`,
      );
    } else if (!REQUIRED_CODEX_EVENTS.includes(eventName)) {
      addError(
        errors,
        `$.hooksFile.hooks.${eventName}`,
        'unknown-event',
        `event '${eventName}' is outside the curated Codex project surface`,
      );
    }
  }

  for (const eventName of REQUIRED_CODEX_EVENTS) {
    const groups = value.hooks[eventName];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) {
      addError(
        errors,
        `$.hooksFile.hooks.${eventName}`,
        'array',
        `event '${eventName}' must contain an array of matcher groups`,
      );
      continue;
    }
    groups.forEach((group, groupIndex) => {
      validateMatcherGroup(group, eventName, groupIndex, root, expectedBaseVersion, errors);
    });
  }

  validateSessionStartSurface(value.hooks.SessionStart, expectedBaseVersion, errors);
}

function validateSessionStartSurface(groups, expectedBaseVersion, errors) {
  if (!Array.isArray(groups)) return;
  const handlers = groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []));
  const commands = handlers
    .filter((handler) => handler?.type === 'command' && typeof handler.command === 'string')
    .map((handler) => handler.command);
  const expectedBanner = sessionStartBannerCommand(expectedBaseVersion);

  if (!commands.includes(expectedBanner)) {
    addError(
      errors,
      '$.hooksFile.hooks.SessionStart',
      'versioned-banner',
      `SessionStart must include the exact versioned banner for v${expectedBaseVersion}`,
    );
  }
  const hasSessionStartHandler = commands.some(
    (command) =>
      parseCodexHookWrapperCommand(command)?.handlerRelativePath === 'on-session-start.mjs',
  );
  if (!hasSessionStartHandler) {
    addError(
      errors,
      '$.hooksFile.hooks.SessionStart',
      'session-start-handler',
      'SessionStart must invoke on-session-start.mjs through run-node.sh',
    );
  }
}

function sessionStartBannerCommand(version) {
  return `echo '🎯 Session Orchestrator v${version} — /session [housekeeping|feature|deep] | /plan [new|feature|retro] | /discovery [scope] | /evolve [analyze|review|list]'`;
}

function validateMatcherGroup(group, eventName, groupIndex, root, expectedBaseVersion, errors) {
  const groupPath = `$.hooksFile.hooks.${eventName}[${groupIndex}]`;
  if (!isRecord(group)) {
    addError(errors, groupPath, 'object', 'matcher group must be an object');
    return;
  }
  if (group.matcher !== undefined && typeof group.matcher !== 'string') {
    addError(errors, `${groupPath}.matcher`, 'string', 'matcher must be a string');
  }
  if (!Array.isArray(group.hooks)) {
    addError(errors, `${groupPath}.hooks`, 'array', 'matcher group hooks must be an array');
    return;
  }
  group.hooks.forEach((handler, handlerIndex) => {
    validateHandler(
      handler,
      `${groupPath}.hooks[${handlerIndex}]`,
      eventName,
      root,
      expectedBaseVersion,
      errors,
    );
  });
}

function validateHandler(handler, path, eventName, root, expectedBaseVersion, errors) {
  if (!isRecord(handler)) {
    addError(errors, path, 'object', 'hook handler must be an object');
    return;
  }
  if (handler.type !== 'command') {
    addError(
      errors,
      `${path}.type`,
      'synchronous-command',
      `handler type '${String(handler.type)}' is unsupported; use 'command'`,
    );
    return;
  }
  if (handler.async === true) {
    addError(errors, `${path}.async`, 'synchronous', 'Codex project handlers must be synchronous');
  } else if (handler.async !== undefined && typeof handler.async !== 'boolean') {
    addError(errors, `${path}.async`, 'boolean', 'async must be a boolean when present');
  }
  if (typeof handler.command !== 'string' || handler.command.trim() === '') {
    addError(errors, `${path}.command`, 'non-empty-string', 'command must be a non-empty string');
    return;
  }

  const command = handler.command;
  if (eventName === 'SessionStart' && command === sessionStartBannerCommand(expectedBaseVersion)) {
    return;
  }
  const parsed = parseCodexHookWrapperCommand(command);
  if (parsed === null) {
    addError(
      errors,
      `${path}.command`,
      'trusted-wrapper',
      'command must exactly match the trusted Codex run-node.sh wrapper grammar',
    );
    return;
  }

  const { handlerRelativePath } = parsed;
  if (DISALLOWED_EDIT_HANDLERS.includes(handlerRelativePath)) {
    addError(
      errors,
      `${path}.command`,
      'unsupported-edit-payload',
      `${handlerRelativePath} does not support canonical Codex apply_patch payloads`,
    );
  }

  const handlerPath = resolve(root, 'hooks', handlerRelativePath);
  if (!existsSync(handlerPath) || !safeIsType(handlerPath, 'file')) {
    addError(
      errors,
      `${path}.command`,
      'handler-file',
      `referenced handler 'hooks/${handlerRelativePath}' must exist as a file`,
    );
  }
}

function validatePathCollection(value, path, kind, root, errors, options = {}) {
  if (value === undefined) {
    if (options.required) addError(errors, path, 'required', `${path} is required`);
    return;
  }
  const paths = Array.isArray(value) ? value : [value];
  if (paths.length === 0) {
    addError(errors, path, 'non-empty-paths', `${path} must contain at least one path`);
    return;
  }
  paths.forEach((entry, index) => {
    validateContractPath(
      entry,
      Array.isArray(value) ? `${path}[${index}]` : path,
      kind,
      root,
      errors,
    );
  });
}

function validateContractPath(value, path, kind, root, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    addError(errors, path, 'path-string', `${path} must be a non-empty string path`);
    return;
  }
  if (!value.startsWith('./')) {
    addError(errors, path, 'relative-path', `${path} must start with './'`);
    return;
  }

  const relative = value.slice(2);
  if (relative === '' || relative.split(/[\\/]/).includes('..')) {
    addError(errors, path, 'no-traversal', `${path} must not be './' or contain '..' traversal`);
    return;
  }

  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    addError(errors, path, 'within-plugin-root', `${path} must resolve inside pluginRoot`);
    return;
  }
  if (!existsSync(target)) {
    addError(errors, path, 'exists', `${path} target '${value}' does not exist`);
    return;
  }
  if (!safeIsType(target, kind)) {
    addError(errors, path, kind, `${path} target '${value}' must be a ${kind}`);
  }
}

function safeIsType(path, kind) {
  try {
    const stats = statSync(path);
    return kind === 'directory' ? stats.isDirectory() : stats.isFile();
  } catch {
    return false;
  }
}

function validateHttpsUrl(value, path, errors) {
  if (typeof value === 'string') {
    try {
      if (new URL(value).protocol === 'https:') return;
    } catch {
      // Report the shared validation error below.
    }
  }
  addError(errors, path, 'https-url', `${path} must be an absolute https URL`);
}

function validateStringArray(value, path, errors, options = {}) {
  if (!Array.isArray(value) || (options.requireNonEmpty && value.length === 0)) {
    addError(errors, path, 'string-array', `${path} must be an array of strings`);
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      addError(errors, `${path}[${index}]`, 'non-empty-string', `${path} entries must be strings`);
    }
  });
}

function requireNonEmptyString(value, path, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    addError(errors, path, 'non-empty-string', `${path} must be a non-empty string`);
  }
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) {
      addError(errors, `${path}.${key}`, 'unknown-key', `unsupported key '${key}'`);
    }
  }
}

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    addError(errors, label, 'read-json', `cannot read valid JSON: ${error.message}`);
    return null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addError(errors, path, rule, message) {
  errors.push({ path, rule, message });
}
