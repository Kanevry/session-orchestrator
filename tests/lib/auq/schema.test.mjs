/**
 * schema.test.mjs — pins the AUQ-Klarheitsmessung CONTRACT (#1107).
 *
 * ## TV-001: die konkreten Fehler, die diese Tests fangen und die bestehende Suite durchlässt
 *
 * Das Modul ist neu — aber "neu" ist keine TV-001-Begründung. Jeder Fall unten
 * benennt einen Defekt, der EINGEBAUT werden kann und den sonst nichts sieht,
 * weil drei Module gleichzeitig gegen dieses Schema bauen und ein falscher
 * Vertrag dort dreifach falsch ankommt:
 *
 *   1. BYTE- statt CODEPOINT-ZÄHLUNG. `Buffer.byteLength('Evolve — Review')` ist
 *      17, die Kopfzeile hat 15 Zeichen — bytebasiert reißt sie eine 12er-Grenze,
 *      die sie nicht reißt. `.length` ist der zweite falsche Weg: es zählt
 *      UTF-16-Einheiten, also ein Emoji doppelt. Beide Fehlwege sind hier
 *      gegeneinander gepinnt.
 *
 *   2. NOTENGRENZEN-OFF-BY-ONE. `>` statt `>=` verschiebt jede Note um einen
 *      Punkt; 90 wäre dann ein B. Sichtbar wird das erst im Bericht vor dem
 *      Operator, wo es niemand mehr nachrechnet.
 *
 *   3. GEWICHTSSUMME ≠ 100. Wird ein Gewicht editiert, ohne die Summe
 *      nachzuziehen, verlieren die Notenbänder ihren Bezug — `points` ist dann
 *      keine Prozentzahl mehr, aber gradeFor rechnet weiter, als wäre es eine.
 *
 *   4. HÜRDE OHNE ÜBERSTEUERUNG. Eine gerissene Hürde MUSS F ergeben, auch bei
 *      95 Punkten. Vergisst der Bewerter das, sieht der Bericht eine Frage als
 *      "A" an, deren Kopfzeile das Tool selbst abschneidet.
 *
 *   5. SICHERHEITSTEXT ALS LÄNGENVERSTOSS. Ein 99-Zeichen-Warntext darf nie als
 *      Längenverstoß in den Bericht — sonst greift ihn ein späterer
 *      Kürzungsschritt auf und entfernt genau die Disclosure, die
 *      `soul.md` § "Never traded for brevity" schützt. Zweiter Teil desselben
 *      Defekts: die Ausnahme darf NUR die Längenkriterien befreien, nie K7 —
 *      sonst hört die Jargon-Prüfung für Warntexte stillschweigend auf.
 *
 *   6. UNGÜLTIGER DATENSATZ LÄUFT DURCH. Ein Befund mit der Kriteriums-ID `K9`
 *      oder ein Options-Befund ohne Index ist keiner Option zuzuordnen und
 *      fehlt in `summary.byCriterion` schlicht — lautlos.
 *
 *   7. VALIDATOR STÜRZT AB. `validateReport` ist die Fehlermeldung der CLI; wirft
 *      sie selbst, nimmt sie dem Operator genau die Diagnose weg, für die sie da
 *      ist. Gepinnt gegen `null`, String und ein zyklisches Objekt.
 *
 *   8. SUPERLATIV-REGEX STATT WORTLISTE. `\b\w+est\b` trifft im echten Korpus
 *      `Test`, `Vitest`, `pytest`, `latest`, `Manifest` — 5 von 8 Treffern sind
 *      keine Superlative. Wer die geschlossene Liste durch ein Muster ersetzt,
 *      markiert jede Option, die das Wort "Test" enthält, als begründet.
 *
 *   9. NAIVES PFADMUSTER. `\w+/\w+` trifft auf deutschem Text `Erfolg/Abbruch`,
 *      `Skill-/Phasen-Nutzung`, `Pfade/Prompts/Repo-Namen` — gemessen 33 statt
 *      18 markierte Beschreibungen. Der Test pinnt beide Richtungen.
 *
 *  10. GETEILTE GLOBALE REGEXP. Ein `g`-Flag in der eingefrorenen Registry
 *      schleppt `lastIndex` mit: derselbe Aufruf liefert beim zweiten Mal ein
 *      anderes Ergebnis. Gepinnt über zwei aufeinanderfolgende Aufrufe.
 *
 * Kein Test hier behauptet, dass ein Satz in einer Markdown-Datei steht.
 */

