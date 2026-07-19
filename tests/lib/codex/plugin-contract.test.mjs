import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCodexHookWrapperCommand,
  validateCodexPluginContract,
} from '../../../scripts/lib/codex/plugin-contract.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EXPECTED_VERSION = '3.14.0';
const REQUIRED_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
];

let fixtureRoot;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

function validCommand(handler = 'on-stop.mjs') {
  return `SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${'${PLUGIN_ROOT}'}" sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh" "${'${PLUGIN_ROOT}'}/hooks/${handler}"`;
}

function validBannerCommand() {
  return `echo '🎯 Session Orchestrator v${EXPECTED_VERSION} — /session [housekeeping|feature|deep] | /plan [new|feature|retro] | /discovery [scope] | /evolve [analyze|review|list]'`;
}

function validManifest() {
  return {
    name: 'session-orchestrator',
    version: `${EXPECTED_VERSION}+codex.20260717175716`,
    description: 'Fixture Codex plugin',
    keywords: ['codex', 'sessions'],
    skills: './skills/',
    hooks: './hooks/hooks-codex.json',
    mcpServers: './.mcp.json',
    interface: {
      displayName: 'Session Orchestrator',
      composerIcon: './assets/icon.svg',
      defaultPrompt: ['Start a structured feature session'],
    },
  };
}

function validHooks() {
  const hooks = Object.fromEntries(REQUIRED_EVENTS.map((event) => [event, []]));
  hooks.SessionStart = [
    {
      matcher: 'startup|resume|clear|compact',
      hooks: [
        { type: 'command', command: validBannerCommand(), async: false },
        { type: 'command', command: validCommand('on-session-start.mjs') },
      ],
    },
  ];
  hooks.Stop = [{ matcher: '', hooks: [{ type: 'command', command: validCommand() }] }];
  return { description: 'Codex hooks fixture', hooks };
}

function makeFixture() {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-contract-'));
  mkdirSync(join(fixtureRoot, '.codex-plugin'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'skills'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'hooks'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'assets'), { recursive: true });
  writeFileSync(join(fixtureRoot, '.mcp.json'), '{"mcpServers":{}}');
  writeFileSync(join(fixtureRoot, 'assets', 'icon.svg'), '<svg/>');
  writeFileSync(join(fixtureRoot, 'hooks', 'run-node.sh'), '#!/bin/sh\n');
  writeFileSync(join(fixtureRoot, 'hooks', 'on-session-start.mjs'), '// fixture\n');
  writeFileSync(join(fixtureRoot, 'hooks', 'on-stop.mjs'), '// fixture\n');
  writeManifest(validManifest());
  writeHooks(validHooks());
  return fixtureRoot;
}

function writeManifest(manifest) {
  writeFileSync(join(fixtureRoot, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest));
}

function writeHooks(hooks) {
  writeFileSync(join(fixtureRoot, 'hooks', 'hooks-codex.json'), JSON.stringify(hooks));
}

function validateFixture() {
  return validateCodexPluginContract({
    pluginRoot: fixtureRoot,
    expectedBaseVersion: EXPECTED_VERSION,
  });
}

function expectRule(verdict, rule) {
  expect(verdict.ok).toBe(false);
  expect(verdict.errors.map((error) => error.rule)).toContain(rule);
}

describe('parseCodexHookWrapperCommand', () => {
  it('parses the exact trusted wrapper grammar', () => {
    expect(parseCodexHookWrapperCommand(validCommand('nested/on-stop.mjs'))).toEqual({
      handlerRelativePath: 'nested/on-stop.mjs',
    });
  });

  it.each([
    ['arbitrary prefix', `DEBUG=1 ${validCommand()}`],
    [
      'missing environment prefix',
      `sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh" "${'${PLUGIN_ROOT}'}/hooks/on-stop.mjs"`,
    ],
    [
      'root mismatch',
      `SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${'${CODEX_PLUGIN_ROOT}'}" sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh" "${'${PLUGIN_ROOT}'}/hooks/on-stop.mjs"`,
    ],
    [
      'missing handler',
      `SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${'${PLUGIN_ROOT}'}" sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh"`,
    ],
    ['trailing command', `${validCommand()}; echo injected`],
    [
      'unsafe traversal path',
      `SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${'${PLUGIN_ROOT}'}" sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh" "${'${PLUGIN_ROOT}'}/hooks/../outside.mjs"`,
    ],
  ])('rejects an exact-grammar violation: %s', (_case, command) => {
    expect(parseCodexHookWrapperCommand(command)).toBeNull();
  });
});

