export function buildTasksPrompt(spec: string, plan: string): string {
  return `# Write Implementation Tasks

You are breaking down an implementation plan into atomic, self-contained tasks. Each task will be sent independently to an implementer model for implementation  -  the model will have NO access to the spec, plan, or other tasks. Every task must contain ALL context needed to complete it.

## Specification
${spec}

## Implementation Plan
${plan}

## Instructions

Write a \`tasks.md\` file containing ordered, atomic tasks. Each task represents a single file operation (create or modify one file).

## Task Format

Each task MUST use this exact format:

\`\`\`markdown
---
id: T001
title: Short descriptive title
action: create | modify
file: src/path/to/file.ts
depends_on: [] | [T001, T002]
---

### Description
Detailed explanation of what to implement. Include all relevant context:
- WHY this code is needed (its role in the system)
- HOW it fits with other modules (what imports it, what it imports)
- WHAT specific behavior is expected

### Signature
\\\`\\\`\\\`typescript
// Exact function/type signatures to implement
export function exampleFn(param: Type): ReturnType
\\\`\\\`\\\`

### Type Definitions
\\\`\\\`\\\`typescript
// Copy ALL TypeScript interfaces/types referenced in the function signature,
// tests, or description. Copy verbatim from source files.
// Keep under ~300 tokens. Prioritize types in the function signature.
export interface ExampleType {
  field: string;
}
\\\`\\\`\\\`

### Implementation Steps
1. Step-by-step description of HOW to implement (not just WHAT)
2. Include specific function calls, patterns, and logic flow
3. 3-5 numbered steps maximum

### Tests
- Test case 1: Given X, expect Y
- Test case 2: Given A, expect B
- Edge case: Given null/empty/invalid, expect Z

### Constraints
- Do not add extra exports
- Follow ESM conventions (use .js extensions in imports)
- Any other rules specific to this task
\`\`\`

## Critical Rules

1. **Self-contained**: Each task must inline ALL context needed. Include relevant type definitions, import paths, function signatures from dependencies, and expected patterns. The implementer cannot look up other files.

2. **Atomic**: One task = one file. Either create a new file or modify an existing one. Never split a single file across tasks or combine multiple files in one task.

3. **Dependency-ordered**: Tasks must be ordered so that dependencies come first. Use \`depends_on\` to declare which tasks must complete before this one. If tasks have no dependencies on each other, they can be marked as parallelizable.

4. **Concrete tests**: Every task must include specific test cases with concrete inputs and expected outputs  -  not vague descriptions like "should work correctly."

5. **Inline type definitions**: If a task depends on types defined in another file, copy the relevant type definitions into the task description so the implementer has them.

6. **Implementation steps**: Every task must include 3-5 numbered steps in ### Implementation Steps describing HOW to implement the task. Include specific function calls, patterns to use, and logic flow. The implementer is a small model — it needs concrete guidance, not abstract descriptions.

7. **Type definitions section**: Every task must include a ### Type Definitions section with all TypeScript types referenced in the function signature, tests, or description. Copy the full interface/type definitions verbatim from source files. Max ~300 tokens — prioritize types that appear in the function signature.

8. **Import paths**: Specify exact import paths the implementer should use, including \`.js\` extensions for ESM.

9. **Pattern examples**: If the codebase has an established pattern the task should follow, include a brief example in the task.

## Output

Write the complete tasks.md content with all tasks in dependency order. Group related tasks into phases with a brief purpose statement for each phase.`;
}
