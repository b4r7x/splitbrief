import { describe, expect, it } from 'vitest';
import {
  MarkTaskDoneInputSchema,
  ReportErrorInputSchema,
  ReportEvidenceInputSchema,
} from './schemas.js';

const taskDoneInput = {
  sessionId: 'sess-001',
  taskId: 'T001',
  changedFiles: ['src/foo.ts'],
};

describe('MCP tool schemas', () => {
  it('normalizes project-relative changed files', () => {
    const parsed = MarkTaskDoneInputSchema.parse({
      ...taskDoneInput,
      changedFiles: ['./src/foo.ts', 'src\\bar.ts'],
    });

    expect(parsed.changedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it.each([
    ['/tmp/outside.ts'],
    ['../outside.ts'],
    ['src/../outside.ts'],
    [''],
    ['src/\u001b[31mowned.ts'],
    ['C:\\outside.ts'],
    ['./C:\\outside.ts'],
    ['.\\C:\\outside.ts'],
    ['./C:/outside.ts'],
    ['\\\\server\\share\\outside.ts'],
  ])('rejects unsafe changed file path %s', (path) => {
    const result = MarkTaskDoneInputSchema.safeParse({
      ...taskDoneInput,
      changedFiles: [path],
    });

    expect(result.success).toBe(false);
  });

  it('strips terminal controls from observed evidence on ingestion', () => {
    const parsed = ReportEvidenceInputSchema.parse({
      sessionId: 'sess-001',
      taskId: 'T001',
      observedEvidence: ['visible\u001b]52;c;clipboard-secret\u0007'],
      changedFiles: ['./src/foo.ts'],
    });

    expect(parsed.observedEvidence).toEqual(['visible']);
    expect(parsed.changedFiles).toEqual(['src/foo.ts']);
  });

  it('strips terminal controls from error text on ingestion', () => {
    const parsed = ReportErrorInputSchema.parse({
      sessionId: 'sess-001',
      taskId: 'T001',
      error: 'failed\u001b]52;c;clipboard-secret\u0007',
    });

    expect(parsed.error).toBe('failed');
  });
});
