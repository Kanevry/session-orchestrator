/**
 * auq/schema.mjs — THE frozen contract for the AUQ-Klarheitsmessung (#1107).
 *
 * ## Warum diese Datei existiert
 *
 * Der Operator hat gemeldet, dass die Fragen, die dieses System ihm über
 * `AskUserQuestion` stellt, zu technisch, zu lang und nicht entscheidbar sind.
 * Welle 2 baut dagegen ein DETERMINISTISCHES Messprogramm — reines Node, kein
 * LLM —, das jede Frage-Vorlage im Repo benotet. Drei Module bauen gleichzeitig
 * dagegen. Was hier nicht steht, erfinden sie sich einzeln und widersprüchlich;
 * was hier steht, ist eingefroren.
 *
 * Dieses Modul ist REINE DATEN: Konstanten, Typ-Dokumentation, Fabriken,
 * Validierung. Kein Datei-IO, kein Parsen, keine Bewertungslogik. Die drei
 * Grenzen sind absichtlich scharf — ein Schema, das mitbewertet, wird zum
 * zweiten Ort, an dem eine Schwelle steht.
 *
 * ## Die drei Verträge, gegen die gebaut wird
 *
 * `scripts/lib/auq/parse.mjs` — findet die Vorlagen, misst nichts:
 *     parseFile({ file, content }) -> { blocks: AuqBlock[], warnings: string[] }
 *     parseRepo({ repoRoot, files }) -> { blocks: AuqBlock[], corpus, warnings }
 *   Baut jeden Datensatz über `makeOption` / `makeQuestion` / `makeBlock`,
 *   damit Vorgabewerte (`multiSelect: false`, `preview: null`) an EINER Stelle
 *   stehen. `corpus` kommt aus `emptyCorpus()` und wird hochgezählt.
 *
 * `scripts/lib/auq/clarity.mjs` — bewertet, parst nicht:
 *     scoreQuestion(question) -> AuqScore
 *     scoreBlocks(blocks) -> AuqScore[]
 *   Liest ALLE Schwellen aus `CRITERIA` / `THRESHOLDS` / `HURDLES`, baut jeden
 *   Befund über `makeFinding`, jedes Ergebnis über `makeScore`. Eine Zahl, die
 *   in clarity.mjs als Literal steht, ist ein Vertragsbruch.
 *   Punkteformel (hier festgelegt, dort ausgeführt):
 *
 *       points = 100 − Σ CRITERIA[k].weight  für jedes k, das für DIESE Frage
 *                                            mindestens einen `fail`-Befund hat
 *
 *   Jedes Kriterium zieht höchstens EINMAL ab, egal wie viele Optionen es
 *   reißen — sonst bestraft dieselbe Schwäche eine Vier-Options-Frage doppelt
 *   so hart wie eine Zwei-Options-Frage. `warn`-Befunde ziehen NICHTS ab; sie
 *   sind Hinweise, keine Strafe. Ergebnis auf [0, 100] geklemmt.
 *
 * `scripts/auq-audit.mjs` (CLI) — fügt zusammen, misst nichts:
 *     buildReport({ blocks, scores, corpus, head, dirty }) -> AuqReport
 *   Prüft die eigene Ausgabe mit `validateReport` VOR dem Schreiben und gibt
 *   den `--json`-Umschlag über `writeStdoutLineSync` aus (`scripts/lib/io.mjs`),
 *   nie über `console.log` — stdout ist auf einer Pipe asynchron, und alles
 *   jenseits von ~64 KiB verwirft `process.exit()`.
 *
 * ## Zwei Messfallen, die hier strukturell zugemauert sind
 *
 * 1. CODEPOINTS, NICHT BYTES. `Buffer.byteLength('Evolve — Review')` ist 17,
 *    die Kopfzeile hat aber 15 Zeichen — bytebasiert gemessen reißt sie eine
 *    12er-Grenze, die sie gar nicht reißt. Alle drei Module zählen über
 *    `codepointLength()`; `.length` ist ebenfalls falsch, sobald ein Emoji
 *    (astrales Zeichen) im Text steht.
 *
 * 2. OPTIONEN ZÄHLT MAN PRO FRAGE, NICHT PRO BLOCK. Blockweise gezählt scheint
 *    `skills/plan/SKILL.md:137` mit 14 Optionen gegen H2 zu verstoßen; es ist
 *    aber ein legaler Vierfragen-Block (4 Fragen × 3–4 Optionen). `AuqBlock`
 *    trägt darum 1–4 `AuqQuestion`, und H2 gilt je `AuqQuestion`.
 *
 * ## Der Schutz, der niemals wegoptimiert werden darf
 *
 * `skills/session-start/soul.md` § "Never traded for brevity" schützt fünf
 * Klassen (Eingabevalidierung, Fehlerbehandlung/-meldungen, Sicherheitsbefunde
 * und Bestätigungen zerstörender Aktionen, Zugänglichkeit der Ausgabe, alles
 * ausdrücklich Verlangte). Ein Text, der auf `SAFETY_PATTERN` passt, ist von
 * ALLEN Längenkriterien befreit (`LENGTH_CRITERIA` = K1, K6) und trägt im
 * Befund `exempt: 'length'` — damit ein späterer automatischer Kürzungsschritt
 * ihn nie stillschweigend aufgreifen kann. K3/K4/K5/K7/K8 gelten weiter: die
 * FÜGEN Information HINZU und entfernen nie welche.
 *
 * Gemessen am 2026-08-22: die 9 sicherheitsrelevanten Beschreibungen im Repo
 * haben Median 83 und Maximum 99 Zeichen, liegen also alle unter der
 * WARN-Grenze von 120. Die Kollision tritt heute NICHT auf — die Ausnahme ist
 * Vorsorge, kein Pflaster.
 *
 * Querverweise:
 * - `.claude/rules/ask-via-tool.md` (AUQ-001..005 — die Regel, die gemessen wird)
 * - `skills/session-start/soul.md` § "Never traded for brevity"
 * - `scripts/lib/tests-src-ratio.mjs` (Form eines Mess-Moduls mit --json-Umschlag)
 * - Issue #1107
 */

// ---------------------------------------------------------------------------
// Umschlag-Version + geschlossene Aufzählungen
// ---------------------------------------------------------------------------

/** Schema-Marke im `--json`-Umschlag. Bricht der Vertrag, steigt die Zahl. */
export const SCHEMA_VERSION = 'auq-clarity/1';

/**
 * Herkunftsklassen des Korpus. Ein Datensatz weiß, WOHER er kommt, weil eine
 * Prosa-Erwähnung einer Frage anders zu werten ist als eine echte Vorlage.
 */
export const POPULATIONS = Object.freeze([
  'A', // ausgeführter Tool-Aufruf in einem Skill-Körper
  'B', // Vorlage in `commands/` oder `agents/`
  'C-mdc', // Beispiel in einer Regel-/Doku-Datei
  'C-mjs', // Vorlage in einem `.mjs`-Modul (String-Literal)
  'C-prose', // in Fließtext beschriebene Frage, kein Tool-Aufruf
  'C-hybrid', // Mischform: Vorlage im Fließtext eingebettet
]);

/** Vorlage (wird wirklich gestellt) vs. Illustration (zeigt nur die Form). */
export const KINDS = Object.freeze(['template', 'illustration']);

/** Wie der Text im Quelltext eingefasst ist — entscheidet über die Auszugsform. */
export const QUOTINGS = Object.freeze(['double', 'backtick', 'prose']);

/** Worauf sich ein Befund bezieht. */
export const TARGETS = Object.freeze(['question', 'option', 'header']);

/** Zwei Stufen, mehr nicht. `fail` zieht Punkte, `warn` nie. */
export const SEVERITIES = Object.freeze(['fail', 'warn']);

/** Wofür ein Kriterium überhaupt zuständig ist. */
export const SCOPES = Object.freeze(['question', 'option', 'block']);

// ---------------------------------------------------------------------------
// Die Kriterien-Registry
// ---------------------------------------------------------------------------

/**
 * Die acht Kriterien, aus einer Discovery-Analyse am echten Korpus abgeleitet.
 *
 * `weight` ist der Punktabzug bei mindestens einem `fail`-Befund. Die Summe der
 * Gewichte ist 100 (K2 wiegt 0 — reiner Hinweis; K5 ist keine Punktsache,
 * sondern die harte Hürde H1). Diese Summe ist eine Invariante: fällt sie
 * auseinander, verlieren die Notenbänder ihren Bezug.
 *
 * `severity` nennt die HÖCHSTE Stufe, die das Kriterium erreichen kann — K2
 * kann nie `fail` werden, egal wie lang der Satz ist.
 *
 * @type {Readonly<Record<string, Readonly<{id:string,title:string,weight:number,severity:'fail'|'warn',appliesTo:'question'|'option'|'block',hurdle:string|null,measures:string}>>>}
 */
