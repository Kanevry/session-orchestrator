'use strict';
// hooks/codex-win.cjs — native Windows entry for the Codex plugin hooks (#1849).
//
// hooks/hooks-codex.json starts every handler through a POSIX hull
// (`SO_PLATFORM=codex CODEX_PLUGIN_ROOT=… sh run-node.sh …`). Under native
// Windows that hull fails before the handler runs: Codex starts Windows hooks
// through `%COMSPEC% /C` (cmd.exe; codex-rs hooks/src/engine/command_runner.rs
// @26ad281f), and cmd.exe has no env-prefix syntax, so no hook — and no guard —
// ever runs. Each handler therefore also carries a `commandWindows` override:
//
//   set NoDefaultCurrentDirectoryInExePath=1&& node -e "require(require('path').join(require('path').isAbsolute(process.env.PLUGIN_ROOT||'')?process.env.PLUGIN_ROOT:process.exit(1),'hooks','codex-win.cjs'))" <handler>.mjs
//
// - The `set` matters: cmd.exe looks for a bare `node` in the current directory
//   before PATH, and the current directory is the session's repository, which
//   could ship a `node.exe` or `node.cmd`.
// - The quoted script has no spaces and no `$`, `%` or `"`, so cmd.exe (and
//   PowerShell) hand it to node unchanged; the plugin root is read from the
//   environment inside node, so a root with spaces needs no shell quoting.
// - Only an absolute root is used: a relative or empty one would make the
//   join a module path that require() looks up in the session directory's
//   node_modules — a file the repository could plant.
//
// Contract (same as hooks/run-node.sh): set SO_PLATFORM=codex and
// CODEX_PLUGIN_ROOT, run the handler with stdin/stdout/stderr inherited, exit
// with the handler's exit code. Node is the running binary (process.execPath);
// a host without `node` on PATH fails in the shell before this file loads.
//
// Unlike the POSIX hull's `exec`, this is a parent plus a child process. On a
// hook timeout Codex terminates the hook's job object, or runs `taskkill /T`,
// which takes the child with it (command_runner.rs @26ad281f). Revisit if a
// Windows run shows a handler outliving its timeout.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const process = require('node:process');

// Same grammar as the POSIX wrapper's handler path in scripts/lib/codex/plugin-contract.mjs.
const HANDLER_RE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.mjs$/;

const root = process.env.PLUGIN_ROOT;
const handler = process.argv[1];

if (typeof root !== 'string' || root.trim() === '') {
  process.stderr.write('session-orchestrator: PLUGIN_ROOT is not set; Codex hook not started (#1849)\n');
  process.exit(1);
}
if (typeof handler !== 'string' || !HANDLER_RE.test(handler)) {
  process.stderr.write(`session-orchestrator: invalid hook handler name ${JSON.stringify(String(handler))} (#1849)\n`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [path.join(root, 'hooks', ...handler.split('/'))], {
  stdio: 'inherit',
  env: { ...process.env, SO_PLATFORM: 'codex', CODEX_PLUGIN_ROOT: root },
  windowsHide: true,
});

if (result.error) {
  process.stderr.write(`session-orchestrator: hook ${handler} failed to start: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
