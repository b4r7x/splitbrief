import { describe, expect, it } from 'vitest';
import { ProjectRelativeChangedFileSchema } from './changed-file-path.js';

describe('ProjectRelativeChangedFileSchema', () => {
  it('normalizes project-relative changed file paths', () => {
    expect(ProjectRelativeChangedFileSchema.parse('./src/foo.ts')).toBe('src/foo.ts');
    expect(ProjectRelativeChangedFileSchema.parse('src\\bar.ts')).toBe('src/bar.ts');
  });

  it.each([['./C:\\outside.ts'], ['.\\C:\\outside.ts'], ['./C:/outside.ts']])(
    'rejects normalized drive-prefixed path %s',
    (path) => {
      expect(ProjectRelativeChangedFileSchema.safeParse(path).success).toBe(false);
    },
  );
});
