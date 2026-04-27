export const ESM_CONVENTION = 'ESM imports with .js extensions, pure functions, no classes';

// Markdown rendering of one Product Task Brief v1. Section -> brief mapping:
//   frontmatter             = Identity
//   ### Description         = Intent
//   ### Signature / Current Code / Types / Pattern = Code Context
//   ### Implementation Steps= Implementation Plan
//   ### Tests               = Validation
//   ### Constraints         = Constraints
//   ### Scope               = Scope (in/out of bounds)
//   ### Escalation          = Escalation (when to stop and ask)
//   ### Evidence            = Evidence (proof to leave behind)
export const TASK_FORMAT_EXAMPLE = `\`\`\`markdown
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

### Current Code
\\\`\\\`\\\`typescript
// Relevant existing code for modify tasks
\\\`\\\`\\\`

### Pattern
Existing codebase pattern or exact snippet the implementer should follow.

### Implementation Steps
1. Step-by-step HOW to implement
2. Specific function calls and patterns
3. 3-5 steps max

### Tests
- Test case with concrete inputs/outputs

### Scope
**In bounds:**
- Concrete change this brief is allowed to make
**Out of bounds:**
- Adjacent change the implementer must NOT make

### Escalation
- Stop and ask when the required behavior is ambiguous, when a dependency is missing, or when the brief conflicts with local code.

### Evidence
- Reviewable proof the task completed (passing tests, typecheck, changed files, behavioral note).

### Constraints
- ESM imports with .js extensions
- Follow existing codebase patterns
\`\`\``;

export interface PromptSection {
  heading: string;
  body: string;
}

interface PromptSpec {
  title: string;
  intro: string;
  sections: PromptSection[];
  output?: string | undefined;
}

export function buildPrompt(spec: PromptSpec): string {
  const parts: string[] = [`# ${spec.title}`, '', spec.intro];

  for (const section of spec.sections) {
    parts.push('', `## ${section.heading}`, section.body);
  }

  if (spec.output !== undefined) {
    parts.push('', '## Output', spec.output);
  }

  return parts.join('\n');
}

export function instructionsSection(body: string): PromptSection {
  return { heading: 'Instructions', body };
}

export function requiredSectionsSection(body: string): PromptSection {
  return { heading: 'Required Sections', body };
}
