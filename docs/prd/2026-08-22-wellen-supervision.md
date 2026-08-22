# Feature: Wellen-Supervision — der Koordinator sieht, was seine Agenten tun

**Date:** 2026-08-22
**Author:** Bernhard Götzendorfer + Claude (AI-gestützte Planung)
**Status:** Draft, Revision 2 — Optionen NICHT abgestimmt
**Appetite:** 1w `[ANNAHME]`
**Parent Project:** session-orchestrator

> **Revision 2** nach unabhängiger Prüfung. Zwölf Beanstandungen, davon vier tragende Zahlen falsch. Alle korrigiert und im Fließtext markiert. Was sich dadurch **inhaltlich** geändert hat: der neue Ereignisname ist weg (das bestehende `stagnation_detected` wird zum Feuern gebracht), FA-3 ist von Position 3 auf Position 1 gerückt und ist jetzt ein Gate, es gibt eine Abbruchlinie und eine Erfolgsmessung, und der prosa-pinnende Test in FA-4 ist gestrichen.

---

## 0. Entscheidungen unter Vorbehalt

Vier Weichenstellungen wurden ohne Operator-Antwort gesetzt (AUQ lief 600 s ins Leere). Jede ist kippbar, ohne das Dokument neu zu schreiben:

| # | Frage | Gesetzt auf | Verworfene Alternativen |
|---|---|---|---|
| A1 | Welche Mechanik? | Transkript-Tail **+** SendMessage-Rückkanal | nur Tail · nur Rückkanal · nichts bauen, Observer abwarten |
| A2 | `run_in_background: false` kippen? | Nein — erst messen (FA-3, jetzt Tag 1) | sofort kippen · Prohibition unangetastet lassen |
| A3 | Verschlankung hier mitplanen? | Nein — eigenes Dokument | zusammenziehen · nur als Issues ablegen |
| A4 | Appetit | 1 Woche mit Abbruchlinie (§ 2.1) | 2 Wochen (plattformneutral) · 2-Tage-Spike |

---

## 1. Problem & Motivation

### What

Der Koordinator — der Agent, mit dem der Operator spricht — soll sehen, was seine parallel dispatchten Wellen-Agenten tun, **während** sie es tun, statt es erst aus ihren Abschlussberichten zu erfahren.

Gemessener Ist-Zustand: **jeder dispatch-nahe Schritt in `wave-loop.md` liegt vor dem Dispatch oder nach der Welle.** Der einzige Schritt zwischen dem ersten und dem letzten Agenten einer Welle ist `wave-loop.md:114-120` (`#### Dispatch Verification (fail-loud — #724)`) — und der zählt zurückgekehrte Tool-Results ab. Er beobachtet nichts.

> *Rev-2-Korrektur:* Revision 1 eröffnete mit „21 Checkpoints". Diese Aufzählung existiert im Baum nicht — `grep -c "Checkpoint [0-9]" skills/wave-executor/{wave-loop,SKILL}.md` → **0, 0**. Die Zahl war eine private Nummerierung, die als Repo-Tatsache auftrat. Ein Dokument, dessen § 1c von unbelegten Zahlen handelt, darf nicht mit einer aufmachen. Die qualitative Aussage hält und ist oben ohne Zahl formuliert.

`skills/wave-executor/circuit-breaker.md:168` sagt es selbst: *„These checks run during step 2 of `wave-loop.md`… after the wave completes — **not during the agent's execution**."*

### Why

**(a) Die Begründung der zentralen Prohibition ist auf der heutigen Plattform faktisch verkehrt herum.**

`skills/wave-executor/SKILL.md:482`:
> **NEVER** run `run_in_background: true` during waves — you lose coordination ability

Gepinnt an **sechs** Stellen: `wave-loop.md:272`, `:507`, `:786`, `:805`, `SKILL.md:482`, `circuit-breaker.md:106` (`grep -rn run_in_background skills/wave-executor/ | wc -l` → 6). *Rev-2-Korrektur: Revision 1 sagte „dreifach". Das ist nicht kosmetisch — es verdoppelt die Editierfläche eines A2-Umschwenks.*

In der Planungssession vom 2026-08-22 wurde das Gegenteil **gemessen**, indem exakt so gearbeitet wurde, wie die Regel es verbietet:

