import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '../schemas/attachment.js';
import type { Attachment } from '../schemas/attachment.js';
import type { DraftDocument } from '../schemas/draft-document.js';
import { plainUserMessage } from '../types/user-input.js';
import { createDraftDocument, replaceDraftRange } from './document.js';
import { prepareDraftSubmission } from './submission.js';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
}));

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
}));

let projectDir: string;
let externalDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-submission-'));
  externalDir = mkdtempSync(join(tmpdir(), 'splitbrief-submission-external-'));
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe('composer file references', () => {
  it.each(['@./notes.md', '@docs/notes.md', '@"a b.md"', "@'a b.md'", '@notes.md'])(
    'attaches %s and keeps its typed reference',
    (reference) => {
      mkdirSync(join(projectDir, 'docs'));
      for (const name of ['notes.md', 'docs/notes.md', 'a b.md']) {
        writeFileSync(join(projectDir, name), 'Body\n\n');
      }
      const typedPath = reference.slice(1);
      const resolvedPath =
        typedPath.startsWith('"') || typedPath.startsWith("'") ? typedPath.slice(1, -1) : typedPath;
      const displayText = `read ${reference} please`;
      const plannerContext = `--- @${typedPath} ---\nBody\n\n`;

      expect(prepareDraftSubmission(createDraftDocument(displayText), supported())).toEqual({
        ok: true,
        document: createDraftDocument(displayText),
        message: {
          text: `${displayText}\n\n${plannerContext}`,
          displayText,
          images: [],
          attachedInputs: [{ path: realpathSync(join(projectDir, resolvedPath)), kind: 'text' }],
        },
        plannerContext,
      });
    },
  );

  it.each([
    ['my notes.md', 'my\\ notes.md'],
    ['a\\b.md', 'a\\\\b.md'],
    ['notes.md ', 'notes.md\\ '],
  ])('decodes the unquoted reference %s and preserves its typed text', (name, typedName) => {
    const path = join(externalDir, name);
    writeFileSync(path, 'Body\n');
    if (name.endsWith(' ')) writeFileSync(path.trimEnd(), 'Wrong file.');
    const typedPath = join(externalDir, typedName);
    const displayText = `read @${typedPath} please`;
    const plannerContext = `--- @${typedPath} ---\nBody\n`;

    expect(prepareDraftSubmission(createDraftDocument(displayText), supported())).toEqual({
      ok: true,
      document: createDraftDocument(displayText),
      message: {
        text: `${displayText}\n\n${plannerContext}`,
        displayText,
        images: [],
        attachedInputs: [{ path: realpathSync(path), kind: 'text' }],
      },
      plannerContext,
    });
  });

  it.each(['"', "'"])('keeps backslashes literal inside %s quoted references', (quote) => {
    const path = join(externalDir, 'a\\b.md');
    writeFileSync(path, 'Body\n');
    const typedPath = `${quote}${path}${quote}`;
    const displayText = `read @${typedPath} please`;
    const plannerContext = `--- @${typedPath} ---\nBody\n`;

    expect(prepareDraftSubmission(createDraftDocument(displayText), supported())).toEqual({
      ok: true,
      document: createDraftDocument(displayText),
      message: {
        text: `${displayText}\n\n${plannerContext}`,
        displayText,
        images: [],
        attachedInputs: [{ path: realpathSync(path), kind: 'text' }],
      },
      plannerContext,
    });
  });

  it.each([
    'ping @bob.',
    '@notes.md',
    'a@b.md',
    'embedded@./notes.md',
    '\\@./notes.md',
    '@',
    'hi @ there',
    "ping @'bob",
    'say @"hello world',
    'ping @\'bob"',
  ])('keeps %s as prose', (text) => {
    writeFileSync(join(projectDir, 'notes.md'), 'Do not attach.');
    if (text === '@notes.md') rmSync(join(projectDir, 'notes.md'));
    expect(prepareDraftSubmission(createDraftDocument(text), supported())).toEqual({
      ok: true,
      document: createDraftDocument(text),
      message: plainUserMessage(text),
      plannerContext: '',
    });
  });

  it('attaches outside absolute, parent-relative, and home paths', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(externalDir);
    const path = join(externalDir, 'outside.md');
    writeFileSync(path, 'Outside.');
    const parentPath = `../${externalDir.split('/').at(-1)}/outside.md`;
    for (const typedPath of [path, parentPath, '~/outside.md']) {
      const displayText = `@${typedPath}`;
      const plannerContext = `--- @${typedPath} ---\nOutside.`;
      expect(prepareDraftSubmission(createDraftDocument(displayText), supported())).toEqual({
        ok: true,
        document: createDraftDocument(displayText),
        message: {
          text: `${displayText}\n\n${plannerContext}`,
          displayText,
          images: [],
          attachedInputs: [{ path: realpathSync(path), kind: 'text' }],
        },
        plannerContext,
      });
    }
  });

  it('looks up an unmatched quote as part of the filename without dropping its last character', () => {
    writeFileSync(join(projectDir, "'bob"), 'The right body.');
    writeFileSync(join(projectDir, 'bo'), 'The wrong body.');
    const result = prepareDraftSubmission(createDraftDocument("ping @'bob"), supported());
    expect(result.ok && result.plannerContext).toBe("--- @'bob ---\nThe right body.");
  });

  it('finds references at the start and after every whitespace boundary', () => {
    writeFileSync(join(projectDir, 'notes.md'), 'Body');
    const displayText = '@notes.md\t@notes.md\n@notes.md';
    const result = prepareDraftSubmission(createDraftDocument(displayText), supported());
    expect(result.ok && result.plannerContext).toBe(
      Array(3).fill('--- @notes.md ---\nBody').join('\n\n'),
    );
    expect(result.ok && result.message.attachedInputs).toHaveLength(3);
  });

  it('ends a quoted reference at its closing quote', () => {
    writeFileSync(join(projectDir, 'a b.md'), 'Body');
    const result = prepareDraftSubmission(
      createDraftDocument('@"a b.md", then prose'),
      supported(),
    );
    expect(result.ok && result.message.displayText).toBe('@"a b.md", then prose');
    expect(result.ok && result.plannerContext).toBe('--- @"a b.md" ---\nBody');
  });

  it('does not parse attached bodies or an @ embedded after an image atom', () => {
    writeFileSync(join(projectDir, 'notes.md'), '@./missing.md');
    const atom = image('existing', writeImage(projectDir, 'shot.png'));
    const result = prepareDraftSubmission(draft(atom, '@./missing.md @notes.md'), supported());
    expect(result.ok && result.plannerContext).toBe('--- @notes.md ---\n@./missing.md');
    expect(result.ok && result.message.attachedInputs).toEqual([
      { path: atom.path, kind: 'image' },
      { path: realpathSync(join(projectDir, 'notes.md')), kind: 'text' },
    ]);
  });

  it('turns @x.png into an atom and preserves image and text encounter order', () => {
    const firstPath = writeImage(externalDir, 'x.png');
    const existing = image('existing', writeImage(projectDir, 'old.png'));
    const lastPath = writeImage(projectDir, 'last.png');
    writeFileSync(join(projectDir, 'one.md'), 'One\n');
    writeFileSync(join(projectDir, 'two.md'), 'Two');
    const result = prepareDraftSubmission(
      draft(`@${firstPath} @one.md `, existing, ' @two.md @last.png'),
      supported(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second, last] = result.message.images;
    if (!first || !second || !last) throw new Error('Expected three images.');
    const displayText = `[image:${first.id}] @one.md [image:existing] @two.md [image:${last.id}]\n\nImages referenced above, in attachment order:\n[image:${first.id}] = attached image 1\n[image:existing] = attached image 2\n[image:${last.id}] = attached image 3`;
    const plannerContext = '--- @one.md ---\nOne\n\n\n--- @two.md ---\nTwo';
    expect(result.document).toEqual(draft(first, ' @one.md ', existing, ' @two.md ', last));
    expect(first.path).toBe(firstPath);
    expect(second).toEqual(existing);
    expect(last.path).toBe(lastPath);
    expect(result.message).toEqual({
      text: `${displayText}\n\n${plannerContext}`,
      displayText,
      images: [first, existing, last],
      attachedInputs: [
        { path: firstPath, kind: 'image' },
        { path: realpathSync(join(projectDir, 'one.md')), kind: 'text' },
        { path: existing.path, kind: 'image' },
        { path: realpathSync(join(projectDir, 'two.md')), kind: 'text' },
        { path: lastPath, kind: 'image' },
      ],
    });
    expect(result.plannerContext).toBe(plannerContext);
  });

  it('turns a bare image path into an atom', () => {
    const path = writeImage(projectDir, 'x.png');
    const result = prepareDraftSubmission(createDraftDocument('@x.png'), supported());
    expect(result.ok && result.document.parts).toEqual([
      { kind: 'image', attachment: expect.objectContaining({ path }) },
    ]);
    expect(result.ok && result.message.attachedInputs).toEqual([{ path, kind: 'image' }]);
  });

  it.each([
    './missing.md',
    '../missing.md',
    '~/missing.md',
    'docs/missing.md',
    '"missing.md"',
    "'missing.md'",
  ])('refuses a missing explicit %s with its typed path', (path) => {
    vi.spyOn(os, 'homedir').mockReturnValue(externalDir);
    expect(prepareDraftSubmission(createDraftDocument(`read @${path}`), supported())).toEqual({
      ok: false,
      reason: 'not-found',
      path,
    });
  });

  it.each(['./notes.md', 'notes.md'])(
    'refuses a directory, oversized file, and unreadable file at %s atomically',
    (path) => {
      const file = join(projectDir, 'notes.md');
      const document = createDraftDocument(`keep @${path} all of this`);
      const snapshot = structuredClone(document);
      mkdirSync(file);
      expect(prepareDraftSubmission(document, supported())).toEqual({
        ok: false,
        reason: 'not-a-file',
        path,
      });
      rmSync(file, { recursive: true });
      writeFileSync(file, 'Body');
      truncateSync(file, MAX_ATTACHMENT_BYTES + 1);
      expect(prepareDraftSubmission(document, supported())).toEqual({
        ok: false,
        reason: 'too-large',
        path,
      });
      truncateSync(file, 4);
      vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('Denied'), { code: 'EACCES' });
      });
      expect(prepareDraftSubmission(document, supported())).toEqual({
        ok: false,
        reason: 'unreadable',
        path,
      });
      expect(document).toEqual(snapshot);
    },
  );

  it('checks vision only after an image reference resolves', () => {
    writeFileSync(join(projectDir, 'notes.md'), 'Text');
    writeImage(projectDir, 'x.png');
    const opts = { projectDir, supportsImages: false };
    expect(prepareDraftSubmission(createDraftDocument('@notes.md'), opts).ok).toBe(true);
    expect(prepareDraftSubmission(createDraftDocument('@./missing.png'), opts)).toEqual({
      ok: false,
      reason: 'not-found',
      path: './missing.png',
    });
    expect(prepareDraftSubmission(createDraftDocument('@x.png'), opts)).toEqual({
      ok: false,
      reason: 'no-vision',
      path: 'x.png',
    });
  });
});

