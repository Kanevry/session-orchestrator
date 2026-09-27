# Feature: navigator im session-orchestrator (Peer-Protokoll v1 und Skill `/navigator`)

**Date:** 2026-09-27
**Author:** navigator-fd (Koordinatorsession), Gegenprüfung durch unabhängigen Prüfer 15:42
**Status:** Entwurf v2 nach Gegenprüfung; Owner hat die Entscheide E1–E12 am 2026-09-27 (15:5x) an navigator-fd delegiert, alle zwölf sind wie empfohlen angenommen (siehe Abschnitt 7)
**Epic:** noch keins (nach Freigabe: SO-Epic + navigator-Issue je Stufe)
**Appetite:** 2w (Medium Batch), Stufen einzeln abbrechbar
**Parent Project:** session-orchestrator (Protokoll, Adapter, Skill, Hooks) und navigator (Mechanik-CLI)

> Zeiten Europe/Vienna, gemessen mit `date` oder aus Dateien mit Zeitstempel. Zahlen ohne eigene
> Messung stammen aus der Codex-Recherche von navigator-fd (15:35) und sind so markiert. Belegstellen
> im SO beziehen sich auf **origin/main `5d9bf2b6`** (gelesen per `git show origin/main:<pfad>`),
> Belegstellen im navigator-Repo auf den Arbeitsstand von heute. Zielwerte ohne Vorab-Messung sind als
> **Hypothese** markiert. Messprotokoll am Ende. Begriff: navigators Einheit heißt **Auftrag**, nicht
> Mandat (PRD-002 Z. 188, 233–234, 451).

> Repo- und Sessionnamen sind für die Veröffentlichung durch Platzhalter ersetzt; die Zuordnung liegt
> im privaten navigator-Repo (Flotten-Lage 2026-09-27). Platzhalter: Repos repo-A bis repo-H;
> Sessions session-A1 bis session-F1 und session-S1; Koordinatorsession der Vornacht navigator-N1;
> Veranstaltung „Hackathon H2".

## 1. Problem & Motivation

### What

Heute gibt es zwei Hälften, die nichts voneinander wissen. Der session-orchestrator (SO) ist der
Motor in einer Session und kennt Peers nur als Banner-Zeile. navigator ist ein eigenes Repo mit CLI
(`status`, `watch`, `ledger`, `authority`, `ask`, `quota`; `README.md`). Das Koordinationsprotokoll,
das am 27.09. lief, steht in keinem der beiden Repos, sondern in einer Prompt-Datei
(`.orchestrator/runtime/ticker/prompt-fd.md`, 16 Zeilen), einem Startskript (`fleet/_start.sh`) und in
Chatnachrichten. Im SO kommt „navigator" funktional nicht vor (grep-Zensus: 1 Datei in
`skills hooks scripts .claude commands`, `.claude/STATE.md`, Sitzungsnotiz).

### Why: vier Belege vom 2026-09-27

1. **Das Protokoll ist emergent.** 15:19–15:21 starteten vier Owner-Sessions (session-A1,
   session-B1, session-C1, session-D1), später session-E1. Zwei
   davon (session-A1, session-D1) meldeten sich **unaufgefordert** mit fast gleichem Schema (Anhang A.1). session-D1 legte die
   Rückfallregel gleich mit fest: „schreibende erst nach deiner Antwort oder nach 10 min ohne Antwort
   mit den S76-Grenzen". Drei von fünf taten es nicht von selbst.
