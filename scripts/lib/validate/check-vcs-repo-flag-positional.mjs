#!/usr/bin/env node
/**
 * Separate WARN-only check for gh pr commands rejected with --repo/-R (#1024).
 * Shares corpus discovery and call-shape parsing with the bare-repo census,
 * but its findings advise naming the PR or dropping the flag, never adding it.
 * Coverage ceilings (literal argv, shell fences/strings) are shared with that census.
 */
import path from 'node:path';
import { inspectVcsRepoFlag } from './check-vcs-repo-flag.mjs';
import { isMainModule } from '../is-main-module.mjs';

/** @param {string} pluginRoot independent check envelope */
export function inspectVcsRepoFlagPositional(pluginRoot) {
  const result = inspectVcsRepoFlag(pluginRoot, { rejected: true });
  return {
    ok: result.ok,
    toolError: result.toolError,
    summary: {
      filesScanned: result.summary.filesScanned,
      unresolvedArgv: result.summary.unresolvedArgv,
      findings: result.findings.length,
      byKind: result.summary.byKind,
    },
    findings: result.findings,
  };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage =
    'Usage: check-vcs-repo-flag-positional.mjs [<plugin-root>] [--json]\n' +
    'Exit: 0 check completed (findings WARN-only) · 1 usage error · 2 tool error';
  const unknown = args.filter((arg) => arg.startsWith('-') && !['--json', '--help'].includes(arg));
  const roots = args.filter((arg) => !arg.startsWith('-'));
  if (unknown.length || roots.length > 1) {
    console.error(usage);
    process.exitCode = 1;
  } else if (args.includes('--help')) {
    console.log(usage);
  } else {
    const result = inspectVcsRepoFlagPositional(path.resolve(roots[0] ?? process.cwd()));
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('--- Check: --repo/-R requiring a PR positional (WARN-only) ---');
      for (const finding of result.findings) {
        console.log(
          `  ${result.toolError ? 'FAIL' : 'WARN'}: [${finding.kind}] ${finding.file}:${finding.line} — ${finding.message}`,
        );
      }
      if (!result.toolError)
        console.log(
          `  PASS: scanned ${result.summary.filesScanned} file(s), ${result.findings.length} rejected repo flag(s), ${result.summary.unresolvedArgv} variable argv array(s) unjudged`,
        );
      console.log(`Results: ${result.toolError ? '0 passed, 1 failed' : '1 passed, 0 failed'}`);
    }
    process.exitCode = result.toolError ? 2 : 0;
  }
}
