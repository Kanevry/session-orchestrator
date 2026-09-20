# Feature: Prozessgruppen-Kill und Waisen-Wächter

**Date:** 2026-09-20
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Draft
**Epic:** #1425
**Appetite:** Stufe 1 zuerst, Stufe 2 als Option danach (Reihenfolge zählt, nicht Kalenderzeit)
**Parent Project:** session-orchestrator

## 1. Problem & Motivation

### What

Zwei zusammengehörige Bausteine gegen dieselbe Fehlerklasse:

- **Teil A — Prävention.** Quality-Gate-Kommandos so starten und beenden, dass ihre
  Enkelprozesse mitsterben (eigene Prozessgruppe, Gruppen-Signal, SIGTERM→SIGKILL-Leiter),
  und den bisher timeoutlosen zweiten Gate-Pfad überhaupt erst deckeln.
- **Teil B — Netz.** Ein Wächter, der während laufender Sessions verwaiste Nachkommen
  erkennt und beseitigt, die trotz Teil A entstehen — etwa weil eine Session abstürzt,
  der Harness SIGKILL schickt oder das Leck aus einem fremden Repo stammt.

### Why

Am **2026-09-20** stand der Arbeits-Mac (M4 Pro, 24 GB) still. macOS meldete „Your system
has run out of application memory", Ghostty stand mit **36,69 GB** im Force-Quit-Dialog.
Gemessen zum Zeitpunkt des Eingriffs:

| Kennzahl | vor dem Eingriff | nach dem Eingriff |
|---|---|---|
| Speicher frei, systemweit (`memory_pressure -Q`) | 13 % | 71 % |
| Swap belegt (`sysctl vm.swapusage`) | 9 736 MB von 14 336 MB | 3 980 MB |
| Load average 1 min | 67,4 | 22,5 |

Ursache waren **vier verwaiste `tsgo --noEmit`-Prozesse** aus einem anderen Repo
desselben Hosts, zwei davon mit **PPID = 1**, mit **86–588 % CPU** und bis zu
**8,0 GB RSS** je Prozess. Alle vier waren Kinder von Quality-Gate-Läufen.

**Der Vorfall hat sich während der Planung dieser PRD reproduziert:** um 10:19 lief erneut
ein verwaister `tsgo --noEmit` mit **97,2 % CPU und 3,46 GB**, gestartet *nach* dem
Aufräumen um 10:03. Die Quelle produziert weiter.

**Warum der bestehende Detektor nichts gesehen hat.** `countZombieProcesses()`
(`scripts/lib/resource-probe/parsers.mjs:44-72`) hätte den Vorfall mit **0** gezählt —
fünf unabhängige Gründe:

1. Die Messung ruft `ps -A -o pid,comm,etime,%cpu` (`probe-platform.mjs:167`) — **kein
   `ppid`-Feld**. Verwaisung ist strukturell nicht beobachtbar.
2. **Kein `rss`-Feld.** Die 8,0 GB waren unsichtbar.
3. Der Namensfilter akzeptiert nur `claude` und `node`. `tsgo` ist ein natives Binary.
4. `if (cpu > maxCpuPct) continue` mit `maxCpuPct = 1.0` — der Detektor definiert einen
   Zombie als **idle**. Unsere Runaways verbrannten CPU; sie sind das genaue Gegenteil.
5. Selbst bei Treffer bleibt es folgenlos: `evaluate.mjs:394` meldet `info:` … *„not counted
   as a capacity signal"*, im Einklang mit `.claude/rules/host-resources.md` HR-104,
   wo Zombies im Fliesstext ausdrücklich „report, never count" tragen.

Dazu strukturell: `evaluateWaveResourceGate()` läuft **nur vor dem Dispatch** einer Welle
(`skills/wave-executor/references/wave-loop-dispatch.md:67`). Das Leck wuchs *während* einer
laufenden Welle. Es gibt im Repo keinen sitzungsbegleitenden Puls: kein launchd, kein cron, keinen Daemon.
Das einzige `setInterval` (`scripts/lib/session-start-probes.mjs:408`) ist ein `unref()`-ter
Einmal-Messtimer beim Session-Start, kein Wellen-Wächter.

