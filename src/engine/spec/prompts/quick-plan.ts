export function buildQuickPlanPrompt(feature: string, projectContext: string): string {
  return `# Quick Plan: Generate Tasks

You are implementing a feature in an existing codebase. Briefly analyze the project, then produce an ordered list of atomic implementation tasks.

## Feature Request
${feature}

## Project Context
${projectContext}

## Instructions

1. Briefly review the codebase structure and identify files to create or modify.
2. Output a \`tasks.md\` file with atomic, self-contained tasks. Each task = one file.

Use this exact format for each task:

\`\`\`markdown
---
id: T001
title: Short descriptive title
action: create | modify
file: src/path/to/file.ts
depends_on: [] | [T001, T002]
---

### Description
What to implement and why. Include all context the implementer needs.

### Signature
\\\`\\\`\\\`typescript
export function exampleFn(param: Type): ReturnType
\\\`\\\`\\\`

### Type Definitions
\\\`\\\`\\\`typescript
// All referenced types, copied verbatim
\\\`\\\`\\\`

### Implementation Steps
1. Step-by-step HOW to implement
2. Specific function calls and patterns
3. 3-5 steps max

### Tests
- Test case with concrete inputs/outputs

### Constraints
- ESM imports with .js extensions
- Follow existing codebase patterns
\`\`\`

## Rules
- One task per file. Self-contained with all context inlined.
- Dependency-ordered. Use \`depends_on\` for sequencing.
- No spec or plan document needed — just tasks.

## Output
Write the complete tasks.md content.`;
}
