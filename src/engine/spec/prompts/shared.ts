export const ESM_CONVENTION = 'ESM imports with .js extensions, pure functions, no classes';

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

### Implementation Steps
1. Step-by-step HOW to implement
2. Specific function calls and patterns
3. 3-5 steps max

### Tests
- Test case with concrete inputs/outputs

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