**Die eigentliche Ursache ist ein Spawn-Fehler, kein Messfehler.**
`scripts/lib/quality-gate.mjs:293-308` startet Gate-Kommandos als
`spawnSync(cmd, { shell: true, timeout: 900000 })` — ohne `detached`, ohne `killSignal`,
ohne Prozessgruppen-Semantik. Bei Timeout schickt Node SIGTERM **nur an die Shell**; die
Enkel (`tsgo`, Vitest-Worker) werden auf PPID = 1 reparentet und laufen weiter. Nodes eigene
Dokumentation beschreibt genau diesen Fall mit Codebeispiel:
*„On Linux, child processes of child processes will not be terminated when attempting to kill
their parent. This is likely to happen when running a new process in a shell or with the use
of the shell option of ChildProcess"* (nodejs.org/api/child_process.html, v26.9.0,
abgerufen 2026-09-20).

Der zweite Gate-Pfad ist schlechter dran: `scripts/run-quality-gate.mjs:388` (`spawnSync`)
und `scripts/lib/gates/gate-helpers.mjs:69` (`execSync`) haben **überhaupt keinen Timeout**.
Eine repo-weite Suche nach `detached` / `kill(-` / `setsid` / `tree-kill` / `execa` über
`scripts/` und `hooks/` liefert genau **einen** Treffer mit echter Prozessgruppen-Bedeutung
(`hooks/skill-invocation-telemetry.mjs:164`, `detached: true` für einen Fire-and-Forget-
Telemetrie-Flush) — und **keinen einzigen** mit Gruppen-Signal- oder Kill-Eskalations-Semantik.

### Who

Der Orchestrator selbst und jede Session auf dem Host — eigene wie fremde. Der Schaden ist
nicht repo-lokal: die Lecks stammten aus einem anderen Repo, lahmgelegt wurde der gesamte
Mac samt aller vier parallelen Sessions. Auf dem Zielbild (Venture Studio, bis zu 7 Macs,
40 Accounts) multipliziert sich das je Host.

## 2. Solution & Scope

### In-Scope — Stufe 1 (zuerst bauen)

- [ ] **A1** `quality-gate.mjs` von `spawnSync` auf asynchrones `spawn` mit
      `detached: true` und `stdio: 'pipe'` umstellen; Timeout beendet die **Prozessgruppe**
      (`process.kill(-pid, …)`), nicht nur die Shell.
- [ ] **A2** SIGTERM→Gnadenfrist→SIGKILL-Leiter, nach dem bestehenden Vorbild
      `dispatch-common.mjs:99-164` (`DEFAULT_KILL_GRACE_MS`), angewandt auf die Gruppe.
- [ ] **A3** Timeout für den bisher ungedeckelten Pfad B (`run-quality-gate.mjs:388`,
      `gate-helpers.mjs:69`), mit derselben Gruppen-Semantik.
- [ ] **A4** **Abstammungsregister:** jeder selbst gestartete Gate-Prozess wird mit
      `pid`, `pgid`, Startzeit und Kommando-Signatur festgehalten. Das ist die
      Identitätsgrundlage für Teil B.
- [ ] **B1** Reine Entscheidungsfunktion `decideReapCandidates(psSnapshot, ledger, now)` —
      kein I/O, kein `kill`, vollständig aus `ps`-Textfixtures testbar.
- [ ] **B2** Erkennung über `ps -A -o pid,ppid,rss,etime,%cpu,comm,args` (die drei heute
      fehlenden Spalten `ppid`, `rss`, `args` kommen dazu). Stufe 1 erkennt nur
      **PPID = 1**; die zwei Runaways vom 2026-09-20, die noch einen lebenden Elternteil
      hatten, deckt **Teil A an der Quelle** ab, nicht der Reaper. Waisen ohne PPID = 1
      zuverlässig zu erkennen ist ausdrücklich Stufe 2 (C4).