import { describe, it, expect } from 'vitest';

import {
  SCHEMA_VERSION,
  CRITERIA,
  CRITERION_IDS,
  TOTAL_WEIGHT,
  HURDLES,
  SCOPES,
  SEVERITIES,
  MARKER_CLASSES,
  IDENTIFIER_PATTERNS,
  IDENTIFIER_ALLOWLIST,
  LENGTH_CRITERIA,
  EXCERPT_MAX_CHARS,
  codepointLength,
  normalizeLiteralNewlines,
  globalOf,
  gradeFor,
  isLengthExempt,
  makeOption,
  makeQuestion,
  makeBlock,
  makeFinding,
  makeScore,
  emptyCorpus,
  emptySummary,
  validateReport,
} from '../../../scripts/lib/auq/schema.mjs';

// ---------------------------------------------------------------------------
// Hilfsbau eines gültigen Berichts (nur über die Fabriken — kein Handliteral,
// damit der Test nicht seine eigene zweite Schema-Kopie wird)
// ---------------------------------------------------------------------------

function validReport() {
  const options = [
    makeOption({
      index: 0,
      label: 'Jetzt schließen (Recommended)',
      description: 'Dauert ~2 Minuten und friert den Plan ein.',
      isRecommended: true,
    }),
    makeOption({
      index: 1,
      label: 'Weiterarbeiten',
      description: 'Kostet eine weitere Welle, dafür bleibt der Umfang offen.',
    }),
  ];
  const question = makeQuestion({
    question: 'Session jetzt schließen?',
    header: 'Abschluss',
    options,
    file: 'skills/session-end/SKILL.md',
    line: 42,
    population: 'A',
    kind: 'template',
    quoting: 'double',
  });
  const block = makeBlock({ file: 'skills/session-end/SKILL.md', line: 40, questions: [question] });
  const score = makeScore({
    file: 'skills/session-end/SKILL.md',
    line: 42,
    questionIndex: 0,
    points: 100,
  });
  const corpus = emptyCorpus();
  corpus.A = 1;
  const summary = emptySummary();
  summary.grades.A = 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    measuredAt: '2026-08-22T10:00:00.000Z',
    head: 'a4f93cf',
    dirty: false,
    corpus,
    blocks: [block],
    scores: [score],
    summary,
  };
}

// ---------------------------------------------------------------------------

describe('codepointLength — Zeichen, nicht Bytes und nicht UTF-16-Einheiten (Fehler 1)', () => {
  it('zählt den Gedankenstrich als EIN Zeichen, wo Buffer.byteLength drei zählt', () => {
    const header = 'Evolve — Review';
    expect(codepointLength(header)).toBe(15);
    // Der Beweis, dass die Falle real ist: byteweise gemessen wären es 17,
    // also 5 über der H1-Grenze statt 3.
    expect(Buffer.byteLength(header, 'utf8')).toBe(17);
  });

  it('zählt ein astrales Zeichen als EINS, wo .length zwei zählt', () => {
    const header = '🚨 Alert';
    expect(codepointLength(header)).toBe(7);
    expect(header.length).toBe(8);
  });

  it('gibt 0 für Nicht-Strings zurück statt zu werfen', () => {
    expect(codepointLength(null)).toBe(0);
    expect(codepointLength(undefined)).toBe(0);
    expect(codepointLength(42)).toBe(0);
  });

  it('normalizeLiteralNewlines ersetzt literale UND echte Umbrüche durch ein Leerzeichen', () => {
    expect(normalizeLiteralNewlines('a\\nb\nc')).toBe('a b c');
  });
});

