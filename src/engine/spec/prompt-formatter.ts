import type { ProjectContext, CodeContext } from '../../core/state/types.js';
import type { Task } from '../../core/schemas/task.js';
import type { Plan } from '../../core/schemas/plan.js';
import type { ImplementerWriteMode } from '../../core/schemas/implementer-config.js';
import type { BuildOutputContract } from '../implementers/file-bundle.js';
import { extractFunctionContext } from '../parsers/scope-extractor.js';
import { DECLARATION_NAME_RE } from '../parsers/code-patterns.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { truncateMiddle, computeTokenBudget } from './token-budget.js';
import { buildLanguageContext, type LanguageContext } from './prompts/language-context.js';
import { buildImplementerSystemPreamble as formatImplementerSystemPreamble } from './prompts/system.js';
import { buildScopeLines } from './formatter.js';
import { READ_ONLY_CONTEXT_HEADING, TASK_BRIEF_HEADINGS } from './headings.js';
import { framingForAttempt } from '../../core/pipeline-spec/ladder.js';
import { CLOSING_CONSTRAINTS } from '../../core/pipeline-spec/brief.js';

export { formatImplementerSystemPreamble };

export type PlanContext = Pick<Plan, 'summary' | 'decisions' | 'criteria'>;

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

function buildTaskSections(
  task: Task,
  context: ProjectContext | undefined,
  writesFiles: ImplementerWriteMode,
  outputContract: BuildOutputContract | undefined,
  plan: PlanContext | undefined,
  inPlace: boolean,
): string[] {
  const sections: string[] = [];

  if (context) {
    sections.push(`## Project: ${context.name}`, '');
    if (context.skillsContext) sections.push(context.skillsContext, '');
  }

  const files = task.suggestedFiles;
  sections.push(
    `## Task: ${task.title}`,
    `### Action: ${task.action}`,
    ...(files.length > 1
      ? [
          '### Files:',
          `- ${task.suggestedFiles[0]} (anchor)`,
          ...files.filter((p) => p !== task.suggestedFiles[0]).map((p) => `- ${p}`),
        ]
      : [`### File: ${task.suggestedFiles[0]}`]),
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
  if (plan) {
    const matchingCriteria = plan.criteria.filter((c) => task.criteria?.includes(c.id));
    sections.push('', '### Plan context (read-only)', plan.summary);
    if (plan.decisions.length > 0) {
      sections.push(
        '',
        'Decisions:',
        ...plan.decisions.map((d) => `- ${d.text}${d.taskId === null ? '' : ` (${d.taskId})`}`),
      );
    }
    if (matchingCriteria.length > 0) {
      sections.push(
        '',
        'Criteria this task serves:',
        ...matchingCriteria.map((c) => `- ${c.id}: ${c.text}`),
      );
    }
  }
  if (task.implementationSteps.length > 0) {
    sections.push(
      '',
      TASK_BRIEF_HEADINGS.implementationSteps.heading,
      'Guidance only: another approach that passes the checks is fine.',
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
  const completionInstruction =
    outputContract === 'file-bundle-v1'
      ? `Answer with one JSON object: {"version":1,"files":[{"path":"...","action":"create"|"modify","content":"..."}]}. Carry the complete new contents of every file listed above that you change, and leave the rest out. No markdown fences. No explanations.`
      : writesFiles === 'direct'
        ? `Edit ${files.join(', ')} directly in ${inPlace ? "the user's checkout" : 'the isolation directory'}. SPLITBRIEF runs the typecheck, lint and test gates after you hand back, so run at most the focused test files the brief lists, once. End your reply with the one JSON report object the rules describe: status done with the files you changed, or status blocked with your question and the files you need.`
        : `Output the complete file contents for ${task.suggestedFiles[0]}. No markdown fences. No explanations.`;
  sections.push('', completionInstruction);

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

function insertAnchorCode(sections: string[], task: Task, availableTokens?: number): void {
  if (!task.currentCode) return;

  if (availableTokens === undefined) {
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

  const codeCtx = resolveCodeContext(task.currentCode, functionName, availableTokens);

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

function insertCodeContext(sections: string[], task: Task, budget?: { remaining: number }): void {
  const byFile = task.currentCodeByFile;
  const extras: [string, string][] = [];
  if (byFile) {
    for (const path of task.suggestedFiles) {
      const content = byFile[path];
      if (content !== undefined) extras.push([path, content]);
    }
  }

  // Every target and every context file shares the budget, so no one file crowds out the rest.
  const blocks =
    extras.length + (task.currentCode ? 1 : 0) + Object.keys(task.contextCodeByFile ?? {}).length;
  const perBlock =
    budget !== undefined && blocks > 0
      ? Math.max(0, Math.floor(budget.remaining / blocks))
      : undefined;

  insertAnchorCode(sections, task, perBlock);

  for (const [path, content] of extras) {
    insertCodeContextSection(sections, [
      '',
      `${TASK_BRIEF_HEADINGS.currentCode.heading} — ${path}`,
      perBlock === undefined ? content : truncateMiddle(content, perBlock),
    ]);
  }

  insertCodeContextSection(sections, contextCodeLines(task, perBlock));
}

// The refresh bounded context code; a budgeted prompt cuts each file to its share, after the targets.
function contextCodeLines(task: Task, tokens?: number | undefined): string[] {
  return Object.entries(task.contextCodeByFile ?? {}).flatMap(([path, content]) => [
    '',
    `${READ_ONLY_CONTEXT_HEADING} — ${path}`,
    tokens === undefined ? content : truncateMiddle(content, tokens),
  ]);
}

export function formatTaskPrompt(opts: {
  task: Task;
  context: ProjectContext;
  contextLength?: number | undefined;
  languageContext?: LanguageContext | undefined;
  writesFiles?: ImplementerWriteMode | undefined;
  outputContract?: BuildOutputContract | undefined;
  plan?: PlanContext | undefined;
  /** The writer edits the user's checkout itself (`workflow.isolation: none`). */
  inPlace?: boolean | undefined;
}): string {
  const {
    task,
    context,
    contextLength,
    languageContext,
    writesFiles = 'extracted-code',
    outputContract,
    plan,
    inPlace = false,
  } = opts;
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const sections = buildTaskSections(task, context, writesFiles, outputContract, plan, inPlace);

  // A bundle answer carries complete files, so every captured target goes in
  // whole: a formatter that cut one would ask for a rewrite of code the model
  // never saw. A prompt that does not fit is refused by the call's own budget,
  // with its figures, rather than trimmed to be admitted. A direct writer edits
  // the files where they live and reads them itself, so it gets only the context code.
  if (outputContract === 'file-bundle-v1') {
    insertCodeContext(sections, task);
  } else if (writesFiles === 'direct') {
    insertCodeContextSection(sections, contextCodeLines(task));
  } else if (task.action === 'modify' || task.currentCodeByFile || task.contextCodeByFile) {
    const budget = contextLength
      ? computeTokenBudget({
          system: formatImplementerSystemPreamble(ctx, writesFiles, context.dir),
          taskBody: sections.join('\n'),
          contextLength,
        })
      : undefined;
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
  writesFiles?: ImplementerWriteMode | undefined;
  outputContract?: BuildOutputContract | undefined;
  plan?: PlanContext | undefined;
  /** The writer edits the user's checkout itself (`workflow.isolation: none`). */
  inPlace?: boolean | undefined;
}): string {
  const {
    task,
    context,
    error,
    attempt,
    contextLength,
    languageContext,
    writesFiles = 'extracted-code',
    outputContract,
    plan,
    inPlace = false,
  } = opts;
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const framing = framingForAttempt(attempt);
  const sections = buildTaskSections(task, context, writesFiles, outputContract, plan, inPlace);

  sections.unshift(framing, '', 'Error from previous attempt:', error, '');

  if (outputContract === 'file-bundle-v1') {
    insertCodeContext(sections, task);
  } else if (writesFiles === 'direct') {
    insertCodeContextSection(sections, contextCodeLines(task));
  } else if (task.currentCode || task.currentCodeByFile || task.contextCodeByFile) {
    const budget = contextLength
      ? computeTokenBudget({
          system: formatImplementerSystemPreamble(ctx, writesFiles, context.dir),
          taskBody: sections.join('\n'),
          contextLength,
        })
      : undefined;
    insertCodeContext(sections, task, budget);
  }

  return sections.join('\n');
}
