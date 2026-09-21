import { describe, expect, it } from 'vitest';
import type { Attachment } from '../schemas/attachment.js';
import { DraftDocumentSchema } from '../schemas/draft-document.js';
import {
  createDraftDocument,
  draftError,
  draftLength,
  insertDraftImage,
  insertDraftText,
  normalizeDraftDocument,
  removeDraftRange,
  replaceDraftRange,
} from './document.js';

function image(id: string): Attachment {
  return { id, kind: 'image', path: `/tmp/${id}.png`, mimeType: 'image/png', sizeBytes: 10 };
}

describe('draft document image atoms', () => {
  it('inserts an image at the caret between surrounding text', () => {
    const { document, caret } = insertDraftImage(createDraftDocument('ab'), 1, image('img-1'));

    expect(document.parts).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'image', attachment: image('img-1') },
      { kind: 'text', text: 'b' },
    ]);
    expect(caret).toBe(2);
    expect(draftLength(document)).toBe(3);
  });

  it('edits text on either side of an image and deleting the atom removes only that image', () => {
    let edit = insertDraftImage(createDraftDocument('ab'), 1, image('img-1'));
    edit = insertDraftImage(edit.document, 3, image('img-2'));
    edit = insertDraftText(edit.document, 1, 'X');
    edit = insertDraftText(edit.document, 3, 'Y');

    expect(edit.document.parts).toEqual([
      { kind: 'text', text: 'aX' },
      { kind: 'image', attachment: image('img-1') },
      { kind: 'text', text: 'Yb' },
      { kind: 'image', attachment: image('img-2') },
    ]);

    const removed = removeDraftRange(edit.document, { start: 2, end: 3 });

    expect(removed.document.parts).toEqual([
      { kind: 'text', text: 'aXYb' },
      { kind: 'image', attachment: image('img-2') },
    ]);
    expect(removed.caret).toBe(2);
  });

  it('keeps image identity and document order across edits', () => {
    const first = image('img-1');
    let edit = insertDraftImage(createDraftDocument('one two'), 3, first);
    edit = insertDraftImage(edit.document, draftLength(edit.document), image('img-2'));
    edit = insertDraftText(edit.document, 0, '> ');

    const images = edit.document.parts.flatMap((part) =>
      part.kind === 'image' ? [part.attachment] : [],
    );
    expect(images.map((attachment) => attachment.id)).toEqual(['img-1', 'img-2']);
    expect(images[0]).toBe(first);
  });
});

describe('draft document pastes', () => {
  const paste = 'line 1\nline 2\nline 3\nline 4';

  it('removes a four-line paste inserted into an empty draft completely', () => {
    const pasted = insertDraftText(createDraftDocument(''), 0, paste);

    expect(pasted.document.parts).toEqual([{ kind: 'text', text: paste }]);
    expect(pasted.caret).toBe(paste.length);

    const removed = removeDraftRange(pasted.document, { start: 0, end: pasted.caret });

    expect(removed.document).toEqual({ version: 1, parts: [] });
    expect(removed.caret).toBe(0);
  });

  it('types after a paste without splitting the payload', () => {
    const pasted = insertDraftText(createDraftDocument('ab'), 1, paste);
    const typed = insertDraftText(pasted.document, pasted.caret, 'X');

    expect(typed.document.parts).toEqual([{ kind: 'text', text: `a${paste}Xb` }]);
    expect(typed.caret).toBe(1 + paste.length + 1);
  });

  it('keeps literal marker-looking text as ordinary text', () => {
    const document = createDraftDocument('see [paste:x] and [Image #1]');
    const { document: edited } = removeDraftRange(document, { start: 4, end: 5 });

    expect(draftLength(document)).toBe(28);
    expect(edited.parts).toEqual([{ kind: 'text', text: 'see paste:x] and [Image #1]' }]);
  });
});

describe('draft document normalization', () => {
  it('counts Unicode code points and never splits a surrogate pair', () => {
    const document = createDraftDocument('a😀b');

    expect(draftLength(document)).toBe(3);
    expect(insertDraftText(document, 2, '|').document.parts).toEqual([
      { kind: 'text', text: 'a😀|b' },
    ]);
    expect(removeDraftRange(document, { start: 1, end: 2 }).document.parts).toEqual([
      { kind: 'text', text: 'ab' },
    ]);
  });

  it('coalesces adjacent text, drops empty text and keeps adjacent images apart', () => {
    const document = normalizeDraftDocument({
      version: 1,
      parts: [
        { kind: 'text', text: '' },
        { kind: 'text', text: 'a' },
        { kind: 'text', text: 'b' },
        { kind: 'image', attachment: image('img-1') },
        { kind: 'image', attachment: image('img-2') },
        { kind: 'text', text: '' },
      ],
    });

    expect(document.parts).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'image', attachment: image('img-1') },
      { kind: 'image', attachment: image('img-2') },
    ]);
  });

  it('clamps and orders ranges at the endpoints', () => {
    const document = insertDraftImage(createDraftDocument('ab'), 2, image('img-1')).document;

    expect(insertDraftText(document, -5, 'S')).toMatchObject({
      document: { parts: [{ kind: 'text', text: 'Sab' }, { kind: 'image' }] },
      caret: 1,
    });
    expect(insertDraftText(document, 99, 'E')).toMatchObject({
      document: {
        parts: [{ kind: 'text', text: 'ab' }, { kind: 'image' }, { kind: 'text', text: 'E' }],
      },
      caret: 4,
    });
    expect(removeDraftRange(document, { start: 99, end: 1 })).toEqual({
      document: { version: 1, parts: [{ kind: 'text', text: 'a' }] },
      caret: 1,
    });
  });

  it('rejects duplicate image ids', () => {
    const document = insertDraftImage(createDraftDocument(''), 0, image('img-1')).document;

    expect(() => insertDraftImage(document, 1, image('img-1'))).toThrowError(
      expect.objectContaining({ kind: 'draft-duplicate-image-id' }),
    );
    expect(() =>
      normalizeDraftDocument({
        version: 1,
        parts: [
          { kind: 'image', attachment: image('img-1') },
          { kind: 'image', attachment: image('img-1') },
        ],
      }),
    ).toThrow(expect.toSatisfy(draftError.isDuplicateImageId));
    expect(
      DraftDocumentSchema.safeParse({
        version: 1,
        parts: [
          { kind: 'image', attachment: image('img-1') },
          { kind: 'text', text: 'x' },
          { kind: 'image', attachment: image('img-1') },
        ],
      }).success,
    ).toBe(false);
  });

  it('replacing an image with itself keeps the draft valid and leaves the input untouched', () => {
    const document = insertDraftImage(createDraftDocument('ab'), 1, image('img-1')).document;
    const snapshot = structuredClone(document);

    const replaced = replaceDraftRange(document, { start: 1, end: 2 }, [
      { kind: 'image', attachment: image('img-1') },
    ]);

    expect(replaced.document).toEqual(snapshot);
    expect(replaced.caret).toBe(2);
    expect(document).toEqual(snapshot);
  });
});
