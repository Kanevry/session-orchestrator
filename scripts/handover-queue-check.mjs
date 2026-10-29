#!/usr/bin/env node
/**
 * handover-queue-check.mjs — every open point of a fleet handover carries a
 * queue mark before the session reports "Bereit zum Schließen." (#1639).
 *
 * Callers: `skills/_shared/fleet-protocol.md` § Übergabe und Zug-Manifest
 * Schritt 1a (the waiting turn that writes the file) and session-end § 4.5
 * (re-check at `/close`). Parsing lives in `lib/handover-queue-marks.mjs`.
 *
 * Usage:
 *   node scripts/handover-queue-check.mjs (--file <path> | --fleet-dir <dir> --since <iso>)
 *        [--name <name>] [--apply --repo <repo> [--navigator-cli <path>]] [--json]
 *
 *   --file           the handover or train manifest to check
 *   --fleet-dir/--since  newest of uebergabe-<name>.md, uebergabe-<name>-*.md,
 *                    <name>-zug-*.md in <dir> modified at or after <iso> or
 *                    epoch ms (the session's start, e.g. `startedAt` of its
 *                    ~/.claude/sessions entry): session names repeat across days, so an
 *                    older file of the same name is a predecessor's (#1639 F1)
 *   --name           the session name; queue titles read `<name>: <point>`
 *                    (required with --fleet-dir and with --apply)
 *   --apply          file each unmarked point via `owner-queue add --json`
 *                    and write `queue:#<id>` into the file; points under an
 *                    owner/decision heading are reported, never filed; so
 *                    are info lines (`**MR:** !44, Kopf abc1234`,
 *                    `Pipeline <id> grün`: a label followed by refs and
 *                    values only), which belong under "Vollzogen" (#1794). Only
 *                    for an own file (the --fleet-dir name pattern for
 *                    --name); a foreign file is refused untouched (#1647).
 *                    Check mode without --apply reads any file.
 *   --repo           owner-queue repo name (required with --apply)
 *   --navigator-cli  coordinator CLI: a `.js` path runs under node, anything
 *                    else as a binary; default `navigator` from PATH
 *
 * Exit: 0 every open point marked (or no fleet integration: nothing to do) ·
 *       3 unmarked points or info lines remain (listed on stdout) · 2 usage error ·
 *       4 --apply on a file that is not the session's own — foreign name, a
 *         symlink, or older than --since (nothing filed or written).
 */

import { lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fleetIntegrationEnabled } from './lib/fleet-protocol.mjs';
import { findOpenPoints, insertMarks, kindFor, refFor, unmarkedPoints } from './lib/handover-queue-marks.mjs';
import { spawnSync } from './lib/native-command.mjs';

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_UNMARKED = 3;
const EXIT_FOREIGN = 4;

function parseArgs(argv) {
  const out = { apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (['--file', '--name', '--fleet-dir', '--since', '--repo', '--navigator-cli'].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.file && !(out.name && out.fleetDir && out.since)) {
    throw new Error('need --file, or --fleet-dir with --name and --since');
  }
  if (out.since !== undefined) {
    // ISO date, or epoch ms as the session registry's `startedAt` carries it.
    out.sinceMs = /^\d+$/.test(out.since) ? Number(out.since) : Date.parse(out.since);
    if (Number.isNaN(out.sinceMs)) throw new Error(`--since is not a date: ${out.since}`);
  }
  if (out.apply && !out.repo) throw new Error('--apply needs --repo');
  if (out.apply && !out.name) throw new Error('--apply needs --name');
  return out;
}

/**
 * True when basename `f` is a handover or train file of session `name`:
 * `uebergabe-<name>.md`, `uebergabe-<name>-*.md` or `<name>-zug-*.md`. The
 * hyphen after `<name>` keeps `uebergabe-foo2-*.md` out of `foo`'s files.
 */
function isOwnHandover(f, name) {
  return (
    f.endsWith('.md') &&
    (f === `uebergabe-${name}.md` || f.startsWith(`uebergabe-${name}-`) || f.startsWith(`${name}-zug-`))
  );
}

/** Newest handover/train file of `name` in `dir` modified at/after `sinceMs`, or null. */
function newestHandover(dir, name, sinceMs) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const own = names.filter((f) => isOwnHandover(f, name));
  const withTime = own.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).filter((x) => x.t >= sinceMs);
  withTime.sort((a, b) => b.t - a.t);
  return withTime.length ? join(dir, withTime[0].f) : null;
}

