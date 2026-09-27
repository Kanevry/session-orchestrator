# Fleet Protocol v1 — Dateien statt Nachrichten (#1462, Epic #1461)

Shared reference for every session-orchestrator session (Claude Code, Codex, headless) that
runs beside a fleet coordinator ("navigator"). It is a reference, **not a rule**: nothing under
`.claude/rules/**` loads it, session-start Phase 7.6 and the operations-contract peer preflight
point here. The mechanics live in code — `scripts/lib/fleet-protocol.mjs` is the only place that
knows paths, fields, deadlines and lease validity; `scripts/fleet-checkin.mjs` writes the check-in.
This file describes them and never redefines them. Source: PRD
`docs/prd/2026-09-27-navigator-peer-protokoll.md` §§ 3.1–3.3, 3.7, Anhang A.2 (MR !53). <!-- path-check: planned #1461 -->

**Grundsatz (ADR-002, CSM-003).** Zustand liegt in Dateien; Nachrichten sind nur Hinweise auf eine
Datei. Der Navigator erteilt keine Freigaben — wörtlich: **„Freigaben erteile ich keine, maßgeblich
ist dein Owner-Auftrag"**. Eine Datei, die fehlt, heißt „nicht nachweisbar", nie „nicht vorhanden"
(ADR-004): eine fehlende Lease ist kein freies Feld, sondern ein Zustand ohne Beleg.

## Verzeichnis und Dateiform

- Wurzel `~/.config/navigator/`, Override `NAVIGATOR_CONFIG_DIR` (getrimmt; leer oder nur
  Whitespace zählt als nicht gesetzt) — dieselbe Variable wie die navigator-CLI, keine zweite.
  Code: `navigatorDir()`. Ein Override zeigt nur auf ein eigenes Verzeichnis mit Modus 0700, nie
  auf einen geteilten Ort: wer dort schreiben kann, kann eine „aktive" Lease vortäuschen.
- Verzeichnisse Modus `0700`, Dateien Modus `0600`. Schreiben immer atomar (tmp-Datei im
  Zielverzeichnis, dann `rename`).
- Jede Datei trägt `zeit` aus `date -u +%FT%TZ` (Sekunden, `YYYY-MM-DDTHH:MM:SSZ`); nie geschätzt,
  nie aus einer anderen Uhr. Code: `utcSecondsTimestamp()`.
- Dateinamen aus einer `session_id` sind pfadsicher: nur `[A-Za-z0-9._-]`, nicht `.` oder `..`,
  kein `/`. Code: `isSafeSessionId()`; `checkinPath()` und `auflagenPath()` werfen sonst.
- Tests berühren das echte Verzeichnis nie: `tests/setup/navigator-dir-guard.mjs` setzt
  `NAVIGATOR_CONFIG_DIR` je vitest-Worker auf ein tmp-Verzeichnis.

## `leases/navigator.json` — genau ein aktiver Navigator (PRD 3.1)

| Feld | Inhalt |
|---|---|
| `session_id` | Registry-ID des Navigators (Pflicht; pfadsicher wie oben, höchstens 128 Zeichen) |
| `plattform` | `claude` \| `codex` \| `kopflos` (Pflicht) |
| `adresse` | `ListAgents`-Name, wenn Claude (`[A-Za-z0-9._:@-]`, 1–128 Zeichen); sonst `null` |
| `seit` | Zeit des Erwerbs, UTC mit `Z`, Sekunden oder Millisekunden (Pflicht) |
| `laeuft_ab` | UTC mit `Z`; Erneuerung je Ticker-Runde, Ablauf 30 min nach der letzten (Pflicht) |
| `uebergabe_an` | `null` oder Session-ID des Nachfolgers |

