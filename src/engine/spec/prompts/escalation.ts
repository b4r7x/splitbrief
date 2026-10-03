import type { Task } from '../../../core/schemas/task.js';
import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, codeFenceLanguage } from './language-context.js';
import { buildPrompt, fenced, instructionsSection, type PromptSection } from './builder.js';
import { selectRelevantExamples, formatExamplesSection } from './escalation-examples.js';
import { workspaceRules } from './system.js';

function taskMetaSection(task: Task, ctx: LanguageContext): PromptSection {
  return {
    heading: 'Task',
    body: `**ID**: ${task.id}
**Title**: ${task.title}
**Action**: ${task.action}
**File**: ${task.file}

### Description
${task.description}${
  task.signature
    ? `\n\n### Expected Signature\n${fenced(task.signature, codeFenceLanguage(ctx))}`
    : ''
}`,
  };
}

function constraintsBlock(task: Task): string {
  return task.constraints.length > 0
    ? task.constraints.map((c) => `- ${c}`).join('\n')
    : 'None specified.';
}

function conventionsText(ctx: LanguageContext): string {
  return `${ctx.importConvention}, ${ctx.typeAnnotationStyle}, ${ctx.moduleSystem}`;
}

function escalationInstructions(
  task: Task,
  ctx: LanguageContext,
  outputMode: 'files' | 'text',
): string {
  if (outputMode === 'files') {
    return `1. Analyze the failed attempt and the error to understand what went wrong.
2. Edit \`${task.file}\` directly in the current working directory with the correct, complete implementation.
3. Ensure all tests and constraints are satisfied.
4. Follow existing project conventions (${conventionsText(ctx)}).

Make the changes on disk. Do not return file contents as a substitute for editing the files. When finished, briefly report the files changed and validation performed.`;
  }
  return `1. Analyze the failed attempt and the error to understand what went wrong.
2. Write the correct, complete implementation for \`${task.file}\`.
3. Ensure all tests and constraints are satisfied.
4. Follow existing project conventions (${conventionsText(ctx)}).

Respond with the complete file content for \`${task.file}\`. Do not include explanations outside the code.`;
}

export function buildEscalationPrompt(opts: {
  task: Task;
  lastAttempt: string;
  error: string;
  languageContext?: LanguageContext | undefined;
  isolationDir: string;
  outputMode: 'files' | 'text';
}): string {
  const { task, lastAttempt, error, outputMode } = opts;
  const ctx = opts.languageContext ?? buildLanguageContext(undefined);
  const examples = selectRelevantExamples(error, ctx);
  const sections: PromptSection[] = [taskMetaSection(task, ctx)];

  if (task.tests.length > 0) {
    sections.push({
      heading: 'Tests That Must Pass',
      body: task.tests.map((t) => `- ${t}`).join('\n'),
    });
  }

  sections.push(
    { heading: 'Constraints', body: constraintsBlock(task) },
    { heading: 'Last Failed Attempt', body: fenced(lastAttempt) },
    { heading: 'Validation Error', body: fenced(error) },
  );
  if (examples.length > 0) {
    sections.push({ heading: 'Similar Issues', body: formatExamplesSection(examples) });
  }
  if (outputMode === 'files') {
    sections.push({ heading: 'Rules', body: workspaceRules(opts.isolationDir) });
  }
  sections.push(instructionsSection(escalationInstructions(task, ctx, outputMode)));

  return buildPrompt({
    title: 'Escalation: Implement Fix',
    intro:
      outputMode === 'files'
        ? 'The implementer model failed to implement the task below after multiple attempts. You must make the correct, complete implementation directly in the working directory.'
        : 'The implementer model failed to implement the task below after multiple attempts. You must provide the correct, complete implementation.',
    sections,
  });
}