| Messung | Beleg |
|---|---|
| Nachricht an einen **laufenden** Subagenten wird zugestellt | Tool-Result wörtlich: `Message queued for delivery to <id> at its next tool round.` Der Agent antwortete mitten im Lauf mit einem Fortschrittsbericht, ~9 min vor seinem Abschlussbericht. |
| Subagent → Koordinator mitten im Lauf funktioniert | Tool-Result wörtlich: `Message queued for the main conversation's next turn.` |
| Subagent-Transkripte wachsen **inkrementell** | `~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl`: 1.115.925 → 1.124.197 → 1.139.860 Byte in 22 s bei laufendem Agenten. Flush **pro Turn**, nicht kontinuierlich — während eines langen Tool-Calls sieht die Datei eingefroren aus. |

Mit Hintergrund-Dispatch wurde Koordinationsfähigkeit also *gewonnen*, nicht verloren. Die Regel beschreibt eine Plattform, die es nicht mehr gibt.

**(b) Die Telemetrie, die diese Lücke füllen sollte, ist zu ~89 % leer — obwohl die Rohdaten daneben liegen.**

Flottenweit über 21 Repos mit `.orchestrator/`: **57.079** Zeilen `subagents.jsonl`. Der Diskriminator `subagent_transcript_found` trennt brauchbare von leeren Stop-Records:

| | brauchbar (`true`) | Phantom (`false`) | Legacy (kein Feld) |
|---|---:|---:|---:|
| Flotte gesamt | 3.306 | 33.755 | — |
| **Ertrag** | **8,9 %** | | |
| dieses Repo | 585 | 5.114 | 2.700 |

Ein Phantom-Record trägt `agent_type: null`, `duration_ms: null`, alle Token-Felder `null`. `total_cost_usd` ist **auch auf `found:true`-Records durchgängig `null`** — Kostenaufsicht existiert nirgends.

Gleichzeitig liegen unter `~/.claude/projects/` **3.797 vollständige Agent-Transkripte mit 2.777 MB**. Das Problem ist kein fehlendes Signal, sondern ein **fehlender Join** zwischen Agenten-Identität und ihrem Transkript.

**(c) Der eine Kanal, den das Repo für koordinator-gerichtet hält, ist es nicht — und ein Kommentar behauptet das Gegenteil.**

Aus dem Vertrag des ausgelieferten Binaries (v2.1.239): `SubagentStop`-`additionalContext` ist *„non-error feedback delivered to **the subagent**; **the subagent continues** so it can act on it."* Kein Hook-Ausgabekanal erreicht den Koordinator-Kontext.

`hooks/post-subagent-discovery-validator.mjs:601-602`, wörtlich verifiziert:
```
// v2.1.163+ additionalContext: feed the warning back to the coordinator turn
// so the finding is visible inline, not just in stderr + events.jsonl.
```
Falsch. Die PSA-006-Warnung erreicht damit **den Agenten, der die unbelegte Zahl aufgestellt hat** — statt den Koordinator, dessen dokumentierte Pflicht die Zurückweisung ist (`.claude/rules/parallel-sessions.md` § PSA-006). Der Mechanismus ist seit Einführung an den falschen Empfänger adressiert. Die Wege über `events.jsonl` und stderr funktionieren wie vorgesehen.

**(d) Der Scope-Guard urteilt sessionübergreifend — live belegt, aber transient.**

*Momentaufnahme, erfasst 2026-08-22 ~16:28 lokal; der Zustand war um 16:37 bereits ein anderer. Die dauerhafte Fassung dieses Befunds gehört in Issue #1082, nicht in dieses Dokument.*

Beim Schreiben von Revision 1 wurde der Schreibversuch abgelehnt:
```
Scope violation: 'docs/prd/2026-08-22-wellen-supervision.md' not in allowed paths []
— the wave's allowedPaths union is empty for role `Quality`
```
Ursache: `.claude/wave-scope.json` (untracked) gehörte einer **anderen** Session, die parallel im selben Working Copy ihre Welle fuhr — `{"wave":4,"role":"Quality","enforcement":"strict","allowedPaths":[]}`. Die Datei trägt **keine Session-ID**. Ein fremdes Wellen-Manifest sperrte damit die Schreibzugriffe einer Session, die gar keine Welle fährt.

Die Nachbar-Session hat den Zustand auf Meldung hin zurückgenommen und dabei den schärferen Teil beigetragen: ihre drei Panel-Agenten trugen ohnehin nur `Read, Grep, Glob, Bash` — die leere Liste sicherte nichts ab, was die Agentendefinition nicht schon absicherte. **Sie traf ausschließlich die unbeteiligte Session.** Formulierung des Befunds von dort übernommen: *dasselbe fehlende Feld, entgegengesetzter Schaden* — CLAUDE.md dokumentiert den fail-open-Fall (nur (b), (a) fehlt → signalfreies ALLOW), dies ist die Gegenrichtung.

