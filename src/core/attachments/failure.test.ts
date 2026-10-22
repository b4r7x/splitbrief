import { describe, expect, it } from 'vitest';
import {
  attachmentFailureText,
  formatAttachmentFailure,
  type AttachmentFailureReason,
} from './failure.js';

const reasons: [AttachmentFailureReason, string][] = [
  ['not-found', 'file not found. Check the path and try again.'],
  ['not-a-file', 'not a regular file. Name a file, not a directory.'],
  ['too-large', 'file is larger than 10 MiB. Choose a smaller file.'],
  ['unreadable', 'cannot read the file. Check its permissions.'],
  ['not-text', 'not a text file. Choose a UTF-8 text file or a supported image.'],
  ['not-image', 'choose a PNG, JPEG, GIF, WebP, or BMP file.'],
];

describe('attachmentFailureText', () => {
  it.each(reasons)('explains %s', (reason, text) => {
    expect(attachmentFailureText(reason)).toBe(text);
  });
});

describe.each([
  ['attach-image', 'Cannot attach image: '],
  ['attach-file', 'Cannot attach file: '],
  ['send', 'Cannot send: '],
] as const)('formatAttachmentFailure for %s', (action, prefix) => {
  it.each(reasons)('explains %s before naming the file', (reason, text) => {
    expect(formatAttachmentFailure({ action, reason })).toBe(`${prefix}${text}`);
    expect(formatAttachmentFailure({ action, reason, path: '/some/notes.md' })).toBe(
      `${prefix}${text} File: notes.md.`,
    );
  });

  it('names a directory with a trailing separator', () => {
    expect(
      formatAttachmentFailure({ action, reason: 'not-a-file', path: '/Users/me/notes/' }),
    ).toBe(`${prefix}not a regular file. Name a file, not a directory. File: notes.`);
  });

  it('truncates the base name of a long path to 24 cells', () => {
    expect(
      formatAttachmentFailure({
        action,
        reason: 'too-large',
        path: '/Users/me/projects/deeply/nested/directory/a-really-long-attachment-filename.png',
      }),
    ).toBe(
      `${prefix}file is larger than 10 MiB. Choose a smaller file. File: a-really-long-attachmen….`,
    );
  });

  it('strips terminal controls from the path suffix', () => {
    expect(
      formatAttachmentFailure({
        action,
        reason: 'unreadable',
        path: '\u001b]0;pwned\u0007\u001b[31mnotes.md\u001b[0m\n',
      }),
    ).toBe(`${prefix}cannot read the file. Check its permissions. File: notes.md .`);
  });
});
