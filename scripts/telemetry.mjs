#!/usr/bin/env node
/**
 * telemetry.mjs — operator CLI for anonymous usage telemetry (Epic #841, S3 /
 * GitLab #844; PRD docs/prd/2026-07-20-anonymous-usage-telemetry.md §3-FA3).
 *
 * Subcommands:
 *   status    show the resolved consent posture + queue occupancy
 *   enable    grant consent (persist to telemetry.json)
 *   disable   deny consent (persist to telemetry.json)
 *   show      preview the usage-ping payload WITHOUT minting/persisting an anon-ID
 *
 * (`_flush` is an internal, hidden subcommand used by the daily-fallback hook to
 * run a detached flush; it is intentionally omitted from --help.)
 *
 * Follows .claude/rules/cli-design.md:
 *   - `--json` for machine output; human-readable by default.
 *   - Data → stdout, diagnostics → stderr.
 *   - Exit codes: 0 success · 1 user error (unknown subcommand) · 2 system error.
 *
 * All host-local state (telemetry.json, telemetry-queue.ndjson) is homedir-based;
 * tests isolate via an injected HOME.
 */

import { parseArgs } from 'node:util';

import {
  resolveConsent,
  readTelemetryState,
  grantConsent,
  denyConsent,
} from './lib/telemetry/consent.mjs';
import { queueStats } from './lib/telemetry/queue.mjs';
import { flush, buildBatch } from './lib/telemetry/sync.mjs';
import { loadOwnerConfig } from './lib/owner-yaml.mjs';
import { readPluginVersionFromPackageJson } from './lib/bootstrap-lock-freshness.mjs';
import { SO_PLUGIN_ROOT } from './lib/platform.mjs';

const EXIT_OK = 0;
const EXIT_USER = 1;
const EXIT_SYSTEM = 2;

const HELP = `telemetry — anonymous usage-telemetry consent + inspection CLI

USAGE
  telemetry <status|enable|disable|show> [--json]
  telemetry --help | --version

SUBCOMMANDS
  status     show the resolved consent posture, anon-ID presence, and queue stats
  enable     grant consent (persisted to ~/.config/session-orchestrator/telemetry.json)
  disable    deny consent (persisted; subsequent sessions send nothing)
  show       preview the exact usage-ping payload — never mints an ID, never sends

OPTIONS
  --json     emit machine-readable JSON on stdout
  --help     show this help
  --version  print the plugin version

EXIT CODES
  0  success
  1  user error (unknown subcommand)
  2  system error

ENV KILL-SWITCHES
  DO_NOT_TRACK=1 / SO_TELEMETRY_DISABLED=1   disable telemetry for this shell
  SO_TELEMETRY=1                             force-enable (fleet) without a prompt
  SO_TELEMETRY_DEBUG=1                       print the payload instead of sending
`;