*Rev-2-Korrektur: Revision 1 schrieb „`.orchestrator/filescopes/` ist leer". Das Verzeichnis **existiert nicht** — ein anderer Zustand mit anderer Bedeutung.*

### Who

Der **Koordinator** in `feature`- und `deep`-Sessions. Über die letzten 30 Sessions: 7 von 30, alle `deep`, jede mit ≥1 Welle (5, 6, 2, 1, 3, 5, 6 Wellen bei 33/31/9/0/9/26/30 Agenten). Housekeeping-Sessions dispatchen keine Wellen und sind **nicht** betroffen.

Sekundär der **Operator**, der heute nur per `tmux`-Pane und `.orchestrator/STEER.md` in eine laufende Welle hineinsehen bzw. -sprechen kann.

---

## 2. Solution & Scope

### In-Scope `[ANNAHME A1]` — in Ausführungsreihenfolge

- [ ] **FA-3 (Tag 1, Gate) — Das Dispatch-Experiment.** Gemessene Antwort auf: erreicht eine Eskalation den Koordinator, während eine blockierende Welle läuft, oder erst wenn der Batch zurückkommt? *Steht bewusst an erster Stelle: das Ergebnis ändert, wie FA-2 beschrieben und verkauft wird.*
- [ ] **FA-1 — Transkript-Tail.** Ein Out-of-Process-Beobachter folgt den live wachsenden `subagents/agent-*.jsonl` der aktuellen Welle und bringt das **bestehende** `stagnation_detected`-Ereignis zum Feuern. Drei Detektoren.
- [ ] **FA-2 — Agent→Koordinator-Rückkanal.** Die fünf **schreibenden** Agenten plus `session-reviewer` dürfen einen wellenblockierenden Hinderungsgrund per `SendMessage` an `main` melden. Setzt **#1051** um; dieser PRD ergänzt nur die Koordinator-Seite.
- [ ] **FA-4 — Fehladressierungs-Fix.** `post-subagent-discovery-validator.mjs`: den irreführenden Kommentar entfernen, den tatsächlichen Zustellweg dokumentieren, und einen Test auf den **Ausgabekanal** (nicht auf den Kommentartext) legen.
- [ ] **FA-5 — Observer-Beobachtungsposten.** ADR-Eintrag zum nativen `observer:`/`ObserverReport`-Fund samt seiner zwei Sperren.

### 2.1 Abbruchlinie (wenn die Woche knapp wird)

Fällt in dieser Reihenfolge weg: **FA-5** zuerst, dann **FA-4**. **FA-3, FA-1 und FA-2 fallen nicht** — ohne FA-3 ist FA-2 falsch beschrieben, ohne FA-1 gibt es keine Beobachtung, und FA-2 ist der billigste Teil.

Ergibt FA-3, dass die Eskalation erst mit dem Batch-Ende ankommt: **FA-2 wird als Haltbarkeits-Gewinn ausgeliefert, nicht als Supervision** — die Meldung überlebt dann einen maxTurns-Kill, mehr nicht. FA-1 bleibt unverändert der tragende Teil.

### Out-of-Scope

- **Natives `observer:`-Primitiv als Lieferbestandteil.** Zwei Gründe, jeder allein ausreichend: (1) **serverseitig** doppelt gegated (`tengu_observer_agents_enabled` plus `tengu_observer_subagent_fanout`) zusätzlich zur Umgebungsvariable — wir kontrollieren diese Flags nicht, und ein Negativversuch wäre **nicht interpretierbar**. (2) In der einzigen heute autorenseitig möglichen Form — `observer:` auf einem Worker — meldet der Beobachter an **den Worker**, nicht an den Koordinator; koordinator-gerichtet setzt voraus, dass die *Haupt*-Agentendefinition das Feld trägt, was einen Wechsel der Startart (`--agent <koordinator>`) bedeutet.
- **Ein LLM-Supervisor, der jeden Schritt liest.** Kein untersuchtes Framework fährt das als Default; LangGraph (`full_history`) und AutoGen (Voll-Broadcast) können es und liefern beide eine Fluchtluke, AutoGens Quelle mit der Begründung *„avoiding contamination of outer termination logic"*. Kosten hier: 6 Agenten × 15 Turns ≤ 90 zusätzliche Modellaufrufe je Welle; 18 × 25 ≤ 450.
- **Ein neuer Ereignisname.** *Rev-2-Änderung:* Revision 1 erfand `tail_finding`. `wave-loop.md:578` definiert bereits `stagnation_detected` mit `pattern`-Enum (`pagination-spiral|turn-key-repetition|error-echo`), `wave`, `agent`, `file`, `occurrences`, `error_class`. Ein zweiter Name für dieselbe Tatsache wäre Epic #1035 („Eine Tatsache, zwei Kopien") — genau die Klasse, mit der dieser PRD ein zweites Verzeichnis ablehnt.
- **Ein neues Artefakt-Verzeichnis unter `.orchestrator/`.**
- **Eine neue `.claude/rules/`-Datei** — § 5.
- **Reparatur der 89-%-Phantom-Telemetrie** — der Tailer umgeht das Problem; #1068 deckt die Lifecycle-Seite ab.
- **Verschlankung des Frameworks** — eigenes Dokument `[ANNAHME A3]`.
- **Plattformneutrale Umsetzung für Codex/Cursor/Pi.** *Rev-2-Änderung:* Revision 1 erklärte das für außerhalb und behielt trotzdem 25 Zeilen Codex-Telemetrie im Text — eine Ausklammerung, die ihren Platzbedarf behält (BV-001.1). Die Messung ist jetzt auf sechs Zeilen gekürzt (§ 4) und der Rest gehört in ein Issue gegen `platform-tools.md`, nicht hierher.

