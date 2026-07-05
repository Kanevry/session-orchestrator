/**
 * category6.mjs — Category 6: Config Hygiene (weight: 8)
 *
 * Checks: claude-md-line-count, no-dead-branch-refs, v2-features-section,
 *         github-mirror-sync
 *
 * Stdlib only: node:fs, node:path, node:child_process.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

  // c6.3 plugin-narrative-section — plugin-repo-specific heading check. Consumer
  // repos never have this section, so we skip-as-pass when the audit target is
  // NOT the session-orchestrator plugin repo. Plugin repo is detected by the
  // presence of skills/session-start/SKILL.md (unique to this plugin).
  //
  // Accepts any of: `## Current State` (canonical since v3.x), `## v2.0 Features`
  // (legacy plugin pre-v3), or `## v<major>.<minor> Features` (future-proofed
  // version-pinned headings). Pre-v3.0 the plugin pinned a specific v2.0 heading;
  // post-v3.0 the canonical heading is `## Current State` (the session-narrative
  // anchor). The check is intentionally version-agnostic so the rubric does not
  // need updating for every release.
  {
    const relPath = instrRel;
    const isPluginRepo = existsSync(join(root, 'skills/session-start/SKILL.md'));
    const text = instr ? safeRead(instrPath) : null;
    const hasNarrativeAnchor = text && (
      text.includes('## Current State') ||
      /## v\d+\.\d+ Features/.test(text)
    );
    if (!isPluginRepo) {
      checks.push(pass('plugin-narrative-section', 2, 2, relPath,
        { isPluginRepo: false, skipped: true },
        'consumer repo — plugin-specific heading check skipped'));
    } else if (!text) {
      checks.push(fail('plugin-narrative-section', 2, relPath,
        { isPluginRepo: true, present: false },
        'CLAUDE.md (or AGENTS.md alias) missing'));
    } else if (hasNarrativeAnchor) {
      checks.push(pass('plugin-narrative-section', 2, 2, relPath,
        { isPluginRepo: true, present: true },
        `${relPath} contains plugin-narrative anchor heading`));
    } else {
      checks.push(fail('plugin-narrative-section', 2, relPath,
        { isPluginRepo: true, present: false },
        `${relPath} missing plugin-narrative anchor (## Current State or ## v<n>.<n> Features)`));
    }
  }

  // c6.4 github-mirror-sync — warns when local commits have not reached the
  // repo's "github" remote (GitLab-primary / GitHub-mirror setups). A repo
  // with no github remote is not required to mirror anything, so that state
  // is skip-as-pass (full points) rather than a failure. Every git call is
  // wrapped defensively — a missing remote, an unfetched tracking ref, a
  // non-git root, or any other git-edge-case degrades to skip-as-pass so the
  // audit never crashes or hard-fails on ambient repo state it can't inspect.
  //
  // Mirror-branch resolution tries two strategies, in order:
  //   1. `github/HEAD` symbolic ref — only populated by an explicit
  //      `git remote set-head github -a` (or an equivalent fetch). A normal
  //      `git push github HEAD` does NOT set this ref, so a freshly
  //      bootstrapped repo that has only ever pushed never resolves here.
  //   2. Local current branch fallback — resolve the local branch name via
  //      `git rev-parse --abbrev-ref HEAD`, then verify the mirror actually
  //      has a matching tracking ref (`github/<local-branch>`). This covers
  //      the common post-bootstrap case: first `git push github HEAD` done,
  //      `set-head` never run.
  // Only skip-as-pass when neither strategy resolves an existing tracking ref
  // (or there is no github remote at all).
  {
    const checkId = 'github-mirror-sync';
    const relPath = '.git';

    const runGit = (args) => {
      try {
        return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
      } catch {
        return null;
      }
    };

    const remotesOutput = runGit(['remote']);
    const hasGithubRemote = remotesOutput !== null &&
      remotesOutput.split('\n').map((l) => l.trim()).includes('github');

    if (!hasGithubRemote) {
      checks.push(pass({
        checkId, points: 2, maxPoints: 2, path: relPath,
        evidence: { hasGithubRemote: false },
        message: 'no github mirror remote configured — skipped',
      }));
    } else {
      // Strategy 1: github/HEAD symbolic ref.
      const headAbbrevRef = runGit(['rev-parse', '--abbrev-ref', 'github/HEAD']);
      const headBranch = headAbbrevRef ? headAbbrevRef.replace(/^github\//, '') : null;
      const headVerified = headBranch !== null &&
        runGit(['rev-parse', '--verify', '--quiet', `github/${headBranch}`]) !== null;

      let mirrorBranch = headVerified ? headBranch : null;
      let resolvedVia = mirrorBranch ? 'github-head' : null;

      // Strategy 2: local current-branch fallback, only tried when strategy 1
      // didn't resolve a verified tracking ref.
      if (!mirrorBranch) {
        const localBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
        const localVerified = localBranch !== null &&
          runGit(['rev-parse', '--verify', '--quiet', `github/${localBranch}`]) !== null;
        if (localVerified) {
          mirrorBranch = localBranch;
          resolvedVia = 'local-branch-fallback';
        }
      }

      if (!mirrorBranch) {
        checks.push(pass({
          checkId, points: 2, maxPoints: 2, path: relPath,
          evidence: { hasGithubRemote: true, mirrorBranch: null },
          message: 'github mirror ref not fetched locally — skipped',
        }));
      } else {
        const revListOut = runGit(['rev-list', '--count', `github/${mirrorBranch}..HEAD`]);
        const aheadCount = revListOut !== null ? Number.parseInt(revListOut, 10) : NaN;

        if (Number.isNaN(aheadCount)) {
          checks.push(pass({
            checkId, points: 2, maxPoints: 2, path: relPath,
            evidence: { hasGithubRemote: true, mirrorBranch, resolvedVia, aheadCount: null },
            message: 'unable to determine ahead-count vs github mirror — skipped',
          }));
        } else if (aheadCount === 0) {
          checks.push(pass({
            checkId, points: 2, maxPoints: 2, path: relPath,
            evidence: { hasGithubRemote: true, mirrorBranch, resolvedVia, aheadCount },
            message: `HEAD is fully mirrored to github/${mirrorBranch}`,
          }));
        } else {
          checks.push(pass({
            checkId, points: 1, maxPoints: 2, path: relPath,
            evidence: { hasGithubRemote: true, mirrorBranch, resolvedVia, aheadCount },
            message: `${aheadCount} local commit(s) not pushed to github mirror (github/${mirrorBranch}). Run: git push github HEAD`,
          }));
        }
      }
    }
  }

  return checks;
}
