#!/usr/bin/env bash
# setup.sh — idempotent fixture builder for the #484-H3 Agent-Teams hook-seam test.
#
# Builds /tmp/h3-agent-teams-test: a minimal, self-contained TypeScript-ish
# fixture whose `npm run typecheck` is a zero-dependency node script. The
# TaskCompleted hook (in .claude/settings.json) runs that typecheck and is
# expected to exit 2 (block) when src/h3.ts is in its FAIL state.
#
# Spawns NO claude session — only node/npm/git in /tmp. Re-running is safe:
# it rewrites the fixture files deterministically and re-commits only if dirty.
set -euo pipefail

FIXTURE="/tmp/h3-agent-teams-test"

# Symlink guard (#627 codex review, HIGH — CWE-377/CWE-61). The fixture path is
# fixed and predictable, so a pre-planted symlink at ${FIXTURE} (e.g. -> $HOME)
# would make the `cat >` writes below follow out-of-dir and clobber files
# outside /tmp. Refuse to proceed if ${FIXTURE} exists as a symlink. The fixed
# path is intentional (shared across setup/toggle/preflight/run-h3 + the
# operator runbook's cleanup commands), so we harden in place rather than switch
# to mktemp -d, which would break that cross-script + runbook contract.
if [ -L "${FIXTURE}" ]; then
  echo "[setup] REFUSING: ${FIXTURE} is a symlink (possible symlink-following attack)." >&2
  echo "[setup] remove it and re-run: rm -f \"${FIXTURE}\"" >&2
  exit 1
fi

echo "[setup] building H3 fixture at ${FIXTURE}"
mkdir -p "${FIXTURE}/src" "${FIXTURE}/.claude"

# --- package.json -----------------------------------------------------------
cat > "${FIXTURE}/package.json" <<'JSON'
{
  "name": "h3-agent-teams-fixture",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "typecheck": "node ./typecheck.mjs"
  }
}
JSON

# --- typecheck.mjs (self-contained, no deps) --------------------------------
# Exit 2 when src/h3.ts is missing, contains FAIL_MARKER, or assigns a string
# literal to a `: number` annotation. Exit 0 otherwise. Diagnostics on stderr.
cat > "${FIXTURE}/typecheck.mjs" <<'MJS'
#!/usr/bin/env node
// Self-contained typecheck gate for the #484-H3 fixture. NO external deps —
// this is deliberately NOT tsgo/tsc so the fixture needs no install step.
import { readFileSync } from 'node:fs';

const TARGET = 'src/h3.ts';

let source;
try {
  source = readFileSync(new URL(`./${TARGET}`, import.meta.url), 'utf8');
} catch {
  process.stderr.write(`typecheck: ${TARGET} missing\n`);
  process.exit(2);
}

const hasFailMarker = source.includes('FAIL_MARKER');
const stringToNumber = /:\s*number\s*=\s*["']/.test(source);

if (hasFailMarker || stringToNumber) {
  process.stderr.write(
    `typecheck FAILED: type error in ${TARGET} (string assigned to number / FAIL_MARKER present)\n`,
  );
  process.exit(2);
}

process.stdout.write('typecheck PASSED: 0 errors\n');
process.exit(0);
MJS

# --- src/h3.ts — initial PASS state -----------------------------------------
cat > "${FIXTURE}/src/h3.ts" <<'TS'
export const x: number = 42;
TS

# --- .claude/settings.json --------------------------------------------------
# Enables the experimental Agent-Teams flag AND wires the TaskCompleted hook
# to the typecheck gate. settings.json must be committed for hooks to load.
cat > "${FIXTURE}/.claude/settings.json" <<'JSON'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "hooks": {
    "TaskCompleted": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npm run --silent typecheck",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
JSON

# --- results log + template -------------------------------------------------
# Results log the operator appends to; template documents the shape.
# Create-if-absent ONLY — never truncate. The between-run reset rebuilds the
# fixture (run-h3.sh cleanup → setup.sh); truncating here would destroy the
# run-N evidence the operator was told (run-h3.sh step 5) to append before
# run-N+1 (#627 codex review, MEDIUM). A fresh `run-h3.sh cleanup` removes the
# whole fixture dir, which is the intended full reset.
if [ ! -f "${FIXTURE}/h3-results.jsonl" ]; then
  : > "${FIXTURE}/h3-results.jsonl"
fi

cat > "${FIXTURE}/RESULTS-TEMPLATE.jsonl" <<'JSON'
{"timestamp":"<ISO>","run_n":1,"src_state":"pass|fail","hook_exit_code":0,"task_status":"completed|blocked|stuck","blocked":false,"feedback_delivered":false,"teammate_retried":false,"transcript_excerpt":"...","notes":"..."}
JSON

# --- git init + initial commit ----------------------------------------------
if [ ! -d "${FIXTURE}/.git" ]; then
  git -C "${FIXTURE}" init -q
  git -C "${FIXTURE}" config user.email "h3-fixture@example.invalid"
  git -C "${FIXTURE}" config user.name "H3 Fixture"
fi
# Ensure the experimental hooks settings are tracked & committed (idempotent).
git -C "${FIXTURE}" add -A
if ! git -C "${FIXTURE}" diff --cached --quiet; then
  git -C "${FIXTURE}" commit -q -m "chore(h3): fixture state (settings.json + typecheck gate + src/h3.ts)"
  echo "[setup] committed fixture state"
else
  echo "[setup] fixture already committed (no changes)"
fi

echo "[setup] DONE — fixture ready at ${FIXTURE}"
echo "[setup] next: run ./preflight.sh to smoke-test the seam (no claude session)"
