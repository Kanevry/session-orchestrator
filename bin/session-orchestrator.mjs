#!/usr/bin/env node
/**
 * session-orchestrator — the npm package's single entry command (#2194).
 *
 * Wiring only: `doctor` hands its remaining arguments to
 * `scripts/runtime-readiness.mjs` `main()` and returns that exit code
 * unchanged (0 ready, 1 input error, 2 system error, 3 not ready). No check
 * logic lives here. The import is lazy so `--help` and `--version` still work
 * when the runtime check itself would fail to load.
 *
 * @module bin/session-orchestrator
 */

import { readFileSync } from 'node:fs';

const HELP = `Usage: session-orchestrator <command> [options]

Commands:
  doctor [options]   Check whether this install can load its runtime
                     dependencies; --repair installs missing ones.
                     Options are passed through: --json, --repair, --codex,
                     --claude, --root <dir>. See: session-orchestrator doctor --help

Options:
  -h, --help         Show this help.
  -v, --version      Print the package version.

Exit codes: those of the command run; 2 for an unknown command.
`;

/**
 * @param {string[]} argv arguments after the executable
 * @returns {Promise<number>} exit code
 */
async function run(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    // An explicit help request is data (stdout); no command at all is a usage error.
    (command === undefined ? process.stderr : process.stdout).write(HELP);
    return command === undefined ? 2 : 0;
  }
  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (command === 'doctor') {
    const { main } = await import('../scripts/runtime-readiness.mjs');
    return main(rest);
  }
  process.stderr.write(`session-orchestrator: unknown command '${command}'\n\n${HELP}`);
  return 2;
}

process.exitCode = await run(process.argv.slice(2));
