import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, buildLanguageContextSections } from './language-context.js';
import { buildPrompt, instructionsSection } from './builder.js';
import { buildTaskFormatExample } from './task-format-example.js';
import { requiredBriefSectionsProse } from './required-sections.js';

export type QuickPlanPromptInput = Readonly<{
  feature: string;
  projectContext: string;
  languageContext?: LanguageContext | undefined;
  trivial?: boolean | undefined;
}>;

export function buildQuickPlanPrompt(input: QuickPlanPromptInput): string {
  const { feature, projectContext, trivial } = input;
  const ctx = input.languageContext ?? buildLanguageContext(undefined);
  const firstStep = trivial
    ? 'This request was auto-classified as a tiny edit, so skip the codebase-structure survey unless the change clearly spans several files. A single Task Brief is fine; do not over-engineer. 1-5 briefs max.'
    : 'Briefly review the codebase structure and identify files to create or modify.';

  return buildPrompt({
    title: 'Quick: Compile Task Briefs',
    intro: trivial
      ? 'You are compiling the narrowest useful set of **Product Task Brief v1** records for a tiny change in an existing codebase. Emit an ordered list of self-contained Task Briefs and stop — no spec, no plan. The `tasks.md` file is the markdown transport; each brief is the durable contract a small implementer model will execute.'
      : 'You are compiling **Product Task Brief v1** records for a small change in an existing codebase. Briefly analyze the project, then emit an ordered list of self-contained Task Briefs. The `tasks.md` file is the markdown transport; each brief is the durable contract a small implementer model will execute.',
    sections: [
      { heading: 'Specification', body: feature },
      { heading: 'Project Context', body: projectContext },
      ...buildLanguageContextSections(ctx),
      instructionsSection(`1. ${firstStep}
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
- Outside fenced code blocks, lines containing only \`---\` are reserved for Task Brief frontmatter delimiters. Never use a bare \`---\` as a horizontal rule or phase-heading separator.${
          trivial
            ? '\n- Keep Scope, Escalation, and Evidence concise for trivial work, but do not omit them; every Task Brief v1 must preserve those contract sections.'
            : ''
        }`,
      },
    ],
    output:
      'Return the complete tasks.md content in your reply. Do not write tasks.md or any other project file yourself; SPLITBRIEF captures your reply and persists the tasks.md artifact inside the active session.',
  });
}
