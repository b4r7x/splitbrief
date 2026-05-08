import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { tick } from '#testing/helpers/ink.js';
import { findReferenceToken, useReferenceCompletion } from './hook.js';

const DOWN = '\u001B[B';
const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';

const FILES = [
  'src/app.ts',
  'src/components/composer/composer.tsx',
  'docs/README.md',
];

interface HarnessProps {
  initialValue: string;
  disabled?: boolean;
  setValueSpy?: { current: ((value: string) => void) | null };
}

function Harness({ initialValue, disabled, setValueSpy }: HarnessProps) {
  const [value, setValue] = React.useState(initialValue);
  if (setValueSpy) setValueSpy.current = setValue;
  const result = useReferenceCompletion({
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

describe('findReferenceToken', () => {
  it('detects @ at the start of input', () => {
    expect(findReferenceToken('@src')).toEqual({ start: 0, query: 'src' });
  });

  it('detects @ after a space', () => {
    expect(findReferenceToken('add auth @src')).toEqual({ start: 9, query: 'src' });
  });

  it('detects @ at the start of a new line', () => {
    expect(findReferenceToken('first line\n@docs')).toEqual({ start: 11, query: 'docs' });
  });

  it('ignores @ in the middle of a word', () => {
    expect(findReferenceToken('user@example.com')).toBeNull();
  });

  it('returns null when a later word has no @ token', () => {
    expect(findReferenceToken('@src later')).toBeNull();
  });
});

describe('useReferenceCompletion', () => {
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
    expect(instance.lastFrame() ?? '').toContain('selected=src/components/composer/composer.tsx');

    instance.stdin.write(ENTER);
    await tick(1); await tick(1);

    expect(instance.lastFrame() ?? '').toContain('value=@src/components/composer/composer.tsx');
    instance.unmount();
  });

  it('resets the highlighted file when the @ query changes', async () => {
    const setValueSpy: HarnessProps['setValueSpy'] = { current: null };
    const instance = render(<Harness initialValue="@" setValueSpy={setValueSpy} />);
    await tick(1); await tick(1);

    instance.stdin.write(DOWN);
    await tick(1); await tick(1);
    expect(instance.lastFrame() ?? '').toContain('selected=src/components/composer/composer.tsx');

    setValueSpy.current?.('@docs');
    await tick(1); await tick(1);
    expect(instance.lastFrame() ?? '').toContain('selected=docs/README.md');

    instance.stdin.write(ENTER);
    await tick(1); await tick(1);
    expect(instance.lastFrame() ?? '').toContain('value=@docs/README.md');
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
