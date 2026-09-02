# PRD: Skill `journey-audit` — Nutzersicht-Produktaudit als wiederholbare Deep-Session

Herkunft: <consumer-repo>-Session (Erstlauf, manuell orchestriert). Ergebnis dort:
5 P0-Befunde (unverlinktes Kernfeature, verbrannte Gratis-Quota, Plan-Gate-Bypass, Claim-vs-Code-
Widerspruch, EUR-Texte im USD-Kontext), 18 Issues, Fix-Welle. Aufwand: 7 Agenten, ~1,2 M
Subagent-Tokens, ~3 h Wall-Clock (2 Rollen auf M5 offloaded). Dossier im Ziel-Repo dokumentiert.

## Problem

Compliance-Tests und Code-Reviews prüfen Code gegen Code. Niemand prüft systematisch das
PRODUKT gegen die Nutzererfahrung: Was verspricht die Website, was tut der Code, was erleben
echte Nutzer, was kommt per Mail an, was wird real genutzt? Die teuersten Defekte des Erstlaufs
(Feature ohne Einstiegspunkt, Owner nach Hard-Bounce dauerhaft stumm, 50 % bezahlte Events ohne
Aktivierung) sind für jede Code-zentrische Prüfung unsichtbar.

## Lösung: Skill `journey-audit` (Deep-Session-Modus) + per-Repo `journey-manifest`

### Die 7 Rollen (Wellen-Template, alle read-only außer R5)

| R | Rolle | Generisch | Repo-spezifisch (aus Manifest) |
|---|---|---|---|
| R1 | Flow-Zensus | Trigger→Empfänger→Zeitpunkt→Dedupe-Karte aller Outbound-Touchpoints (Mail/Push/Webhook) | Template-Verzeichnis, Send-Pfad, Cron-Quellen |
| R2 | Artefakt-Rendering | Templates zu HTML rendern, Screenshots Desktop/Mobile/Dark, Konsistenz-Matrix | Render-Idiom (z. B. react-email), Beispiel-Props |
| R3 | Claim-vs-Code-Matrix | Jede Marketing-/FAQ-/Chat-Behauptung gegen SSOT-Konstanten; Feature-Inventar × Darstellungs-Flächen | SSOT-Dateien, i18n-Namespaces, Chat-Fakten-Quelle |
| R4 | Anonymer Live-Rundgang | agent-browser, Desktop+Mobile, Chat-Interview mit Wahrheits-Schlüssel, tote Links, Konsole | Routen-Liste, Chat-Fragen + Soll-Antworten |
| R5 | Echter E2E-Durchstich | Prod, echter Account, jeden Kern-Flow wirklich ausführen, DB-Gegenprobe, Mail-Log-Abgleich | SAFETY-Block (Pflicht): erlaubte Konten/Events, No-Go-Aktionen, Checkout-Grenze, Cleanup-Regel |
| R6 | Realdaten-Funnel | Nutzungs-Funnel, nie-gefeuerte Flows, Zustell-Defekte, Nicht-Messbares benennen | DB-Zugang (read-only!), Identitäts-Regeln, Mail-Provider-API |
| R7 | Plattform-Ausnutzung | Eigenbau-vs-Plattform-Matrix (Hosting/DB/Realtime/Queues/CDN/WAF), Limits bei 10× | CLI-Logins, Plan-Erwartung, offene Perf-Issues |

### Koordinator-Disziplin (Kern des Werts, nicht optional)

1. **Jede P0-Behauptung eines Agenten wird vom Koordinator einzeln nachgeprüft** (eigener grep/curl),
   bevor sie ins Dossier geht. Erstlauf: 2 Agentenfehler gefangen („instant unerreichbar" — war
   UI-wählbar; „USD auf Prod" — war Session-Artefakt), 3 P0 bestätigt.
2. Dossier nach festem Format nach `docs/audits/YYYY-MM-DD-user-journey-audit.md` (P0 Geld/Kern,
   P1 Flows, P1 UX, P2 Inhalt, P2 Plattform, Realdaten, Marketing-Hebel).
3. Abschluss-AUQ: Fix-Wellen-Pakete (multiSelect) + Issue-Erzeugung; Issue-Batch nach
   Label-Taxonomie des Repos.
4. Parallel-Session-Protokoll: Peer-Koordination vor Start (Dateihoheit), i18n-Dateien als
   bekannter Engpass — EIN Agent besitzt sie.
5. Offload-fähig: R6/R7 sind reine CLI/API-Rollen → headless auf Zweitrechner (`claude -p`).
   Falle aus dem Erstlauf: `-p` druckt nur die LETZTE Nachricht — Prompt muss verlangen, dass der
   Vollbericht in der letzten Nachricht steht und keine Hintergrundprozesse laufen.

### Manifest (`.orchestrator/journey-manifest.md` im Ziel-Repo)

Personas + Einstiegspunkte, Wahrheits-SSOTs, Chat-Interview (Frage→Soll-Antwort), R5-SAFETY-Block,
Credential-Quellen (env-Namen, nie Werte), Realdaten-Queries, bekannte Ausnahmen. <consumer-repo>
bekommt das erste Manifest, destilliert aus den 7 Agenten-Prompts des Erstlaufs (im
Session-Transkript dokumentiert).

### Kadenz & Abgrenzung

- Quartalsweise oder nach großen Feature-Drops; bewusst KEINE CI-Component (teuer, urteilslastig).
- Optional monatliche Light-Variante (nur R3+R4) als geplante Cloud-Session.
- Abgrenzung zu `/discovery`: discovery prüft Code-Qualität innen-nach-außen; journey-audit prüft
  Produkt-Wahrheit außen-nach-innen. Kein Ersatz, Ergänzung.
- Folgeprinzip: mechanisierbare Teile pro Repo einfrieren (`pnpm report:*`-Skripte,
  Claim-Drift-Compliance-Tests), damit Folgeläufe billiger werden.

## Akzeptanzkriterien

1. `/journey-audit` lädt das Skill, verweigert ohne Manifest mit Hinweis auf Template.
2. Manifest-Template unter `templates/` mit SAFETY-Block als Pflichtfeld.
3. Wellen-Template dispatcht R1–R7 (R5 nur wenn SAFETY-Block vorhanden und Operator bestätigt).
4. Dossier-Format + Issue-Batch wie oben; Koordinator-Nachprüfung als expliziter Phase-Schritt.
5. Dry-run-fähig: ohne R5/R6 (keine Prod-Writes, keine Realdaten) bleibt der Rest lauffähig.
