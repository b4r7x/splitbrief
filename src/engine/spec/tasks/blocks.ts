import { z } from 'zod';
import { FileActionSchema } from '../../../core/schemas/enums.js';
import { isPathConfined } from '../../../lib/path-confinement.js';
import { parseSimpleYamlFrontmatter } from '../../../utils/frontmatter.js';

export const TaskFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  action: FileActionSchema,
  file: z
    .string()
    .min(1)
    .refine((p) => isPathConfined(p, '.'), {
      message: 'task file path must be a confined relative path',
    }),
  depends_on: z
    .union([z.array(z.string()), z.string().transform((s) => [s])])
    .optional()
    .default([]),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;

export function fenceMarkerLength(trimmed: string): number | null {
  const match = trimmed.match(/^(`{3,})/);
  return match?.[1] ? match[1].length : null;
}

export function splitTaskBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split('\n');
  let current: string[] = [];
  let state: 'idle' | 'in-frontmatter' | 'in-body' = 'idle';
  let fenceLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    const recoversFromUnclosedFence =
      fenceLength > 0 &&
      state === 'in-body' &&
      trimmed === '---' &&
      nextNonBlankLineIsTaskId(lines, i + 1) &&
      !fenceClosesBefore(lines, i + 1, fenceLength);
    if (recoversFromUnclosedFence) fenceLength = 0;

    const marker = fenceMarkerLength(trimmed);
    if (marker !== null) {
      if (fenceLength === 0) fenceLength = marker;
      else if (marker >= fenceLength) fenceLength = 0;
    }

    const isSeparator = (fenceLength === 0 && trimmed === '---') || recoversFromUnclosedFence;

    if (state === 'idle' && isSeparator) {
      current = [line];
      state = 'in-frontmatter';
    } else if (state === 'in-frontmatter' && isSeparator) {
      current.push(line);
      state = 'in-body';
    } else if (state === 'in-body' && isSeparator) {
      blocks.push(current.join('\n'));
      current = [line];
      state = 'in-frontmatter';
    } else {
      current.push(line);
    }
  }

  if (state !== 'idle' && current.length > 0) {
    blocks.push(current.join('\n'));
  }

  return blocks;
}

export function normalizeTaskSeparators(content: string): string {
  const lines = content.split('\n');
  let fenceLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const marker = fenceMarkerLength(line.trim());
    if (marker !== null) {
      if (fenceLength === 0) fenceLength = marker;
      else if (marker >= fenceLength) fenceLength = 0;
      continue;
    }

    if (fenceLength > 0) continue;
    if (!/^id:/.test(lines[i + 1] ?? '')) continue;

    lines[i] = line.replace(/([^\r])---(\r?)$/, '$1\n---$2');
  }

  return lines.join('\n');
}

export function looksLikeTaskBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed.startsWith('---')) return false;
  return /\bid:\s*\S/.test(trimmed);
}

export function opensUnterminatedFrontmatter(block: string): boolean {
  if (!block.trim().startsWith('---')) return false;
  const lines = block.split('\n');
  let fenceLength = 0;
  let separators = 0;
  let contentAfterOpen = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const marker = fenceMarkerLength(trimmed);
    if (marker !== null) {
      if (fenceLength === 0) fenceLength = marker;
      else if (marker >= fenceLength) fenceLength = 0;
    }
    if (fenceLength === 0 && trimmed === '---') {
      separators += 1;
      continue;
    }
    if (separators === 1 && trimmed !== '') contentAfterOpen = true;
  }
  return separators < 2 && contentAfterOpen;
}

export function taskBlockParseFailure(block: string): string {
  const raw = parseSimpleYamlFrontmatter(block);
  if (!raw) return 'malformed YAML frontmatter';
  const result = TaskFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    return result.error.issues.map((issue) => issue.message).join('; ');
  }
  return 'missing required task sections';
}

export function extractTaskFrontmatter(block: string): TaskFrontmatter | null {
  const raw = parseSimpleYamlFrontmatter(block);
  if (!raw) return null;

  const result = TaskFrontmatterSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function nextNonBlankLineIsTaskId(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '') continue;
    return /^id:\s*\S/.test(trimmed);
  }
  return false;
}

function fenceClosesBefore(lines: string[], from: number, openLength: number): boolean {
  for (let i = from; i < lines.length; i++) {
    const marker = fenceMarkerLength((lines[i] ?? '').trim());
    if (marker !== null && marker >= openLength) return true;
  }
  return false;
}
