import type { Task, ProjectContext, TokenBudget, CodeContext } from '../types.js';
import { extractFunctionContext } from '../orchestrator/context-extractor.js';

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

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateMiddle(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 4);
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 50) / 2);
  if (half <= 0) return text.slice(0, maxChars);
  return text.slice(0, half) + '\n// ... truncated to fit context window ...\n' + text.slice(-half);
}

export function computeTokenBudget(
  system: string,
  taskBody: string,
  typeDefs: string,
  implSteps: string,
  contextLength: number,
): TokenBudget {
  const systemTokens = estimateTokens(system);
  const taskBodyTokens = estimateTokens(taskBody);
  const typeDefsTokens = estimateTokens(typeDefs);
  const implStepsTokens = estimateTokens(implSteps);
  const outputReserve = Math.floor(contextLength * 0.25);
  const usedWithoutCode = systemTokens + taskBodyTokens + typeDefsTokens + implStepsTokens + outputReserve;
  const codeContext = 0; // placeholder — filled by caller
  const total = usedWithoutCode;
  const remaining = contextLength - total;

  return {
    system: systemTokens,
    taskBody: taskBodyTokens,
    typeDefs: typeDefsTokens,
    implSteps: implStepsTokens,
    codeContext,
    outputReserve,
    total,
    remaining,
  };
}

export function resolveCodeContext(
  fileContent: string,
  functionName: string | undefined,
  availableTokens: number,
): CodeContext {
  // 1. Try whole-file
  const wholeFileTokens = estimateTokens(fileContent);
  if (wholeFileTokens <= availableTokens) {
    return { mode: 'whole-file', content: fileContent };
  }

  // 2. Try function-level (if we have a function name)
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

  // 3. Truncate middle
  if (availableTokens > 0) {
    return { mode: 'whole-file', content: truncateMiddle(fileContent, availableTokens) };
  }

  // 4. No space at all — return empty
  return { mode: 'whole-file', content: '' };
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

  if (task.typeDefs) {
    sections.push('', '### Type Definitions', task.typeDefs);
  }

  if (task.implSteps.length > 0) {
    sections.push('', '### Implementation Steps', ...task.implSteps.map((s, i) => `${i + 1}. ${s}`));
  }

  if (task.tests.length > 0) {
    sections.push('', '### Tests (must pass after implementation)', task.tests.join('\n'));
  }

  const allConstraints = [...task.constraints, ...CLOSING_CONSTRAINTS];
  sections.push('', '### Constraints', ...allConstraints.map(c => `- ${c}`));
  sections.push('', `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`);

  // Assemble task body (everything except code context)
  const taskBody = sections.join('\n');

  // If no context length specified, include code as-is (legacy behavior)
  if (!contextLength) {
    if (task.action === 'modify' && task.currentCode) {
      const withCode = [...sections];
      // Insert current code before constraints
      const constraintIdx = withCode.indexOf('### Constraints');
      if (constraintIdx !== -1) {
        withCode.splice(constraintIdx, 0, '', '### Current Code', task.currentCode);
      }
      return withCode.join('\n');
    }
    return taskBody;
  }

  // Token-budgeted assembly
  const budget = computeTokenBudget(
    SYSTEM_PREAMBLE,
    taskBody,
    '', // typeDefs already in taskBody
    '', // implSteps already in taskBody
    contextLength,
  );

  // Resolve code context for modify tasks
  if (task.action === 'modify' && task.currentCode) {
    // Extract function name from signature for function-level extraction
    let functionName: string | undefined;
    if (task.signature) {
      const match = task.signature.match(/(?:function|const|class|interface|type)\s+(\w+)/);
      if (match) functionName = match[1];
    }

    const codeCtx = resolveCodeContext(task.currentCode, functionName, budget.remaining);

    if (codeCtx.mode === 'function-level') {
      const codeSection = [
        '',
        '### Current Code (relevant section)',
        '// === Imports ===',
        codeCtx.imports,
        '',
        '// === Target Function ===',
        codeCtx.targetFunction,
        '',
        `// === Other Exports (do not modify): ${codeCtx.otherExports.join(', ')}`,
      ];
      // Insert before constraints
      const constraintIdx = sections.indexOf('### Constraints');
      if (constraintIdx !== -1) {
        sections.splice(constraintIdx, 0, ...codeSection);
      }
    } else {
      // whole-file (possibly truncated)
      const constraintIdx = sections.indexOf('### Constraints');
      if (constraintIdx !== -1) {
        sections.splice(constraintIdx, 0, '', '### Current Code', codeCtx.content);
      }
    }
  }

  return sections.join('\n');
}

export function formatRetryPrompt(task: Task, context: ProjectContext, error: string, attempt: number): string {
  const framings: Record<number, string> = {
    1: 'Your previous attempt had an error. Fix it:',
    2: 'Previous attempts failed. Here is the task rephrased differently:',
    3: 'Multiple attempts have failed. Try a completely different approach:',
  };

  const framing = framings[attempt] ?? framings[3];

  const sections: string[] = [
    framing,
    '',
    'Error from previous attempt:',
    error,
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

  if (task.typeDefs) {
    sections.push('', '### Type Definitions', task.typeDefs);
  }

  if (task.implSteps.length > 0) {
    sections.push('', '### Implementation Steps', ...task.implSteps.map((s, i) => `${i + 1}. ${s}`));
  }

  if (task.tests.length > 0) {
    sections.push('', '### Tests (must pass after implementation)', task.tests.join('\n'));
  }

  if (task.currentCode) {
    sections.push('', '### Current Code', task.currentCode);
  }

  const allConstraints = [...task.constraints, ...CLOSING_CONSTRAINTS];
  sections.push('', '### Constraints', ...allConstraints.map(c => `- ${c}`));
  sections.push('', `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`);

  return sections.join('\n');
}
