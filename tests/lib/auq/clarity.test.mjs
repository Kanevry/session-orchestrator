/**
 * clarity.test.mjs — pins den BEWERTER der AUQ-Klarheitsmessung (#1107).
 *
 * ## TV-001: die konkreten Fehler, die diese Tests fangen
 *
 * Jeder Fall unten benennt einen Defekt, der einbaubar ist und den sonst nichts
 * sieht. Ein Klarheits-Prüfer hat eine Besonderheit, die ihn von normalem Code
 * unterscheidet: SEINE FALSCH-POSITIVE SIND SEIN TOD. Meckert er korrekte
 * Fragen an, schaltet der Operator ihn ab — und dann ist auch jede richtig
 * gefundene Schwäche weg. Die Mehrzahl der Fälle hier pinnt deshalb ein
 * BESTEHEN, nicht ein Durchfallen.
 *
 * Alle Zitate sind aus dem echten Repo gemessen (2026-08-22, siehe Dateiangabe
 * am jeweiligen Fall). Ein erfundenes Wunschformat pinnte die Annahme des
 * Testautors statt der Wirklichkeit — genau der "unfaithful double" aus
 * `.claude/rules/testing.md`.
 *
 * Kein Test liest eine Datei und behauptet, ein Satz stehe darin (TV-002c).
 */

import { describe, it, expect } from 'vitest';

import { makeOption, makeQuestion, makeBlock, THRESHOLDS } from '../../../scripts/lib/auq/schema.mjs';
import { scoreQuestion, scoreBlocks } from '../../../scripts/lib/auq/clarity.mjs';

// ---------------------------------------------------------------------------
// Fabriken
// ---------------------------------------------------------------------------

const META = { population: 'A', kind: 'template', quoting: 'double' };

/**
 * @param {{question: string, header?: string|null, options: Array<object>, file?: string, line?: number}} rec
 */
function question(rec) {
  return makeQuestion({
    question: rec.question,
    header: rec.header ?? 'Kurz',
    file: rec.file ?? 'skills/x/SKILL.md',
    line: rec.line ?? 1,
    options: rec.options.map((o, index) => makeOption({ ...o, index })),
    ...META,
  });
}