2. **Kollision mit einer unsichtbaren Session.** 15:25 startete der kopflose Lauf session-F1 in
   repo-F; 15:28 gestoppt (exit 143), weil die Codex-Desktop-Session 01a0e308-41ef am selben
   Bündel arbeitete (#449 mit 14 Treffern im Rollout, dazu #451, #450, #448, #441; Beleg
   `navigator-flotte/docs/ops/2026-09-26-flotte/00-lage.md`, „Ab navigator-fd"). Seit 15:35 hat
   `_start.sh` ein Belegt-Tor (Codex-Rollout mit cwd = Repo jünger 30 min oder `session.lock` jünger
   6 h, dann exit 5).
3. **Kurier-Last.** Hackathon H2: 11 repo-G-Sessions in 6 h, der Navigator wurde „Kurier für Hunderte
   Nachrichten", Übergaben kosteten 10–20 min; Uhrzeiten 1 bis 8 min falsch geschätzt; Merge-Ketten
   lasen die SHA erst beim Merge (`docs/ops/<Hackathon-H2-Ordner>/91-lehren-navigator-N1.md`, „Was nicht
   gut geklappt hat" Nr. 1, 2, 4).
4. **Codex ist sichtbar, aber nicht erreichbar.** Die SO-Registry
   `~/.config/session-orchestrator/sessions/active/` führte um 15:37 zwölf lesbare Einträge, **5 mit
   `platform: codex`**. Der SO-SessionStart-Hook läuft also in Codex (`hooks/hooks-codex.json`,
   SessionStart mit `SO_PLATFORM=codex`). Es fehlt der Rückkanal: `SendMessage` erreicht Codex nicht.

### Who

Der Owner (solo) und jede Session, die er startet: interaktive Claude-Sessions, kopflose
`claude -p`-Läufe mit Brief, Codex-Desktop-Sessions. Der Koordinator ist eine Claude-Session mit
`/navigator`.

## 2. Ziel und Nicht-Ziel

### Ziel

- Jede SO-Session sieht beim Start, ob ein Navigator aktiv ist (Mindesthinweis, alle Plattformen).
- Jede Session, die über `/session` oder die Operations-Route startet, legt vor ihrer ersten
  **schreibenden Aktion** (Definition 3.2) einen Check-in als Datei ab und liest Auflagen als Datei.
- Merges werden über **Zustand** koordiniert (Ansage- und Lease-Dateien mit Ablaufzeit), nie über das
  Warten auf eine Antwort (`.claude/rules/cross-session-messaging.md` Z. 44: „Never gate a decision, a
  wave, or a commit on a peer's reply").
- Der Koordinator ist ein aufrufbarer Skill statt einer Prompt-Datei im Runtime-Ordner.
- Codex bekommt denselben Protokoll-Anteil über Dateien und Hooks.
- Der Navigator wird vom Boten zum Prüfer: Nachrichten sind nur noch Hinweise auf Dateien.

### Nicht-Ziel

- **Kein automatischer Sessionstart** (navigator `CLAUDE.md`: OUT, bis S1 bis S6 stehen).
- **Keine Freigaben durch navigator** (ADR-002; CSM-003). Eine Merge-Lease heißt „main ist frei,
  die Belege stimmen", nie „du darfst". Die Befugnis kommt aus dem Owner-Auftrag bzw. aus
  `authority/<repo>.yaml` (3.5).
- **Kein neuer Zustandsdienst.** Zustand liegt in Dateien (PRD-002 § 6.2); Messaging ist Transport.
- „Nicht gefunden" ist nie „nicht vorhanden" (ADR-004): fehlt die Navigator-Lease, heißt das „kein
  aktiver Navigator nachweisbar", nicht „alles frei".

## 3. Protokoll v1

Alle Protokolldateien liegen unter `~/.config/navigator/` (außerhalb jedes Repos, Modus 0600). Jede
Datei trägt `zeit` aus `date -u +%FT%TZ`, nie geschätzt.

### 3.1 Genau ein aktiver Navigator: Navigator-Lease

`leases/navigator.json`: `session_id` (Registry-ID), `plattform`, `adresse` (ListAgents-Name, falls
Claude), `seit`, `laeuft_ab` (Erneuerung je Ticker-Runde, Ablauf 30 min nach letzter Erneuerung),
`uebergabe_an` (leer oder Session-ID des Nachfolgers). Erwerb atomar (mkdir-Sperre wie beim Ledger,
`README.md` Abschnitt `ledger`). Ein zweiter Navigator bekommt die Lease nicht, solange sie gültig
ist; Übergabe nur über `uebergabe_an` (schließt an navigator#33 an).

**„Aktiv" heißt: gültige Lease.** Das gilt für alle Plattformen gleich, auch für Codex, kopflose Läufe
und Subagents, die `ListAgents` nicht laden können. Registry-Heartbeat und ListAgents sind nur
Zusatzsignale; der Heartbeat schreibt nur am Turn-Ende (`hooks/on-stop.mjs` Z. 398–418) und taugt
deshalb nicht als Lebendbeweis eines wartenden Navigators.

Registry-Anschluss: neues optionales Feld `role` (Wert `navigator`) statt eines neuen `mode`. `mode`
wird nur im SessionStart-Hook gesetzt (`hooks/on-session-start.mjs` Z. 353), `heartbeat()` patcht
heute nur `status` und `current_wave` (`scripts/lib/session-registry.mjs` Z. 243–256). B4 erweitert
`heartbeat(patch)` um `role` und `_validEntry` um dessen Form; `skills/_shared/state-ownership.md`
nennt das Feld. `role` berührt `classifyMode` nicht. Die Registry ist Anzeige; maßgeblich bleibt die
Lease.

### 3.2 Check-in (Session an Navigator)

**Schreibend** heißt: Änderung an Repo-Inhalt oder VCS-Zustand (Datei im Arbeitsbaum außerhalb
`.orchestrator/` und `.claude/`, Commit, Branch, Push, MR, Issue, Kommentar). SO-eigener
Sitzungszustand zählt nicht: Phase 1.1 (CLAUDE.md-Migration, einmalig), 1.2 `session.lock`, 1.5
`STATE.md`, 1.6 Metriken, 1.7 Live-Status-Board (`skills/session-start/SKILL.md` Z. 93–117). Phase 1.1 ist
eine Repo-Datei und wird deshalb als Ausnahme im Check-in genannt (`vorab_geschrieben`).

Zeitpunkt: neue **Phase 7.6** zwischen 7.5 (Mode-Selector, Z. 342) und 8 (Präsentation, Z. 353); dort
liegen Git-, VCS- und Issue-Stand vor. Die Operations-Route ersetzt die Phasen 0.5–9
(`SKILL.md` Z. 35–49); ihr Contract (`references/operations-contract.md`, Peer-Preflight Z. 43–48)
bekommt denselben Schritt. Sessions ohne `/session` sehen nur den Mindesthinweis (4.3); diese Lücke
wird gezählt, nicht verdeckt (S1-Kriterium).

Ablage: `checkin/<session_id>.json` (Claude, Codex, kopflos gleich), dazu SO-Event
`orchestrator.fleet.checkin` in `events.jsonl` (Namensmuster wie `orchestrator.session.started`).
Eine `SendMessage` an den Navigator ist optional und nur Hinweis auf die Datei.

| Feld | Inhalt |
|---|---|
| `session`, `plattform` | Registry-ID + semantische ID; claude / codex / kopflos |
| `repo`, `repo_id`, `worktree` | Name, `repo_id` aus `navigator identity`, Worktree ja/nein |
| `modus` | housekeeping / feature / deep / operations |
| `auftrag_ref` | Pfad der Auftragsdatei oder „Owner-Chat <zeit>" mit Wortlaut in einem Satz |
| `konto_slot`, `quota` | `account_slot` als Nummer (`navigator identity`), Quota-Stand aus `navigator quota` oder `nicht messbar` |
| `stand` | main-, origin/main-, Prod-SHA (sonst `nicht messbar`), offene MRs |
| `kandidaten`, `schreibbereich` | Issue-Nummern; Verzeichnisse/Dateien |
| `bedarf` | geplante volle Pipelines, m5-remote-Jobs, prozessstartende Agents |
| `vorab_geschrieben`, `rueckfall` | Ausnahmen nach Definition oben; Verhalten ohne Auflagen (3.3) |

### 3.3 Auflagen (Navigator an Session)

Datei `auflagen/<session_id>.json`, optional mit Hinweis-Nachricht. Felder: Caps (prozessstartende /
lesende Agents je nach freiem Speicher des lokalen Hosts), volle Pipelines je Repo, m5-remote-Regel
(Lastschwelle, was lokal erlaubt ist), Merge-Protokoll, Zeitregel, Flottenpriorität (Owner 15:28:
repo-B, repo-D/repo-H, repo-A, Rest; Bremsen von unten), Besitzkonflikte, Satz
„Freigaben erteile ich keine, maßgeblich ist dein Owner-Auftrag". Fehlt die Datei 10 min nach dem
Check-in, gelten die **Standard-Auflagen** (konservative Stufe, steht in B1); lesende Arbeit und
Schreiben im eigenen Worktree laufen weiter. Das ist kein Warten auf eine Antwort, sondern ein
Dateistand mit Frist.

### 3.4 Merge: Ansage und Lease als Zustand

1. **Ansage (Session):** `merge/<repo_id>/ansage-<mr>.json` mit MR, gepinnter Head-SHA, Pipeline-ID,
   Jobliste inkl. Pflichtjobs, Gate-Log-SHA (= Head), Review-Stand, Migration ja/nein, `laeuft_ab`
   (Ansage + 20 min).
2. **Lease (Navigator, wenn aktiv):** misst am GitLab (Head = Pipeline-SHA = Gate-SHA, `mergeable`,
   keine laufende main-Pipeline, keine gültige fremde Ansage im Repo) und schreibt
   `merge/<repo_id>/lease-<mr>.json` mit MR, SHA, `laeuft_ab` (+ 15 min), Ledger-Hash. Die
   Session **liest** die Lease selbst; sie wartet auf keine Nachricht.
3. **Ohne Lease bis Ablauf der Ansage**, oder ohne aktiven Navigator (3.1): die Session misst dieselben
   Punkte selbst und merged nach 3.5, oder sie fragt `navigator ask --aktion merge` (Exit 0 gedeckt,
   3 geparkt, 4 abgelehnt, 2 Aufruffehler; `README.md` Z. 17). Geparkt heißt: MR offen lassen, nächstes
   Issue, kein Stillstand der Welle.
4. **Merge** nur mit `--sha <gepinnte SHA>`; Lease-SHA muss gleich der gepinnten SHA sein, sonst neu
   ansagen (Hackathon H2-Lehre 1 und 2).
5. **Meldung:** `merge/<repo_id>/done-<mr>.json` mit Merge-SHA, main-Pipeline-ID, Prod-SHA.

**Verfall:** Eine Ansage oder Lease gilt nicht mehr, wenn `laeuft_ab` überschritten ist, der MR nicht
mehr `opened` ist oder der Head sich geändert hat. Eine abgestürzte Session sperrt das Repo also
höchstens 20 min. Der Navigator misst main nach jeder `done`-Datei selbst (Pipeline bis Ende,
Health-SHA) und verlässt sich nicht auf die Meldung.

Die fail-closed-Asymmetrie bleibt: Beim Check-in schützt der Worktree, deshalb Weiterarbeit nach
Frist. Beim Merge schützt nur Messung plus Befugnis, deshalb gibt es ohne beides keinen Merge; aber
der Merge hängt nie an einer Antwort, sondern an Dateien mit Ablaufzeit und an eigener Messung.

### 3.5 Befugnis vor jedem Merge

Die Lease ist weder notwendig noch hinreichend für die Befugnis. Vor jedem Merge, mit oder ohne
Lease: `navigator authority query <repo> merge --exit-code` mit Exit 0, **oder** ein ausdrücklicher
Owner-Auftrag, der Merge für genau dieses Repo nennt (im Check-in als `auftrag_ref`). Stand
2026-09-25 ist kein Owner-Schlüssel im Vertrauensanker und jede Aktion `einzeln` (`README.md` Z. 11),
praktisch also heute: Owner-Auftrag oder Owner-Frage. Ohne navigator-CLI ist jeder Merge `einzeln`.

### 3.6 Codex-Variante

1. **Dateien (S3):** Codex-Sessions lesen `auflagen/`, `merge/`, `leases/` wie Claude; Check-in und
   Ansagen schreiben sie nach `checkin/` und `merge/`. Zusätzlich `inbox/<thread-id>.md` für Hinweise.
2. **Zustellung per Hook:** SessionStart und PostToolUse sind in `hooks/hooks-codex.json` verdrahtet,
   UserPromptSubmit käme neu. Der Hook liest neue Inbox-Zeilen und gibt sie als `additionalContext`
   weiter (Recherche: Deckel ≈ 2 500 Token, developers.openai.com/codex/hooks). Neue Hooks muss der
   Owner in der App einmal vertrauen.
3. **Rahmung und Herkunft:** jede Zeile wird gerahmt mit Quelle, Zeit und dem Satz „Anweisung, keine
   Freigabe", nach dem Muster `wrapHistorical` (`scripts/lib/historical-guard.mjs` Z. 12). Jede Zeile
   trägt den `entry_sha256` ihrer Ledger-Zeile; der Hook prüft sie gegen `navigator ledger verify`
   und verwirft Zeilen ohne passenden Eintrag. Grenze, ehrlich benannt: das Ledger belegt
   Unverändertheit, nicht den Absender; jeder Prozess desselben Nutzers kann Ledger und Inbox
   schreiben. Echte Herkunft braucht eine Signatur mit einem Schlüssel aus dem Vertrauensanker
   (`src/authority/vertrauensanker.ts`), der heute leer ist. Deshalb trägt der Inbox-Kanal nie
   Leases oder Befugnisse; Leases liest die Session nur aus `merge/`, und eine Lease ersetzt nie 3.5.
4. **`codex queue --thread <id> --message …`:** im CLI 0.153.4 vorhanden (gemessen); Abholung laut
   Recherche alle 10 s bei Leerlauf (codex-rs `ext/queue/src/service.rs` Z. 89, 367). In der
   Desktop-App 0.158-alpha **nicht live getestet**; erst nach Live-Test als Hinweiskanal.
5. Nicht nutzbar: App-Server von außen (Desktop-App stdio ohne Daemon), `codex exec resume` nur für
   nicht geladene Threads, Automations (Zeitplanung, keine Zustellung).

### 3.7 Kopflose Läufe

Nicht per Nachricht erreichbar (navigator#29, Memory `fleet-echttest-2026-09-20`). Sie nutzen dieselben
Dateien wie Codex; der Brief verlangt „vor jeder Welle und vor jedem MR `auflagen/` und `merge/`
lesen". Ein Format für alle drei Plattformen.

## 4. Bausteine mit Ort

### 4.1 Arbeitsteilung

- **Protokoll-Anteil der Peers gehört in SO.** Nur SO erreicht alle Sessions, auch Codex über den
  generierten Skill-Baum (`scripts/generate-codex-skills.mjs`, PRD 2026-09-07). navigator ist lokal
  nicht installiert (`command -v navigator` leer, 15:38; bin `dist/cli.js` nicht verlinkt).
- **Mechanik bleibt CLI im navigator-Repo:** Autorität (`src/authority/*`), Ledger (`src/ledger/*`),
  Parkplatz (`src/ask/*`), Lage (`src/status/*`), Identität (`src/identity/*`). Sie nach SO zu ziehen
  verdoppelt Code und widerspricht navigator `CLAUDE.md` („er wohnt nicht in ihnen").
- **Vorbild `remote-offload`, vollständig übernommen:** Mechanik liegt dort nicht im Skill, sondern in
  SO-Adaptern (`scripts/lib/wave-executor/remote-dispatch.mjs`, Exit-Karte `OFFLOAD_EXIT_REASONS`
  Z. 68), Bereitschaft kommt über eine Bannerzeile, und fehlt der Host, ist die Funktion aus. Für
<!-- path-check: planned #1463 -->
  navigator heißt das: **SO-Adapter** `scripts/lib/navigator-adapter.mjs` mit Exit-Karte
  (`authority check` 1 = fail-closed; `authority query --exit-code`; `ask` 0/3/4/2) und Kontrakt-Test
  gegen die echte CLI wie MR !41. **Ohne CLI** gibt es keinen „Handbetrieb" mit denselben Rechten:
  der Skill liest nur (Registry, Dateien, GitLab), schreibt Auflagen und Leases als Koordinator, und
  jeder Merge ist `einzeln`. Abweichung vom Vorbild: `/navigator` ist user-invocable, weil er eine
  Koordinator-Rolle ist und kein Referenzskill.

### 4.2 Bausteine

| # | Baustein | Ort | Hängt an |
|---|---|---|---|
<!-- path-check: planned #1462 -->
| B1 | Protokoll-Referenz (3.1–3.7, Standard-Auflagen, Dateischemata) | SO `skills/_shared/fleet-protocol.md`, keine Rule | B2, B3, B5 laden sie |
| B2 | Check-in Phase 7.6 + Schritt im Operations-Contract + Event `orchestrator.fleet.checkin` | SO `skills/session-start/SKILL.md`, `references/operations-contract.md` | B1, B4 |
| B3 | Merge-Disziplin vor `glab mr merge` (`skills/gitlab-ops/SKILL.md` Z. 189) und `gh pr merge` (Z. 226); optional PreToolUse-Hinweis auf diese Befehle | SO `gitlab-ops`, ggf. Hook | B1; Hook kostet einen Aufruf je Bash-Befehl (4.5) |
| B4 | Registry-Feld `role` + `heartbeat(patch.role)` + `state-ownership.md` | SO `session-registry.mjs` | keiner |
| B5 | Skill `navigator`: `/navigator [ticker\|status\|start\|fenster\|handover]`, Referenzen Ticker, Auflagen, Brief-Vorlage, Codex-Adapter | SO `skills/navigator/` | B1, B4, B6 |
<!-- path-check: planned #1463 -->
| B6 | Adapter + Exit-Karte + Kontrakt-Test + Bannerzeile `navigator: ready=yes\|no` | SO `scripts/lib/navigator-adapter.mjs`, `hooks/on-session-start.mjs` | navigator-CLI |
| B7 | Codex-Inbox-Hook mit Rahmung und Ledger-Prüfung | SO `hooks/hooks-codex.json` + neues `.mjs` | B1, B6, Owner-Vertrauen |
| B8 | Navigator-Lease, Merge-Ansage/Lease-Dateien, Verfall | navigator-CLI `navigator lease`, `navigator merge` | B10 |
| B9 | Belegt-/Platz-Tor als Befehl (heute `_start.sh`) | navigator-CLI `navigator slot check <repo>` | Registry, Codex-Tabellen |
| B10 | Zeitstempel mechanisch (#28), `navigator fenster` (#30), Übergabe (#33) | navigator-CLI | keiner |
| B11 | navigator-CLI installieren (`pnpm link` o. ä.), Voraussetzung für Ledger-Zählung | Owner-Host | Owner-Entscheid E11 |

Headless: unter `claude -p` sind nur `session` und `plan` als eingebaute Namen reserviert
(`commands/session.md` Z. 56–62); ob `/navigator` ohne Namespace auflöst, ist **zu messen**, bis dahin
`/session-orchestrator:navigator`. In Codex erscheint der Skill nach Neugenerierung und
Neuinstallation als `$session-orchestrator:navigator`; der Cache steht auf `5.3.0+codex.20260922063114`.

### 4.3 Was der SessionStart-Hook heute liefert und was dazukommt

`hooks/on-session-start.mjs` Z. 937–996 (origin/main): Zeile „Peers: N live on this host"
(Z. 973), getrennt nach „in THIS working copy" und „other repos (host capacity only)", Format mit
UUID-Kürzel (`fmt` ab Z. 968); Quelle ist die Registry, Codex eingeschlossen. Kein busy/idle
(Z. 991: `ListAgents` ist modellseitig). Neu (B6): **Mindesthinweis für alle SO-Sessions**, eine
Zeile „Navigator aktiv: <id>, Check-in nach ~/.config/navigator/checkin/" aus der Lease, oder „kein
Navigator aktiv". Das erreicht auch Sessions ohne `/session`, in Claude und Codex.

### 4.4 m5-remote-Offload für alle

`applyOffloadDecision()` greift nur bei Urteil `reduce` oder `coordinator-direct`
(`skills/remote-offload/SKILL.md` Abschnitt 1), und nur 2 von 8 geprüften Repo-`CLAUDE.md` deklarieren
`remote-hosts:` (repo-C, session-orchestrator). Heute trägt nur die Auflage die Regel. Vorschlag:
Owner-Entscheid E4 (offload-first) und Spalte „lokale Heavy-Prozesse" in `navigator status` (#31).

### 4.5 Last beim Verbraucher (Zeilen-/Byte-Plan, gemessen am Ist, Plan als Obergrenze)

`computeInstructionBudget` misst nur `.claude/rules` (`scripts/lib/instruction-budget-guard.mjs`
Z. 1145–1147) und sieht Skills und Hooks nicht. Gemessen wird deshalb beim Verbraucher:

| Verbraucher | Ist origin/main | Plan-Obergrenze | Wer zahlt |
|---|---|---|---|
| `session-start/SKILL.md` Phase 7.6 | 423 Z. / 43 649 B | + 12 Z. / + 1 200 B (Rest in B1) | jede `/session`, Claude und Codex |
| `operations-contract.md` | 114 Z. / 7 740 B | + 4 Z. / + 400 B | Operations-Route |
| `gitlab-ops/SKILL.md` B3 | 396 Z. / 24 588 B | + 6 Z. / + 600 B | jede Nutzung von gitlab-ops |
| Skill-Beschreibung `navigator` | 0 | ≤ 400 B | jede Session mit geladenem Plugin, auch Codex |
| Bannerzeile B6 | 0 | 1 Zeile ≤ 120 B | jede SO-Session |
| Codex-Inbox-Hook | 0 | ≤ 2 500 Token je Treffer (Deckel laut Recherche), 0 ohne neue Zeile | Codex-Sessions mit Inbox-Zeilen |
| `.claude/rules` | 467 Direktiven / 120 878 B von 480 / 121 000 | + 0 | alle |

## 5. Stufenplan

### S1 Protokoll-Dateien, Check-in, Mindesthinweis (SO, ~3 Tage)

Inhalt: B1, B2, B4, B5 (lesend), Bannerzeile aus B6.
Bestehenskriterien (alle aus Dateien und Events zählbar, ohne navigator-CLI):
- Check-in-Datei vor dem ersten Commit oder MR (Zeit `checkin.zeit` gegen erstes `git log`-Datum der
  Session) bei 5 von 5 `/session`-Sessions eines Owner-Starts.
- Lücke gezählt: Registry-Einträge ohne Check-in-Datei nach 30 min, als Zahl mit Population.
- 0 Doppelbelegungen: keine zwei gleichzeitigen Check-ins mit überlappenden `kandidaten` im selben Repo.
- Plan-Obergrenzen aus 4.5 eingehalten (`wc -lc` vor und nach).
Owner testet: fünf Sessions ohne Protokollhinweis im Prompt starten; Dateien unter `checkin/` zählen.

### S2 Merge als Zustand (navigator + SO, ~3 Tage)

Voraussetzung: B11 (CLI installiert). Inhalt: B3, B6, B8, B10.
Bestehenskriterien:
- 0 Merges mit Merge-SHA ≠ gepinnter SHA (Vergleich `done` gegen `ansage`).
- 0 Merges ohne Befugnisbeleg nach 3.5 (Ledger-Zeile oder `auftrag_ref`).
- Verfall: eine absichtlich verwaiste Ansage blockiert das Repo ≤ 20 min, 1 von 1.
- Dateien je Merge = 3 (Ansage, Lease oder eigene Messung, done); Hinweis-Nachrichten je Merge ≤ 1
  (**Hypothese**, erste Zählung in S2).
Owner testet: zwei Sessions, ein Repo, je ein MR; die zweite Lease entsteht erst nach der ersten
`done`-Datei; dann eine Session nach der Ansage abbrechen und den Verfall beobachten.

### S3 Codex-Adapter (SO + navigator, ~2 Tage plus Live-Test)

Inhalt: B7, Live-Test `codex queue` an einem Wegwerf-Thread der Desktop-App.
Bestehenskriterien:
- Eine gerahmte Inbox-Zeile erscheint im nächsten Turn als `additionalContext` (Beleg im Rollout),
  3 von 3; eine Zeile ohne passenden Ledger-Eintrag wird verworfen, 1 von 1.
- Check-in einer Codex-Session liegt vor ihrem ersten Commit in `checkin/`, 3 von 3.
- `codex queue`: Ergebnis dokumentiert (zugestellt ja/nein, Latenz), unabhängig vom Ausgang.
Owner testet: Hooks in der App vertrauen, Codex-Session starten, Auflagen im ersten Turn prüfen.

### S4 Einzelner Navigator, Übergabe, Tore (navigator, ~4 Tage)

Inhalt: B8 (Navigator-Lease), B9, `/navigator start` ruft `navigator slot check` statt `_start.sh`,
`/navigator handover`, Offload-Spalte (#31).
Bestehenskriterien:
- Zweiter Navigator bekommt keine Lease, solange die erste gilt, 1 von 1; Übergabe über
  `uebergabe_an` ohne Lücke.
- Belegt-Tor verweigert Start bei aktiver Codex-Session, 1 von 1 nachgestellten Fällen (wie 15:25).
- Übergabe zwischen zwei Koordinatoren ≤ 5 min (**Hypothese**; Hackathon H2: 10–20 min).
- Navigator-Hinweis-Nachrichten je Stunde bei fünf Peers ≤ 12 (**Hypothese**, Basiswert aus S1/S2).
Owner testet: Koordinator wechseln, Nachfolger arbeitet ohne Rückfrage weiter.

## 6. Anschluss an E3/E4 (Owner-Sicht)

- **Auftrag (E4, PRD-002 Z. 233–234):** Repos, Zeitfenster, Quota- und Modellplan, Kostenobergrenze,
  Verweis auf Autoritätsdateien, Signatur. Der Check-in referenziert ihn (`auftrag_ref`), die Auflagen
  dürfen ihn nur enger machen. Kostendeckel Topf 2 (direkte API) nach E4b (PRD-002 Z. 360–366);
  Abo- und CLI-Verbrauch nie in Euro.
- **Scoring (E3, PRD-002 Z. 227):** jede Lease ist eine Vorhersage („merge ok" mit gemessenen Fakten),
  die `done`-Datei plus main-Pipeline ist das Ergebnis; beide als Paar ins Ledger. `navigator ask`
  schreibt Vorhersage und Ausgang heute schon (`README.md`, Abschnitt `ask`).
- **Autonomie-Leiter (PRD-002 § 4.3):** dieses PRD hebt keine Sprosse. Es liefert die Datenpunkte, an
  denen eine spätere Hochstufung (E5) gemessen wird.

## 7. Risiken

| Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|
| Kurier-Last wächst | mehr Nachrichten statt weniger | Zustand in Dateien, Nachricht nur Hinweis; Zählung ab S1 |
| Merge hängt an Antwort | CSM Z. 44 verletzt, Stau bei wartendem Navigator | Lease als Datei mit Ablauf, danach eigene Messung oder `navigator ask` (3.4) |
| Verwaiste Ansage | Repo gesperrt | Verfall nach 20 min, MR ≠ opened oder neuem Head |
| Lease als Freigabe gelesen | ADR-002-Bruch | 3.5 verlangt Befugnis unabhängig von der Lease; Pflichtsatz in Auflagen |
| Gefälschte Inbox-Zeile | falsche Auflage in Codex | Rahmung, Ledger-Prüfung, Inbox trägt nie Leases; Restrisiko gleicher Nutzer bis Signatur |
| Zwei Navigatoren | widersprüchliche Leases | Navigator-Lease, Erwerb atomar (3.1) |
| `role`-Feld fehlt in alten Einträgen | Anzeige unvollständig | additiv; unbekannte Modi fallen schon heute auf `parallel-ok` zurück (`session-lock.mjs` Z. 542–577), Lease ist maßgeblich |
| Check-in erreicht nicht alle | Session ohne `/session` unsichtbar | Mindesthinweis per Hook, Lücke als Kennzahl |
| `codex queue` ungetestet | Codex hängt an Dateien + Hook | Queue nur nach Live-Test |
| Last in Skills/Hooks | Budget steigt unbemerkt | Plan-Obergrenzen 4.5, keine always-on-Rule |
| navigator-CLI nicht installiert | Ledger, Leases, Befugnis fehlen | B11 vor S2; ohne CLI jeder Merge `einzeln` |
| `codex-status.sh` zählt Subagents falsch | Lagebild unvollständig | Spalte `parent_thread_id` statt `parent`; heute `subagents_open=?` bei 6 von 6 |

## 8. Offene Owner-Entscheide

1. **E1 Arbeitsteilung** wie 4.1 (Protokoll, Adapter, Skill in SO; Mechanik als navigator-CLI). Empfehlung: ja.
2. **E2 Merge als Zustand** (Ansage/Lease-Dateien mit Ablauf, danach eigene Messung oder `ask`) statt Warten auf Zeichen. Empfehlung: ja.
3. **E3 Fristen:** Check-in-Rückfall 10 min, Ansage 20 min, Lease 15 min, Navigator-Lease 30 min. Empfehlung: ja, nach S2 nachmessen.
4. **E4 offload-first** als Session-Config-Schalter (Heavy-Rollen immer auf m5-remote, wenn bereit). Empfehlung: ja, eigenes SO-Issue.
5. **E5 Form:** Skill `navigator` (user-invocable) statt Command. Empfehlung: Skill, weil Codex nur Skills generiert bekommt.
6. **E6 Codex:** Dateien + Hook zuerst, `codex queue` nach Live-Test an Wegwerf-Thread. Empfehlung: ja.
7. **E7 Flottenpriorität als Datei** (`~/.config/navigator/prioritaet.yaml`). Empfehlung: ja.
8. **E8 Reihenfolge:** dieses PRD vor navigator#9; #28, #29, #30, #33 gehen in S2–S4 auf. Empfehlung: ja.
9. **E9 Befugnis vor Merge** nach 3.5 (authority query oder ausdrücklicher Auftrag). Empfehlung: ja; parallel Owner-Schlüssel in den Vertrauensanker (#20), sonst bleibt alles `einzeln`.
10. **E10 Inbox-Herkunft:** Ledger-Prüfung jetzt, SSH-Signatur je Zeile, sobald der Anker einen Schlüssel hat. Empfehlung: ja.
11. **E11 navigator-CLI auf dem lokalen Host installieren** (Voraussetzung S2). Empfehlung: ja.
12. **E12 Ein aktiver Navigator** per Lease, zweiter nur über Übergabe. Empfehlung: ja.

## Anhang A: Nachrichtenschemata vom 27.09.

### A.1 Anmeldung (session-A1 und session-D1, sinngemäß, nicht wörtlich archiviert)

```
Anmeldung <session> · Repo <repo> · Modus <deep|feature>
Owner-Auftrag: <ein Satz>
Stand: main <sha> · origin/main <sha> · Prod <sha> · offene MRs <!n, !m>
Kandidaten: #<n>, #<m> …
Fragen: Runner-/Pipeline-Budget? Speicher? Offload-Slots? Sperren? andere Sessions im Repo?
Rückfall (session-D1): schreibende erst nach deiner Antwort oder nach 10 min ohne Antwort mit den S76-Grenzen
```

### A.2 Auflagen (navigator-fd an alle fünf, Inhalt gleich; v1-Form, in v2 durch 3.3/3.4 ersetzt)

```
Caps: 2 prozessstartende + 2 lesende Agents, solange der lokale Host >= 50 % Speicher frei hat.
Pipelines: <= 2 volle je Repo; Nachzug-Pushes vorher anmelden.
Offload: nur Alias m5-remote, nur bei 5-min-Load < 12; alles Schwere dorthin; lokal nur vitest je Datei mit timeout.
Merge: Ansage (MR, Head-SHA, Pipeline-ID + Jobliste inkl. Pflichtjobs, Gate-Log-SHA = Head,
  Review-Stand, Migration ja/nein) -> ich messe am GitLab (Head = Pipeline-SHA = Gate-SHA,
  mergeable, main frei) -> Zeichen -> Merge -> Meldung main-Pipeline + Prod-SHA.
Zeiten nur aus date.
Freigaben erteile ich keine, dein Mandat ist der Owner-Auftrag.   [v2: „maßgeblich ist dein Owner-Auftrag"]
```

## Anhang B: Codex-Kanaltabelle

Quelle, soweit nicht als gemessen markiert: Codex-Recherche navigator-fd 15:35.

| Kanal | Richtung | Stand | Einsatz |
|---|---|---|---|
| SO-Registry (`platform: codex`) | lesen | gemessen: 5 Einträge 15:37 | Belegt-Tor, Banner |
| Rollout-JSONL (`session_meta`, `task_started`/`task_complete`) | lesen | im Einsatz (`_start.sh`, Ticker Schritt 4) | Turn-Grenzen, cwd |
| `state_5.sqlite` `threads`, `thread_spawn_edges` | lesen | im Einsatz (`codex-status.sh`), Spaltenfehler s. Risiken | cwd, Branch, Subagents |
| `thread_history_1.sqlite` `thread_turns.status` | lesen | `inProgress` allein heißt nicht busy (ADR-004) | Turn-Status |
| `lsof +d ~/.codex/thread-writer-locks` | lesen | gemessen: 6 Root-Threads 15:37 | geladene Threads |
| Protokolldateien `~/.config/navigator/*` | beide | neu (S1–S3) | Check-in, Auflagen, Merge |
| Hooks SessionStart/UserPromptSubmit/PostToolUse, `additionalContext` | schreiben | SessionStart + PostToolUse verdrahtet; Inbox-Leser fehlt | Hinweise, gerahmt |
| Hook Stop mit `decision:block` | schreiben | ungetestet | nicht für Steuerung |
| `codex queue --thread` | schreiben | CLI 0.153.4 vorhanden (gemessen); Desktop ungetestet | S3 Live-Test |
| App-Server `turn/steer`, `thread/inject_items` | schreiben | Desktop ohne Daemon, nicht andockbar | nicht nutzbar |
| `codex exec resume <id>` | schreiben | nur nicht geladene Threads | kopflose Codex-Läufe |

Bestehende Werkzeuge (Recherche, Sterne Stand 15:35): openai/codex-plugin-cc (33 623), smtg-ai/claude-squad
(8 537), kbwo/ccmanager (1 250), asheshgoplani/agent-deck (959), jazzyalex/agent-sessions (877),
fuergaosi233/claude-codex (99), daemon-james/codex-fleet (1, PostToolUse-Inbox-Hook, Muster für B7),
JaminZhou/codex-app-server-client (1). Keines deckt Befugnis, Merge-Lease und Registry ab.

## Messungen

v1: 2026-09-27 15:35–15:39 (Haupt-Checkout `ae452d33`). v2: 15:44–15:50 gegen origin/main `5d9bf2b6`
(`git show origin/main:<pfad>`, `date` 15:48:52).

```
# grep-Zensus "navigator" im SO (Wortgrenze, ohne node_modules/.git), Stand ae452d33
grep -rIl -w navigator skills hooks scripts .claude commands -> 1 Datei (.claude/STATE.md Z. 15, 86)
ganzes Repo ohne site/, eslint.config -> 8 Zeilen, funktional 0

# Zeilenzahlen (wc -l), SO skills/<x>/SKILL.md, ae452d33:
dispatcher 214 · autopilot 478 · remote-offload 89 · gitlab-portfolio 205 · ecosystem-health 122 · tmux-layout 111
session-start 423 · wave-executor 423 · session-end 314 · gitlab-ops 396 · _shared/parallel-aware-preamble.md 230
navigator: ticker/prompt-fd.md 16 · codex-status.sh 17 · session-S1/brief-phase1.md 168 · PRD-002 547
# origin/main (git show | wc -lc): session-start 423/43649 · gitlab-ops 396/24588
#   operations-contract.md 114/7740 · hooks-codex.json 60/1808

# Belegstellen origin/main 5d9bf2b6 (git show origin/main:<pfad> | grep -n)
cross-session-messaging.md:44 "Never gate a decision, a wave, or a commit on a peer's reply."
hooks/on-stop.mjs:398-418 heartbeat(sessionId) im Stop-Hook
hooks/on-session-start.mjs:353 rawMode · :938 Kommentar · :968 const fmt · :973 pushBanner Peers · :991 ListAgents modellseitig
scripts/lib/session-registry.mjs:202 registerSelf · :243 heartbeat(sessionId, patch) nur status/currentWave
scripts/lib/session-lock.mjs:542 safe classifyMode wrapper (-> parallel-ok) · :552 · :574
skills/gitlab-ops/SKILL.md:189 glab mr merge · :226 gh pr merge
skills/session-end/SKILL.md:197 "### 4.3 Push" · :199 git push origin HEAD
skills/session-start/SKILL.md:35 Operations route · :93-117 Phasen 1.1-1.7 · :327 7.1 · :342 7.5 · :353 8
scripts/lib/historical-guard.mjs:12 wrapHistorical · remote-dispatch.mjs:68 OFFLOAD_EXIT_REASONS
remote-offload/SKILL.md Frontmatter: user-invocable: false
event names (git grep orchestrator.x.y in scripts/lib): orchestrator.session.lock 23, .session.started 16 ...

# Instruktionsbudget (computeInstructionBudget), Stand ae452d33
navigator 602/480 Direktiven, 133408/121000 B (overBudget) · session-orchestrator 467/480, 120878/121000 (ok)

# Registry 15:37: 13 Dateien, 1 .tmp unlesbar, 12 lesbar: claude 7, codex 5; mode "session" 12 von 12
# Codex: codex-cli 0.153.4 · codex queue --help: --thread, --message · codex-status.sh: 6 Root-Threads,
#   subagents_open=? 6 von 6 · .schema thread_spawn_edges: parent_thread_id, child_thread_id, status
# CLI: command -v navigator leer · offload ~/.local/bin/offload
# remote-hosts: in 8 Repo-CLAUDE.md 2 Treffer (repo-C, session-orchestrator)
# navigator README: Z. 11 kein Owner-Schlüssel, jede Aktion einzeln · Z. 14 authority check Exit 1 · Z. 17 ask 0/3/4/2
# navigator-Issues (glab issue view, 15:36): #8, #9, #28 bis #35 open
```
