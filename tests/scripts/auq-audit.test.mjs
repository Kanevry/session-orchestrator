/**
 * auq-audit.test.mjs — pins die CLI der AUQ-Klarheitsmessung (#1107).
 *
 * ## TV-001: welchen konkreten Fehler jeder Fall fängt
 *
 * Diese CLI erzeugt EINE Zahl, auf die sich spätere Sessions berufen werden.
 * Die teuren Fehler sind deshalb nicht Rechenfehler — die fangen die Tests der
 * drei Module darunter (`tests/lib/auq/`) —, sondern die Fehler, bei denen die
 * Zahl trotzdem ankommt und nur falsch gerahmt ist:
 *
 *   1. eine Diagnose rutscht nach stdout → der `--json`-Umschlag ist unparsebar
 *   2. `--strict` ist versehentlich scharf → jeder Lauf wird zum roten Gate
 *   3. `--strict` ist verkabelt, tut aber nichts → das Gate ist Attrappe
 *   4. eine unbekannte Flagge läuft durch statt mit Eingabefehler zu enden
 *   5. `validateReport` wird gerufen und sein Verdikt ignoriert
 *   6. `dirty` wird nicht gesetzt → der Bericht behauptet Reproduzierbarkeit
 *   7. stdout wird über den 64-KiB-Pipe-Puffer hinaus verworfen
 *   8. eine Verschlechterung der Vorlagen senkt die Note NICHT (Fake-Regression)
 *
 * Kein Fall pinnt einen Korpus-Zählstand ("72 Fragen") — der driftet mit jeder
 * Vorlagenänderung und wäre eine garantierte Falschmeldung. Verglichen wird
 * immer eine RICHTUNG (vorher/nachher) oder eine Struktureigenschaft.
 *
 * Die Vorlage für die Fake-Regression ist eine KOPIE einer echten Repo-Datei,
 * kein erfundenes Wunschformat — sonst pinnte der Test die Annahme des
 * Testautors statt der Wirklichkeit (`.claude/rules/testing.md`, "unfaithful
 * double").
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReport, decideExit, EXIT } from '../../scripts/auq-audit.mjs';
import { validateReport, emptyCorpus } from '../../scripts/lib/auq/schema.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'auq-audit.mjs');

/**
 * Eine echte, heute im Repo bestehende Vorlage — Kopfzeile `"Archetype"`
 * (9 Zeichen), Note A. Sie ist die Grundlage der Fake-Regression: nur an einer
 * Vorlage, die VORHER besteht, beweist ein Notenverfall etwas.
 */
const CLEAN_TEMPLATE = 'skills/bootstrap/SKILL.md';

/** @param {string[]} args @param {string} [cwd] */
function run(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Notenverteilung eines Laufs über eine einzelne Datei. */
function gradesOf(root, file) {
  const res = run([root, '--file', file, '--json']);
  expect(res.status).toBe(EXIT.ok);
  return JSON.parse(res.stdout).summary.grades;
}

/**
 * Baut eine Fixture-Wurzel aus einer ECHTEN Repo-Vorlage plus einer absichtlichen
 * Verschlechterung.
 *
 * Warum nicht gegen `REPO_ROOT` messen: die Gate-Fälle unten brauchen einen
 * Korpus MIT Defekt. Gegen das lebende Repo gemessen pinnen sie dessen
 * Defektstand — und gehen genau dann rot, wenn jemand das Repo repariert. Das
 * ist am 2026-08-22 passiert: Welle 3 von #1107 brachte den Korpus von 21/72
 * auf 72/72, und beide Fälle wurden rot, obwohl nichts kaputt war. Ein
 * Gate-Test, der verlangt dass das Repo kaputt bleibt, bestraft die Reparatur.
 *
 * Die Vorlage bleibt eine Kopie einer echten Datei (`.claude/rules/testing.md`,
 * "unfaithful double") — synthetisch ist nur die Mutation.
 *
 * @param {string} name Unterverzeichnis unter `tmpRoot`
 * @param {(source: string) => string} mutate
 */
function fixtureRoot(name, mutate) {
  const root = join(tmpRoot, name);
  const rel = 'skills/demo/SKILL.md';
  const abs = join(root, rel);
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  cpSync(join(REPO_ROOT, CLEAN_TEMPLATE), abs);
  const original = readFileSync(abs, 'utf8');
  const mutated = mutate(original);
  // Greift die Mutation nicht, prüft der Fall nichts mehr — dann lieber rot.
  expect(mutated).not.toBe(original);
  writeFileSync(abs, mutated);
  return { root, rel };
}

/** Die Mutation, die genau eine harte Grenze (H1) reißt und sonst nichts. */
const breakHeader = (source) =>
  source.replace(/header: "Archetype"/gu, 'header: "Archetype With A Very Long Header"');

let tmpRoot;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'auq-audit-'));
});

