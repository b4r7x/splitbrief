import type { Task } from '../../../core/schemas/task.js';
import { sliceRuleText } from '../../../core/pipeline-spec/brief.js';
import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, buildLanguageContextSections } from './language-context.js';
import {
  plannerConversationSection,
  buildPrompt,
  instructionsSection,
  skillsSection,
} from './builder.js';
import { buildTaskFormatExample } from './task-format-example.js';
import { formatTasks } from '../formatter.js';
import { TASK_BRIEF_HEADINGS } from '../headings.js';

const H = TASK_BRIEF_HEADINGS;

/** The gates are SPLITBRIEF's, so a brief never orders the implementer to run them. */
export const GATES_ARE_SPLITBRIEFS =
  'Name the focused test files and cases only. SPLITBRIEF runs typecheck, lint and the affected tests after every brief, so never tell the implementer to run a project-wide gate, the whole suite, or a screenshot/render tool.';

export const EVIDENCE_PROOF =
  "(the focused tests that pass, the changed files, the behavior a reviewer can check). Renders and project-wide gates are the review seat's and SPLITBRIEF's evidence, not the implementer's steps.";

export const SCOPE_MEANING =
  '`files` are the suggested files; **In bounds** is context; **Out of bounds** lists the explicit exclusions the reviewer checks.';

export function briefContract(ctx: LanguageContext): string {
  return `Every brief must cover these nine semantic sections, even when one is brief:

1. **Identity** — frontmatter \`id\`, \`title\`, \`action\`, \`file\`, optional \`files\`, \`depends_on\`.
2. **Intent** — \`${H.description.heading}\`: what the change is and why it matters.
3. **Scope** — \`${H.scope.heading}\` with \`**In bounds:**\`, \`**Out of bounds:**\`, and optional \`**Approved out of bounds:**\` bullet lists. REQUIRED in standard mode. ${SCOPE_MEANING}
4. **Code Context** — \`${H.signature.heading}\`, \`${H.currentCode.heading}\`, \`${H.typeDefs.heading}\`, and \`${H.pattern.heading}\`: copied verbatim from the project when relevant. The implementer cannot look up other files.
5. **Implementation Plan** — \`${H.implementationSteps.heading}\`: 3-5 numbered steps with concrete function calls and patterns.
6. **Validation** — \`${H.tests.heading}\`: REQUIRED concrete test cases with specific inputs and expected outputs, in every brief. No phrases like "should work correctly", and no deferring the cases to whichever brief owns the test file.
7. **Constraints** — \`${H.constraints.heading}\`: invariants, dependency rules, ${ctx.importConvention}, refusal conditions.
8. **Escalation** — \`${H.escalation.heading}\`: bullets describing when the implementer must stop and ask instead of guessing. Required whenever the brief contains plausible ambiguity.
9. **Evidence** — \`${H.evidence.heading}\`: REQUIRED bullets describing the reviewable proof that should exist when the brief is done ${EVIDENCE_PROOF}

Every brief must also leave typecheck, lint and tests green on its own. Never plan for a failing gate: when a change would break a sibling file, widen the brief's \`files\` to include it, keep the change backward compatible with an optional property and a default, or split the work so each brief lands whole. Before a brief deletes or renames an export, its \`files\` name every consumer found by searching the whole repository — \`src/\` and \`testing/\` alike, colocated and sibling tests included.`;
}

export function criticalRules(ctx: LanguageContext): string {
  return `1. **Self-contained**: Each brief must inline ALL context needed. Include relevant current code for modify tasks, ${ctx.typeAnnotationStyle}, import paths, function signatures from dependencies, and expected patterns.

2. **Coherent**: ${sliceRuleText()}

3. **Dependency-ordered**: Briefs must be ordered so dependencies come first. Use \`depends_on\` to declare which briefs must complete first. Independent briefs can run in parallel.

4. **Concrete validation**: Every \`${H.tests.heading}\` block must list specific test cases with concrete inputs and expected outputs, as \`-\` bullets. This holds for every brief, including one whose test file a different brief owns: list the cases that verify THIS brief's change. Never replace the bullets with prose that defers validation to another brief. ${GATES_ARE_SPLITBRIEFS}

5. **Inline type definitions**: Copy referenced ${ctx.typeAnnotationStyle} or data shape definitions verbatim into \`${H.typeDefs.heading}\`. Max ~300 tokens — prioritize definitions that appear in the function signature.

6. **Import paths**: Specify exact imports using ${ctx.importConvention}.

7. **Escalation, not guessing**: If a brief could be interpreted multiple ways, list those decision points under \`${H.escalation.heading}\` rather than baking a guess into the steps.

8. **Evidence is not implementation**: \`${H.evidence.heading}\` describes the proof that survives after the brief is done, not the steps that produce it.

9. **Reserved delimiter**: Outside fenced code blocks, lines containing only \`---\` are reserved for Task Brief frontmatter delimiters. Never use a bare \`---\` as a horizontal rule or phase-heading separator.`;
}

/** The implementer gets the run's skills beside every brief, so a brief restates none of them. */
export const SKILLS_WITH_EVERY_BRIEF =
  'Every brief reaches the implementer together with the Active Project Skills section: do not copy that section into a brief, and do not point a brief at skill files.';

export type TasksPromptInput = Readonly<{
  spec: string;
  plan: string;
  languageContext?: LanguageContext | undefined;
  currentTasks?: Task[] | undefined;
  skillsContext?: string | undefined;
}>;

export function buildTasksPrompt(input: TasksPromptInput): string {
  const ctx = input.languageContext ?? buildLanguageContext(undefined);
  const currentTasks = input.currentTasks;

  return buildPrompt({
    title: 'Compile Product Task Briefs',
    intro: `You are compiling a set of **Product Task Brief v1** records — the durable contract the implementer model will execute against. Each brief is sent independently to a small implementer model that has NO access to this prompt, the spec, the plan, or sibling briefs. Every brief must stand on its own.${input.skillsContext ? ` ${SKILLS_WITH_EVERY_BRIEF}` : ''} The \`tasks.md\` markdown file is the transport; the brief is the meaning.`,
    sections: [
      plannerConversationSection,
      { heading: 'Specification', body: input.spec },
      { heading: 'Implementation Plan', body: input.plan },
      ...skillsSection(input.skillsContext),
      ...(currentTasks && currentTasks.length > 0
        ? [
            {
              heading: 'Current Task Briefs',
              body: `The session already has these Task Briefs on disk. When regenerating, preserve every unmentioned brief unchanged unless the user feedback explicitly requires edits.\n\n${formatTasks(currentTasks)}`,
            },
          ]
        : []),
      ...buildLanguageContextSections(ctx),
      instructionsSection(
        'Compose the complete `tasks.md` content with one Task Brief per markdown block, ordered by dependency. Each brief delivers one coherent outcome; `files` lists every path it writes.',
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
      'Return the complete tasks.md content in your reply, with all Task Briefs in dependency order. Group related briefs into phases with a brief purpose statement for each phase. Do not write tasks.md or any other project file yourself; SPLITBRIEF captures your reply and persists the tasks.md artifact inside the active session.',
  });
}
