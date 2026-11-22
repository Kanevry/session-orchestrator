#!/usr/bin/env node
/**
 * session-tree.mjs — print the tree Session → Wave → Agent for one session (#2218).
 *
 * Read-only CLI over `scripts/lib/session-tree.mjs`.
 *
 *   node scripts/session-tree.mjs [--session <id>] [--repo-root <path>] [--json]
 *
 * `--session` takes a raw harness UUID or a semantic label; default is the
 * newest session in `subagents.jsonl`. `--repo-root` defaults to the cwd.
 * `--json` prints ONE JSON document on stdout; otherwise a plain text tree.
 * Diagnostics go to stderr only.
 *
 * Exit codes (`.claude/rules/cli-design.md`): 0 tree printed, 1 input error
 * (unknown flag, session found in no ledger), 2 system error (`subagents.jsonl`
 * absent or unreadable, unexpected failure).
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import { LedgerUnreadableError, loadSessionTree } from './lib/session-tree.mjs';

const USAGE = [
  'Usage: node scripts/session-tree.mjs [--session <id>] [--repo-root <path>] [--json]',
  '',
  '  --session    optional  raw session UUID or semantic label; default: newest in subagents.jsonl',
  '  --repo-root  optional  repo whose .orchestrator/metrics/ is read; default: cwd',
  '  --json       optional  one JSON document on stdout instead of the text tree',
  '  --help       print this help',
  '',
  'Exit codes: 0 ok, 1 bad arguments or unknown session, 2 subagents.jsonl unreadable',
].join('\n');

const EXIT_ARGS = 1;
const EXIT_IO = 2;

function warn(message) {
  process.stderr.write(`session-tree: ${message}\n`);
}

function agentLine(a) {
  const span = `${a.started_at ?? '?'} → ${a.stopped_at ?? '?'}`;
  return `${a.agent_id}  ${a.agent_type ?? '(type unknown)'}  ${span}`;
}

/**
 * Render the tree as indented text with `├──` / `└──`.
 *
 * @param {object} tree — result of `loadSessionTree`
 * @returns {string}
 */
export function renderText(tree) {
  const s = tree.session;
  const lines = [
    `session ${s.semantic_session_ids.join(', ') || '(no semantic label)'}  raw ${s.raw_session_ids.join(', ') || '(none)'}`,
  ];
  const measurable = tree.coverage.agents_measurable;
  const count = (n) => (measurable ? `${n} agent(s)` : 'agents n/a');
  const groups = tree.waves.map((w) => ({
    head: `wave ${w.wave}  ${w.role ?? '(role unknown)'}  ${count(w.agents.length)}` +
      (Number.isInteger(w.recorded?.agent_count) ? `, recorded ${w.recorded.agent_count}` : ''),
    agents: w.agents,
  }));
  groups.push({ head: `unassigned  ${count(tree.unassigned.count)} without a known wave`, agents: tree.unassigned.agents });
  groups.forEach((g, gi) => {
    const lastG = gi === groups.length - 1;
    lines.push(`${lastG ? '└──' : '├──'} ${g.head}`);
    g.agents.forEach((a, ai) => {
      lines.push(`${lastG ? '    ' : '│   '}${ai === g.agents.length - 1 ? '└──' : '├──'} ${agentLine(a)}`);
    });
  });
  const c = tree.coverage;
  // "Not measured" must never print as 0 (#2218 review): agents without a
  // resolvable raw id, and the events share without a readable events ledger.
  const fromEvents = tree.sources?.events?.present === true ? String(c.wave_from_events) : 'n/a';
  lines.push(
    measurable
      ? `coverage: ${c.agents_total} agent(s), ${c.agents_with_wave} with wave ` +
          `(subagents ${c.wave_from_subagents}, events ${fromEvents}), unassigned ${c.unassigned}` +
          (c.recorded_conflicts > 0 ? `, recorded conflicts ${c.recorded_conflicts} (first row shown)` : '')
      : 'coverage: agents n/a — NOT measurable (no raw session id resolvable)',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * One stderr line per source that is absent, unreadable, cut or has torn lines.
 * Printed in both output modes; `--json` additionally carries `sources`.
 *
 * @param {object} sources — `sources` block of `loadSessionTree`
 * @returns {string[]}
 */
export function sourceWarnings(sources) {
  const out = [];
  const { subagents: sub, events: ev, sessions: sess } = sources ?? {};
  if (sub?.malformed_lines > 0) out.push(`subagents.jsonl: ${sub.malformed_lines} malformed line(s) skipped`);
  const unreadable = ev?.unreadable_sources ?? 0;
  if (ev?.error) out.push(`events ledger unreadable (${ev.error}) — events not measurable`);
  else if (ev?.present !== true) {
    out.push(unreadable > 0
      ? `events ledger unreadable (${unreadable} source(s)) — events not measurable`
      : 'events ledger absent — events not measurable');
  } else {
    if (unreadable > 0) out.push(`events ledger: ${unreadable} source(s) unreadable — events partly measured`);
    const otherGaps = (ev.gaps ?? 0) - unreadable;
    if (otherGaps > 0) out.push(`events ledger incomplete: ${otherGaps} gap(s) in the rotated history`);
    if (ev.malformed_lines > 0) out.push(`events ledger: ${ev.malformed_lines} malformed line(s) skipped`);
  }
  if (sess?.error) out.push(`sessions.jsonl unreadable (${sess.error}) — recorded waves not measurable`);
  else if (sess?.present !== true) out.push('sessions.jsonl absent — recorded waves not measurable');
  else if (sess.malformed_lines > 0) out.push(`sessions.jsonl: ${sess.malformed_lines} malformed line(s) skipped`);
  return out;
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        session: { type: 'string' },
        'repo-root': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    warn(String(err?.message ?? err));
    warn(USAGE);
    return EXIT_ARGS;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (values.session !== undefined && values.session.trim() === '') {
    warn('--session must not be empty');
    return EXIT_ARGS;
  }
  const repoRoot = resolve((values['repo-root'] || '').trim() || process.cwd());

  let tree;
  try {
    tree = await loadSessionTree({ repoRoot, session: values.session ?? null });
  } catch (err) {
    if (err instanceof LedgerUnreadableError) {
      warn(err.message);
      return EXIT_IO;
    }
    throw err;
  }
  if (!tree.found) {
    warn(`session not found in any ledger: ${tree.session.selector || '(subagents.jsonl has no session)'}`);
    return EXIT_ARGS;
  }
  for (const line of sourceWarnings(tree.sources)) warn(line);
  process.stdout.write(values.json ? `${JSON.stringify(tree, null, 2)}\n` : renderText(tree));
  return 0;
}

if (isMainModule(import.meta.url)) {
  // A consumer closing the pipe early (`| head`) is not an error.
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
    throw err;
  });
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { warn(String(err?.stack ?? err)); process.exitCode = EXIT_IO; },
  );
}