describe('validateCodexPluginContract', () => {
  it('passes against the real repository contract', () => {
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const verdict = validateCodexPluginContract({
      pluginRoot: REPO_ROOT,
      expectedBaseVersion: packageJson.version,
    });

    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it('returns a deterministic structured verdict for a valid fixture', () => {
    makeFixture();

    expect(validateFixture()).toEqual({ ok: true, errors: [] });
  });

  it('rejects an unknown manifest key', () => {
    makeFixture();
    writeManifest({ ...validManifest(), author: 'unsupported' });

    expectRule(validateFixture(), 'unknown-key');
  });

  it('rejects an unknown interface key', () => {
    makeFixture();
    writeManifest({
      ...validManifest(),
      interface: { ...validManifest().interface, unsupportedField: true },
    });

    const verdict = validateFixture();
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContainEqual({
      path: '$.manifest.interface.unsupportedField',
      rule: 'unknown-key',
      message: "unsupported key 'unsupportedField'",
    });
  });

  it('rejects a base-version mismatch', () => {
    makeFixture();
    writeManifest({ ...validManifest(), version: '9.9.9+codex.20260717175716' });

    expectRule(validateFixture(), 'base-version');
  });

  it('rejects an invalid Codex cachebuster suffix', () => {
    makeFixture();
    writeManifest({ ...validManifest(), version: `${EXPECTED_VERSION}+codex.latest` });

    expectRule(validateFixture(), 'codex-cachebuster');
  });

  it('rejects a path without the required ./ prefix', () => {
    makeFixture();
    writeManifest({ ...validManifest(), skills: 'skills/' });

    expectRule(validateFixture(), 'relative-path');
  });

  it('rejects a traversing path', () => {
    makeFixture();
    writeManifest({ ...validManifest(), hooks: './../hooks/hooks-codex.json' });

    expectRule(validateFixture(), 'no-traversal');
  });

  it('rejects a missing path target', () => {
    makeFixture();
    writeManifest({ ...validManifest(), mcpServers: './missing.json' });

    expectRule(validateFixture(), 'exists');
  });

  it('rejects a path whose target type is wrong', () => {
    makeFixture();
    writeManifest({ ...validManifest(), skills: './.mcp.json' });

    expectRule(validateFixture(), 'directory');
  });

  it('rejects a missing composerIcon field', () => {
    makeFixture();
    const manifest = validManifest();
    delete manifest.interface.composerIcon;
    writeManifest(manifest);

    expectRule(validateFixture(), 'required');
  });

  it('rejects a missing composerIcon file', () => {
    makeFixture();
    writeManifest({
      ...validManifest(),
      interface: { ...validManifest().interface, composerIcon: './assets/missing.svg' },
    });

    expectRule(validateFixture(), 'exists');
  });

  it('rejects composerIcon content that is not SVG', () => {
    makeFixture();
    writeFileSync(join(fixtureRoot, 'assets', 'icon.svg'), 'not svg content');

    expectRule(validateFixture(), 'svg-content');
  });

  it.each([
    ['a direct SVG root', '  <svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an XML declaration', '\n<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
  ])('accepts composerIcon content beginning with %s after trimming', (_case, content) => {
    makeFixture();
    writeFileSync(join(fixtureRoot, 'assets', 'icon.svg'), content);

    expect(validateFixture()).toEqual({ ok: true, errors: [] });
  });

  it('rejects an unknown hooks-file key', () => {
    makeFixture();
    writeHooks({ ...validHooks(), _comment: 'unsupported' });

    expectRule(validateFixture(), 'unknown-key');
  });

  it('rejects an unsupported Claude-only event', () => {
    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.SessionEnd = [];
    writeHooks(hooksFile);

    expectRule(validateFixture(), 'unsupported-event');
  });

  it('rejects an event outside the curated Codex surface', () => {
    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.CustomEvent = [];
    writeHooks(hooksFile);

    const verdict = validateFixture();
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContainEqual({
      path: '$.hooksFile.hooks.CustomEvent',
      rule: 'unknown-event',
      message: "event 'CustomEvent' is outside the curated Codex project surface",
    });
  });

  it('rejects a missing required event', () => {
    makeFixture();
    const hooksFile = validHooks();
    delete hooksFile.hooks.Stop;
    writeHooks(hooksFile);

    expectRule(validateFixture(), 'required-event');
  });

  it('rejects an arbitrary non-wrapper SessionStart command', () => {
    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.SessionStart[0].hooks[0].command = "echo 'not the canonical banner'";
    writeHooks(hooksFile);

    expectRule(validateFixture(), 'trusted-wrapper');
    expectRule(validateFixture(), 'versioned-banner');
  });

  it('requires the on-session-start handler alongside the banner', () => {
    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.SessionStart[0].hooks.splice(1, 1);
    writeHooks(hooksFile);

    expectRule(validateFixture(), 'session-start-handler');
  });

  it('allows the versioned banner only on SessionStart', () => {
    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.Stop[0].hooks[0].command = validBannerCommand();
    writeHooks(hooksFile);

    const verdict = validateFixture();
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContainEqual({
      path: '$.hooksFile.hooks.Stop[0].hooks[0].command',
      rule: 'trusted-wrapper',
      message: 'command must exactly match the trusted Codex run-node.sh wrapper grammar',
    });
  });

  it('rejects an async command handler', () => {
    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.Stop[0].hooks[0].async = true;
    writeHooks(hooksFile);

    expectRule(validateFixture(), 'synchronous');
  });

  it.each(['prompt', 'agent'])('rejects a %s handler', (type) => {
    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.Stop[0].hooks[0] = { type };
    writeHooks(hooksFile);

    expectRule(validateFixture(), 'synchronous-command');
  });

  it('fake-regression: rejects an arbitrary prefix in the shared helper and production validator', () => {
    const command = `DEBUG=1 ${validCommand()}`;
    expect(parseCodexHookWrapperCommand(command)).toBeNull();

    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.Stop[0].hooks[0].command = command;
    writeHooks(hooksFile);

    expectRule(validateFixture(), 'trusted-wrapper');
  });

  it.each([
    ['missing native root usage', 'SO_PLATFORM=codex sh hooks/run-node.sh hooks/on-stop.mjs'],
    [
      'missing SO_PLATFORM=codex',
      `CODEX_PLUGIN_ROOT="${'${PLUGIN_ROOT}'}" sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh" "${'${PLUGIN_ROOT}'}/hooks/on-stop.mjs"`,
    ],
    [
      'a mismatched root variable',
      `SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${'${CODEX_PLUGIN_ROOT}'}" sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh" "${'${PLUGIN_ROOT}'}/hooks/on-stop.mjs"`,
    ],
    [
      'a missing handler',
      `SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${'${PLUGIN_ROOT}'}" sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh"`,
    ],
    ['a trailing command', `${validCommand()}; echo injected`],
    [
      'an unsafe handler path',
      `SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${'${PLUGIN_ROOT}'}" sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh" "${'${PLUGIN_ROOT}'}/hooks/../outside.mjs"`,
    ],
  ])('rejects a wrapper with %s', (_case, command) => {
    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.Stop[0].hooks[0].command = command;
    writeHooks(hooksFile);

    expectRule(validateFixture(), 'trusted-wrapper');
  });

  it('rejects a wrapper whose handler file does not exist', () => {
    makeFixture();
    const hooksFile = validHooks();
    hooksFile.hooks.Stop[0].hooks[0].command = validCommand('missing-handler.mjs');
    writeHooks(hooksFile);

    expectRule(validateFixture(), 'handler-file');
  });
});
