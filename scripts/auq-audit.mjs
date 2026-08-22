#!/usr/bin/env node
/**
 * auq-audit.mjs — die CLI der AUQ-Klarheitsmessung (#1107).
 *
 * ## Warum es dieses Programm gibt
 *
 * Der Operator hat gesagt, die Fragen, die dieses System ihm stellt, seien zu
 * technisch, zu lang und nicht entscheidbar. Ohne Zahl ist jede Verbesserung
 * daran eine Behauptung. Dieses Programm liefert die Zahl.
 *
 * Es MISST NICHTS SELBST. Es verkabelt drei fertige Module und fügt deren
 * Ergebnis zu einem Bericht zusammen:
 *
 *   scripts/lib/auq/parse.mjs    findet die Vorlagen   (parseRepo)
 *   scripts/lib/auq/clarity.mjs  bewertet sie          (scoreBlocks)
 *   scripts/lib/auq/schema.mjs   der eingefrorene Vertrag + validateReport
 *
 * Eine Schwelle, ein Kriterium oder eine Note in DIESER Datei wäre ein zweiter
 * Ort für dieselbe Regel. Was hier steht, ist ausschließlich: Argumente,
 * Auswahl, Darstellung, Ausgang.
 *
 * ## Namensabweichung, bewusst dokumentiert
 *
 * Der Modulkopf von `schema.mjs` nennt die CLI `scripts/auq-clarity.mjs`. Der
 * Dateiname ist `auq-audit.mjs` — so lautet der vergebene Datei-Scope. Der
 * VERTRAG (`buildReport({ blocks, scores, corpus, head, dirty }) -> AuqReport`)
 * ist unverändert eingehalten; nur der Dateiname weicht ab.
 *
 * ## Zwei Fallen dieses Repos, gegen die hier gebaut ist
 *
 * 1. **`console.log` + `process.exit()` verwirft stdout oberhalb von ~64 KiB.**
 *    stdout ist auf einer Pipe unter macOS asynchron; was nicht mehr in den
 *    Kernel-Puffer passt, liegt in der libuv-Warteschlange und wird von
 *    `process.exit()` weggeworfen. Der `--json`-Umschlag dieses Programms ist
 *    über 1 MB groß und reißt diese Grenze bei JEDEM Lauf. Deshalb geht JEDE
 *    stdout-Ausgabe durch `writeStdoutLineSync` (`scripts/lib/io.mjs`), das
 *    synchron schreibt und EAGAIN wiederholt.
 * 2. **`no-console` steht in `eslint.config.js` auf `off`.** Der Linter fängt
 *    eine nach stdout gerutschte Diagnose NICHT. Die Trennung ist deshalb
 *    strukturell: `out()` schreibt nach stdout, `note()` nach stderr, und es
 *    gibt keinen dritten Weg.
 *
 * ## Warum `--strict` standardmäßig AUS ist
 *
 * Nur H1 und H2 haben eine gemessene Falsch-Positiv-Rate von 0 %; alle anderen
 * Kriterien liegen zwischen 14 % und 25 %. Ein Prüfer, der darauf hart sperrt,
 * meckert bei jeder vierten korrekten Frage — und wird abgeschaltet. Dann ist
 * auch jede richtig gefundene Schwäche weg. Ohne `--strict` ist ein Lauf mit
 * hunderten Befunden deshalb immer noch exit 0.
 *
 * @see .claude/rules/ask-via-tool.md — AUQ-001..005, die gemessene Regel
 * @see .claude/rules/cli-design.md — JSON-first, stdout/stderr, Exit-Codes
 * @see scripts/lib/tests-src-ratio.mjs — Vorbild für Umschlag, `head` und `dirty`
 * @see Issue #1107
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';

import { scoreBlocks } from './lib/auq/clarity.mjs';
import {
  CRITERIA,
  CRITERION_IDS,
  GRADES,
  HURDLES,
  HURDLE_IDS,
  POPULATIONS,
  SCHEMA_VERSION,
  emptyCorpus,
  emptySummary,
  truncateExcerpt,
  validateReport,
} from './lib/auq/schema.mjs';
import { corpusKindOf, parseRepo } from './lib/auq/parse.mjs';
import { writeStdoutLineSync } from './lib/io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_DEFAULT = path.resolve(HERE, '..');

/** Wie viele der schlechtesten Fragen der Bericht ohne `--top` zeigt. */
const DEFAULT_TOP = 10;

