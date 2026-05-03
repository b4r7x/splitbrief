import type { Task } from '../../../core/schemas/task.js';
import type { LanguageContext } from './language-context.js';
import { buildLanguageContext, codeFenceLanguage, isJavaScriptLikeLanguage } from './language-context.js';
import { buildPrompt, instructionsSection, type PromptSection } from './shared.js';

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
    ? `\n\n### Expected Signature\n\`\`\`${codeFenceLanguage(ctx)}\n${task.signature}\n\`\`\``
    : ''
}`,
  };
}

function constraintsBlock(task: Task): string {
  return task.constraints.length > 0
    ? task.constraints.map(c => `- ${c}`).join('\n')
    : 'None specified.';
}

function hintInstructions(ctx: LanguageContext): string {
  const commonPitfall = isJavaScriptLikeLanguage(ctx)
    ? 'If this is a common mistake (e.g., missing .js extension, wrong import path, incorrect type), say so explicitly.'
    : `If this is a common ${ctx.language} mistake (e.g., wrong import path, incorrect type usage, invalid module/package reference), say so explicitly.`;

  return `In ~500 tokens or less, provide:

1. **Root cause**: What specifically went wrong? Parse the error message and identify the exact issue.
2. **Fix approach**: Describe the approach to fix it in plain language. Be specific -- mention exact function names, ${ctx.typeAnnotationStyle}, or patterns to use.
3. **Common pitfall**: ${commonPitfall}

Do NOT write code. Only explain the diagnosis and approach.`;
}

export function buildHintPrompt(task: Task, error: string, languageContext?: LanguageContext): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);
  return buildPrompt({
    title: 'Diagnose Implementation Failure',
    intro: 'An implementer model attempted to implement the task below but the result failed validation. Provide a concise diagnosis and approach hint -- do NOT write code.',
    sections: [
      taskMetaSection(task, ctx),
      { heading: 'Constraints', body: constraintsBlock(task) },
      { heading: 'Validation Error', body: '```\n' + error + '\n```' },
      instructionsSection(hintInstructions(ctx)),
    ],
  });
}

function conventionsText(ctx: LanguageContext): string {
  return `${ctx.importConvention}, ${ctx.typeAnnotationStyle}, ${ctx.moduleSystem}`;
}

function escalationInstructions(task: Task, ctx: LanguageContext): string {
  return `1. Analyze the failed attempt and the error to understand what went wrong.
2. Write the correct, complete implementation for \`${task.file}\`.
3. Ensure all tests and constraints are satisfied.
4. Follow existing project conventions (${conventionsText(ctx)}).

Respond with the complete file content for \`${task.file}\`. Do not include explanations outside the code.`;
}

export function buildEscalationPrompt(task: Task, lastAttempt: string, error: string, languageContext?: LanguageContext): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const sections: PromptSection[] = [
    taskMetaSection(task, ctx),
  ];

  if (task.tests.length > 0) {
    sections.push({
      heading: 'Tests That Must Pass',
      body: task.tests.map(t => `- ${t}`).join('\n'),
    });
  }

  sections.push(
    { heading: 'Constraints', body: constraintsBlock(task) },
    { heading: 'Last Failed Attempt', body: '```\n' + lastAttempt + '\n```' },
    { heading: 'Validation Error', body: '```\n' + error + '\n```' },
    instructionsSection(escalationInstructions(task, ctx)),
  );

  return buildPrompt({
    title: 'Escalation: Implement Fix',
    intro: 'The implementer model failed to implement the task below after multiple attempts. You must provide the correct, complete implementation.',
    sections,
  });
}
