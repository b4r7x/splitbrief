import { CLOSING_CONSTRAINTS } from '../../../core/pipeline-spec/brief.js';
import {
  type RetryKind,
  CORRECTION_FRAMING,
  framingForAttempt,
} from '../../../core/pipeline-spec/ladder.js';
import type { Plan } from '../../../core/schemas/plan.js';
import type { ImplementerWriteMode } from '../../../core/schemas/runner/implementer.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { BuildOutputContract } from '../../implementers/file-bundle/contract.js';
import { buildScopeLines } from '../formatter.js';
import { TASK_BRIEF_HEADINGS } from '../headings.js';
import { insertTaskCode } from './code-context.js';
import type { LanguageContext } from './language-context.js';

export type PlanContext = Pick<Plan, 'summary' | 'decisions' | 'criteria'>;

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
    sections.push(
      '',
      TASK_BRIEF_HEADINGS.tests.heading,
      'SPLITBRIEF runs these tests after you hand back. Write or change the ones in the files this brief lists.',
      ...task.tests.map((t) => `- ${t}`),
    );
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
        ? `Edit ${files.join(', ')} directly in ${inPlace ? "the user's checkout" : 'the isolation directory'}. SPLITBRIEF runs the checks after you hand back, so run no test, typecheck, lint or other check command. End your reply with the one JSON report object the rules describe: status done with the files you changed, or status blocked with your question and the files you need.`
        : `Output the complete file contents for ${task.suggestedFiles[0]}. No markdown fences. No explanations.`;
  sections.push('', completionInstruction);

  return sections;
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
    writesFiles = 'extracted-code',
    outputContract,
    plan,
    inPlace = false,
  } = opts;
  const sections = buildTaskSections(task, context, writesFiles, outputContract, plan, inPlace);
  insertTaskCode(sections, { ...opts, writesFiles });
  return sections.join('\n');
}

export function formatRetryPrompt(opts: {
  task: Task;
  context: ProjectContext;
  error: string;
  attempt: number;
  kind: RetryKind;
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
    kind,
    writesFiles = 'extracted-code',
    outputContract,
    plan,
    inPlace = false,
  } = opts;
  const correction = kind === 'correction';
  const framing = correction
    ? CORRECTION_FRAMING
    : framingForAttempt(attempt, task.fix !== undefined);
  const sections = buildTaskSections(task, context, writesFiles, outputContract, plan, inPlace);

  sections.unshift(
    framing,
    '',
    correction ? 'Correction:' : 'Error from previous attempt:',
    error,
    '',
  );
  insertTaskCode(sections, { ...opts, writesFiles });
  return sections.join('\n');
}
