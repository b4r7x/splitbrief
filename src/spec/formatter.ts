import type { Task, ProjectContext } from '../types.js';

const SYSTEM_PREAMBLE = `SYSTEM: You are a TypeScript code generator. You write clean, working TypeScript code.
Rules:
- Output ONLY the complete file contents
- Do NOT include markdown code fences
- Do NOT include explanations before or after the code
- Do NOT add comments unless specified in the task
- Use ESM imports with .js extensions
- Follow the exact function signatures provided`;

const CLOSING_CONSTRAINTS = [
  'Do NOT invent new functions not described in the task',
  'Do NOT add features not described in the task',
  'Do NOT import packages not listed in the project dependencies',
];

export function formatTaskPrompt(task: Task, context: ProjectContext): string {
  const sections: string[] = [
    SYSTEM_PREAMBLE,
    '',
    `## Project: ${context.name}`,
    `## Runtime: ${context.runtime}`,
    '',
    `## Task: ${task.title}`,
    `### Action: ${task.action}`,
    `### File: ${task.file}`,
    '',
    '### What To Do',
    task.description,
  ];

  if (task.signature) {
    sections.push('', '### Function Signature', task.signature);
  }

  if (task.tests.length > 0) {
    sections.push('', '### Tests (must pass after implementation)', task.tests.join('\n'));
  }

  if (task.action === 'modify' && task.currentCode) {
    sections.push('', '### Current Code (for modify only)', task.currentCode);
  }

  const allConstraints = [...task.constraints, ...CLOSING_CONSTRAINTS];
  sections.push('', '### Constraints', ...allConstraints.map(c => `- ${c}`));

  sections.push('', `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`);

  return sections.join('\n');
}

export function formatRetryPrompt(task: Task, context: ProjectContext, error: string, attempt: number): string {
  const original = formatTaskPrompt(task, context);

  if (attempt === 1) {
    return [
      'Your previous attempt failed with the following error:',
      '',
      error,
      '',
      'Fix the error and try again.',
      '',
      original,
    ].join('\n');
  }

  if (attempt === 2) {
    return [
      'Previous attempts have failed. Here is the task rephrased:',
      '',
      `Write the file ${task.file} that implements: ${task.title}.`,
      task.description,
      '',
      'The last error was:',
      '',
      error,
      '',
      original,
    ].join('\n');
  }

  return [
    'Multiple previous attempts have failed. Try a different approach.',
    '',
    'The last error was:',
    '',
    error,
    '',
    original,
  ].join('\n');
}
