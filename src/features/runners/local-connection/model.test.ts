import { describe, expect, it } from 'vitest';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { localConnectionModelRows, localConnectionProvider } from './model.js';

describe('localConnectionProvider', () => {
  it('opens the form for a local server the picker cannot list, and for nothing else', () => {
    const offline = { ...realPickerOption('planner', 'ollama'), available: false };
    expect(localConnectionProvider(offline)).toBe('ollama');
    expect(localConnectionProvider({ ...offline, available: true })).toBeUndefined();
    expect(
      localConnectionProvider({ ...realPickerOption('planner', 'codex'), available: false }),
    ).toBeUndefined();
  });
});

describe('localConnectionModelRows', () => {
  it('keeps a configured model the catalog does not carry instead of taking the first one', () => {
    const rows = localConnectionModelRows({
      seatModel: 'qwen2.5-coder:7b',
      catalog: [{ id: 'gemma3:27b' }, { id: 'deepseek-coder-v2:16b' }],
      probed: true,
    });

    expect(rows.map((row) => row.id)).toEqual([
      'qwen2.5-coder:7b',
      'gemma3:27b',
      'deepseek-coder-v2:16b',
    ]);
    expect(rows[0]?.state).toBe('not in this catalog');
  });

  it('separates the exact id from the label and states what the server said about loading', () => {
    const rows = localConnectionModelRows({
      seatModel: undefined,
      catalog: [
        {
          id: 'qwen/qwen3-coder-30b',
          displayName: 'Qwen3 Coder 30B',
          runtime: { loadState: 'loaded', observedAt: 1 },
        },
        { id: 'mistral:7b', runtime: { loadState: 'not-loaded', observedAt: 1 } },
        { id: 'gpt-oss-20b-mxfp4' },
      ],
      probed: true,
    });

    expect(rows[0]).toEqual({
      id: 'qwen/qwen3-coder-30b',
      label: 'Qwen3 Coder 30B',
      state: 'loaded',
    });
    expect(rows[1]?.state).toBe('not loaded');
    // No runtime record is an absent answer, so the row claims availability and no more.
    expect(rows[2]?.state).toBe('listed');
  });

  it('calls an unproven selection unknown after a failed check and not-checked before one', () => {
    const before = localConnectionModelRows({
      seatModel: 'qwen2.5-coder:7b',
      catalog: undefined,
      probed: false,
    });
    const after = localConnectionModelRows({
      seatModel: 'qwen2.5-coder:7b',
      catalog: undefined,
      probed: true,
    });

    expect(before[0]?.state).toBe('not checked');
    expect(after[0]?.state).toBe('unknown');
  });
});
