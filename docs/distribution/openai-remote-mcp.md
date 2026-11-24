# OpenAI-Verzeichnis: Paket mit entferntem MCP-Server

Stand: 2026-11-23 · Issue #2260 · Vorgänger: [openai-skills-only.md](./openai-skills-only.md)

## Warum

Das Plugin-Verzeichnis von OpenAI (ChatGPT und Codex) nimmt seit mindestens 2026-10-23 keine reinen Skill-Pakete mehr an. Das Portal meldet „We are not accepting more skills-only submissions at this time“. Offen ist der Weg „With MCP“: ein Paket, das einen öffentlich erreichbaren MCP-Server nennt. Lifecycle-Hooks liefert das Verzeichnis auf keinem Weg aus, und ein lokaler MCP-Server ist freigeschalteten Partnern vorbehalten. Das volle Plugin bleibt deshalb bei der Installation über GitHub oder npm.

Diese Variante enthält dieselben vier Skills wie das Skill-Paket und dazu einen Server, der nur liest: Er beantwortet Fragen aus der öffentlichen Dokumentation.

## Was der Server kann

Quellen: `server/mcp/`. Der Server hat keine Abhängigkeiten außer Node 24.

| Werkzeug | Zweck |
|---|---|
| `search` | Durchsucht die öffentliche Dokumentation und liefert passende Abschnitte mit Link |
| `fetch` | Liefert einen Abschnitt im Volltext |
| `list_skills` | Listet die Skills des vollen Plugins, optional gefiltert |
| `check_session_config` | Prüft einen Session-Config-Block: unbekannte Schlüssel mit Vorschlag, doppelte Schlüssel, nicht lesbare Zeilen |
| `get_release_notes` | Liefert die neueste oder eine genannte Version mit ihren Änderungen |

Alle Werkzeuge sind als lesend, geschlossen und nicht zerstörend gekennzeichnet. Keines greift auf das Netz, eine Datenbank oder das Dateisystem zu.

Der Wissensstand entsteht beim Image-Build: `server/mcp/build-corpus.mjs` liest README, die Dokumente unter `docs/`, die Skill-Köpfe und das Changelog und schreibt eine JSON-Datei. Jede Quelle muss im kuratierten öffentlichen Export stehen (`.orchestrator/policy/public-export.json`), sonst bricht der Build ab. Der Server kann also nichts ausliefern, was der öffentliche Spiegel nicht trägt.

## Datenschutz

Der Server speichert nichts. Er hat keine Datenbank und schreibt keine Dateien. Eingaben und Adressen werden nicht protokolliert, auch nicht am Proxy davor. Im Speicher liegen für höchstens 60 Sekunden Zähler je Adresse für die Ratenbegrenzung. Zähler je Werkzeug und Statuscode leben bis zum nächsten Neustart und stehen unter `/healthz`; sie enthalten weder Eingaben noch Adressen. Die Datenschutz- und die Nutzungsseite liefert der Server selbst aus (`/privacy`, `/terms`, Text in `server/mcp/pages.mjs`); wer den Server betreibt, steht nicht im Code, sondern kommt aus der Umgebung des Hosts. Wer Protokollierung, Speicherung oder Hosting ändert, ändert diesen Text im selben Commit.

## Paket bauen

```sh
node scripts/export-openai-skills.mjs --with-mcp --zip --out <ausgabeordner>
node scripts/export-openai-skills.mjs --with-mcp --check <ausgabeordner>/session-orchestrator.zip
```

Mit `--with-mcp` enthält das Paket zusätzlich eine `mcp.json` an der Wurzel, die genau diesen einen Server nennt, dazu fünf positive und drei negative Testfälle und die Release Notes im Manifest. Die Prüfung lehnt jede andere MCP-Konfiguration ab: eine fremde Adresse, einen zweiten Server, Kopfzeilen, einen lokalen Server. Ohne `--with-mcp` bleibt alles wie im Skill-Paket; dort ist jede MCP-Konfiguration ein Verstoß.

## Deploy

Der Server läuft als Container hinter einem TLS-Proxy. Der Container bindet nur an die private Adresse des Service-Hosts.

