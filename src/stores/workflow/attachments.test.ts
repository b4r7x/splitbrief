import { beforeEach, describe, expect, it } from 'vitest';
import { attachmentsStore } from './attachments.js';
import type { Attachment } from '../../core/schemas/attachment.js';

function makeAttachment(id: string): Attachment {
  return {
    id,
    kind: 'image',
    path: `/tmp/${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 100,
    addedAt: Date.now(),
  };
}

beforeEach(() => {
  attachmentsStore.reset();
});

describe('attachmentsStore', () => {
  it('starts empty', () => {
    expect(attachmentsStore.peek()).toEqual([]);
  });

  it('adds and lists attachments', () => {
    attachmentsStore.add(makeAttachment('a'));
    attachmentsStore.add(makeAttachment('b'));
    expect(attachmentsStore.peek().map(a => a.id)).toEqual(['a', 'b']);
  });

  it('removes by id', () => {
    attachmentsStore.add(makeAttachment('a'));
    attachmentsStore.add(makeAttachment('b'));
    attachmentsStore.remove('a');
    expect(attachmentsStore.peek().map(a => a.id)).toEqual(['b']);
  });

  it('drain returns and clears pending', () => {
    attachmentsStore.add(makeAttachment('a'));
    attachmentsStore.add(makeAttachment('b'));
    const drained = attachmentsStore.drain();
    expect(drained.map(a => a.id)).toEqual(['a', 'b']);
    expect(attachmentsStore.peek()).toEqual([]);
  });

  it('drain on empty store does not error', () => {
    expect(attachmentsStore.drain()).toEqual([]);
  });
});