describe('gradeFor — die Notengrenzen sind inklusiv (Fehler 2)', () => {
  it('setzt jede Bandgrenze und den Punkt darunter', () => {
    expect([100, 90, 89, 75, 74, 60, 59, 45, 44, 0].map(gradeFor)).toEqual([
      'A',
      'A',
      'B',
      'B',
      'C',
      'C',
      'D',
      'D',
      'F',
      'F',
    ]);
  });

  it('gibt F für alles zurück, was keine endliche Zahl ist', () => {
    expect([NaN, Infinity, null, undefined, '90'].map(gradeFor)).toEqual(['F', 'F', 'F', 'F', 'F']);
  });
});

describe('Kriterien-Registry — Gewichtssumme und Unveränderlichkeit (Fehler 3)', () => {
  it('summiert alle Gewichte auf genau 100, damit points eine Prozentzahl ist', () => {
    const sum = CRITERION_IDS.reduce((acc, id) => acc + CRITERIA[id].weight, 0);
    expect(sum).toBe(100);
    expect(TOTAL_WEIGHT).toBe(100);
  });

  it('gibt jedem Kriterium einen bekannten Zuständigkeitsbereich', () => {
    // Ein vertipptes `appliesTo` ("options" statt "option") lässt clarity.mjs
    // das Kriterium beim Verteilen still überspringen — es fehlt dann im
    // Bericht, ohne dass irgendwo ein Fehler auftaucht.
    for (const id of CRITERION_IDS) {
      expect(SCOPES).toContain(CRITERIA[id].appliesTo);
      expect(SEVERITIES).toContain(CRITERIA[id].severity);
    }
  });

  it('lässt K2 nie zu einem Fehler werden und bindet K5 an die Hürde H1', () => {
    expect(CRITERIA.K2.weight).toBe(0);
    expect(CRITERIA.K2.severity).toBe('warn');
    expect(CRITERIA.K5.hurdle).toBe('H1');
    expect(CRITERIA.K6.hurdle).toBe('H2');
    expect(HURDLES.H1.criterion).toBe('K5');
    expect(HURDLES.H2.criterion).toBe('K6');
  });

  it('ist eingefroren — ein Modul kann die Schwellen der beiden anderen nicht umschreiben', () => {
    expect(() => {
      CRITERIA.K1.weight = 999;
    }).toThrow();
    expect(CRITERIA.K1.weight).toBe(20);
  });
});

describe('makeScore — eine gerissene Hürde übersteuert die Punktzahl (Fehler 4)', () => {
  it('vergibt F bei 95 Punkten, wenn H1 gerissen ist', () => {
    const score = makeScore({
      file: 'skills/plan/SKILL.md',
      line: 137,
      questionIndex: 0,
      points: 95,
      hurdlesBroken: ['H1'],
    });
    expect(score.grade).toBe('F');
    expect(score.points).toBe(95);
  });

  it('vergibt ohne Hürde die Note der Punktzahl', () => {
    const score = makeScore({ file: 'a.md', line: 1, questionIndex: 0, points: 95 });
    expect(score.grade).toBe('A');
  });

  it('weist eine unbekannte Hürde und Punkte außerhalb 0–100 zurück', () => {
    expect(() =>
      makeScore({ file: 'a.md', line: 1, questionIndex: 0, points: 50, hurdlesBroken: ['H9'] }),
    ).toThrow(/H9/);
    expect(() => makeScore({ file: 'a.md', line: 1, questionIndex: 0, points: 101 })).toThrow(
      /zwischen 0 und 100/,
    );
  });

  it('fängt ein handgebautes Ergebnis, das die Hürde reißt und trotzdem eine Note trägt', () => {
    const report = validReport();
    report.scores = [
      { ...report.scores[0], hurdlesBroken: ['H1'], grade: 'A' },
    ];
    const verdict = validateReport(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/muss "F" sein/);
  });
});

