import type { Task } from '../../../../core/schemas/task.js';
import type { ValidationResult } from '../../validation-types.js';
import type { UserEditConflict } from '../../../events/workflow-events.js';
import { uniqueSorted } from '../../../../utils/collections.js';
import { looksLikeFilePath } from '../../../../utils/path-patterns.js';
import { summarizeText } from './recovery-issue.js';

export function summarizeValidation(opts: {
  validationResults?: ValidationResult[] | undefined;
  validationSummary?: string | undefined;
}): { detail: string; summary: string; stage?: ValidationResult['stage'] | undefined } {
  if (opts.validationSummary !== undefined && opts.validationSummary.trim().length > 0) {
    const summary = summarizeText(opts.validationSummary);
    return { detail: `Validation: ${summary}`, summary };
  }

  const failed = opts.validationResults?.find((result) => !result.passed);
  if (!failed) {
    return {
      detail: 'Validation failed without a reported failing stage.',
      summary: 'Validation failed without a reported failing stage.',
    };
  }

  const summary = summarizeText(failed.error || failed.output || `${failed.stage} failed`);
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
  if (attempts !== undefined && maxAttempts !== undefined)
    return [`Attempts: ${attempts}/${maxAttempts}`];
  if (attempts !== undefined) return [`Attempts: ${attempts}`];
  return [`Max attempts: ${maxAttempts}`];
}

export function implementerDetails(selectedImplementerProfile: string | undefined): string[] {
  return selectedImplementerProfile ? [`Worker profile: ${selectedImplementerProfile}`] : [];
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
      ...(task.scope?.inBounds ?? []).filter(looksLikeFilePath),
      ...(task.scope?.approvedOutOfBounds ?? []).filter(looksLikeFilePath),
    ],
    { trim: true, nonEmpty: true },
  );
}

export function fileConflictDetails(conflict: UserEditConflict): string[] {
  return conflict.fileConflicts.map((fileConflict) => {
    const affected =
      fileConflict.affectedTaskIds.length > 0
        ? ` affects ${fileConflict.affectedTaskIds.join(', ')}`
        : '';
    return `${fileConflict.file}: ${fileConflict.kind}${affected}`;
  });
}
