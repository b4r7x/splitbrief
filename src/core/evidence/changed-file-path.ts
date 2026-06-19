import { z } from 'zod';

function normalizeProjectRelativeChangedFile(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function hasControlCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export const ProjectRelativeChangedFileSchema = z
  .string()
  .min(1)
  .superRefine((path, ctx) => {
    const normalized = normalizeProjectRelativeChangedFile(path);
    const segments = normalized.split('/');
    const firstSegment = segments[0] ?? '';

    if (
      normalized.length === 0 ||
      normalized.startsWith('/') ||
      normalized.startsWith('//') ||
      firstSegment.includes(':') ||
      hasControlCharacter(path) ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'changed file must be a project-relative file path',
      });
    }
  })
  .transform(normalizeProjectRelativeChangedFile);