describe('Sicherheits-Ausnahme — Warntexte sind von der Länge befreit, sonst nichts (Fehler 5)', () => {
  // 99 Zeichen: das gemessene Maximum der 9 sicherheitsrelevanten Beschreibungen
  // im Repo. Liegt unter der WARN-Grenze 120 — die Ausnahme ist Vorsorge.
  const warntext =
    'Löscht den Worktree samt ungepushter Commits unwiderruflich; verlorene Arbeit ist nicht mehr da.';
  const harmlos =
    'Zerlegt die Aufgabe in kleinere Schritte und arbeitet sie nacheinander ab, bis alles fertig ist.';

  it('erkennt einen zerstörenden Warntext als längenbefreit, einen harmlosen nicht', () => {
    expect(isLengthExempt(warntext)).toBe('length');
    expect(isLengthExempt(harmlos)).toBe(null);
  });

  it('liefert bei zwei aufeinanderfolgenden Aufrufen dasselbe Ergebnis (kein lastIndex-Leck, Fehler 10)', () => {
    expect(isLengthExempt(warntext)).toBe(isLengthExempt(warntext));
    expect(isLengthExempt(warntext)).toBe('length');
  });

  it('befreit AUSSCHLIESSLICH die Längenkriterien — K7 bleibt für Warntexte scharf', () => {
    expect([...LENGTH_CRITERIA].sort()).toEqual(['K1', 'K6']);
    expect(LENGTH_CRITERIA).not.toContain('K7');
    expect(LENGTH_CRITERIA).not.toContain('K4');
  });

  it('erkennt auch Geheimnis-, Sperr- und Fehlerwortschatz', () => {
    expect(isLengthExempt('Rotiert das Token und macht die alte Sitzung ungültig.')).toBe('length');
    expect(isLengthExempt('Bricht ab, wenn der Lock von einer anderen Sitzung gehalten wird.')).toBe(
      'length',
    );
    expect(isLengthExempt('Meldet einen Fehler statt still weiterzulaufen.')).toBe('length');
  });
});

describe('makeFinding — ein ungültiger Befund kommt gar nicht erst in den Bericht (Fehler 6)', () => {
  const base = {
    criterion: 'K1',
    severity: 'fail',
    file: 'skills/plan/SKILL.md',
    line: 137,
    target: 'question',
    message: 'Der Fragetext ist 214 Zeichen lang — mehr als doppelt so lang wie die Grenze.',
  };

  it('weist eine erfundene Kriteriums-ID zurück', () => {
    expect(() => makeFinding({ ...base, criterion: 'K9' })).toThrow(/K9/);
  });

  it('weist einen Options-Befund ohne Index zurück und einen Frage-Befund MIT Index', () => {
    expect(() => makeFinding({ ...base, target: 'option' })).toThrow(/optionIndex/);
    expect(() => makeFinding({ ...base, optionIndex: 0 })).toThrow(/optionIndex/);
  });

  it('weist eine leere Meldung zurück — sie steht vor dem Operator', () => {
    expect(() => makeFinding({ ...base, message: '   ' })).toThrow(/message/);
  });

  it('setzt die Vorgaben und kürzt das Zitat auf die Höchstlänge', () => {
    const long = 'x'.repeat(500);
    const finding = makeFinding({ ...base, excerpt: long });
    expect(finding.optionIndex).toBe(null);
    expect(finding.exempt).toBe(null);
    expect(finding.measured).toBe(null);
    expect(codepointLength(finding.excerpt)).toBe(EXCERPT_MAX_CHARS);
    expect(finding.excerpt.endsWith('…')).toBe(true);
  });
});

