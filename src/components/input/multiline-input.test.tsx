import { useState } from 'react';
import { Box, Text } from 'ink';
import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { MultilineInput, type InputAtom, type InputEdit } from './multiline-input.js';

const CTRL_R = '\x12';
const CTRL_U = '\x15';
const CTRL_B = '\x02';
const CTRL_E = '\x05';
const CTRL_F = '\x06';
const CTRL_W = '\x17';
const ALT_A = '\x1ba';
// Ctrl+/ as the legacy control byte on terminals without the kitty protocol.
const CTRL_SLASH_LEGACY = '\x1f';
// Kitty CSI-u encodings ink parses: codepoint 13 = Enter, modifier 2 = Shift.
const ENTER = '\x1b[13u';
const SHIFT_ENTER = '\x1b[13;2u';

interface HarnessProps {
  onFileDrop?: (path: string) => void;
  keyBindings?: {
    submit?: (key: Key) => boolean;
    newline?: (key: Key) => boolean;
    shortcut?: (input: string, key: Key) => boolean;
  };
  onShortcut?: () => void;
  onSubmit?: (value: string) => void;
}

function Harness({ onFileDrop, keyBindings, onShortcut, onSubmit }: HarnessProps) {
  const [value, setValue] = useState('');
  return (
    <Box flexDirection="column">
      <Text>value:{value}</Text>
      <MultilineInput
        value={value}
        onChange={setValue}
        {...(onFileDrop ? { onFileDrop } : {})}
        {...(keyBindings ? { keyBindings } : {})}
        {...(onShortcut ? { onShortcut } : {})}
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
    await flushEffects();

    ui.stdin.write('r');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('value:r');

    await flushEffects();
    ui.stdin.write(CTRL_U);
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('value:');
    expect(ui.lastFrame() ?? '').not.toContain('value:r');

    await flushEffects();
    ui.stdin.write(CTRL_R);
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('value:');
    expect(ui.lastFrame() ?? '').not.toContain('value:r');
  });

  it('leaves the draft unchanged for a bare C0 control byte (Ctrl+/ on legacy terminals)', async () => {
    const ui = renderFeature(<Harness />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write('ab');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('value:ab');

    await flushEffects();
    ui.stdin.write(CTRL_SLASH_LEGACY);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('value:ab');
    expect(frame).not.toContain(CTRL_SLASH_LEGACY);
  });

  it('swallows unhandled Alt/Meta printable chords without inserting text', async () => {
    const ui = renderFeature(<Harness />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write('ab');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('value:ab');

    await flushEffects();
    ui.stdin.write(ALT_A);
    await flushEffects();

    expect(ui.lastFrame() ?? '').toContain('value:ab');
    expect(ui.lastFrame() ?? '').not.toContain('value:aba');
  });

  it('ignores Home and End so they pass through to the conversation scroll handler', async () => {
    const ui = renderFeature(<Harness />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write('ab');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('value:ab');

    await flushEffects();
    ui.stdin.write('\x1B[H');
    await flushEffects();
    ui.stdin.write('\x1B[F');
    await flushEffects();

    expect(ui.lastFrame() ?? '').toContain('value:ab');
  });
});

describe('MultilineInput file drop', () => {
  it('accepts quoted image paths that contain spaces', async () => {
    let dropped: string | undefined;
    const ui = renderFeature(<Harness onFileDrop={(path) => (dropped = path)} />);
    await flushEffects();

    ui.stdin.write('"/tmp/my photo.png"');
    await flushEffects();

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
    await flushEffects();

    ui.stdin.write('ab');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('value:ab');

    await flushEffects();
    ui.stdin.write(SHIFT_ENTER);
    await flushEffects();
    ui.stdin.write('cd');
    await flushEffects();

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
    await flushEffects();

    ui.stdin.write('ab');
    await flushEffects();

    ui.stdin.write(ENTER);
    await flushEffects();

    expect(submits).toEqual(['ab']);
    expect(ui.lastFrame() ?? '').toContain('value:ab');
  });
});

function SanitizeHarness({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <MultilineInput
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      showCursor={false}
      rows={1}
    />
  );
}

describe('MultilineInput control-byte sanitization', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  it.each(['\x07', '\x01'])(
    'does not echo multi-character control byte %j into the rendered draft',
    async (byte) => {
      let stored = '';
      const ui = renderFeature(<SanitizeHarness onChange={(v) => (stored = v)} />);
      unmount = ui.unmount;
      await flushEffects();

      ui.stdin.write(`a${byte}b`);
      await flushEffects();

      const frame = ui.lastFrame() ?? '';
      expect(stored).toBe(`a${byte}b`);
      expect(frame).toContain('ab');
      expect(frame).not.toContain(byte);
    },
  );
});

