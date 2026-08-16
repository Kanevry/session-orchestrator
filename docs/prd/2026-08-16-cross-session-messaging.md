# Feature: Cross-Session Messaging — Transport für parallele Sessions

**Date:** 2026-08-16
**Author:** Operator + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 2w (Medium Batch, Cooldown 3 Tage)
**Parent Project:** session-orchestrator (standalone Feature)

> Alle Zahlen und Zitate in diesem Dokument stammen aus Messungen der Planungs-Session
> `main-2026-08-16-session-2` (Claude Code 2.1.233, macOS arm64). Das vollständige
> Messprotokoll steht in Anhang A. Behauptungen ohne Messung sind als solche markiert.

---

## 1. Problem & Motivation

### What

Claude Code hat mit v2.1.224 zwei Werkzeuge nativ bekommen — `ListAgents` (entdecken) und
`SendMessage` (zustellen) —, mit denen unabhängige Sessions einander Text schicken können.
Der Session-Orchestrator kannte beide nicht: **vor diesem PRD** kam `ListAgents` im gesamten Repo **0×** vor,
`SendMessage` genau **1×**, und zwar als Prosa in `docs/adr/0002-agent-teams-substrate.md`.

Dieses Feature verdrahtet die native Fläche in den Orchestrator, korrigiert die dadurch
veraltete Entscheidungslage, schließt die Cross-Host-Lücke in unserer Session-Sicht und
schreibt einen erprobten, provider-neutralen Standardpfad auf, den fremde Nutzer bei ihrem
eigenen Anbieter nachbauen können.

**Die These, auf der das Feature steht:**

> **Messaging ist Transport, kein geteilter Zustand.**

Es ersetzt weder den Session-Lock noch STATE.md noch die Filescope-Dekonfliktierung. Es
schließt genau eine Lücke, die wir nie geschlossen hatten: *ein Befund erreicht die andere
Session nicht.*