export const CRITERIA = Object.freeze({
  K1: Object.freeze({
    id: 'K1',
    title: 'Payload-Form',
    weight: 20,
    severity: 'fail',
    appliesTo: 'question',
    hurdle: null,
    measures:
      'Zeichen im Fragetext, eingebettete Zeilenumbrüche, Code-Block, Tabellenzeile — ' +
      'die Frage ist eine Frage, kein Bericht.',
  }),
  K2: Object.freeze({
    id: 'K2',
    title: 'Satzlänge',
    weight: 0,
    severity: 'warn',
    appliesTo: 'question',
    hurdle: null,
    measures: 'Längster Satz in Wörtern. Nur ein Hinweis, nie ein Fehler.',
  }),
  K3: Object.freeze({
    id: 'K3',
    title: 'Beschreibung wiederholt Label',
    weight: 10,
    severity: 'fail',
    appliesTo: 'option',
    hurdle: null,
    measures:
      'Neue Wörter in der Beschreibung gegenüber dem Label, und wie viel vom Label ' +
      'die Beschreibung nur wiederholt.',
  }),
  K4: Object.freeze({
    id: 'K4',
    title: 'Empfehlung ohne Grund',
    weight: 25,
    severity: 'fail',
    appliesTo: 'option',
    hurdle: null,
    measures:
      'Nennt die Option einen Grund, einen Preis, eine Folge oder einen Vergleich? ' +
      'Eine Empfehlung ohne all das ist eine Behauptung.',
  }),
  K5: Object.freeze({
    id: 'K5',
    title: 'Header-Grenze',
    weight: 0,
    severity: 'fail',
    appliesTo: 'block',
    hurdle: 'H1',
    measures:
      'Zeichen der Kopfzeile. Über 12 schneidet das Tool selbst ab — das ist keine ' +
      'Stilfrage, sondern eine harte Grenze.',
  }),
  K6: Object.freeze({
    id: 'K6',
    title: 'Längenbudget',
    weight: 10,
    severity: 'fail',
    appliesTo: 'option',
    hurdle: 'H2',
    measures:
      'Zeichen je Beschreibung und Label, Nutzlast je Frage, Anzahl Optionen je Frage.',
  }),
  K7: Object.freeze({
    id: 'K7',
    title: 'Unerklärter Bezeichner',
    weight: 25,
    severity: 'fail',
    appliesTo: 'option',
    hurdle: null,
    measures:
      'Bezeichner-förmige Wörter in einer Beschreibung, die weder allgemein bekannt ' +
      'noch danebenerklärt sind. Absolute Zahl, keine Dichte.',
  }),
  K8: Object.freeze({
    id: 'K8',
    title: 'Geh selbst nachsehen',
    weight: 10,
    severity: 'fail',
    appliesTo: 'option',
    hurdle: null,
    measures:
      'Verweist die Option darauf, dass der Operator erst eine Datei öffnen muss, ' +
      'um entscheiden zu können?',
  }),
});

/** Stabile Reihenfolge für Berichte und Zusammenfassungen. */
export const CRITERION_IDS = Object.freeze(Object.keys(CRITERIA));

/**
 * Summe aller Gewichte. 100 per Konstruktion — `points` ist deshalb direkt eine
 * Prozentzahl und braucht keine zweite Normierung.
 */
export const TOTAL_WEIGHT = CRITERION_IDS.reduce((sum, id) => sum + CRITERIA[id].weight, 0);

// ---------------------------------------------------------------------------
// Die zwei harten Hürden
// ---------------------------------------------------------------------------

/**
 * Hürden sind KEINE gewichteten Kriterien. Eine gerissene Hürde ergibt Note F,
 * unabhängig von der Punktzahl — deshalb stehen sie getrennt und werden in
 * `AuqScore.hurdlesBroken` geführt, nicht in `points` verrechnet.
 *
 * @type {Readonly<Record<'H1'|'H2', Readonly<{id:string,title:string,rule:string,criterion:string,evidence:string}>>>}
 */
export const HURDLES = Object.freeze({
  H1: Object.freeze({
    id: 'H1',
    title: 'Kopfzeile höchstens 12 Zeichen',
    rule: 'codepointLength(header) <= 12',
    criterion: 'K5',
    evidence:
      'Gemessen 2026-08-22: 26 von 42 Kopfzeilen-Literalen reißen diese Grenze (62 %), ' +
      'Spitzenwert 54 Zeichen. Das Tool schneidet ab — der Operator sieht den Rest nie.',
  }),
  H2: Object.freeze({
    id: 'H2',
    title: '2–4 Optionen je Frage, genau eine Empfehlung auf Platz 1',
    rule: 'options.length zwischen 2 und 4 JE FRAGE, und isRecommended nur bei index 0',
    criterion: 'K6',
    evidence:
      'Pro Block gezählt meldet skills/plan/SKILL.md:137 fälschlich 14 Optionen — ' +
      'es ist ein legaler Vierfragen-Block. Der Zähler zählt je Frage.',
  }),
});

/** Stabile Reihenfolge. */
export const HURDLE_IDS = Object.freeze(Object.keys(HURDLES));

// ---------------------------------------------------------------------------
// Schwellen — die einzige Stelle, an der eine Zahl steht
// ---------------------------------------------------------------------------

/**
 * Alle Schwellen, nach Kriterium gruppiert. clarity.mjs liest ausschließlich
 * von hier; ein Zahlenliteral dort wäre ein zweiter Ort für dieselbe Schwelle.
 */
export const THRESHOLDS = Object.freeze({
  /** K1 — Payload-Form. */
  K1: Object.freeze({
    /** Zeichen im Fragetext (nach Normalisierung der Zeilenumbrüche). */
    questionCharsFail: 120,
    /**
     * Ab so vielen eingebetteten Zeilenumbrüchen ist die Frage ein Bericht —
     * ES SEI DENN, die Zeilen sind eine Aufzählung (`LIST_LINE_PATTERN`). Eine
     * Aufzählung ist lesbare Struktur, ein Fließtextabsatz ist es nicht.
     */
    embeddedLinesFail: 2,
  }),

  /** K2 — Satzlänge. Erreicht nie `fail`, egal wie hoch der Wert steigt. */
  K2: Object.freeze({ sentenceWordsWarn: 25 }),

  /**
   * K3 — Beschreibung wiederholt Label. KONJUNKTION, nicht Disjunktion:
   * `fail` nur wenn `novelty < 3` UND `containment >= 0.5`.
   *
   * Containment allein hat 100 % Falsch-Positive: Einwort-Labels wie `new`,
   * `full` oder `feature` erreichen containment 1.00, während die Beschreibung
   * viel Substanz trägt. Erst die Kombination aus "sagt wenig Neues" UND
   * "wiederholt das halbe Label" trifft den echten Fall.
   */
  K3: Object.freeze({
    noveltyFailBelow: 3,
    containmentFailAtOrAbove: 0.5,
    /** Token mit ≤ 2 Zeichen werden verworfen, bevor gezählt wird. */
    tokenMinChars: 3,
  }),

  /** K4 — Empfehlung ohne Grund. Zählt Marker, nicht Zeichen. */
  K4: Object.freeze({ markersRequired: 1 }),

  /** K5 — Header-Grenze (= Hürde H1). */
  K5: Object.freeze({
    headerCharsFail: 12,
    /**
     * Enthält die Kopfzeile einen Platzhalter (`<…>` / `[…]`), ist ihre echte
     * Länge unbekannt. Dann gilt `Literallänge + 8` als schlimmster Fall — und
     * nur WARN, weil eine Vermutung keinen Fehler begründet.
     */
    placeholderPad: 8,
  }),

  /** K6 — Längenbudget (Optionsanzahl = Hürde H2). */
  K6: Object.freeze({
    descriptionCharsWarn: 120,
    descriptionCharsFail: 150,
    labelCharsWarn: 40,
    /** Summe aller Zeichen einer Frage: Fragetext + alle Labels + alle Beschreibungen. */
    questionPayloadWarn: 500,
    questionPayloadFail: 650,
    /** JE FRAGE, nie je Block — siehe H2. */
    optionsMin: 2,
    optionsMax: 4,
  }),

  /**
   * K7 — Unerklärter Bezeichner. ABSOLUTE ZAHL, keine Dichte: die gemessene
   * Dichte hat Median 0 und Maximum 0,44 und trennt damit nichts. Ein einziger
   * unerklärter Bezeichner reicht, damit der Operator nachschlagen muss.
   */
  K7: Object.freeze({ unexplainedFailAtOrAbove: 1 }),

  /** K8 — Lese-Imperativ plus Ziel in Reichweite. */
  K8: Object.freeze({
    failAtOrAbove: 1,
    /** Nicht-Punkt-Zeichen zwischen Imperativ und Pfad/Issue-Nummer. */
    proximityChars: 45,
  }),
});

