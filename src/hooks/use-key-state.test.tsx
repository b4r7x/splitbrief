import { describe, expect, it, vi } from 'vitest';
import { Text, useInput } from 'ink';
import { useKeyState } from './use-key-state.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';

const DOWN = '\u001b[B';
const ENTER = '\r';

function Harness({ onEnter }: { onEnter: (value: number) => void }) {
  const [value, setValue, latest] = useKeyState(0);
  useInput((_input, key) => {
    if (key.downArrow) setValue(latest() + 1);
    if (key.return) onEnter(latest());
  });
  return <Text>{`value:${value}`}</Text>;
}

describe('useKeyState', () => {
  it('reads the value that ↓ set when ↓↓⏎ arrive in one stdin read', async () => {
    const entered: number[] = [];
    const ui = renderFeature(<Harness onEnter={(value) => entered.push(value)} />);
    await flushEffects();

    ui.stdin.write(`${DOWN}${DOWN}${ENTER}`);

    await vi.waitFor(() => {
      expect(entered).toEqual([2]);
      expect(ui.lastFrame()).toContain('value:2');
    });
    ui.unmount();
  });
});