describe('validateReport — vollständig, mit Pfad, und wirft nie (Fehler 7)', () => {
  it('nimmt einen über die Fabriken gebauten Bericht an', () => {
    const verdict = validateReport(validReport());
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it('nennt ein fehlendes Pflichtfeld beim Namen', () => {
    const report = validReport();
    delete report.dirty;
    const verdict = validateReport(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/report\.dirty/);
  });

  it('erkennt eine falsche Schema-Version', () => {
    const verdict = validateReport({ ...validReport(), schemaVersion: 'auq-clarity/0' });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/schemaVersion/);
  });

  it('erkennt eine fehlende Population im Korpus', () => {
    const report = validReport();
    delete report.corpus['C-hybrid'];
    const verdict = validateReport(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/corpus\.C-hybrid/);
  });

  it('sammelt ALLE Fehler statt beim ersten abzubrechen', () => {
    const report = validReport();
    delete report.dirty;
    delete report.head;
    report.schemaVersion = 'falsch';
    expect(validateReport(report).errors.length).toBeGreaterThanOrEqual(3);
  });

  it('wirft weder bei null noch bei einem String noch bei einem zyklischen Objekt', () => {
    for (const input of [null, undefined, 'ein Bericht', 42, []]) {
      const verdict = validateReport(input);
      expect(verdict.ok).toBe(false);
      expect(verdict.errors.length).toBeGreaterThan(0);
    }
    const cyclic = validReport();
    cyclic.schemaVersion = {};
    cyclic.schemaVersion.self = cyclic.schemaVersion;
    const verdict = validateReport(cyclic);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.length).toBeGreaterThan(0);
  });
});

describe('K4-Vergleichsmarker — geschlossene Wortliste statt Superlativ-Regex (Fehler 8)', () => {
  const cmp = MARKER_CLASSES.comparison.pattern;

  it('markiert die fünf gemessenen Nicht-Superlative NICHT', () => {
    // `\b\w+est\b` würde alle fünf treffen — 5 von 8 Treffern im Korpus.
    for (const word of ['Test', 'Vitest', 'pytest', 'latest', 'Manifest']) {
      expect(cmp.test(`Runs the ${word} suite.`)).toBe(false);
    }
  });

  it('markiert die echten Vergleichswörter, deutsch wie englisch', () => {
    expect(cmp.test('Fastest for file-disjoint tasks.')).toBe(true);
    expect(cmp.test('most precise decomposition')).toBe(true);
    expect(cmp.test('Am schnellsten, dafür ungenauer.')).toBe(true);
  });

  it('führt die Wortliste als Daten, damit ein Regex sie nicht ersetzen kann', () => {
    expect(MARKER_CLASSES.comparison.words).toContain('fastest');
    expect(MARKER_CLASSES.comparison.words).toContain('am schnellsten');
    expect(Object.isFrozen(MARKER_CLASSES.comparison.words)).toBe(true);
  });

  it('lässt beide Sprachen gleichzeitig laufen — keine Spracherkennung', () => {
    expect(MARKER_CLASSES.causal.pattern.test('weil der Lauf sonst abbricht')).toBe(true);
    expect(MARKER_CLASSES.causal.pattern.test('because the run would abort')).toBe(true);
    expect(MARKER_CLASSES.cost.pattern.test('dauert ~2 min')).toBe(true);
    expect(MARKER_CLASSES.consequence.pattern.test('dann verliert man die Änderungen')).toBe(true);
  });
});

