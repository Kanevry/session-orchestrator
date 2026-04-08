# Wave Summary Style

Use this format for wave completion reports between waves.

## Structure

### Header

```
## Wave {N}/{total} Complete
```

### Agent Status Table

| Agent | Task | Status | Files |
|-------|------|--------|-------|
| {agent-name} | {1-line task} | done/partial/failed | {file list} |

### Quality Gate Results

- Tests: {n} passing, {n} failing
- Validator: {n}/{n} checks
- TypeScript: {n} errors (if applicable)

### Adaptations

Only include if the plan changed:
- What changed and why
- Impact on remaining waves

## Rules

- One table row per agent — no nested details
- Status is exactly one of: `done`, `partial`, `failed`
- File lists use short relative paths (e.g., `hooks/on-stop.sh`)
- Quality gates are pass/fail — no ambiguity
- Adaptations only when deviating from plan — omit if on track
- Keep under 20 lines total
