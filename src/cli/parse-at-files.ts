import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { MAX_ATTACHMENT_BYTES, SUPPORTED_IMAGE_EXTS } from '../core/schemas/attachment.js';
import { resolveAttachment } from '../core/attachments/resolve.js';
import type { AttachedInput, Attachment } from '../core/schemas/attachment.js';
import { stripTerminalControls } from '../utils/display-text.js';

export interface AtFileResult {
  feature: string;
  textContext: string;
  attachments: Attachment[];
  attachedInputs: AttachedInput[];
  errors: AtFileError[];
}

export interface AtFileError {
  path: string;
  reason: 'not-found' | 'not-a-file' | 'too-large' | 'unreadable';
}

export function formatAtFileRefusal(errors: readonly AtFileError[]): string {
  const header = 'Cannot start: SPLITBRIEF refused these @file inputs.';
  return [
    header,
    ...errors.map((err) => `  @${stripTerminalControls(err.path)}: ${refusalText(err.reason)}`),
  ].join('\n');
}

function refusalText(reason: AtFileError['reason']): string {
  switch (reason) {
    case 'not-found':
      return 'file not found. Check the path and try again.';
    case 'not-a-file':
      return 'not a regular file. Name a file, not a directory.';
    case 'too-large':
      return 'file is larger than 10 MiB. Choose a smaller file.';
    case 'unreadable':
      return 'cannot read the file. Check its permissions.';
  }
}

export function parseAtFiles(feature: string, args: string[], projectDir: string): AtFileResult {
  const atPaths: string[] = [];
  const extraWords: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('@') && arg.length > 1) {
      atPaths.push(arg.slice(1));
    } else {
      extraWords.push(arg);
    }
  }

  const finalFeature = extraWords.length > 0 ? `${feature} ${extraWords.join(' ')}` : feature;

  const textSegments: string[] = [];
  const attachments: Attachment[] = [];
  const attachedInputs: AttachedInput[] = [];
  const errors: AtFileError[] = [];

  for (const raw of atPaths) {
    const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
    const absPath = isAbsolute(expanded) ? normalize(expanded) : resolve(projectDir, expanded);

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

    let resolved: string;
    try {
      resolved = realpathSync(absPath);
    } catch {
      errors.push({ path: raw, reason: 'not-found' });
      continue;
    }

    const isImage = SUPPORTED_IMAGE_EXTS.some((ext) => absPath.toLowerCase().endsWith(`.${ext}`));
    if (isImage) {
      try {
        accessSync(resolved, constants.R_OK);
      } catch {
        errors.push({ path: raw, reason: 'unreadable' });
        continue;
      }

      const imageResult = resolveAttachment({ input: absPath, projectDir });
      if (imageResult.ok) {
        attachments.push(imageResult.attachment);
        attachedInputs.push({ path: imageResult.attachment.path, kind: 'image' });
        continue;
      }
      if (imageResult.reason !== 'not-image') {
        errors.push({ path: raw, reason: imageResult.reason });
        continue;
      }
    }

    let content: string;
    try {
      content = readFileSync(resolved, 'utf-8');
    } catch {
      errors.push({ path: raw, reason: 'unreadable' });
      continue;
    }

    textSegments.push(`--- @${raw} ---\n${content}`);
    attachedInputs.push({ path: resolved, kind: 'text' });
  }

  const textContext = textSegments.join('\n\n');

  return { feature: finalFeature, textContext, attachments, attachedInputs, errors };
}