**Sollte drin sein, ist es nicht — bewusst:** der Session-Bindungs-Fix aus #1082. FA-1 verlangt Session-Identität (Edge-Case-AC), und § 1d zeigt den sessionblinden Guard. Beides in einem Schnitt wäre richtiger; es bleibt draußen, weil der Guard-Umbau `hooks/enforce-scope.mjs` und `scripts/lib/scope-gate.mjs` berührt — beide in der Änderungsmenge der Parallel-Session. **Als Vorbedingung notiert, nicht als Nebensache.**

---

## 3. Acceptance Criteria

### FA-3 — Dispatch-Experiment (Gate, Tag 1)

```gherkin
Given eine Wegwerf-Session
When im selben Assistant-Turn (a) ein Hintergrund-Agent dispatcht wird, der nach 90 s
     eine SendMessage an "main" mit Zeitstempel sendet und dann weitere 90 s arbeitet,
     und (b) ein blockierender Agent mit ~5 min Laufzeit
Then ist protokolliert, wann die PING-Nachricht im Koordinator-Kontext sichtbar wird
  And das Ergebnis trägt Datum und Claude-Code-Version
```

```gherkin
Given das Experiment ist gelaufen
When FA-2 dokumentiert wird
Then ist FA-2 entweder als Supervision oder als reiner Haltbarkeits-Gewinn beschrieben
  And die Wahl ist mit der Messung belegt, nicht mit einer Annahme
```

### FA-1 — Transkript-Tail

```gherkin
Given eine Welle hat N Agenten dispatcht
  And der Tailer kennt Session-UUID und die Agent-IDs dieser Welle
When ein Subagent in einem Bash-Aufruf `git commit`, `git add`, `git stash` oder `git push` ausführt
Then erscheint ein stagnation_detected-Record mit pattern "psa007-git-write"
     und source "tail" in .orchestrator/metrics/events.jsonl
```

```gherkin
Given ein Subagent scheitert dreimal hintereinander mit Edit auf demselben Pfad
When der dritte Fehlversuch im Transkript erscheint
Then erscheint ein stagnation_detected-Record mit pattern "error-echo"
  And er trägt dieselben Felder wie ein vom Koordinator geschriebener Record,
      unterschieden allein durch source: "tail" statt "coordinator"
```

```gherkin
Given ein Subagent schreibt "STATUS: partial" und wird danach von maxTurns beendet,
      bevor sein Abschlussbericht den Koordinator erreicht
When die Welle zurückkommt
Then liegt der Befund trotzdem in events.jsonl vor
```
> *Rev-2-Korrektur:* Revision 1 forderte, der Befund erscheine „bevor der Abschlussbericht den Koordinator erreicht". Das ist unerfüllbar, wenn der Agent `STATUS: partial` in seinem letzten Turn schreibt — selber Flush, selber Turn. Das AC prüft jetzt **Haltbarkeit**, nicht Reihenfolge.

```gherkin
Given der Tailer kann das Transkript-Verzeichnis nicht auflösen
When die Welle dispatcht
Then läuft die Welle unverändert weiter
  And der Tailer beendet sich mit einer stderr-Zeile
  And es wird KEIN Agent blockiert
```

### FA-2 — Rückkanal

```gherkin
Given ein code-implementer trifft auf einen wellenblockierenden Hinderungsgrund
When er das erkennt
Then sendet er EINE SendMessage an "main" mit Agent-ID, Datei-Scope und Hinderungsgrund
  And er arbeitet danach in seinem Scope weiter oder beendet mit STATUS: blocked
  And er wartet NICHT auf eine Antwort
```

