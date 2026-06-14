import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServerArgsAttachmentDrain } from './server-args.js';

describe('createServerArgsAttachmentDrain', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'server-args-drain-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('materializes persisted records into full image attachments', () => {
    const imgPath = join(tmp, 'mockup.png');
    writeFileSync(imgPath, Buffer.from([1, 2, 3, 4]));

    const drain = createServerArgsAttachmentDrain([
      { id: 'att-1', path: imgPath, mimeType: 'image/png' },
    ]);

    const drained = drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      id: 'att-1',
      kind: 'image',
      path: imgPath,
      mimeType: 'image/png',
      sizeBytes: 4,
    });
    expect(drained[0]).not.toHaveProperty('addedAt');
  });

  it('is one-shot: a second drain yields nothing', () => {
    const imgPath = join(tmp, 'mockup.png');
    writeFileSync(imgPath, Buffer.from([1, 2, 3, 4]));

    const drain = createServerArgsAttachmentDrain([
      { id: 'att-1', path: imgPath, mimeType: 'image/png' },
    ]);

    expect(drain()).toHaveLength(1);
    expect(drain()).toEqual([]);
  });

  it('falls back to a positive size when the file is gone', () => {
    const drain = createServerArgsAttachmentDrain([
      { id: 'att-1', path: join(tmp, 'missing.png'), mimeType: 'image/png' },
    ]);

    const drained = drain();
    expect(drained[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('returns nothing when no attachments were persisted', () => {
    expect(createServerArgsAttachmentDrain(undefined)()).toEqual([]);
    expect(createServerArgsAttachmentDrain([])()).toEqual([]);
  });
});