afterAll(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// stdout/stderr-Trennung
// ---------------------------------------------------------------------------

describe('stdout gehört den Daten, stderr der Diagnose', () => {
  // FÄNGT: ein `console.log`/Fortschrittshinweis rutscht in den --json-Kanal.
  // Der Umschlag ist dann unparsebar, obwohl der Lauf mit 0 endet — genau die
  // Form, in der ein kaputter Kanal wie ein Erfolg aussieht.
  // `no-console` steht in eslint.config.js auf `off`, der Linter fängt es NICHT.
  it('--json legt ausschließlich JSON auf stdout, auch mit Warnungen im Lauf', () => {
    const res = run(['--json']);
    expect(res.status).toBe(EXIT.ok);
    expect(res.stdout.trimStart().startsWith('{')).toBe(true);
    const report = JSON.parse(res.stdout);
    expect(validateReport(report).errors).toEqual([]);
    // Der echte Korpus erzeugt Lesewarnungen. Sie müssen im Umschlag stehen
    // und dürfen NICHT als Rohtext auf stdout landen.
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  // FÄNGT: eine Fehlermeldung wird nach stdout geschrieben. Ein Aufrufer, der
  // stdout in `jq` pipet, bekommt dann Prosa statt einer Fehlermeldung auf dem
  // Kanal, auf dem er sie erwartet.
  it('meldet einen Eingabefehler auf stderr und schreibt nichts auf stdout', () => {
    const res = run(['--nope']);
    expect(res.status).toBe(EXIT.usage);
    expect(res.stdout).toBe('');
    // Die Aufrufzeile stammt nur aus dem eigenen Fehlerpfad — eine ungefangene
    // Ausnahme würde ebenfalls mit 1 enden, aber ohne diese Zeile.
    expect(res.stderr).toContain('Aufruf: node scripts/auq-audit.mjs');
  });

  // FÄNGT: ein unlesbarer Pfad wird als Systemfehler (2) oder still als Erfolg
  // behandelt statt als Eingabefehler (1) — cli-design.md § Exit Codes.
  it('endet bei unlesbarer Repo-Wurzel mit dem Eingabefehler-Code', () => {
    const res = run([join(tmpRoot, 'gibt-es-nicht')]);
    expect(res.status).toBe(EXIT.usage);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Repo-Wurzel nicht lesbar');
  });
});

// ---------------------------------------------------------------------------
// Die Pipe-Grenze
// ---------------------------------------------------------------------------

describe('stdout überlebt den 64-KiB-Pipe-Puffer', () => {
  // FÄNGT: die Rückkehr zu `console.log` + `process.exit()`. stdout ist auf
  // einer Pipe unter macOS asynchron; alles jenseits von 65 536 Bytes liegt in
  // der libuv-Warteschlange und wird von process.exit() verworfen. Der Umschlag
  // dieses Programms ist ~190 KB, reißt die Grenze also bei JEDEM Lauf.
  // Gemessener Gegenfall: dieselbe Nutzlast über console.log geschrieben kommt
  // gepipet als exakt 65 536 Bytes an, umgeleitet als 194 222.
  it('liefert gepipet dieselbe Bytezahl wie in eine Datei umgeleitet', () => {
    const piped = run(['--json']).stdout;
    expect(Buffer.byteLength(piped, 'utf8')).toBeGreaterThan(65_536);

    // Dieselbe Ausgabe, aber auf eine DATEI statt auf eine Pipe: eine Datei ist
    // synchron, eine Pipe nicht. Weichen die beiden Bytezahlen ab, hat der
    // Pipe-Weg unterwegs Bytes verloren.
    const file = join(tmpRoot, 'envelope.json');
    const fd = openSync(file, 'w');
    let res;
    try {
      res = spawnSync(process.execPath, [SCRIPT, '--json'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', fd, 'ignore'],
      });
    } finally {
      closeSync(fd);
    }
    expect(res.status).toBe(EXIT.ok);
    expect(Buffer.byteLength(readFileSync(file, 'utf8'), 'utf8')).toBe(
      Buffer.byteLength(piped, 'utf8'),
    );
  });
});

// ---------------------------------------------------------------------------
// Das Gate
// ---------------------------------------------------------------------------

describe('--strict ist die einzige Flagge, die sperrt', () => {
  // FÄNGT: das Gate ist versehentlich standardmäßig scharf. Dann ist jeder
  // Lauf über den echten Korpus rot — und der Prüfer wird abgeschaltet, weil
  // nur H1/H2 eine Falsch-Positiv-Rate von 0 % haben.
  it('endet ohne --strict mit 0, obwohl harte Grenzen gerissen sind', () => {
    const { root, rel } = fixtureRoot('gate-huerde-offen', breakHeader);
    const res = run([root, '--file', rel, '--json']);
    const report = JSON.parse(res.stdout);
    const broken = report.scores.filter((s) => s.hurdlesBroken.length > 0).length;
    expect(broken).toBeGreaterThan(0); // sonst prüft der Fall nichts
    expect(res.status).toBe(EXIT.ok);
  });

  // FÄNGT: --strict ist verkabelt, tut aber nichts (die "gebaut aber nicht
  // eingeschaltet"-Klasse). Ohne diesen Gegenfall ist der Fall darüber
  // vakuum-grün: eine CLI, die IMMER 0 liefert, bestünde ihn.
  it('endet mit --strict nicht-null, sobald eine harte Grenze gerissen ist', () => {
    const { root, rel } = fixtureRoot('gate-huerde-strict', breakHeader);
    const res = run([root, '--file', rel, '--strict']);
    expect(res.status).toBe(EXIT.gate);
    expect(res.stderr).toContain('harte Grenze');
  });

  // FÄNGT: --strict sperrt auf BEFUNDEN statt auf Hürden. Die Cursor-Regeln
  // tragen Befunde, aber keine gerissene Hürde — ein Gate, das dort rot wird,
  // sperrt auf der falschen Größe.
  it('bleibt mit --strict grün, wenn nur Befunde und keine Hürde vorliegen', () => {
    // Eine Empfehlung ohne Grund ist ein Befund (K4) und KEINE Hürde: die
    // Kopfzeile bleibt kurz, die Optionszahl unverändert. Auch dieser Fall lief
    // vorher gegen den lebenden `C-mdc`-Korpus und wäre nach Welle 3 vakuum-grün
    // geworden — dort stehen nur noch drei Hinweise, und wer die aufräumt, nimmt
    // dem Fall seinen Gegenstand.
    const { root, rel } = fixtureRoot('gate-nur-befunde', (source) =>
      source.replace(
        /\{ label: "fast", description: "[^"]*" \}/u,
        '{ label: "fast (Recommended)", description: "Nimm diese." }',
      ),
    );
    const res = run([root, '--file', rel, '--strict', '--json']);
    const report = JSON.parse(res.stdout);
    expect(report.scores.every((s) => s.hurdlesBroken.length === 0)).toBe(true);
    const findings = report.scores.reduce((n, s) => n + s.findings.length, 0);
    expect(findings).toBeGreaterThan(0); // es gibt etwas zu melden …
    expect(res.status).toBe(EXIT.ok); // … und trotzdem kein rotes Gate
  });
});

// ---------------------------------------------------------------------------
// Die Exit-Politik als reine Funktion
// ---------------------------------------------------------------------------

describe('decideExit', () => {
  // FÄNGT: validateReport wird gerufen und sein Verdikt ignoriert — ein
  // Bericht, der sein eigenes Schema verletzt, verließe das Programm dann mit
  // 0 und sähe aus wie eine gültige Messung. Am `process.exit()` in main() ist
  // das nicht prüfbar, an dieser Funktion schon; main() hat genau eine
  // Aufrufstelle für sie.
  it('setzt einen ungültigen Bericht auf den Systemfehler-Code, auch ohne --strict', () => {
    expect(decideExit({ reportValid: false, strict: false, hurdlesBroken: 0 })).toBe(EXIT.system);
  });

  it('lässt einen ungültigen Bericht nicht vom Gate überstimmen', () => {
    expect(decideExit({ reportValid: false, strict: true, hurdlesBroken: 5 })).toBe(EXIT.system);
  });

  it('sperrt nur mit --strict UND gerissener Hürde', () => {
    expect(decideExit({ reportValid: true, strict: true, hurdlesBroken: 1 })).toBe(EXIT.gate);
    expect(decideExit({ reportValid: true, strict: false, hurdlesBroken: 99 })).toBe(EXIT.ok);
    expect(decideExit({ reportValid: true, strict: true, hurdlesBroken: 0 })).toBe(EXIT.ok);
  });
});

// ---------------------------------------------------------------------------
// Der Umschlag
// ---------------------------------------------------------------------------

describe('buildReport', () => {
  // FÄNGT: `summary` wird von Hand mitgeführt statt aus den scores abgeleitet.
  // Eine mitgeführte Zusammenfassung driftet beim ersten Filter auseinander und
  // widerspricht dann der Liste, über der sie steht.
  it('leitet die Notenverteilung aus den übergebenen scores ab', () => {
    const score = {
      file: 'skills/x/SKILL.md',
      line: 1,
      questionIndex: 0,
      points: 100,
      grade: 'A',
      hurdlesBroken: [],
      findings: [],
    };
    const report = buildReport({
      blocks: [],
      scores: [score, { ...score, line: 2, points: 0, grade: 'F' }],
      corpus: emptyCorpus(),
      head: 'abc1234',
      dirty: false,
    });
    expect(report.summary.grades.A).toBe(1);
    expect(report.summary.grades.F).toBe(1);
    expect(validateReport(report).errors).toEqual([]);
  });

  // FÄNGT: `dirty` fällt auf false zurück, wenn git nicht antworten kann. Der
  // Bericht behauptete dann Reproduzierbarkeit an einem SHA, den es nicht gibt.
  it('gilt als schmutzig, solange niemand das Gegenteil gemessen hat', () => {
    const report = buildReport({ blocks: [], scores: [], corpus: emptyCorpus(), head: null });
    expect(report.dirty).toBe(true);
  });
});

describe('Der Umschlag über ein Verzeichnis ohne git', () => {
  // FÄNGT: `dirty` wird hart auf false gesetzt oder gar nicht gesetzt. Ausserhalb
  // eines git-Repos ist der Anker UNBEKANNT — und unbekannt ist nicht sauber.
  it('trägt keinen HEAD und meldet den Baum als nicht reproduzierbar', () => {
    const root = join(tmpRoot, 'kein-git');
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    cpSync(join(REPO_ROOT, CLEAN_TEMPLATE), join(root, 'skills', 'demo', 'SKILL.md'));

    const res = run([root, '--file', 'skills/demo/SKILL.md', '--json']);
    expect(res.status).toBe(EXIT.ok);
    const report = JSON.parse(res.stdout);
    expect(report.head).toBe(null);
    expect(report.dirty).toBe(true);
    expect(report.scores.length).toBeGreaterThan(0);
  });

  // FÄNGT: eine eingegrenzte Zahl wird später als Baseline zitiert. Ohne das
  // Feld `filters` im Umschlag ist einer gefilterten Messung nicht anzusehen,
  // dass sie nicht das ganze Repo beschreibt.
  it('führt die gesetzte Eingrenzung im Umschlag mit', () => {
    const res = run(['--population', 'C-mdc', '--json']);
    expect(res.status).toBe(EXIT.ok);
    expect(JSON.parse(res.stdout).filters).toEqual({
      populations: ['C-mdc'],
      files: [],
      criteria: [],
    });
    expect(JSON.parse(run(['--json']).stdout).filters).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Fake-Regression: beißt der Prüfer überhaupt?
// ---------------------------------------------------------------------------

describe('Fake-Regression an einer Kopie einer echten Vorlage', () => {
  // FÄNGT: die ganze Kette misst gar nichts. Ein grüner Lauf beweist das nicht —
  // nur ein NACHWEISLICHER Notenverfall bei einer eingebauten Verschlechterung.
  // Verglichen werden Richtungen, keine Absolutzahlen: der Zählstand der
  // Vorlage darf sich ändern, die Richtung nicht.
  it('senkt die Note, wenn eine Kopfzeile über die harte Grenze wächst', () => {
    const root = join(tmpRoot, 'fake-regression');
    const rel = 'skills/demo/SKILL.md';
    const abs = join(root, rel);
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    cpSync(join(REPO_ROOT, CLEAN_TEMPLATE), abs);

    const before = gradesOf(root, rel);
    expect(before.A).toBeGreaterThan(0); // sonst kann nichts fallen

    const original = readFileSync(abs, 'utf8');
    const broken = original.replace(
      /header: "Archetype"/gu,
      'header: "Archetype With A Very Long Header"',
    );
    // Schlägt die Ersetzung fehl, prüft der Fall nichts mehr — dann lieber rot.
    expect(broken).not.toBe(original);
    writeFileSync(abs, broken);

    const after = gradesOf(root, rel);
    expect(after.A).toBeLessThan(before.A);
    expect(after.F).toBeGreaterThan(before.F);

    // Und die Gegenrichtung: zurückgedreht ist die Note wieder da. Ohne diesen
    // Halbsatz könnte der Verfall auch von etwas anderem am Lauf stammen.
    writeFileSync(abs, original);
    expect(gradesOf(root, rel)).toEqual(before);
  });
});
