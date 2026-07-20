import type { z } from 'zod';

export interface AddDuplicateIssuesOptions {
  readonly values: readonly string[];
  readonly label: string;
  readonly context: z.core.$RefinementCtx<unknown>;
}

export function addDuplicateIssues(options: AddDuplicateIssuesOptions): void {
  const seen = new Set<string>();
  for (const value of options.values) {
    if (seen.has(value)) {
      options.context.addIssue({
        code: 'custom',
        message: `duplicate ${options.label}: ${value}`,
      });
    }
    seen.add(value);
  }
}
