import type { Task, ProjectContext } from '../types.js';

export const SYSTEM_PREAMBLE = `SYSTEM: You are a TypeScript code generator. You write clean, working TypeScript code.
Rules:
- Output ONLY the complete file contents
- Do NOT include markdown code fences
- Do NOT include explanations before or after the code
- Do NOT add comments unless specified in the task
- Use ESM imports with .js extensions
- Follow the exact function signatures provided`;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function truncateMiddle(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 3.5);
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 50) / 2);
  if (half <= 0) return text.slice(0, maxChars);
  return text.slice(0, half) + '\n// ... truncated to fit context window ...\n' + text.slice(-half);
}

const CLOSING_CONSTRAINTS = [
  'Do NOT invent new functions not described in the task',
  'Do NOT add features not described in the task',
  'Do NOT import packages not listed in the project dependencies',
];

export function formatTaskPrompt(task: Task, context: ProjectContext, contextLength?: number): string {
  const sections: string[] = [
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

  let currentCode = task.action === 'modify' ? task.currentCode : undefined;

  if (contextLength && currentCode) {
    const promptWithoutCode = sections.join('\n');
    const usedTokens = estimateTokens(SYSTEM_PREAMBLE) + estimateTokens(promptWithoutCode);
    const reserveForOutput = Math.floor(contextLength * 0.25);
    const availableForCode = contextLength - usedTokens - reserveForOutput;
    if (availableForCode > 0) {
      currentCode = truncateMiddle(currentCode, availableForCode);
    }
  }

  if (currentCode) {
    sections.push('', '### Current Code (for modify only)', currentCode);
  }

  const allConstraints = [...task.constraints, ...CLOSING_CONSTRAINTS];
  sections.push('', '### Constraints', ...allConstraints.map(c => `- ${c}`));

  sections.push('', `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`);

  return sections.join('\n');
}

export function formatRetryPrompt(task: Task, context: ProjectContext, error: string, attempt: number): string {
  if (attempt === 1) {
    const sections: string[] = [
      'Your previous attempt failed with the following error:',
      '',
      error,
      '',
      'Fix the error and try again.',
      '',
      `## Task: ${task.title}`,
      `### Action: ${task.action}`,
      `### File: ${task.file}`,
      '',
      '### What To Do',
      task.description,
    ];

    if (task.action === 'modify' && task.currentCode) {
      sections.push('', '### Current Code', task.currentCode);
    }

    const allConstraints = [...task.constraints, ...CLOSING_CONSTRAINTS];
    if (allConstraints.length > 0) {
      sections.push('', '### Constraints', ...allConstraints.map(c => `- ${c}`));
    }

    sections.push('', `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`);
    return sections.join('\n');
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
      `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`,
    ].join('\n');
  }

  const essentialConstraints = [...task.constraints, ...CLOSING_CONSTRAINTS];
  return [
    'Multiple previous attempts have failed. Try a different approach.',
    '',
    `File: ${task.file}`,
    `Task: ${task.title}`,
    '',
    'The last error was:',
    '',
    error,
    '',
    ...essentialConstraints.map(c => `- ${c}`),
    '',
    `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`,
  ].join('\n');
}
