import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '../schemas/attachment.js';
import type { Attachment } from '../schemas/attachment.js';
import type { DraftDocument } from '../schemas/draft-document.js';
import { createDraftDocument, removeDraftRange } from './document.js';
import { prepareDraftSubmission } from './submission.js';

let projectDir: string;
let externalDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-submission-'));
  externalDir = mkdtempSync(join(tmpdir(), 'splitbrief-submission-external-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(externalDir, { recursive: true, force: true });
});

function writeImage(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return realpathSync(path);
}

function image(id: string, path: string): Attachment {
  return { id, kind: 'image', path, mimeType: 'image/png', sizeBytes: 4 };
}

function draft(...parts: Array<string | Attachment>): DraftDocument {
  return {
    version: 1,
    parts: parts.map((part) =>
      typeof part === 'string' ? { kind: 'text', text: part } : { kind: 'image', attachment: part },
    ),
  };
}

const supported = () => ({ projectDir, supportsImages: true });

describe('prepareDraftSubmission', () => {
  it('references images at their positions and sends them in document order', () => {
    const first = image('img-1', writeImage(projectDir, 'first.png'));
    const second = image('img-2', writeImage(projectDir, 'second.png'));

    const result = prepareDraftSubmission(draft('A ', first, ' B\n', second, ' C'), supported());

    expect(result).toEqual({
      ok: true,
      document: draft('A ', first, ' B\n', second, ' C'),
      text: [
        'A [image:img-1] B',
        '[image:img-2] C',
        '',
        'Images referenced above, in attachment order:',
        '[image:img-1] = attached image 1',
        '[image:img-2] = attached image 2',
      ].join('\n'),
      images: [first, second],
    });
  });

  it('drops a deleted image atom and renumbers the remaining one', () => {
    const first = image('img-1', writeImage(projectDir, 'first.png'));
    const second = image('img-2', writeImage(projectDir, 'second.png'));
    const { document } = removeDraftRange(draft('A', first, 'B', second, 'C'), {
      start: 1,
      end: 2,
    });

    const result = prepareDraftSubmission(document, supported());

    expect(result.ok && result.images).toEqual([second]);
    expect(result.ok && result.text).toBe(
      'AB[image:img-2]C\n\nImages referenced above, in attachment order:\n[image:img-2] = attached image 1',
    );
  });

  it('refreshes image metadata from disk while keeping the atom id', () => {
    const path = writeImage(projectDir, 'pic.png');
    const stale = { ...image('img-1', path), sizeBytes: 999 };

    const result = prepareDraftSubmission(draft(stale), supported());

    expect(result.ok && result.images).toEqual([image('img-1', path)]);
  });

  it.each([
    {
      name: 'a seat without vision',
      reason: 'no-vision',
      make: () => writeImage(projectDir, 'pic.png'),
      supportsImages: false,
    },
    {
      name: 'a missing file',
      reason: 'not-found',
      make: () => {
        const path = writeImage(projectDir, 'gone.png');
        rmSync(path);
        return path;
      },
      supportsImages: true,
    },
    {
      name: 'an oversize file',
      reason: 'too-large',
      make: () => {
        const path = writeImage(projectDir, 'huge.png');
        truncateSync(path, MAX_ATTACHMENT_BYTES + 1);
        return path;
      },
      supportsImages: true,
    },
    {
      name: 'a file outside the safe roots',
      reason: 'outside-safe-roots',
      make: () => writeImage(externalDir, 'outside.png'),
      supportsImages: true,
    },
    {
      name: 'an unsupported extension',
      reason: 'not-image',
      make: () => join(projectDir, 'notes.txt'),
      supportsImages: true,
    },
  ])('fails on $name without touching the draft', ({ reason, make, supportsImages }) => {
    const ok = image('img-ok', writeImage(projectDir, 'ok.png'));
    const bad = image('img-bad', make());
    const document = draft('before ', ok, ' mid ', bad, ' after');
    const snapshot = structuredClone(document);

    const result = prepareDraftSubmission(document, { projectDir, supportsImages });

    expect(result).toEqual({ ok: false, reason, imageId: supportsImages ? 'img-bad' : 'img-ok' });
    expect(document).toEqual(snapshot);
  });

  it('submits an image-only draft with nonempty text', () => {
    const only = image('img-1', writeImage(projectDir, 'pic.png'));

    const result = prepareDraftSubmission(draft(only), supported());

    expect(result.ok && result.text).toBe(
      '[image:img-1]\n\nImages referenced above, in attachment order:\n[image:img-1] = attached image 1',
    );
    expect(result.ok && result.images).toEqual([only]);
  });

  it('submits a text-only draft as its exact text', () => {
    const text = '  fix the parser\n\nthen the tests\n\n';

    const result = prepareDraftSubmission(createDraftDocument(text), {
      projectDir,
      supportsImages: false,
    });

    expect(result).toEqual({ ok: true, document: createDraftDocument(text), text, images: [] });
  });

  it('keeps two images of the same file as two identities', () => {
    const path = writeImage(projectDir, 'same.png');

    const result = prepareDraftSubmission(
      draft(image('img-1', path), ' vs ', image('img-2', path)),
      supported(),
    );

    expect(result.ok && result.images.map((a) => [a.id, a.path])).toEqual([
      ['img-1', path],
      ['img-2', path],
    ]);
  });

  it('leaves marker-looking user text literal', () => {
    const text = 'see [image:img-1] and [image:att-123]';

    const result = prepareDraftSubmission(createDraftDocument(text), supported());

    expect(result).toEqual({ ok: true, document: createDraftDocument(text), text, images: [] });
  });
});
