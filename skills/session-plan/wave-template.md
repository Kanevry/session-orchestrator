# Wave Agent Template

> Reference specification for agent definitions in session plans. Extracted from SKILL.md Step 4.

For each wave, define agents with:

```
[Role] (Wave N) Agent M:
  Task: [specific task description]
  Files: [exact file paths to read/modify]
  Acceptance: [what "done" looks like — measurable]
  Tools needed: [Read, Write, Edit, Bash, Grep, Glob, etc.]
  Dependencies: [output from which prior role/agent]
  Isolation: [worktree|none — copied verbatim from this wave's `waves[].isolation` entry in the shape output (`scripts/session-shape.mjs`); do not compute by hand]
  MaxTurns: [this wave's `maxTurns` from `scripts/session-shape.mjs`; do not compute by hand]
  status: brainstormed
```

- `Isolation: worktree` means the wave-executor will pass `isolation: "worktree"` to the Agent tool, giving each agent its own git worktree copy. Each wave's `isolation` (`worktree`/`none`) AND its paired `enforcement` (`strict`/`warn`/`off`) are computed per-wave from that wave's `agentCap` and the session type — the graduated rule (`resolveIsolation`/`resolveEnforcement`, issue #194: ≤2 agents → `none`, ≥5 agents → `worktree`, 3-4 agents → `none` for housekeeping else `worktree`, an explicit Session Config `isolation` value always wins) lives in `scripts/lib/wave-sizing.mjs`, not in `session-shape.mjs` itself — `session-shape.mjs` only calls it once per wave row and copies the two results onto that wave's record.
- `MaxTurns` is enforced via the agent prompt — wave-executor includes a turn limit instruction in each agent's prompt
- `status` is the mission-status enum value for this wave-plan item (#340). Always `brainstormed` in the initial plan. Wave-executor updates it at gate transitions (validated → in-dev → testing → completed). Rollback to `brainstormed` is allowed from any state. The five values are listed in `SKILL.md` § Mission-Status Enum; nothing validates them mechanically — `setMissionStatus` writes the string it is given to both STATE.md surfaces on purpose, so keeping the value in-enum is the coordinator's job.
- The wave-plan item's `id` becomes the `taskId` every `setMissionStatus` call for this item uses, and `setMissionStatus` REFUSES ids outside `[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+` (lowercase segments, single hyphens, trailing bare digits) with `refused: 'id-grammar'` and a stderr WARN — nothing is written. Mint ids matching it: `m-1`, `docs-2`, `w2-1`, `w2-a-10` all accepted; `w2-a10`, `w3-p2`, `W3-I1`, `Docs_2` all refused.

> **Deconfliction rule:** Before finalizing agent specs for a wave, verify that no two agents in the same wave list overlapping `Files:` paths. If overlap is found, either merge the agents into one or move one task to a later wave. Two agents editing the same file in parallel causes merge conflicts that require manual resolution.

## Agent Count and Turn Budget per Wave

There is no count table here. Both numbers come from the session shape resolved once at plan time (`SKILL.md` § Role-to-Wave Mapping):

- **Agent ceiling** — that wave's `agentCap` (already capped by the Session Config `agents-per-wave` value; `agentCapRaw` is the value before that ceiling).
- **Turn budget** — that wave's `maxTurns` (`null` on a `coordinatorDirect: true` wave, which dispatches no agents).

> **The Quality wave's cap is a CAP, not a target.** Quality capacity is need-gated: the effective count is `min(<the wave's agentCap>, ceil((HIGH + MED gaps from the most recent qa-strategist run) / 3))`. 0 gaps → 0 test-writing tasks and the wave is skipped (the read-only review panel is unaffected); no qa-strategist signal at all → a conservative 1-2, never the blind cap. The shape marks this wave `qualityEarned: true`. Full rule: `SKILL.md` § Agent Count by Tier footnote.
