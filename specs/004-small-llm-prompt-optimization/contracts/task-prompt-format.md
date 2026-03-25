# Task Prompt Format Contract: tiny-spec v0.2

## System Message

```
SYSTEM: You are a TypeScript code generator. You write clean, working TypeScript code.
Rules:
- Output ONLY the complete file contents
- Do NOT include markdown code fences
- Do NOT include explanations before or after the code
- Do NOT add comments unless specified in the task
- Use ESM imports with .js extensions
- Follow the exact function signatures provided

Example output for a typical task:

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './types.js';

export function loadConfig(dir: string): Config {
  const filePath = join(dir, 'config.json');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    name: parsed.name ?? 'default',
    version: parsed.version ?? '1.0.0',
  };
}
```

## User Message (Task Prompt)

### CREATE task

```
## Project: {project.name}
## Runtime: {project.runtime}

## Task: {task.title}
### Action: create
### File: {task.file}

### What To Do
{task.description}

### Function Signature
{task.signature}

### Type Definitions
{task.typeDefs}

### Implementation Steps
{task.implSteps joined by newlines}

### Tests (must pass after implementation)
{task.tests joined by newlines}

### Constraints
- {task.constraints}
- Do NOT invent new functions not described in the task
- Do NOT add features not described in the task
- Do NOT import packages not listed in the project dependencies

Output the complete file contents for {task.file}. No markdown fences. No explanations.
```

### MODIFY task (whole-file mode)

Same as CREATE but adds:

```
### Current Code
{entire file contents}
```

### MODIFY task (function-level mode)

Same as CREATE but adds:

```
### Current Code (relevant section)
// === Imports ===
{import lines from file}

// === Target Function ===
{target function with 5 lines before/after}

// === Other Exports (do not modify) ===
{list of other export names in the file}

Modify ONLY the target function. Keep all other exports unchanged.
Output the complete file contents for {task.file}. No markdown fences. No explanations.
```

## Retry Prompt

All retry attempts include full task context. Template:

```
{framing message}

Error from previous attempt:
{error message}

## Task: {task.title}
### Action: {task.action}
### File: {task.file}

### What To Do
{task.description}

### Function Signature
{task.signature}

### Type Definitions
{task.typeDefs}

### Implementation Steps
{task.implSteps}

### Tests (must pass after implementation)
{task.tests}

### Current Code
{latest file content — may differ from original due to partial fixes}

### Constraints
{all constraints — none omitted}

Output the complete file contents for {task.file}. No markdown fences. No explanations.
```

### Framing by attempt

| Attempt | Temperature | Framing |
|---------|-------------|---------|
| 1 | base + 0.1 | "Your previous attempt had an error. Fix it:" |
| 2 | base + 0.2 | "Previous attempts failed. Here is the task rephrased differently:" |
| 3 | base + 0.3 | "Multiple attempts have failed. Try a completely different approach:" |

## Token Budget

| Component | Typical tokens | Max tokens |
|-----------|---------------|------------|
| System preamble + few-shot | ~500 | 600 |
| Task body (desc, sig, tests, constraints) | ~600 | 1500 |
| Type definitions | ~300 | 500 |
| Implementation steps | ~150 | 300 |
| Code context | ~400-1000 | auto-scaled |
| **Output reserve (25%)** | **2048** (8K) | **8192** (32K) |

### Auto-degradation cascade

1. Compute budget: `available = contextLength - outputReserve - system - taskBody - typeDefs - implSteps`
2. If `available >= estimateTokens(wholeFile)`: use whole-file
3. Else if `available >= estimateTokens(functionLevel)`: use function-level
4. Else if `available > 0`: truncate middle with marker
5. Else: error "task too large for configured context window"