/** `owner-queue add --json` → queue id (exit 0: new, exit 4: existing), or an error string. */
function fileQueueItem(cli, { repo, kind, title, ref }) {
  const args = ['--json', 'owner-queue', 'add', '--repo', repo, '--kind', kind, '--waits-on', 'lead', '--title', title];
  if (ref) args.push('--ref', ref);
  const [cmd, argv] = cli.endsWith('.js') ? [process.execPath, [cli, ...args]] : [cli, args];
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 30_000 });
  if (r.error) return { error: r.error.code ?? r.error.message };
  let parsed;
  try {
    parsed = JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null');
  } catch {
    parsed = null;
  }
  if (r.status === 0 && Number.isInteger(parsed?.id)) return { id: parsed.id };
  if (r.status === 4 && Number.isInteger(parsed?.ids?.[0])) return { id: parsed.ids[0] };
  return { error: `owner-queue add exit ${r.status}` };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`handover-queue-check: ${err.message}\n`);
    return EXIT_USAGE;
  }
  const say = (obj, text) => process.stdout.write(opts.json ? `${JSON.stringify(obj)}\n` : `${text}\n`);

  if (!fleetIntegrationEnabled()) {
    say({ fleet: false, unmarked: 0 }, 'handover-queue-check: keine Flottenintegration — nichts zu prüfen');
    return EXIT_OK;
  }
  const file = opts.file ?? newestHandover(opts.fleetDir, opts.name, opts.sinceMs);
  if (!file) {
    say({ fleet: true, file: null, unmarked: 0 }, 'handover-queue-check: keine Übergabe-Datei gefunden');
    return EXIT_OK;
  }
  // --apply writes into the file and files queue items titled with --name:
  // only the session's own file qualifies (#1647: a fleet-wide loop over
  // --file marked 17 foreign handovers).
  // The name alone is not enough: a symlink named like an own file writes
  // through to its target, and session names repeat across days, so with
  // --since an older file of the same name is a predecessor's (#1639 F1).
  if (opts.apply) {
    let st = null;
    try {
      st = lstatSync(file);
    } catch {
      // unreadable: the read below reports it
    }
    const reason = !isOwnHandover(basename(file), opts.name)
      ? 'fremde Datei'
      : st?.isSymbolicLink()
        ? 'Symlink'
        : st && opts.sinceMs !== undefined && st.mtimeMs < opts.sinceMs
          ? 'Datei älter als --since (Vorgänger gleichen Namens)'
          : null;
    if (reason) {
      process.stderr.write(`handover-queue-check: ${reason}: ${basename(file)} — --apply nur für die eigene Übergabe von ${opts.name}\n`);
      return EXIT_FOREIGN;
    }
  }
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`handover-queue-check: ${file} unlesbar (${err.code ?? err.message})\n`);
    return EXIT_USAGE;
  }

  const all = unmarkedPoints(findOpenPoints(content));
  // Info lines are a hint to move them under "Vollzogen", never a queue item
  // (#1794). They stay in the report and keep exit 3: hidden, the line would
  // vanish from the writer's view while the Lead still counts it as open.
  const info = all.filter((p) => p.info).map((p) => ({ line: p.line + 1, section: p.section, text: p.text }));
  let open = all.filter((p) => !p.info);
  const filed = [];
  const failed = [];
  if (opts.apply && open.length > 0) {
    const cli = opts.navigatorCli ?? 'navigator';
    const ids = new Map();
    for (const p of open) {
      const kind = kindFor(p);
      if (kind === null) {
        failed.push({ line: p.line + 1, error: 'Owner-Entscheid: mit --options/--class selbst anlegen' });
        continue;
      }
      // The CLI shortens titles over 200 code units itself (cleanly, with a
      // WARN); slicing here could split a surrogate pair.
      const title = `${opts.name}: ${p.text}`;
      const r = fileQueueItem(cli, { repo: opts.repo, kind, title, ref: refFor(p, opts.repo) });
      if (r.id !== undefined) {
        ids.set(p.line, r.id);
        filed.push({ line: p.line + 1, id: r.id });
      } else {
        failed.push({ line: p.line + 1, error: r.error });
      }
    }
    if (ids.size > 0) {
      content = insertMarks(content, ids);
      writeFileSync(file, content);
    }
    open = open.filter((p) => !ids.has(p.line));
  }

  const unmarked = open.map((p) => ({ line: p.line + 1, section: p.section, text: p.text }));
  const lines = [`handover-queue-check: ${basename(file)} — ${unmarked.length} Punkt(e) ohne Queue-ID`];
  for (const f of filed) lines.push(`  angelegt: Zeile ${f.line} → queue:#${f.id}`);
  for (const u of unmarked) lines.push(`  offen: Zeile ${u.line} [${u.section}] ${u.text}`);
  for (const f of failed) lines.push(`  Anlegen gescheitert: Zeile ${f.line} (${f.error})`);
  for (const i of info) {
    lines.push(`  Hinweis: Zeile ${i.line} [${i.section}] Infozeile unter Offen-Überschrift, nach Vollzogen verschieben: ${i.text}`);
  }
  say({ fleet: true, file, unmarked: unmarked.length, filed, failed, points: unmarked, info }, lines.join('\n'));
  return unmarked.length > 0 || info.length > 0 ? EXIT_UNMARKED : EXIT_OK;
}

process.exitCode = main();
