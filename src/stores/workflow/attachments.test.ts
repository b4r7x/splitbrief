import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentShortName } from '../../core/attachments/resolve.js';
import { attachImage, attachmentsStore, detachImage, listAttachments } from './attachments.js';
import type { Attachment } from '../../core/schemas/attachment.js';

function makeAttachment(id: string): Attachment {
  return {
    id,
    kind: 'image',
    path: `/tmp/${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 100,
  };
}

let projectDir: string;

beforeEach(() => {
  attachmentsStore.reset();
  projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-attachments-'));
});

afterEach(() => {
  attachmentsStore.reset();
  rmSync(projectDir, { recursive: true, force: true });
});

function writeImage(name: string): string {
  const path = join(projectDir, name);
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return path;
}

function real(path: string): string {
  return realpathSync(path);
}

describe('attachmentsStore', () => {
  it('starts empty', () => {
    expect(attachmentsStore.peek()).toEqual([]);
  });

  it('adds and lists attachments', () => {
    attachmentsStore.add(makeAttachment('a'));
    attachmentsStore.add(makeAttachment('b'));
    expect(attachmentsStore.peek().map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('does not retain caller-owned attachments', () => {
    const attachment = makeAttachment('a');
    attachmentsStore.add(attachment);

    attachment.path = '/tmp/mutated.png';

    expect(attachmentsStore.peek()[0]?.path).toBe('/tmp/a.png');
  });

  it('removes by id', () => {
    attachmentsStore.add(makeAttachment('a'));
    attachmentsStore.add(makeAttachment('b'));
    attachmentsStore.remove('a');
    expect(attachmentsStore.peek().map((a) => a.id)).toEqual(['b']);
  });

  it('drain returns and clears pending', () => {
    attachmentsStore.add(makeAttachment('a'));
    attachmentsStore.add(makeAttachment('b'));
    const drained = attachmentsStore.drain();
    expect(drained.map((a) => a.id)).toEqual(['a', 'b']);
    expect(attachmentsStore.peek()).toEqual([]);
  });

  it('peek and drain return copies', () => {
    attachmentsStore.add(makeAttachment('a'));

    const peeked = attachmentsStore.peek();
    peeked[0]!.path = '/tmp/mutated.png';
    expect(attachmentsStore.peek()[0]?.path).toBe('/tmp/a.png');

    const internalBefore = attachmentsStore.get().pending[0];
    const drained = attachmentsStore.drain();
    expect(drained[0]).not.toBe(internalBefore);
    drained[0]!.path = '/tmp/mutated-again.png';
    expect(internalBefore?.path).toBe('/tmp/a.png');
  });

  it('drain on empty store does not error', () => {
    expect(attachmentsStore.drain()).toEqual([]);
  });
});

describe('attachment actions', () => {
  it('attaches resolved images and exposes list entries', () => {
    const path = writeImage('pic.png');
    const result = attachImage({ path, projectDir, supportsImages: true });

    expect(result).toEqual({ ok: true, path: real(path) });
    expect(listAttachments()).toEqual([
      {
        id: expect.stringMatching(/^att-/),
        path: real(path),
      },
    ]);
    expect(attachmentsStore.peek()[0]).not.toHaveProperty('addedAt');
  });

  it('rejects a seat without vision before reading the file', () => {
    const missing = join(projectDir, 'never-written.png');
    const result = attachImage({ path: missing, projectDir, supportsImages: false });

    expect(result).toEqual({ ok: false, reason: 'no-vision' });
    expect(listAttachments()).toEqual([]);
  });

  it('returns resolver errors without mutating pending attachments', () => {
    const result = attachImage({
      path: join(projectDir, 'notes.txt'),
      projectDir,
      supportsImages: true,
    });

    expect(result).toEqual({ ok: false, reason: 'not-image' });
    expect(listAttachments()).toEqual([]);
  });

  it('detaches by index, id, path suffix, and latest attachment', () => {
    const firstPath = writeImage('first.png');
    const secondPath = writeImage('second.png');
    const thirdPath = writeImage('third.png');
    attachImage({ path: firstPath, projectDir, supportsImages: true });
    attachImage({ path: secondPath, projectDir, supportsImages: true });
    attachImage({ path: thirdPath, projectDir, supportsImages: true });
    const [first] = listAttachments();
    if (!first) throw new Error('expected first attachment');

    expect(detachImage('2')).toBe(true);
    expect(listAttachments().map((a) => a.path)).toEqual([real(firstPath), real(thirdPath)]);

    expect(detachImage(first.id)).toBe(true);
    expect(listAttachments().map((a) => a.path)).toEqual([real(thirdPath)]);

    attachImage({ path: secondPath, projectDir, supportsImages: true });
    expect(detachImage('second.png')).toBe(true);
    expect(listAttachments().map((a) => a.path)).toEqual([real(thirdPath)]);

    expect(detachImage()).toBe(true);
    expect(listAttachments()).toEqual([]);
  });

  it('treats partial numeric strings as ids or path suffixes, not indexes', () => {
    const firstPath = writeImage('1-first.png');
    const secondPath = writeImage('2-second.png');
    attachImage({ path: firstPath, projectDir, supportsImages: true });
    attachImage({ path: secondPath, projectDir, supportsImages: true });

    expect(detachImage('1-first.png')).toBe(true);

    expect(listAttachments().map((a) => a.path)).toEqual([real(secondPath)]);
  });

  it('formats long attachment names without requiring workflow imports', () => {
    expect(attachmentShortName('/tmp/averyveryveryverylongname.png')).toBe(
      'averyveryveryverylongna…',
    );
  });
});