1. Build-Kontext aus dem Git-Stand erzeugen, nie aus dem Arbeitsverzeichnis, und zwar aus zwei Ständen: die Dokumente (`package.json`, `README.md`, `CHANGELOG.md`, die Dateien aus `DOC_SOURCES` und `skills/`) aus dem Release-Tag (`git archive v<version> <pfade> | tar -x -C <kontextordner>`), den Servercode (`server/mcp`, die zwei Module unter `scripts/lib/config`, `.orchestrator/policy/public-export.json`) aus dem Stand, der laufen soll. So beschreibt der Server die veröffentlichte Version und nicht unveröffentlichte Änderungen auf `main`, und keine ungetrackte Datei gelangt in den Wissensstand. `server/mcp/Dockerfile.dockerignore` lässt davon nur die benannten Quellen in den Build (Positivliste).
2. Den Kontextordner auf den Service-Host kopieren. Im Ordner `server/mcp/` eine `.env` anlegen: `BIND_ADDR=<private Adresse>`, `PORT=<Port>`, `SO_MCP_TAG=<Version>`, `SO_MCP_TRUSTED_PROXY=<Adresse des TLS-Proxys, wie der Container sie sieht>`, `SO_MCP_SUBNET=<freies privates /24>`, `SO_MCP_OPENAI_CHALLENGE=<Token aus dem Portal>`. Dazu die Angaben des Betreibers für die Datenschutz- und die Nutzungsseite: `SO_MCP_OPERATOR_NAME`, `SO_MCP_OPERATOR_ADDRESS`, `SO_MCP_OPERATOR_EMAIL`, `SO_MCP_OPERATOR_IMPRINT_URL`, `SO_MCP_HOSTING_PROCESSOR` (Name und Sitz des Hosters) und `SO_MCP_HOSTING_REGION` (wo verarbeitet wird, etwa „the European Union“; ohne Angabe nennt die Seite keine Region). Fehlen Name, Anschrift, E-Mail oder Hoster, antworten `/privacy` und `/terms` mit 404.
3. `docker compose build`, dann `docker compose up -d`. Erwartet: `docker inspect --format '{{.State.Health.Status}}' so-mcp` meldet `healthy`.
4. Am Proxy einen Vhost für den Host des Servers anlegen, der auf die private Adresse zeigt, ohne Access-Log und mit überschriebenem `X-Forwarded-For`, wie beim Telemetrie-Vhost ([deploy-runbook](../telemetry/deploy-runbook.md) § 4).
5. DNS: einen A-Eintrag für den Host auf den Proxy.
6. Prüfen: `curl https://<host>/healthz` liefert `{"status":"ok",…}`.

## Absicherung

Der Dienst ist öffentlich und ohne Anmeldung. Er wurde vor der Freischaltung von einem unabhängigen Security-Review geprüft (2026-11-23, kein kritischer oder hoher Befund). Was ihn eingrenzt:

- **Kein Weg nach außen im Code:** Kein Werkzeug öffnet eine Verbindung, liest eine Datei oder startet einen Prozess. Es gibt keine Abhängigkeiten.
- **Eingaben:** Größe je Anfrage höchstens 64 KB, Argumente gegen das Schema des Werkzeugs geprüft, Sammelanfragen (JSON-RPC-Batches) abgelehnt.
- **Ausgaben:** `check_session_config` nennt höchstens 25 Funde je Art, zitiert einen Schlüssel nur, wenn er wie ein Schlüssel aussieht, und meldet von einer nicht lesbaren Zeile nur Nummer und Länge. Freitext aus der Eingabe kommt so nicht als Werkzeug-Ergebnis zum aufrufenden Modell zurück.
- **Ratenbegrenzung:** je Adresse und Minute, IPv6 je /64. `X-Forwarded-For` gilt nur, wenn die Gegenstelle der eingetragene Proxy ist. Ist die Tabelle voll, teilen sich neue Adressen ein gemeinsames Kontingent; bekannte Clients behalten ihres.
- **Container:** Nicht-Root, schreibgeschütztes Dateisystem, ohne Capabilities, `no-new-privileges`, höchstens 256 MB, ein Kern und 64 Prozesse, Basis-Image per Digest festgelegt, gebunden nur an die private Adresse.

- **Netz:** eigenes Docker-Netz mit festem Subnetz und festem Bridge-Namen (`SO_MCP_SUBNET`: ein freies privates /24 des Hosts, Pflichtangabe in der `.env`; `SO_MCP_BRIDGE`, Vorgabe `so-mcp0`), damit Firewall-Regeln des Hosts es benennen können.

Offen als Härtung des Hosts (braucht Root, eigener Vorgang): den Port am Host nur für den Proxy öffnen und ausgehende Verbindungen aus diesem Subnetz sperren.

Der Container enthält keine Geheimnisse. Das Token für den Domain-Nachweis ist öffentlich abrufbar und damit kein Geheimnis.

Nach einem Release den Build-Kontext neu kopieren und neu bauen, damit der Wissensstand zur veröffentlichten Version passt. OpenAI scannt den Server nach der Veröffentlichung täglich; ein Ausfall gefährdet das Listing. Der Health-Endpunkt gehört deshalb in die Überwachung.

## Einreichen

1. Im Portal `platform.openai.com/plugins` einen neuen Entwurf über „With MCP“ anlegen und das ZIP hochladen. An einen bestehenden Skills-only-Entwurf lässt sich kein Server anhängen.
2. Unter „MCPs“ den Server verbinden: Das Portal zeigt ein Token für den Domain-Nachweis. Es kommt als `SO_MCP_OPENAI_CHALLENGE` in die `.env`; nach `docker compose up -d` liefert der Server es unter `/.well-known/openai-apps-challenge` aus.
3. Den Werkzeug-Scan abwarten und je Werkzeug die drei Kennzeichen begründen.
4. Die Demo-Aufnahme verlinken und einreichen. Der Absende-Klick braucht die Freigabe des Owners.

## Grenzen

- Im Verzeichnis stehen die vier Skills und der Server, nicht das volle Plugin mit Hooks.
- Die Suche ist eine einfache Wortsuche über Abschnitte. Revisit-Trigger: Nutzer finden belegbar Abschnitte nicht, die es gibt.
- `check_session_config` prüft Schlüssel der obersten Ebene gegen die Vorlage dieser Plugin-Version, keine Werte und keine Unterschlüssel. Revisit-Trigger: Der Parser bietet eine Werteprüfung als reine Funktion an.
- Das Changelog im Server reicht so weit zurück wie `CHANGELOG.md`; ältere Versionen stehen unter `docs/changelog/`.
