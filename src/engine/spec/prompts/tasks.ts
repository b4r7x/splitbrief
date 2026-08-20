import type { Task } from '../../../core/schemas/task.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationCallEnvelope,
} from '../../../core/schemas/task-compilation.js';
import type { TaskManifestBatch } from '../tasks/partition.js';
import type { TaskManifestItem } from '../tasks/manifest.js';
import { TASK_COMPILATION_FAILURE_CODE } from '../tasks/task-compilation-codes.js';
import type { TaskCompilationProgramId } from '../../../core/schemas/task-compilation.js';
import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, buildLanguageContextSections } from './language-context.js';
import { buildPrompt, instructionsSection } from './builder.js';
import { buildTaskFormatExample } from './task-format-example.js';
import { error, matches } from '../../../utils/error.js';
import { formatTasks } from '../formatter.js';
import { TASK_BRIEF_HEADINGS } from '../headings.js';

const H = TASK_BRIEF_HEADINGS;

function briefContract(ctx: LanguageContext): string {
  return `Every brief must cover these nine semantic sections, even when one is brief:

1. **Identity** — frontmatter \`id\`, \`title\`, \`action\`, \`file\`, \`depends_on\`.
2. **Intent** — \`${H.description.heading}\`: what the change is and why it matters.
3. **Scope** — \`${H.scope.heading}\` with \`**In bounds:**\`, \`**Out of bounds:**\`, and optional \`**Approved out of bounds:**\` bullet lists. REQUIRED in standard mode so the implementer cannot drift into adjacent files or features.
4. **Code Context** — \`${H.signature.heading}\`, \`${H.currentCode.heading}\`, \`${H.typeDefs.heading}\`, and \`${H.pattern.heading}\`: copied verbatim from the project when relevant. The implementer cannot look up other files.
5. **Implementation Plan** — \`${H.implementationSteps.heading}\`: 3-5 numbered steps with concrete function calls and patterns.
6. **Validation** — \`${H.tests.heading}\`: REQUIRED concrete test cases with specific inputs and expected outputs, in every brief. No phrases like "should work correctly", and no deferring the cases to whichever brief owns the test file.
7. **Constraints** — \`${H.constraints.heading}\`: invariants, dependency rules, ${ctx.importConvention}, refusal conditions.
8. **Escalation** — \`${H.escalation.heading}\`: bullets describing when the implementer must stop and ask instead of guessing. Required whenever the brief contains plausible ambiguity.
9. **Evidence** — \`${H.evidence.heading}\`: REQUIRED bullets describing the reviewable proof that should exist when the brief is done (passing tests, validation output, changed files, behavioral note).`;
}

function criticalRules(ctx: LanguageContext): string {
  return `1. **Self-contained**: Each brief must inline ALL context needed. Include relevant current code for modify tasks, ${ctx.typeAnnotationStyle}, import paths, function signatures from dependencies, and expected patterns.

2. **Atomic**: One brief = one file. Either create a new file or modify an existing one. Never split a single file across briefs or combine multiple files in one brief.

3. **Dependency-ordered**: Briefs must be ordered so dependencies come first. Use \`depends_on\` to declare which briefs must complete first. Independent briefs can run in parallel.

4. **Concrete validation**: Every \`${H.tests.heading}\` block must list specific test cases with concrete inputs and expected outputs, as \`-\` bullets. This holds for every brief, including one whose test file a different brief owns: list the cases that verify THIS brief's change. Never replace the bullets with prose that defers validation to another brief.

5. **Inline type definitions**: Copy referenced ${ctx.typeAnnotationStyle} or data shape definitions verbatim into \`${H.typeDefs.heading}\`. Max ~300 tokens — prioritize definitions that appear in the function signature.

6. **Import paths**: Specify exact imports using ${ctx.importConvention}.

7. **Escalation, not guessing**: If a brief could be interpreted multiple ways, list those decision points under \`${H.escalation.heading}\` rather than baking a guess into the steps.

8. **Evidence is not implementation**: \`${H.evidence.heading}\` describes the proof that survives after the brief is done, not the steps that produce it.

9. **Reserved delimiter**: Outside fenced code blocks, lines containing only \`---\` are reserved for Task Brief frontmatter delimiters. Never use a bare \`---\` as a horizontal rule or phase-heading separator.`;
}

