import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isWindowsReservedName } from './identifiers.js';
import {
  containsUnsafePathUnicode,
  isPublicHostname,
  isSafePersistedText,
} from './persisted-data.js';

export const ProjectRelativePathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isSafePersistedText, {
    message: 'project file path contains unsafe persisted data',
  })
  .refine(isCanonicalProjectRelativePath, {
    message: 'project file path must be safe and project-relative',
  })
  .brand<'VisualProjectRelativePath'>();
export type ProjectRelativePath = z.infer<typeof ProjectRelativePathSchema>;

export const PublicHttpUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => getCanonicalPublicHttpUrl(value) === value)
  .brand<'VisualPublicHttpUrl'>();
export type PublicHttpUrl = z.infer<typeof PublicHttpUrlSchema>;

export const HyperlinkSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('external'),
        url: PublicHttpUrlSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('project-file'),
        path: ProjectRelativePathSchema,
      })
      .strict(),
  ])
  .readonly();
export type Hyperlink = z.infer<typeof HyperlinkSchema>;

export interface SanitizeHyperlinkOptions {
  readonly value: string;
  readonly projectRoot: string;
}

export function sanitizeHyperlink(options: SanitizeHyperlinkOptions): Hyperlink | null {
  const { value, projectRoot } = options;
  if (containsUnsafePathUnicode(value)) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const canonicalExternalUrl = parsePublicHttpUrl(value);
  if (canonicalExternalUrl !== null) {
    return { kind: 'external', url: canonicalExternalUrl };
  }
  if (url.protocol !== 'file:' || !isAbsolute(projectRoot)) return null;

  let filePath: string;
  try {
    filePath = fileURLToPath(url);
  } catch {
    return null;
  }

  const projectPath = relative(projectRoot, filePath);
  const normalizedPath = projectPath.split(sep).join('/');
  const parsedPath = ProjectRelativePathSchema.safeParse(normalizedPath);
  if (!parsedPath.success) return null;
  return { kind: 'project-file', path: parsedPath.data };
}

function parsePublicHttpUrl(value: string): PublicHttpUrl | null {
  const canonicalUrl = getCanonicalPublicHttpUrl(value);
  if (canonicalUrl === null) return null;

  const parsedUrl = PublicHttpUrlSchema.safeParse(canonicalUrl);
  return parsedUrl.success ? parsedUrl.data : null;
}

function getCanonicalPublicHttpUrl(value: string): string | null {
  if (containsUnsafePathUnicode(value) || !isSafePersistedText(value)) return null;

  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      !isPublicHostname(url.hostname)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function isCanonicalProjectRelativePath(value: string): boolean {
  if (
    containsUnsafePathUnicode(value) ||
    value.includes('\\') ||
    value.includes('%') ||
    value.includes(':') ||
    value.startsWith('/') ||
    /^[a-z]:/iu.test(value)
  ) {
    return false;
  }

  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !/[ .]$/u.test(segment) &&
      !isWindowsReservedName(segment),
  );
}
