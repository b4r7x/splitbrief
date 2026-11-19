import { useEffect } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { SettingDef } from '../../../core/settings/catalog.js';
import { useEditBuffer } from './use-edit-buffer.js';

interface CommittedEdit {
  id: string;
  value: unknown;
}

function Harness({
  def,
  initialValue,
  committed,
}: {
  def: SettingDef;
  initialValue: string;
  committed: CommittedEdit[];
}) {
  const { editingId, editBuffer, isEditing, startEditing } = useEditBuffer({
    onCommit: (d, value) => committed.push({ id: d.id, value }),
  });

  useEffect(() => {
    startEditing(def.id, initialValue);
  }, []);

  return <Text>{`editing=${editingId ?? ''} active=${isEditing} buffer=[${editBuffer}]`}</Text>;
}

const numberDef: SettingDef = {
  id: 'implementer.contextLength',
  label: 'Context length',
  section: 'Tuning',
  description: '',
  kind: 'number',
  min: 1024,
  integer: true,
};

const stringDef: SettingDef = {
  id: 'validation.testCommand',
  label: 'Test Command',
  section: 'Validation',
  description: '',
  kind: 'string',
};

describe('useEditBuffer commit', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('commits an unset Context length when the user clears the number', async () => {
    const committed: CommittedEdit[] = [];
    const ui = renderFeature(<Harness def={numberDef} initialValue="3" committed={committed} />);
    await flushEffects();

    for (let i = 0; i < '3'.length; i++) ui.stdin.write('\x7f');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(committed).toEqual([{ id: numberDef.id, value: undefined }]);
    expect(ui.lastFrame()).toContain('active=false');

    ui.unmount();
  });

  it('commits an unset Test command when the user submits only whitespace', async () => {
    const committed: CommittedEdit[] = [];
    const ui = renderFeature(
      <Harness def={stringDef} initialValue="npm test" committed={committed} />,
    );
    await flushEffects();

    for (let i = 0; i < 'npm test'.length; i++) ui.stdin.write('\x7f'); // clear buffer
    await flushEffects();
    ui.stdin.write(' '); // whitespace-only buffer
    await flushEffects();
    ui.stdin.write('\r'); // attempt commit
    await flushEffects();

    expect(committed).toEqual([{ id: stringDef.id, value: undefined }]);
    expect(ui.lastFrame()).toContain('active=false');

    ui.unmount();
  });

  it('backspace removes a whole emoji from the buffer, not a lone surrogate', async () => {
    const committed: CommittedEdit[] = [];
    const ui = renderFeature(<Harness def={stringDef} initialValue="hi" committed={committed} />);
    await flushEffects();

    ui.stdin.write('😀');
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('buffer=[hi😀]');

    await flushEffects();
    ui.stdin.write('\x7f'); // backspace the emoji
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('buffer=[hi]');
    expect(frame).not.toContain('\ud83d');
    expect(frame).not.toContain('\ude00');

    ui.unmount();
  });
});
