import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, buildLanguageContextSections } from './language-context.js';
import { buildPrompt, instructionsSection } from './builder.js';
import { buildTaskFormatExample } from './task-format-example.js';
import { requiredBriefSectionsProse } from './required-sections.js';

export function buildInstantPrompt(
  feature: string,
  projectContext: string,
  languageContext?: LanguageContext,
): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const sections = [
    { heading: 'Feature', body: feature },
    { heading: 'Project Context', body: projectContext },
    ...buildLanguageContextSections(ctx),
    instructionsSection(`You are given a tiny feature request — the requester has already decided this change is trivial. Emit the narrowest useful **Product Task Brief v1** records and stop.

1. Output ONLY a tasks list. No spec, no plan document.
2. A single Task Brief is fine; do not over-engineer. 1-5 briefs max.
3. Each brief MUST be self-contained so a small local model can execute it without additional context.
4. Required per brief: ${requiredBriefSectionsProse()}.
5. Keep Scope, Escalation, and Evidence concise for trivial work, but do not omit them; every Task Brief v1 must preserve those contract sections.
6. Outside fenced code blocks, lines containing only \`---\` are reserved for Task Brief frontmatter delimiters. Never use a bare \`---\` as a horizontal rule or phase-heading separator.

Each brief must be rendered in this exact markdown shape:

${buildTaskFormatExample(ctx)}`),
  ];

  return buildPrompt({
    title: 'Instant: Compile Task Briefs',
    intro:
      'You are compiling a minimal set of **Product Task Brief v1** records for a tiny change in an existing codebase. The brief is the durable contract; `tasks.md` is the markdown transport. Stay narrow — no spec, no plan.',
    sections,
    output:
      'Return the complete tasks.md content in your reply. Do not write tasks.md or any other project file yourself; SPLITBRIEF captures your reply and persists the tasks.md artifact inside the active session.',
  });
}
