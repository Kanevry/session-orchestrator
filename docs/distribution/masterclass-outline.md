# Masterclass-Outline — Operator-Video

Produktionsbriefing für ein 30-60-minütiges Video, das eine echte Deep-Session
end-to-end zeigt. Kein Skript-Demo — eine echte Session, die live begleitet
wird.

## Sprachempfehlung: Englisch

**Empfehlung: Englisch**, Begründung Reichweite (Benchmark-Evidenz von heute):
BMAD-Masterclass erzielte 329k Views auf dem eigenen Kanal (34,5k Subs) und
löste zusätzlich Dritt-Videos mit 230k Views aus — dieser Reichweiten-Hebel
funktioniert nur mit einer Sprache, die die internationale
Claude-Code/Codex-CLI-Zielgruppe direkt erreicht. Das Repo, alle Docs, README
und Skills sind bereits Englisch — ein englisches Video ist konsistent mit dem
Produkt und erschließt YouTube-SEO auf den relevanten Suchbegriffen ("Claude
Code", "Codex CLI", "AI coding agent").

## 1. Konzept

**Titel-Varianten** (YouTube-SEO: enthält "Claude Code", Problem-Formulierung):

1. "Why Your Claude Code Sessions Lose Context — And How I Fixed It (Session Orchestrator Deep Dive)"
2. "I Built a Loop-Engineering Layer for Claude Code, Codex CLI & Cursor — Full Session Walkthrough"
3. "Stop Winging AI Coding Sessions: Research → Plan → Wave-Execute → Close (Live Deep Session)"

**Ziel-Zuschauer:** Solo-Devs und kleine Teams, die Claude Code / Codex CLI /
Cursor bereits für mehrstündige agentische Sessions nutzen und wiederkehrend
Kontextverlust, unbemerkte Regressionen oder fehlende Verifikation erleben.

**Kernversprechen:** "Watch a full deep session end-to-end — from `/session`
through `/go`'s five typed waves to `/close` — and see what verification gates
and typed waves actually change in practice."

## 2. Kapitel-Outline (Ziel-Timestamps für ~45 min Gesamtlänge)

Struktur und Reihenfolge basieren auf dem realen Ablauf in
`skills/session-start/SKILL.md` und `skills/wave-executor/SKILL.md` (nur
Struktur übernommen, keine Implementierungstiefe nötig für die Aufnahme).

| # | Zeit | Kapitel | Was zeigen | Screen | Kernsatz |
|---|---|---|---|---|---|
| 1 | 00:00 | Hook — das Problem | Terminal-Ausschnitt einer "verlorenen" Ad-hoc-Session (Kontextverlust, stiller Regressions-Fund) | Terminal | "Ad-hoc AI sessions lose context and quality silently — here's what that costs you." |
| 2 | 03:00 | Konzept: Loop Engineering | Diagramm/README-Mermaid der Lifecycle-Kette research→plan→wave-execute→close | Browser (README) oder Slide | "Loop engineering turns that ad-hoc flow into a repeatable loop with gates." |
| 3 | 06:30 | Install & Minimal-Config | README-Install-Matrix, `## Session Config` Minimal-Block (7 Felder) | Terminal + Browser | "Seven config fields is the entire barrier to entry." |
| 4 | 10:00 | LIVE: `/session deep` Start | Phase-Analyse läuft — git state, offene Issues, Historie, SSOT-Check | Terminal | "It reads the repo before it touches it." |
| 5 | 15:00 | Q&A-Alignment | `AskUserQuestion`-Picker, Scope-Entscheidung live treffen | Terminal | "You align on scope before a single line of code changes." |
| 6 | 19:00 | Wave-Plan erklären | 5 typisierte Rollen: Discovery → Impl-Core → Impl-Polish → Quality → Finalization | Terminal/Slide | "Five typed roles, not one big batch." |
| 7 | 23:00 | LIVE: `/go` — Wave 1 Discovery | Parallele Subagents live beobachten (read-only Audit) | Terminal (ggf. tmux-Split) | "Discovery runs read-only, in parallel, before anyone writes code." |
| 8 | 28:00 | Inter-Wave-Gate | Session-Reviewer-Output, Confidence-Filter (nur ≥80 erreicht den Nutzer) | Terminal | "Regressions get caught between waves, not just at the end." |
| 9 | 33:00 | Impl-Core/Polish + Quality-Wave | Zeitraffer der Umsetzung, dann Full Gate (typecheck/test/lint) live | Terminal | "Every wave ends at a verification gate — no exceptions." |
| 10 | 38:00 | `/close` | Plan-Verifikation, sauberer Commit, Carryover-Issue für Rest | Terminal | "Everything unfinished becomes a tracked issue, not a forgotten TODO." |
| 11 | 42:00 | Multi-Harness-Beweis | Kurzer Wechsel zu Codex CLI oder Cursor IDE mit denselben Skills | Terminal (zweite Session) | "Same skills, same commands, different harness." |
| 12 | 45:00 | Fazit + Install-CTA | README-Install-Zeile einblenden, Repo-Link, Landing-Link | Browser/Terminal | "Free, MIT, install matrix is one link away." |

## 3. Produktionsnotizen

- **Screen-Setup:** Terminal vollbild als Primärquelle. Für die Wave-Execution-
  Segmente (Kapitel 7-9) optional `/tmux-layout` verwenden — das 4-Pane-Layout
  (STATE.md / CI-Watch / Events, siehe ADR-0007) zeigt parallele Agents und
  Fortschritt gleichzeitig, ohne zwischen Fenstern zu schneiden.
- **Ton:** Ruhig, evidenzorientiert, keine Verkaufssprache. Echte Session statt
  Skript-Demo — wenn während der Aufnahme ein Fehler oder eine Retry-Schleife
  auftritt, drinlassen. Authentizität schlägt Politur; ein Video, das nur den
  Happy-Path zeigt, verliert Glaubwürdigkeit bei der technischen Zielgruppe.
- **Länge:** 30-45 min Zielkorridor für Hands-on-Technical-Content (die
  BMAD-Masterclass-Precedent zeigt: Langform funktioniert, wenn der Inhalt
  substanziell ist — nicht kürzen, um einer angenommenen Aufmerksamkeitsspanne
  zu genügen).
- **Thumbnail-Konzept (Text-Formel):** Split-Screen-Terminal-Screenshot
  (Wave-Ausführung sichtbar) + große Textzeile, z. B. "5 WAVES. 1 LOOP. ZERO
  SILENT REGRESSIONS." — keine erfundenen Zahlen, nur die verifizierten
  Konzept-Begriffe aus README § "How it works".

## 4. Distribution des Videos

**YouTube-Metadaten — Description-Skelett:**

```text
Session Orchestrator turns ad-hoc Claude Code / Codex CLI / Cursor sessions
into a repeatable research → plan → wave-execute → close loop with
verification gates.

Repo: https://github.com/Kanevry/session-orchestrator
Landing: https://session-orchestrator.com

Timestamps:
00:00 The problem
03:00 Loop engineering, explained
06:30 Install & minimal config
10:00 /session deep — live
15:00 Q&A alignment
19:00 The five typed waves
23:00 /go — Wave 1 Discovery, live
28:00 Inter-wave quality gate
33:00 Impl waves + Full Gate
38:00 /close
42:00 Multi-harness proof
45:00 Install & wrap-up

MIT licensed. Community project — not affiliated with Anthropic, OpenAI, or
Cursor.
```

**Tags (Vorschlag):** `claude code`, `codex cli`, `cursor ide`, `ai coding
agent`, `agentic coding`, `loop engineering`, `multi-agent orchestration`,
`claude code plugin`.

**Cross-Post-Plan** (nach Upload, per Kanal-Regeln aus `announce-kit.md`
Abschnitt 3 — ein Post pro Kanal):

1. **r/ClaudeAI** — Link-Post mit kurzer Zusammenfassung + Timestamp-Liste im
   Kommentar (nicht im Titel).
2. **Pi-Discord** — kurzer Update-Post mit Link, erst nach npm-Publish (siehe
   `announce-kit.md` § 2.2 — Discord-Timing-Vorbehalt gilt auch hier).
3. **openai/codex Show-and-tell** — Kommentar im bestehenden Thread mit
   Video-Link + 1-Satz-Zusammenfassung.
4. **README-Einbettung** — Video-Link unter README § "Learn the method behind
   it" ergänzen (dort stehen bereits die agenticbuilders.at-Kurslinks; ein
   Video-Link ist eine spätere Repo-Änderung, hier nur als
   Distributionsschritt vorgemerkt, nicht in diesem Task umgesetzt).

## Quellen (Faktencheck)

- `README.md` — Tagline, Install-Matrix, Lifecycle-Diagramm, "How it works",
  4 Kern-Differenzierer, Links (Repo, Landing, Kurse)
- `skills/session-start/SKILL.md` — Phasenstruktur (Bootstrap-Gate,
  Parallel-Aware-Preamble, Config-Read, Session-Lock, Q&A-Alignment)
- `skills/wave-executor/SKILL.md` — Wave-Ausführungsmodell, Pre-Execution-
  Checks, STATE.md-Initialisierung
- `docs/adr/0007-tmux-visualization-substrate.md` (referenziert via CLAUDE.md
  § "Operator tmux side-channel") — `/tmux-layout` 4-Pane-Layout