/** Zwei unauffällige Optionen — Füllmaterial für Fragen, die anderswo messen. */
const NEUTRAL_OPTIONS = [
  { label: 'Weiter', description: 'Jetzt weitermachen, weil danach nichts mehr davon abhängt.' },
  { label: 'Abbrechen', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
];

/** @param {object} score @param {string} criterion */
const fails = (score, criterion) =>
  score.findings.some((f) => f.criterion === criterion && f.severity === 'fail');

/** @param {object} score @param {string} criterion */
const warns = (score, criterion) =>
  score.findings.some((f) => f.criterion === criterion && f.severity === 'warn');

/** @param {object} score @param {string} criterion */
const findingsFor = (score, criterion) => score.findings.filter((f) => f.criterion === criterion);

// ---------------------------------------------------------------------------

describe('K3 — Beschreibung wiederholt Label', () => {
  // DEFEKT: K3 als DISJUNKTION implementiert (novelty ODER containment).
  // Dann schlagen die fünf Einwort-Labels des Korpus durch, die containment
  // 1.00 erreichen, obwohl ihre Beschreibung reichlich Substanz trägt — 100 %
  // Falsch-Positive auf genau der Konstruktion, für die die Konjunktion
  // eingebaut wurde.
  it('lässt ein Einwort-Label mit containment 1.00 bestehen, solange die Beschreibung Neues sagt', () => {
    const score = scoreQuestion(
      question({
        question: 'Welche Sichtbarkeit soll das Repo bekommen?',
        options: [
          {
            label: 'internal',
            description: 'Internal heißt: sichtbar für das Team, unsichtbar für alle anderen Gruppen.',
          },
          { label: 'Abbrechen', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
        ],
      }),
    );
    expect(fails(score, 'K3')).toBe(false);
  });

  // DEFEKT: die Konjunktion zu streng gefasst (etwa containment > 0.5 statt
  // >= 0.5), wodurch der EINZIGE echte Treffer des Korpus verschwindet und K3
  // zu totem Code wird.
  // Quelle: skills/evolve/SKILL.md:464
  it('meldet den echten Fall aus evolve/SKILL.md:464', () => {
    const score = scoreQuestion(
      question({
        question: 'Was soll mit den Learnings geschehen?',
        options: [
          { label: 'Done — no changes', description: 'Exit without changes' },
          { label: 'Weiter', description: 'Jetzt weitermachen, weil danach nichts mehr davon abhängt.' },
        ],
      }),
    );
    const k3 = findingsFor(score, 'K3');
    expect(k3).toHaveLength(1);
    // Die Arithmetik selbst pinnen: novelty/containment sind der ganze Inhalt
    // des Kriteriums. Rechnet jemand sie um, geht dieser Wert rot.
    expect(k3[0].measured).toBe('novelty=2 containment=0.50');
    expect(k3[0].optionIndex).toBe(0);
  });
});

describe('K4 — Empfehlung ohne Grund', () => {
  // DEFEKT: die vierte Markerklasse (Vergleich) weggelassen. Gemessen steigt
  // die Falsch-Positiv-Rate dann von 14 % auf 44 %: 7 statt 1 falsch markierte
  // Empfehlungen unter 29. Dieses Zitat ist einer dieser sieben.
  // Quelle: die Vergleichs-Markerklasse, gemessen 2026-08-22
  it('lässt eine Empfehlung bestehen, deren Grund ein Vergleich ist', () => {
    const score = scoreQuestion(
      question({
        question: 'Wie sollen die Agenten aufgeteilt werden?',
        options: [
          {
            label: 'Nach Dateien (Recommended)',
            description: 'Fastest for file-disjoint tasks.',
            isRecommended: true,
          },
          { label: 'Abbrechen', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
        ],
      }),
    );
    expect(fails(score, 'K4')).toBe(false);
  });

  // DEFEKT: K4 gar nicht verdrahtet — der Test oben allein wäre dann grün und
  // bewiese nichts.
  it('meldet eine Empfehlung, die weder Grund noch Preis noch Folge noch Vergleich nennt', () => {
    const score = scoreQuestion(
      question({
        question: 'Wie sollen die Agenten aufgeteilt werden?',
        options: [
          { label: 'Nach Dateien (Recommended)', description: 'Nach Dateien aufteilen.', isRecommended: true },
          { label: 'Abbrechen', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
        ],
      }),
    );
    expect(fails(score, 'K4')).toBe(true);
  });

  // DEFEKT: reine Platzhalter-Optionen nicht ausgefiltert. Dann meldet der
  // Prüfer genau die Stellen als Verstoß, an denen der Autor bereits weiß, dass
  // dort noch Text hingehört.
  // Quelle: skills/bootstrap/SKILL.md:81
  it('überspringt eine Option, die nur aus einem Platzhalter besteht', () => {
    const score = scoreQuestion(
      question({
        question: 'Welche Stufe soll gebaut werden?',
        options: [
          {
            label: '<RECOMMENDED_TIER> (Empfohlen)',
            description: '<one-line description of what this tier scaffolds>',
            isRecommended: true,
          },
          { label: 'Abbrechen', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
        ],
      }),
    );
    expect(fails(score, 'K4')).toBe(false);
  });
});

describe('K5 — Header-Grenze (Hürde H1)', () => {
  // DEFEKT: Header BYTEWEISE gemessen. 'Evolve — Rev' hat 12 Codepoints, aber
  // 14 Bytes (der Gedankenstrich ist 3 Bytes in UTF-8) — bytebasiert reißt eine
  // Kopfzeile die Grenze, die vollständig beim Operator ankommt, und der
  // Bericht behauptet eine Verstümmelung, die es nicht gibt.
  it('misst die Kopfzeile in Codepoints, nicht in Bytes', () => {
    expect([...'Evolve — Rev'].length).toBe(THRESHOLDS.K5.headerCharsFail);
    expect(Buffer.byteLength('Evolve — Rev')).toBeGreaterThan(THRESHOLDS.K5.headerCharsFail);

    const score = scoreQuestion(
      question({ question: 'Was tun?', header: 'Evolve — Rev', options: NEUTRAL_OPTIONS }),
    );
    expect(fails(score, 'K5')).toBe(false);
    expect(score.hurdlesBroken).toEqual([]);
  });

  // DEFEKT: H1 nicht an K5 gehängt — die Note bliebe dann A, obwohl das Tool
  // die Kopfzeile abschneidet und der Operator den Rest nie sieht.
  // Quelle: skills/evolve/SKILL.md:458
  it('reißt H1 bei einer zu langen Kopfzeile und erzwingt damit Note F', () => {
    const score = scoreQuestion(
      question({ question: 'Was tun?', header: 'Evolve — Review', options: NEUTRAL_OPTIONS }),
    );
    expect(fails(score, 'K5')).toBe(true);
    expect(score.hurdlesBroken).toEqual(['H1']);
    expect(score.grade).toBe('F');
    expect(score.points).toBe(100); // K5 wiegt 0 — die Hürde allein setzt die Note
  });

  // DEFEKT: Platzhalter-Kopfzeile als harter Fehler behandelt. Ihre echte Länge
  // ist erst zur Laufzeit bekannt; eine Vermutung darf keine Hürde reißen.
  it('meldet eine Platzhalter-Kopfzeile nur als Hinweis, ohne H1 zu reißen', () => {
    const score = scoreQuestion(
      question({ question: 'Was tun?', header: '<TIER> wählen', options: NEUTRAL_OPTIONS }),
    );
    expect(warns(score, 'K5')).toBe(true);
    expect(fails(score, 'K5')).toBe(false);
    expect(score.hurdlesBroken).toEqual([]);
  });
});

describe('K6 / H2 — Optionen zählen je Frage, nicht je Block', () => {
  // DEFEKT: Optionen BLOCKWEISE gezählt. Dann meldet der Bewerter den
  // saubersten mehrteiligen Dialog im Repo als schwersten Verstoß: vier Fragen
  // mit je 3-4 Optionen ergeben blockweise 14 und damit einen H2-Bruch.
  // Quelle: skills/plan/SKILL.md:137
  it('reißt H2 nicht bei einem Mehrfragen-Block mit je vier Optionen', () => {
    const block = makeBlock({
      file: 'skills/plan/SKILL.md',
      line: 137,
      questions: [
        question({
          question: 'Which project archetype fits best?',
          header: 'Archetype',
          file: 'skills/plan/SKILL.md',
          line: 137,
          options: [
            { label: 'nextjs-saas (Recommended)', description: 'Pro: Full SaaS stack with auth, payments. Con: Heavier initial setup.', isRecommended: true },
            { label: 'express-service', description: 'Pro: Lightweight API. Con: No frontend.' },
            { label: 'docker-service', description: 'Pro: Maximum flexibility. Con: More manual setup.' },
            { label: 'Other', description: 'Describe your preferred archetype.' },
          ],
        }),
        question({
          question: 'Which visibility tier?',
          header: 'Visibility',
          file: 'skills/plan/SKILL.md',
          line: 142,
          options: [
            { label: 'internal (Recommended)', description: 'Pro: GitLab private, team access. Con: No external visibility.', isRecommended: true },
            { label: 'public', description: 'Pro: Sichtbar für alle. Con: Jeder Fehler steht öffentlich.' },
            { label: 'Other', description: 'Eine andere Stufe beschreiben.' },
          ],
        }),
      ],
    });

    const scores = scoreBlocks([block]);
    expect(scores).toHaveLength(2);
    expect(scores.flatMap((s) => s.hurdlesBroken)).toEqual([]);
    expect(scores.map((s) => s.questionIndex)).toEqual([0, 1]);
  });

  // DEFEKT: H2 gar nicht verdrahtet — der Test oben wäre dann vakuum-grün.
  // Quelle: skills/bootstrap/SKILL.md:77 (5 Optionen)
  it('reißt H2 bei fünf Optionen in EINER Frage', () => {
    const score = scoreQuestion(
      question({
        question: 'Welche Stufe soll gebaut werden?',
        options: [
          { label: 'fast', description: 'Nur die Grundgerüste anlegen und sonst nichts.' },
          { label: 'standard', description: 'Grundgerüst plus Tests und Linting anlegen.' },
          { label: 'deep', description: 'Standard plus CI und Freigabe-Regeln anlegen.' },
          { label: 'custom', description: 'Die Auswahl gleich hier von Hand beschreiben.' },
          { label: 'Abbrechen', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
        ],
      }),
    );
    expect(score.hurdlesBroken).toEqual(['H2']);
    expect(score.grade).toBe('F');
  });
});

describe('Unsicherheit der Vorlage', () => {
  // DEFEKT: H2 feuert auf einer Vorlage, deren Optionsliste mit einer Auslassung
  // abbricht ("…up to 4 options per batch…"). Die wahre Optionszahl steht dort
  // nicht — ein FAIL wären drei erfundene Verstöße im Korpus
  // (skills/reconcile/SKILL.md:246, skills/evolve/SKILL.md:251,
  // agents/memory-proposal-collector.md:139). NICHT PRÜFBAR ist nicht dasselbe
  // wie VERSTOSSEN.
  //
  // Das Paar unterscheidet sich in genau einem Feld, damit nichts anderes das
  // Ergebnis erklären kann.
  it('reißt H2 nicht, wenn die Optionszahl der Vorlage unbekannt ist', () => {
    const fuenf = {
      question: 'Was soll mit den Vorschlägen geschehen?',
      options: [
        { label: 'A', description: 'Den ersten Vorschlag jetzt übernehmen.' },
        { label: 'B', description: 'Den zweiten Vorschlag jetzt übernehmen.' },
        { label: 'C', description: 'Den dritten Vorschlag jetzt übernehmen.' },
        { label: 'D', description: 'Den vierten Vorschlag jetzt übernehmen.' },
        { label: 'E', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
      ],
    };
    const bekannt = scoreQuestion(question(fuenf));
    const unbekannt = scoreQuestion({ ...question(fuenf), optionCountUnknown: true });

    expect(bekannt.hurdlesBroken).toEqual(['H2']);
    expect(unbekannt.hurdlesBroken).toEqual([]);
    expect(unbekannt.grade).not.toBe('F');

    // Die Lücke wird benannt, nicht verschwiegen — sonst sieht der Bericht so
    // aus, als sei die Frage geprüft worden.
    const hinweis = findingsFor(unbekannt, 'K6').filter((f) => f.measured === 'unbekannt');
    expect(hinweis).toHaveLength(1);
    expect(hinweis[0].severity).toBe('warn');
  });

  // DEFEKT: auf Wahrheitswert statt auf `=== true` geprüft. Das Feld ist ADDITIV
  // und steht nicht im eingefrorenen AuqQuestion-Vertrag — bei einer Frage, die
  // es gar nicht trägt, ist es `undefined`, und "undefined ist nicht wahr" darf
  // nie zu "unbekannt" werden. Ein `optionCountUnknown: false` aus einem
  // späteren Parser-Umbau muss ebenso die Prüfung AKTIV lassen.
  it('behandelt nur ein explizites true als unbekannt', () => {
    const fuenf = {
      question: 'Was tun?',
      options: [
        { label: 'A', description: 'Den ersten Vorschlag jetzt übernehmen.' },
        { label: 'B', description: 'Den zweiten Vorschlag jetzt übernehmen.' },
        { label: 'C', description: 'Den dritten Vorschlag jetzt übernehmen.' },
        { label: 'D', description: 'Den vierten Vorschlag jetzt übernehmen.' },
        { label: 'E', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
      ],
    };
    expect(scoreQuestion({ ...question(fuenf), optionCountUnknown: false }).hurdlesBroken).toEqual(['H2']);
    expect(scoreQuestion({ ...question(fuenf), optionCountUnknown: 1 }).hurdlesBroken).toEqual(['H2']);
  });

  // DEFEKT: eine am Quelltext gemessene Länge wird als exakt berichtet, obwohl
  // die Vorlage `${…}` einsetzt — `${blockingSession.worktreePath}` wird zu
  // einem absoluten Pfad. Ein späterer Leser hielte die neun Backtick-Werte im
  // Korpus für gemessen statt für Untergrenzen. Geschätzt wird nichts: die Zahl
  // bleibt, nur ihre Lesart wird richtiggestellt.
  it('kennzeichnet eine Länge als Untergrenze, wenn die Vorlage Werte einsetzt', () => {
    const text =
      'Session lock is held by ${blockingSession.id} on ${blockingSession.host} at ' +
      '${blockingSession.worktreePath} and the entry is older than the configured window. Weiter?';

    const backtick = scoreQuestion(
      makeQuestion({
        question: text,
        header: 'Kurz',
        file: 'skills/x/SKILL.md',
        line: 1,
        options: NEUTRAL_OPTIONS.map((o, index) => makeOption({ ...o, index })),
        population: 'A',
        kind: 'template',
        quoting: 'backtick',
      }),
    );
    // Derselbe Text doppelt gequotet: dort ist `${…}` wörtlicher Inhalt und die
    // Messung exakt. Ein Hinweis wäre hier eine Falschaussage.
    const doppelt = scoreQuestion(question({ question: text, options: NEUTRAL_OPTIONS }));

    expect(findingsFor(backtick, 'K1')[0].message).toContain('UNTERGRENZE');
    expect(findingsFor(doppelt, 'K1')[0].message).not.toContain('UNTERGRENZE');
    // Die Zahl selbst bleibt die gemessene — kein geschätzter Aufschlag.
    expect(findingsFor(backtick, 'K1')[0].measured).toBe(findingsFor(doppelt, 'K1')[0].measured);
  });
});

describe('K7 — Unerklärter Bezeichner', () => {
  // DEFEKT: K7 als DICHTE statt als absoluter Zahl. Die gemessene Dichte hat
  // Median 0 und Maximum 0,44 und trennt damit nichts — schlimmer, sie versteckt
  // einen Bezeichner umso besser, je mehr Prosa drumherum steht. Beide Sätze
  // hier nennen GENAU EINEN unerklärten Bezeichner; ihre Dichte unterscheidet
  // sich um mehr als das Doppelte. Eine Dichteschwelle, die den kurzen fängt,
  // lässt den langen durch.
  // Quelle des kurzen Satzes: skills/evolve/SKILL.md:463
  it('meldet denselben Bezeichner im kurzen wie im langen Satz', () => {
    const kurz = scoreQuestion(
      question({
        question: 'Was soll mit den Learnings geschehen?',
        options: [
          { label: 'Extend expiry', description: 'Reset expires_at by learning-expiry-days from now' },
          { label: 'Abbrechen', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
        ],
      }),
    );
    const lang = scoreQuestion(
      question({
        question: 'Was soll mit den Learnings geschehen?',
        options: [
          {
            label: 'Extend expiry',
            description:
              'Verlängert expires_at bei allen ausgewählten Einträgen um die konfigurierte Anzahl an Tagen ab heute',
          },
          { label: 'Abbrechen', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
        ],
      }),
    );
    expect(fails(kurz, 'K7')).toBe(true);
    expect(fails(lang, 'K7')).toBe(true);
    expect(findingsFor(lang, 'K7')[0].measured).toBe(1);
  });

  // DEFEKT: die Glossen-Regel nicht umgesetzt (oder Platzhalter nicht vor der
  // Erkennung entfernt). Ohne das Entfernen zerfällt der Pfad an `<feature>` in
  // zwei Bruchstücke, von denen die Erklärung hinter dem Gedankenstrich nur das
  // hintere erreicht — und K7 meldet eine vorbildlich glossierte Option.
  // Quelle: skills/write-executable-plan/SKILL.md:51
  it('lässt einen Bezeichner bestehen, hinter dem eine bezeichnerfreie Erklärung steht', () => {
    const score = scoreQuestion(
      question({
        question: 'Which source should this plan be based on?',
        header: 'Plan Source',
        options: [
          {
            label: 'Existing PRD (Recommended)',
            description: 'Point me to docs/prd/YYYY-MM-DD-<feature>.md — most precise decomposition.',
            isRecommended: true,
          },
          { label: 'Describe inline', description: 'Paste or describe the feature — I will ask follow-up questions before planning.' },
        ],
      }),
    );
    expect(score.findings).toEqual([]);
    expect(score.points).toBe(100);
    expect(score.grade).toBe('A');
  });

  // DEFEKT: Bedingung 4 der Glossen-Regel weggelassen ("die Erklärung enthält
  // selbst keinen Bezeichner"). `Details: docs/telemetry.md` sieht dann wie eine
  // Glosse aus — sie verschiebt das Nachschlagen aber nur um ein Wort.
  // Quelle: skills/session-start/SKILL.md:1059
  it('erkennt eine Erklärung nicht an, die selbst nur aus einem Bezeichner besteht', () => {
    const score = scoreQuestion(
      question({
        question: 'Telemetrie aktivieren?',
        options: [
          {
            label: 'Ja, aktivieren',
            description:
              'Anonymer Zähl-/Struktur-Datensatz (Skill-/Phasen-Nutzung, Erfolg/Abbruch) — whitelist-projiziert, keine Pfade/Prompts/Repo-Namen. Details: docs/telemetry.md',
          },
          { label: 'Nein', description: 'Keine Telemetrie senden und später neu entscheiden.' },
        ],
      }),
    );
    expect(fails(score, 'K7')).toBe(true);
    expect(findingsFor(score, 'K7')[0].message).toContain('docs/telemetry.md');
  });

  // DEFEKT: das gierige Pfadmuster verschluckt den Satzpunkt, und die Allowlist
  // vergleicht per Vertrag auf EXAKTE Zeichengleichheit — `STATE.md.` verfehlt
  // dann den Eintrag `STATE.md`, und K7 meldet einen ausdrücklich erlaubten
  // Bezeichner als unerklärt. Die teuerste Sorte Falsch-Positiv: sie trifft
  // genau die Wörter, die der Operator täglich selbst benutzt.
  it('erkennt einen Allowlist-Bezeichner auch am Satzende', () => {
    const score = scoreQuestion(
      question({
        question: 'Weitermachen?',
        options: [
          { label: 'Ja', description: 'Der aktuelle Sachstand steht bereits vollständig in STATE.md.' },
          { label: 'Nein', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
        ],
      }),
    );
    expect(fails(score, 'K7')).toBe(false);
  });
});

describe('K8 — "Geh selbst nachsehen"', () => {
  // DEFEKT: der Lese-Imperativ allein löst aus, ohne dass überhaupt ein Ziel in
  // Reichweite steht. Beide Beschreibungen hier tragen einen Imperativ
  // (`Review`, `inspect`), aber keinen Pfad und keine Issue-Nummer — gemessen
  // 2026-08-22 trifft KEIN Bezeichner-Muster auf diese Zeile, `/close`
  // eingeschlossen. Ohne die Ziel-Bedingung meldete K8 jede Option, die das Wort
  // "Review" enthält.
  //
  // ACHTUNG, was dieser Fall NICHT zeigt: die Ich-Form-Regel. Sie ist hier
  // wirkungslos, weil schon das Ziel fehlt — der Ausschluss wird im Test
  // darunter isoliert geprüft. (Gemessen: das reale Zitat besteht K8 auch mit
  // abgeschaltetem Ausschluss.)
  // Quelle: skills/session-end/SKILL.md:900 + :903
  it('meldet nicht, wenn ein Lese-Imperativ ohne Ziel dasteht', () => {
    const score = scoreQuestion(
      question({
        question: 'Was soll mit dem Worktree geschehen?',
        options: [
          { label: 'Behalten', description: 'Keep the worktree as-is. No cleanup. Review and remove manually later.' },
          { label: 'Manuell', description: 'Exit /close. I will inspect the worktree before re-running /close.' },
        ],
      }),
    );
    expect(fails(score, 'K8')).toBe(false);
  });

  // DEFEKT: den Ich-Form-Ausschluss weggelassen. Dann meldet K8 ausgerechnet
  // die Option als Verstoß, die dem Operator die Arbeit ABNIMMT — dort sieht der
  // AGENT nach, nicht der Operator.
  //
  // Die beiden Beschreibungen unterscheiden sich in GENAU DREI WÖRTERN: Imperativ,
  // Ziel und Abstand sind identisch, nur das "I will" davor kommt hinzu. Damit ist
  // der Ausschluss das einzige, was sie trennen kann — anders als beim realen
  // Zitat oben, das schon am fehlenden Ziel scheitert und den Ausschluss deshalb
  // gar nicht erst erreicht.
  it('unterscheidet "sieh du nach" von "ich sehe nach"', () => {
    const mit = (description) =>
      scoreQuestion(
        question({
          question: 'Wie weiter?',
          options: [
            { label: 'A', description },
            { label: 'B', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
          ],
        }),
      );

    expect(fails(mit('Inspect .orchestrator/session.lock before proceeding.'), 'K8')).toBe(true);
    expect(fails(mit('I will inspect .orchestrator/session.lock before proceeding.'), 'K8')).toBe(false);
  });

  // DEFEKT: K8 gar nicht verdrahtet — die Tests oben wären dann vakuum-grün.
  // Quelle: skills/session-start/SKILL.md:166
  it('meldet, wenn der Operator erst eine Datei öffnen soll', () => {
    const score = scoreQuestion(
      question({
        question: 'Lock übernehmen?',
        options: [
          { label: 'Reclaim', description: 'Overwrite the stale lock and continue. Safe when the previous session is no longer active.' },
          { label: 'Abort', description: 'Stop here. Inspect .orchestrator/session.lock before proceeding.' },
        ],
      }),
    );
    expect(fails(score, 'K8')).toBe(true);
    expect(findingsFor(score, 'K8')[0].optionIndex).toBe(1);
  });
});

describe('K1 — Payload-Form', () => {
  // DEFEKT: die Aufzählungs-Ausnahme weggelassen. Diese Frage hat fünf
  // eingebettete Zeilen und ist trotzdem vorbildlich — die Liste IST die
  // Tatsache, die der Operator zum Entscheiden braucht. Ohne die Ausnahme
  // meldet K1 die bestgebaute Bestätigungsfrage im Repo als Bericht.
  // Quelle: skills/discovery/SKILL.md:414
  it('lässt eine Frage mit Aufzählung bestehen', () => {
    const score = scoreQuestion(
      question({
        question: 'Ready to create [N] issues?\\n\\n- [X] critical\\n- [Y] high\\n- [Z] medium\\n- [W] low',
        header: 'Confirm',
        options: [
          { label: 'Create all [N] issues', description: 'Proceed with issue creation' },
          { label: 'Cancel', description: 'Do not create any issues' },
        ],
      }),
    );
    expect(fails(score, 'K1')).toBe(false);
  });

  // DEFEKT: die Ausnahme zu breit gefasst, sodass JEDE Mehrzeiligkeit
  // durchgeht. Derselbe Aufbau mit Fließtextzeilen statt Aufzählung ist ein
  // Bericht mit Fragezeichen und muss zubeißen.
  it('meldet dieselbe Frage, wenn die Zeilen Fließtext statt Aufzählung sind', () => {
    const score = scoreQuestion(
      question({
        question: 'Ready to create issues?\\nEs gibt kritische Funde.\\nEs gibt auch hohe Funde.',
        header: 'Confirm',
        options: [
          { label: 'Create all issues', description: 'Proceed with issue creation' },
          { label: 'Cancel', description: 'Do not create any issues' },
        ],
      }),
    );
    expect(fails(score, 'K1')).toBe(true);
  });
});

describe('Die Sicherheits-Ausnahme', () => {
  const stale =
    "Stale session lock found (started ${ageHours}h ago, ttl=${existingLock.ttl_hours}h). " +
    'Process pid=${existingLock.pid} on host=${existingLock.host} is confirmed dead. Reclaim the lock?';
  // Derselbe Text ohne jedes Sicherheitswort — gleiche Länge, gleiche Form.
  const neutral = stale
    .replaceAll('Stale', 'Older')
    .replaceAll('lock', 'entry')
    .replaceAll('dead', 'gone');

  // DEFEKT: die Ausnahme greift nur ZUFÄLLIG (etwa weil alle heutigen
  // Sicherheitstexte ohnehin unter der Warnschwelle liegen) statt strukturell.
  // Dieses Paar ist die Gegenprobe: identische Länge, identische Form, EIN
  // Unterschied — das Sicherheitswort. Geht der linke Fall auf `fail`, kann ein
  // späterer automatischer Kürzungsschritt eine Warnung wegkürzen.
  it('stuft einen Längenverstoß in einem Sicherheitstext auf Hinweis herab und markiert ihn', () => {
    const geschuetzt = scoreQuestion(question({ question: stale, options: NEUTRAL_OPTIONS }));
    const ungeschuetzt = scoreQuestion(question({ question: neutral, options: NEUTRAL_OPTIONS }));

    const k1 = findingsFor(geschuetzt, 'K1');
    expect(k1).toHaveLength(1);
    expect(k1[0].severity).toBe('warn');
    expect(k1[0].exempt).toBe('length');
    expect(geschuetzt.points).toBe(100);

    // Gegenprobe: ohne Sicherheitswort beißt dasselbe Kriterium zu.
    expect(fails(ungeschuetzt, 'K1')).toBe(true);
    expect(findingsFor(ungeschuetzt, 'K1')[0].exempt).toBe(null);
    expect(ungeschuetzt.points).toBeLessThan(100);
  });

  // DEFEKT: die Ausnahme befreit versehentlich AUCH K7. Dann hört die
  // Jargon-Prüfung ausgerechnet für Warntexte stillschweigend auf — und
  // Warntexte sind die, bei denen Verstehen am meisten zählt. K7 fügt
  // Information hinzu und nimmt keine weg; es darf nie mitbefreit werden.
  // Quelle: skills/session-start/SKILL.md:167
  it('befreit einen Sicherheitstext NICHT von der Jargon-Prüfung', () => {
    const score = scoreQuestion(
      question({
        question: 'Lock übernehmen?',
        options: [
          { label: 'Reclaim', description: 'Overwrite the stale lock and continue. Safe when the previous session is no longer active.' },
          { label: 'Abort', description: 'Stop here. Inspect .orchestrator/session.lock before proceeding.' },
        ],
      }),
    );
    const k7 = findingsFor(score, 'K7');
    expect(k7).toHaveLength(1);
    expect(k7[0].severity).toBe('fail');
    expect(k7[0].exempt).toBe(null);
  });

  // DEFEKT: der Ausnahme wird der Nutzlast-Text als Subjekt untergeschoben,
  // obwohl die OPTIONSANZAHL gemessen wurde. Ein einziges Sicherheitswort in
  // irgendeiner Beschreibung stufte den Befund dann auf `warn` herab und
  // markierte ihn als befreit — die Frage bekäme zwar weiter Note F (die Hürde
  // hängt nicht an der Severity), aber der EINZIGE Befund, der das erklärt,
  // stünde als Hinweis da. Der Operator liest "F" ohne Fehler und findet den
  // Grund nicht.
  //
  // Deshalb wird hier auf Severity UND `exempt` geprüft und nicht nur auf die
  // Hürde: die Hürde allein hält auch dann, wenn die Ausnahme falsch greift,
  // und wäre als Wächter blind.
  it('hebelt H2 nicht aus, wenn die Optionen Sicherheitswörter enthalten', () => {
    const score = scoreQuestion(
      question({
        question: 'Was tun?',
        options: [
          { label: 'A', description: 'Delete the stale lock and continue with a fresh token.' },
          { label: 'B', description: 'Overwrite the credential and report the error afterwards.' },
          { label: 'C', description: 'Force-delete the invalid permission entry right away.' },
          { label: 'D', description: 'Reset the failed session and warn the other operator.' },
          { label: 'E', description: 'Purge the secret and revert the last destructive change.' },
        ],
      }),
    );
    expect(score.hurdlesBroken).toEqual(['H2']);
    expect(score.grade).toBe('F');

    const zaehlbefund = findingsFor(score, 'K6').filter(
      (f) => f.threshold === THRESHOLDS.K6.optionsMax,
    );
    expect(zaehlbefund).toHaveLength(1);
    expect(zaehlbefund[0].severity).toBe('fail');
    expect(zaehlbefund[0].exempt).toBe(null);
  });
});

describe('Punkteformel', () => {
  // DEFEKT: je FEHLENDEM BEFUND abgezogen statt je Kriterium. Drei Optionen mit
  // demselben Mangel zögen dann 75 statt 25 Punkte — dieselbe Schwäche
  // bestrafte eine Vier-Options-Frage doppelt so hart wie eine
  // Zwei-Options-Frage, und die Note hinge an der Optionsanzahl statt an der
  // Qualität.
  it('zieht ein Kriterium höchstens einmal ab, egal wie viele Optionen es reißen', () => {
    const score = scoreQuestion(
      question({
        question: 'Welchen Wert setzen?',
        options: [
          { label: 'A', description: 'Setzt expires_at neu' },
          { label: 'B', description: 'Setzt created_at neu' },
          { label: 'C', description: 'Setzt updated_at neu' },
        ],
      }),
    );
    expect(findingsFor(score, 'K7')).toHaveLength(3);
    expect(score.points).toBe(75); // 100 − 25 (K7 einmal), nicht 100 − 75
  });

  // DEFEKT: `warn` zieht Punkte ab. Dann bestraft der Bewerter Hinweise wie
  // Fehler, die Punktzahl verliert ihren Bezug zu den Gewichten, und ein
  // 121-Zeichen-Text steht so schlecht da wie ein fehlender Grund.
  it('zieht für einen Hinweis nichts ab', () => {
    const lang = 'a'.repeat(THRESHOLDS.K6.descriptionCharsWarn + 1);
    const score = scoreQuestion(
      question({
        question: 'Weitermachen?',
        options: [
          { label: 'Ja', description: lang },
          { label: 'Nein', description: 'Hier anhalten und den Rest dieser Runde auslassen.' },
        ],
      }),
    );
    expect(warns(score, 'K6')).toBe(true);
    expect(fails(score, 'K6')).toBe(false);
    expect(score.points).toBe(100);
    expect(score.grade).toBe('A');
  });

  // DEFEKT: K2 kann `fail` werden. Der längste Satz des ganzen Korpus hat 27
  // Wörter — jede Schwelle feuert auf 1-3 von 33 Fragen des Discovery-Zensus
  // vom 2026-08-22 (siehe Modulkopf von clarity.mjs) und verfehlt die
  // schlechteste Frage vollständig. Als Kriterium wäre K2 ein Zufallsgenerator;
  // es soll sichtbar sein, nicht wirksam.
  it('lässt K2 nie über einen Hinweis hinauskommen', () => {
    const langerSatz = `Diese Frage ${'sehr '.repeat(THRESHOLDS.K2.sentenceWordsWarn)} lange formuliert`;
    const score = scoreQuestion(question({ question: langerSatz, options: NEUTRAL_OPTIONS }));
    expect(warns(score, 'K2')).toBe(true);
    expect(fails(score, 'K2')).toBe(false);
  });
});

describe('scoreBlocks', () => {
  // DEFEKT: questionIndex je BLOCK fortlaufend statt je Block zurückgesetzt.
  // Ein AuqScore zeigt dann nicht mehr auf seine Frage, und der Bericht nennt
  // dem Operator die falsche Stelle.
  it('zählt questionIndex innerhalb des Blocks, nicht über Blöcke hinweg', () => {
    const mk = (line) =>
      makeBlock({
        file: 'skills/a/SKILL.md',
        line,
        questions: [
          question({ question: 'Erste?', file: 'skills/a/SKILL.md', line, options: NEUTRAL_OPTIONS }),
          question({ question: 'Zweite?', file: 'skills/a/SKILL.md', line, options: NEUTRAL_OPTIONS }),
        ],
      });
    const scores = scoreBlocks([mk(10), mk(20)]);
    expect(scores.map((s) => s.questionIndex)).toEqual([0, 1, 0, 1]);
    expect(scores.map((s) => s.line)).toEqual([10, 10, 20, 20]);
  });
});
