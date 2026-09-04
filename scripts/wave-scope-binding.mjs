#!/usr/bin/env node
/**
 * wave-scope-binding.mjs — print the session binding for a `wave-scope.json`
 * manifest, and record the fail-closed case as an event (#1153 P4).
 *
 * Usage:
 *   node scripts/wave-scope-binding.mjs [--merge] [--wave N] [--role R] [--repo-root DIR]
 *
 * Prints ONE JSON object on stdout:
 *
 *   {"session_id":"<raw session_id>","semantic_session_id":"<semantic id>"}
 *
 * Those key names are the canonical ones since #1153 P2 — the same spelling
 * `.orchestrator/session.lock` and `current-session.json` already use. Readers
 * additionally accept the pre-#1153 `session` / `semantic_session` spellings
 * until the next minor release (`MANIFEST_SESSION_KEYS` in
 * `scripts/lib/session-identity/own-session.mjs`); this writer never emits them.
 *
 * Keys whose value is unavailable are OMITTED, never written as `""` — an empty
 * id is present-but-equal-to-nobody, which every reader classifies as FOREIGN
 * (the one disposition that skips enforcement entirely), and
 * `validate-wave-scope.mjs` rejects it outright.
 *
 * WHY A COMMAND AND NOT PROSE: this binding used to be an inline
 * `node --input-type=module -e` block in `skills/wave-executor/wave-loop.md`,
 * retyped by the coordinator once per wave. An unbound manifest (`{}`) is the
 * fail-closed direction and therefore SILENT — indistinguishable from a
 * coordinator that skipped the step. `orchestrator.scope.unbound_manifest` is
 * what makes the silent case countable; 0 hits repo-wide before this file.
 *
 * The binding itself is NOT recomputed here. It is exactly one
 * `attributionForRecord()` call, which reads `.orchestrator/session.lock` and
 * confirms the raw `session_id` against this process's own identity before
 * returning anything — under a peer-owned lock it returns `{}` rather than the
 * peer's ids. Duplicating that logic would be the one-fact-two-copies class this
 * repo keeps paying for.
 */

import { parseArgs } from 'node:util';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attributionForRecord, emitEvent } from './lib/events.mjs';
import { MANIFEST_SESSION_KEYS } from './lib/session-identity/own-session.mjs';

const HELP = `Usage: node scripts/wave-scope-binding.mjs [--merge] [--wave N] [--role R] [--repo-root DIR]

Print the session-binding keys for a wave-scope.json manifest as one JSON object.
Empty values are OMITTED; an unbound binding prints {} and emits exactly one
orchestrator.scope.unbound_manifest event.

With --merge, read the DRAFT manifest as one JSON object on stdin and print that
same manifest with the binding keys merged in (or with them omitted, plus the
unbound event, when the binding is {}). Every other field is passed through.

Options:
  --merge             Read the draft manifest on stdin, print it bound.
  --wave <n>          Wave number, recorded in the unbound event payload.
  --role <role>       Wave role, recorded in the unbound event payload.
  --repo-root <dir>   Repo root to resolve the lock and the events log against
                      (default: process.cwd()).
  -h, --help          Show this help and exit 0.

Output:
  stdout — exactly one JSON object. Diagnostics go to stderr.
`;

/**
 * Resolve the manifest binding for `repoRoot`.
 *
 * @param {string} repoRoot
 * @returns {{ session_id?: string, semantic_session_id?: string }} binding with
 *   empty values omitted
 */
