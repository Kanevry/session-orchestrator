# Submission Kit — Externe Distribution-Kanäle

Dieses Kit macht jeden externen Submission-Schritt zu einem 5-Minuten-Browser-Task: pro Kanal eine nummerierte Ablauf-Checkliste plus ein copy-paste-fertiger Text, den der Operator ohne eigene Formulierungsarbeit absenden kann. Stand 2026-07-18 — basiert ausschließlich auf der fetch-verifizierten Recherche in [`2026-07-18-distribution-options.md`](./2026-07-18-distribution-options.md) (6 Research-Agents, alle Kanal-Fakten heute gegen die jeweilige Plattform geprüft). Sektionen sind nach Priorität sortiert (P1 = größter/dringendster Hebel zuerst); jede Sektion nennt Prio, URL, Voraussetzungen, Ablauf-Checkliste, den absendbaren Text und wie das Ergebnis verifiziert wird.

**Kanonische Tagline** (wortgleich in den Copy-Paste-Texten verwendet, wo passend): "Loop engineering for AI coding agents — turn ad-hoc sessions into a repeatable research → plan → wave-execute → close loop with verification gates. Runs on Claude Code, Codex CLI, Cursor, and Pi."

---

## A1 — Anthropic Community-Marketplace (Pin-Refresh)

**Prio:** P1 — bereits gelistet, aber Installs laufen aktuell gegen einen 3 Monate alten Stand.