Der Beleg für die These kam in derselben Session von außen. Eine parallele Session in
diesem Working Copy berichtete: zwei ihrer Wave-Agenten trugen widersprüchliche Fakten
(„npm-Paket existiert nicht" gegen eine Registry-Widerlegung), und der Widerspruch fiel
**nur dem Koordinator auf**, weil dort beide Berichte zusammenliefen. Ihre eigene
Formulierung, nachdem sie eine stärkere Behauptung von sich aus zurückgenommen hatte:
*„Parallel laufende Subagenten teilen keinen Faktenstand; Widersprüche zwischen ihnen
fallen nur dem Koordinator auf."* Ein Kanal hätte diesen Ort nicht ersetzt.

### Why

**Der Auslöser war ein Erlebnis, kein Ticket.** In einem anderen Repo lief eine Session in
eine rote Pipeline, fand die Ursache in zwei Dateien einer *parallelen* Session, und gab den
Befund direkt an sie weiter, statt in fremdem Scope zu editieren (was PSA-002 verbietet)
oder den Operator zum Boten zu machen. Die Empfängerin verifizierte den Befund selbst
nach, statt ihn zu übernehmen — genau die Haltung, die `receiving-review.md` RCR-003
verlangt.

Vier Treiber, alle vom Operator bestätigt:

1. **Befundübertragung.** Für genau diese Reibung existiert **kein** offenes Issue —
   Suchen nach `notification`, `handoff` und `copy-paste` liefern null relevante Treffer
   im offenen Backlog (`glab issue list --per-page 100 | grep -cE "^#[0-9]+"` → **77**, gemessen 2026-08-16; der `--per-page`-Deckel liegt bei 100, die Zahl ist damit vollständig). Reines Neuland, kein Backlog-Abgleich.
2. **Ressourcen-Kontrolle über mehrere Hosts.** Auf dem Entwicklungs-Mac liefen zum
   Messzeitpunkt 13 Claude-Prozesse mit zusammen 4,4 GB RSS und 52 % CPU. Unsere
   Host-Registry weiß, in welchem Repo und Branch jede Session steckt — aber nur lokal,
   und ihr Heartbeat wird nie aktualisiert.
3. **Toter Spike.** `#484` blockiert seit 2026-05-19 auf einer manuellen, interaktiv-only
   Vorbedingung, deren Nutzen jetzt nativ und ohne Experimental-Flag verfügbar ist.
4. **Plattform-Differenzierung.** Codex CLI und Cursor haben nachweislich nichts
   Vergleichbares (§ 5, Fremdlage). Das ist ein Argument für die Claude-Code-Lane.

### Who

Ein Operator mit einer Flotte paralleler Sessions über mehrere Rechner — plus die fremden
Nutzer des Plugins, für die der Server-Pfad reproduzierbar sein muss, ohne unseren
Host-Zustand zu erben. Zweiter Konsument ist der Koordinator-Agent selbst, der die native
Fläche heute weder kennt noch benutzen darf.

---

## 2. Solution & Scope

Vier Arbeitsblöcke. A und C liefern Nutzen, B räumt auf, D macht es teilbar.
**13 In-Scope-Positionen** (A1–A5, B1–B4, C1, D1–D3). C2 ist vorweg als eigenständiges
Bug-Issue herausgelöst (siehe Kasten unten), C3 wurde im Review gestrichen (siehe
Out-of-Scope).

### In-Scope

**A — Live-Achse: die native Fläche verdrahten**

- [ ] **A1** Neue Regel `.claude/rules/cross-session-messaging.md` mit genau fünf IDs:
      **CSM-001** Sende-Entscheidung (wann eine Peer-Session informiert wird statt zu
      pausieren oder in fremdem Scope zu editieren) · **CSM-002** Behandlung eingehender
      Fremd-Nachrichten (verifizieren statt übernehmen — RCR-003; Herkunft als Fremdbefund
      mit Quelle und Datum zitieren) · **CSM-003** Verbot der Permission-Wäsche ·
      **CSM-004** Zustellung ist nie garantiert (Ausbleiben ≠ Ablehnung ≠ Zustimmung) ·
      **CSM-005** Verfügbarkeits-Degradation (die vier stillen Abschalter, Windows,
      Nicht-Anthropic-Provider).
- [ ] **A2** `parallel-sessions.md`: PSA-001/PSA-002-Entscheidungsbaum um den Zweig
      „Signal gehört einer erreichbaren Peer-Session → informiere sie, statt zu pausieren
      oder in fremdem Scope zu editieren" erweitern. Die Zwei-Achsen-Formulierung bleibt,
      ihre Begründung ändert sich (siehe B2).
- [ ] **A3** Session-Start-Sicht: native Liveness mit unserer Semantik verheiraten. **Zwei
      Hälften an zwei Ausführungsorten — das ist keine Kosmetik, sondern eine harte
      Grenze:** `ListAgents` ist ein **modellseitiges Werkzeug**; `hooks/on-session-start.mjs`
      ist ein Node-Prozess und kann es nicht aufrufen. Der einzige Nicht-Werkzeug-Kanal wäre
      der Roh-Socket, und der ist gemessen unbrauchbar (M-6) und ausdrücklich Out-of-Scope.
      - **A3a (Hook, bleibt wo es ist):** das bestehende Peer-Banner in
        `hooks/on-session-start.mjs` liefert weiter die Registry-Semantik
        (`repo_name`, `branch`, `mode`, `current_wave`) und weist aus, dass Liveness dort
        strukturell nicht verfügbar ist.
      - **A3b (Koordinator, Skill-Prosa):** `skills/session-start/SKILL.md` ruft in der
        Peer-Erkennungsphase `ListAgents` auf und legt den nativen Status
        (`busy`/`waiting`/`idle`) über die Hook-Zeilen.
      **Circuit-Breaker:** A3b ist die einzige Position, die `skills/session-start/SKILL.md`
      und dessen Testfläche berührt. Fällt A3b aus, bleiben A1/A2/A4/A5, B, C und D
      unabhängig lieferbar — die vier Blöcke sind nicht gekoppelt.
- [ ] **A4** Agent→Koordinator-Eskalation: `SendMessage` opt-in in die `tools:`-Allowlist.
      **Auswahlkriterium:** nur Agenten, deren Scheitern eine Wave blockiert — also die
      schreibenden Implementierer und die Gate-relevanten Reviewer. Konkret die sechs:
      `code-implementer`, `db-specialist`, `ui-developer`, `test-writer`, `docs-writer`,
      `session-reviewer`. **Nicht** die reinen Analyse- und Urteils-Agenten
      (`analyst`, `qa-strategist`, `architect-reviewer`, `security-reviewer`,
      `ux-evaluator`, `eval-judge`, `skill-applied-judge`, `dialectic-deriver`) — deren
      Befund ist per Konstruktion erst am Ende vollständig, eine Zwischenmeldung hätte
      keinen Adressatennutzen. (`agents/AGENTS.md` ist die Authoring-Spec und
      `agents/memory-proposal-collector.md` laut eigenem Frontmatter Referenzdoku — beide
      sind keine dispatchbaren Agenten und stehen deshalb in keiner der beiden Listen.)
- [ ] **A5** `READ_ONLY_TOOLS` in `scripts/lib/validate/tier-inference.mjs` um
      `SendMessage` und `ListAgents` erweitern (mechanische Vorbedingung für A4, siehe § 4).

**B — Obsoleszenz auflösen**

- [ ] **B1** `#484` schließen mit Supersede-Begründung: die eine Fähigkeit, deren Nutzen der
      Spike messen sollte, ist nativ verfügbar — ohne Experimental-Flag, ohne die
      7×-Plan-Mode-Token-Kosten, ohne maschinen-eigene `config.json`.
- [ ] **B2** `docs/adr/0002-agent-teams-substrate.md` um einen datierten Nachtrag ergänzen:
      die „11-vs-1"-Prämisse ist überholt; der Adapter-Verdikt kollabiert zu **Stay**, weil
      die Gegenleistung entfallen ist. Die H3/H4-Vorbedingung wird nicht mehr gebraucht.
- [ ] **B3** Neue `docs/adr/0013-cross-session-messaging.md`: Verdikt **Adopt** für die
      Live-Achse, **Spike** für Remote Control, mit dem Messprotokoll als Evidenz.
- [ ] **B4** `.claude/rules/loop-and-monitor.md`: LM-002a (Channels) um die Abgrenzung zu
      Cross-Session-Messaging ergänzen — Channels ist *extern → Session*, Messaging ist
      *eigene Session ↔ eigene Session*.

**C — Cross-Host-Sicht (asynchron, ohne Vorschau-Abhängigkeit)**

- [ ] **C1** `host`-Feld in die Vault-Mirror-Session-Notizen und eine `Host`-Spalte in den
      Board-Renderer. **Nur für neu geschriebene Notizen — kein Backfill.** Bestehende
      Notizen ohne `host` bleiben gültig; der Board-Parser muss Zeilen ohne die Spalte
      weiterlesen können.

      Messung (2026-08-16, `~/Projects/vault`):
      `find 50-sessions -name '*.md' -type f | wc -l` → **2241** Notizen gesamt,
      davon **347** im Namespace `session-orchestrator`;
      `grep -rl '^host:' 50-sessions | wc -l` → **0**;
      `grep -c '^| ' 01-projects/_active-sessions.md` → **43** Board-Zeilen, keine mit Host.
> **C2 ist per Operator-Entscheidung vom 2026-08-16 aus dieser Batch herausgelöst** und
> läuft als eigenständiges Bug-Issue (`priority::high`) vorweg: der Defekt ist heute aktiv,
> er trifft Konsumenten außerhalb dieses Features (`autopilot`-Peer-Zählung, cross-repo
> Semantic-ID-Eindeutigkeit) und wartet auf nichts aus A/B/C/D. Die folgende Analyse bleibt
> hier stehen, weil sie in dieser Planungs-Session entstand und das Bug-Issue sie zitiert;
> **sie zählt nicht zu den In-Scope-Positionen dieser Batch.** Die zugehörigen
> Akzeptanzkriterien in §3 und die Risiko-Zeile R-10 gelten für das Bug-Issue.

- [x] **C2 → eigenes Bug-Issue** Host-Registry verliert lebende Sessions — **aktiver Defekt.**
      `heartbeat()` existiert in `scripts/lib/session-registry.mjs:227` und hat **null
      Produktions-Aufrufer** (nur drei in `tests/lib/session-registry.test.mjs`). Es kam im
      allerersten Commit des Moduls mit (`aa3e1e2 feat(lib): add session-registry.mjs —
      multi-session heartbeat + sweep`); kein Commit hat je einen Aufrufer entfernt, weil es
      nie einen gab. Also nie verdrahtet, nicht bewusst abgeschaltet.

      **Gemessener Schaden (2026-08-16, 14:17Z):** Registry meldet **3** Einträge, alle mit
      totem PID, während **12** Sockets gebunden sind. Das `sweep.log` weist die Löschung
      lebender Sessions nach — u.a. `age_minutes: 72` um 13:35Z für eine Session, die
      danach noch antwortete.

      **Ursache — zweiteilig.** Der schnellere und stärkere Teil wurde erst im dritten
      Review-Durchgang sichtbar:

      1. **Deregistrierung pro Turn (dominant).** `hooks/on-stop.mjs` ruft ungegatet
         `deregisterSelf(sessionId)`. `Stop` feuert am **Turn-Ende**, nicht am Session-Ende —
         die Datei sagt es zwei Zeilen tiefer selbst: *„Epic #583 W5-F1c — refresh
         session.lock heartbeat on **every turn-end**"*. Derselbe Hook-Lauf frischt also den
         **Lock** auf und **löscht** den **Registry-Eintrag**. Epic #583 hat exakt diesen
         Fehler für den Lock behoben (`release` → `updateHeartbeat`, Begründung: *„release-on-
         Stop would delete the lock after the first assistant turn → session goes blind"*) —
         für die Registry steht dieselbe Korrektur aus. Das erklärt den Messbefund besser als
         Veralterung: 3 Einträge gegen 12 Sockets heißt, **neun Sessions haben gar keinen
         Eintrag**, und veraltete Einträge blieben laut `session-registry.mjs:281-282`
         ohnehin liegen. Zudem läuft `sweepZombies` nur beim Session-**Start**
         (`hooks/on-session-start.mjs:573`) — eine laufende Session kann sich nicht selbst
         wegsweepen.
      2. **Nie fortschreitender Heartbeat (nachgelagert).** Selbst ein überlebender Eintrag
         behielte `last_heartbeat == started_at`, weil `heartbeat()` keinen Aufrufer hat.
         Dann greifen die Filter gegen lebende Sessions: `detectPeers({freshnessMin: 15})`
         blendet nach 15 min aus, `sweepZombies({thresholdMin: 60})` löscht nach 60 min.

      **Der Schnitt folgt deshalb #583 W5-F1c:** auf `Stop` **`heartbeat()` statt
      `deregisterSelf()`**; die Deregistrierung wandert an das echte Session-Ende
      (`/close` bzw. `hooks/on-session-end.mjs`). Ein `heartbeat()` *vor* einem
      `deregisterSelf()` im selben Lauf wäre ein No-op.

      **Blast-Radius, präzise — im dritten Review korrigiert.** Die ursprüngliche Annahme
      („Exklusivitäts-Prüfung über Worktree-/Repo-Grenzen") ist **falsch**:
      `scripts/lib/session-discovery.mjs:224-227` filtert die Registry-Hälfte auf
      `e.repo_path_hash === myRepoHash`, also denselben Pfad; ein Peer in einem anderen
      Worktree wird über sein eigenes, geheartbeatetes `session.lock` gefunden.
      Tatsächlich betroffen sind die **host-weiten** Konsumenten:
      - `scripts/autopilot.mjs:314` — `detectPeers({freshnessMin: 15})` als `peerCounter`;
        unterzählt Peers und schwächt damit ein Autopilot-Gate.
      - `hooks/on-session-start.mjs:380` — `readRegistry()` in `deriveSemanticCandidate`,
        laut eigenem Kommentar die single source of truth für **cross-repo** uniqueness.
        Hier wirkt nicht der Filter, sondern die Löschung: fehlende Einträge ⇒
        Semantic-Session-ID-Kollision über Repo-Grenzen.
      - `scripts/lib/vault-status/board-writer.mjs:290` / `:418` — die Board-**Status**spalte
        liest primär `session.lock` (der wird geheartbeatet) und ist deshalb weitgehend
        robust; es gibt aber einen Rückfallpfad über `isRegistryEntryFresh()`, wenn kein
        lebender Lock vorliegt. C1 baut genau diese Datei um — der Pfad ist also zu testen,
        nicht wegzuannehmen.

      **Kein Config-Schlüssel.** Es gibt keinen legitimen Aus-Zustand; die Alternative zu
      einer ehrlichen Registry ist eine, die lügt. Kosten sind ein atomarer Schreibvorgang
      auf eine sessioneigene Datei (keine geteilte Datei, keine Contention), die Daten sind
      host-lokal und werden nie committet. Ein Schalter dafür wäre ein BV-001.1-Verstoß.
      **Aufrufstellen:** `hooks/on-stop.mjs` — `deregisterSelf()` durch `heartbeat()`
      ersetzen (nicht ergänzen); `hooks/on-session-end.mjs` — Deregistrierung dorthin
      verschieben; zusätzlich der Inter-Wave-Checkpoint des wave-executors.
      **Kadenz:** mindestens einmal je Wave und je `Stop`-Ereignis; die Leseseite bleibt bei
      der bestehenden `freshnessMin`-Semantik der Registry (15 min), das AC verlangt nur,
      dass der Wert überhaupt fortschreitet.

**D — Teilbarkeit: der erprobte Standardpfad**

- [ ] **D1** Runbook für einen Server-Worker bei einem **beliebigen** Anbieter, mit unserem
      empfohlenen Default-Pfad. Provider-neutral formuliert; unser Hetzner-Lauf ist das
      Beispiel, nicht die Vorschrift.
- [ ] **D2** Saubere Trennung der Ebenen: host-lokale Konfiguration in `owner.yaml`
      (nie committet), das Teilbare in `templates/`. Kein Host-Zustand im ausgelieferten Pfad.
- [ ] **D3** Verfügbarkeits-Vorprüfung, die die stillen Abschalter benennt (§ 5, R-1).

### Out-of-Scope

- **Agent↔Agent-Mesh.** Gemessen: `ListAgents` ist einem Subagenten nicht ladbar, er kann
  seine Geschwister nicht entdecken. Ein Mesh müssten wir bauen, indem wir Geschwister-IDs
  in Prompts injizieren — gegen die Plattform-Absicht, und es löst den Koordinator als
  einzigen Ort auf, an dem Widersprüche sichtbar werden. Dieselbe Begründung wie PSA-007
  für den Git-Index.
- **Roh-Socket / eigener Hook-Kanal.** Gemessen: 10 Frame-Formate an den Inbox-Socket,
  **0 zugestellt, 0 Fehlermeldungen**. Das Wire-Protokoll ist undokumentiert und der
  Fehlermodus still. Für asynchrone Einspeisung bleibt `.orchestrator/STEER.md` die
  einzige Fläche.
- **Echter Token-/Kostenverbrauch als Automatisierungs-Quelle.** Gemessen: die CLI hat kein
  `usage`/`cost`-Kommando; `gateway` ist der Enterprise-OTEL-Pfad. In der Session ist der
  Verbrauch über den `Usage`-Reiter von `/status` **sichtbar**, aber nicht skriptbar. C
  liefert deshalb nur die Proxies, die es tatsächlich schreibt — Dauer, Waves, Agenten,
  geänderte Dateien je Session-Notiz —, keine Kosten. *Host-Auslastung ist bewusst NICHT
  dabei:* sie ist zwar gemessen (M-18), aber keine C-Position liefert sie, und eine
  Aufzählung ohne Lieferant ist ein Versprechen, das die Abnahme nicht einlöst.
- **Aufrollung „welche Session hat zuletzt was getan, auf welchem Host".** Ursprünglich als
  C3 geplant, im Review gestrichen: kein Artefakt, keine Datei, kein Akzeptanzkriterium —
  als einzige Position nicht abnehmbar, und inhaltlich überlappend mit dem Board, das C1
  gerade umbaut. Wird ein Follow-up-Issue mit eigener Falsifikationsfrage, sobald C1 liegt
  und man sieht, was die Host-Spalte allein schon beantwortet.
- **Remote Control innerhalb dieser 2w.** Gemessen ist der Stand geteilt, nicht „läuft":
  **Zustellung** über die Maschinengrenze funktioniert (M-17), **Entdeckung ist
  asymmetrisch** — der Mac sieht die Box, die Box sieht nichts (M-16) —, und
  `-p --remote-control` baut trotz `/rc`-Anzeige **keine** echte Verbindung (M-15). Dazu
  Research Preview und die einzige Komponente ohne stabilen Vertrag. Wandert in ein eigenes
  Spike-Issue mit eigener Falsifikationsfrage.

---

## 3. Acceptance Criteria

### A — Live-Achse

```gherkin
Given eine zweite Claude-Code-Session ist im selben Working Copy aktiv
When der SessionStart-Hook sein Peer-Banner rendert
Then nennt es je Peer Repo, Branch, Mode und Wave aus der Host-Registry
 And es weist aus, dass Liveness im Hook strukturell nicht verfügbar ist
 And es behauptet KEINEN nativen Status
```

```gherkin
Given der Hook hat sein Peer-Banner gerendert
When der Koordinator die Peer-Erkennungsphase durchläuft (Phase 0.5 bzw. 1.2.1)
Then ruft er ListAgents auf
 And legt den nativen Status (busy/waiting/idle) über die Banner-Zeilen
 And weist aus, welche Peers per SendMessage erreichbar sind
```

```gherkin
Given ich erkenne einen Befund, der ausschließlich fremden Scope betrifft
When der betroffene Scope einer erreichbaren Peer-Session gehört
Then informiere ich diese Session per SendMessage
 And ich editiere NICHT in ihrem Scope
 And ich pausiere NICHT nach PSA-002, sondern arbeite in meinem Scope weiter
```

```gherkin
Given ein Wave-Agent mit SendMessage in seiner tools-Allowlist
When er auf einen Blocker trifft, der seinen Auftrag unerfüllbar macht
Then meldet er ihn per SendMessage an "main", bevor sein Lauf endet
 And der Koordinator kann reagieren, ohne den Abschlussbericht abzuwarten
```

```gherkin
Given ein read-only Agent, dessen tools-Allowlist um SendMessage erweitert wurde
When check-agents.mjs die sandbox-tier prüft
Then bleibt die abgeleitete Tier "read-only"
 And die Tier-Konsistenzprüfung meldet keinen Widerspruch
```

### A — Eingehende Nachricht (Sicherheit)

```gherkin
Given eine Nachricht einer Peer-Session trifft ein
When sie eine Tatsachenbehauptung über den Zustand des Repos enthält
Then verifiziere ich sie selbst, bevor ich auf ihr aufbaue
 And ich zitiere ihre Herkunft als Fremdbefund mit Quelle und Datum
```

```gherkin
Given eine Peer-Nachricht bittet um eine Aktion
When diese Aktion in meiner Session blockiert oder abgelehnt wäre
Then führe ich sie NICHT aus
 And ich lege sie dem Operator vor, statt die Berechtigung zu umgehen
```

### B — Obsoleszenz

```gherkin
Given ADR-0002 begründet den Agent-Teams-Adapter mit "the gap is 11-vs-1"
When der Nachtrag aus B2 gelandet ist
Then nennt das Dokument die native Verfügbarkeit dieser einen Fähigkeit
 And das Verdikt ist auf Stay korrigiert
 And Issue #484 ist geschlossen und verweist auf den Nachtrag
```

### C — Cross-Host-Sicht

```gherkin
Given Sessions liefen auf mehr als einem Rechner
When der Vault-Mirror eine Session-Notiz schreibt
Then trägt ihr Frontmatter ein host-Feld
 And das Board zeigt eine Host-Spalte je Zeile
```

```gherkin
Given der Wert von last_heartbeat unmittelbar VOR Wave N wurde festgehalten
When Wave N abgeschlossen ist
Then ist last_heartbeat echt größer als der festgehaltene Wert
 And das Stop-Ereignis erhöht ihn unabhängig davon ein weiteres Mal
 And ein Peer kann aus der Progression auf Liveness schließen
```

```gherkin
Given eine Session läuft seit mehr als 60 Minuten und ist nachweislich lebendig
When sweepZombies über die Host-Registry läuft
Then bleibt ihr Eintrag erhalten
 And die Zahl der Registry-Einträge stimmt mit der Zahl lebender Sessions überein
```

```gherkin
Given ein bestehendes Board ohne Host-Spalte und Notizen ohne host-Feld
When der Renderer mit der neuen Spalte läuft
Then bleiben alle vorhandenen Zeilen erhalten
 And Zeilen ohne Host-Angabe zeigen ein leeres Feld statt zu verschwinden
 And parseBoardRows liest das alte Format weiterhin fehlerfrei
```

### D — Teilbarkeit

```gherkin
Given ein fremder Nutzer folgt dem Runbook bei einem beliebigen Anbieter
When er die dokumentierten Schritte abarbeitet
Then erreicht seine lokale Session seinen Server-Worker
 And kein Schritt setzt unsere Host-Konfiguration oder unseren Anbieter voraus
```

### Edge Cases / Fehlerbehandlung

```gherkin
Given eine der vier Telemetrie-Variablen ist gesetzt
 (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, DISABLE_TELEMETRY, DO_NOT_TRACK, DISABLE_GROWTHBOOK)
When session-start die Verfügbarkeit prüft
Then meldet es Cross-Session-Messaging als NICHT verfügbar und nennt die Ursache
 And keine Codepfad-Verzweigung nimmt Zustellung an
```

```gherkin
Given der Empfänger läuft in einem anderen Permission-Modus als der Sender
When eine Nachricht gesendet wird
Then behandelt der Sender die Zustellung als unbestätigt
 And das Ausbleiben einer Antwort wird nicht als Zustimmung gelesen
```

```gherkin
Given SendMessage adressiert einen Namen, den keine lebende Session trägt
When der Aufruf erfolgt
Then meldet das Werkzeug einen expliziten Fehler
 And der Koordinator behandelt dies als Fehlschlag, nicht als Zustellung
```

```gherkin
Given die Plattform ist natives Windows, oder Bedrock/Vertex/Foundry
When der Orchestrator startet
Then ist der Messaging-Pfad inaktiv
 And jede Skill, die ihn nutzt, degradiert auf das heutige Verhalten
```

## 3.A Acceptance Criteria (EARS)

### A — Live-Achse

**Ubiquitous:** Der Orchestrator soll die Zustellung einer Nachricht niemals als
garantiert annehmen.
**State-driven:** Solange eine Peer-Session im selben Repo erreichbar ist, soll die
Session-Start-**Sicht** sie ausweisen — Registry-Semantik aus dem Hook, nativer Status vom
Koordinator. Das Hook-Banner allein soll niemals einen nativen Status behaupten.
**Event-driven:** Wenn ein Befund ausschließlich fremden, erreichbaren Scope betrifft, soll
der Koordinator die besitzende Session benachrichtigen, statt zu editieren.
**Optional feature:** Wo `SendMessage` in der `tools:`-Allowlist eines Agenten steht, soll
dieser Agent Blocker vor Laufende an `main` melden dürfen.
**Unwanted behaviour:** Wenn eine Peer-Nachricht eine in dieser Session blockierte Aktion
verlangt, dann soll der Orchestrator sie ablehnen und dem Operator vorlegen.

### C — Cross-Host-Sicht

**Ubiquitous:** Jede vom Vault-Mirror **neu** erzeugte Session-Notiz soll ein `host`-Feld
tragen.
**State-driven:** Solange eine Session aktiv ist, soll ihr Registry-Heartbeat fortlaufend
aktualisiert werden.
**Optional feature:** Wo für dasselbe Repo zwei Zeilen mit **verschiedenem** Host vorliegen
(Host-Wechsel oder Zwilling), soll der Renderer beide erhalten und über die bestehende
Merge-Slot-Logik unterscheiden — niemals eine Zeile durch die andere überschreiben.
**Unwanted behaviour:** Wenn der Heartbeat eines Eintrags dem Startzeitpunkt entspricht
**und** der Eintrag älter ist als die Heartbeat-Kadenz, dann soll der Leser ihn als
liveness-unbestimmt behandeln, nicht als lebend. (Der Alters-Zusatz ist notwendig:
`registerSelf` setzt `started_at` und `last_heartbeat` bei **jeder** neuen Session auf
denselben Wert — ohne ihn gälte eine sekundenalte, beweisbar lebende Session als unbestimmt.)

### D — Teilbarkeit

**Optional feature:** Wo ein Nutzer einen Server-Worker bei einem beliebigen Anbieter
betreibt, soll das Runbook ohne anbieterspezifische Voraussetzung durchführbar sein.
**Unwanted behaviour:** Wenn eine der vier Telemetrie-Variablen gesetzt ist, dann soll die
Vorprüfung Messaging als nicht verfügbar melden und die verursachende Variable benennen.
**Unwanted behaviour:** Wenn der ausgelieferte Pfad einen host-lokalen Wert benötigen würde,
dann soll er stattdessen auf `owner.yaml` verweisen und niemals einen konkreten Host,
Anbieter oder Pfad dieses Rechners enthalten.

---

## 4. Technical Notes

### Affected Files

| Datei | Änderung |
|---|---|
| `.claude/rules/cross-session-messaging.md` | **neu** — CSM-001..005 |
| `.claude/rules/parallel-sessions.md` | PSA-Entscheidungsbaum um den Peer-Informieren-Zweig; Zwei-Achsen-Begründung nachziehen |
| `.claude/rules/loop-and-monitor.md` | LM-002a: Abgrenzung Channels ↔ Cross-Session-Messaging |
| `scripts/lib/validate/tier-inference.mjs` | `READ_ONLY_TOOLS` um `SendMessage`, `ListAgents` |
| `agents/*.md` (Auswahl) | `tools:` opt-in um `SendMessage`; `agents/AGENTS.md` § Authoring-Konvention nachziehen |
| `hooks/on-session-start.mjs` | A3a — Peer-Banner behält Registry-Semantik und weist aus, dass Liveness dort strukturell fehlt (Hook kann `ListAgents` nicht rufen) |
| `skills/session-start/SKILL.md` | A3b — Koordinator ruft `ListAgents` und legt nativen Status über die Hook-Zeilen |
| `scripts/lib/session-registry.mjs` | Heartbeat-Aktualisierung (C2) |
| `scripts/lib/vault-status/board-writer.mjs` | `Host`-Spalte im Renderer |
| `skills/vault-mirror/SKILL.md` + Mirror-Code | `host`-Feld im Notiz-Frontmatter |
| `docs/adr/0002-agent-teams-substrate.md` | datierter Nachtrag, Verdikt → Stay |
| `docs/adr/0013-cross-session-messaging.md` | **neu** |
| `templates/_shared/rules/` | Regel-Kopie für ausgeliefernde Repos |
| `docs/` (Runbook) | D1/D2/D3 |

### Architecture

**Zwei Registries, eine Ehe.** Nativ und eigen wissen Verschiedenes:

| | nativ (`ListAgents` / Inbox-Socket) | eigen (`sessions/active/`) |
|---|---|---|
| Liveness | ✔ `busy` / `waiting` / `idle` | ✘ Heartbeat tot |
| Adressierbarkeit | ✔ Name ist die Adresse | ✘ |
| Repo / Branch / Mode / Wave | ✘ (nur cwd in `/list-agents`) | ✔ |
| Host-übergreifend | nur mit Remote Control | ✘ host-lokal |

Wir ersetzen nichts. Native Liveness beantwortet „lebt es?", unsere Registry „was tut es?".
Die Verheiratung ist eine Anzeige-Ebene, keine neue Datenhaltung.

**Hierarchie statt Mesh.** Gemessen: ein Subagent kann `SendMessage` nutzen, aber
`ListAgents` nicht laden. Nach oben senden geht, seitwärts entdecken nicht. Das Design
folgt dem: Koordinator ↔ Agent bidirektional, Agent ↔ Agent nie.

**Der mechanische Stolperstein (A5).** `READ_ONLY_TOOLS` in `tier-inference.mjs` kennt heute
`{Read, Grep, Glob, Bash, Skill}`; alles Unbekannte fällt auf den sicheren Default
`repo-write`. Gemessen:

```
heute: session-reviewer            -> read-only
+SendMessage (read-only Agent)     -> repo-write   ← kippt
```

A5 ist damit harte Vorbedingung für A4, nicht Nacharbeit.

**Drei Ebenen sauber trennen (D2).** Host-lokal (`owner.yaml`, nie committet) ·
repo-committet (Session Config) · ausgeliefert (`templates/`). Der Server-Pfad darf keinen
Host-Zustand erben — dieselbe Trennung, die `owner-persona.md` für die Persona-Ebene
etabliert hat.

### Data Model Changes

- Vault-Session-Notiz-Frontmatter: neues optionales Feld `host` (Schema-Erweiterung,
  abwärtskompatibel — die bestehenden **2241** Notizen bleiben ohne das Feld gültig und
  werden nicht nachgezogen, siehe § 2 C1).
- Board-Zeile: neue Spalte `Host`. `parseBoardRows` muss alte Zeilen ohne die Spalte
  weiter lesen können.
- Registry-Eintrag: keine Feldänderung, nur die Aktualisierung von `last_heartbeat`.

### API Changes

Keine. Beide Werkzeuge sind Plattform-Fläche; wir verändern nur, wer sie in `tools:` stehen
hat und wo unsere Skills sie nennen.

---

## 5. Risks & Dependencies

| # | Risiko | Impact | Mitigation | Triage |
|---|---|---|---|---|
| R-1 | Vier Telemetrie-Variablen schalten Messaging **still** ab | hoch — Feature verschwindet ohne Fehlermeldung | Verfügbarkeits-Vorprüfung (D3), die die Variable benennt; jeder Pfad degradiert auf heutiges Verhalten | Implement |
| R-2 | Zustellung ist nicht garantiert; `hold`/`refuse` sind für den Sender teils unsichtbar | hoch — ein Kanal, dem man vertraut, ist gefährlicher als keiner | Zustellung nie als Zustimmung lesen (AC oben); Ausbleiben ≠ Ablehnung | Implement |
| R-3 | Fremde Session als Prompt-Injection-Fläche | hoch | CSM-Regel: verifizieren statt übernehmen; Permission-Wäsche explizit verboten. Plattform hilft: Nachricht kann nichts genehmigen, keine Config ändern, keine Kommandos ausführen | Implement |
| R-4 | Bekannte Plattform-Bugs: Socket-Bind schlägt bei einer von zwei gleichzeitig gestarteten Sessions fehl (still einseitiger Kanal, `anthropics/claude-code#84945`); auf Windows Zustellung ohne Absenden (`#86014`, `#86069`) | mittel | Fehler laut behandeln; kein Pfad, der Stille als Erfolg liest | Implement |
| R-5 | Approval-Reibung bei vielen Sessions (`#78706`, offen: ~10 Klicks je Koordinationsrunde) | mittel | Für Worker den dokumentierten `crossSessionInbound: accept`-Pfad nutzen; nie als Default für interaktive Sessions | Experiment |
| R-6 | Nicht auf nativem Windows, nicht auf Bedrock/Vertex/Foundry | mittel — betrifft fremde Nutzer | Degradation auf heutiges Verhalten; im Runbook benannt | Implement |
| R-7 | Remote Control ist Research Preview und kann sich ändern | mittel | Aus der 2w-Batch ausgeschlossen; eigenes Spike-Issue | Experiment |
| R-8 | Ein 1 Jahr gültiges Abo-Credential liegt auf einer internet-erreichbaren Box und im Klartext in einem lokalen Transkript (`setup-token` druckt ihn; unvermeidbar in diesem Flow) | mittel | Operator-Entscheidung: bleibt bestehen. Dokumentiert, damit es nicht später als Überraschung auftaucht. Auf der Box in einer 0600-Datei, tmux-Puffer gelöscht | Defer |
| R-9 | C1 berührt `vault-mirror` (`grep -rl "vault-mirror" tests/ \| wc -l` → **26** Testdateien, 2026-08-16) und den 7-Spalten-Board-Vertrag — der längste Testschwanz im Umfang | mittel | Kein Backfill (§2 C1); `parseBoardRows` muss alte Zeilen weiterlesen, das ist ein eigenes AC | Implement |
| R-10 | Die Host-Registry verliert **heute schon** lebende Sessions — `deregisterSelf()` feuert pro Turn-Ende (gemessen: 3 Einträge mit totem PID gegen 12 gebundene Sockets; `sweep.log` weist Löschung einer noch antwortenden Session bei `age_minutes: 72` nach). Jede Entscheidung, die sie liest, arbeitet auf falschen Daten — insbesondere die Exklusivitäts-Prüfung über Worktree-/Repo-Grenzen hinweg | hoch | C2, und zwar früh in der Batch. Falsifizierbarer Nachweis: nach dem Fix muss die Zahl der Einträge der Zahl lebender Sessions entsprechen (eigenes AC) | Implement |

**Rejected (kein Issue, Begründung hier):** ein eigener Koordinations-Daemon über dem
Roh-Socket — geringer Nutzen bei hohem Risiko, weil das Wire-Protokoll undokumentiert ist
und still verwirft (Low-Impact + High-Risk).

> **Herkunft der Risiko-Belege:** R-1, R-2, R-6 und R-8 stammen aus der offiziellen
> Plattform-Dokumentation; R-4 und R-5 nennen offene `anthropics/claude-code`-Issues und
> sind **Fremdrecherche vom 2026-08-16**, von uns nicht nachmessbar. Alle übrigen Zahlen
> im **Fließtext** sind eigene Messungen mit zitiertem Befehl. Im Messprotokoll (Anhang A)
> tragen nicht alle Zeilen den Befehl inline — dort steht die Beobachtung, der Befehl ist
> in der Session protokolliert.

### Dependencies

- **`#595`** — Sunset der v1-Lock/Registry-Kompatibilitätspfade, fällig **2026-08-25**
  (Tag ~9 dieser Batch), `priority:low`, berührt `session-lock.mjs` +
  `session-registry.mjs`, also dieselbe Datei wie C2.
  **Die Kopplung ist Merge-Reihenfolge, keine semantische Abhängigkeit.** C2 fügt
  Aufrufe einer bereits existierenden Funktion hinzu; #595 entfernt v1-Lesepfade. Beide
  können unabhängig landen. Regel deshalb: **#595 zuerst, wenn es bis Tag 9 liegt** —
  sonst landet C2 zuerst und #595 rebased darauf. Die Batch wartet nicht auf ein
  `priority:low`-Issue. (Der Reviewer wollte C2 ganz aus der Batch nehmen; dagegen steht,
  dass C2 klein bleibt und ein Merge-Konflikt keine Blockade ist. Die frühere Begründung
  „reine Verdrahtung" trägt nach dem korrigierten Schnitt **nicht mehr**: ein
  Semantikwechsel in `on-stop.mjs` — löschen statt auffrischen — ist derselbe Eingriffstyp
  wie #583 W5-F1c, klein, aber kein bloßes Hinzufügen von Aufrufen.) Ein inhaltlicher Berührungspunkt bleibt: beide
  Seiten belegen dasselbe Prädikat `last_heartbeat == started_at`, aber aus **zwei
  verschiedenen Quellen** — #595 entfernt die v1-Normalisierung im **Lock**
  (`session-lock.mjs:188-192`), während das **Registry-Seeding** (`registerSelf`,
  `session-registry.mjs:213-214`) es weiter erzeugt und auch nach C2 erzeugen wird. Wer
  zuletzt landet, prüft die andere Seite.
- **`#484`** — wird durch B1 geschlossen (supersede).
- **`#861`** (ACPX-Transport-Adapter) — teilweise überholt: die `send`/Adressierungs-Fläche
  ist für Claude-Code-Sessions nativ abgedeckt. Bleibt als **Nicht-Claude**-Transport
  gültig; neu zuschneiden, nicht schließen.
- **`#1026`** — Residual 1 („`--assert-disjoint` hat keinen Liveness-Begriff"): `ListAgents`
  liefert genau das fehlende Laufzeit-Orakel. Teilweise überholt.
- **`#869`** — die `entries-vs-messages`-Abgrenzung ist genau die Sprache, die B3/B4
  brauchen. In dieses PRD hineinziehen statt als Doku-Kleinigkeit liegen lassen.
- **`#868`** (kumulatives files-touched-Ledger) — Persistenz bleibt nötig (Resume über
  Sessions hinweg); die In-Run-Polling-Begründung entfällt.
- **ADR-364** (`proposed`) hat zwei Zeilen derselben Entscheidungstabelle (Z. 39 und Z. 51) **mit verschiedenen Begründungen**
  verworfen, die nicht vermengt werden dürfen:
  *continuous tracker poller* → reject, weil es *„pushes us toward 'always-on service'
  which contradicts the CLI plugin shape"*; *warm-machine / VM-leased* → reject, weil
  *„We are filesystem-resident, not VM-leased."*
  Der D-Block korrigiert **nur die erste** Position, und zwar begrenzt: ein adressierbarer
  Worker ist kein Dienst — er pollt nichts, er wird angesprochen. Die warm-machine-Ablehnung
  ist von D gar nicht berührt.

---

## Anhang A — Messprotokoll (2026-08-16)

Alle Messungen aus `main-2026-08-16-session-2`, Claude Code **2.1.233**, macOS arm64.
Hostnamen, IPs und private Repo-Slugs sind ersetzt.

| # | Messung | Ergebnis |
|---|---|---|
| M-1 | Repo-Zensus (**vor diesem PRD**) | `ListAgents` 0 Treffer, `SendMessage` 1 (Prosa in ADR-0002), `crossSession` 0, `PushNotification` 0 |
| M-2 | `ListAgents` live | 11 Peer-Sessions mit Name, `busy`/`waiting`/`idle`, Laufzeit |
| M-3 | Socket-Verzeichnis macOS | `/tmp/cc-socks/`, 12 Sockets, `srw-------`, nur eigener OS-User |
| M-4 | Zustellung Session→Session | 2 vollständige Round-Trips mit einer parallelen Session im selben Working Copy |
| M-5 | Nachrichten-Header | `from="uds:…"`, `from-name="…"`, **`from-mode="bypass"`** — der Permission-Modus des Senders wird offengelegt |
| M-6 | Roh-Socket | 10 Frame-Formate mit gültigem Auth-Frame → **0 zugestellt, 0 Fehler** |
| M-7 | Subagent mit `*`-Tools | `SendMessage` verfügbar, **`ListAgents` nicht ladbar**; Senden an unbekannten Namen liefert expliziten Fehler |
| M-8 | Repo-eigener Agent (`tools: Read, Grep, Glob, Bash`) | beide Werkzeuge **nicht verfügbar** — Allowlist greift mechanisch |
| M-9 | Koordinator → beschäftigter Agent | zugestellt bei Tick 1; 6 Zeitstempel in exakt 15-s-Abständen ohne Lücke ⇒ **kein laufender Tool-Aufruf unterbrochen** |
| M-10 | Headless `-p`-Worker mit `crossSessionInbound: accept` | erscheint in `ListAgents`, nimmt Nachricht **unbeaufsichtigt** an |
| M-11 | Tier-Inferenz | `+SendMessage` kippt einen read-only-Agenten auf `repo-write` |
| M-12 | Server-Box | Ubuntu 24.04, 4 Kerne/8 GB, Claude Code 2.1.233 — identisch zum Mac |
| M-13 | Auth-Scopes | `setup-token` liefert nur `user:inference`; interaktiv + RC verlangt zusätzlich `user:sessions:claude_code`, `org:create_api_key`, `user:mcp_servers`, `user:file_upload`, `user:profile` |
| M-14 | Socket-Pfad Linux | `uds:/run/user/0/cc-socks/<pid>.sock` (XDG) statt `/tmp/cc-socks` |
| M-15 | `-p --remote-control` | meldet `/rc`, baut aber **keine** echte RC-Verbindung — sah den Peer nicht |
| M-16 | Interaktiv + RC beidseitig | Mac sieht `[running] · <server> · Remote Control`; **Server sieht nichts** („No subagents or other Claude sessions") |
| M-17 | Cross-Host-Zustellung | Mac → Server **angekommen**, mit Reply-Adresse. Gemessen ist **nur diese Richtung**; die Rückrichtung ist durch die mitgelieferte Reply-Adresse angelegt, aber nicht eigenständig gemessen. **Entdeckung** ist nachweislich asymmetrisch (M-16) |
| M-18 | Ressourcen Mac | 13 Claude-Prozesse, 4,4 GB RSS (Ø 350 MB), 52 % CPU, 24 GB RAM. Modell-Inferenz läuft nicht lokal — verschoben wird Werkzeug-Last |
| M-19 | Vault als Cross-Host-Kanal | `find 50-sessions -name '*.md' -type f \| wc -l` → **2241** (davon **347** im Namespace `session-orchestrator`); `find 40-learnings -name '*.md' -type f \| wc -l` → **4620**; `grep -rl '^host:' 50-sessions \| wc -l` → **0**; `grep -c '^\| ' 01-projects/_active-sessions.md` → **43** Zeilen, keine Host-Spalte. Git-synchronisiert. **Korrektur:** eine frühere Fassung nannte 249 und 908 — das waren `ls`-Verzeichniseinträge auf Ebene 1, nicht Notizen (eigener PSA-006-Verstoß, im Review gefunden) |
| M-20 | `.orchestrator/metrics/*.jsonl` | gitignoriert (`.gitignore:40`) ⇒ host-lokal, kein Cross-Host-Kanal |
| M-21 | Usage | kein `usage`/`cost`-Kommando in der CLI; in der Session über den `Usage`-Reiter von `/status` sichtbar |
| M-22 | Host-Registry verliert lebende Sessions | `ls ~/.config/session-orchestrator/sessions/active/*.json \| wc -l` → **3** (alle mit totem PID) gegen `ls /tmp/cc-socks/*.sock \| wc -l` → **12**, 14:17Z. Die eigene, seit 12:47Z laufende Session war bereits gelöscht. `sweep.log` weist u.a. `age_minutes: 72` um 13:35Z für eine Session nach, die anschließend noch auf eine Nachricht antwortete. Ursache **zweiteilig** (im dritten Review präzisiert): dominant ist `deregisterSelf()` in `hooks/on-stop.mjs`, das **pro Turn-Ende** feuert und den Eintrag nach dem ersten Assistenten-Turn entfernt — neun der zwölf Sessions haben deshalb gar keinen Eintrag; nachgelagert bleibt `heartbeat()` ohne Produktions-Aufrufer, wodurch überlebende Einträge auf `last_heartbeat == started_at` stehen und von `detectPeers` (15 min) ausgeblendet bzw. von `sweepZombies` (60 min) gelöscht werden |
| M-23 | Kein eigenes `/config` | `ls commands/` → 25 Kommandos, keines für Konfiguration. Session Config wird von Hand in der CLAUDE.md gepflegt (`parse-config.mjs` liest, `claude-md-drift-check` Check 6 erzwingt Parität, `/bootstrap` schreibt beim Erstlauf) |

**Fremdlage (Recherche, keine eigene Messung):** Codex CLI hat Session-Resume, Subagents,
MCP und ein App-Server-JSON-RPC (`thread/loaded/list` + `turn/start` — für einen
einbettenden Host, nicht Session→Session), aber **keine** Peer-Entdeckung, keinen Lock und
keine Registry; belegt durch offene Issues zu SQLite-Lock-Contention, Worktree-Interferenz
und einen offenen Wunsch nach einer Agent-View. Cursor: nur Parent→Child-Subagents.
**Claude Code ist die einzige der drei Plattformen mit einem echten Peer-Message-Bus.**

**Fremdbefund (Parallel-Session `main-2026-08-16-session-1`, 2026-08-16):** Subagenten
überleben den Parent-Exit als Transkript auf Platte und lassen sich per `SendMessage` an die
Agent-ID fortsetzen — koordinator-getriggert, kein Auto-Restart. Die Session hat eine
zweite, stärkere Behauptung von sich aus auf das Belegbare zurückgenommen; übernommen ist
nur die abgeschwächte Fassung (siehe § 1).