```gherkin
Given eine Agenten-Eskalation ist im Koordinator-Kontext eingetroffen
When der Koordinator seinen nächsten Turn beginnt
Then behandelt er sie nach receiving-review.md RCR-003 als Behauptung, nicht als Tatsache
  And er verifiziert sie gegen den Baum, bevor er den Wellenplan ändert
  And er hält sie in der Wellen-Erzählung mit Provenienz fest
```

```gherkin
Given ein Analyse- oder Judge-Agent, der nicht auf der Liste steht
When seine Definition validiert wird
Then trägt er kein SendMessage in tools
```

### FA-4 — Fehladressierung

```gherkin
Given post-subagent-discovery-validator.mjs feuert auf SubagentStop
When ein Agent eine unbelegte Verteilungsbehauptung aufgestellt hat
Then landet der Befund in events.jsonl und auf stderr
  And ein Test prüft den AUSGABEKANAL des Hooks, nicht den Text eines Kommentars
```
> *Rev-2-Korrektur:* Revision 1 forderte einen Test, der pinnt, dass ein Kommentar-Anspruch nicht wiederkehrt. Das verstößt gegen `test-value.md` TV-001 (kein benennbarer Bug) und TV-002c (Prosa-Pinning ist ohne Zeremonie löschbar). Der Test prüft jetzt das Verhalten.

### Erfolgsmessung (neu in Rev 2)

```gherkin
Given FA-1 ist ausgeliefert
When die ersten fünf Wellen danach gelaufen sind
Then hat mindestens einer der drei Detektoren mindestens einmal gefeuert
  And falls keiner gefeuert hat, ist das ein Befund, kein Erfolg —
      dann wiederholt FA-1 das Schicksal von #980 (ein Monitor, der ausgeliefert wird und nie feuert)
```

### Edge Cases

```gherkin
Given zwei Sessions arbeiten im selben Working Copy
When beide einen Tailer starten
Then schreibt jeder nur Records seiner EIGENEN Session-UUID
  And kein Tailer liest die Subagent-Transkripte der Fremdsession
```

```gherkin
Given der Monitor überschreitet die Ratenbegrenzung und wird automatisch gestoppt
When das passiert
Then ist es an einem Record in events.jsonl erkennbar
  And Schweigen des Tailers wird NICHT als "keine Befunde" gelesen
```

---

## 3.A Acceptance Criteria (EARS)

### FA-1

**Ubiquitous:** Der Tailer soll ausschließlich lesen und nur nach `.orchestrator/metrics/events.jsonl` schreiben.

**State-driven:** Solange eine Welle läuft, soll der Tailer die Transkripte der dieser Welle zugeordneten Agenten per Byte-Offset verfolgen.

**Event-driven:** Wenn ein Detektor anschlägt, soll genau ein `stagnation_detected`-Record mit `source: "tail"` entstehen.

**Optional feature:** Wo der Tailer nicht verfügbar ist, soll die Wellenausführung byte-identisch zum heutigen Verhalten ablaufen.

**Unwanted behaviour:** Wenn der Tailer abstürzt oder das Transkript-Verzeichnis fehlt, soll er sich beenden, ohne einen Agenten oder die Welle zu blockieren.

### FA-2

**Ubiquitous:** Ein Subagent soll niemals eine Antwort auf seine Eskalation abwarten.

**Event-driven:** Wenn ein schreibender Agent einen wellenblockierenden Hinderungsgrund erkennt, soll er genau eine Nachricht an `main` senden.

**Optional feature:** Wo `SendMessage` nicht verfügbar ist (Bedrock/Vertex/Foundry, Telemetrie deaktiviert, natives Windows), soll der Agent den Hinderungsgrund im Abschlussbericht melden.

**Unwanted behaviour:** Wenn eine Eskalation eine Handlung verlangt, die in der Koordinator-Session gesperrt ist, soll der Koordinator sie ablehnen und dem Operator vorlegen (CSM-003).

### Übergreifend

**Ubiquitous:** Jede Aussage über Plattformverhalten soll Datum und Claude-Code-Version tragen.

---

## 4. Technical Notes

### Affected Files

