import type { Task, TaskId } from '../../../../core/schemas/task.js';
import type { ValidationResult } from '../../validation/result.js';
import { uniqueSorted } from '../../../../utils/collections.js';
import { scopePathPatterns } from '../../../../utils/path-patterns.js';
import { summarizeText } from './issue.js';

/** `> <package>@<version> <script>`: npm and pnpm print it, then `> <command>`, above a script's output. */
const RUN_BANNER = /^> (?:@[^\s/]+\/)?[^\s@/]+@\S+ \S/;

/** npm and pnpm print a banner pair above a script's real output; it is not the error. */
function stripBannerLines(input: string): string {
  const lines = input.split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (RUN_BANNER.test(line)) {
      if ((lines[index + 1] ?? '').startsWith('> ')) index++;
      continue;
    }
    if (line.trim().length > 0) kept.push(line);
  }
  return kept.length > 0 ? kept.join('\n') : input;
}

export function summarizeValidation(opts: {
  validationResults?: ValidationResult[] | undefined;
  validationSummary?: string | undefined;
}): { detail: string; summary: string; stage?: ValidationResult['stage'] | undefined } {
  if (opts.validationSummary !== undefined && opts.validationSummary.trim().length > 0) {
    const summary = summarizeText(stripBannerLines(opts.validationSummary));
    return { detail: `Validation: ${summary}`, summary };
  }

  const failed = opts.validationResults?.find((result) => !result.passed);
  if (!failed) {
    return {
      detail: 'Validation failed without a reported failing stage.',
      summary: 'Validation failed without a reported failing stage.',
    };
  }

  const summary = summarizeText(
    stripBannerLines(failed.error || failed.output || `${failed.stage} failed`),
  );
  return {
    detail: `Validation ${failed.stage} failed: ${summary}`,
    summary,
    stage: failed.stage,
  };
}

export function attemptDetails(
  attempts: number | undefined,
  maxAttempts: number | undefined,
): string[] {
  if (attempts === undefined && maxAttempts === undefined) return [];
  if (attempts !== undefined && maxAttempts !== undefined && attempts <= maxAttempts) {
    return [`Attempts: ${attempts}/${maxAttempts}`];
  }
  if (attempts !== undefined) return [`Attempts: ${attempts}`];
  return [`Max attempts: ${maxAttempts}`];
}

export function implementerDetails(selectedImplementerProfile: string | undefined): string[] {
  return selectedImplementerProfile ? [`Worker profile: ${selectedImplementerProfile}`] : [];
}

/** A review with no seat of its own runs on the PLAN tool, so a new PLAN tool moves it too. */
export function reviewSeatDetails(followsPlan: boolean): string[] {
  return followsPlan
    ? ['The review runs on the PLAN tool. A new PLAN tool also runs the review.']
    : [];
}

/** A consult halt names the brief whose consult the planner could not answer. */
export function consultHaltDetails(taskId: TaskId): string[] {
  return [`The planner could not answer the consult for ${taskId}.`];
}

export function routeBiggerDetails(opts: {
  routeBiggerProfile?: string | undefined;
  canRouteBigger?: boolean | undefined;
}): string[] {
  if (opts.routeBiggerProfile) return [`Bigger worker available: ${opts.routeBiggerProfile}`];
  if (opts.canRouteBigger) return ['Bigger worker available'];
  return [];
}

export function taskFiles(task: Task): string[] {
  return uniqueSorted(
    [
      task.file,
      ...(task.scope?.inBounds ?? []).flatMap(scopePathPatterns),
      ...(task.scope?.approvedOutOfBounds ?? []).flatMap(scopePathPatterns),
    ],
    { trim: true, nonEmpty: true },
  );
}
