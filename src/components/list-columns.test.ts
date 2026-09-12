import { describe, expect, it } from 'vitest';
import type { RuntimeCommandDef } from '../core/runtime/commands/types.js';
import { commandLabelWidth, descriptionColumn } from './list-columns.js';

function makeCommand(name: string): RuntimeCommandDef {
  return {
    kind: 'noarg',
    name,
    description: 'Crew, validation, workflow',
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  };
}

describe('descriptionColumn', () => {
  const row = { description: 'Workflow mode', shortcut: null, labelWidth: 10 };

  it('prints the grammar hint beside the description when both fit whole', () => {
    expect(descriptionColumn({ ...row, hint: '[quick|standard]', innerWidth: 60 }).trimEnd()).toBe(
      'Workflow mode  [quick|standard]',
    );
  });

  it('drops the whole hint rather than cut it, leaving the description alone', () => {
    const column = descriptionColumn({ ...row, hint: '[quick|standard]', innerWidth: 30 });

    expect(column.trimEnd()).toBe('Workflow mode');
    expect(column).not.toContain('[');
  });

  it('pads to the same field with or without a hint', () => {
    const withHint = descriptionColumn({ ...row, hint: '[quick|standard]', innerWidth: 60 });
    const without = descriptionColumn({ ...row, hint: null, innerWidth: 60 });

    expect(withHint).toHaveLength(without.length);
  });
});

describe('commandLabelWidth', () => {
  it('measures the widest command name in the registry', () => {
    const commands = [makeCommand('/help'), makeCommand('/revise-spec'), makeCommand('/crew')];
    expect(commandLabelWidth(commands)).toBe('/revise-spec'.length);
  });

  it('is zero for an empty command list', () => {
    expect(commandLabelWidth([])).toBe(0);
  });
});