| Datei | Änderung | Neu? |
|---|---|---|
| `scripts/lib/wave-transcript-tail.mjs` | Tailer, drei Detektoren, Byte-Offset, fail-open | **neu** |
| `monitors/monitors.json` | dritter Eintrag (heute: `ecosystem-health`, `convergence-monitor`) | ändern |
| `skills/wave-executor/wave-loop.md` | Schritt 2.0-bis; `pattern`-Enum um zwei Werte + `source`-Feld erweitern; Behandlung eintreffender Eskalationen | ändern |
| `agents/{code-implementer,db-specialist,ui-developer,test-writer,docs-writer}.md` | `SendMessage` in `tools` (**5 schreibende Agenten**) | ändern (5) |
| `agents/session-reviewer.md` | `SendMessage` in `tools` — read-only Agent, siehe Hinweis | ändern |
| `agents/AGENTS.md` | Autorenkonvention: wer eskalieren darf | ändern |
| `hooks/post-subagent-discovery-validator.mjs` | Kommentar korrigieren | ändern |
| `docs/adr/0010-native-autonomy-commands.md` | Observer-Posten + FA-3-Ergebnis | ändern |
| `tests/lib/wave-transcript-tail.test.mjs` | drei Detektoren gegen Fixture-JSONL | **neu** |

*Rev-2-Korrektur:* Revision 1 schrieb „die sechs schreibenden Agenten". `agents/session-reviewer.md:6` trägt `tools: Read, Grep, Glob, Bash` — **read-only**. Es sind fünf schreibende plus ein lesender. Die Tier-Schlussfolgerung ändert sich nicht (`SendMessage` steht in `READ_ONLY_TOOLS`, `tier-inference.mjs:33-41`), der Satz war trotzdem falsch — in einem Dokument, das über Genauigkeit argumentiert.

### Architecture

**Warum ein Out-of-Process-Monitor und kein Hook.** Hooks können den Koordinator strukturell nicht erreichen (§ 1c). Der einzige native Weg, aus einem Dateistrom koordinator-sichtbare Ereignisse zu machen, ist das `Monitor`-Werkzeug — jede stdout-Zeile wird eine Benachrichtigung. `monitors/monitors.json` trägt bereits zwei Einträge; `check-plugin-monitors.mjs:132` prüft `monitors.length >= 2`, ein dritter besteht.

**Ehrlicher Vorbehalt zum Vorbild:** Revision 1 schrieb, die Monitor-Form sei „im Baum erprobt". `convergence-monitor` ist die Form, aber **#980 sagt, dass seine drei Signale auf echten Daten nie feuern.** Das Vorbild belegt die Verdrahtung, nicht die Wirksamkeit. Genau deshalb hat Rev 2 eine Erfolgsmessung (§ 3).

**Lifecycle des Tailers** (in Rev 1 offen, vom Prüfer beanstandet):
`when: "on-skill-invoke:wave-executor"` feuert **einmal je Skill-Aufruf, nicht je Welle**. Der Tailer muss daher selbst herausfinden, wen er beobachtet:
- **Start:** bei Skill-Invocation, persistent für die Session.
- **Session-UUID:** aus dem Pfad des eigenen Prozess-CWD bzw. der Hook-Umgebung; ohne sie beendet er sich (fail-open).
- **Agenten-Menge:** er beobachtet das Verzeichnis `<session>/subagents/` und nimmt **neu erscheinende** `agent-*.jsonl` auf, statt eine Liste übergeben zu bekommen — damit braucht er keine Wellen-Grenze zu kennen.
- **Byte-Offset:** je Datei gemerkt, damit ein Neustart nicht doppelt meldet.
- **Ende:** mit der Session (`persistent: true`), oder per `TaskStop`.

**Warum genau drei Detektoren.** Jeder ist ein reiner Textabgleich ohne Modellaufruf:

1. **`psa007-git-write`** — ein Subagent schreibt in den geteilten Index. PSA-007 verbietet das mit Flotten-Beleg (2 Repos, conf ≥ 0,9: `index.lock`-Kollisionen, Stash-Operationen die Geschwisterarbeit still verwarfen). Heute erfährt der Koordinator davon nur, wenn der Agent es selbst erwähnt.
2. **`error-echo`** — bestehender Enum-Wert. `circuit-breaker.md:123` über die drei Muster: *„All three patterns are LLM heuristics, not executable code."* Und sie feuern nachweislich nicht: `stagnation_detected` hat **0 Records in 27.530 Ereignissen**.
3. **`status-partial`** — der Agent weiß bereits, dass er scheitert; heute geht das bei einem maxTurns-Kill verloren.

**Warum kein Parser, keine Zustandsmaschine.** Drei reguläre Ausdrücke sind ~90 % des Werts; alles darüber ist `build-value.md` § BV-001.

