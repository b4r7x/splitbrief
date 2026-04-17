import type { Task } from '../../../core/types/state-actions.js';
import { buildPrompt, ESM_CONVENTION, instructionsSection, type PromptSection } from './shared.js';

function taskMetaSection(task: Task): PromptSection {
  return {
    heading: 'Task',
    body: `**ID**: ${task.id}
**Title**: ${task.title}
**Action**: ${task.action}
**File**: ${task.file}

### Description
${task.description}${
  task.signature
    ? `\n\n### Expected Signature\n\`\`\`typescript\n${task.signature}\n\`\`\``
    : ''
}`,
  };
}

function constraintsBlock(task: Task): string {
  return task.constraints.length > 0
    ? task.constraints.map(c => `- ${c}`).join('\n')
    : 'None specified.';
}

const HINT_INSTRUCTIONS = `In ~500 tokens or less, provide:

1. **Root cause**: What specifically went wrong? Parse the error message and identify the exact issue.
2. **Fix approach**: Describe the approach to fix it in plain language. Be specific  -  mention exact function names, types, or patterns to use.
3. **Common pitfall**: If this is a common mistake (e.g., missing .js extension, wrong import path, incorrect type), say so explicitly.

Do NOT write code. Only explain the diagnosis and approach.`;

export function buildHintPrompt(task: Task, error: string): string {
  return buildPrompt({
    title: 'Diagnose Implementation Failure',
    intro: 'An implementer model attempted to implement the task below but the result failed validation. Provide a concise diagnosis and approach hint  -  do NOT write code.',
    sections: [
      taskMetaSection(task),
      { heading: 'Constraints', body: constraintsBlock(task) },
      { heading: 'Validation Error', body: '```\n' + error + '\n```' },
      instructionsSection(HINT_INSTRUCTIONS),
    ],
  });
}

function escalationInstructions(task: Task): string {
  return `1. Analyze the failed attempt and the error to understand what went wrong.
2. Write the correct, complete implementation for \`${task.file}\`.
3. Ensure all tests and constraints are satisfied.
4. Follow existing project conventions (${ESM_CONVENTION}).

Respond with the complete file content for \`${task.file}\`. Do not include explanations outside the code.`;
}

export function buildEscalationPrompt(task: Task, lastAttempt: string, error: string): string {
  const sections: PromptSection[] = [
    taskMetaSection(task),
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
    instructionsSection(escalationInstructions(task)),
  );

  return buildPrompt({
    title: 'Escalation: Implement Fix',
    intro: 'The implementer model failed to implement the task below after multiple attempts. You must provide the correct, complete implementation.',
    sections,
  });
}