/** Höchstlänge eines Zitats in einem Befund (Codepoints). */
export const EXCERPT_MAX_CHARS = 80;

// ---------------------------------------------------------------------------
// K1 — Formmuster
// ---------------------------------------------------------------------------

/** Ein Code-Block im Fragetext. */
export const CODE_FENCE_PATTERN = /```/u;

/** Eine Tabellenzeile: mindestens zwei Spaltentrenner. */
export const TABLE_ROW_PATTERN = /\|[^|\n]*\|/u;

/** Eine Aufzählungszeile — strukturierte Mehrzeiligkeit, kein Bericht. */
export const LIST_LINE_PATTERN = /^\s*(?:-\s|\d+\.\s)/u;

/** Literaler `\n` im Quelltext ODER echter Zeilenumbruch. */
export const NEWLINE_PATTERN = /\\n|\r\n|\n/u;

// ---------------------------------------------------------------------------
// K4 — die vier Markerklassen
// ---------------------------------------------------------------------------

/**
 * Vier geschlossene Klassen. BEIDE SPRACHEN LAUFEN IMMER GLEICHZEITIG — es gibt
 * bewusst KEINE Spracherkennung, weil im Korpus keine Kollision zwischen der
 * deutschen und der englischen Liste auftritt. Eine Erkennung wäre ein
 * zusätzlicher Fehlerpfad ohne einen einzigen Fall, den sie richtig stellt.
 *
 * Warum die vierte Klasse (Vergleich) zwingend ist, gemessen:
 *   mit drei Klassen  — 16 von 29 `(Recommended)`-Optionen markiert, 7 davon
 *                       falsch (44 % Falsch-Positive), z. B. "Fastest for
 *                       file-disjoint tasks.", "most precise decomposition",
 *                       "Isolates file edits"
 *   mit vier Klassen  — 9 von 29 markiert, 1 davon falsch (14 %)
 *
 * Warum `comparison` eine GESCHLOSSENE WORTLISTE ist und kein Superlativ-Regex:
 * von den 8 Treffern, die `\b\w+est\b` im Korpus erzeugt, sind 5 keine
 * Superlative — `Test`, `Vitest`, `pytest`, `latest`, `Manifest`.
 *
 * Alle Muster tragen KEIN `g`-Flag: eine geteilte globale RegExp schleppt
 * `lastIndex` zwischen Aufrufen mit und liefert bei jedem zweiten Aufruf ein
 * anderes Ergebnis. Wer alle Treffer braucht, nimmt `globalOf()`.
 */
export const MARKER_CLASSES = Object.freeze({
  causal: Object.freeze({
    id: 'causal',
    title: 'Grund',
    pattern:
      /\b(?:weil|damit|sonst|deshalb|dadurch|verhindert|entspricht|passt|because|so that|since|otherwise|therefore|prevents|avoids|matches|fits|isolates|safe when|safe default)\b/iu,
  }),
  cost: Object.freeze({
    id: 'cost',
    title: 'Preis',
    pattern:
      /(?:\b(?:kostet|dauert|braucht|Kosten|cost|trade-off|slower|faster|heavier|requires|limits|burden|manually|manual)\b|Pro:|Con:|~\d|\b\d+\s*(?:min|h|Std|Tage)\b)/iu,
  }),
  consequence: Object.freeze({
    id: 'consequence',
    title: 'Folge',
    pattern:
      /(?:\b(?:dann|führt dazu|verliert|löscht|wird|then|loses|commits to|freezes|overwrites|deletes|blocks|breaks|you can|until|leaves|keeps)\b|\bno (?:further|separate|cleanup)\b)/iu,
  }),
  comparison: Object.freeze({
    id: 'comparison',
    title: 'Vergleich',
    /**
     * Geschlossene Wortliste, KEIN Superlativ-Regex — siehe Klassenkommentar.
     * Der Vergleich wird als Alternation über genau diese Wörter geprüft.
     */
    words: Object.freeze([
      'fastest',
      'safest',
      'simplest',
      'cheapest',
      'most precise',
      'least',
      'only',
      'unlike',
      'instead',
      'vs',
      'maximum',
      'minimal',
      'lightweight',
      'high synergy',
      'am schnellsten',
      'am sichersten',
    ]),
    pattern:
      /\b(?:fastest|safest|simplest|cheapest|most precise|least|only|unlike|instead|vs|maximum|minimal|lightweight|high synergy|am schnellsten|am sichersten)\b/iu,
  }),
});

/** Stabile Reihenfolge der Markerklassen. */
export const MARKER_CLASS_IDS = Object.freeze(Object.keys(MARKER_CLASSES));

/** Wie eine empfohlene Option im Label markiert ist — beide Sprachen. */
export const RECOMMENDED_MARKERS = Object.freeze(['(Recommended)', '(Empfohlen)']);

/**
 * Trägt diese Option eine Empfehlung? EIN Ort, zwei Konsumenten.
 *
 * **Label ODER Beschreibung** — bewusst beide. Der Marker gehört per AUQ-003 ins
 * Label, aber `scripts/lib/config/dispatcher-autonomy-capture.mjs` hat ihn
 * jahrelang in die Beschreibung gesetzt. Wer nur das Label prüft, übersieht
 * genau diese Frage — und meldet sie als „gar keine Empfehlung vorhanden".
 *
 * Warum das hier steht und nicht zweimal daneben: bis 2026-08-22 gab es zwei
 * Ableitungen. `parse.mjs` prüfte Label ODER Beschreibung, der Hook nur das
 * Label. Dieselbe Optionsmenge, entgegengesetzte Urteile — als Datei-Vorlage
 * meldete der Validator einen H2-Bruch, zur Laufzeit liess der Hook durch. Der
 * Marker-String war schon geteilt; das PRÄDIKAT war es nicht, und genau dort
 * lief es auseinander. Gefunden vom Architektur-Review dieser Session (W4-Q7).
 *
 * @param {{label?: unknown, description?: unknown}} option
 * @returns {boolean}
 */
export function isRecommendedOption(option) {
  if (option === null || typeof option !== 'object') return false;
  const label = typeof option.label === 'string' ? option.label : '';
  const description = typeof option.description === 'string' ? option.description : '';
  return RECOMMENDED_MARKERS.some((m) => label.includes(m) || description.includes(m));
}

// ---------------------------------------------------------------------------
// K3 — Stoppwörter
// ---------------------------------------------------------------------------

/**
 * Zweisprachige Stoppwortliste für den Neuheits-/Containment-Vergleich.
 * Kleingeschrieben; der Vergleich normalisiert vorher auf Kleinschreibung.
 * Token mit ≤ `THRESHOLDS.K3.tokenMinChars - 1` Zeichen fallen ohnehin heraus,
 * darum stehen hier nur Wörter ab drei Zeichen.
 */
export const STOPWORDS = Object.freeze(
  new Set([
    // Deutsch
    'aber',
    'alle',
    'also',
    'auch',
    'auf',
    'aus',
    'bei',
    'bis',
    'das',
    'dem',
    'den',
    'der',
    'des',
    'die',
    'ein',
    'eine',
    'einem',
    'einen',
    'einer',
    'für',
    'ist',
    'kann',
    'mit',
    'nach',
    'nicht',
    'nur',
    'oder',
    'ohne',
    'sich',
    'sind',
    'über',
    'und',
    'vom',
    'von',
    'vor',
    'wenn',
    'werden',
    'wie',
    'wird',
    'zum',
    'zur',
    // Englisch
    'all',
    'and',
    'any',
    'are',
    'but',
    'can',
    'for',
    'from',
    'has',
    'have',
    'into',
    'its',
    'not',
    'off',
    'one',
    'onto',
    'per',
    'that',
    'the',
    'their',
    'them',
    'then',
    'this',
    'was',
    'were',
    'will',
    'with',
    'you',
    'your',
  ]),
);

// ---------------------------------------------------------------------------
// K5 — Platzhalter in der Kopfzeile
// ---------------------------------------------------------------------------

/** `<name>` oder `[name]` — die Kopfzeile wird zur Laufzeit erst gefüllt. */
export const HEADER_PLACEHOLDER_PATTERN = /<[^<>]{1,40}>|\[[^[\]]{1,40}\]/u;

// ---------------------------------------------------------------------------
// K7 — der dreistufige Bezeichner-Detektor (Daten; Auswertung in clarity.mjs)
// ---------------------------------------------------------------------------

/** Dateiendungen, die ein Pfad-Token beglaubigen. */
export const PATH_EXTENSIONS = Object.freeze([
  '.mjs',
  '.js',
  '.ts',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.lock',
  '.toml',
]);

/** Verzeichnisse, die ein Pfad-Token beglaubigen (inkl. Punktverzeichnisse). */
export const REPO_DIR_PREFIXES = Object.freeze([
  'scripts/',
  'skills/',
  'docs/',
  'tests/',
  'commands/',
  'agents/',
  'refs/',
  '.claude/',
  '.orchestrator/',
]);

/**
 * Stufe 1 — die Detektoren. Ein Treffer heißt "sieht aus wie ein Bezeichner",
 * noch nicht "ist unerklärt": Stufe 2 (Allowlist) und Stufe 3 (Glosse) sieben
 * danach.
 *
 * Das Pfadmuster ist ABSICHTLICH VERSCHÄRFT. Das naive `\w+/\w+` ist auf
 * deutschem Text reines Rauschen — es trifft `Zähl-/Struktur-Datensatz`,
 * `Skill-/Phasen-Nutzung`, `Erfolg/Abbruch`, `Pfade/Prompts/Repo-Namen`.
 * Gemessen: naiv markiert 33 von 120 Beschreibungen, verschärft 18 von 120.
 * Ein Pfad-Token muss deshalb entweder auf eine bekannte Endung enden ODER mit
 * einem bekannten Repo-Verzeichnis beginnen.
 *
 * Kein Muster trägt `g` — siehe `globalOf()`.
 */
export const IDENTIFIER_PATTERNS = Object.freeze([
  Object.freeze({ id: 'backtick', pattern: /`[^`\n]+`/u }),
  Object.freeze({ id: 'issue-ref', pattern: /#\d+/u }),
  Object.freeze({
    id: 'path',
    pattern: new RegExp(
      '(?:' +
        // (a) beginnt mit einem bekannten Repo-Verzeichnis
        `(?:${REPO_DIR_PREFIXES.map((d) => d.replace(/[.]/g, '\\.')).join('|')})[\\w./-]*` +
        '|' +
        // (b) endet auf eine bekannte Endung
        `[\\w./-]*(?:${PATH_EXTENSIONS.map((e) => e.replace(/[.]/g, '\\.')).join('|')})\\b` +
        ')',
      'u',
    ),
  }),
  Object.freeze({ id: 'namespaced', pattern: /\b[A-Za-z][\w-]*::[\w-]+/u }),
  Object.freeze({ id: 'snake_case', pattern: /\b[a-z][a-z\d]*(?:_[a-z\d]+)+\b/u }),
  Object.freeze({ id: 'ALLCAPS_CONST', pattern: /\b[A-Z][A-Z\d]*(?:_[A-Z\d]+)+\b/u }),
  Object.freeze({ id: 'camelCase', pattern: /\b[a-z][a-z\d]*(?:[A-Z][a-z\d]+)+\b/u }),
]);

