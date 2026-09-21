import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushEffects } from '#testing/helpers/ink.js';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { MultilineInput } from './multiline-input.js';

function Input({
  onSubmit,
  onPaste,
  onFileDrop,
  active = true,
}: {
  onSubmit: (value: string) => void;
  onPaste?: ((text: string, caret: number) => boolean) | undefined;
  onFileDrop?: (path: string) => void;
  active?: boolean;
}) {
  const [value, setValue] = useState('draft');
  return (
    <MultilineInput
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      onPaste={onPaste}
      {...(onFileDrop ? { onFileDrop } : {})}
      isActive={active}
      keyBindings={{ submit: (key) => key.return, newline: () => false }}
    />
  );
}

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

describe('bracketed paste into a mounted input', () => {
  it.each(['\n', '\t', '  first\nsecond\n', 'e\u0301'])(
    'inserts %j once without submitting',
    async (text) => {
      const onSubmit = vi.fn();
      const ui = renderThroughFilteredStdin(<Input onSubmit={onSubmit} />);
      unmount = ui.unmount;
      await flushEffects();
      ui.pressBytes(`\u001b[200~${text}\u001b[201~`);
      await flushEffects();
      expect(onSubmit).not.toHaveBeenCalled();
      ui.pressBytes('X');
      await flushEffects();
      ui.pressBytes('\r');
      await flushEffects();
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(`draft${text.normalize('NFC')}X`);
    },
  );

  it('offers only framed paste before NFC at the current caret and lets the caller consume it', async () => {
    const onSubmit = vi.fn();
    const onPaste = vi.fn(() => true);
    const ui = renderThroughFilteredStdin(<Input onSubmit={onSubmit} onPaste={onPaste} />);
    unmount = ui.unmount;
    await flushEffects();
    ui.pressBytes('\u001b[D');
    await flushEffects();
    ui.pressBytes('\u001b[200~e\u0301\u001b[201~');
    await flushEffects();
    expect(onPaste).toHaveBeenCalledExactlyOnceWith('e\u0301', 4);
    ui.pressBytes('ordinary');
    await flushEffects();
    expect(onPaste).toHaveBeenCalledTimes(1);
    ui.pressBytes('\r');
    await flushEffects();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('drafordinaryt');
  });

  it('keeps text and paste in wire order when they share a chunk', async () => {
    const onSubmit = vi.fn();
    const ui = renderThroughFilteredStdin(<Input onSubmit={onSubmit} />);
    unmount = ui.unmount;
    await flushEffects();
    ui.pressBytes('A\u001b[200~\n\u001b[201~B');
    await flushEffects();
    ui.pressBytes('\r');
    await flushEffects();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('draftA\nB');
  });

  it('keeps a quoted image path on the drop path before paste interception', async () => {
    const onSubmit = vi.fn();
    const onPaste = vi.fn(() => true);
    const onFileDrop = vi.fn();
    const ui = renderThroughFilteredStdin(
      <Input onSubmit={onSubmit} onPaste={onPaste} onFileDrop={onFileDrop} />,
    );
    unmount = ui.unmount;
    await flushEffects();

    ui.pressBytes('\u001b[200~"/tmp/pasted-image.png"\u001b[201~');
    await flushEffects();

    expect(onFileDrop).toHaveBeenCalledExactlyOnceWith('/tmp/pasted-image.png');
    expect(onPaste).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('removes paste interception on unmount', async () => {
    const ui = renderThroughFilteredStdin(<Input onSubmit={() => {}} />);
    await flushEffects();
    expect(ui.filtered.stdin.listenerCount('paste')).toBe(1);
    ui.unmount();
    expect(ui.filtered.stdin.listenerCount('paste')).toBe(0);
  });
});
