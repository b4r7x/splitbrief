import type { Task } from '../../../core/schemas/task.js';
import { confinedExists, confinedReadFileAsync } from '../../../lib/confined-fs.js';
import { pathConfinementError } from '../../../lib/path-confinement.js';
import { matches } from '../../../utils/error.js';
import { extractCode } from '../../parsers/response-extractor.js';
import { applyCode } from '../apply.js';
import { computeDiff } from '../../../utils/diff.js';

const isPathEscape = matches('path-confined-escape');

export async function readTaskFileContent(
  projectDir: string,
  file: string,
): Promise<string | null> {
  try {
    if (!confinedExists(projectDir, file)) return null;
    return await confinedReadFileAsync(projectDir, file);
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err) || isPathEscape(err)) return null;
    throw err;
  }
}

export function extractedCodeApprovalRaceError(file: string): string {
  return `write blocked because ${file} changed during approval`;
}

export function isExtractedCodeApprovalRaceError(file: string, error?: string): boolean {
  return error === extractedCodeApprovalRaceError(file);
}

export async function processImplementerOutput(opts: {
  text: string;
  task: Task;
  projectDir: string;
  approvedBaselineContent: string | null;
  approveWrite?:
    | ((file: string) => Promise<{ allow: boolean; reason?: string | undefined }>)
    | undefined;
}): Promise<
  | { success: true; diff: string; linesAdded: number; linesRemoved: number }
  | { success: false; error: string }
> {
  const { text, task, projectDir, approvedBaselineContent, approveWrite } = opts;
  const extractResult = extractCode(text);

  if ('error' in extractResult) {
    return { success: false, error: extractResult.error };
  }

  const approval = approveWrite ? await approveWrite(task.file) : { allow: true };
  if (!approval.allow) {
    return { success: false, error: approval.reason ?? 'write denied by approval gate' };
  }

  const currentContent = await readTaskFileContent(projectDir, task.file);
  if (currentContent !== approvedBaselineContent) {
    return {
      success: false,
      error: extractedCodeApprovalRaceError(task.file),
    };
  }

  const applyResult = await applyCode(extractResult.code, task, projectDir);

  if (!applyResult.success) {
    return { success: false, error: applyResult.error ?? 'Failed to apply code' };
  }

  const newContent = (await readTaskFileContent(projectDir, task.file)) ?? '';
  const { diff, linesAdded, linesRemoved } = computeDiff(approvedBaselineContent ?? '', newContent);

  return { success: true, diff, linesAdded, linesRemoved };
}
