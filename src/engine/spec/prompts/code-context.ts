import type { ImplementerWriteMode } from '../../../core/schemas/runner/implementer.js';
import type { Task } from '../../../core/schemas/task.js';
import type { CodeContext, ProjectContext } from '../../../core/state/types.js';
import { estimateTokens } from '../../../core/tokens/estimate.js';
import type { BuildOutputContract } from '../../implementers/file-bundle/contract.js';
import { DECLARATION_NAME_RE } from '../../parsers/code-patterns.js';
import { extractFunctionContext } from '../../parsers/scope-extractor.js';
import { TASK_BRIEF_HEADINGS, READ_ONLY_CONTEXT_HEADING } from '../headings.js';
import { computeTokenBudget, truncateMiddle } from '../token-budget.js';
import { type LanguageContext, buildLanguageContext } from './language-context.js';
import { buildImplementerSystemPreamble as formatImplementerSystemPreamble } from './system.js';

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

/**
 * The brief's code goes in whenever the brief carries it, whatever its action: `currentCode` is
 * set only when the workspace holds the anchor (`refreshCurrentCode`). A bundle answer carries
 * complete files, so every captured target goes in whole: a formatter that cut one would ask for a
 * rewrite of code the model never saw. A prompt that does not fit is refused by the call's own
 * budget, with its figures, rather than trimmed to be admitted. A direct writer edits the files
 * where they live and reads them itself, so it gets only the context code.
 */
export function insertTaskCode(
  sections: string[],
  opts: {
    task: Task;
    context: ProjectContext;
    contextLength?: number | undefined;
    languageContext?: LanguageContext | undefined;
    writesFiles: ImplementerWriteMode;
    outputContract?: BuildOutputContract | undefined;
  },
): void {
  const { task, contextLength, writesFiles } = opts;
  if (opts.outputContract === 'file-bundle-v1') {
    insertCodeContext(sections, task);
  } else if (writesFiles === 'direct') {
    insertCodeContextSection(sections, contextCodeLines(task));
  } else if (task.currentCode || task.currentCodeByFile || task.contextCodeByFile) {
    const budget = contextLength
      ? computeTokenBudget({
          system: formatImplementerSystemPreamble(
            opts.languageContext ?? buildLanguageContext(undefined),
            writesFiles,
            opts.context.dir,
          ),
          taskBody: sections.join('\n'),
          contextLength,
        })
      : undefined;
    insertCodeContext(sections, task, budget);
  }
}
