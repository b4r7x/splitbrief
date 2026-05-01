import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '../core/schemas/attachment.js';
import { resolveAttachment } from '../core/attachments/resolve.js';
import { assertPathConfined } from '../lib/path-confinement.js';
import type { Attachment } from '../core/schemas/attachment.js';

export interface AtFileResult {
  feature: string;
  textContext: string;
  attachments: Attachment[];
  errors: AtFileError[];
}

export interface AtFileError {
  path: string;
  reason: 'not-found' | 'not-a-file' | 'too-large' | 'unreadable' | 'outside-safe-roots' | 'outside-project';
}

export function parseAtFiles(
  feature: string,
  args: string[],
  projectDir: string,
): AtFileResult {
  const atPaths: string[] = [];
  const extraWords: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('@') && arg.length > 1) {
      atPaths.push(arg.slice(1));
    } else {
      extraWords.push(arg);
    }
  }

  const finalFeature = extraWords.length > 0
    ? `${feature} ${extraWords.join(' ')}`
    : feature;

  const textSegments: string[] = [];
  const attachments: Attachment[] = [];
  const errors: AtFileError[] = [];

  for (const raw of atPaths) {
    const absPath = resolve(projectDir, raw);

    const imageResult = resolveAttachment({ input: absPath, projectDir });
    if (imageResult.ok) {
      attachments.push(imageResult.attachment);
      continue;
    }
    if (imageResult.reason !== 'not-image') {
      errors.push({ path: raw, reason: imageResult.reason });
      continue;
    }

    try {
      assertPathConfined(raw, projectDir);
    } catch {
      errors.push({ path: raw, reason: 'outside-project' });
      continue;
    }

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absPath);
    } catch {
      errors.push({ path: raw, reason: 'not-found' });
      continue;
    }

    if (!stat.isFile()) {
      errors.push({ path: raw, reason: 'not-a-file' });
      continue;
    }

    if (stat.size > MAX_ATTACHMENT_BYTES) {
      errors.push({ path: raw, reason: 'too-large' });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      errors.push({ path: raw, reason: 'unreadable' });
      continue;
    }

    textSegments.push(`--- @${raw} ---\n${content}`);
  }

  const textContext = textSegments.join('\n\n');

  return { feature: finalFeature, textContext, attachments, errors };
}
