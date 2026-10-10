import { beforeEach, describe, expect, it } from 'vitest';
import { createDraftDocument } from '../../core/composer/document.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import {
  getInputHistoryDocuments,
  draftDocumentText,
  inputHistoryStore,
  MAX_INPUT_HISTORY,
} from './input-history.js';

const homeEntries = () =>
  getInputHistoryDocuments(inputHistoryStore.get(), { currentScreen: 'home' }).map(
    draftDocumentText,
  );

describe('inputHistoryStore', () => {
  beforeEach(() => {
    inputHistoryStore.reset();
  });

  it('ignores blank pushes', () => {
    inputHistoryStore.push('   ');
    expect(homeEntries()).toEqual([]);
  });

  it('trims pushed values and keeps the newest first', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push(' second ');
    expect(homeEntries()).toEqual(['second', 'first']);
  });

  it('moves a re-pushed value to the front instead of duplicating it', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push('second');
    inputHistoryStore.push('first');
    expect(homeEntries()).toEqual(['first', 'second']);

    inputHistoryStore.push('first');
    expect(homeEntries()).toEqual(['first', 'second']);
  });

  it('caps pushed entries at the maximum, dropping the oldest', () => {
    for (let index = 0; index < MAX_INPUT_HISTORY + 2; index++) {
      inputHistoryStore.push(`item-${index}`);
    }
    expect(homeEntries()).toHaveLength(MAX_INPUT_HISTORY);
    expect(homeEntries()[0]).toBe(`item-${MAX_INPUT_HISTORY + 1}`);
  });

  it('replaces existing entries on hydrate', () => {
    inputHistoryStore.push('stale');
    inputHistoryStore.hydrate(['fresh-a', 'fresh-b']);
    expect(homeEntries()).toEqual(['fresh-a', 'fresh-b']);
  });

  it('drops duplicates while hydrating', () => {
    inputHistoryStore.hydrate(['a', 'b', 'a', 'c']);
    expect(homeEntries()).toEqual(['a', 'b', 'c']);
  });

  it('drops blank lines while hydrating', () => {
    inputHistoryStore.hydrate(['first', '', '   ', 'second']);
    expect(homeEntries()).toEqual(['first', 'second']);
  });

  it('strips ANSI escapes and raw controls from hydrated strings but keeps tabs, newlines and Unicode', () => {
    inputHistoryStore.hydrate([
      '\u001b[31mred\u001b[0m\u0007\u007f plain',
      'tabs\tnewlines\nand ünïcødé 🚀',
    ]);
    expect(homeEntries()).toEqual(['red plain', 'tabs\tnewlines\nand ünïcødé 🚀']);
  });

  it('drops hydrated entries whose text is only controls', () => {
    inputHistoryStore.hydrate(['\u001b[2J\u0000\u007f']);
    expect(homeEntries()).toEqual([]);
  });

  it('sanitizes document text parts before deduplication and preserves image metadata and ordering', () => {
    const attachment = {
      id: 'img-1',
      kind: 'image' as const,
      path: '/tmp/shot.png',
      mimeType: 'image/png',
      sizeBytes: 4,
    };
    const withImage: DraftDocument = {
      version: 1,
      parts: [
        { kind: 'text', text: '\u001b[2Jbefore\u0000' },
        { kind: 'image', attachment },
        { kind: 'text', text: '\u007f\nünicode\tkept' },
      ],
    };

    inputHistoryStore.hydrate(['\u001b[1mdirty\u001b[0m\u0007', 'dirty', withImage]);

    expect(getInputHistoryDocuments(inputHistoryStore.get(), { currentScreen: 'home' })).toEqual([
      createDraftDocument('dirty'),
      {
        version: 1,
        parts: [
          { kind: 'text', text: 'before' },
          { kind: 'image', attachment },
          { kind: 'text', text: '\nünicode\tkept' },
        ],
      },
    ]);
  });

  it('sanitizes entries on hydrate then retrieval for home and workflow screens', () => {
    const dirty: DraftDocument = {
      version: 1,
      parts: [{ kind: 'text', text: 'recall \u001b[31mred\u001b[0m\u0007' }],
    };

    inputHistoryStore.hydrate([dirty]);
    const state = inputHistoryStore.get();

    expect(getInputHistoryDocuments(state, { currentScreen: 'home' })).toEqual([
      createDraftDocument('recall red'),
    ]);
    expect(getInputHistoryDocuments(state, { currentScreen: 'workflow' })).toEqual([
      createDraftDocument('recall red'),
    ]);
  });

  it('caps hydrated entries at the maximum', () => {
    const lines = Array.from({ length: MAX_INPUT_HISTORY + 3 }, (_, i) => `item-${i}`);
    inputHistoryStore.hydrate(lines);
    expect(homeEntries()).toHaveLength(MAX_INPUT_HISTORY);
  });

  it('clears entries when hydrated with nothing', () => {
    inputHistoryStore.push('something');
    inputHistoryStore.hydrate([]);
    expect(homeEntries()).toEqual([]);
  });

  it('writes workflow prompts to both the persisted entries and the workflow ring', () => {
    inputHistoryStore.pushDocumentSubmission(createDraftDocument('persisted workflow prompt'), {
      currentScreen: 'workflow',
    });

    const state = inputHistoryStore.get();
    expect(state.entries).toEqual([createDraftDocument('persisted workflow prompt')]);
    expect(state.workflowEntries).toEqual([createDraftDocument('persisted workflow prompt')]);
    expect(getInputHistoryDocuments(state, { currentScreen: 'workflow' })).toEqual([
      createDraftDocument('persisted workflow prompt'),
    ]);
  });

  it('keeps a paste-only document as one exact entry, secrets and all, with image metadata only', () => {
    const paste = '  first line\n\ntoken sk-abcdefghijklmnopqrst\n';
    const withImage: DraftDocument = {
      version: 1,
      parts: [
        { kind: 'text', text: paste },
        {
          kind: 'image',
          attachment: {
            id: 'img-1',
            kind: 'image',
            path: '/tmp/shot.png',
            mimeType: 'image/png',
            sizeBytes: 4,
          },
        },
      ],
    };

    inputHistoryStore.pushDocumentSubmission(createDraftDocument(paste), { currentScreen: 'home' });
    inputHistoryStore.pushDocumentSubmission(withImage, { currentScreen: 'home' });
    inputHistoryStore.pushDocumentSubmission(createDraftDocument(paste), { currentScreen: 'home' });
    inputHistoryStore.pushDocumentSubmission(createDraftDocument(' \n '), {
      currentScreen: 'home',
    });

    expect(getInputHistoryDocuments(inputHistoryStore.get(), { currentScreen: 'home' })).toEqual([
      createDraftDocument(paste),
      withImage,
    ]);
    expect(homeEntries()).toEqual([paste, paste]);
  });
});
