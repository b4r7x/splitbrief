import { attachmentShortName } from './resolve.js';
import type { InputFileFailureReason } from './resolve.js';

export type AttachmentFailureReason = InputFileFailureReason | 'not-image';

export function attachmentFailureText(reason: AttachmentFailureReason): string {
  switch (reason) {
    case 'not-found':
      return 'file not found. Check the path and try again.';
    case 'not-a-file':
      return 'not a regular file. Name a file, not a directory.';
    case 'too-large':
      return 'file is larger than 10 MiB. Choose a smaller file.';
    case 'unreadable':
      return 'cannot read the file. Check its permissions.';
    case 'not-text':
      return 'not a text file. Choose a UTF-8 text file or a supported image.';
    case 'not-image':
      return 'choose a PNG, JPEG, GIF, WebP, or BMP file.';
  }
}

export function formatAttachmentFailure(input: {
  action: 'attach-image' | 'attach-file' | 'send';
  reason: AttachmentFailureReason;
  path?: string | undefined;
}): string {
  const action = { 'attach-image': 'attach image', 'attach-file': 'attach file', send: 'send' };
  const suffix = input.path === undefined ? '' : ` File: ${attachmentShortName(input.path)}.`;
  return `Cannot ${action[input.action]}: ${attachmentFailureText(input.reason)}${suffix}`;
}