const BACKSPACE = '\x7f';
const DELETE = '\x1b[3~';
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
    await flushEffects();

    ui.stdin.write(`a${EMOJI}`);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain(`value:[a${EMOJI}]`);
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(BACKSPACE);
    await vi.waitFor(
      () => {
        // The emoji is gone entirely — no half-surrogate residue.
        expect(ui.lastFrame() ?? '').toContain('value:[a]');
      },
      { timeout: 5000 },
    );
  });

  it('left then right arrow steps over the full emoji code point', async () => {
    const ui = renderFeature(<CursorHarness />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(EMOJI);
    await flushEffects();

    // Left moves to before the emoji; typing inserts ahead of it.
    await flushEffects();
    ui.stdin.write(LEFT);
    await flushEffects();
    ui.stdin.write('x');
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain(`value:[x${EMOJI}]`);
      },
      { timeout: 5000 },
    );

    // Right steps over the whole emoji; typing lands after it.
    await flushEffects();
    ui.stdin.write(RIGHT);
    await flushEffects();
    ui.stdin.write('y');
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain(`value:[x${EMOJI}y]`);
      },
      { timeout: 5000 },
    );
  });

  it('delete removes the next whole emoji instead of backspacing', async () => {
    const ui = renderFeature(<CursorHarness />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(`a${EMOJI}b`);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain(`value:[a${EMOJI}b]`);
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(LEFT);
    await flushEffects();
    ui.stdin.write(LEFT);
    await flushEffects();
    ui.stdin.write(DELETE);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain('value:[ab]');
      },
      { timeout: 5000 },
    );
  });

  it('keeps Ctrl+B, Ctrl+F, and Ctrl+E as composer text editing chords', async () => {
    const ui = renderFeature(<CursorHarness />);
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write('ab');
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain('value:[ab]');
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(CTRL_B);
    await flushEffects();
    ui.stdin.write('X');
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain('value:[aXb]');
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(CTRL_F);
    await flushEffects();
    ui.stdin.write('Y');
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain('value:[aXbY]');
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(CTRL_B);
    await flushEffects();
    ui.stdin.write(CTRL_B);
    await flushEffects();
    ui.stdin.write(CTRL_E);
    await flushEffects();
    ui.stdin.write('!');
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain('value:[aXbY!]');
      },
      { timeout: 5000 },
    );
  });

  it('lets callers override Ctrl+E with an explicit shortcut binding', async () => {
    const shortcut = vi.fn();
    const ui = renderFeature(
      <Harness
        keyBindings={{ shortcut: (input, key) => key.ctrl && input === 'e' }}
        onShortcut={shortcut}
      />,
    );
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write('ab');
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain('value:ab');
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(CTRL_E);
    await flushEffects();
    ui.stdin.write('!');
    await vi.waitFor(
      () => {
        expect(shortcut).toHaveBeenCalledTimes(1);
        expect(ui.lastFrame() ?? '').toContain('value:ab!');
      },
      { timeout: 5000 },
    );
  });
});

// The atom is the input's half of the draft contract: the parent says where the indivisible spans
// are, the input never reads their text. This harness is the parent in miniature — one atom that is
// either whole or gone, never partly edited.
interface AtomModel {
  before: string;
  label: string;
  after: string;
}

const ATOM_LABEL = '[image #1]';
const PASTE_LABEL = '[paste #1 +5 lines]';

function atomValue(model: AtomModel): string {
  return model.before + model.label + model.after;
}

function atomSpans(model: AtomModel): InputAtom[] {
  if (model.label === '') return [];
  return [{ start: model.before.length, end: model.before.length + model.label.length }];
}

function applyAtomEdit(model: AtomModel, edit: InputEdit): AtomModel {
  const value = atomValue(model);
  const start = model.before.length;
  const end = start + model.label.length;
  if (model.label !== '' && edit.start <= start && edit.end >= end) {
    return {
      before: value.slice(0, edit.start) + edit.text + value.slice(edit.end),
      label: '',
      after: '',
    };
  }
  if (edit.end <= start) {
    return {
      ...model,
      before: model.before.slice(0, edit.start) + edit.text + model.before.slice(edit.end),
    };
  }
  return {
    ...model,
    after: model.after.slice(0, edit.start - end) + edit.text + model.after.slice(edit.end - end),
  };
}

