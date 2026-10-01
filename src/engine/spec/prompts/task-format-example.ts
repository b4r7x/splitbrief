import {
  buildLanguageContext,
  codeFenceLanguage,
  type LanguageContext,
} from './language-context.js';

export function buildTaskFormatExample(languageContext?: LanguageContext): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const codeFenceStart = `\`\`\`${codeFenceLanguage(ctx)}`;

  return `Frontmatter values are parsed literally. Never emit an alternation such as \`create | modify\` — choose one value:

- \`id\` — unique brief id: \`T001\`, \`T002\`, ... in emission order.
- \`title\` — one short line.
- \`action\` — exactly \`create\` or \`modify\`.
- \`file\` — one project-relative path (no leading \`/\`, no \`..\`): the slice's anchor.
- \`files\` — optional YAML list of every project-relative path the slice writes, \`file\` among them. Omit it when the slice writes only the anchor.
- \`depends_on\` — YAML list of brief ids this one must follow: \`[]\` when independent, \`[T001, T002]\` when it must run after both.

Copy this shape and substitute real values:

---
id: T001
title: Short descriptive title
action: create
file: src/path/to/file${ctx.fileExtension}
files: [src/path/to/file${ctx.fileExtension}, src/path/to/file.test${ctx.fileExtension}]
depends_on: []
---

### Description
What to implement and why. Include all context the implementer needs.

### Signature
${codeFenceStart}
${signatureExample(ctx)}
\`\`\`

### Type Definitions
${codeFenceStart}
${typeDefinitionsExample(ctx)}
\`\`\`

### Current Code
${codeFenceStart}
${currentCodeExample(ctx)}
\`\`\`

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
- Context the change works within
**Out of bounds:**
- Explicit exclusion the reviewer checks
**Approved out of bounds:**
- A further path the planner already approved

### Escalation
- Stop and ask when the required behavior is ambiguous, when a dependency is missing, or when the brief conflicts with local code.

### Evidence
- Reviewable proof the task completed (the focused tests that pass, the changed files, the behavior a reviewer can check).

### Constraints
- ${ctx.importConvention}
- Follow existing codebase patterns`;
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
