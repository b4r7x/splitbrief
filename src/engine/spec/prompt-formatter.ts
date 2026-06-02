import type { ProjectContext, CodeContext } from '../../core/state/types.js';
import type { Task } from '../../core/schemas/task.js';
import { extractFunctionContext } from '../parsers/scope-extractor.js';
import { DECLARATION_NAME_RE } from '../parsers/code-patterns.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { truncateMiddle, computeTokenBudget } from './token-budget.js';
import { buildLanguageContext, type LanguageContext } from './prompts/language-context.js';
import { buildSystemPreamble } from './prompts/system.js';
import { buildScopeLines } from './formatter.js';
import { TASK_BRIEF_HEADINGS } from './headings.js';

const CLOSING_CONSTRAINTS = [
  'Do NOT invent new functions not described in the task',
  'Do NOT add features not described in the task',
  'Do NOT import packages not listed in the project dependencies',
];

function resolveCodeContext(
  fileContent: string,
  functionName: string | undefined,
  availableTokens: number,
): CodeContext {
  const wholeFileTokens = estimateTokens(fileContent);
  if (wholeFileTokens <= availableTokens) {
    return { mode: 'whole-file', content: fileContent };
  }

  if (functionName) {
    const extracted = extractFunctionContext(fileContent, functionName, 5);
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

function buildTaskSections(task: Task, context?: ProjectContext): string[] {
  const sections: string[] = [];

  if (context) {
    sections.push(`## Project: ${context.name}`, '');
  }

  sections.push(
    `## Task: ${task.title}`,
    `### Action: ${task.action}`,
    `### File: ${task.file}`,
    '',
    TASK_BRIEF_HEADINGS.description.heading,
    task.description,
  );

  if (task.signature) {
    sections.push('', TASK_BRIEF_HEADINGS.signature.heading, task.signature);
  }
  if (task.typeDefs) {
    sections.push('', TASK_BRIEF_HEADINGS.typeDefs.heading, task.typeDefs);
  }
  if (task.pattern) {
    sections.push('', TASK_BRIEF_HEADINGS.pattern.heading, task.pattern);
  }
  if (task.implementationSteps.length > 0) {
    sections.push(
      '',
      TASK_BRIEF_HEADINGS.implementationSteps.heading,
      ...task.implementationSteps.map((s, i) => `${i + 1}. ${s}`),
    );
  }
  if (task.tests.length > 0) {
    sections.push('', TASK_BRIEF_HEADINGS.tests.heading, ...task.tests.map((t) => `- ${t}`));
  }

  const scopeLines = buildScopeLines(task.scope);
  if (scopeLines.length > 0) {
    sections.push('', TASK_BRIEF_HEADINGS.scope.heading, ...scopeLines);
  }
  if (task.escalation && task.escalation.length > 0) {
    sections.push(
      '',
      TASK_BRIEF_HEADINGS.escalation.heading,
      ...task.escalation.map((e) => `- ${e}`),
    );
  }
  if (task.evidence && task.evidence.length > 0) {
    sections.push('', TASK_BRIEF_HEADINGS.evidence.heading, ...task.evidence.map((e) => `- ${e}`));
  }

  const allConstraints = [...task.constraints, ...CLOSING_CONSTRAINTS];
  sections.push(
    '',
    TASK_BRIEF_HEADINGS.constraints.heading,
    ...allConstraints.map((c) => `- ${c}`),
  );
  sections.push(
    '',
    `Output the complete file contents for ${task.file}. No markdown fences. No explanations.`,
  );

  return sections;
}

function findCodeContextInsertIndex(sections: string[]): number {
  const headingsAfterCodeContext = [
    TASK_BRIEF_HEADINGS.implementationSteps.heading,
    TASK_BRIEF_HEADINGS.tests.heading,
    TASK_BRIEF_HEADINGS.scope.heading,
    TASK_BRIEF_HEADINGS.escalation.heading,
    TASK_BRIEF_HEADINGS.evidence.heading,
    TASK_BRIEF_HEADINGS.constraints.heading,
  ];

  for (const heading of headingsAfterCodeContext) {
    const idx = sections.indexOf(heading);
    if (idx !== -1) return idx;
  }

  return -1;
}

function insertCodeContextSection(sections: string[], codeLines: string[]): void {
  const insertIdx = findCodeContextInsertIndex(sections);
  if (insertIdx !== -1) {
    sections.splice(insertIdx, 0, ...codeLines);
  } else {
    sections.push(...codeLines);
  }
}

function insertCodeContext(sections: string[], task: Task, budget?: { remaining: number }): void {
  if (!task.currentCode) return;

  if (!budget) {
    insertCodeContextSection(sections, [
      '',
      TASK_BRIEF_HEADINGS.currentCode.heading,
      task.currentCode,
    ]);
    return;
  }

  let functionName: string | undefined;
  if (task.signature) {
    const match = task.signature.match(DECLARATION_NAME_RE);
    if (match) functionName = match[1];
  }

  const codeCtx = resolveCodeContext(task.currentCode, functionName, budget.remaining);

  if (codeCtx.mode === 'function-level') {
    insertCodeContextSection(sections, [
      '',
      '### Current Code (relevant section)',
      '#### Imports',
      codeCtx.imports,
      '',
      '#### Target Function',
      codeCtx.targetFunction,
      '',
      `#### Other Exports (do not modify): ${codeCtx.otherExports.join(', ')}`,
    ]);
  } else {
    insertCodeContextSection(sections, [
      '',
      TASK_BRIEF_HEADINGS.currentCode.heading,
      codeCtx.content,
    ]);
  }
}

export function formatTaskPrompt(opts: {
  task: Task;
  context: ProjectContext;
  contextLength?: number | undefined;
  languageContext?: LanguageContext | undefined;
}): string {
  const { task, context, contextLength, languageContext } = opts;
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const sections = buildTaskSections(task, context);

  if (!contextLength) {
    if (task.action === 'modify') insertCodeContext(sections, task);
    return sections.join('\n');
  }

  if (task.action === 'modify') {
    const budget = computeTokenBudget({
      system: buildSystemPreamble(ctx),
      taskBody: sections.join('\n'),
      contextLength,
    });
    insertCodeContext(sections, task, budget);
  }

  return sections.join('\n');
}

export function formatRetryPrompt(opts: {
  task: Task;
  context: ProjectContext;
  error: string;
  attempt: number;
  contextLength?: number | undefined;
  languageContext?: LanguageContext | undefined;
}): string {
  const { task, context, error, attempt, contextLength, languageContext } = opts;
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const framings: Record<number, string> = {
    1: 'Your previous attempt had an error. Fix it:',
    2: 'Previous attempts failed. Here is the task rephrased differently:',
    3: 'Multiple attempts have failed. Try a completely different approach:',
  };

  const framing = framings[attempt] ?? framings[3] ?? '';
  const sections = buildTaskSections(task, context);

  sections.unshift(framing, '', 'Error from previous attempt:', error, '');

  if (task.currentCode) {
    const budget = contextLength
      ? computeTokenBudget({
          system: buildSystemPreamble(ctx),
          taskBody: sections.join('\n'),
          contextLength,
        })
      : undefined;
    insertCodeContext(sections, task, budget);
  }

  return sections.join('\n');
}