export function buildTasksPrompt(
  spec: string,
  plan: string,
  languageContext?: LanguageContext,
  currentTasks?: Task[],
): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);

  return buildPrompt({
    title: 'Compile Product Task Briefs',
    intro:
      'You are compiling a set of **Product Task Brief v1** records — the durable contract the implementer model will execute against. Each brief is sent independently to a small implementer model that has NO access to this prompt, the spec, the plan, or sibling briefs. Every brief must stand on its own. The `tasks.md` markdown file is the transport; the brief is the meaning.',
    sections: [
      { heading: 'Specification', body: spec },
      { heading: 'Implementation Plan', body: plan },
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
        'Compose the complete `tasks.md` content with one Task Brief per markdown block, ordered by dependency. Each brief represents a single file operation (create or modify one file).',
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

export type TaskBatchPromptInputs = Readonly<{
  programId: TaskCompilationProgramId;
  batch: TaskManifestBatch;
  backwardDependencies: readonly TaskManifestItem[];
}>;

export type TaskBatchPromptOptions = Readonly<{
  languageContext?: LanguageContext;
  envelope?: TaskCompilationCallEnvelope;
}>;

export const taskBatchPromptError = {
  tooLarge: (actualBytes: number, maxBytes: number) =>
    error(
      TASK_COMPILATION_FAILURE_CODE.task_compiler_prompt_too_large,
      `The Task batch prompt is ${actualBytes} bytes; the bound is ${maxBytes} bytes.`,
      { actualBytes, maxBytes },
    ),
  isTooLarge: matches(TASK_COMPILATION_FAILURE_CODE.task_compiler_prompt_too_large),
} as const;

function batchSelectionSection(
  programId: TaskCompilationProgramId,
  batch: TaskManifestBatch,
): string {
  const items = batch.items
    .map((item) => `- \`${item.id}\` — ${item.action} \`${item.file}\`\n  Purpose: ${item.purpose}`)
    .join('\n');
  return `Program: \`${programId}\`
Batch: \`${batch.batchId}\`

Compile exactly these ${batch.items.length} manifest items — nothing more, nothing less:

${items}`;
}

function backwardDependenciesSection(dependencies: readonly TaskManifestItem[]): string {
  if (dependencies.length === 0) {
    return 'No earlier manifest items exist. Every `depends_on` must be `[]`; there is nothing this batch may depend on.';
  }
  const list = dependencies
    .map((item) => `- \`${item.id}\` — ${item.action} \`${item.file}\``)
    .join('\n');
  return `These earlier manifest items are the only dependency targets this batch may reference:

${list}

Every \`depends_on\` value must name an item listed in this prompt — an earlier item above or an earlier item in this batch. Never name an unlisted or later item; use \`[]\` when independent.`;
}

/**
 * Deterministic prompt for one frozen four-item manifest slice. The batch identity,
 * the exact selected items, and the backward-only dependency targets are fixed before
 * dispatch; the provider may only choose the brief content, never the membership.
 */
export function buildTaskBatchPrompt(
  inputs: TaskBatchPromptInputs,
  options?: TaskBatchPromptOptions,
): string {
  const ctx = options?.languageContext ?? buildLanguageContext(undefined);

  const prompt = buildPrompt({
    title: 'Compile Product Task Briefs — Batch',
    intro:
      'You are compiling exactly one deterministic batch of **Product Task Brief v1** records for a detached SPLITBRIEF compilation. You have no session, no files, and no context beyond this prompt; SPLITBRIEF holds the manifest and captures your final response. Each brief is executed independently by a small implementer model that has NO access to this prompt, sibling briefs, or the manifest — every brief must stand on its own.',
    sections: [
      {
        heading: 'Batch Selection',
        body: batchSelectionSection(inputs.programId, inputs.batch),
      },
      {
        heading: 'Backward-Only Dependencies',
        body: backwardDependenciesSection(inputs.backwardDependencies),
      },
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
      instructionsSection(
        `Emit exactly the ${inputs.batch.items.length} selected complete Product Task Brief v1 blocks — one \`---\` delimited block per manifest item, in the order listed above — as bare markdown, not wrapped in a code fence, with no phase headings, summary, or trailing prose.`,
      ),
    ],
    output:
      'Return exactly the selected Task Brief blocks in your final response. Do not write, create, or modify any file, and do not read, resume, or reference any session state; SPLITBRIEF captures only your final response as the batch artifact.',
  });
  return assertTaskBatchPromptBound(
    prompt,
    options?.envelope?.promptBytes ?? TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
  );
}

export function taskBatchPromptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf8');
}

export function assertTaskBatchPromptBound(
  prompt: string,
  maxPromptBytes: number = TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
): string {
  const actualBytes = taskBatchPromptByteLength(prompt);
  if (actualBytes > maxPromptBytes)
    throw taskBatchPromptError.tooLarge(actualBytes, maxPromptBytes);
  return prompt;
}