function AtomHarness({ initial, columns }: { initial: AtomModel; columns?: number }) {
  const [model, setModel] = useState(initial);
  return (
    <Box flexDirection="column">
      <Text>
        parts:[{model.before}|{model.label}|{model.after}]
      </Text>
      <MultilineInput
        value={atomValue(model)}
        atoms={atomSpans(model)}
        onChange={(_value, edit) => setModel(applyAtomEdit(model, edit))}
        {...(columns === undefined ? {} : { columns })}
        showCursor={true}
        rows={1}
        maxRows={6}
      />
    </Box>
  );
}

describe('MultilineInput image atoms', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  it('steps the caret over the whole label in one press, around emoji and combining marks', async () => {
    const ui = renderFeature(
      <AtomHarness initial={{ before: `e\u0301${EMOJI}`, label: ATOM_LABEL, after: 'x' }} />,
    );
    unmount = ui.unmount;
    await flushEffects();

    // end → before `x` → before the atom → before the emoji → before the combining pair.
    for (let press = 0; press < 4; press += 1) {
      ui.stdin.write(LEFT);
      await flushEffects();
    }
    ui.stdin.write('Z');
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain(`parts:[Ze\u0301${EMOJI}|${ATOM_LABEL}|x]`);
      },
      { timeout: 5000 },
    );
  });

  it('takes the whole atom on backspace instead of leaving a shortened label', async () => {
    const ui = renderFeature(
      <AtomHarness initial={{ before: 'a', label: ATOM_LABEL, after: 'b' }} />,
    );
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(LEFT);
    await flushEffects();
    ui.stdin.write(BACKSPACE);
    await vi.waitFor(
      () => {
        // Not `Image`, not `Image1` minus a digit: the span went whole and the text closed over it.
        expect(ui.lastFrame() ?? '').toContain('parts:[ab||]');
      },
      { timeout: 5000 },
    );
  });

  it('takes the whole atom on a forward delete from the text before it', async () => {
    const ui = renderFeature(
      <AtomHarness initial={{ before: 'a', label: ATOM_LABEL, after: 'b' }} />,
    );
    unmount = ui.unmount;
    await flushEffects();

    for (let press = 0; press < 2; press += 1) {
      ui.stdin.write(LEFT);
      await flushEffects();
    }
    ui.stdin.write(DELETE);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain('parts:[ab||]');
      },
      { timeout: 5000 },
    );
  });

  // A word delete stops at a space, and the collapsed-paste label has spaces in it — so without the
  // atom this key would cut the marker in half and leave `[paste #1 +5` standing as a label.
  it('takes the whole atom when a word delete stops inside its label', async () => {
    const ui = renderFeature(
      <AtomHarness initial={{ before: 'see ', label: PASTE_LABEL, after: '' }} />,
    );
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(CTRL_W);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain('parts:[see ||]');
      },
      { timeout: 5000 },
    );
  });

  it('keeps the label whole when the line wraps around it', async () => {
    const ui = renderFeature(
      <AtomHarness
        initial={{ before: 'hello there ', label: ATOM_LABEL, after: ' and more' }}
        columns={14}
      />,
    );
    unmount = ui.unmount;
    await flushEffects();

    const rows = (ui.lastFrame() ?? '').split('\n');
    expect(rows.some((row) => row.includes(ATOM_LABEL))).toBe(true);
    // No row carries a fragment of the label without carrying all of it.
    for (const row of rows) {
      if (row.includes('parts:')) continue;
      if (!row.includes(ATOM_LABEL)) expect(row).not.toContain('image #');
    }
  });

  // Ctrl+U works on the row the terminal paints, and a hard wrap can fall in the middle of a label.
  // The row start is inside the atom here, so the delete has to grow out to the atom's own edge.
  it('takes the whole atom when a wrap puts the row start inside its label', async () => {
    const ui = renderFeature(
      <AtomHarness initial={{ before: 'helloworld', label: ATOM_LABEL, after: '' }} columns={12} />,
    );
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(CTRL_U);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame() ?? '').toContain('parts:[helloworld||]');
      },
      { timeout: 5000 },
    );
  });
});
