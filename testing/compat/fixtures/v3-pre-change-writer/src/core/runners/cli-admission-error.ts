import { error } from '../../utils/error.js';

export const cliAdmissionError = {
  omitRequiresAbsentSource: (relativePath: string) =>
    error(
      'cli-admission-omit-absent-source',
      `CLI admission OMIT requires absent candidate source: ${relativePath}`,
      { relativePath },
    ),
} as const;
