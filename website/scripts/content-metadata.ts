import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CONTENT_GROUPS, ROOT_META_PAGES } from './content-manifest.js';
import type { SourceDiagnostic } from './source-diagnostic.js';

const ROOT_META_SCHEMA = z
  .object({
    pages: z.array(z.string()),
    root: z.literal(true),
    title: z.literal('Documentation'),
  })
  .strict();
const GROUP_META_SCHEMA = z
  .object({
    pages: z.array(z.string()),
    title: z.string(),
  })
  .strict();

function parseJsonFile(options: { readonly file: string }):
  | { readonly kind: 'invalid'; readonly violation: SourceDiagnostic }
  | {
      readonly data: unknown;
      readonly kind: 'valid';
    } {
  try {
    const data: unknown = JSON.parse(readFileSync(options.file, 'utf8'));
    return { data, kind: 'valid' };
  } catch (error) {
    return {
      kind: 'invalid',
      violation: {
        file: options.file,
        message: `cannot read valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

export function validateContentMetadata(options: {
  readonly directory: string;
}): SourceDiagnostic[] {
  const violations: SourceDiagnostic[] = [];
  const rootFile = join(options.directory, 'meta.json');
  const root = parseJsonFile({ file: rootFile });
  if (root.kind === 'invalid') {
    violations.push(root.violation);
  } else {
    const metadata = ROOT_META_SCHEMA.safeParse(root.data);
    if (
      !metadata.success ||
      JSON.stringify(metadata.data.pages) !== JSON.stringify(ROOT_META_PAGES)
    ) {
      violations.push({
        file: rootFile,
        message: 'root metadata must contain the exact title, root flag, and manifest navigation',
      });
    }
  }

  for (const group of CONTENT_GROUPS) {
    const file = join(options.directory, group.path, 'meta.json');
    const result = parseJsonFile({ file });
    if (result.kind === 'invalid') {
      violations.push(result.violation);
      continue;
    }

    const metadata = GROUP_META_SCHEMA.safeParse(result.data);
    if (
      !metadata.success ||
      metadata.data.title !== group.title ||
      JSON.stringify(metadata.data.pages) !== JSON.stringify(group.pages)
    ) {
      violations.push({
        file,
        message: `${group.title} metadata must contain the exact title and manifest navigation`,
      });
    }
  }

  return violations;
}
