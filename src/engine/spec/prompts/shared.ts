import {
  buildLanguageContext,
  codeFenceLanguage,
  type LanguageContext,
} from './language-context.js';

export function buildTaskFormatExample(languageContext?: LanguageContext): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const fenceLanguage = codeFenceLanguage(ctx);
  const codeFenceStart = fenceLanguage ? `\\\`\\\`\\\`${fenceLanguage}` : '\\`\\`\\`';

  return `\`\`\`markdown
---
id: T001
title: Short descriptive title
action: create | modify
file: src/path/to/file${ctx.fileExtension}
depends_on: [] | [T001, T002]
---

### Description
What to implement and why. Include all context the implementer needs.

### Signature
${codeFenceStart}
${signatureExample(ctx)}
\\\`\\\`\\\`

### Type Definitions
${codeFenceStart}
${typeDefinitionsExample(ctx)}
\\\`\\\`\\\`

### Current Code
${codeFenceStart}
${currentCodeExample(ctx)}
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
- ${ctx.importConvention}
- Follow existing codebase patterns
\`\`\``;
}

function signatureExample(ctx: LanguageContext): string {
  switch (ctx.language) {
    case 'TypeScript':
      return 'export function exampleFn(param: Type): ReturnType';
    case 'JavaScript':
      return 'export function exampleFn(param) { /* ... */ }';
    case 'Python':
      return 'def example_fn(param: Type) -> ReturnType:';
    case 'Go':
      return 'func ExampleFn(param Type) ReturnType';
    case 'Rust':
      return 'pub fn example_fn(param: Type) -> ReturnType';
    default:
      return 'Function or method signature appropriate for the project language';
  }
}

function typeDefinitionsExample(ctx: LanguageContext): string {
  switch (ctx.language) {
    case 'TypeScript':
      return '// All referenced types, copied verbatim';
    case 'JavaScript':
      return '// Relevant JSDoc typedefs or data shapes, copied verbatim';
    case 'Python':
      return '# Relevant Python type hints, protocols, or data shapes, copied verbatim';
    case 'Go':
      return '// Relevant Go structs, interfaces, or type aliases, copied verbatim';
    case 'Rust':
      return '// Relevant Rust structs, traits, enums, or type aliases, copied verbatim';
    default:
      return 'Referenced types or data shapes, copied verbatim when the language uses them';
  }
}

function currentCodeExample(ctx: LanguageContext): string {
  switch (ctx.language) {
    case 'Python':
      return '# Relevant existing code for modify tasks';
    default:
      return '// Relevant existing code for modify tasks';
  }
}

export type PromptSection = {
  heading: string;
  body: string;
};

type PromptSpec = {
  title: string;
  intro: string;
  sections: PromptSection[];
  output?: string | undefined;
};

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

export function fenced(body: string, lang = ''): string {
  return '```' + lang + '\n' + body + '\n```';
}

export function instructionsSection(body: string): PromptSection {
  return { heading: 'Instructions', body };
}

export function requiredSectionsSection(body: string): PromptSection {
  return { heading: 'Required Sections', body };
}
