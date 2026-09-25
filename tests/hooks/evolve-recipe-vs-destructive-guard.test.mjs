/**
 * tests/hooks/evolve-recipe-vs-destructive-guard.test.mjs
 *
 * #1453 — the documented `/evolve analyze` Step 3.5(5) recipe must survive the
 * destructive-command guard it runs under.
 *
 * The bug: the recipe put its next-generation sidecar at
 * `.orchestrator/metrics/.learnings-next.jsonl` and cleaned up with
 * `&& rm -f "$NEXT"`. The `ledger-delete-protected` rule (#1401) blocks every
 * rm/mv/unlink whose operand is under `.orchestrator/metrics/**`, so the
 * moment `$NEXT` is spelled out (an agent inlining the path, which is the
 * ordinary way the recipe gets executed) the WHOLE Bash call — including the
 * `--prune --apply` half — is denied, and the sidecar is left behind as a file
 * nobody may delete.
 *
 * Why `$NEXT` is resolved before the guard sees it: the guard is lexical and
 * treats a variable delete operand as unresolved → "not matched". Feeding it
 * the verbatim `"$NEXT"` would ALLOW vacuously on BOTH the old and the new
 * path and prove nothing. The resolved form is the one that discriminates.
 *
 * Call shape mirrors tests/hooks/pre-bash-destructive-guard.test.mjs: the hook
 * is spawned with a PreToolUse Bash payload on stdin. There is no exported
 * pure decision function — the rule loop lives in the hook's `main()`. The
 * project dir is a throwaway tmpdir without a policy file, so the hook's
 * plugin-root policy (the REAL `.orchestrator/policy/blocked-commands.json`)
 * is the effective one.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expectAllow } from '../_helpers/hook-decision.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(REPO, 'hooks/pre-bash-destructive-guard.mjs');
const DOC = path.join(REPO, 'skills/evolve/references/evolve-analyze-mode.md');

/** The one fenced block that carries the `--prune` invocation. */
function extractPruneBlock(markdown) {
  const blocks = [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const hits = blocks.filter(
    (b) => b.includes('sweep-expired-learnings.mjs --prune') && b.includes('rm -f "$NEXT"'),
  );
  expect(hits).toHaveLength(1);
  return hits[0];
}

describe('#1453 — /evolve Step 3.5 sidecar recipe vs. the destructive-command guard', () => {
  const block = extractPruneBlock(readFileSync(DOC, 'utf8'));
  const next = block.match(/^\s*NEXT="([^"]+)"/m)?.[1];

  it('resolves $NEXT to a path under .orchestrator/tmp/', () => {
    expect(next).toBeDefined();
    expect(next.startsWith('.orchestrator/tmp/')).toBe(true);
  });

  it('the recipe with $NEXT spelled out is ALLOWED by the real guard policy', () => {
    const command = block.replaceAll('"$NEXT"', `"${next}"`).trim();
    // Guard against a vacuous ALLOW: no unresolved $NEXT operand may remain.
    expect(command).not.toContain('$NEXT');

    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'evolve-recipe-guard-'));
    try {
      const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
      delete env.SO_DISABLED_HOOKS;
      const result = spawnSync(process.execPath, [HOOK], {
        cwd: projectDir,
        env,
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf8',
      });
      expectAllow(result);
      // The delete branch must have SEEN a concrete operand, not skipped a variable.
      expect(result.stderr).not.toContain('carry a variable/substitution');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
