import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const closeMd = readFileSync(path.join(repoRoot, 'commands', 'close.md'), 'utf8');

describe('commands/close.md pre-check — issue #253', () => {
  it('#253: pre-check header announces three exit conditions', () => {
    expect(closeMd).toMatch(/Three exit conditions:/);
  });

  it('#253: differentiates persistence:false missing-STATE.md message', () => {
    expect(closeMd).toMatch(/persistence is off/i);
    expect(closeMd).toMatch(/STATE\.md was never created/);
  });

  it('#253: differentiates persistence:true missing-STATE.md message', () => {
    expect(closeMd).toMatch(/No active session found/);
    expect(closeMd).toMatch(/Use `\/session` to start a session first/);
  });

  it('#253: status:completed message cites session-end + offers inspection hint', () => {
    expect(closeMd).toMatch(/finalized by session-end/);
    expect(closeMd).toMatch(/inspect `<state-dir>\/STATE\.md`/);
  });

  it('#253: proceeds on status:active or status:paused', () => {
    expect(closeMd).toMatch(/status: active.+status: paused/);
    expect(closeMd).toMatch(/Proceed to invoke the session-end skill/);
  });

  it('#253: catch-all warns on unexpected status and names idle as example', () => {
    expect(closeMd).toMatch(/Unexpected session status/);
    expect(closeMd).toMatch(/idle/);
  });

  it('#253: catch-all instructs the user to inspect STATE.md and reset via /session', () => {
    expect(closeMd).toMatch(/Inspect `<state-dir>\/STATE\.md`/);
    expect(closeMd).toMatch(/use `\/session` to reset if needed/);
  });

  it('#253 regression guard: pre-fix single-line "Previous session already closed" wording is gone', () => {
    expect(closeMd).not.toMatch(/Previous session already closed\./);
  });

  it('#253: instructs reading persistence from Session Config when STATE.md is absent', () => {
    expect(closeMd).toMatch(/Read Session Config to check `persistence`/);
  });
});