/**
 * Stufe 2 — die Allowlist. Bewusst KLEIN und kuratiert: nur Token, die der
 * Operator täglich selbst benutzt. Gemessene Wirkung: entfernt 5 der 18
 * Markierungen. Der Vergleich ist exakte Zeichengleichheit auf dem gefundenen
 * Token — kein Präfix-, kein Kleinschreibungsvergleich, weil "sieht ähnlich
 * aus" genau die Unschärfe wäre, die die Liste vermeiden soll.
 *
 * Die Liste wächst nur gegen eine MESSUNG (wie viele Markierungen verschwinden),
 * nie gegen ein Gefühl — sonst ist am Ende jeder Bezeichner allowlistet.
 */
export const IDENTIFIER_ALLOWLIST = Object.freeze(
  new Set([
    '/close',
    '/go',
    '/session',
    '/plan',
    '/grill',
    '/brainstorm',
    '/details',
    'STATE.md',
    // CLAUDE.md and AGENTS.md are the same file under two names — CLAUDE.md on
    // Claude Code / Cursor, AGENTS.md on Codex CLI. Both are operator-daily
    // vocabulary, so both must be allowlisted: on Codex the operator only ever
    // sees AGENTS.md, and flagging it as an unexplained identifier would be the
    // exact false positive this allowlist exists to prevent.
    'CLAUDE.md',
    'AGENTS.md',
    'README.md',
    'CHANGELOG.md',
    'package.json',
    'pyproject.toml',
    'Next.js',
  ]),
);

/**
 * Stufe 3 — die Glossen-Regel. Die mechanisch prüfbare Antwort auf "woran
 * erkennt man, dass eine Erklärung danebensteht".
 *
 * Ein Token `T` gilt als GLOSSIERT, wenn im selben Satz eine Spanne `G` ALLE
 * VIER Bedingungen erfüllt:
 *   1. `G` ist begrenzt durch ` — ` / ` – `, ein Klammerpaar, oder `: `;
 *   2. `G` beginnt höchstens `maxGapChars` nach dem Ende von `T`, ODER endet
 *      höchstens `maxGapChars` vor dem Beginn von `T`;
 *   3. `G` enthält mindestens `minWords` Wörter;
 *   4. `G` enthält selbst NULL Bezeichner-Token.
 *
 * Bedingung 4 ist die tragende: eine "Erklärung", die selbst aus Bezeichnern
 * besteht, erklärt nichts — sie verschiebt das Nachschlagen nur um ein Wort.
 */
export const GLOSS_RULE = Object.freeze({
  maxGapChars: 3,
  minWords: 3,
  /** Trenner, die eine Glossen-Spanne einfassen dürfen. */
  delimiters: Object.freeze([
    Object.freeze({ id: 'em-dash', open: ' — ', close: null }),
    Object.freeze({ id: 'en-dash', open: ' – ', close: null }),
    Object.freeze({ id: 'paren', open: '(', close: ')' }),
    Object.freeze({ id: 'bracket', open: '[', close: ']' }),
    Object.freeze({ id: 'colon', open: ': ', close: null }),
  ]),
  mustContainNoIdentifiers: true,
});

// ---------------------------------------------------------------------------
// K8 — "Geh selbst nachsehen"
// ---------------------------------------------------------------------------

/** Lese-Imperativ. */
export const READ_IMPERATIVE_PATTERN =
  /\b(?:inspect|check|review|read|see|look at|open|Details?|siehe|prüfe|schau|öffne)\b/iu;

/**
 * Ich-Form ist KEIN Verweis an den Operator: "I will inspect the log" sagt zu,
 * dass das System nachsieht — genau das Gegenteil von "sieh du nach".
 */
export const FIRST_PERSON_EXCLUSION_PATTERN = /\b(?:I|I'll|I will|we|we'll|we will)\s+$/iu;

// ---------------------------------------------------------------------------
// Der Schutz: Sicherheits-Lexikon und Längen-Ausnahme
// ---------------------------------------------------------------------------

/**
 * Sicherheits-Lexikon (`soul.md` § "Never traded for brevity"). Ein Text, der
 * hier passt, darf nie aus Längengründen gekürzt werden.
 *
 * Bewusst großzügig geschnitten: über-befreien kostet einen ungeprüften
 * Längenhinweis, unter-befreien kostet eine weggekürzte Warnung. Die Richtung
 * ist nicht symmetrisch, also ist die Liste es auch nicht.
 *
 * Kein `g`-Flag — `.test()` bleibt zustandslos.
 */
