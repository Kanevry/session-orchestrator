#!/usr/bin/env node
/**
 * tmux-layout — opt-in tmux visualization for operator-side session side-channels.
 * Per ADR-0007 + GitLab #561. NOT a coordinator chat surface — Pane 1 is a scratch shell.
 *
 * Usage:
 *   node scripts/tmux-layout.mjs [options]
 *   tmux-layout [options]                     # via bin symlink
 *
 * Exit codes:
 *   0 — success (layout rendered, one-liner printed)
 *   1 — user-input error (invalid --layout, malformed --session-name, conflicting flags)
 *   2 — system error (tmux not found, tmux version < 3.0, session collision without --force)
 */

import { parseArgs } from 'node:util';
import { renderDefaultLayout, renderDebugLayout } from './lib/tmux-layout/layouts.mjs';
import { detectTmuxVersion } from './lib/tmux-layout/tmux-shell.mjs';
import { resolveStateDir } from './lib/platform.mjs';
import { readConfigFile, parseSessionConfig } from './lib/config.mjs';

const SCRIPT_VERSION = '0.1.0';
const VALID_LAYOUTS = ['default', 'debug'];

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp() {
  return `Usage: tmux-layout [options]

  -l, --layout <name>      Layout variant: default | debug  (default: default)
      --session-name <s>   Custom tmux session name          (default: so-layout-<layout>)
  -f, --force              Replace existing tmux session (PSA-003 escape hatch)
      --with-status-pane   Add a 5th pane tailing agent-status telemetry (#565)
      --json               Machine-readable JSON output to stdout
  -h, --help               Show this help
  -V, --version            Show version

Opt-in operator-side tmux visualization substrate (ADR-0007).
  Pane 1 is a SCRATCH SHELL — NOT a new claude session.
  Your original (coordinator) terminal stays as-is.
  See skills/tmux-layout/SKILL.md for pane details.
`;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      layout:             { type: 'string',  short: 'l', default: 'default' },
      'session-name':     { type: 'string' },
      force:              { type: 'boolean', short: 'f', default: false },
      'with-status-pane': { type: 'boolean', default: false },
      json:               { type: 'boolean', default: false },
      help:               { type: 'boolean', short: 'h', default: false },
      version:            { type: 'boolean', short: 'V', default: false },
    },
    allowPositionals: false,
  });
}

// ---------------------------------------------------------------------------
// Dispatch logic
// ---------------------------------------------------------------------------

async function dispatch({ values }) {
  // (1) Handle --help / --version first — no validation needed
  if (values.help) {
    return { exitCode: 0, output: printHelp(), kind: 'help' };
  }
  if (values.version) {
    return { exitCode: 0, output: SCRIPT_VERSION, kind: 'version' };
  }

  // (2) Validate --layout
  if (!VALID_LAYOUTS.includes(values.layout)) {
    return {
      exitCode: 1,
      output: {
        ok: false,
        error: `Invalid --layout '${values.layout}' (must be one of: ${VALID_LAYOUTS.join(', ')})`,
        exitCode: 1,
      },
      kind: 'json-error',
    };
  }

  // (3) Validate --session-name (no whitespace, no colons — tmux constraint)
  const sessionName = values['session-name'] ?? `so-layout-${values.layout}`;
  if (/[\s:]/.test(sessionName)) {
    return {
      exitCode: 1,
      output: {
        ok: false,
        error: `Invalid --session-name '${sessionName}': must not contain whitespace or colons (tmux constraint)`,
        exitCode: 1,
      },
      kind: 'json-error',
    };
  }

  // (4) Degradation pre-check: tmux availability
  const ver = detectTmuxVersion();
  if (!ver.available) {
    return {
      exitCode: 2,
      output: {
        ok: false,
        error: 'tmux not found in $PATH',
        exitCode: 2,
        remediation: 'Install tmux ≥ 3.0 via: brew install tmux  OR  apt install tmux',
      },
      kind: 'json-error',
    };
  }

  // (5) Degradation pre-check: tmux version ≥ 3.0
  if (!ver.satisfiesMin) {
    return {
      exitCode: 2,
      output: {
        ok: false,
        error: `tmux version '${ver.version}' is below the 3.0 minimum required`,
        exitCode: 2,
        remediation: 'Upgrade tmux to ≥ 3.0 via: brew upgrade tmux  OR  apt upgrade tmux',
      },
      kind: 'json-error',
    };
  }

  // (6) Resolve project root + state dir (informational — passed to renderer)
  const projectRoot = process.cwd();
  const stateDir = resolveStateDir(); // uses SO_PLATFORM env detection

  // (7) Load VCS config from Session Config (best-effort — fall back to defaults)
  let vcsConfig = {};
  try {
    const mdContent = await readConfigFile(projectRoot);
    const cfg = parseSessionConfig(mdContent);
    vcsConfig = {
      vcs: cfg['vcs'],
      'gitlab-host': cfg['gitlab-host'],
      mirror: cfg['mirror'],
    };
  } catch {
    // Non-fatal: renderer can run without Session Config context
  }

  // (8) Dispatch to layout renderer
  const ctx = {
    sessionName,
    force: values.force,
    withStatusPane: values['with-status-pane'],
    projectRoot,
    stateDir,
    vcsConfig,
  };

  const result = values.layout === 'default'
    ? await renderDefaultLayout(ctx)
    : await renderDebugLayout(ctx);

  if (!result.ok) {
    return {
      exitCode: 2,
      output: {
        ok: false,
        error: result.error ?? 'Layout render failed',
        exitCode: 2,
        ...(result.remediation ? { remediation: result.remediation } : {}),
      },
      kind: 'json-error',
    };
  }

  return {
    exitCode: 0,
    output: {
      ok: true,
      sessionName,
      layout: values.layout,
      panes: result.panes,
      degraded: result.degraded ?? false,
      oneliner: result.oneliner,
    },
    kind: 'json-success',
  };
}

// ---------------------------------------------------------------------------
// Output + entry-point
// ---------------------------------------------------------------------------

async function main(argv) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`tmux-layout: ${err.message}\n\n${printHelp()}\n`);
    return 1;
  }

  const result = await dispatch(parsed);

  if (result.kind === 'help' || result.kind === 'version') {
    process.stdout.write(result.output + '\n');
    return result.exitCode;
  }

  if (parsed.values.json) {
    // --json: structured output to stdout, silence stderr notes
    process.stdout.write(JSON.stringify(result.output) + '\n');
  } else if (result.kind === 'json-success') {
    // Human-readable: one-liner to stdout, usage note to stderr
    process.stdout.write(result.output.oneliner + '\n');
    process.stderr.write(
      '\n' +
      '# Paste the line above into a SECOND terminal.\n' +
      '# Your original (coordinator) terminal stays as-is —\n' +
      '# Pane 1 of the layout is a scratch shell, NOT a new claude session.\n' +
      `# Session: ${result.output.sessionName} | Layout: ${result.output.layout} | Panes: ${result.output.panes}` +
      (result.output.degraded ? ' | degraded: true' : '') +
      '\n',
    );
  } else if (result.kind === 'json-error') {
    process.stderr.write(`tmux-layout: ${result.output.error}\n`);
    if (result.output.remediation) {
      process.stderr.write(`  Remediation: ${result.output.remediation}\n`);
    }
  }

  return result.exitCode;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`tmux-layout: fatal: ${err.message}\n${err.stack ?? ''}\n`);
    process.exit(2);
  });
