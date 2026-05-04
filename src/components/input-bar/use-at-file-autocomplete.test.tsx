import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { tick } from '#testing/helpers/ink.js';
import { findAtToken, useAtFileAutocomplete } from './use-at-file-autocomplete.js';

const DOWN = '[B';
const ENTER = '\r';
const ESC = '';
const TAB = '\t';

const FILES = [
  'src/app.ts',
  'src/components/input-bar/input-bar.tsx',
  'docs/README.md',
];

interface HarnessProps {
  initialValue: string;
  disabled?: boolean;
}

function Harness({ initialValue, disabled }: HarnessProps) {
  const [value, setValue] = React.useState(initialValue);
  const result = useAtFileAutocomplete({
    files: FILES,
    value,
    setValue,
    disabled,
  });
  return (
    <Text>
      value={value}|show={String(result.showSuggestions)}|selected={result.filtered[result.selectedIndex] ?? ''}
    </Text>
  );
}

describe('findAtToken', () => {
  it('detects @ at the start of input', () => {
    expect(findAtToken('@src')).toEqual({ start: 0, query: 'src' });
  });

  it('detects @ after a space', () => {
    expect(findAtToken('add auth @src')).toEqual({ start: 9, query: 'src' });
  });

  it('detects @ at the start of a new line', () => {
    expect(findAtToken('first line\n@docs')).toEqual({ start: 11, query: 'docs' });
  });

  it('ignores @ in the middle of a word', () => {
    expect(findAtToken('user@example.com')).toBeNull();
  });

  it('returns null when a later word has no @ token', () => {
    expect(findAtToken('@src later')).toBeNull();
  });
});

describe('useAtFileAutocomplete', () => {
  it('fills the selected file path with Tab', async () => {
    const instance = render(<Harness initialValue="review @src/app" />);
    await tick(1); await tick(1);

    expect(instance.lastFrame() ?? '').toContain('show=true');

    instance.stdin.write(TAB);
    await tick(1); await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('value=review @src/app.ts');
    expect(frame).toContain('show=false');
    instance.unmount();
  });

  it('arrow keys change which file Enter accepts', async () => {
    const instance = render(<Harness initialValue="@src" />);
    await tick(1); await tick(1);

    instance.stdin.write(DOWN);
    await tick(1); await tick(1);
    expect(instance.lastFrame() ?? '').toContain('selected=src/components/input-bar/input-bar.tsx');

    instance.stdin.write(ENTER);
    await tick(1); await tick(1);

    expect(instance.lastFrame() ?? '').toContain('value=@src/components/input-bar/input-bar.tsx');
    instance.unmount();
  });

  it('Escape dismisses suggestions without clearing the input', async () => {
    const instance = render(<Harness initialValue="@src" />);
    await tick(1); await tick(1);

    instance.stdin.write(ESC);
    await tick(1); await tick(1);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('value=@src');
    expect(frame).toContain('show=false');
    instance.unmount();
  });

  it('ignores keyboard input when disabled', async () => {
    const instance = render(<Harness initialValue="@src" disabled />);
    await tick(1); await tick(1);

    const before = instance.lastFrame() ?? '';
    expect(before).toContain('selected=src/app.ts');

    instance.stdin.write(DOWN);
    await tick(1); await tick(1);
    instance.stdin.write(TAB);
    await tick(1); await tick(1);

    const after = instance.lastFrame() ?? '';
    expect(after).toContain('value=@src');
    expect(after).toContain('selected=src/app.ts');
    instance.unmount();
  });
});
