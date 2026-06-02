import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, buildLanguageContextSections } from './language-context.js';
import { buildPrompt, instructionsSection } from './prompt-builder.js';
import { buildTaskFormatExample } from './task-format-example.js';
import { TASK_BRIEF_HEADINGS } from '../headings.js';

const H = TASK_BRIEF_HEADINGS;

function briefContract(ctx: LanguageContext): string {
  return `Every brief must cover these nine semantic sections, even when one is brief:

1. **Identity** — frontmatter \`id\`, \`title\`, \`action\`, \`file\`, \`depends_on\`.
2. **Intent** — \`${H.description.heading}\`: what the change is and why it matters.
3. **Scope** — \`${H.scope.heading}\` with \`**In bounds:**\` and \`**Out of bounds:**\` bullet lists. REQUIRED in standard mode so the implementer cannot drift into adjacent files or features.
4. **Code Context** — \`${H.signature.heading}\`, \`${H.currentCode.heading}\`, \`${H.typeDefs.heading}\`, and \`${H.pattern.heading}\`: copied verbatim from the project when relevant. The implementer cannot look up other files.
5. **Implementation Plan** — \`${H.implementationSteps.heading}\`: 3-5 numbered steps with concrete function calls and patterns.
6. **Validation** — \`${H.tests.heading}\`: REQUIRED concrete test cases with specific inputs and expected outputs. No phrases like "should work correctly."
7. **Constraints** — \`${H.constraints.heading}\`: invariants, dependency rules, ${ctx.importConvention}, refusal conditions.
8. **Escalation** — \`${H.escalation.heading}\`: bullets describing when the implementer must stop and ask instead of guessing. Required whenever the brief contains plausible ambiguity.
9. **Evidence** — \`${H.evidence.heading}\`: REQUIRED bullets describing the reviewable proof that should exist when the brief is done (passing tests, validation output, changed files, behavioral note).`;
}

function criticalRules(ctx: LanguageContext): string {
  return `1. **Self-contained**: Each brief must inline ALL context needed. Include relevant current code for modify tasks, ${ctx.typeAnnotationStyle}, import paths, function signatures from dependencies, and expected patterns.

2. **Atomic**: One brief = one file. Either create a new file or modify an existing one. Never split a single file across briefs or combine multiple files in one brief.

3. **Dependency-ordered**: Briefs must be ordered so dependencies come first. Use \`depends_on\` to declare which briefs must complete first. Independent briefs can run in parallel.

4. **Concrete validation**: Every \`${H.tests.heading}\` block must list specific test cases with concrete inputs and expected outputs.

5. **Inline type definitions**: Copy referenced ${ctx.typeAnnotationStyle} or data shape definitions verbatim into \`${H.typeDefs.heading}\`. Max ~300 tokens — prioritize definitions that appear in the function signature.

6. **Import paths**: Specify exact imports using ${ctx.importConvention}.

7. **Escalation, not guessing**: If a brief could be interpreted multiple ways, list those decision points under \`${H.escalation.heading}\` rather than baking a guess into the steps.

8. **Evidence is not implementation**: \`${H.evidence.heading}\` describes the proof that survives after the brief is done, not the steps that produce it.`;
}

export function buildTasksPrompt(
  spec: string,
  plan: string,
  languageContext?: LanguageContext,
): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);

  return buildPrompt({
    title: 'Compile Product Task Briefs',
    intro:
      'You are compiling a set of **Product Task Brief v1** records — the durable contract the implementer model will execute against. Each brief is sent independently to a small implementer model that has NO access to this prompt, the spec, the plan, or sibling briefs. Every brief must stand on its own. The `tasks.md` markdown file is the transport; the brief is the meaning.',
    sections: [
      { heading: 'Specification', body: spec },
      { heading: 'Implementation Plan', body: plan },
      ...buildLanguageContextSections(ctx),
      instructionsSection(
        'Write a `tasks.md` file containing one Task Brief per markdown block, ordered by dependency. Each brief represents a single file operation (create or modify one file).',
      ),
      {
        heading: 'Task Brief Format',
        body: `Each Task Brief MUST be rendered in this exact markdown shape. Frontmatter carries Identity; section headings carry the rest of the contract:

${buildTaskFormatExample(ctx)}`,
      },
      {
        heading: 'Brief Contract (required semantics)',
        body: briefContract(ctx),
      },
      {
        heading: 'Critical Rules',
        body: criticalRules(ctx),
      },
    ],
    output:
      'Write the complete tasks.md content with all Task Briefs in dependency order. Group related briefs into phases with a brief purpose statement for each phase.',
  });
}
