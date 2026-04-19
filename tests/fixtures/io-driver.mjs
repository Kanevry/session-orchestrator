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
 *                          — calls emitDeny(reason, suggestion?). Exits 2.
 *   emit-warn <message>    — calls emitWarn(message). Exits 0, stderr output.
 *   emit-system <message>  — calls emitSystemMessage(message). Exits 0.
 */

import { readStdin, emitAllow, emitDeny, emitWarn, emitSystemMessage } from '../../scripts/lib/io.mjs';

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

  case 'emit-warn': {
    const message = rest.join(' ');
    emitWarn(message);
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