**Die Turn-Granularität ist eine harte Eigenschaft.** Transkripte werden pro Turn geflusht. Ein Agent in einem 3-Minuten-Tool-Call ist für diese 3 Minuten unsichtbar. Der Tailer darf Schweigen nie als „läuft normal" berichten — `loop-and-monitor.md` § LM-002 (*„silence is not success"*).

### Data Model Changes

**Kein neuer Ereignisname.** Das bestehende Schema (`wave-loop.md:578`) wird um zwei Enum-Werte und ein Feld erweitert:

```json
{"event":"stagnation_detected","timestamp":"<ISO>","session":"<id>","wave":N,
 "agent":"<subagent_type>",
 "pattern":"pagination-spiral|turn-key-repetition|error-echo|psa007-git-write|status-partial",
 "source":"coordinator|tail",
 "error_class":"<nur bei error-echo>","file":"<rel path|null>","occurrences":N}
```

`source` ist additiv; bestehende Konsumenten, die es nicht kennen, verhalten sich unverändert. Nebeneffekt mit eigenem Wert: ein Ereignis, das seit seiner Definition **null** Records hat, bekommt einen Produzenten — und wenn es danach immer noch schweigt, ist das eine Aussage über das Repo statt über den Emitter.

### API Changes

Keine. `SendMessage` steht bereits in `READ_ONLY_TOOLS` (`scripts/lib/validate/tier-inference.mjs:33-41`, mit `#1049`-Verweis in Zeile 31) — die Agenten behalten ihre Sandbox-Stufe.

### Plattform-Messung (gekürzt, Rev 2)

`skills/_shared/platform-tools.md` beschreibt Codex-Subagenten als *„when available; otherwise execute sequentially"*. Gemessen 2026-08-22 auf diesem Host: `codex-cli 0.141.0`, `multi_agent stable true`; aus `~/.codex/sessions` im Namespace `collaboration`: `spawn_agent` 1.744, `send_message` 2.224, `followup_task` 654, `interrupt_agent` 109, `wait_agent` 6.033, `list_agents` 833, `close_agent` 781. Der Operator fährt Mid-Run-Steuerung auf Codex produktiv; die Abstraktionsschicht des Repos ist veraltet.

**Das gehört in ein eigenes Issue gegen `platform-tools.md`, nicht in diesen Schnitt.** Hier steht es nur, weil die Messung sonst verfällt.

---

## 5. Risks & Dependencies

| Risiko | Impact | Mitigation | Triage |
|---|---|---|---|
| **A2 ungemessen: die Eskalation kommt erst mit dem Batch-Ende an.** Konfidenz der Blockade-These: 0,85 | hoch | FA-3 ist jetzt Tag 1 und Gate; die Abbruchlinie (§ 2.1) beschreibt beide Ausgänge | Experiment |
| **FA-1 wird ausgeliefert und feuert nie** — das Schicksal von #980 | hoch | Erfolgsmessung in § 3: mindestens ein Detektor in den ersten fünf Wellen. Kein Feuer = Befund, nicht Erfolg | Implement |
| **Der Always-on-Regelkorpus ist knapp.** Live gemessen: `totalDirectives 465 / 480`, `totalBytes 113.975 / 114.000`, `overBudget false`. Luft: **15 Direktiven / 25 Byte** (Stand 2026-08-22 nach dem Commit der Parallel-Session; wandernd, weil `/reconcile` maschinell erzeugte Regeln in dieses Verzeichnis schreibt) | mittel | Dieser PRD schlägt **keine** neue `.claude/rules/`-Datei vor. Verhaltensregeln gehen in `agents/*.md` und `wave-loop.md` | Implement |
| **Der Scope-Guard sperrt sessionübergreifend** (§ 1d) | hoch | #1082; als Vorbedingung notiert. Vor Umsetzungsbeginn `.claude/wave-scope.json` prüfen | Defer |
| Der Monitor überschwemmt den Koordinator-Kontext und wird gestoppt | mittel | Drei Detektoren, keine Rohzeilen; ein Stopp muss als Ereignis sichtbar sein | Implement |
| Ein Agent nutzt den Rückkanal für Fragen, die er selbst beantworten könnte | mittel | Eskalationsregel definiert „wellenblockierend" eng, mit Gegenbeispielen; #1051 hat die Allowlist und die Nicht-Liste | Implement |
| Der Observer wird trotz § 2 „ausprobiert", das Ergebnis ist negativ und wird als Widerlegung gelesen | mittel | FA-5 hält fest: Env-Flag genügt nicht, Gates sind serverseitig, **ein Negativergebnis ist nicht interpretierbar** | Reject |
| Ein Detektor schlägt auf legitimes Verhalten an und wird abgeschaltet | mittel | Alle drei prüfen Verhalten, das bestehende Regeln bereits verbieten oder als Scheitern definieren. Bei Falsch-Positiven den Detektor entfernen, nicht die Schwelle heben (`development.md` § Guard & Threshold Design) | Implement |
| Der 1w-Appetit reicht nicht | mittel | Ehrliche Schätzung: FA-3 0,5 d · FA-1 2–3 d · FA-2 1–1,5 d · FA-4 0,5 d · FA-5 0,25 d = **4,5–5,5 d ohne Puffer**. Deshalb die Abbruchlinie in § 2.1 | Implement |
| `subagents.jsonl` bleibt zu 89 % Phantom | niedrig | Nicht in diesem Schnitt; #1068 | Defer |