describe('K7-Pfadmuster — verschärft, damit deutscher Text kein Rauschen erzeugt (Fehler 9)', () => {
  const path = IDENTIFIER_PATTERNS.find((p) => p.id === 'path').pattern;

  it('trifft die vier gemessenen deutschen Falsch-Positiven NICHT', () => {
    // `\w+/\w+` trifft alle vier — gemessen 33 statt 18 markierte Beschreibungen.
    for (const noise of [
      'Zähl-/Struktur-Datensatz',
      'Skill-/Phasen-Nutzung',
      'Erfolg/Abbruch',
      'Pfade/Prompts/Repo-Namen',
    ]) {
      expect(path.test(noise)).toBe(false);
    }
  });

  it('trifft echte Pfade über beide Beglaubigungen (Endung oder Repo-Verzeichnis)', () => {
    expect(path.test('scripts/lib/auq/schema.mjs')).toBe(true); // beide
    expect(path.test('docs/prd')).toBe(true); // nur Verzeichnis
    expect(path.test('STATE.md')).toBe(true); // nur Endung
    expect(path.test('.orchestrator/metrics')).toBe(true); // Punktverzeichnis
  });

  it('hält die Allowlist klein und exakt vergleichbar', () => {
    expect(IDENTIFIER_ALLOWLIST.has('/close')).toBe(true);
    expect(IDENTIFIER_ALLOWLIST.has('STATE.md')).toBe(true);
    // Exakter Vergleich, kein Präfix- oder Kleinschreibungsmatch.
    expect(IDENTIFIER_ALLOWLIST.has('state.md')).toBe(false);
    expect(IDENTIFIER_ALLOWLIST.has('/closed')).toBe(false);
  });
});

describe('globalOf — alle Treffer holen, ohne die geteilte RegExp zu mutieren (Fehler 10)', () => {
  it('gibt eine frische globale Kopie zurück und lässt das Original zustandslos', () => {
    const original = MARKER_CLASSES.causal.pattern;
    expect(original.flags).not.toContain('g');
    const g = globalOf(original);
    expect(g.flags).toContain('g');
    expect(g).not.toBe(original);
    // Zwei Läufe über dieselbe Registry-RegExp liefern dasselbe Ergebnis.
    // Drei kausale Marker: `weil`, `sonst`, `because`.
    const text = 'weil es sonst bricht, because it breaks';
    expect(original.test(text)).toBe(true);
    expect(original.test(text)).toBe(true);
    expect([...text.matchAll(globalOf(original))].map((m) => m[0])).toEqual([
      'weil',
      'sonst',
      'because',
    ]);
  });
});

describe('makeQuestion / makeOption — Vorgaben und abgeleitete Zahlen an EINER Stelle', () => {
  it('leitet previewCount ab, statt ihn mitführen zu lassen', () => {
    const q = makeQuestion({
      question: 'Weiter?',
      header: 'Weiter',
      options: [
        makeOption({ index: 0, label: 'Ja', preview: 'diff --stat' }),
        makeOption({ index: 1, label: 'Nein' }),
      ],
      file: 'commands/go.md',
      line: 3,
      population: 'B',
      kind: 'template',
      quoting: 'double',
    });
    expect(q.previewCount).toBe(1);
    expect(q.multiSelect).toBe(false);
    expect(q.options[1].preview).toBe(null);
    expect(q.options[1].description).toBe('');
    expect(q.options[1].isRecommended).toBe(false);
  });

  it('weist eine unbekannte Population zurück, statt sie in den Korpus laufen zu lassen', () => {
    const rec = {
      question: 'Weiter?',
      file: 'commands/go.md',
      line: 3,
      population: 'D',
      kind: 'template',
      quoting: 'double',
    };
    expect(() => makeQuestion(rec)).toThrow(/population/);
  });

  it('erzwingt KEINE Fragenzahl im Block — 5 Fragen sind ein Befund, kein Absturz', () => {
    const q = (i) =>
      makeQuestion({
        question: `F${i}`,
        file: 'skills/plan/SKILL.md',
        line: 137,
        population: 'A',
        kind: 'template',
        quoting: 'double',
      });
    const block = makeBlock({
      file: 'skills/plan/SKILL.md',
      line: 137,
      questions: [q(1), q(2), q(3), q(4), q(5)],
    });
    expect(block.questions).toHaveLength(5);
    expect(validateReport({ ...validReport(), blocks: [block] }).ok).toBe(true);
  });
});
