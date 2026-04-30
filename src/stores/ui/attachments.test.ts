import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachImage,
  attachmentShortName,
  attachmentsStore,
  detachImage,
  listAttachments,
} from './attachments.js';

let projectDir: string;

beforeEach(() => {
  attachmentsStore.reset();
  projectDir = mkdtempSync(join(tmpdir(), 'diptych-attachments-'));
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

describe('attachment actions', () => {
  it('attaches resolved images and exposes list entries', () => {
    const path = writeImage('pic.png');
    const result = attachImage(path, projectDir);

    expect(result).toEqual({ ok: true, path: real(path) });
    expect(listAttachments()).toEqual([
      {
        id: expect.stringMatching(/^att-/),
        path: real(path),
      },
    ]);
  });

  it('returns resolver errors without mutating pending attachments', () => {
    const result = attachImage(join(projectDir, 'notes.txt'), projectDir);

    expect(result).toEqual({ ok: false, reason: 'not-image' });
    expect(listAttachments()).toEqual([]);
  });

  it('detaches by index, id, path suffix, and latest attachment', () => {
    const firstPath = writeImage('first.png');
    const secondPath = writeImage('second.png');
    const thirdPath = writeImage('third.png');
    attachImage(firstPath, projectDir);
    attachImage(secondPath, projectDir);
    attachImage(thirdPath, projectDir);
    const [first] = listAttachments();
    if (!first) throw new Error('expected first attachment');

    expect(detachImage('2')).toBe(true);
    expect(listAttachments().map(a => a.path)).toEqual([real(firstPath), real(thirdPath)]);

    expect(detachImage(first.id)).toBe(true);
    expect(listAttachments().map(a => a.path)).toEqual([real(thirdPath)]);

    attachImage(secondPath, projectDir);
    expect(detachImage('second.png')).toBe(true);
    expect(listAttachments().map(a => a.path)).toEqual([real(thirdPath)]);

    expect(detachImage()).toBe(true);
    expect(listAttachments()).toEqual([]);
  });

  it('formats long attachment names without requiring workflow imports', () => {
    expect(attachmentShortName('/tmp/averyveryveryverylongname.png')).toBe('averyveryveryverylong...');
  });
});
