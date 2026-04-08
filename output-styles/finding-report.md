# Finding Report Style

Use this format for discovery probes and code analysis findings.

## Structure

### Finding Header

```
### [{severity}] {title}
```

Severity levels: `critical`, `high`, `medium`, `low`, `info`

### Finding Body

| Field | Value |
|-------|-------|
| Severity | `{level}` |
| Confidence | `{high\|medium\|low}` |
| File | `{path}:{line}` |
| Issue | GL#{n} (if applicable) |

### Description

One paragraph maximum. What was found and why it matters.

### Evidence

Code snippet with file reference:

```{lang}
// path/to/file.ts:42
<relevant code>
```

### Recommendation

One-line fix suggestion. Link to docs or patterns if applicable.

## Rules

- Severity + confidence always visible — drives prioritization
- One finding per block — never combine multiple issues
- Evidence is mandatory — no findings without code references
- Recommendations are actionable — "rename X to Y" not "consider renaming"
- Sort by severity descending within a report
- Keep description under 3 sentences