describe('prepareDraftSubmission', () => {
  it('references images at their positions and sends them in document order', () => {
    const first = image('img-1', writeImage(projectDir, 'first.png'));
    const second = image('img-2', writeImage(projectDir, 'second.png'));

    const result = prepareDraftSubmission(draft('A ', first, ' B\n', second, ' C'), supported());

    expect(result).toEqual({
      ok: true,
      document: draft('A ', first, ' B\n', second, ' C'),
      message: {
        text: [
          'A [image:img-1] B',
          '[image:img-2] C',
          '',
          'Images referenced above, in attachment order:',
          '[image:img-1] = attached image 1',
          '[image:img-2] = attached image 2',
        ].join('\n'),
        displayText: [
          'A [image:img-1] B',
          '[image:img-2] C',
          '',
          'Images referenced above, in attachment order:',
          '[image:img-1] = attached image 1',
          '[image:img-2] = attached image 2',
        ].join('\n'),
        images: [first, second],
        attachedInputs: [first, second].map(({ path }) => ({ path, kind: 'image' })),
      },
      plannerContext: '',
    });
  });

  it('drops a deleted image atom and renumbers the remaining one', () => {
    const first = image('img-1', writeImage(projectDir, 'first.png'));
    const second = image('img-2', writeImage(projectDir, 'second.png'));
    const { document } = replaceDraftRange(
      draft('A', first, 'B', second, 'C'),
      {
        start: 1,
        end: 2,
      },
      [],
    );

    const result = prepareDraftSubmission(document, supported());

    expect(result.ok && result.message.images).toEqual([second]);
    expect(result.ok && result.message.text).toBe(
      'AB[image:img-2]C\n\nImages referenced above, in attachment order:\n[image:img-2] = attached image 1',
    );
  });

  it('refreshes image metadata from disk while keeping the atom id', () => {
    const path = writeImage(projectDir, 'pic.png');
    const stale = { ...image('img-1', path), sizeBytes: 999 };

    const result = prepareDraftSubmission(draft(stale), supported());

    expect(result.ok && result.message.images).toEqual([image('img-1', path)]);
  });

  it('resubmits an image reference whose symlink target has a different extension', () => {
    const path = writeImage(externalDir, 'image.data');
    symlinkSync(path, join(projectDir, 'shot.png'));
    const first = prepareDraftSubmission(createDraftDocument('@./shot.png'), supported());
    if (!first.ok) throw new Error(`Submission failed: ${first.reason}`);

    const repeated = prepareDraftSubmission(first.document, supported());

    expect(repeated).toEqual(first);
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
      name: 'a missing file outside the project',
      reason: 'not-found',
      make: () => join(externalDir, 'missing.png'),
      supportsImages: true,
    },
  ])('fails on $name without touching the draft', ({ reason, make, supportsImages }) => {
    const ok = image('img-ok', writeImage(projectDir, 'ok.png'));
    const bad = image('img-bad', make());
    const document = draft('before ', ok, ' mid ', bad, ' after');
    const snapshot = structuredClone(document);

    const result = prepareDraftSubmission(document, { projectDir, supportsImages });

    expect(result).toEqual({
      ok: false,
      reason,
      imageId: supportsImages ? 'img-bad' : 'img-ok',
      path: supportsImages ? bad.path : ok.path,
    });
    expect(document).toEqual(snapshot);
  });

  it('submits an image-only draft with nonempty text', () => {
    const only = image('img-1', writeImage(projectDir, 'pic.png'));

    const result = prepareDraftSubmission(draft(only), supported());

    expect(result.ok && result.message.text).toBe(
      '[image:img-1]\n\nImages referenced above, in attachment order:\n[image:img-1] = attached image 1',
    );
    expect(result.ok && result.message.images).toEqual([only]);
  });

  it('submits a text-only draft as its exact text', () => {
    const text = '  fix the parser\n\nthen the tests\n\n';

    const result = prepareDraftSubmission(createDraftDocument(text), {
      projectDir,
      supportsImages: false,
    });

    expect(result).toEqual({
      ok: true,
      document: createDraftDocument(text),
      message: plainUserMessage(text),
      plannerContext: '',
    });
  });

  it('keeps two images of the same file as two identities', () => {
    const path = writeImage(projectDir, 'same.png');

    const result = prepareDraftSubmission(
      draft(image('img-1', path), ' vs ', image('img-2', path)),
      supported(),
    );

    expect(result.ok && result.message.images.map((a) => [a.id, a.path])).toEqual([
      ['img-1', path],
      ['img-2', path],
    ]);
  });

  it('leaves marker-looking user text literal', () => {
    const text = 'see [image:img-1] and [image:att-123]';

    const result = prepareDraftSubmission(createDraftDocument(text), supported());

    expect(result).toEqual({
      ok: true,
      document: createDraftDocument(text),
      message: plainUserMessage(text),
      plannerContext: '',
    });
  });
});