// ---------------------------------------------------------------------------
// Exit-Codes
// ---------------------------------------------------------------------------

/**
 * `.claude/rules/cli-design.md` vergibt 0/1/2. Der vierte Code ist die
 * Gate-Entscheidung und steht bewusst NEBEN dem Eingabefehler: eine gerissene
 * Hürde ist kein Bedienfehler, und wer dieses Programm in CI hängt, muss die
 * beiden auseinanderhalten können. In `--help` dokumentiert (cli-design.md:
 * "Document non-standard exit codes in --help").
 */
export const EXIT = Object.freeze({
  ok: 0,
  /** Eingabefehler: unbekannte Flagge, unlesbarer Pfad, kaputter Wert. */
  usage: 1,
  /** Systemfehler: der eigene Bericht verletzt sein eigenes Schema. */
  system: 2,
  /** Nur mit `--strict`: mindestens eine harte Grenze ist gerissen. */
  gate: 3,
});

/**
 * Die gesamte Exit-Politik als reine Funktion.
 *
 * Sie steht hier getrennt, weil genau hier der teure Fehler sitzt: ein
 * `validateReport`, dessen Verdikt gelesen und dann ignoriert wird, und ein
 * `--strict`, das verkabelt aussieht und nichts tut. Beides ist an einer
 * reinen Funktion prüfbar, an einem `process.exit()` mitten in `main()` nicht.
 *
 * @param {{reportValid: boolean, strict: boolean, hurdlesBroken: number}} rec
 * @returns {number}
 */
