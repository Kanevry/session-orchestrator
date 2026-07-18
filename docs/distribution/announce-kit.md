# Announce-Kit

Wiederverwendbares Playbook für Release-Announcements. Ziel: pro Release ein
konsistenter, ehrlicher Auftritt auf allen Kanälen — kein Ad-hoc-Copywriting
jedes Mal neu erfinden.

**Kanonische Tagline** (immer 1:1 übernehmen, nicht umformulieren):

> Loop engineering for AI coding agents — turn ad-hoc sessions into a repeatable research → plan → wave-execute → close loop with verification gates. Runs on Claude Code, Codex CLI, Cursor, and Pi.

**Kanonische Links:**

- Repo: `https://github.com/Kanevry/session-orchestrator`
- Landing: `https://session-orchestrator.com`
- Discussions (Show-and-tell / Fragen): `https://github.com/Kanevry/session-orchestrator/discussions`

## 1. Wann announcen

Kadenz-Prinzip (Benchmark-Evidenz, siehe unten): Announce jede Minor/Major mit
sichtbarem Nutzer-Mehrwert — nie für reine Patch/Chore-Releases, dafür reicht
das CHANGELOG. Regelmäßigkeit schlägt Lautstärke: ruflo (65k Stars) postet
jede Major auf r/ClaudeAI und bleibt dadurch sichtbar, während SuperClaude nach
4 Monaten Funkstille als stagnierend wahrgenommen wurde — unabhängig vom
tatsächlichen Code-Zustand. Ein Announce pro Kanal pro Release: kein
Wiederholen, kein Cross-Posting-Spam binnen derselben Woche.

**Trigger-Checkliste** (mindestens einer muss zutreffen):
- [ ] Neues Skill/Command/Agent mit sichtbarer Nutzer-Auswirkung
- [ ] Neuer Plattform-Support oder Plattform-Parität-Sprung (z. B. neue Harness-Unterstützung)
- [ ] Breaking-Fix oder Sicherheits-relevanter Fix, den Nutzer kennen sollten
- [ ] Spürbare Workflow-Verbesserung (z. B. neue Quality-Gate-Fähigkeit)

Wenn keiner zutrifft → kein Announce, CHANGELOG genügt.

## 2. Templates

Alle Templates sind copy-paste-fertig. Platzhalter ersetzen: `<version>`,
`<highlight-1>` / `<highlight-2>` / `<highlight-3>`, `<install-line>`.
`<install-line>` = die passende Zeile aus der README-Install-Matrix für die
Zielgruppe des Kanals (siehe README.md § Install — nicht neu erfinden, dort
kopieren).

### 2.1 r/ClaudeAI Post

Titel-Formel: `Session Orchestrator v<version>: <highlight-1>` — nüchtern,
kein Clickbait, kein "🚀"/"🔥" im Titel. Reddit bestraft Marketing-Ton härter
als jeder andere Kanal in dieser Kategorie.

```text
Title: Session Orchestrator v<version>: <highlight-1>

Body:

Session Orchestrator turns ad-hoc Claude Code sessions into a repeatable
research → plan → wave-execute → close loop with verification gates. Runs on
Claude Code, Codex CLI, Cursor, and Pi.

What's new in v<version>:
- <highlight-1>
- <highlight-2>
- <highlight-3>

Why it matters: <one sentence — the concrete problem this solves, not a
feature list restated>

Install:
<install-line>

Repo: https://github.com/Kanevry/session-orchestrator
Full changelog: https://github.com/Kanevry/session-orchestrator/blob/main/CHANGELOG.md

Happy to answer questions — this is a community MIT project, not affiliated
with Anthropic.
```

### 2.2 Pi Discord Update

Kurz, technisch, kein Fließtext-Hype. Posten in den Pi-Community-Discord unter
`discord.com/invite/3cU7Bz4UPx` — **erst nach dem npm-Publish**, da der native
Pi-Install-Pfad (`pi install npm:session-orchestrator`) heute noch nicht
verfügbar ist (README, Install-Matrix Pi-Zeile).

```text
Session Orchestrator v<version> is out.

- <highlight-1>
- <highlight-2>

Install: <install-line>
Repo: https://github.com/Kanevry/session-orchestrator
Pi setup guide: https://github.com/Kanevry/session-orchestrator/blob/main/docs/pi-setup.md
```

### 2.3 openai/codex "Show and tell" Discussion-Kommentar

Als Update-Kommentar im bestehenden Show-and-tell-Thread, nicht als neuer
Thread pro Release (sonst verwässert die Historie).

```text
Update — v<version> is out.

- <highlight-1>
- <highlight-2>
- <highlight-3>

Codex CLI install:
<install-line>

Repo: https://github.com/Kanevry/session-orchestrator
```

### 2.4 GitHub Release Notes Head

2-3 Sätze über dem automatisch generierten Changelog-Block, nicht ersetzend.

```text
Session Orchestrator v<version> — <highlight-1>.

<One sentence: what changed and why it matters to someone running multi-hour
agentic coding sessions.> Runs on Claude Code, Codex CLI, Cursor, and Pi — see
the README install matrix for your platform.

---
<changelog block follows>
```

### 2.5 X/Bluesky Snippet (< 280 Zeichen)

```text
Session Orchestrator v<version>: <highlight-1>. Loop engineering for AI
coding agents — research → plan → wave-execute → close, with verification
gates. Runs on Claude Code, Codex CLI, Cursor & Pi.
https://github.com/Kanevry/session-orchestrator
```

Zeichen-Budget prüfen: Link zählt bei X/Bluesky meist als fixe Kurz-URL-Länge,
trotzdem den Rest unter ~250 Zeichen halten, um Puffer zu behalten.

## 3. Regeln

- **Ehrlichkeit vor Reichweite.** Keine unbelegten Zahlen ("10,000+ downloads",
  "used by hundreds of teams") ohne Quelle. Test-/Skill-/Command-Zahlen immer
  gegen `docs/components.md` und die README-Badges prüfen, nie aus dem
  Gedächtnis schreiben — die Zahlen ändern sich pro Release.
- **Ein Announce pro Kanal pro Release.** Kein Nachfassen binnen derselben
  Woche, auch nicht bei schwacher Resonanz — das liest sich als Spam.
- **Antworten auf Kommentare fest einplanen** — Zeitfenster von 24h nach
  Posting reservieren (Kalender-Slot, nicht "wenn Zeit ist"). Unbeantwortete
  Fragen unter einem Announce-Post wirken stärker negativ als kein Post.
- **Links immer auf Repo + Landing**, nie auf Zwischenseiten (z. B. keine
  Marketplace-Suchergebnis-Links, sondern den direkten Repo-Link).
- **Kein Hype-Vokabular** ("revolutionary", "game-changing", "the best").
  Nüchterne Feature-Beschreibung + konkreter Nutzen schlägt Superlative in
  dieser Nutzer-Kategorie (Reddit-Evidenz, siehe oben).
- **Reihenfolge bei Multi-Channel-Releases**: r/ClaudeAI und GitHub Release
  zuerst (höchste Reichweite), Pi Discord und Show-and-tell danach, X/Bluesky
  parallel oder kurz danach als Kurz-Version.

## Quellen (für Faktencheck bei künftigen Announces)

- `README.md` — Install-Matrix, Tagline, 4 Kern-Differenzierer, Versionsnummer,
  Recent-Highlights-Abschnitt
- `docs/components.md` — aktuelle Skill-/Command-/Agent-/Hook-Zahlen
- `CHANGELOG.md` — vollständige Versions-Historie