### Dependencies

- **#1051** — FA-2 **ist** dessen Umsetzung; nicht neu planen. Ergänzt wird die Koordinator-Seite und der Vorbehalt aus FA-3.
- **#1049** — Blocker von #1051, **geschlossen** und im Baum (`tier-inference.mjs`). FA-2 entsperrt.
- **#1109** — Observer-Fund, von der Parallel-Session angelegt, mit gegenseitiger Nachmessung. FA-5 ist der ADR-Niederschlag; **keinen zweiten Fundbericht schreiben**.
- **#1082** — Session-Bindung des Scope-Guards. § 1d liefert den Live-Beleg; die dauerhafte Fassung gehört dorthin. **Vorbedingung, nicht Nebensache.**
- **#980** — convergence-monitor feuert nicht. Liefert das Vorbild für die Verdrahtung UND die Warnung; die Erfolgsmessung in § 3 existiert wegen #980.
- **#1048** — Epic Cross-Session Messaging.
- **#1092** — FILE-SCOPE Ende-zu-Ende beobachtbar. Gleiche Fehlerklasse, andere Mechanik. Nicht zusammenlegen.
- **#966** — `wave_number` ins Gate-Ereignis. Der erweiterte `stagnation_detected`-Record trägt `wave` bereits.
- **#1068** — `subagents.jsonl`-Lifecycle.
- **Parallel-Session `session-orchestrator-fa`** — hielt am 2026-08-22 **73** uncommitted Pfade (`git status --porcelain | wc -l`) in `scripts/`, `hooks/`, `skills/`, `.claude/rules/`, `tests/`. `docs/prd/` ist bei 0 Treffern. **Vor Umsetzungsbeginn neu abstimmen** — die Pfade aus § 4 überschneiden sich.

### Rev-2-Änderungsprotokoll

| # | Beanstandung | Erledigung |
|---|---|---|
| 1 | „21 Checkpoints" nicht herleitbar (0 Fundstellen) | Zahl gestrichen, qualitativ mit echtem Anker formuliert |
| 2 | Regelbudget-Arithmetik selbstwidersprüchlich | Auf die Metrik des Tests umgestellt: 465/480 Direktiven, 113.975/114.000 Byte, `overBudget: false` |
| 3 | `tail_finding` dupliziert `stagnation_detected` | Neuer Ereignisname gestrichen; bestehendes Ereignis um zwei Enum-Werte + `source` erweitert |
| 4 | `status-partial`-AC verlangt unmögliche Reihenfolge | Auf Haltbarkeit umgestellt |
| 5 | FA-3 ist ein Gate, stand aber an dritter Stelle; keine Abbruchlinie | FA-3 auf Tag 1; § 2.1 Abbruchlinie ergänzt |
| 6 | FA-4 pinnt Kommentar-Prosa (TV-001/TV-002c) | Test prüft jetzt den Ausgabekanal |
| 7 | Keine Erfolgsmessung | § 3 Erfolgsmessung ergänzt (mit #980 als Begründung) |
| 8 | „sechs schreibende Agenten" falsch | Auf fünf schreibende + `session-reviewer` (read-only) korrigiert |
| 9 | „dreifach gepinnt" falsch | Auf sechs Fundstellen korrigiert, mit Hinweis auf die Editierfläche |
| 10 | Tailer-Lifecycle unspezifiziert | § 4 Lifecycle-Absatz ergänzt (Start, Session-UUID, Agenten-Entdeckung, Offset, Ende) |
| 11 | § 1d transient, „filescopes leer" falsch | Als Momentaufnahme mit Uhrzeit markiert; „existiert nicht" korrigiert; Dauerfassung an #1082 verwiesen |
| 12 | Veraltete Nenner | 27.311 → 27.530 Ereignisse; 63 → 73 dirty paths; „40 Ereignisnamen" gestrichen (39, und für die Aussage entbehrlich) |