export const SAFETY_PATTERN = new RegExp(
  [
    // zerstörende Verben
    '\\b(?:delete[sd]?|remove[sd]?|drop(?:s|ped)?|overwrite[sd]?|reset|revert|purge|wipe|destroy)\\b',
    '\\b(?:l(?:ö|oe)sch\\w*|(?:ü|ue)berschreib\\w*|verwerf\\w*|zur(?:ü|ue)cksetz\\w*|entfernt)\\b',
    // erzwungene Aktionen
    '--force',
    '\\bforce[- ]?(?:push|delete)\\b',
    // Sperren und Zustand
    '\\b(?:lock|locked|stale)\\b',
    // Geheimnisse und Rechte
    '\\b(?:secret|credential|token|password|permission|auth)\\w*\\b',
    // Fehler und Warnungen
    '\\b(?:error|fail(?:s|ed|ure)?|invalid|warn(?:s|ing)?)\\b',
    '\\b(?:fehler\\w*|ung(?:ü|ue)ltig\\w*|warn\\w*)\\b',
  ].join('|'),
  'iu',
);

/**
 * Die Kriterien, von denen ein sicherheitsrelevanter Text befreit ist.
 *
 * NUR die Längenkriterien. K3/K4/K5/K7/K8 gelten weiter, weil sie Information
 * HINZUFÜGEN (Grund, Preis, Erklärung) und nie welche entfernen — eine
 * Sicherheitswarnung wird durch einen genannten Grund besser, nicht schlechter.
 * Steht hier je K7 drin, hört die Jargon-Prüfung für Warntexte stillschweigend
 * auf; genau das darf nicht passieren.
 */
export const LENGTH_CRITERIA = Object.freeze(['K1', 'K6']);

/** Wert, den ein befreiter Befund im Feld `exempt` trägt. */
export const EXEMPT_LENGTH = 'length';

/**
 * Ist dieser Text von den Längenkriterien befreit?
 *
 * Die einzige Funktion in diesem Modul, die einen Text ansieht — und zwar
 * absichtlich: die Ausnahme ist der Schutz selbst. Läge sie in clarity.mjs,
 * wäre sie eine Regel unter vielen und würde beim ersten Umbau mitgezogen.
 *
 * @param {string} text
 * @returns {'length'|null} `'length'` = befreit (in `AuqFinding.exempt` legen)
 */
export function isLengthExempt(text) {
  if (typeof text !== 'string' || text === '') return null;
  return SAFETY_PATTERN.test(text) ? EXEMPT_LENGTH : null;
}

// ---------------------------------------------------------------------------
// Messprimitive
// ---------------------------------------------------------------------------

/**
 * Länge in Unicode-CODEPOINTS.
 *
 * Weder `Buffer.byteLength` noch `.length` tun das:
 *   `Buffer.byteLength('Evolve — Review')` = 17  (Bytes, nicht Zeichen)
 *   `'🚨 Alert'.length`                    = 8   (UTF-16-Einheiten, 🚨 zählt doppelt)
 *   `codepointLength('🚨 Alert')`          = 7   (Zeichen — was das Tool abschneidet)
 *
 * @param {string} str
 * @returns {number}
 */
export function codepointLength(str) {
  if (typeof str !== 'string' || str === '') return 0;
  // NFC ZUERST — sonst misst dieselbe SICHTBARE Zeichenkette zwei verschiedene
  // Längen, und die Differenz entscheidet über eine Operator-Frage.
  //
  // `"Nächste Prüf"` hat in beiden Unicode-Formen 12 Graphemcluster, also 12
  // sichtbare Zeichen. Als NFC sind das 12 Codepoints, als NFD 14 — die Akzente
  // stehen dort als eigene kombinierende Zeichen daneben. Ohne diese Zeile wird
  // die NFD-Fassung von H1 (Kopfzeile ≤ 12) abgelehnt und die NFC-Fassung
  // durchgelassen; gemessen 2026-08-22 am echten Hook über stdin:
  // NFC → ALLOW (kein stdout), NFD → deny.
  //
  // Das ist fail-closed am falschen Ort, und die Ablehnung widerlegt sich beim
  // Lesen selbst: ihr Grund zitiert eine Kopfzeile mit sichtbar 12 Zeichen und
  // behauptet daneben 14. Kürzen ist die einzige nahegelegte Handlung und
  // unmöglich — die Kopfzeile liegt bereits auf der Grenze. Das Modell
  // formuliert um, trifft dieselbe Wand, und weder es noch der Operator erfährt,
  // dass die Entscheidung nie gestellt wurde.
  //
  // Erreichbar ist das über den Laufzeitpfad, nicht über die Vorlagen: macOS
  // liefert Dateisystemnamen als NFD, also trägt jede Kopfzeile, die aus einem
  // Pfad, Branch- oder Dateinamen komponiert wird, die zerlegte Form. Der
  // 72-Vorlagen-Korpus ist vollständig NFC — deshalb konnte weder die Messung
  // aus Welle 2 noch das Umschreiben in Welle 3 darauf stoßen.
  //
  // Gefunden vom Security-Review dieser Session (W4-Q5), koordinator-verifiziert.
  return [...str.normalize('NFC')].length;
}

/**
 * Ersetzt literale `\n` und echte Zeilenumbrüche durch ein Leerzeichen.
 * K1 zählt die Umbrüche ZUERST und misst die Zeichen DANACH — sonst zählt der
 * Fragetext Escape-Sequenzen als zwei Zeichen mit.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeLiteralNewlines(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\\n|\r\n|\n/gu, ' ');
}

/**
 * Gleiche RegExp, aber mit `g`-Flag — für "alle Treffer".
 *
 * Die Registry-Muster tragen bewusst kein `g`: eine geteilte globale RegExp
 * schleppt `lastIndex` zwischen Aufrufen mit, sodass derselbe `.test()` beim
 * zweiten Mal `false` liefert. Wer alle Treffer braucht, holt sich hier eine
 * FRISCHE Instanz statt die geteilte zu mutieren.
 *
 * @param {RegExp} re
 * @returns {RegExp}
 */
export function globalOf(re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return new RegExp(re.source, flags);
}

// ---------------------------------------------------------------------------
// Noten
// ---------------------------------------------------------------------------

/**
 * Notenbänder, absteigend geprüft. `min` ist INKLUSIV: 90 ist ein A, 89 ein B.
 */
export const GRADE_BANDS = Object.freeze([
  Object.freeze({ grade: 'A', min: 90 }),
  Object.freeze({ grade: 'B', min: 75 }),
  Object.freeze({ grade: 'C', min: 60 }),
  Object.freeze({ grade: 'D', min: 45 }),
  Object.freeze({ grade: 'F', min: -Infinity }),
]);

/** Stabile Reihenfolge für die Notenverteilung. */
export const GRADES = Object.freeze(['A', 'B', 'C', 'D', 'F']);

/**
 * Note zu einer Punktzahl. Hürden sind hier NICHT enthalten — dafür ist
 * `makeScore` zuständig, das die Hürden-Übersteuerung anwendet.
 *
 * @param {number} points 0–100
 * @returns {'A'|'B'|'C'|'D'|'F'} `F` für alles, was keine Zahl ist
 */
export function gradeFor(points) {
  if (typeof points !== 'number' || !Number.isFinite(points)) return 'F';
  for (const band of GRADE_BANDS) {
    if (points >= band.min) return band.grade;
  }
  return 'F';
}

// ---------------------------------------------------------------------------
// Typen (JSDoc) — die Datensätze, die zwischen den drei Modulen fließen
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AuqOption
 * @property {string} label            Der sichtbare Knopftext.
 * @property {string} description      Der Erklärtext darunter.
 * @property {string|null} preview     Optionale Vorschau, `null` wenn keine.
 * @property {boolean} isRecommended   Trägt das Label einen Marker aus `RECOMMENDED_MARKERS`.
 * @property {number} index            0-basierte Position innerhalb der Frage.
 */

/**
 * @typedef {object} AuqQuestion
 * @property {string} question         Der Fragetext.
 * @property {string|null} header      Die Kopfzeile, `null` wenn keine gefunden.
 * @property {boolean} multiSelect     Vorgabe `false`.
 * @property {AuqOption[]} options
 * @property {number} previewCount     Wie viele Optionen dieser Frage eine Vorschau tragen.
 * @property {string} file             Repo-relativer Pfad.
 * @property {number} line             1-basierte Zeile des Fundorts.
 * @property {'A'|'B'|'C-mdc'|'C-mjs'|'C-prose'|'C-hybrid'} population
 * @property {'template'|'illustration'} kind
 * @property {'double'|'backtick'|'prose'} quoting
 */

/**
 * @typedef {object} AuqBlock
 * @property {string} file
 * @property {number} line
 * @property {AuqQuestion[]} questions  1–4 Fragen (die Tool-Grenze).
 */

