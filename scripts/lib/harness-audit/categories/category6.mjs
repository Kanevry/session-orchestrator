/**
 * category6.mjs — Category 6: Config Hygiene (weight: 8)
 *
 * Checks: claude-md-line-count, no-dead-branch-refs, v2-features-section
 *
 * Stdlib only: node:fs, node:path.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { safeRead, lineCount, pass, fail } from './helpers.mjs';
import { resolveInstructionFile } from '../../common.mjs';

export function runCategory6(root) {
  const checks = [];

  // CLAUDE.md (Claude Code / Cursor) and AGENTS.md (Codex CLI) are transparent
  // aliases — see skills/_shared/instruction-file-resolution.md. Resolve once
  // and reuse. relPath stays repo-relative for scorecard output.
  const instr = resolveInstructionFile(root);
  const instrPath = instr?.path ?? join(root, 'CLAUDE.md');
  const instrRel = instr ? (instr.kind === 'agents' ? 'AGENTS.md' : 'CLAUDE.md') : 'CLAUDE.md';

  // c6.1 claude-md-line-count
  {
    const p = instrPath;
    const relPath = instrRel;
    const text = instr ? safeRead(p) : null;
    if (!text) {
      checks.push(fail('claude-md-line-count', 3, relPath,
        { lineCount: 0 },
        'CLAUDE.md (or AGENTS.md alias) missing'));
    } else {
      const count = lineCount(text);
      if (count <= 250) {
        checks.push(pass('claude-md-line-count', 3, 3, relPath,
          { lineCount: count },
          `${relPath} is ${count} lines (≤ 250)`));
      } else {
        checks.push(fail('claude-md-line-count', 3, relPath,
          { lineCount: count },
          `${relPath} is ${count} lines (> 250 limit)`));
      }
    }
  }

  // c6.2 no-dead-branch-refs
  {
    const p = instrPath;
    const relPath = instrRel;
    const text = instr ? safeRead(p) : null;
    if (!text) {
      checks.push(fail('no-dead-branch-refs', 3, relPath,
        { deadRefsFound: [] },
        'CLAUDE.md (or AGENTS.md alias) missing'));
    } else {
      const deadPatterns = ['windows-native-v3', 'legacy-bash-v2', 'feat/v3-'];
      const textLower = text.toLowerCase();
      const deadRefsFound = deadPatterns.filter((pat) => textLower.includes(pat.toLowerCase()));
      if (deadRefsFound.length === 0) {
        checks.push(pass('no-dead-branch-refs', 3, 3, relPath,
          { deadRefsFound: [] },
          `${relPath} contains no dead branch refs`));
      } else {
        checks.push(fail('no-dead-branch-refs', 3, relPath,
          { deadRefsFound },
          `${relPath} contains dead branch refs: ${deadRefsFound.join(', ')}`));
      }
    }
  }

  // c6.3 v2-features-section — plugin-repo-specific heading check. Consumer
  // repos never have this section, so we skip-as-pass when the audit target is
  // NOT the session-orchestrator plugin repo. Plugin repo is detected by the
  // presence of skills/session-start/SKILL.md (unique to this plugin).
  {
    const relPath = instrRel;
    const isPluginRepo = existsSync(join(root, 'skills/session-start/SKILL.md'));
    const text = instr ? safeRead(instrPath) : null;
    if (!isPluginRepo) {
      checks.push(pass('v2-features-section', 2, 2, relPath,
        { isPluginRepo: false, skipped: true },
        'consumer repo — plugin-specific heading check skipped'));
    } else if (!text) {
      checks.push(fail('v2-features-section', 2, relPath,
        { isPluginRepo: true, present: false },
        'CLAUDE.md (or AGENTS.md alias) missing'));
    } else if (text.includes('## v2.0 Features')) {
      checks.push(pass('v2-features-section', 2, 2, relPath,
        { isPluginRepo: true, present: true },
        `${relPath} contains ## v2.0 Features heading`));
    } else {
      checks.push(fail('v2-features-section', 2, relPath,
        { isPluginRepo: true, present: false },
        `${relPath} missing ## v2.0 Features heading`));
    }
  }

  return checks;
}
