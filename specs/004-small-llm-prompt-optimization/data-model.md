# Data Model: diptych v0.2 -- Small LLM Prompt Optimization

**Source**: [spec.md](spec.md) Key Entities section

## Entities

### Task (extended)

Extends the existing `Task` type from `src/types.ts` with two new fields.

| Field | Type | Description | New? |
|-------|------|-------------|------|
| id | `string` | Task identifier (e.g., "T001") | No |
| title | `string` | Human-readable title | No |
| action | `'create' \| 'modify'` | Whether to create or modify a file | No |
| file | `string` | Target file path (relative to project root) | No |
| dependsOn | `string[]` | Task IDs that must complete first | No |
| description | `string` | What to implement | No |
| signature | `string \| undefined` | Exact function signature with types | No |
| currentCode | `string \| undefined` | Current file contents (for modify tasks) | No |
| tests | `string[]` | Concrete test cases with expected values | No |
| constraints | `string[]` | What NOT to do | No |
| pattern | `string \| undefined` | Example from codebase to follow | No |
| status | `TaskStatus` | Current status | No |
| **typeDefs** | **`string`** | **Inlined type definitions (all types referenced in signature/tests)** | **Yes** |
| **implSteps** | **`string[]`** | **3-5 implementation steps (HOW to implement)** | **Yes** |

### TokenBudget (new)

Computed breakdown of token allocation within a task prompt. Used by the formatter to decide which degradation level to use.

| Field | Type | Description |
|-------|------|-------------|
| system | `number` | Tokens for system preamble + few-shot example |
| taskBody | `number` | Tokens for task description, signature, tests, constraints |
| typeDefs | `number` | Tokens for inlined type definitions |
| implSteps | `number` | Tokens for implementation steps |
| codeContext | `number` | Tokens for current code (whole-file or function-level) |
| outputReserve | `number` | Tokens reserved for model output (25% of contextLength) |
| total | `number` | Sum of all components |
| remaining | `number` | contextLength - total (must be >= 0) |

### CodeContext (new)

Represents the code included in a MODIFY task prompt. Discriminated union based on `mode`.

**Whole-file mode** (files that fit in budget):

| Field | Type | Description |
|-------|------|-------------|
| mode | `'whole-file'` | Discriminant |
| content | `string` | Complete file contents |

**Function-level mode** (files too large for budget):

| Field | Type | Description |
|-------|------|-------------|
| mode | `'function-level'` | Discriminant |
| imports | `string` | Import section of the file (lines 0 to first non-import) |
| targetFunction | `string` | The function to modify + 5 lines surrounding context |
| surroundingContext | `string` | Brief summary of other exports in the file (names only) |

## Changes to Existing Entities

### Task Parser Sections

The parser (`src/spec/parser.ts`) currently extracts these sections from task markdown:

| Section | Current | v0.2 |
|---------|---------|------|
| `### Description` | Yes | Yes |
| `### Signature` | Yes | Yes |
| `### Tests` | Yes | Yes |
| `### Constraints` | Yes | Yes |
| `### Pattern` | Yes | Yes |
| `### Type Definitions` | No | **New** |
| `### Implementation Steps` | No | **New** |

### System Preamble

Current (`src/spec/formatter.ts`): 6 rules, ~104 tokens.
v0.2: Same rules + 10-15 line few-shot example. ~500 tokens total.

### Task Prompt Structure (v0.2)

```
[SYSTEM: preamble + few-shot example]

[USER:]
## Project: {name}
## Runtime: {runtime}

## Task: {title}
### Action: {action}
### File: {file}

### What To Do
{description}

### Function Signature
{signature}

### Type Definitions
{typeDefs}

### Implementation Steps
{implSteps}

### Tests (must pass after implementation)
{tests}

### Current Code
{codeContext — whole-file or function-level}

### Constraints
{constraints}

Output the complete file contents for {file}. No markdown fences. No explanations.
```

Ordering follows "lost-in-the-middle" mitigation from v0.1 research:
1. Task description + signature — beginning (high attention)
2. Type definitions — early (good attention)
3. Implementation steps — early-middle
4. Tests — middle
5. Current code — middle-end
6. Constraints + output instruction — end (high attention)