/**
 * @typedef {object} AuqFinding
 * @property {string} criterion         Eine `id` aus `CRITERIA`.
 * @property {'fail'|'warn'} severity
 * @property {string} file
 * @property {number} line
 * @property {'question'|'option'|'header'} target
 * @property {number|null} optionIndex  Pflicht bei `target: 'option'`, sonst `null`.
 * @property {string} message           Operator-lesbar, deutsch, ohne Fachjargon.
 * @property {number|string|null} measured  Der konkrete gemessene Wert.
 * @property {number|string|null} threshold Die Schwelle, gegen die gemessen wurde.
 * @property {string|null} exempt       `'length'` = von K1/K6 befreit, sonst `null`.
 * @property {string} excerpt           Kurzes Zitat, höchstens `EXCERPT_MAX_CHARS`.
 */

/**
 * @typedef {object} AuqScore
 * @property {string} file
 * @property {number} line
 * @property {number} questionIndex     0-basierte Position der Frage in ihrem Block.
 * @property {number} points            0–100.
 * @property {'A'|'B'|'C'|'D'|'F'} grade
 * @property {Array<'H1'|'H2'>} hurdlesBroken
 * @property {AuqFinding[]} findings
 */

/**
 * @typedef {object} AuqReport
 * @property {string} schemaVersion
 * @property {string} measuredAt        ISO-8601.
 * @property {string|null} head         Kurzer HEAD-SHA.
 * @property {boolean} dirty            Arbeitsbaum schmutzig — dann ist `head` kein Anker.
 * @property {Record<string, number>} corpus   Zählung je Population.
 * @property {AuqBlock[]} blocks
 * @property {AuqScore[]} scores
 * @property {{grades: Record<string, number>, byCriterion: Record<string, {fail: number, warn: number}>}} summary
 */

// ---------------------------------------------------------------------------
// Fabriken
// ---------------------------------------------------------------------------

/**
 * Fehler beim Bau eines Datensatzes ist ein PROGRAMMIERFEHLER im erzeugenden
 * Modul, kein Datenbefund — deshalb wirft die Fabrik, statt still zu
 * normalisieren. Ein Befund mit der Kriteriums-ID `K9` würde sonst lautlos in
 * den Bericht laufen und in `summary.byCriterion` schlicht fehlen.
 *
 * @param {string} msg
 * @returns {never}
 */
function fail(msg) {
  throw new TypeError(`auq/schema: ${msg}`);
}

/** @param {unknown} v @returns {string} */
function asString(v, field) {
  if (typeof v !== 'string') fail(`${field} muss ein String sein (bekommen: ${typeof v})`);
  return v;
}

/** @param {unknown} v @returns {number} */
function asInt(v, field) {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    fail(`${field} muss eine ganze Zahl sein (bekommen: ${String(v)})`);
  }
  return v;
}

/**
 * Kürzt ein Zitat auf `EXCERPT_MAX_CHARS` Codepoints und hängt ein Auslassungs-
 * zeichen an. Zentral, damit nicht drei Module drei Zitatlängen erzeugen.
 *
 * @param {string} text
 * @returns {string}
 */
export function truncateExcerpt(text) {
  if (typeof text !== 'string' || text === '') return '';
  const flat = normalizeLiteralNewlines(text).trim();
  const chars = [...flat];
  if (chars.length <= EXCERPT_MAX_CHARS) return flat;
  return `${chars.slice(0, EXCERPT_MAX_CHARS - 1).join('')}…`;
}

/**
 * Baut eine Option. Setzt die Vorgaben, die sonst dreimal erfunden würden.
 *
 * @param {{label: string, description?: string, preview?: string|null, isRecommended?: boolean, index: number}} rec
 * @returns {AuqOption}
 */
export function makeOption(rec) {
  if (rec === null || typeof rec !== 'object') fail('makeOption braucht ein Objekt');
  return Object.freeze({
    label: asString(rec.label, 'label'),
    description: typeof rec.description === 'string' ? rec.description : '',
    preview: typeof rec.preview === 'string' ? rec.preview : null,
    isRecommended: rec.isRecommended === true,
    index: asInt(rec.index, 'index'),
  });
}

/**
 * Baut eine Frage. `previewCount` wird ABGELEITET, nicht übergeben — eine von
 * Hand mitgeführte Zahl ist ein Defekt in Wartestellung.
 *
 * @param {{question: string, header?: string|null, multiSelect?: boolean, options?: AuqOption[],
 *          file: string, line: number, population: string, kind: string, quoting: string}} rec
 * @returns {AuqQuestion}
 */
export function makeQuestion(rec) {
  if (rec === null || typeof rec !== 'object') fail('makeQuestion braucht ein Objekt');
  const options = Array.isArray(rec.options) ? rec.options : [];
  if (!POPULATIONS.includes(rec.population)) {
    fail(`unbekannte population: ${String(rec.population)} (erlaubt: ${POPULATIONS.join(', ')})`);
  }
  if (!KINDS.includes(rec.kind)) {
    fail(`unbekannter kind: ${String(rec.kind)} (erlaubt: ${KINDS.join(', ')})`);
  }
  if (!QUOTINGS.includes(rec.quoting)) {
    fail(`unbekanntes quoting: ${String(rec.quoting)} (erlaubt: ${QUOTINGS.join(', ')})`);
  }
  return Object.freeze({
    question: asString(rec.question, 'question'),
    header: typeof rec.header === 'string' ? rec.header : null,
    multiSelect: rec.multiSelect === true,
    options: Object.freeze([...options]),
    previewCount: options.filter((o) => o && o.preview !== null && o.preview !== undefined).length,
    file: asString(rec.file, 'file'),
    line: asInt(rec.line, 'line'),
    population: rec.population,
    kind: rec.kind,
    quoting: rec.quoting,
  });
}

/**
 * Baut einen Block. Die Fragenzahl wird NICHT erzwungen — ein Block mit 5
 * Fragen ist ein echter Befund des Korpus und muss in den Bericht, nicht in
 * einen Ausnahmefehler. (Die Optionsgrenze dagegen IST die Hürde H2 und wird
 * von clarity.mjs je Frage geprüft.)
 *
 * @param {{file: string, line: number, questions?: AuqQuestion[]}} rec
 * @returns {AuqBlock}
 */
export function makeBlock(rec) {
  if (rec === null || typeof rec !== 'object') fail('makeBlock braucht ein Objekt');
  return Object.freeze({
    file: asString(rec.file, 'file'),
    line: asInt(rec.line, 'line'),
    questions: Object.freeze(Array.isArray(rec.questions) ? [...rec.questions] : []),
  });
}

/**
 * Baut einen Befund.
 *
 * `message` ist das Feld, an dem dieses Programm sich selbst misst: es steht
 * später vor dem Operator. Deutsch, ohne Fachjargon, und es nennt WAS gemessen
 * wurde — nicht die Kriteriums-ID.
 *
 * @param {{criterion: string, severity: 'fail'|'warn', file: string, line: number,
 *          target: 'question'|'option'|'header', optionIndex?: number|null, message: string,
 *          measured?: number|string|null, threshold?: number|string|null,
 *          exempt?: string|null, excerpt?: string}} rec
 * @returns {AuqFinding}
 */
