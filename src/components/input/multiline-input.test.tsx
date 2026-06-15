import { useState } from 'react';
import { Box, Text } from 'ink';
import type { Key } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { MultilineInput } from './multiline-input.js';

const CTRL_R = '\x12';
const CTRL_U = '\x15';
// Ctrl+/ as the legacy control byte on terminals without the kitty protocol.
const CTRL_SLASH_LEGACY = '\x1f';
// Kitty CSI-u encodings ink parses: codepoint 13 = Enter, modifier 2 = Shift.
const ENTER = '\x1b[13u';
const SHIFT_ENTER = '\x1b[13;2u';

interface HarnessProps {
  onFileDrop?: (path: string) => void;
  keyBindings?: { submit?: (key: Key) => boolean; newline?: (key: Key) => boolean };
  onSubmit?: (value: string) => void;
}

function Harness({ onFileDrop, keyBindings, onSubmit }: HarnessProps) {
  const [value, setValue] = useState('');
  return (
    <Box flexDirection="column">
      <Text>value:{value}</Text>
      <MultilineInput
        value={value}
        onChange={setValue}
        {...(onFileDrop ? { onFileDrop } : {})}
        {...(keyBindings ? { keyBindings } : {})}
        {...(onSubmit ? { onSubmit } : {})}
        showCursor={false}
        rows={1}
      />
    </Box>
  );
}

const COMPOSER_KEY_BINDINGS = {
  submit: (key: Key) => key.return && !key.shift,
  newline: (key: Key) => key.return && key.shift,
};

describe('MultilineInput modifier chords', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  it('swallows unhandled Ctrl+R without inserting text', async () => {
    const ui = renderFeature(<Harness />);
    unmount = ui.unmount;
    await tick(20);

    ui.stdin.write('r');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('value:r');

    ui.stdin.write(CTRL_U);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('value:');
    expect(ui.lastFrame() ?? '').not.toContain('value:r');

    ui.stdin.write(CTRL_R);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('value:');
    expect(ui.lastFrame() ?? '').not.toContain('value:r');
  });

  it('leaves the draft unchanged for a bare C0 control byte (Ctrl+/ on legacy terminals)', async () => {
    const ui = renderFeature(<Harness />);
    unmount = ui.unmount;
    await tick(20);

    ui.stdin.write('ab');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('value:ab');

    ui.stdin.write(CTRL_SLASH_LEGACY);
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('value:ab');
    expect(frame).not.toContain(CTRL_SLASH_LEGACY);
  });

  it('ignores Home and End so they pass through to the conversation scroll handler', async () => {
    const ui = renderFeature(<Harness />);
    unmount = ui.unmount;
    await tick(20);

    ui.stdin.write('ab');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('value:ab');

    ui.stdin.write('\x1B[H');
    await tick(20);
    ui.stdin.write('\x1B[F');
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('value:ab');
  });
});

describe('MultilineInput file drop', () => {
  it('accepts quoted image paths that contain spaces', async () => {
    let dropped: string | undefined;
    const ui = renderFeature(<Harness onFileDrop={(path) => (dropped = path)} />);
    await tick(20);

    ui.stdin.write('"/tmp/my photo.png"');
    await tick(20);

    expect(dropped).toBe('/tmp/my photo.png');
    expect(ui.lastFrame() ?? '').toContain('value:');
    ui.unmount();
  });
});

describe('MultilineInput keyBinding precedence (composer bindings)', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  it('inserts a newline on Shift+Enter instead of submitting', async () => {
    const submits: string[] = [];
    const ui = renderFeature(
      <Harness keyBindings={COMPOSER_KEY_BINDINGS} onSubmit={(v) => submits.push(v)} />,
    );
    unmount = ui.unmount;
    await tick(20);

    ui.stdin.write('ab');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('value:ab');

    ui.stdin.write(SHIFT_ENTER);
    await tick(20);
    ui.stdin.write('cd');
    await tick(20);

    expect(ui.lastFrame() ?? '').toContain('value:ab');
    expect(ui.lastFrame() ?? '').toContain('cd');
    expect(submits).toEqual([]);
  });

  it('submits on plain Enter without inserting a newline', async () => {
    const submits: string[] = [];
    const ui = renderFeature(
      <Harness keyBindings={COMPOSER_KEY_BINDINGS} onSubmit={(v) => submits.push(v)} />,
    );
    unmount = ui.unmount;
    await tick(20);

    ui.stdin.write('ab');
    await tick(20);

    ui.stdin.write(ENTER);
    await tick(20);

    expect(submits).toEqual(['ab']);
    expect(ui.lastFrame() ?? '').toContain('value:ab');
  });
});

const BACKSPACE = '\x7f';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const EMOJI = '😀';

function CursorHarness() {
  const [value, setValue] = useState('');
  return (
    <Box flexDirection="column">
      <Text>value:[{value}]</Text>
      <MultilineInput value={value} onChange={setValue} showCursor={true} rows={1} />
    </Box>
  );
}

describe('MultilineInput astral-plane editing', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  it('backspace deletes a whole emoji instead of a lone surrogate', async () => {
    const ui = renderFeature(<CursorHarness />);
    unmount = ui.unmount;
    await tick(20);

    ui.stdin.write(`a${EMOJI}`);
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain(`value:[a${EMOJI}]`);

    ui.stdin.write(BACKSPACE);
    await tick(20);

    // The emoji is gone entirely — no half-surrogate residue.
    expect(ui.lastFrame() ?? '').toContain('value:[a]');
  });

  it('left then right arrow steps over the full emoji code point', async () => {
    const ui = renderFeature(<CursorHarness />);
    unmount = ui.unmount;
    await tick(20);

    ui.stdin.write(EMOJI);
    await tick(20);

    // Left moves to before the emoji; typing inserts ahead of it.
    ui.stdin.write(LEFT);
    await tick(20);
    ui.stdin.write('x');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain(`value:[x${EMOJI}]`);

    // Right steps over the whole emoji; typing lands after it.
    ui.stdin.write(RIGHT);
    await tick(20);
    ui.stdin.write('y');
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain(`value:[x${EMOJI}y]`);
  });
});
