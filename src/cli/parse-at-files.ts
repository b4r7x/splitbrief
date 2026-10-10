import { attachmentFailureText } from '../core/attachments/failure.js';
import {
  formatAttachedText,
  resolveInputFile,
  type InputFileFailureReason,
} from '../core/attachments/resolve.js';
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
  reason: InputFileFailureReason;
}

export function formatAtFileRefusal(errors: readonly AtFileError[]): string {
  const header = 'Cannot start: SPLITBRIEF refused these @file inputs.';
  return [
    header,
    ...errors.map(
      (err) => `  @${stripTerminalControls(err.path)}: ${attachmentFailureText(err.reason)}`,
    ),
  ].join('\n');
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
    const result = resolveInputFile({ input: raw, projectDir });
    if (!result.ok) {
      errors.push({ path: raw, reason: result.reason });
      continue;
    }
    if (result.kind === 'image') {
      attachments.push(result.attachment);
      attachedInputs.push({ path: result.attachment.path, kind: 'image' });
    } else {
      textSegments.push(formatAttachedText(raw, result.content));
      attachedInputs.push({ path: result.path, kind: 'text' });
    }
  }

  const textContext = textSegments.join('\n\n');

  return { feature: finalFeature, textContext, attachments, attachedInputs, errors };
}