export function makeFinding(rec) {
  if (rec === null || typeof rec !== 'object') fail('makeFinding braucht ein Objekt');

  const criterion = asString(rec.criterion, 'criterion');
  if (!Object.prototype.hasOwnProperty.call(CRITERIA, criterion)) {
    fail(`unbekanntes Kriterium: ${criterion} (erlaubt: ${CRITERION_IDS.join(', ')})`);
  }
  if (!SEVERITIES.includes(rec.severity)) {
    fail(`unbekannte severity: ${String(rec.severity)} (erlaubt: ${SEVERITIES.join(', ')})`);
  }
  if (!TARGETS.includes(rec.target)) {
    fail(`unbekanntes target: ${String(rec.target)} (erlaubt: ${TARGETS.join(', ')})`);
  }
  const message = asString(rec.message, 'message');
  if (message.trim() === '') fail('message darf nicht leer sein — sie steht vor dem Operator');

  // Ein Options-Befund ohne Index ist keiner Option zuzuordnen und damit
  // unbrauchbar; ein Nicht-Options-Befund MIT Index behauptet eine Zuordnung,
  // die es nicht gibt.
  const hasIndex = typeof rec.optionIndex === 'number' && Number.isInteger(rec.optionIndex);
  if (rec.target === 'option' && !hasIndex) {
    fail('target "option" braucht einen ganzzahligen optionIndex');
  }
  if (rec.target !== 'option' && hasIndex) {
    fail(`target "${rec.target}" darf keinen optionIndex tragen`);
  }

  // `hurdle` — WELCHE harte Grenze dieser eine Befund reisst, oder `null`.
  //
  // Ohne dieses Feld muessen die Konsumenten die Zuordnung ueber
  // `HURDLES[id].criterion` rekonstruieren — und greifen dabei ueber: K6
  // erzeugt VIER Befundklassen (Beschreibungslaenge, Labellaenge, Nutzlast,
  // Optionszahl) und nur die letzte traegt H2. Gemessen 2026-08-22 am echten
  // Hook: unter der Ueberschrift „H2 — 2-4 Optionen je Frage" standen bei
  // 4 Fragen x 5 Optionen ZEHN Beschreibungslaengen-Zeilen und EINE, die den
  // echten Optionszahl-Bruch benannte; die Brueche der Fragen 2-4 fielen
  // komplett aus dem Zeilenbudget.
  //
  // Die Zuordnung existiert bei der Pruefung bereits (checkK5/checkK6 geben
  // `{findings, hurdles}` im selben Durchlauf zurueck) und wurde bisher an
  // `makeScore` weggeworfen. Sie hier mitzufuehren ersetzt zwei Rekonstruktionen
  // durch eine Tatsache — genau die Klasse aus Epic #1035 („Eine Tatsache, zwei
  // Kopien").
  //
  // Gefunden vom Architektur-Review dieser Session (W4-Q7), das den Fix in
  // dieser Form vorgeschlagen hat; koordinator-verifiziert.
  const hurdle =
    typeof rec.hurdle === 'string' && HURDLE_IDS.includes(rec.hurdle) ? rec.hurdle : null;

  return Object.freeze({
    criterion,
    severity: rec.severity,
    file: asString(rec.file, 'file'),
    line: asInt(rec.line, 'line'),
    target: rec.target,
    optionIndex: hasIndex ? rec.optionIndex : null,
    message,
    measured: rec.measured === undefined ? null : rec.measured,
    threshold: rec.threshold === undefined ? null : rec.threshold,
    exempt: typeof rec.exempt === 'string' ? rec.exempt : null,
    excerpt: truncateExcerpt(rec.excerpt ?? ''),
    hurdle,
  });
}

/**
 * Baut ein Ergebnis und LEITET die Note ab.
 *
 * Die Hürden-Übersteuerung sitzt hier, nicht beim Aufrufer: eine gerissene
 * Hürde ergibt F, auch bei 95 Punkten. Genau das ist der Unterschied zwischen
 * einer Hürde und einem schweren Kriterium — und genau die Stelle, an der ein
 * Aufrufer es vergessen würde.
 *
 * @param {{file: string, line: number, questionIndex: number, points: number,
 *          hurdlesBroken?: Array<'H1'|'H2'>, findings?: AuqFinding[]}} rec
 * @returns {AuqScore}
 */
export function makeScore(rec) {
  if (rec === null || typeof rec !== 'object') fail('makeScore braucht ein Objekt');
  if (typeof rec.points !== 'number' || !Number.isFinite(rec.points)) {
    fail(`points muss eine endliche Zahl sein (bekommen: ${String(rec.points)})`);
  }
  if (rec.points < 0 || rec.points > 100) {
    fail(`points muss zwischen 0 und 100 liegen (bekommen: ${rec.points})`);
  }

  const hurdlesBroken = Array.isArray(rec.hurdlesBroken) ? [...rec.hurdlesBroken] : [];
  for (const h of hurdlesBroken) {
    if (!HURDLE_IDS.includes(h)) {
      fail(`unbekannte Hürde: ${String(h)} (erlaubt: ${HURDLE_IDS.join(', ')})`);
    }
  }

  return Object.freeze({
    file: asString(rec.file, 'file'),
    line: asInt(rec.line, 'line'),
    questionIndex: asInt(rec.questionIndex, 'questionIndex'),
    points: rec.points,
    grade: hurdlesBroken.length > 0 ? 'F' : gradeFor(rec.points),
    hurdlesBroken: Object.freeze(hurdlesBroken),
    findings: Object.freeze(Array.isArray(rec.findings) ? [...rec.findings] : []),
  });
}

/**
 * Leerer Korpus-Zähler mit ALLEN Populationen auf 0.
 *
 * Fabrik statt handgeschriebenem Objektliteral, damit eine neue Population
 * nicht in einem der drei Module fehlt und dort als `undefined` in eine
 * Addition läuft.
 *
 * @returns {Record<string, number>}
 */
export function emptyCorpus() {
  const out = {};
  for (const p of POPULATIONS) out[p] = 0;
  return out;
}

/**
 * Leere Zusammenfassung: jede Note auf 0, jedes Kriterium mit `{fail: 0, warn: 0}`.
 * Gleicher Grund wie `emptyCorpus`.
 *
 * @returns {{grades: Record<string, number>, byCriterion: Record<string, {fail: number, warn: number}>}}
 */
export function emptySummary() {
  const grades = {};
  for (const g of GRADES) grades[g] = 0;
  const byCriterion = {};
  for (const k of CRITERION_IDS) byCriterion[k] = { fail: 0, warn: 0 };
  return { grades, byCriterion };
}

// ---------------------------------------------------------------------------
// Validierung
// ---------------------------------------------------------------------------

/**
 * Prüft einen fertigen Bericht gegen dieses Schema.
 *
 * WIRFT NIE — auch nicht bei `null`, einem String oder einem zyklischen Objekt.
 * Der Aufrufer ist die CLI, und ein Validator, der beim Prüfen abstürzt, nimmt
 * dem Operator genau die Fehlermeldung weg, für die er gebaut wurde.
 *
 * Die Fehlerliste ist VOLLSTÄNDIG (kein Abbruch beim ersten Fund) und jeder
 * Eintrag nennt seinen Pfad, damit man ihn ohne Suchen findet.
 *
 * @param {unknown} obj
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateReport(obj) {
  const errors = [];
  const push = (msg) => {
    if (errors.length < 200) errors.push(msg);
  };

  try {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, errors: [`report: muss ein Objekt sein (bekommen: ${obj === null ? 'null' : Array.isArray(obj) ? 'Array' : typeof obj})`] };
    }
    const r = /** @type {Record<string, unknown>} */ (obj);

    if (r.schemaVersion !== SCHEMA_VERSION) {
      push(`report.schemaVersion: erwartet "${SCHEMA_VERSION}", bekommen ${JSON.stringify(r.schemaVersion)}`);
    }
    if (typeof r.measuredAt !== 'string' || Number.isNaN(Date.parse(r.measuredAt))) {
      push(`report.measuredAt: muss ein ISO-8601-Zeitstempel sein (bekommen: ${JSON.stringify(r.measuredAt)})`);
    }
    if (!(typeof r.head === 'string' || r.head === null)) {
      push('report.head: muss ein String oder null sein');
    }
    if (typeof r.dirty !== 'boolean') {
      push('report.dirty: muss ein Boolean sein');
    }

    // corpus — jede Population, jede Zahl.
    if (r.corpus === null || typeof r.corpus !== 'object' || Array.isArray(r.corpus)) {
      push('report.corpus: muss ein Objekt sein');
    } else {
      for (const p of POPULATIONS) {
        const v = /** @type {Record<string, unknown>} */ (r.corpus)[p];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          push(`report.corpus.${p}: muss eine Zahl >= 0 sein (bekommen: ${JSON.stringify(v)})`);
        }
      }
    }

    // blocks
    if (!Array.isArray(r.blocks)) {
      push('report.blocks: muss ein Array sein');
    } else {
      r.blocks.forEach((b, i) => validateBlock(b, `report.blocks[${i}]`, push));
    }

    // scores
    if (!Array.isArray(r.scores)) {
      push('report.scores: muss ein Array sein');
    } else {
      r.scores.forEach((s, i) => validateScore(s, `report.scores[${i}]`, push));
    }

    // summary
    if (r.summary === null || typeof r.summary !== 'object' || Array.isArray(r.summary)) {
      push('report.summary: muss ein Objekt sein');
    } else {
      const s = /** @type {Record<string, unknown>} */ (r.summary);
      if (s.grades === null || typeof s.grades !== 'object') {
        push('report.summary.grades: muss ein Objekt sein');
      } else {
        for (const g of GRADES) {
          const v = /** @type {Record<string, unknown>} */ (s.grades)[g];
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            push(`report.summary.grades.${g}: muss eine Zahl >= 0 sein`);
          }
        }
      }
      if (s.byCriterion === null || typeof s.byCriterion !== 'object') {
        push('report.summary.byCriterion: muss ein Objekt sein');
      } else {
        for (const k of CRITERION_IDS) {
          const v = /** @type {Record<string, unknown>} */ (s.byCriterion)[k];
          if (v === null || typeof v !== 'object') {
            push(`report.summary.byCriterion.${k}: muss ein Objekt {fail, warn} sein`);
            continue;
          }
          for (const level of SEVERITIES) {
            const n = /** @type {Record<string, unknown>} */ (v)[level];
            if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
              push(`report.summary.byCriterion.${k}.${level}: muss eine Zahl >= 0 sein`);
            }
          }
        }
      }
    }
  } catch (err) {
    // Ein abstürzender Validator ist schlimmer als ein ungültiger Bericht.
    return { ok: false, errors: [`report: Validierung abgebrochen — ${err?.message ?? String(err)}`] };
  }

  return { ok: errors.length === 0, errors };
}

