# AI Slop Detection Patterns

Reference document for the `ai-slop` probe. Contains grep-compatible regex patterns
organized by category. All patterns are usable directly with `grep -E` or the Grep tool.

---

## 1. Filler Phrases in Comments

AI-generated code frequently contains unnecessary editorial commentary in comments.

**Pattern:**
```
(as you can see|it's worth noting|needless to say|it should be noted|obviously|of course|basically|essentially|simply|let's go ahead|let's proceed|moving on to)
```

**Usage:**
```bash
Grep pattern: (as you can see|it's worth noting|needless to say|it should be noted|obviously|of course|basically|essentially|simply|let's go ahead|let's proceed|moving on to)
  -i --glob "*.{ts,tsx,js,jsx,py,go,rs,java,rb}"
```

**Notes:**
- Case-insensitive matching recommended
- Most commonly found in line comments (`//`, `#`) and JSDoc/docstring blocks
- High false-positive rate for "simply" and "of course" in legitimate documentation; cross-check that they appear in code comments, not prose docs

---

## 2. Over-Documentation

Structural indicators that documentation was generated mechanically rather than thoughtfully.

### 2a. Param docs that repeat the parameter name

**Pattern:**
```
@param\s+(\w+)\s+[-—]\s*(the\s+)?\1
```

**Usage:**
```bash
Grep pattern: @param\s+(\w+)\s+[-—]\s*(the\s+)?\1
  --glob "*.{ts,tsx,js,jsx}"
```

**Examples flagged:**
- `@param name - the name` (repeats "name")
- `@param userId -- userId` (repeats "userId")

### 2b. Returns docs that say nothing

**Pattern:**
```
@returns?\s+(the\s+)?(result|value|output|response|data|return value)\.?\s*$
```

**Usage:**
```bash
Grep pattern: @returns?\s+(the\s+)?(result|value|output|response|data|return value)\.?\s*$
  --glob "*.{ts,tsx,js,jsx}"
```

### 2c. Comment-to-code ratio check

Not a regex pattern -- requires counting. For each function body:
```bash
# Count comment lines vs code lines in a file
# Flag if comment lines > code lines (excluding file headers and license blocks)
grep -c '^\s*//' <file>    # comment lines (JS/TS)
grep -c '^\s*[^/]' <file>  # code lines
```

---

## 3. Hallucinated Imports

Verification approach for imports that reference non-existent modules.

### 3a. Relative imports -- verify file exists on disk

**Pattern (extract relative imports):**
```
from\s+["'](\.\.?/[^"']+)["']
```

**Verification:**
```bash
# For each matched path, resolve and check:
# Given import from "./utils/helper"
# Check: ./utils/helper.ts, ./utils/helper.tsx, ./utils/helper.js, ./utils/helper/index.ts, ./utils/helper/index.js
test -f <resolved_path>.ts || test -f <resolved_path>.tsx || test -f <resolved_path>.js || test -f <resolved_path>/index.ts || test -f <resolved_path>/index.js
```

### 3b. Package imports -- verify in package.json

**Pattern (extract package imports):**
```
from\s+["']([^./][^"']*)["']
```

**Verification:**
```bash
# Extract package name (handle scoped packages)
# "@scope/package/sub" -> "@scope/package"
# "package/sub" -> "package"
# Check against dependencies + devDependencies in package.json
cat package.json | python3 -c "
import json, sys
pkg = json.load(sys.stdin)
deps = set(pkg.get('dependencies', {}).keys()) | set(pkg.get('devDependencies', {}).keys())
print('\n'.join(sorted(deps)))
"
```

---

## 4. Unnecessary Complexity

Patterns indicating over-engineering, often from AI trying to appear thorough.

### 4a. Try-catch wrapping non-throwing synchronous operations

**Pattern:**
```
try\s*\{[^}]*\b(const|let|var)\s+\w+\s*=\s*[^;]*;?\s*\}\s*catch
```

**Usage:**
```bash
Grep pattern: try\s*\{[^}]*\b(const|let|var)\s+\w+\s*=\s*[^;]*;?\s*\}\s*catch
  --glob "*.{ts,tsx,js,jsx}" --multiline true
```

**Notes:** High false-positive rate. Manual review recommended. Focus on try-catch around pure assignments, string operations, array operations that cannot throw.

### 4b. Re-implementing standard library functions