export function decideExit({ reportValid, strict, hurdlesBroken }) {
  if (!reportValid) return EXIT.system;
  if (strict && hurdlesBroken > 0) return EXIT.gate;
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Ausgabekanäle — die Trennung, die der Linter hier nicht erzwingt
// ---------------------------------------------------------------------------

/**
 * Nach stdout. IMMER synchron: der `--json`-Umschlag liegt weit über dem
 * 64-KiB-Pipe-Puffer, und `console.log` + `process.exit()` würde den Rest
 * verwerfen (siehe Modulkopf, Falle 1).
 *
 * @param {string} line
 */
function out(line) {
  const res = writeStdoutLineSync(line);
  if (!res.ok && res.error !== 'EPIPE') {
    // stdout ist der einzige Kanal, den wir gerade verloren haben — also den
    // anderen nehmen, statt still zu enden.
    process.stderr.write(`auq-audit: stdout-Schreibfehler (${res.error})\n`);
  }
}

/**
 * Nach stderr. Diagnose, Fortschritt, Fehler — nie nach stdout, sonst ist der
 * `--json`-Umschlag unparsebar.
 *
 * @param {string} line
 */
function note(line) {
  process.stderr.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Klartext für den Operator
// ---------------------------------------------------------------------------

/**
 * Operator-lesbare Überschrift je Kriterium.
 *
 * Warum nicht `CRITERIA[k].title`: das ist der INTERNE Kurzname ("Payload-Form",
 * "Header-Grenze"). Ein Bericht über Verständlichkeit, der mit "K7: 21 Befunde"
 * überschreibt, ist genau die Ironie, an der er scheitert. Die Zuordnung fällt
 * auf `CRITERIA[k].title` zurück, falls die Registry ein Kriterium bekommt, das
 * hier fehlt — dann steht ein Kurzname da, aber keine Lücke.
 */
const CRITERION_LABELS = Object.freeze({
  K1: 'Frage ist ein Bericht statt einer Frage',
  K2: 'Sehr langer Satz (nur ein Hinweis)',
  K3: 'Beschreibung wiederholt nur das Label',
  K4: 'Empfehlung ohne Grund, Preis oder Folge',
  K5: 'Kopfzeile zu lang — wird abgeschnitten',
  K6: 'Zu lang oder zu viele Optionen',
  K7: 'Fachbegriffe ohne Erklärung',
  K8: 'Verlangt, erst selbst nachzusehen',
});

/** Klartext je Herkunftsklasse. */
const POPULATION_LABELS = Object.freeze({
  A: 'Claude Code — echter Frage-Aufruf',
  B: 'Codex / Cursor — nummerierte Liste',
  'C-mdc': 'Cursor-Regeldateien (.mdc)',
  'C-mjs': 'Skript-Code (.mjs)',
  'C-prose': 'nur im Fließtext beschrieben',
  'C-hybrid': 'Mischform aus beidem',
});

/** Klartext je Note. */
const GRADE_LABELS = Object.freeze({
  A: 'sehr gut',
  B: 'gut',
  C: 'brauchbar',
  D: 'schwach',
  F: 'durchgefallen',
});

/** @param {string} id */
function criterionLabel(id) {
  return CRITERION_LABELS[id] ?? CRITERIA[id]?.title ?? id;
}

/** @param {string} id */
function populationLabel(id) {
  return POPULATION_LABELS[id] ?? id;
}

// ---------------------------------------------------------------------------
// git-Anker: WANN wurde gemessen, und ist die Zahl reproduzierbar
// ---------------------------------------------------------------------------

/**
 * Kurzer HEAD-SHA, oder `null` ausserhalb eines git-Repos.
 *
 * @param {string} root
 * @returns {string|null}
 */
function headRef(root) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Weicht irgendeine GETRACKTE Datei vom Index ab?
 *
 * Tragend, nicht Deko: die Dateiliste kommt aus dem git-INDEX, der Inhalt aber
 * aus dem ARBEITSBAUM. Auf einem schmutzigen Baum ist das Paar (`head`,
 * Notenverteilung) eine Behauptung, die niemand an diesem SHA reproduzieren
 * kann — der Bericht sagt das dann ausdrücklich.
 *
 * FAIL-CLOSED: kann git nicht antworten (kein Repo), gilt `true`. "Unbekannt"
 * ist kein Anker, und `false` würde Reproduzierbarkeit behaupten, die niemand
 * geprüft hat.
 *
 * `--no-optional-locks` verhindert, dass ein beiläufiges `git status` den
 * `.git/index` neu schreibt und damit eine parallele Session anschiebt
 * (PSA-007) — dieselbe Flagge, derselbe Grund wie in tests-src-ratio.mjs.
 *
 * @param {string} root
 * @returns {boolean}
 */
function isDirty(root) {
  try {
    const outp = execFileSync(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return outp.split('\n').some((l) => l.trim() !== '');
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Der Umschlag
// ---------------------------------------------------------------------------

/**
 * Ein Befund zählt gegen die Punkte, wenn er `fail` ist UND nicht befreit.
 * Dieselbe Bedingung wie in `clarity.pointsFor` — hier nur zum ZÄHLEN, nie zum
 * Neuberechnen einer Note.
 *
 * @param {import('./lib/auq/schema.mjs').AuqFinding} f
 */
function isCountedFailure(f) {
  return f.severity === 'fail' && f.exempt === null;
}

/**
 * Fügt den Bericht zusammen. MISST NICHTS — `summary` wird ausschließlich aus
 * den übergebenen `scores` hochgezählt.
 *
 * `summary` ist bewusst ABGELEITET und kein Parameter: eine von Hand
 * mitgeführte Zusammenfassung ist ein Defekt in Wartestellung.
 *
 * @param {{blocks: import('./lib/auq/schema.mjs').AuqBlock[],
 *          scores: import('./lib/auq/schema.mjs').AuqScore[],
 *          corpus: Record<string, number>,
 *          head: string|null,
 *          dirty: boolean,
 *          warnings?: string[],
 *          filters?: object,
 *          measuredAt?: string}} rec
 * @returns {import('./lib/auq/schema.mjs').AuqReport}
 */
export function buildReport(rec) {
  const blocks = Array.isArray(rec?.blocks) ? rec.blocks : [];
  const scores = Array.isArray(rec?.scores) ? rec.scores : [];
  const summary = emptySummary();

  for (const score of scores) {
    if (Object.prototype.hasOwnProperty.call(summary.grades, score.grade)) {
      summary.grades[score.grade] += 1;
    }
    for (const finding of score.findings) {
      const bucket = summary.byCriterion[finding.criterion];
      if (bucket !== undefined) bucket[finding.severity] += 1;
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    measuredAt: typeof rec?.measuredAt === 'string' ? rec.measuredAt : new Date().toISOString(),
    head: typeof rec?.head === 'string' ? rec.head : null,
    dirty: rec?.dirty !== false,
    corpus: { ...emptyCorpus(), ...(rec?.corpus ?? {}) },
    blocks,
    scores,
    summary,
    // Zwei additive Felder ausserhalb des AuqReport-Kerns. `validateReport`
    // ignoriert unbekannte Schlüssel, der Vertrag bleibt also eingehalten.
    // Beide verhindern eine FALSCHE LESART, nicht bloß Bequemlichkeit:
    //   warnings — die Extraktion hat etwas übersprungen; ohne diese Liste sähe
    //              ein Nicht-Befund wie ein Bestehen aus.
    //   filters  — eine gefilterte Zahl ist NICHT die Baseline. Wer sie später
    //              zitiert, muss sehen können, worüber gemessen wurde.
    warnings: Array.isArray(rec?.warnings) ? [...rec.warnings] : [],
    filters: rec?.filters ?? null,
  };
}

// ---------------------------------------------------------------------------
// Auswahl
// ---------------------------------------------------------------------------

/**
 * Wendet `--population` / `--file` / `--criterion` auf die BLÖCKE an.
 *
 * Alle drei sind Selektoren auf FRAGEN, nie auf Befunde: würde `--criterion`
 * die Befundliste einer Frage beschneiden, käme eine Note heraus, die es nicht
 * gibt. Eine Frage wird deshalb entweder ganz gezeigt oder gar nicht.
 *
 * @param {import('./lib/auq/schema.mjs').AuqBlock[]} blocks
 * @param {{populations: string[], files: string[], criteria: string[]}} filters
 * @returns {import('./lib/auq/schema.mjs').AuqBlock[]}
 */
function applyFilters(blocks, filters) {
  const { populations, files, criteria } = filters;
  if (populations.length === 0 && files.length === 0 && criteria.length === 0) return blocks;

  const matchesFile = (file) =>
    files.length === 0 || files.some((f) => file === f || file.startsWith(`${f.replace(/\/$/u, '')}/`));

  const out2 = [];
  for (const block of blocks) {
    const kept = block.questions.filter((q) => {
      if (populations.length > 0 && !populations.includes(q.population)) return false;
      if (!matchesFile(q.file)) return false;
      if (criteria.length > 0) {
        // Eine Frage bleibt, wenn sie MINDESTENS EINEN Befund des gesuchten
        // Kriteriums trägt — bewertet wird sie danach unverändert.
        const score = scoreBlocks([{ ...block, questions: [q] }])[0];
        if (!score || !score.findings.some((f) => criteria.includes(f.criterion))) return false;
      }
      return true;
    });
    if (kept.length > 0) out2.push({ ...block, questions: kept });
  }
  return out2;
}

// ---------------------------------------------------------------------------
// Kennzahlen für den lesbaren Bericht
// ---------------------------------------------------------------------------

/**
 * Bestanden heißt: KEINE harte Grenze gerissen UND kein Fehler-Befund.
 *
 * Diese Definition erfindet keine neue Schwelle — sie liest nur zusammen, was
 * `clarity.mjs` bereits entschieden hat. Der Bericht schreibt sie ausdrücklich
 * hin, damit die Leitzahl nicht unbeschriftet dasteht.
 *
 * @param {import('./lib/auq/schema.mjs').AuqScore} score
 */
function passes(score) {
  return score.hurdlesBroken.length === 0 && !score.findings.some(isCountedFailure);
}

/** @param {number} part @param {number} whole */
function pct(part, whole) {
  if (whole === 0) return '   0 %';
  return `${String(Math.round((part / whole) * 100)).padStart(3, ' ')} %`;
}

/** Rechtsbündige Zahl in fester Breite. */
function num(n, width) {
  return String(n).padStart(width, ' ');
}

/** Linksbündiger Text in fester Breite. */
function pad(s, width) {
  const chars = [...String(s)];
  return chars.length >= width ? String(s) : String(s) + ' '.repeat(width - chars.length);
}

/**
 * Rangfolge der schlechtesten Fragen: erst die schlechteste Note, dann die
 * wenigsten Punkte, dann die meisten Fehler, zuletzt Datei/Zeile — damit zwei
 * Läufe über denselben Baum dieselbe Reihenfolge liefern und sich diffen lassen.
 *
 * Die Note steht VOR den Punkten, weil eine gerissene harte Grenze die Note
 * übersteuert: eine F-Frage mit 50 Punkten ist nach dem Urteil des Bewerters
 * schlechter als eine D-Frage mit denselben 50 Punkten, und eine Liste, die das
 * umdreht, widerspricht der Tabelle darüber.
 *
 * @param {import('./lib/auq/schema.mjs').AuqScore[]} scores
 */
function worstFirst(scores) {
  const rank = (g) => GRADES.indexOf(g);
  return [...scores].sort((a, b) => {
    if (a.grade !== b.grade) return rank(b.grade) - rank(a.grade);
    if (a.points !== b.points) return a.points - b.points;
    const af = a.findings.filter(isCountedFailure).length;
    const bf = b.findings.filter(isCountedFailure).length;
    if (af !== bf) return bf - af;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}

/** Findet die Frage zu einem Ergebnis — für Zitat und Herkunft. */
function questionOf(blocks, score) {
  for (const block of blocks) {
    for (let i = 0; i < block.questions.length; i++) {
      const q = block.questions[i];
      if (q.file === score.file && q.line === score.line && i === score.questionIndex) return q;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Der lesbare Bericht
// ---------------------------------------------------------------------------

/**
 * Baut den menschenlesbaren Bericht.
 *
 * Dieser Text ist das erste Erzeugnis dieser Messung, das der Operator liest,
 * und er handelt davon, dass Ausgaben lesbar sein sollen. Deshalb: deutsch,
 * keine Kriteriums-Kürzel als Überschrift, keine nackte unbeschriftete Zahl,
 * keine Bedeutung allein über Farbe oder Zeichen, jede Tabelle mit Kopf — und
 * kurz, weil ein Bericht, der nicht zu Ende gelesen wird, nichts misst.
 *
 * @param {import('./lib/auq/schema.mjs').AuqReport} report
 * @param {{top: number}} opts
 * @returns {string}
 */
export function renderHuman(report, opts) {
  const L = [];
  const scores = report.scores;
  const total = scores.length;
  const passed = scores.filter(passes).length;
  const failed = total - passed;

  L.push('AUQ-Klarheitsmessung — wie verständlich sind die Fragen, die dieses System stellt?');
  const anchor = report.head ? `HEAD ${report.head}` : 'kein git-Anker';
  L.push(
    `Gemessen am ${report.measuredAt} · ${anchor} · Arbeitsbaum: ${report.dirty ? 'GEÄNDERT' : 'sauber'}`,
  );
  if (report.dirty) {
    L.push(
      '  Achtung: der Arbeitsbaum weicht vom letzten Commit ab. Diese Zahlen sind an diesem',
      '  Stand NICHT reproduzierbar — für eine zitierfähige Baseline auf sauberem Baum messen.',
    );
  }
  if (report.filters) {
    const f = report.filters;
    const parts = [];
    if (f.populations?.length) parts.push(`Herkunft: ${f.populations.join(', ')}`);
    if (f.files?.length) parts.push(`Dateien: ${f.files.join(', ')}`);
    if (f.criteria?.length) parts.push(`Kriterien: ${f.criteria.join(', ')}`);
    if (parts.length > 0) {
      L.push(`  Eingegrenzt auf ${parts.join(' · ')} — das ist NICHT die Gesamtzahl des Repos.`);
    }
  }
  L.push('');

  // --- Die Leitzahl -------------------------------------------------------
  L.push(
    `${passed} von ${total} Fragen bestehen (${pct(passed, total).trim()}). ` +
      `${failed} bestehen nicht (${pct(failed, total).trim()}).`,
  );
  L.push(
    '  Bestanden heißt: keine harte Grenze gerissen und kein einziger Fehler-Befund.',
  );
  L.push('');

  if (total === 0) {
    L.push('Keine Frage-Vorlage gefunden. Prüfe die Eingrenzung oder den Pfad.');
    return L.join('\n');
  }

  // --- Noten --------------------------------------------------------------
  L.push('Noten (Punkte von 100; eine gerissene harte Grenze ergibt immer die schlechteste Note)');
  L.push(`  ${pad('Note', 22)}${num('Fragen', 7)}   Anteil`);
  for (const g of GRADES) {
    const n = report.summary.grades[g] ?? 0;
    L.push(`  ${pad(`${g} — ${GRADE_LABELS[g] ?? ''}`, 22)}${num(n, 7)}   ${pct(n, total)}`);
  }
  L.push('');

  // --- Harte Grenzen ------------------------------------------------------
  const brokenBy = {};
  for (const h of HURDLE_IDS) brokenBy[h] = 0;
  let anyHurdle = 0;
  for (const s of scores) {
    if (s.hurdlesBroken.length > 0) anyHurdle += 1;
    for (const h of s.hurdlesBroken) brokenBy[h] = (brokenBy[h] ?? 0) + 1;
  }
  L.push('Harte Grenzen — das Werkzeug selbst schneidet hier ab, das ist keine Stilfrage');
  L.push(`  ${pad("Grenze", 56)}${num('Fragen', 7)}   Anteil`);
  for (const h of HURDLE_IDS) {
    L.push(`  ${pad(HURDLES[h].title, 56)}${num(brokenBy[h], 7)}   ${pct(brokenBy[h], total)}`);
  }
  L.push(`  ${pad("mindestens eine der beiden gerissen", 56)}${num(anyHurdle, 7)}   ${pct(anyHurdle, total)}`);
  L.push('');

  // --- Befunde je Kriterium -----------------------------------------------
  L.push('Was schiefgeht — Fehler ziehen Punkte ab, Hinweise nicht');
  L.push(`  ${pad('Befund', 46)}${num('Fehler', 8)}${num('Hinweise', 10)}`);
  const rows = CRITERION_IDS.map((k) => ({ k, ...report.summary.byCriterion[k] })).sort(
    (a, b) => b.fail - a.fail || b.warn - a.warn,
  );
  for (const r of rows) {
    if (r.fail === 0 && r.warn === 0) continue;
    L.push(`  ${pad(criterionLabel(r.k), 46)}${num(r.fail, 8)}${num(r.warn, 10)}`);
  }
  L.push('');

  // --- Nach Herkunft ------------------------------------------------------
  const byPop = new Map();
  for (const s of scores) {
    const q = questionOf(report.blocks, s);
    const p = q?.population ?? 'unbekannt';
    const rec = byPop.get(p) ?? { total: 0, passed: 0, hurdles: 0 };
    rec.total += 1;
    if (passes(s)) rec.passed += 1;
    if (s.hurdlesBroken.length > 0) rec.hurdles += 1;
    byPop.set(p, rec);
  }
  L.push('Nach Herkunft — wo die Frage steht, entscheidet, welches Werkzeug sie stellt');
  L.push(`  ${pad('Herkunft', 38)}${num('Fragen', 7)}${num('bestehen', 10)}   Anteil`);
  for (const p of POPULATIONS) {
    const rec = byPop.get(p);
    if (!rec) continue;
    L.push(
      `  ${pad(`${p} — ${populationLabel(p)}`, 38)}${num(rec.total, 7)}${num(rec.passed, 10)}   ` +
        `${pct(rec.passed, rec.total)}`,
    );
  }
  L.push('');

  // --- Die schlechtesten Fragen -------------------------------------------
  const worst = worstFirst(scores).slice(0, Math.max(0, opts.top));
  if (worst.length > 0) {
    L.push(`Die ${worst.length} schlechtesten Fragen — Datei und Zeile zum Nachschlagen`);
    worst.forEach((s, i) => {
      const q = questionOf(report.blocks, s);
      const hurdleNote =
        s.hurdlesBroken.length > 0 ? ` · harte Grenze gerissen: ${s.hurdlesBroken.join(', ')}` : '';
      L.push(`  ${num(i + 1, 2)}. ${s.file}:${s.line} — Note ${s.grade}, ${s.points} Punkte${hurdleNote}`);
      if (q) L.push(`      Frage: „${truncateExcerpt(q.question)}"`);
      const reasons = [...new Set(s.findings.filter(isCountedFailure).map((f) => criterionLabel(f.criterion)))];
      if (reasons.length > 0) L.push(`      Fehler: ${reasons.join(' · ')}`);
    });
    L.push('');
  }

  // --- Leseprobleme -------------------------------------------------------
  if (report.warnings.length > 0) {
    L.push(`Beim Einlesen übersprungen oder auffällig (${report.warnings.length})`);
    for (const w of report.warnings.slice(0, 10)) L.push(`  - ${w}`);
    if (report.warnings.length > 10) L.push(`  … und ${report.warnings.length - 10} weitere`);
    L.push('');
  }

  L.push('Vollständige Daten je Frage und Befund: dasselbe Kommando mit --json.');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Argumente
// ---------------------------------------------------------------------------

const USAGE = 'Aufruf: node scripts/auq-audit.mjs [<repo-wurzel>] [--json] [--strict] [--top N] [--criterion K7] [--population A] [--file <pfad>]';

/**
 * @param {string[]} argv
 * @returns {{error: string|null, help: boolean, version: boolean, json: boolean,
 *            strict: boolean, top: number, criteria: string[], populations: string[],
 *            files: string[], root: string}}
 */
export function parseCliArgs(argv) {
  const base = {
    error: null,
    help: false,
    version: false,
    json: false,
    strict: false,
    top: DEFAULT_TOP,
    criteria: [],
    populations: [],
    files: [],
    root: REPO_ROOT_DEFAULT,
  };

  let parsed;
  try {
    parsed = nodeParseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        top: { type: 'string' },
        criterion: { type: 'string', multiple: true },
        population: { type: 'string', multiple: true },
        file: { type: 'string', multiple: true },
      },
    });
  } catch (err) {
    return { ...base, error: err?.message ?? String(err) };
  }

  const v = parsed.values;
  const criteria = v.criterion ?? [];
  for (const c of criteria) {
    if (!CRITERION_IDS.includes(c)) {
      return { ...base, error: `unbekanntes Kriterium: ${c} (erlaubt: ${CRITERION_IDS.join(', ')})` };
    }
  }
  const populations = v.population ?? [];
  for (const p of populations) {
    if (!POPULATIONS.includes(p)) {
      return { ...base, error: `unbekannte Herkunft: ${p} (erlaubt: ${POPULATIONS.join(', ')})` };
    }
  }

  let top = DEFAULT_TOP;
  if (v.top !== undefined) {
    const n = Number(v.top);
    if (!Number.isInteger(n) || n < 0) {
      return { ...base, error: `--top braucht eine ganze Zahl >= 0 (bekommen: ${v.top})` };
    }
    top = n;
  }

  if (parsed.positionals.length > 1) {
    return { ...base, error: `höchstens eine Repo-Wurzel erlaubt (bekommen: ${parsed.positionals.length})` };
  }

  return {
    ...base,
    help: v.help === true,
    version: v.version === true,
    json: v.json === true,
    strict: v.strict === true,
    top,
    criteria: [...criteria],
    populations: [...populations],
    files: (v.file ?? []).map((f) => f.replace(/\\/gu, '/').replace(/^\.\//u, '')),
    root: parsed.positionals[0] ? path.resolve(parsed.positionals[0]) : REPO_ROOT_DEFAULT,
  };
}

function printHelp() {
  out(USAGE);
  out('');
  out('Misst, wie verständlich die Fragen sind, die dieses System dem Operator stellt.');
  out('Findet jede Frage-Vorlage im Repo, benotet sie gegen acht Kriterien und zwei');
  out('harte Grenzen, und gibt eine Notenverteilung aus. Rein deterministisch, kein LLM.');
  out('');
  out('  --json              maschinenlesbarer Umschlag auf stdout, sonst nichts');
  out('  --strict            Ausgang 3, wenn mindestens eine harte Grenze gerissen ist');
  out(`  --top N             die N schlechtesten Fragen zeigen (Vorgabe: ${DEFAULT_TOP})`);
  out(`  --criterion K7      nur Fragen mit einem Befund dieses Kriteriums (erlaubt: ${CRITERION_IDS.join(', ')})`);
  out(`  --population A      nur diese Herkunft (erlaubt: ${POPULATIONS.join(', ')})`);
  out('  --file <pfad>       nur diese Datei oder dieses Verzeichnis (repo-relativ)');
  out('  --help / --version');
  out('');
  out('  <repo-wurzel>       Wurzel des zu messenden Repos (Vorgabe: dieses Repo)');
  out('');
  out('Alle drei Eingrenzungen wirken auf FRAGEN, nie auf Befunde: eine Frage wird ganz');
  out('gezeigt oder gar nicht. Eine eingegrenzte Zahl ist nie die Gesamtzahl des Repos —');
  out('der Umschlag führt die gesetzten Eingrenzungen deshalb im Feld "filters" mit.');
  out('');
  out('Warum --strict standardmäßig aus ist: nur die beiden harten Grenzen haben eine');
  out('gemessene Falsch-Positiv-Rate von 0 %, die übrigen Kriterien liegen zwischen 14 %');
  out('und 25 %. Ein Prüfer, der darauf sperrt, meckert korrekte Fragen an und wird');
  out('abgeschaltet — dann ist auch jeder echte Befund weg.');
  out('');
  out('Ausgang: 0 Erfolg · 1 Eingabefehler · 2 Systemfehler (Bericht verletzt sein');
  out('eigenes Schema) · 3 nur mit --strict: harte Grenze gerissen.');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.error) {
    note(`Fehler: ${args.error}`);
    note(USAGE);
    process.exit(EXIT.usage);
  }
  if (args.help) {
    printHelp();
    process.exit(EXIT.ok);
  }
  if (args.version) {
    // Die Version des Umschlag-Schemas ist die, an der ein Konsument hängt —
    // die Paketversion steht daneben, weil `--version` sie erwartet.
    out(`auq-audit ${pkgVersion()} (Umschlag ${SCHEMA_VERSION})`);
    process.exit(EXIT.ok);
  }

  if (!existsSync(args.root) || !statSync(args.root).isDirectory()) {
    note(`Fehler: Repo-Wurzel nicht lesbar: ${args.root}`);
    process.exit(EXIT.usage);
  }

  // Nennt `--file` ausschließlich konkrete Korpus-DATEIEN, werden genau die
  // gelesen und `git ls-files` gar nicht erst gerufen — so ist die CLI auch auf
  // einem Verzeichnis ohne git-Repo benutzbar (und genau so testbar). Sobald
  // ein Verzeichnis-PRÄFIX dabei ist, braucht es die Aufzählung; die
  // Eingrenzung übernimmt dann `applyFilters`.
  const explicit = args.files.filter((f) => corpusKindOf(f) !== null);
  const prefixes = args.files.filter((f) => corpusKindOf(f) === null);
  let files;
  if (args.files.length > 0 && prefixes.length === 0) {
    const missing = explicit.filter((f) => !existsSync(path.join(args.root, f)));
    if (missing.length > 0) {
      note(`Fehler: Datei nicht gefunden: ${missing.join(', ')}`);
      process.exit(EXIT.usage);
    }
    files = explicit;
  }

  const parsedRepo = parseRepo({ repoRoot: args.root, files });
  const blocks = applyFilters(parsedRepo.blocks, {
    populations: args.populations,
    files: args.files,
    criteria: args.criteria,
  });
  const scores = scoreBlocks(blocks);

  // `corpus` wird aus den GEFILTERTEN Blöcken neu gezählt, sonst behauptete der
  // Umschlag eine Grundgesamtheit, die im Bericht gar nicht steht.
  const corpus = emptyCorpus();
  for (const b of blocks) {
    const p = b.questions[0]?.population;
    if (p !== undefined) corpus[p] += 1;
  }

  const hasFilters =
    args.populations.length > 0 || args.files.length > 0 || args.criteria.length > 0;

  // Ist der Bericht eingegrenzt, müssen die Lesewarnungen mitgehen: eine
  // Warnung über eine Datei, die im Bericht gar nicht vorkommt, liest sich wie
  // ein Mangel der gezeigten Auswahl. Jede Warnung beginnt mit `datei:zeile:`.
  const keptFiles = new Set(blocks.flatMap((b) => b.questions.map((q) => q.file)));
  const warnings = hasFilters
    ? parsedRepo.warnings.filter((w) => [...keptFiles].some((f) => w.startsWith(`${f}:`)))
    : parsedRepo.warnings;

  const report = buildReport({
    blocks,
    scores,
    corpus,
    head: headRef(args.root),
    dirty: isDirty(args.root),
    warnings,
    filters: hasFilters
      ? { populations: args.populations, files: args.files, criteria: args.criteria }
      : null,
  });

  // Ein Bericht, der sein eigenes Schema verletzt, ist schlimmer als keiner:
  // er sieht aus wie eine Messung und ist eine. Deshalb VOR der Ausgabe prüfen
  // und im Fehlerfall gar keinen Umschlag schreiben.
  const verdict = validateReport(report);
  if (!verdict.ok) {
    note('Fehler: der erzeugte Bericht verletzt sein eigenes Schema — nichts ausgegeben.');
    for (const e of verdict.errors.slice(0, 20)) note(`  - ${e}`);
    if (verdict.errors.length > 20) note(`  … und ${verdict.errors.length - 20} weitere`);
    process.exit(decideExit({ reportValid: false, strict: args.strict, hurdlesBroken: 0 }));
  }

  if (args.json) out(JSON.stringify(report, null, 2));
  else out(renderHuman(report, { top: args.top }));

  const hurdlesBroken = scores.filter((s) => s.hurdlesBroken.length > 0).length;
  if (args.strict && hurdlesBroken > 0) {
    note(`--strict: ${hurdlesBroken} Frage(n) reißen eine harte Grenze.`);
  }
  process.exit(decideExit({ reportValid: true, strict: args.strict, hurdlesBroken }));
}

/** Paketversion, oder `0.0.0` wenn package.json nicht lesbar ist. */
function pkgVersion() {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT_DEFAULT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
