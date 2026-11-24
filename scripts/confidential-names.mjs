#!/usr/bin/env node
/**
 * confidential-names.mjs — generate and check the host-local CP11 name list (#2238).
 * Library: scripts/lib/confidential-names-list.mjs. Publisher guide:
 * docs/confidential-names-list.md. Prints counts only, never a name.
 */

import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import {
  MAX_LIST_AGE_DAYS,
  REGENERATE_COMMAND,
  defaultListPaths,
  describeNamesList,
  generateNamesList,
} from './lib/confidential-names-list.mjs';
import { readMirrorSetting } from './lib/github-export.mjs';
import { loadOwnerConfig } from './lib/owner-yaml.mjs';

export const HELP = `Usage: node scripts/confidential-names.mjs <generate|status> [options]

Host-local list of confidential repo/customer names for the CP11 rule of the
owner-leakage scanner. The list lives beside owner.yaml, never in a repo, and this
command never prints a name: only counts, statuses and file basenames.

generate   Read every GitLab project the account is a MEMBER of (glab api, GET only,
           paged), take each project's path and name and the segments of its group
           namespace (generic structure words such as products or infra skipped),
           add the extra list, dedupe case-insensitively, drop names shorter than 3
           characters, subtract the exception list, and write the list atomically
           with mode 0600 (directory 0700 when created).
  --out <path>     target file (default: <config dir>/confidential-names.json)
  --allow <path>   exception list, a JSON array of names never to emit (default:
                   <config dir>/confidential-names-allow.json; absent = no exceptions)
  --extra <path>   extra list, a JSON array of names always to emit unless excepted
                   (default: <config dir>/confidential-names-extra.json; absent = none)
  --no-groups      leave group namespace segments out of the list (still counted)
  --dry-run        fetch and count, write nothing
  --json           counts as JSON on stdout

status     Report the list CP11 would use (SO_CONFIDENTIAL_NAMES_FILE, else owner.yaml
           paths.confidential-names-file): status, name count, age in days.
  --advisory       pre-commit mode: in a 'mirror: curated' repo, one WARN line on stderr
                   when the list is not usable or older than ${MAX_LIST_AGE_DAYS} days;
                   silent otherwise; always exit 0
  --json           status as JSON on stdout

Writing the list does not activate it: set paths.confidential-names-file in owner.yaml
(or SO_CONFIDENTIAL_NAMES_FILE) to the written path.

Exit codes: 0 success (status: list ok or deliberately []); 1 bad arguments, or status
not usable; 2 generate failed (glab, network, filesystem; nothing written).`;

/** @param {string[]} argv @returns {number} */
export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        allow: { type: 'string' },
        extra: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'no-groups': { type: 'boolean', default: false },
        advisory: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    console.error(`confidential-names: ${err.message}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const [cmd, ...rest] = positionals;
  if (rest.length > 0 || (cmd !== 'generate' && cmd !== 'status')) {
    console.error(HELP);
    return 1;
  }
  return cmd === 'generate' ? runGenerate(values) : runStatus(values);
}

/** @param {{ out?: string, allow?: string, extra?: string, 'dry-run': boolean, 'no-groups': boolean, json: boolean }} values */
function runGenerate(values) {
  const defaults = defaultListPaths();
  const result = generateNamesList({
    namesPath: values.out ?? defaults.namesPath,
    allowPath: values.allow ?? defaults.allowPath,
    extraPath: values.extra ?? defaults.extraPath,
    dryRun: values['dry-run'],
    includeGroups: !values['no-groups'],
  });
  if (values.json) console.log(JSON.stringify(result));
  if (!result.ok) {
    if (!values.json) console.error(`confidential-names: ${result.reason}`);
    return 2;
  }
  if (!values.json) {
    console.log(
      `${result.written ? 'wrote' : 'dry run:'} ${result.names} names from ${result.projects} projects ` +
        `(${result.candidates} distinct candidates; ${result.groupSegments} distinct group segments ` +
        `${result.groupsIncluded ? `included, ${result.groupGeneric} generic skipped` : 'counted, not listed'}; ` +
        `${result.extra} extra, ${result.excepted} excepted, ${result.tooShort} too short; ` +
        `exception list ${result.allowList}, extra list ${result.extraList})`,
    );
  }
  return 0;
}

/** @param {{ advisory: boolean, json: boolean }} values */
function runStatus(values) {
  if (values.advisory) {
    try {
      const mirror = readMirrorSetting(process.cwd());
      if (!mirror.ok || mirror.mirror !== 'curated') return 0;
      const list = describeNamesList({ ownerConfig: loadOwnerConfig().config });
      if (list.status !== 'ok' && list.status !== 'empty') {
        console.error(`WARN confidential-names: list ${list.status} — export and release stay red in this mirror: curated repo (run: ${REGENERATE_COMMAND})`);
      } else if (list.stale) {
        console.error(`WARN confidential-names: list ${list.ageDays} day(s) old (> ${MAX_LIST_AGE_DAYS}) — refresh: ${REGENERATE_COMMAND}`);
      }
    } catch {
      // Advisory only: a failing check never blocks a commit.
    }
    return 0;
  }
  const list = describeNamesList({ ownerConfig: loadOwnerConfig().config });
  if (values.json) console.log(JSON.stringify(list));
  else console.log(`list ${list.status}: ${list.count} names${list.ageDays === null ? '' : `, ${list.ageDays} day(s) old`}${list.stale ? ' (stale)' : ''}`);
  return list.status === 'ok' || list.status === 'empty' ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