/** @param {unknown} b @param {string} path @param {(m: string) => void} push */
function validateBlock(b, path, push) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    push(`${path}: muss ein Objekt sein`);
    return;
  }
  const rec = /** @type {Record<string, unknown>} */ (b);
  if (typeof rec.file !== 'string' || rec.file === '') push(`${path}.file: muss ein nicht-leerer String sein`);
  if (!Number.isInteger(rec.line)) push(`${path}.line: muss eine ganze Zahl sein`);
  if (!Array.isArray(rec.questions)) {
    push(`${path}.questions: muss ein Array sein`);
    return;
  }
  rec.questions.forEach((q, i) => validateQuestion(q, `${path}.questions[${i}]`, push));
}

/** @param {unknown} q @param {string} path @param {(m: string) => void} push */
function validateQuestion(q, path, push) {
  if (q === null || typeof q !== 'object' || Array.isArray(q)) {
    push(`${path}: muss ein Objekt sein`);
    return;
  }
  const rec = /** @type {Record<string, unknown>} */ (q);
  if (typeof rec.question !== 'string') push(`${path}.question: muss ein String sein`);
  if (!(typeof rec.header === 'string' || rec.header === null)) {
    push(`${path}.header: muss ein String oder null sein`);
  }
  if (typeof rec.multiSelect !== 'boolean') push(`${path}.multiSelect: muss ein Boolean sein`);
  if (!POPULATIONS.includes(/** @type {string} */ (rec.population))) {
    push(`${path}.population: unbekannt (${JSON.stringify(rec.population)})`);
  }
  if (!KINDS.includes(/** @type {string} */ (rec.kind))) {
    push(`${path}.kind: unbekannt (${JSON.stringify(rec.kind)})`);
  }
  if (!QUOTINGS.includes(/** @type {string} */ (rec.quoting))) {
    push(`${path}.quoting: unbekannt (${JSON.stringify(rec.quoting)})`);
  }
  if (typeof rec.file !== 'string' || rec.file === '') push(`${path}.file: muss ein nicht-leerer String sein`);
  if (!Number.isInteger(rec.line)) push(`${path}.line: muss eine ganze Zahl sein`);
  if (!Number.isInteger(rec.previewCount)) push(`${path}.previewCount: muss eine ganze Zahl sein`);
  if (!Array.isArray(rec.options)) {
    push(`${path}.options: muss ein Array sein`);
    return;
  }
  rec.options.forEach((o, i) => {
    const p = `${path}.options[${i}]`;
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
      push(`${p}: muss ein Objekt sein`);
      return;
    }
    const opt = /** @type {Record<string, unknown>} */ (o);
    if (typeof opt.label !== 'string') push(`${p}.label: muss ein String sein`);
    if (typeof opt.description !== 'string') push(`${p}.description: muss ein String sein`);
    if (!(typeof opt.preview === 'string' || opt.preview === null)) {
      push(`${p}.preview: muss ein String oder null sein`);
    }
    if (typeof opt.isRecommended !== 'boolean') push(`${p}.isRecommended: muss ein Boolean sein`);
    if (!Number.isInteger(opt.index)) push(`${p}.index: muss eine ganze Zahl sein`);
  });
}

/** @param {unknown} s @param {string} path @param {(m: string) => void} push */
function validateScore(s, path, push) {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) {
    push(`${path}: muss ein Objekt sein`);
    return;
  }
  const rec = /** @type {Record<string, unknown>} */ (s);
  if (typeof rec.file !== 'string' || rec.file === '') push(`${path}.file: muss ein nicht-leerer String sein`);
  if (!Number.isInteger(rec.line)) push(`${path}.line: muss eine ganze Zahl sein`);
  if (!Number.isInteger(rec.questionIndex)) push(`${path}.questionIndex: muss eine ganze Zahl sein`);
  if (typeof rec.points !== 'number' || !Number.isFinite(rec.points) || rec.points < 0 || rec.points > 100) {
    push(`${path}.points: muss eine Zahl zwischen 0 und 100 sein (bekommen: ${JSON.stringify(rec.points)})`);
  }
  if (!GRADES.includes(/** @type {string} */ (rec.grade))) {
    push(`${path}.grade: unbekannt (${JSON.stringify(rec.grade)})`);
  }
  if (!Array.isArray(rec.hurdlesBroken)) {
    push(`${path}.hurdlesBroken: muss ein Array sein`);
  } else {
    rec.hurdlesBroken.forEach((h, i) => {
      if (!HURDLE_IDS.includes(/** @type {string} */ (h))) {
        push(`${path}.hurdlesBroken[${i}]: unbekannte Hürde (${JSON.stringify(h)})`);
      }
    });
    // Die Hürden-Übersteuerung ist der Sinn einer Hürde — ein Ergebnis, das
    // sie reißt und trotzdem eine Note trägt, hat sie unterwegs verloren.
    if (rec.hurdlesBroken.length > 0 && rec.grade !== 'F') {
      push(`${path}.grade: muss "F" sein, weil ${rec.hurdlesBroken.length} Hürde(n) gerissen sind`);
    }
  }
  if (!Array.isArray(rec.findings)) {
    push(`${path}.findings: muss ein Array sein`);
    return;
  }
  rec.findings.forEach((f, i) => validateFinding(f, `${path}.findings[${i}]`, push));
}

/** @param {unknown} f @param {string} path @param {(m: string) => void} push */
function validateFinding(f, path, push) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) {
    push(`${path}: muss ein Objekt sein`);
    return;
  }
  const rec = /** @type {Record<string, unknown>} */ (f);
  if (!Object.prototype.hasOwnProperty.call(CRITERIA, /** @type {string} */ (rec.criterion))) {
    push(`${path}.criterion: unbekannt (${JSON.stringify(rec.criterion)})`);
  }
  if (!SEVERITIES.includes(/** @type {string} */ (rec.severity))) {
    push(`${path}.severity: unbekannt (${JSON.stringify(rec.severity)})`);
  }
  if (!TARGETS.includes(/** @type {string} */ (rec.target))) {
    push(`${path}.target: unbekannt (${JSON.stringify(rec.target)})`);
  }
  if (typeof rec.message !== 'string' || rec.message.trim() === '') {
    push(`${path}.message: muss ein nicht-leerer String sein`);
  }
  if (typeof rec.file !== 'string' || rec.file === '') push(`${path}.file: muss ein nicht-leerer String sein`);
  if (!Number.isInteger(rec.line)) push(`${path}.line: muss eine ganze Zahl sein`);
  if (rec.target === 'option') {
    if (!Number.isInteger(rec.optionIndex)) {
      push(`${path}.optionIndex: Pflicht bei target "option"`);
    }
  } else if (rec.optionIndex !== null) {
    push(`${path}.optionIndex: muss null sein bei target "${String(rec.target)}"`);
  }
  if (!(typeof rec.exempt === 'string' || rec.exempt === null)) {
    push(`${path}.exempt: muss ein String oder null sein`);
  }
  if (typeof rec.excerpt !== 'string') push(`${path}.excerpt: muss ein String sein`);
  else if (codepointLength(rec.excerpt) > EXCERPT_MAX_CHARS) {
    push(`${path}.excerpt: höchstens ${EXCERPT_MAX_CHARS} Zeichen (bekommen: ${codepointLength(rec.excerpt)})`);
  }
}
