import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, buildLanguageContextSections } from './language-context.js';
import { buildPrompt, instructionsSection } from './builder.js';
import { buildTaskFormatExample } from './task-format-example.js';
import { requiredBriefSectionsProse } from './required-sections.js';

export function buildQuickPlanPrompt(
  feature: string,
  projectContext: string,
  languageContext?: LanguageContext,
): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);

  return buildPrompt({
    title: 'Quick: Compile Task Briefs',
    intro:
      'You are compiling **Product Task Brief v1** records for a small change in an existing codebase. Briefly analyze the project, then emit an ordered list of self-contained Task Briefs. The `tasks.md` file is the markdown transport; each brief is the durable contract a small implementer model will execute.',
    sections: [
      { heading: 'Specification', body: feature },
      { heading: 'Project Context', body: projectContext },
      ...buildLanguageContextSections(ctx),
      instructionsSection(`1. Briefly review the codebase structure and identify files to create or modify.
2. Compose the complete \`tasks.md\` content with atomic Task Briefs. One brief = one file.

Each brief must be rendered in this exact markdown shape:

${buildTaskFormatExample(ctx)}`),
      {
        heading: 'Rules',
        body: `- One brief per file. Self-contained with all context inlined.
- Dependency-ordered. Use \`depends_on\` for sequencing.
- No spec or plan document needed — Task Briefs are the artifact.
- Required sections per brief: ${requiredBriefSectionsProse()}.
- \`### Scope\` must include \`**In bounds:**\` / \`**Out of bounds:**\` bullets, even when the boundary is short.
- \`### Escalation\` must state when the implementer should stop instead of guessing.
- \`### Evidence\` must state the reviewable proof expected from the task (passing tests, typecheck, changed files, or equivalent).
- Outside fenced code blocks, lines containing only \`---\` are reserved for Task Brief frontmatter delimiters. Never use a bare \`---\` as a horizontal rule or phase-heading separator.`,
      },
    ],
    output:
      'Return the complete tasks.md content in your reply. Do not write tasks.md or any other project file yourself; SPLITBRIEF captures your reply and persists the tasks.md artifact inside the active session.',
  });
}