**„Aktiv" heißt ausschließlich: gültige Lease.** `readNavigatorLease()` liefert genau eines von
`active` (Datei lesbar, Pflichtfelder da, `laeuft_ab` in der Zukunft), `none` (Datei fehlt oder
`laeuft_ab` überschritten) oder `unreadable` (kaputtes JSON, fehlende Pflichtfelder, Lesefehler, oder ein Feld außerhalb der
Tabellenform: unbekannte `plattform`, Steuerzeichen in `session_id`/`adresse`, eine Zeit ohne `Z`
oder mit Offset — sie würde in lokaler Zeit gelesen und könnte die Lease verlängern).
Unlesbar oder abgelaufen ist **nie** aktiv (fail-closed). Registry-Heartbeat (`role: navigator`,
`scripts/lib/session-registry.mjs`) und `ListAgents` sind Zusatzsignale, keine Lebendbeweise.
Erwerb und Übergabe der Lease sind S4 (agents/navigator#36), nicht Teil dieses Repos.

## `checkin/<session_id>.json` — Session an Navigator (PRD 3.2)

**Schreibend** heißt: Änderung an Repo-Inhalt oder VCS-Zustand (Datei im Arbeitsbaum außerhalb
`.orchestrator/` und `.claude/`, Commit, Branch, Push, MR, Issue, Kommentar). SO-eigener
Sitzungszustand zählt nicht: Phase 1.1 (CLAUDE.md-Migration, einmalig), 1.2 `session.lock`, 1.5
`STATE.md`, 1.6 Metriken, 1.7 Live-Status-Board. Phase 1.1 ist eine Repo-Datei und wird deshalb
als Ausnahme im Check-in genannt (`vorab_geschrieben`). (`CLAUDE.md` heißt auf Codex CLI `AGENTS.md`, siehe
`skills/_shared/instruction-file-resolution.md`.)

Der Check-in liegt **vor der ersten schreibenden Aktion** (Phase 7.6, oder der Peer-Preflight der
Operations-Route). Schreiber: `node scripts/fleet-checkin.mjs` liest das JSON von stdin, ergänzt
`zeit`, validiert (`validateCheckin()`), schreibt atomar mit Modus 0600 und emittiert
`orchestrator.fleet.checkin` (Payload `session`, `repo`, `modus`, `kandidaten`, `navigator_state`).
Exit 0 geschrieben, 2 ungültige Eingabe (Fehlerliste auf stderr, keine Datei), 1 Schreibfehler.

| Feld | Inhalt |
|---|---|
| `session`, `plattform` | Registry-ID (aus `.orchestrator/current-session.json`); `claude` / `codex` / `kopflos` |
| `repo`, `repo_id`, `worktree` | Name; `repo_id` aus `navigator identity` oder `null`; Worktree `true`/`false` |
| `modus` | `housekeeping` / `feature` / `deep` / `operations` |
| `auftrag_ref` | Pfad der Auftragsdatei oder „Owner-Chat <zeit>" mit Wortlaut in einem Satz |
| `konto_slot`, `quota` | `account_slot` als Nummer (`navigator identity`) oder `null`; Quota aus `navigator quota` oder `nicht messbar` |
| `stand` | Objekt: main-, origin/main-, Prod-SHA (sonst `nicht messbar`), offene MRs |
| `kandidaten`, `schreibbereich` | Issue-Nummern; Verzeichnisse/Dateien |
| `bedarf` | Objekt: geplante volle Pipelines, m5-remote-Jobs, prozessstartende Agents |
| `vorab_geschrieben`, `rueckfall` | Ausnahmen nach der Definition oben; Verhalten ohne Auflagen (unten) |
| `zeit` | von der CLI gesetzt |

Eine `SendMessage` an den Navigator ist optional und nur ein Hinweis auf die Datei: höchstens eine,
nur wenn die Lease aktiv ist und eine Peer-Adresse `navigator-*` erreichbar ist; nie eine Antwort
erwarten, nie darauf warten (CSM-004).

## `auflagen/<session_id>.json` — Navigator an Session (PRD 3.3)

Felder: Caps (prozessstartende / lesende Agents nach freiem Speicher des lokalen Hosts), volle
Pipelines je Repo, m5-remote-Regel (Lastschwelle, was lokal erlaubt ist), Merge-Protokoll, Zeitregel,
Flottenpriorität, Besitzkonflikte, Pflichtsatz „Freigaben erteile ich keine, maßgeblich ist dein
Owner-Auftrag". Die Session **liest** die Datei; sie wartet auf keine Nachricht.

**Standard-Auflagen (konservative Stufe).** Sie gelten, wenn `CHECKIN_FALLBACK_MIN` = 10 Minuten
nach `checkin.zeit` keine Auflagen-Datei liegt — und sofort, wenn kein Navigator aktiv ist
(PRD Anhang A.2, v2-Wortlaut):

- Caps: 2 prozessstartende + 2 lesende Agents, solange der lokale Host ≥ 50 % Speicher frei hat
  (`memory_pressure | tail -1`).
- Pipelines: ≤ 2 volle je Repo; Nachzug-Pushes vorher im Check-in (`bedarf`) benennen.
- Offload: Heavy-Rollen (test, build, lint, audit) nur auf `m5-remote`, nur bei 5-Minuten-Last < 12;
  lokal nur `vitest` bzw. `eslint` je Datei mit `timeout`.
- Zeiten nur aus `date`.
- Kein Merge ohne Befugnis nach PRD 3.5: `navigator authority query <repo> merge --exit-code` mit
  Exit 0 **oder** ein ausdrücklicher Owner-Auftrag, der Merge für genau dieses Repo nennt
  (`auftrag_ref`). Ohne navigator-CLI ist jeder Merge `einzeln`.

Lesende Arbeit und Schreiben im eigenen Worktree laufen währenddessen weiter; der Rückfall ist ein
Dateistand mit Frist, kein Warten auf eine Antwort.

## Verhalten ohne Navigator (PRD 3.7)

Lease `none` oder `unreadable`: die Check-in-Datei wird **trotzdem** geschrieben (sie ist der
zählbare Beleg), die Standard-Auflagen gelten sofort, es geht keine Nachricht ab. Kopflose Läufe
sind per Nachricht nicht erreichbar und nutzen dieselben Dateien; ihr Brief verlangt, vor jeder
Welle und vor jedem MR `auflagen/` und `merge/` zu lesen.

## Vorschau: `merge/<repo_id>/*` (S2, #1463 — hier keine Mechanik)

Ansage `ansage-<mr>.json` (MR, gepinnte Head-SHA, Pipeline-ID, Jobliste, Gate-Log-SHA, Review-Stand,
Migration, `laeuft_ab` +20 min), Lease `lease-<mr>.json` (Navigator, +15 min), Meldung
`done-<mr>.json` (Merge-SHA, main-Pipeline-ID, Prod-SHA). Verfall bei Ablauf, MR nicht mehr
`opened` oder geändertem Head. Nichts davon ist in diesem Repo implementiert; bis S2 gilt PRD 3.4
Punkt 3: selbst messen und nach 3.5 mergen, oder `navigator ask --aktion merge`.

## See Also

`skills/session-start/SKILL.md` Phase 7.6 · `skills/session-start/references/operations-contract.md`
(Peer-Preflight) · `skills/_shared/state-ownership.md` § Session Identity and Lock Ownership (`role`) ·
`docs/events-schema.md` (`orchestrator.fleet.checkin`) · `.claude/rules/cross-session-messaging.md`
(CSM-003/004) · `scripts/lib/fleet-protocol.mjs` · `scripts/fleet-checkin.mjs`