export function resolveBinding(repoRoot) {
  const attribution = attributionForRecord(repoRoot) ?? {};
  /** @type {{ session_id?: string, semantic_session_id?: string }} */
  const out = {};
  const session = typeof attribution.session_id === 'string' ? attribution.session_id.trim() : '';
  const semantic = typeof attribution.semantic_session_id === 'string'
    ? attribution.semantic_session_id.trim()
    : '';
  if (session) out.session_id = session;
  if (semantic) out.semantic_session_id = semantic;
  return out;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        wave: { type: 'string' },
        role: { type: 'string' },
        'repo-root': { type: 'string' },
        merge: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(`wave-scope-binding: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(HELP);
    process.exitCode = 2;
    return;
  }

  if (parsed.values.help) {
    process.stdout.write(HELP);
    return;
  }

  const repoRoot = parsed.values['repo-root'] ?? process.cwd();
  const binding = resolveBinding(repoRoot);

  if (Object.keys(binding).length === 0) {
    // The fail-closed case, and the whole reason this is a command: an unbound
    // manifest enforces against EVERY session in the checkout, and until now it
    // left no trace at all. Best-effort — the binding is still printed if the
    // append fails, because a broken events log must not stall a wave.
    try {
      await emitEvent(
        'orchestrator.scope.unbound_manifest',
        {
          // Numeric when it parses as one, so the field matches every other
          // `wave` in the stream; `null` (never `undefined`) when absent, since
          // an undefined `wave` lets emitEvent's correlation envelope fill it
          // from the live manifest — the very artefact this event says is
          // unbound.
          wave: Number.isFinite(Number(parsed.values.wave)) && parsed.values.wave !== undefined
            ? Number(parsed.values.wave)
            : (parsed.values.wave ?? null),
          role: parsed.values.role ?? null,
          reason: 'no-confirmed-session-attribution',
        },
        { repoRoot },
      );
    } catch (error) {
      process.stderr.write(
        `wave-scope-binding: could not record unbound_manifest event: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  if (!parsed.values.merge) {
    process.stdout.write(`${JSON.stringify(binding)}\n`);
    return;
  }

  // --merge: the coordinator pipes the draft manifest in and gets the SAME
  // manifest back with the binding merged, instead of hand-copying two keys
  // out of the printed object into the JSON it is about to write (#1207).
  let draftRaw;
  try {
    draftRaw = await readStdin();
  } catch (error) {
    process.stderr.write(
      `wave-scope-binding: could not read the draft manifest from stdin: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  let draft;
  try {
    draft = JSON.parse(draftRaw);
  } catch {
    process.stderr.write('wave-scope-binding: --merge expects ONE JSON object on stdin\n');
    process.exitCode = 1;
    return;
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    process.stderr.write('wave-scope-binding: --merge expects ONE JSON object on stdin\n');
    process.exitCode = 1;
    return;
  }

  // Any binding key already in the draft is dropped first: under an unbound or
  // peer-owned lock the merged manifest must name NOBODY, and a stale key
  // surviving the merge would name somebody. Omitted, never `""` — see above.
  // BOTH spellings are dropped (close-review 2026-09-04, HIGH): a legacy
  // `session`/`semantic_session` pair surviving the merge is still READ by every
  // consumer and would name a foreign session — `foreign` = gates stand down.
  const merged = { ...draft };
  for (const key of [...MANIFEST_SESSION_KEYS.current, ...MANIFEST_SESSION_KEYS.legacy]) delete merged[key];
  // Explicit per-key copy, never Object.assign: `merged` derives from a
  // JSON.parse'd draft, and a `__proto__` payload key would reach the
  // Object.prototype setter through [[Set]] semantics (CWE-1321, semgrep
  // prototype-pollution-object-assign — CI-red on ce6a28aa).
  for (const key of MANIFEST_SESSION_KEYS.current) {
    if (typeof binding[key] === 'string' && binding[key]) merged[key] = binding[key];
  }
  process.stdout.write(`${JSON.stringify(merged)}\n`);
}

/**
 * Read all of stdin as UTF-8. Resolves to `''` when stdin is closed/empty.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

// `import.meta.main` is not available on every supported Node — compare argv[1]
// instead, so importing this module from a test never runs the CLI.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  await main(process.argv.slice(2));
}