/** Plugin version for `--version` — single-sourced via readPluginVersionFromPackageJson (null → 'unknown'). */
function readPkgVersion() {
  return readPluginVersionFromPackageJson(SO_PLUGIN_ROOT) ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/** Resolve the current consent posture from env + owner.yaml + telemetry.json. */
function currentPosture() {
  const ownerConfig = loadOwnerConfig().config;
  const { record } = readTelemetryState();
  const consent = resolveConsent({ env: process.env, ownerConfig, state: record, interactive: false });
  const queue = queueStats();
  return { record, consent, queue };
}

function runStatus(json) {
  const { record, consent, queue } = currentPosture();
  const out = {
    state: consent.state,
    send: consent.send,
    prompt: consent.prompt,
    consent: record.consent,
    anon_id_present: typeof record.anon_id === 'string' && record.anon_id.trim() !== '',
    last_flush_at: record.last_flush_at,
    queue: { count: queue.count, bytes: queue.bytes },
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } else {
    process.stdout.write(
      [
        `state:          ${out.state}`,
        `send:           ${out.send}`,
        `consent:        ${out.consent ?? '(none)'}`,
        `anon_id:        ${out.anon_id_present ? 'present' : 'not yet minted'}`,
        `last_flush_at:  ${out.last_flush_at ?? '(never)'}`,
        `queue:          ${out.queue.count} batch(es), ${out.queue.bytes} byte(s)`,
      ].join('\n') + '\n',
    );
  }
  return EXIT_OK;
}

/**
 * Persist a consent decision, then warn on stdout/stderr if an env kill-switch
 * still overrides the file (so the operator is never misled that enabling took
 * effect when DO_NOT_TRACK / SO_TELEMETRY_DISABLED wins for this shell).
 */
function runSetConsent(decision, json) {
  const res = decision === 'granted' ? grantConsent() : denyConsent();
  if (!res.ok) {
    process.stderr.write('telemetry: failed to persist consent to telemetry.json\n');
    return EXIT_SYSTEM;
  }

  // Re-resolve to detect an env override that still forces disabled.
  const ownerConfig = loadOwnerConfig().config;
  const consent = resolveConsent({ env: process.env, ownerConfig, state: res.record, interactive: false });
  const envOverrides = decision === 'granted' && consent.state === 'disabled-env';
  if (envOverrides) {
    process.stderr.write(
      'telemetry: WARN — DO_NOT_TRACK / SO_TELEMETRY_DISABLED overrides the file setting; ' +
        'nothing will be sent from this shell.\n',
    );
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ consent: decision, effective_state: consent.state, send: consent.send })}\n`);
  } else {
    process.stdout.write(
      decision === 'granted'
        ? `Telemetry enabled (consent granted). Effective state: ${consent.state}.\n`
        : 'Telemetry disabled (consent denied). Nothing will be sent.\n',
    );
  }
  return EXIT_OK;
}

/**
 * Preview the usage-ping payload WITHOUT minting or persisting an anon-ID
 * (persist:false in buildBatch). Never sends. When no ID exists yet, a
 * placeholder is shown in the anon_id slot.
 */
function runShow(json) {
  const { record, reason } = buildBatch({ persist: false });
  if (!record) {
    process.stderr.write(`telemetry: cannot build preview (${reason ?? 'unknown'})\n`);
    return EXIT_SYSTEM;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } else {
    process.stdout.write(
      'Usage-ping preview (NOT sent; anon-ID is not minted by `show`):\n' +
        `${JSON.stringify(record, null, 2)}\n`,
    );
  }
  return EXIT_OK;
}

/** Internal detached-child entry: run one flush, swallow everything, exit 0. */
async function runFlush() {
  try {
    await flush();
  } catch {
    // never-throw contract; the detached child produces no user-facing output.
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    process.stderr.write(`telemetry: argument error: ${err?.message ?? String(err)}\n`);
    process.exit(EXIT_USER);
    return;
  }

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(EXIT_OK);
  }
  if (values.version) {
    process.stdout.write(`${readPkgVersion()}\n`);
    process.exit(EXIT_OK);
  }

  const sub = positionals[0];
  let code;
  switch (sub) {
    case 'status':
      code = runStatus(values.json);
      break;
    case 'enable':
      code = runSetConsent('granted', values.json);
      break;
    case 'disable':
      code = runSetConsent('denied', values.json);
      break;
    case 'show':
      code = runShow(values.json);
      break;
    case '_flush':
      code = await runFlush();
      break;
    default:
      process.stderr.write(
        sub
          ? `telemetry: unknown subcommand "${sub}". Try: status | enable | disable | show (--help).\n`
          : 'telemetry: missing subcommand. Try: status | enable | disable | show (--help).\n',
      );
      process.exit(EXIT_USER);
      return;
  }

  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`telemetry: system error: ${err?.message ?? String(err)}\n`);
  process.exit(EXIT_SYSTEM);
});
