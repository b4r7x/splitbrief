import { resolve } from 'node:path';
import { assertModelWritablePathConfined } from './scope/control-plane.js';
import { error, matches } from '../utils/error.js';

export const pathError = {
  escapesProject: (filePath: string, cause?: unknown) =>
    error(
      'path-escapes-project',
      `Path '${filePath}' escapes project directory`,
      { filePath },
      cause,
    ),
  isEscapesProject: matches('path-escapes-project'),
} as const;

export function validateTaskPath(projectDir: string, filePath: string): string {
  try {
    assertModelWritablePathConfined(filePath, projectDir);
  } catch (err) {
    throw pathError.escapesProject(filePath, err);
  }
  return resolve(projectDir, filePath);
}
