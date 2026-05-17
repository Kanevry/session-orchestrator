# language-mappers

Semantic slice extractors for the session-orchestrator discovery pipeline.

## API

### `extractSemanticSlices(filePath, content, options?): Promise<SemanticSlice[]>`

Dispatches to the correct language mapper based on file extension (or an explicit `options.language` override).

```js
import { extractSemanticSlices } from './index.mjs';

const slices = await extractSemanticSlices('src/utils.ts', sourceText);
// [{ kind: 'function', name: 'formatDate', file: 'src/utils.ts', line: 3, endLine: 7, exported: true, isNested: false, params: ['date'] }]
```

### `languageFromPath(filePath): 'ts'|'js'|'md'|null`

Derive the language key from a file path extension. Returns `null` for unsupported extensions.

### `SLICE_KINDS`

Frozen array of all valid `kind` values: `['function', 'class', 'interface', 'type', 'export', 'section']`.

## SemanticSlice shape

```ts
interface SemanticSlice {
  kind: 'function' | 'class' | 'interface' | 'type' | 'export' | 'section';
  name: string;
  file: string;
  line: number;
  endLine: number;
  exported: boolean;
  isNested: boolean;
  params?: string[];   // TS: param names; class: method names; MD: [depth]
  doc?: string;        // leading JSDoc comment text, if present
}
```

## Phase 1 support

| Extension | Language | Mapper |
|-----------|----------|--------|
| `.ts`, `.tsx` | TypeScript | `@babel/parser` |
| `.js`, `.jsx`, `.mjs`, `.cjs` | JavaScript | `@babel/parser` |
| `.md`, `.mdx` | Markdown | `remark` + `remark-parse` |

## Phase 2 (filed as follow-up issue)

- **Swift** — regex-based proto (`class`, `func`, `protocol`, `struct` declarations)
- **Python** — regex-based proto (`def`, `class` declarations)

## Integration

Discovery probes consume this API in W4+ (not wired in Phase 1). The discovery pipeline calls `extractSemanticSlices` per file and passes the slice array to triage state for issue-matching.