**URL:** [platform.claude.com/plugins/submit](https://platform.claude.com/plugins/submit) (auth-gated Console-Formular; Kurzlink `clau.de/plugin-directory-submission`)

**Voraussetzungen:**
- Anthropic-Account-Login im Browser.
- `claude plugin validate` lokal grün (heute bereits bestätigt: „Validation passed").
- Der Katalog-Eintrag existiert bereits (SHA `fdb27d9`, 2026-04-07, ~588 Commits hinter HEAD) — das ist ein Refresh, keine Neu-Einreichung. PRs gegen `anthropics/claude-plugins-community` werden automatisch geschlossen — nur das Formular funktioniert.

**Ablauf-Checkliste:**
1. `claude plugin validate` (lokal) erneut laufen lassen und Output als Beleg griffbereit halten.
2. Sicherstellen, dass der GitHub-Mirror `Kanevry/session-orchestrator` auf dem aktuellen `main`-HEAD steht.
3. `platform.claude.com/plugins/submit` im Browser öffnen, mit Anthropic-Account einloggen.
4. Formular ausfüllen: Repo-URL, Freitextfeld mit dem Copy-Paste-Text unten füllen.
5. Absenden, Bestätigungs-/Ticket-ID (falls angezeigt) notieren.
6. Nach Freigabe: in einer Test-Instanz `/plugin install session-orchestrator@claude-community` ausführen und die installierte Version prüfen.

**Copy-Paste-Text:**
```
Requesting a catalog refresh for an existing listing.

Plugin: session-orchestrator
Repository: https://github.com/Kanevry/session-orchestrator
Current catalog pin: fdb27d9 (2026-04-07), approximately 588 commits behind HEAD.
Current version: 3.14.0 (validated locally with `claude plugin validate`).

The catalog metadata (description, homepage) is stale relative to the current
.claude-plugin/plugin.json. Requesting:
1. A pin refresh to the current HEAD commit on the `main` branch.
2. A metadata refresh — homepage is now https://session-orchestrator.com;
   updated description: "Loop engineering for AI coding agents — turn ad-hoc
   sessions into a repeatable research → plan → wave-execute → close loop
   with verification gates. Runs on Claude Code, Codex CLI, Cursor, and Pi."

We have not observed the documented automatic CI pin-bump take effect for
this listing since the initial SHA pin — flagging this in case there is a
configuration gap on our end (e.g. missing webhook or label) we should fix.

Contact: office@gotzendorfer.at
```

**Erwartetes Ergebnis + Verifikation:** Katalog-Pin zeigt auf aktuellen `main`-HEAD statt `fdb27d9`, Metadaten decken sich mit `.claude-plugin/plugin.json`. Verifikation: `/plugin install session-orchestrator@claude-community` in Claude Code installiert Version 3.14.0 (oder höher), nicht den alten Snapshot.

---

## npm-Publish (Voraussetzung für Pi-Kanal — nur Verweis)

**Prio:** P1 — schaltet den Pi-Kanal, den npx-Einstieg und das npm-Badge frei; blockiert B7 unten.

**URL:** kein externes Formular — reiner Operator-CLI-Schritt (`npm publish`, erfordert npm-Auth). Vollständige Anleitung: [`docs/distribution/npm-publish-checklist.md`](npm-publish-checklist.md).

**Voraussetzungen:** npm-Auth (`npm whoami`), Leakage-Gate (`npm pack --dry-run`) sauber, Typecheck/Test grün.

**Ablauf-Checkliste:**
1. `docs/distribution/npm-publish-checklist.md` Schritt 1–4 durchgehen (Auth, Version, Leakage-Gate, Supporting Gates).
2. Bei grünem Leakage-Gate: Schritt 5 (`npm publish --access public`) ausführen.
3. Schritt 6 (Post-Publish-Verifikation) durchgehen.
4. Danach: `docs/pi-setup.md` § Installation aktualisieren (Caveat „not yet available" entfernen) — separater Doku-Task, nicht Teil dieses Kits.
5. Erst NACH erfolgreichem Publish mit Kanal B7 (Pi-Community) weitermachen.

**Vorab-Check-Snippet** (kein Submission-Text, aber copy-paste-fähig zur schnellen Bereitschaftsprüfung):
```bash
npm whoami
npm view session-orchestrator version 2>&1 || echo "not yet published"
npm pack --dry-run 2>&1 | tail -5
```

**Erwartetes Ergebnis + Verifikation:** Paket unter `session-orchestrator` auf npm veröffentlicht. Verifikation: `npm view session-orchestrator version` zeigt die publizierte Version; `pi.dev/packages` listet `session-orchestrator` nach dem nächsten Gallery-Sync (nicht instantan).

---

## A2 — claudemarketplaces.com

**Prio:** P2 — valides Manifest, aber nicht indexiert; Zero-Cost sobald der Crawl greift.

**URL:** [claudemarketplaces.com](https://claudemarketplaces.com) · Issue-Tracker: [github.com/mertbuilds/claudemarketplaces.com](https://github.com/mertbuilds/claudemarketplaces.com)

**Voraussetzungen:** GitHub-Login. `.claude-plugin/marketplace.json` bereits valide (`claude plugin validate --strict` läuft heute grün).

**Ablauf-Checkliste:**
1. `claude plugin validate --strict` erneut lokal laufen lassen, Output als Beleg sichern.
2. `github.com/mertbuilds/claudemarketplaces.com/issues/new` im Browser öffnen, mit GitHub-Account einloggen.
3. Neues Issue mit dem Copy-Paste-Text unten anlegen.
4. Absenden, Issue-Link notieren.
5. Nach ein paar Tagen: `claudemarketplaces.com` nach "session-orchestrator" durchsuchen.

**Copy-Paste-Text:**
```
Title: Plugin not indexed despite valid marketplace.json — session-orchestrator

Repository: https://github.com/Kanevry/session-orchestrator
Manifest: .claude-plugin/marketplace.json (validated locally with
`claude plugin validate --strict`, passes with no errors)

The repository has been public with a valid marketplace manifest for some
time, but does not appear indexed on claudemarketplaces.com yet. Could you
check whether the auto-crawl has picked it up, or whether there is a
schema/discovery issue on our end blocking the crawl?

Plugin summary: Loop engineering for AI coding agents — turn ad-hoc sessions
into a repeatable research → plan → wave-execute → close loop with
verification gates. Runs on Claude Code, Codex CLI, Cursor, and Pi.

Happy to make any manifest adjustments needed. Thanks for maintaining the
directory.
```

**Erwartetes Ergebnis + Verifikation:** Crawl nachgeholt oder Root-Cause benannt. Verifikation: Suche auf `claudemarketplaces.com` nach "session-orchestrator" zeigt einen Eintrag.

---

## B4 — cursor.directory

**Prio:** P2 — jetzt offizielles Cursor-Community-Verzeichnis, 10-Minuten-Task.

**URL:** [cursor.directory/plugins/new](https://cursor.directory/plugins/new)

**Voraussetzungen:** GitHub- oder Google-Login. Repo öffentlich (ist es: `Kanevry/session-orchestrator`).

**Ablauf-Checkliste:**
1. `cursor.directory/plugins/new` öffnen, mit GitHub oder Google einloggen.
2. Repo-URL `https://github.com/Kanevry/session-orchestrator` eintragen.
3. Auto-Detection abwarten (Standard: Skills unter `skills/*/SKILL.md`, Agents unter `agents/*.md`).
4. Automatischen Security-Check (safe/suspicious/malicious) abwarten; bei "suspicious" das Ergebnis nicht ignorieren, sondern gegenlesen.
5. Freitext-/Beschreibungsfeld mit dem Copy-Paste-Text unten füllen.
6. Absenden.

**Copy-Paste-Text:**
```
Loop engineering for AI coding agents — turn ad-hoc sessions into a
repeatable research → plan → wave-execute → close loop with verification
gates. Runs on Claude Code, Codex CLI, Cursor, and Pi.
```

**Erwartete Gaps (nicht nacharbeiten vor Submission, nur zur Kenntnis):** Die Cursor-"Rules"-Kategorie erwartet `rules/*.mdc` — unsere Regeln liegen als `.md` unter `.claude/rules/`, werden also vermutlich nicht erkannt. Die "Hooks"-Kategorie erwartet `hooks/hooks.json` — diese Datei existiert bei uns (verifiziert: `hooks/hooks.json` liegt im Repo), sollte also erkannt werden.

**Erwartetes Ergebnis + Verifikation:** Repo gelistet, Security-Status "safe". Verifikation: Suche auf `cursor.directory` nach "session-orchestrator" zeigt den Eintrag samt erkannten Kategorien (Skills ✓, Agents ✓).

---

## B3a — awesome-codex-cli (PR-Eintrag)

**Prio:** P2 — größte Codex-Ökosystem-Liste, passende Kategorien vorhanden.

**URL:** [github.com/RoggeOhta/awesome-codex-cli](https://github.com/RoggeOhta/awesome-codex-cli) (420 Stars, Lizenz CC0) · Alternative: Kommentar in [openai/codex Discussion #16329](https://github.com/openai/codex/discussions/16329)

**Voraussetzungen:** GitHub-Account, Fork-Rechte (Standard). Kategorien "Multi-Agent Orchestration" bzw. "Session & Workflow Management" existieren bereits in der Liste.

**Ablauf-Checkliste:**
1. Repo forken, README-Sektion "Multi-Agent Orchestration" oder "Session & Workflow Management" öffnen.
2. Eigene Zeile ergänzen — den Rohtext unten an die exakte Bullet-Syntax der jeweiligen Sektion anpassen (Einrückung, Trennzeichen).
3. Commit + Pull Request öffnen, PR-Beschreibung aus dem zweiten Copy-Paste-Block unten verwenden.
4. Falls der PR-Review träge ist: alternativ denselben Text als Kommentar in Discussion #16329 posten (dritter Copy-Paste-Block).

**Copy-Paste-Text (Listen-Zeile, Basis-Format `- [name](link) — description`):**
```
- [session-orchestrator](https://github.com/Kanevry/session-orchestrator) — Loop engineering for AI coding agents: research → plan → wave-execute → close, with verification gates between waves. Runs on Codex CLI, Claude Code, Cursor, and Pi.
```

**Copy-Paste-Text (PR-Beschreibung):**
```
Adding session-orchestrator to the Multi-Agent Orchestration / Session &
Workflow Management section.

session-orchestrator (MIT) runs a repeatable research → plan → wave-execute
→ close loop on top of Codex CLI (also supports Claude Code, Cursor, and
Pi), with typecheck/lint/test verification gates between execution waves.

Repo: https://github.com/Kanevry/session-orchestrator
```

**Copy-Paste-Text (Alternativ-Kommentar in Discussion #16329):**
```
Sharing session-orchestrator here as well: a wave-based session loop for
Codex CLI (research → plan → wave-execute → close), with typecheck/lint/test
verification gates between waves rather than only at the end. MIT licensed,
also runs on Claude Code, Cursor, and Pi.

https://github.com/Kanevry/session-orchestrator
```

**Erwartetes Ergebnis + Verifikation:** PR gemerged oder Kommentar sichtbar in Discussion #16329. Verifikation: PR-Status zeigt `merged`, bzw. der eigene Kommentar-Permalink in Discussion #16329 ist erreichbar.

---

## B3b — openai/codex "Show and tell"-Discussion

**Prio:** P2 — offizieller Ort für Community-Tools im Codex-Repo.

**URL:** [github.com/openai/codex/discussions](https://github.com/openai/codex/discussions) → Kategorie "Show and tell" → "New discussion"

**Voraussetzungen:** GitHub-Account. Codex-Installationsweg funktioniert bereits heute unverändert (Option 1 aus `docs/codex-setup.md` — keine weiteren Bauarbeiten nötig).

**Ablauf-Checkliste:**
1. `github.com/openai/codex/discussions` öffnen, Kategorie "Show and tell" wählen, "New discussion" klicken.
2. Titel + Body aus dem Copy-Paste-Text unten einfügen.
3. Absenden.
4. Permalink der eigenen Discussion notieren.

**Copy-Paste-Text:**
```
Title: session-orchestrator — a wave-based session loop for Codex CLI (and other harnesses)

session-orchestrator is a plugin that turns ad-hoc Codex sessions into a
repeatable loop: research → plan → wave-execute → close, with
typecheck/lint/test verification gates between waves instead of only at the
end.

How it works in three commands:
1. `/session feature` — inspects git state, open issues, and history, then
   aligns on scope via Q&A.
2. `/go` — executes the agreed plan in five typed waves (Discovery →
   Impl-Core → Impl-Polish → Quality → Finalization) with parallel
   subagents and a quality gate between each wave.
3. `/close` — verifies every planned item, commits cleanly, and files
   carryover issues for anything left.

Install on Codex CLI:

git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator
cd ~/Projects/session-orchestrator && npm install
node ~/Projects/session-orchestrator/scripts/codex-install.mjs

Restart Codex, then the commands above are available. Session Config lives
in your project's AGENTS.md.

The same skills and commands also run on Claude Code, Cursor IDE, and Pi,
with platform-adapted hooks. Repo: https://github.com/Kanevry/session-orchestrator
— MIT licensed, community-maintained.
```

**Erwartetes Ergebnis + Verifikation:** Sichtbarer Community-Post in "Show and tell". Verifikation: Permalink der Discussion ist im Browser öffentlich erreichbar.

---

## B3c — OpenAI Developer Showcase

**Prio:** P2 — offizielles OpenAI-Schaufenster, Kategorie "Built with Codex" passt direkt.

**URL:** [developers.openai.com/showcase](https://developers.openai.com/showcase) → "Submit your project"

**Voraussetzungen:** Formular-Login (falls verlangt), Repo öffentlich.

**Ablauf-Checkliste:**
1. `developers.openai.com/showcase` öffnen, "Submit your project" anklicken.
2. Kategorie "Built with Codex" wählen.
3. Formularfelder ausfüllen: Projektname, Repo-URL, Kurzbeschreibung (Copy-Paste-Text unten), Kontakt, Metadaten (Liste unten).
4. Absenden.

**Copy-Paste-Text (Kurzbeschreibung):**
```
session-orchestrator is a loop-engineering plugin for AI coding agents: it
turns ad-hoc Codex sessions into a repeatable research → plan →
wave-execute → close loop, with typecheck/lint/test verification gates
between execution waves rather than only at the end. Built with Codex CLI
as one of four supported harnesses (alongside Claude Code, Cursor, and Pi).
MIT licensed, community-maintained.
```

**Projekt-Metadaten (Formularfelder):**
- Name: `session-orchestrator`
- Repo: `https://github.com/Kanevry/session-orchestrator`
- Homepage: `https://session-orchestrator.com`
- Kategorie: Built with Codex
- Lizenz: MIT
- Kontakt: `office@gotzendorfer.at`

**Erwartetes Ergebnis + Verifikation:** Eintrag im Showcase-Katalog nach Review durch das OpenAI-Team (Timeline unbekannt). Verifikation: `developers.openai.com/showcase` per Suche/Filter nach "session-orchestrator" durchsuchen, oder Bestätigungs-E-Mail abwarten.

---

## A3 — claudepluginhub.com

**Prio:** P2 — direkte Submission wird laut Site-Text bevorzugt behandelt ("queues your repository directly for validation").

**URL:** `claudepluginhub.com/tools/submit-plugin` — **nur im Browser** öffnen, kein CLI-Fetch (Cloudflare-Bot-Schutz gibt Fetch-Tools 403 zurück).

**Voraussetzungen:** Browser-Session (kein Login laut Recherche erforderlich, aber Formular kann das verlangen — vor Ort prüfen).

**Ablauf-Checkliste:**
1. `claudepluginhub.com/tools/submit-plugin` im Browser öffnen.
2. Repo-URL `https://github.com/Kanevry/session-orchestrator` eintragen.
3. Beschreibungs-/Kategorie-Feld mit dem Copy-Paste-Text unten füllen.
4. Absenden — laut Site-Text wird das Repo direkt in die Validierungs-Queue eingereiht.
5. Nach einigen Tagen: `claudepluginhub.com` nach "session-orchestrator" durchsuchen.

**Copy-Paste-Text:**
```
Loop engineering for AI coding agents — turn ad-hoc sessions into a
repeatable research → plan → wave-execute → close loop with verification
gates. Runs on Claude Code, Codex CLI, Cursor, and Pi. MIT licensed,
community-maintained.

Repository: https://github.com/Kanevry/session-orchestrator
Homepage: https://session-orchestrator.com
```

**Erwartetes Ergebnis + Verifikation:** Repo in Validierungs-Queue, danach gelistet. Verifikation: Suche auf `claudepluginhub.com` nach "session-orchestrator" zeigt einen Eintrag.

---

## A4 — awesome-claude-code (Issue-Formular)

**Prio:** P3 — flankierend; 50,3k Stars, aber best-effort/selektiv ohne Antwort-Garantie, laut Benchmark nicht der Kanal der Gewinner.

**URL:** [github.com/hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) → "Issues" → "New issue" → passende Vorlage wählen (Ressourcen-/Tool-Empfehlung). **Ausschließlich das Web-Issue-Formular verwenden — niemals einen Pull Request öffnen**, PRs werden für diese Liste nicht akzeptiert.

**Voraussetzungen:** GitHub-Account. Beschreibung muss laut Repo-Konvention nüchtern-beschreibend sein, nicht werblich.

**Ablauf-Checkliste:**
1. `github.com/hesreallyhim/awesome-claude-code/issues/new/choose` öffnen, die zutreffende Empfehlungs-Vorlage auswählen.
2. Formularfelder mit dem Copy-Paste-Text unten befüllen.
3. Absenden.
4. Kein Antwort-SLA — nach einigen Wochen die Liste (README bzw. Katalog-Datei) im Repo nach "session-orchestrator" durchsuchen, z. B. via GitHub-Code-Suche `repo:hesreallyhim/awesome-claude-code session-orchestrator`.

**Copy-Paste-Text (Formularfelder):**
```
Name: session-orchestrator
Link: https://github.com/Kanevry/session-orchestrator
Category: Workflows & Knowledge Guides (or nearest matching category)
Description: Wave-based session loop for Claude Code (research, plan,
wave-execute, close) with typecheck/lint/test verification gates between
waves.
```

**Erwartetes Ergebnis + Verifikation:** Möglicherweise Aufnahme in die Liste (kein Garantie-Prozess). Verifikation: GitHub-Code-Suche `repo:hesreallyhim/awesome-claude-code session-orchestrator` liefert einen Treffer.

---

## B7 — Pi-Community (Discord-Announce + Erstkontakt Mario Zechner)

**Prio:** P3 — flankierend; erst NACH dem npm-Publish sinnvoll (siehe Sektion "npm-Publish" oben).

**URL:** Discord-Invite [discord.com/invite/3cU7Bz4UPx](https://discord.com/invite/3cU7Bz4UPx) · X: `@pidotdev` · Bluesky: [bsky.app/profile/mariozechner.at](https://bsky.app/profile/mariozechner.at) · Mastodon: [mastodon.gamedev.place/@badlogic](https://mastodon.gamedev.place/@badlogic)

**Voraussetzungen:** npm-Publish (Sektion oben) abgeschlossen und via `npm view session-orchestrator version` bestätigt — vor Publish nicht posten. Pi ist earendil-works/pi (72k Stars); Maintainer Mario Zechner sitzt in Graz (AT).

**Ablauf-Checkliste:**
1. Vor diesem Schritt: `docs/distribution/npm-publish-checklist.md` vollständig abgeschlossen, `npm view session-orchestrator version` bestätigt die aktuelle Version.
2. Discord-Invite beitreten, den passenden Announce-/Showcase-Channel finden.
3. Copy-Paste-Text (a) dort posten.
4. Optional, respektvoll: Erstkontakt an Mario Zechner via Bluesky ODER Mastodon (nicht beide gleichzeitig) mit der Kurzvariante (b1); bei erkennbarem Interesse die längere Variante (b2) nachreichen.
5. Nicht an mehreren Kanälen parallel posten, um nicht als Spam zu wirken.

**Copy-Paste-Text (a) — Discord-Announce:**
```
session-orchestrator (npm: session-orchestrator, `pi install
npm:session-orchestrator`) is now published for Pi.

It's a loop-engineering plugin: research → plan → wave-execute → close,
with typecheck/lint/test verification gates between execution waves instead
of only at the end. Five typed wave roles (Discovery, Impl-Core,
Impl-Polish, Quality, Finalization), persistent STATE.md across crashes,
and a learnings-extraction step (/evolve) that turns session patterns into
reusable rules.

Same skills/commands also run on Claude Code, Codex CLI, and Cursor IDE.
MIT licensed, community-maintained.

Repo: https://github.com/Kanevry/session-orchestrator
```

**Copy-Paste-Text (b1) — Kurzvariante für Bluesky/Mastodon-Erstkontakt:**
```
Hi Mario — built session-orchestrator, a wave-based session loop for
Codex/Claude/Cursor/Pi with verification gates between waves. Just
published to npm for Pi. Grüße aus Graz — thought it might interest you
given pi-spine/pi-conductor. https://github.com/Kanevry/session-orchestrator
```

**Copy-Paste-Text (b2) — längere Variante (falls Interesse erkennbar):**
```
Hi Mario, I've been building session-orchestrator, a loop-engineering
plugin that turns ad-hoc coding-agent sessions into a repeatable research →
plan → wave-execute → close loop, with typecheck/lint/test verification
gates between execution waves. It runs on Claude Code, Codex CLI, Cursor
IDE, and now Pi (just published to npm). I noticed pi-spine and
pi-conductor cover related ground in the Pi ecosystem — happy to compare
notes if useful. Also based in Graz, small world. Repo:
https://github.com/Kanevry/session-orchestrator
```

**Erwartetes Ergebnis + Verifikation:** Sichtbarkeit im Pi-Discord, ggf. Reaktion von Mario Zechner. Verifikation: Discord-Post-Permalink vorhanden; ggf. Antwort/Reaktion auf den Bluesky-/Mastodon-Post.

---

## Backlog / Optional (kein Copy-Paste-Text, Ermessens-Items)

Diese Kanäle sind laut Recherche entweder later-stage (keine Self-Serve-Submission, Voraussetzungen fehlen noch) oder niedrige Priorität — kein vorbereiteter Copy-Paste-Text, nur Notiz für später:

- **A5 — Anthropic Official Marketplace:** kein dokumentierter Self-Serve-Prozess ("There is no application process"). Voraussetzung: A1 gefixt + belegbare Install-Traktion. Später über Partner-Kontakt angehen, nicht über ein Formular.
- **A6 — wshobson/agents (38k Stars):** Aufnahme läuft über Maintainer-Ermessen, kein Formular. Falls gewünscht: direkte Kontaktaufnahme mit der Multi-Harness-Story (Claude Code/Codex/Cursor/Pi) als Argument.
- **A7 — Kleinere Kataloge** (tonsofskills/ccpi, cc-marketplace, ComposioHQ): niedrige Reichweite; ComposioHQ hat laut Recherche 238 offene PRs (Merge-Stau) — nur bei Restkapazität sinnvoll.
- **B5 — Cursor Official Marketplace:** braucht einen `.cursor-plugin/plugin.json`-Port + manuelles Review. Erst nach einem Sichtbarkeits-Signal aus B4 (cursor.directory) angehen.
- **B6 — OpenAI Official Plugin Directory:** Identitätsverifikation + eigene Test-Case-Suite + Policy-Scan aller Skills — eigenes Projekt, nicht Teil dieses Kits.

## See Also

- [`2026-07-18-distribution-options.md`](./2026-07-18-distribution-options.md) — vollständige Optionsmatrix mit Aufwand/Reichweite/Fit-Bewertung
- [`docs/distribution/npm-publish-checklist.md`](npm-publish-checklist.md) — Operator-Runbook für den npm-Publish (Voraussetzung für B7)
- [`docs/codex-setup.md`](../codex-setup.md) · [`docs/pi-setup.md`](../pi-setup.md) — Plattform-Setup-Guides, referenziert in den Copy-Paste-Texten oben