**Pattern:**
```
function\s+(isEmpty|isNull|isUndefined|isNil|isString|isNumber|isArray|isObject|isFunction|capitalize|camelCase|kebabCase|snakeCase|flatten|uniq|chunk|range|clamp|noop)\s*\(
```

**Usage:**
```bash
Grep pattern: function\s+(isEmpty|isNull|isUndefined|isNil|isString|isNumber|isArray|isObject|isFunction|capitalize|camelCase|kebabCase|snakeCase|flatten|uniq|chunk|range|clamp|noop)\s*\(
  --glob "*.{ts,tsx,js,jsx}" --glob "!**/node_modules/**"
```

### 4c. Excessive null checks on narrowed types

**Pattern:**
```
if\s*\(\s*\w+\s*(!=|!==)\s*(null|undefined)\s*\)\s*\{[^}]*\}\s*(else\s*\{[^}]*\})?
```

**Notes:** Requires type-awareness for accurate detection. Flag when the variable was already narrowed by a previous check or type guard in the same scope.

---

## 5. Generic Error Messages

AI-generated code frequently uses unhelpful error messages that provide no diagnostic value.

### 5a. Generic "error occurred" messages

**Pattern:**
```
catch.*throw new Error\(["'].*error occurred
```

**Usage:**
```bash
Grep pattern: catch.*throw new Error\(["'].*error occurred
  -i --glob "*.{ts,tsx,js,jsx,py}"
```

### 5b. Error logging without context

**Pattern:**
```
catch.*console\.(log|error)\(["']error
```

**Usage:**
```bash
Grep pattern: catch.*console\.(log|error)\(["']error
  -i --glob "*.{ts,tsx,js,jsx}"
```

### 5c. Empty catch blocks (swallowed errors)

**Pattern:**
```
catch\s*\(\w+\)\s*\{\s*\}
```

**Usage:**
```bash
Grep pattern: catch\s*\(\w+\)\s*\{\s*\}
  --glob "*.{ts,tsx,js,jsx,py}" --multiline true
```

### 5d. Catch-and-rethrow without adding context

**Pattern:**
```
catch\s*\(\s*(\w+)\s*\)\s*\{\s*throw\s+\1\s*;?\s*\}
```

**Usage:**
```bash
Grep pattern: catch\s*\(\s*(\w+)\s*\)\s*\{\s*throw\s+\1\s*;?\s*\}
  --glob "*.{ts,tsx,js,jsx}" --multiline true
```

---

## 6. Redundant Code

Patterns where code does something the language already handles, adding noise without value.

### 6a. Redundant type assertions on already-typed values

**Pattern:**
```
as string(?=\s*[;,)\]])
```

**Usage:**
```bash
Grep pattern: as string(?=\s*[;,)\]])
  --glob "*.{ts,tsx}"
```

**Notes:** Cross-reference with TypeScript type info. Only flag when the value is already typed as `string`.

### 6b. Explicit boolean comparisons

**Pattern:**
```
===?\s*true|===?\s*false|!==?\s*true|!==?\s*false
```

**Usage:**
```bash
Grep pattern: ===?\s*true\b|===?\s*false\b|!==?\s*true\b|!==?\s*false\b
  --glob "*.{ts,tsx,js,jsx}"
```

### 6c. Unnecessary return await

**Pattern:**
```
return\s+await\s+
```

**Usage:**
```bash
Grep pattern: return\s+await\s+
  --glob "*.{ts,tsx,js,jsx}"
```

**Notes:** Only flag when NOT inside a try-catch block. `return await` inside try-catch is correct and necessary for proper error handling.

### 6d. If/else returning boolean literals

**Pattern:**
```
if\s*\([^)]+\)\s*\{?\s*return\s+true\s*;?\s*\}?\s*else\s*\{?\s*return\s+false
```

**Usage:**
```bash
Grep pattern: if\s*\([^)]+\)\s*\{?\s*return\s+true\s*;?\s*\}?\s*else\s*\{?\s*return\s+false
  --glob "*.{ts,tsx,js,jsx,py}" --multiline true
```

**Fix:** Replace with `return <condition>`.

### 6e. Double negation

**Pattern:**
```
!!\w+
```

**Usage:**
```bash
Grep pattern: !!\w+
  --glob "*.{ts,tsx,js,jsx}"
```

**Notes:** Sometimes intentional for boolean coercion. Flag only when the value is already boolean or when `Boolean()` would be clearer.
