import type { Task } from '../../../core/schemas/task.js';
import type { LanguageContext } from './language-context.js';
import {
  buildLanguageContext,
  codeFenceLanguage,
  isJavaScriptLikeLanguage,
} from './language-context.js';
import { buildPrompt, fenced, instructionsSection, type PromptSection } from './builder.js';
import { selectRelevantExamples, formatExamplesSection } from './escalation-examples.js';
import { buildScopeLines } from '../formatter.js';
import { workspaceRules } from './system.js';

export type HintVerdict =
  | { kind: 'answer' }
  | { kind: 'widen'; paths: string[]; reason: string }
  | { kind: 'brief'; diagnosis: string };

export type HintVerdictKind = HintVerdict['kind'];

export const HINT_VERDICT_LINE = /^VERDICT:\s*(answer|widen|brief)\b\s*(.*)$/im;

const VERDICT_REASON_SEPARATOR = /(?:^|\s+)[—–-](?:\s+|$)|:\s*/;

function splitVerdictReason(rest: string): { head: string; reason: string } {
  const separator = VERDICT_REASON_SEPARATOR.exec(rest);
  if (separator === null) return { head: rest.trim(), reason: '' };
  return {
    head: rest.slice(0, separator.index).trim(),
    reason: rest.slice(separator.index + separator[0].length).trim(),
  };
}

/** The first `VERDICT:` line of a hint; no line, or a widening naming no path, reads `answer`. */
export function parseHintVerdict(output: string): HintVerdict {
  const match = HINT_VERDICT_LINE.exec(output);
  if (match === null) return { kind: 'answer' };
  const kind = match[1]?.toLowerCase();
  const { head, reason } = splitVerdictReason(match[2] ?? '');
  if (kind === 'brief') return { kind: 'brief', diagnosis: head === '' ? reason : head };
  if (kind !== 'widen') return { kind: 'answer' };
  const paths = head
    .split(/[,\s]+/)
    .map((path) => path.replace(/^`+|`+$/g, '').trim())
    .filter((path) => path.length > 0);
  return paths.length === 0 ? { kind: 'answer' } : { kind: 'widen', paths, reason };
}

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
    ? `\n\n### Expected Signature\n${fenced(task.signature, codeFenceLanguage(ctx))}`
    : ''
}`,
  };
}

function constraintsBlock(task: Task): string {
  return task.constraints.length > 0
    ? task.constraints.map((c) => `- ${c}`).join('\n')
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

Begin your reply with exactly one line: \`VERDICT: answer\` when the implementer should retry with your diagnosis below; \`VERDICT: widen <path>[, <path>…] — <reason>\` when the brief must also be allowed to edit the named files (paths outside its declared set); \`VERDICT: brief — <diagnosis>\` when the brief itself is wrong and no retry can land it. When the implementer stopped with a question, decide whether the brief or the implementer is at fault and answer it.

Do NOT write code. Only explain the diagnosis and approach.`;
}

export function buildHintPrompt(
  task: Task,
  error: string,
  languageContext?: LanguageContext,
  handBack?: string,
): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const examples = selectRelevantExamples(error, ctx);
  const sections: PromptSection[] = [
    taskMetaSection(task, ctx),
    { heading: 'Constraints', body: constraintsBlock(task) },
    { heading: 'Validation Error', body: fenced(error) },
  ];
  const handBackText = handBack?.trim() ?? '';
  if (handBackText.length > 0) {
    sections.push({ heading: 'Implementer hand-back', body: fenced(handBackText) });
  }
  const scopeLines = buildScopeLines(task.scope);
  if (scopeLines.length > 0) {
    sections.push({ heading: 'Scope', body: scopeLines.join('\n') });
  }
  if (task.escalation !== undefined && task.escalation.length > 0) {
    sections.push({
      heading: 'Escalation',
      body: task.escalation.map((entry) => `- ${entry}`).join('\n'),
    });
  }
  if (examples.length > 0) {
    sections.push({ heading: 'Similar Issues', body: formatExamplesSection(examples) });
  }
  sections.push(instructionsSection(hintInstructions(ctx)));
  return buildPrompt({
    title: 'Diagnose Implementation Failure',
    intro:
      'An implementer model attempted to implement the task below but the result failed validation. Provide a concise diagnosis and approach hint -- do NOT write code.',
    sections,
  });
}

function conventionsText(ctx: LanguageContext): string {
  return `${ctx.importConvention}, ${ctx.typeAnnotationStyle}, ${ctx.moduleSystem}`;
}

function escalationInstructions(
  task: Task,
  ctx: LanguageContext,
  outputMode: 'files' | 'text',
): string {
  if (outputMode === 'files') {
    return `1. Analyze the failed attempt and the error to understand what went wrong.
2. Edit \`${task.file}\` directly in the current working directory with the correct, complete implementation.
3. Ensure all tests and constraints are satisfied.
4. Follow existing project conventions (${conventionsText(ctx)}).

Make the changes on disk. Do not return file contents as a substitute for editing the files. When finished, briefly report the files changed and validation performed.`;
  }
  return `1. Analyze the failed attempt and the error to understand what went wrong.
2. Write the correct, complete implementation for \`${task.file}\`.
3. Ensure all tests and constraints are satisfied.
4. Follow existing project conventions (${conventionsText(ctx)}).

Respond with the complete file content for \`${task.file}\`. Do not include explanations outside the code.`;
}

export function buildEscalationPrompt(opts: {
  task: Task;
  lastAttempt: string;
  error: string;
  languageContext?: LanguageContext | undefined;
  isolationDir: string;
  outputMode: 'files' | 'text';
}): string {
  const { task, lastAttempt, error, outputMode } = opts;
  const ctx = opts.languageContext ?? buildLanguageContext(undefined);
  const examples = selectRelevantExamples(error, ctx);
  const sections: PromptSection[] = [taskMetaSection(task, ctx)];

  if (task.tests.length > 0) {
    sections.push({
      heading: 'Tests That Must Pass',
      body: task.tests.map((t) => `- ${t}`).join('\n'),
    });
  }

  sections.push(
    { heading: 'Constraints', body: constraintsBlock(task) },
    { heading: 'Last Failed Attempt', body: fenced(lastAttempt) },
    { heading: 'Validation Error', body: fenced(error) },
  );
  if (examples.length > 0) {
    sections.push({ heading: 'Similar Issues', body: formatExamplesSection(examples) });
  }
  if (outputMode === 'files') {
    sections.push({ heading: 'Rules', body: workspaceRules(opts.isolationDir) });
  }
  sections.push(instructionsSection(escalationInstructions(task, ctx, outputMode)));

  return buildPrompt({
    title: 'Escalation: Implement Fix',
    intro:
      outputMode === 'files'
        ? 'The implementer model failed to implement the task below after multiple attempts. You must make the correct, complete implementation directly in the working directory.'
        : 'The implementer model failed to implement the task below after multiple attempts. You must provide the correct, complete implementation.',
    sections,
  });
}
