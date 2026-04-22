import { TASK_FORMAT_EXAMPLE, buildPrompt, instructionsSection } from './shared.js';

export function buildQuickPlanPrompt(feature: string, projectContext: string): string {
  return buildPrompt({
    title: 'Quick: Compile Task Briefs',
    intro: 'You are compiling **Product Task Brief v1** records for a small change in an existing codebase. Briefly analyze the project, then emit an ordered list of self-contained Task Briefs. The `tasks.md` file is the markdown transport; each brief is the durable contract a small implementer model will execute.',
    sections: [
      { heading: 'Specification', body: feature },
      { heading: 'Project Context', body: projectContext },
      instructionsSection(`1. Briefly review the codebase structure and identify files to create or modify.
2. Output a \`tasks.md\` file with atomic Task Briefs. One brief = one file.

Each brief must be rendered in this exact markdown shape:

${TASK_FORMAT_EXAMPLE}`),
      {
        heading: 'Rules',
        body: `- One brief per file. Self-contained with all context inlined.
- Dependency-ordered. Use \`depends_on\` for sequencing.
- No spec or plan document needed — Task Briefs are the artifact.
- Required sections per brief: Description (Intent), Implementation Steps, Tests (Validation), Constraints, Type Definitions.
- Add \`### Scope\` with \`**In bounds:**\` / \`**Out of bounds:**\` bullets whenever the change touches an area where drift is plausible.
- Add \`### Escalation\` bullets whenever the request is ambiguous or could be interpreted more than one way.
- Add \`### Evidence\` bullets when the brief should leave behind specific reviewable proof (passing tests, typecheck, changed files).`,
      },
    ],
    output: 'Write the complete tasks.md content.',
  });
}
