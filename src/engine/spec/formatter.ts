import type { Task, ProjectContext, CodeContext } from '../../types.js';
import { extractFunctionContext } from '../parsers/scope-extractor.js';
import { estimateTokens, truncateMiddle, computeTokenBudget } from './token-budget.js';

export const SYSTEM_PREAMBLE = `SYSTEM: You are a TypeScript code generator. You write clean, working TypeScript code.
Rules:
- Output ONLY the complete file contents
- Do NOT include markdown code fences
- Do NOT include explanations before or after the code
- Do NOT add comments unless specified in the task
- Use ESM imports with .js extensions
- Follow the exact function signatures provided

Example output for a typical task:

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './types.js';

export function loadConfig(dir: string): Config {
  const filePath = join(dir, 'config.json');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    name: parsed.name ?? 'default',
    version: parsed.version ?? '1.0.0',
  };
}`;

export function resolveCodeContext(
  fileContent: string,
  functionName: string | undefined,
  availableTokens: number,
): CodeContext {
  const wholeFileTokens = estimateTokens(fileContent);
  if (wholeFileTokens <= availableTokens) {
    return { mode: 'whole-file', content: fileContent };
  }

  if (functionName) {
    const extracted = extractFunctionContext(fileContent, functionName);
    if (extracted) {
      const functionContent = extracted.imports + '\n\n' + extracted.targetFunction;
      const functionTokens = estimateTokens(functionContent);
      if (functionTokens <= availableTokens) {
        return {
          mode: 'function-level',
          imports: extracted.imports,
          targetFunction: extracted.targetFunction,
          otherExports: extracted.otherExports,
        };
      }
    }
  }

  if (availableTokens > 0) {
    return { mode: 'whole-file', content: truncateMiddle(fileContent, availableTokens) };
  }

  return { mode: 'whole-file', content: '' };
}

const CLOSING_CONSTRAINTS = [
  'Do NOT invent new functions not described in the task',
  'Do NOT add features not described in the task',
  'Do NOT import packages not listed in the project dependencies',
];

function buildTaskSections(task: Task, context?: ProjectContext): string[] {
  const sections: string[] = [];

  if (context) {
    sections.push(`## Project: ${context.name}`, `## Runtime: ${context.runtime}`, '');
  }

  sections.push(
    `## Task: ${task.title}`,
    `### Action: ${task.action}`,
    `### File: ${task.file}`,
    '',
    '### What To Do',
    task.description,
  );

  if (task.signature) {
    sections.push('', '### Function Signature', task.signature);
  }
  if (task.typeDefs) {
    sections.push('', '### Type Definitions', task.typeDefs);
  }
  if (task.implementationSteps.length > 0) {
    sections.push('', '### Implementation Steps', ...task.implementationSteps.map((s, i) => `${i + 1}. ${s}`));
  }
  if (task.tests.length > 0) {
    sections.push('', '### Tests (must pass after implementation)', task.tests.join('\n'));
  }

  const allConstraints = [...task.constraints, ...CLOSING_CONSTRAINTS];
  sections.push('', '### Constraints', ...allConstraints.map(c => `- ${c}`));
  sections.push('', `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`);

  return sections;
}

function insertCodeBeforeConstraints(sections: string[], codeLines: string[]): void {
  const constraintIdx = sections.indexOf('### Constraints');
  if (constraintIdx !== -1) {
    sections.splice(constraintIdx, 0, ...codeLines);
  } else {
    sections.push(...codeLines);
  }
}

function insertCodeContext(sections: string[], task: Task, budget?: { remaining: number }): void {
  if (!task.currentCode) return;

  if (!budget) {
    insertCodeBeforeConstraints(sections, ['', '### Current Code', task.currentCode]);
    return;
  }

  let functionName: string | undefined;
  if (task.signature) {
    const match = task.signature.match(/(?:function|const|class|interface|type)\s+(\w+)/);
    if (match) functionName = match[1];
  }

  const codeCtx = resolveCodeContext(task.currentCode, functionName, budget.remaining);

  if (codeCtx.mode === 'function-level') {
    insertCodeBeforeConstraints(sections, [
      '', '### Current Code (relevant section)',
      '// === Imports ===', codeCtx.imports, '',
      '// === Target Function ===', codeCtx.targetFunction, '',
      `// === Other Exports (do not modify): ${codeCtx.otherExports.join(', ')}`,
    ]);
  } else {
    insertCodeBeforeConstraints(sections, ['', '### Current Code', codeCtx.content]);
  }
}

export function formatTaskPrompt(task: Task, context: ProjectContext, contextLength?: number): string {
  const sections = buildTaskSections(task, context);

  if (!contextLength) {
    if (task.action === 'modify') insertCodeContext(sections, task);
    return sections.join('\n');
  }

  const budget = computeTokenBudget(SYSTEM_PREAMBLE, sections.join('\n'), contextLength);

  if (task.action === 'modify') {
    insertCodeContext(sections, task, budget);
  }

  return sections.join('\n');
}

export function buildFullPrompt(task: Task, context: ProjectContext, contextLength?: number): string {
  return SYSTEM_PREAMBLE + '\n\n' + formatTaskPrompt(task, context, contextLength);
}

export function buildFullRetryPrompt(task: Task, context: ProjectContext, error: string, attempt: number, contextLength?: number): string {
  return SYSTEM_PREAMBLE + '\n\n' + formatRetryPrompt(task, context, error, attempt, contextLength);
}

export function formatRetryPrompt(task: Task, context: ProjectContext, error: string, attempt: number, contextLength?: number): string {
  const framings: Record<number, string> = {
    1: 'Your previous attempt had an error. Fix it:',
    2: 'Previous attempts failed. Here is the task rephrased differently:',
    3: 'Multiple attempts have failed. Try a completely different approach:',
  };

  const framing = framings[attempt] ?? framings[3];
  const sections = buildTaskSections(task, context);

  sections.unshift(framing, '', 'Error from previous attempt:', error, '');

  if (task.currentCode) {
    const budget = contextLength
      ? computeTokenBudget(SYSTEM_PREAMBLE, sections.join('\n'), contextLength)
      : undefined;
    insertCodeContext(sections, task, budget);
  }

  return sections.join('\n');
}