- [ ] **B3** **Identitätsprüfung unmittelbar vor jedem Signal** (Startzeit + Kommandoname)
      gegen PID-Recycling. Schlägt sie fehl, wird kein Signal gesendet.
- [ ] **B4** Andocken an `PostToolBatch` (der einzige Hook mit belegt hoher Frequenz
      *während* laufender Wellen) und `SubagentStop`. Non-blocking, eigener gezielter
      `ps`-Aufruf statt des vollen `probe()` mit bis zu fünf Subprozessen, und gedrosselt
      auf `reaper.min-scan-interval-seconds`, damit ein Hook-Sturm nicht jeden Tool-Call verteuert.
- [ ] **B5** JSONL-Audit je Kill: Auslöser, Schwellenwert, Ist-Wert, Einheit, PID,
      Kommando, Ergebnis.
- [ ] **B6** **Wirkung zurücklesen mit Wartezeit** — Exit-Code und „Signal gesendet" sind
      kein Beleg. (Beim Aufräumen am 2026-09-20 meldete die eigene Prüfroutine
      fälschlich „lebt noch", weil sie ohne Wartezeit direkt nach `kill -9` maß.)

### In-Scope — Stufe 2 (erst nach Auswertung von Stufe 1)

- [ ] **C1** Kalibrierungs-Datensatz und Pre-Registration nach
      `projects-baseline/docs/EVALUATION-MODELS.md` §5.
- [ ] **C2** Notfallmodus mit Hysterese (sofort hoch, Cooldown runter).
- [ ] **C3** `maxRuntime`-Tabelle je Prozesstyp.
- [ ] **C4** Orphan-Confidence über PPID-Historie (`reparented` vs. `seit jeher PPID 1`).

### Out-of-Scope

- **Jev als Kalibrierungs-Instanz** — gemessen ungeeignet: `EVALUATION-MODELS.md` §2 nennt
  „Regelwerke mit Arithmetik und Reihenfolge-Logik" ausdrücklich als Nicht-Passung, belegt
  mit 83,5 % gegen 99,5 %. Jev ist ein Klassifikator über einen fertigen State, kein
  Simulator und kein Parameter-Sweep. Die **Methodik** aus §5 wird übernommen, das Modell nicht.
- **Eigener Daemon / launchd-Agent** — ein neues Betriebsartefakt auf jedem Host mit eigenem
  Lebenszyklus; und ein Daemon, der selbst hängt, fällt niemandem auf.
- **Töten von Prozessen fremder, lebender Sessions ohne Rückfrage** — am 2026-09-20 gehörten
  zwei der vier Runaways einer laufenden Peer-Session; sie wurden erst nach ausdrücklicher
  Freigabe beendet.
- **Auto-Kill nicht-read-only-Kommandos** — Dev-Server und MCP-Server bleiben unangetastet,
  auch als Waisen. (Zwei solche Waisen aus `browser-kit` liefen zum Planungszeitpunkt seit
  1 h 47 min mit zusammen ~12 MB: gemeldet, nicht getötet.)
- **Rückportierung nach navigator** — dessen CLAUDE.md legt die Reihenfolge S1–S6 fest.

## 3. Acceptance Criteria

### Feature Area 1 — Prozessgruppen-Kill im Quality-Gate

```gherkin
Given ein Gate-Kommando, das über eine Shell einen Enkelprozess startet
  And der Enkel ignoriert SIGTERM
When das Gate-Timeout abläuft
Then erhält die gesamte Prozessgruppe SIGTERM
  And nach Ablauf der Gnadenfrist erhält sie SIGKILL
  And kein Nachkomme des Kommandos existiert nach Rückkehr der Funktion noch
  And kein Nachkomme wurde auf PPID 1 reparentet
```

```gherkin
Given der Gate-Pfad über run-quality-gate.mjs und gate-helpers.mjs
When ein Unterkommando länger läuft als der konfigurierte Deckel
Then wird es samt Prozessgruppe beendet
  And der Gate-Lauf meldet den Timeout als solchen statt unbegrenzt zu blockieren
```

### Feature Area 2 — Waisen erkennen

```gherkin
Given ein ps-Snapshot mit einem Prozess: PPID 1, Alter über Mindestalter,
      Kommando-Signatur im Abstammungsregister, read-only-Kommando
When decideReapCandidates aufgerufen wird
Then enthält das Ergebnis genau diesen Prozess mit Begründung und Ist-Werten
  And die Funktion sendet selbst kein Signal
```

```gherkin
Given ein Prozess mit PPID 1, der ein System-Daemon ist und nicht im Register steht
When decideReapCandidates aufgerufen wird
Then ist er NICHT unter den Kandidaten
  And der Grund der Ablehnung ist im Ergebnis nachvollziehbar
```

### Feature Area 3 — Sicher töten

```gherkin
Given ein Kill-Kandidat, dessen PID zwischen Erkennung und Signal recycelt wurde
When der Reaper das Signal senden will
Then erkennt die Identitätsprüfung die abweichende Startzeit
  And es wird KEIN Signal gesendet
  And der Vorfall wird als abgebrochener Kill protokolliert
```

```gherkin
Given ein Kandidat, der einer fremden lebenden Session zugeordnet ist
When der Reaper ihn bewertet
Then wird er gemeldet, aber nicht automatisch getötet
```

### Feature Area 4 — Wächter im laufenden Betrieb

```gherkin
Given eine laufende Welle
When ein PostToolBatch-Hook feuert
  And seit dem letzten Scan ist mindestens `reaper.min-scan-interval-seconds` vergangen
Then läuft der Waisen-Scan non-blocking
  And er verzögert den Hook um höchstens `reaper.max-hook-latency-ms`
  And bei jedem Fehler degradiert er lautlos, ohne den Hook scheitern zu lassen
```

```gherkin
Given seit dem letzten Waisen-Scan ist weniger als `reaper.min-scan-interval-seconds` vergangen
When ein weiterer PostToolBatch-Hook feuert
Then wird der Scan übersprungen
  And der Hook kehrt ohne ps-Aufruf zurück
```

### Edge Case / Fehlerbehandlung

```gherkin
Given ein Signal wurde an einen Kandidaten gesendet
When der Reaper die Wirkung prüft
Then wartet er, bevor er misst
  And er belegt den Erfolg am Zustand, nicht am Exit-Code
  And ein Prozess, der SIGKILL überlebt, wird als solcher gemeldet statt als Erfolg gebucht
```

```gherkin
Given die Fehlalarmrate des Waisen-Signals über eine Messperiode
When sie über 10 Prozent der Läufe liegt
Then gilt das Instrument nach HR-101 als defekt
  And es wird neu vermessen statt die Schwelle nachzuziehen
```

## 3.A Acceptance Criteria (EARS)

### Feature Area 1 — Prozessgruppen-Kill

**Ubiquitous:** Das Gate soll jedes Kommando als Leiter einer eigenen Prozessgruppe starten.
**Event-driven:** Wenn das Timeout abläuft, soll das Gate der Prozessgruppe SIGTERM senden.
**State-driven:** Solange nach der Gnadenfrist noch ein Gruppenmitglied lebt, soll das Gate SIGKILL senden.
**If-then:** Wenn ein Nachkomme sich per setsid aus der Gruppe löst, dann soll das Gate ihn als nicht beendbar melden statt Erfolg zu buchen.

### Feature Area 2/3 — Erkennung und Kill

**Ubiquitous:** Der Reaper soll die Kill-Entscheidung als reine Funktion ohne I/O treffen.
**Event-driven:** Wenn ein Kandidat bestimmt ist, soll der Reaper vor dem Signal Startzeit und Kommandoname erneut prüfen.
**If-then:** Wenn die Identitätsprüfung fehlschlägt, dann soll der Reaper kein Signal senden und den Abbruch protokollieren.
**Where:** Wo ein Kandidat einer fremden lebenden Session gehört, soll der Reaper melden statt zu töten.

### Feature Area 4 — Betrieb

**State-driven:** Während eine Welle läuft, soll der Wächter bei PostToolBatch prüfen, sofern
der Mindestabstand seit dem letzten Scan verstrichen ist.
**If-then:** Wenn ein Scan fehlschlägt, dann soll er lautlos degradieren und den Hook nicht scheitern lassen.

## 4. Technical Notes

### Affected Files

- `scripts/lib/quality-gate.mjs` — `runGate()` von `spawnSync` auf asynchrones `spawn`
  umstellen; `detached: true`, `stdio: 'pipe'`, Gruppen-Signal. Zwingend asynchron, weil
  `spawnSync` den Event Loop blockiert und `child.pid` erst nach Prozessende liefert.
- `scripts/run-quality-gate.mjs` — Timeout ergänzen.
- `scripts/lib/gates/gate-helpers.mjs` — `execSync` → deckelbarer Aufruf.
- `scripts/lib/orphan-reaper.mjs` — **neu**, nach dem `resolveDeps()`-Muster aus
  `lock-reaper.mjs:77-100`, mit neuem Slot `deps.killProcess`.
- `scripts/lib/resource-probe/probe-platform.mjs` — `ps`-Spalten um `ppid`, `rss`, `args`
  erweitern (eigener Aufruf, um `probe()` nicht zu verteuern).
- `hooks/post-tool-batch-wave-signal.mjs`, `hooks/on-stop.mjs` (SubagentStop) — Andockpunkte.
- `.claude/rules/host-resources.md` — neue Regel für das Waisen-Signal.

### Architecture

Strikte Trennung nach dem Vorbild `lock-reaper.mjs`: `evaluateRepo()` entscheidet rein,
`archiveLock()` führt destruktiv aus, mit TOCTOU-Recheck dazwischen. Übertragen:
`decideReapCandidates()` (rein, textfixture-testbar) → Identitätsprüfung → `deps.killProcess`.

Für die Kill-Eskalation existiert ein fertiges, getestetes Vorbild in
`dispatch-common.mjs:99-164`; zu ändern ist nur das Ziel des Signals — von `child.kill(sig)`
auf `process.kill(-pgid, sig)`.

Bibliotheken sind **nicht** zwingend nötig (`ps` reicht). Falls doch: `execa` ist der einzige
aktiv gepflegte Kandidat mit dokumentiertem `killDescendants`; `tree-kill` ist seit
2019-12-11 ohne Release und hat einen offenen macOS-Bugreport (#28).

### Parameter und Vorgabewerte

Startwerte für Stufe 1, **nicht kalibriert** — jeder trägt hier seine Herkunft, damit später
nachvollziehbar ist, wogegen Stufe 1 gemessen wurde (CLAUDE.md: „keine Zahl ohne ihre Population").

| Parameter | Vorgabe | Herkunft |
|---|---|---|
| `reaper.min-age-seconds` | 300 (5 min) | DevWatchdogs Hart-Grenze für `tsgo`; die Waisen vom 2026-09-20 waren 7–17 min alt, lagen also deutlich darüber |
| `reaper.min-scan-interval-seconds` | 30 | DevWatchdogs Normal-Scan-Takt; verhindert, dass ein `PostToolBatch`-Sturm jeden Tool-Call verteuert |
| `reaper.kill-grace-ms` | 10 000 | `DEFAULT_KILL_GRACE_MS` aus `dispatch-common.mjs:61` — Repo-Konvention, nicht neu erfunden |
| `reaper.verify-wait-ms` | 500 | Wartezeit vor dem Zurücklesen; ohne sie meldete die Prüfroutine am 2026-09-20 fälschlich „lebt noch" |
| `reaper.max-hook-latency-ms` | 50 | Obergrenze, um die ein Scan einen Hook verzögern darf; darüber gilt der Scan als zu teuer und wird übersprungen |
| `reaper.false-alarm-window` | letzte 50 Entscheidungen aus dem JSONL-Audit (B5) | rollierendes Fenster statt Kalenderzeit, damit die Rate auch auf ruhigen Hosts eine Population hat |
| `gate.timeout-path-b-ms` | 900 000 (15 min) | gleicher Deckel wie `GATE_TIMEOUT_MS` in Pfad A, damit beide Pfade gleich lange dürfen |

Die HR-101-Schwelle von 10 % Feuerrate wird gegen `reaper.false-alarm-window` geprüft.

### Data Model Changes

Neu: Abstammungsregister (`pid`, `pgid`, `startTime`, Kommando-Signatur, Session-ID) und
ein JSONL-Audit unter `.orchestrator/`. Keine Datenbank.

### API Changes

Keine externen. Neu exportiert: `decideReapCandidates()`, `verifyProcessIdentity()`,
`killProcessGroup()`.

## 5. Risks & Dependencies

| Risk | Impact | Mitigation | Triage |
|---|---|---|---|
| Der Reaper tötet einen legitimen Prozess | hoch | Abstammungsregister statt blankem PPID=1; Identitätsprüfung vor jedem Signal; read-only-Kommandos only; System-Daemons ausgeschlossen | Implement |
| PPID=1 ist auf macOS kein Waisen-Signal (launchd ist Elternteil von fast allem) | hoch | Kill nur gegen das eigene Register; PPID=1 ist notwendige, nicht hinreichende Bedingung | Implement |
| Umstellung von `spawnSync` auf `spawn` bricht den Gate-Pfad, den jede Session nutzt | hoch | Vorhandene Gate-Tests als Netz; Fake-Child-Muster aus `foreign-dispatch.test.mjs:32-79` (`ignoreSigterm`) für die Eskalation; schrittweise hinter Flag | Experiment |
| Neues Warnsignal feuert zu oft und wird ignoriert wie das alte | mittel | HR-101 gilt: Feuerrate vor Aktivierung messen, >10 % heisst Instrument defekt | Implement |
| Scan verteuert jeden Tool-Call | mittel | Gezielter `ps` statt `probe()`; non-blocking; Mindestabstand zwischen Scans | Implement |
| Tests killen echte Entwickler-Prozesse | hoch | `.claude/rules/testing.md:122`; nur selbst gespawnte Kinder; `DEAD_PID`-Sentinel; niemals `ps`-Ergebnisse als Kill-Ziel in Tests | Implement |
| Jev als Entscheider im Kill-Pfad | mittel | Bewusst ausgeschlossen (§2 Out-of-Scope): externer Netz-Call, nicht versionspinnbar, 503-Fenster gemessen | Reject |

### Dependencies

- **Peer-Session in `session-orchestrator`:** Zum Planungszeitpunkt lief eine fremde Session
  auf `main` mit 10 unkommittierten Dateien, darunter `hooks/enforce-scope.mjs` und
  `scripts/lib/scope-gate.mjs`. Vor Implementierungsbeginn abgleichen — `hooks/` wird von
  Teil B berührt.
- **`.claude/rules/host-resources.md`** HR-101 bis HR-106 gelten unverändert und binden
  jedes neue Signal.
- **`projects-baseline/docs/EVALUATION-MODELS.md` §5** ist die Methodik-SSOT für Stufe 2;
  Vorlage: `LeadPipeDACH/scripts/eval/jev/PREREG-2026-09-18.md`.
- **Nummernkreis-Warnung:** Issue-Nummern in Code-Kommentaren stimmen nicht durchgängig mit
  GitLab überein (der GitHub-Mirror hat einen eigenen Kreis, Stand 71 Issues). Diese PRD
  zitiert deshalb Commit-SHAs, etwa `634f425c` (2026-08-21) für die 1477-Events-Messung.
