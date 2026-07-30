/**
 * tests/fixtures/io-driver.mjs
 *
 * Parameterised CLI driver for io.mjs exports used by io.test.mjs spawn tests.
 *
 * Usage:
 *   echo '<stdin>' | node io-driver.mjs <mode> [args...]
 *
 * Modes:
 *   read-echo              — readStdin(), emit the result as a system message or
 *                            write "null" to stdout on null result. Exits 0.
 *   emit-allow             — calls emitAllow(). Exits 0 silently.
 *   emit-deny <reason> [suggestion]
 *                          — calls emitDeny(reason, suggestion?). Exits 0 with a
 *                            single hookSpecificOutput JSON line on stdout.
 *                            `reason` may contain newlines (argv is passed raw).
 *   emit-deny-big <n>      — calls emitDeny() with an n-character reason built
 *                            IN THIS CHILD. Generating it here rather than
 *                            passing it through argv keeps the 200 000-char case
 *                            clear of ARG_MAX; the payload is the point, not the
 *                            argv path.
 *   emit-deny-empty        — calls emitDeny('') — the missing-reason path.
 *   write-line <n>         — writeStdoutLineSync() with an n-character line, then
 *                            process.exit(0). Exercises the stdout writer alone,
 *                            with no reason clamp in front of it.
 *   emit-warn <message>    — calls emitWarn(message). Exits 0, stderr output.
 *   emit-system <message>  — calls emitSystemMessage(message). Exits 0.
 */

// NOTE: This file is spawned as a CHILD Node process by tests/lib/io.test.mjs
// (spawnSync(process.execPath, [DRIVER, ...])). The child Node process does NOT
// run under vitest, so it has no `@lib` alias resolution. Keep this import as a
// raw relative path — do not convert to `@lib/io.mjs` (#407 alias rollout exempt).
import {
  readStdin,
  emitAllow,
  emitDeny,
  emitWarn,
  emitSystemMessage,
  writeStdoutLineSync,
} from '../../scripts/lib/io.mjs';

const [, , mode, ...rest] = process.argv;

switch (mode) {
  case 'read-echo': {
    let result;
    try {
      result = await readStdin();
    } catch (err) {
      // Write the error class + message to stderr, exit 1 so the test can detect it
      process.stderr.write(`${err.constructor.name}: ${err.message}\n`);
      process.exit(1);
    }
    if (result === null) {
      process.stdout.write('null\n');
    } else {
      emitSystemMessage(JSON.stringify(result));
    }
    process.exit(0);
    break;
  }

  case 'emit-allow':
    emitAllow();
    break; // never reached

  case 'emit-deny': {
    const reason = rest[0];
    const suggestion = rest[1]; // may be undefined
    emitDeny(reason, suggestion);
    break; // never reached
  }

  case 'emit-deny-big': {
    emitDeny('R'.repeat(Number(rest[0])));
    break; // never reached
  }

  case 'emit-deny-empty': {
    emitDeny('');
    break; // never reached
  }

  case 'write-line': {
    writeStdoutLineSync('W'.repeat(Number(rest[0])));
    process.exit(0);
    break;
  }

  case 'emit-warn': {
    const message = rest.join(' ');
    emitWarn(message);
    break; // never reached
  }

  // Takes a LENGTH, not the string — mirrors emit-deny-big. Passing 200 000
  // characters through argv works on macOS and dies with E2BIG on Linux, where
  // ARG_MAX is far smaller; generating the payload in the child removes the
  // platform from the test entirely. (CI red on 3a27817 for exactly this.)
  case 'emit-warn-big': {
    emitWarn('W'.repeat(Number(rest[0])));
    break; // never reached
  }

  case 'emit-system': {
    const msg = rest.join(' ');
    emitSystemMessage(msg);
    process.exit(0);
    break;
  }

  default:
    process.stderr.write(`io-driver: unknown mode "${mode}"\n`);
    process.exit(127);
}
