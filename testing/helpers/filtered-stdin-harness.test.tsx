import { Text, useInput, useStdout } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getActiveFilteredStdin,
  setActiveFilteredStdin,
} from '../../src/lib/terminal/filtered-stdin/active.js';
import type { FilteredStdin } from '../../src/lib/terminal/filtered-stdin/types.js';
import {
  renderThroughFilteredStdin,
  type FilteredStdinViewport,
} from './filtered-stdin-harness.js';

const VIEWPORTS: readonly FilteredStdinViewport[] = [
  { cols: 120, rows: 40 },
  { cols: 80, rows: 24 },
  { cols: 60, rows: 18 },
];

afterEach(() => {
  setActiveFilteredStdin(undefined);
});

describe('filtered stdin render harness lifecycle', () => {
  it.each(VIEWPORTS)('captures at $cols x $rows without retaining state', (viewport) => {
    const stdoutWriteBefore = process.stdout.write;
    expect(getActiveFilteredStdin()).toBeUndefined();

    const harness = renderThroughFilteredStdin(<ViewportProbe />, viewport);
    expect(getActiveFilteredStdin()).toBe(harness.filtered);
    expect(harness.lastFrame()).toContain(`${viewport.cols}x${viewport.rows}`);

    harness.unmount();
    harness.unmount();
    expect(getActiveFilteredStdin()).toBeUndefined();
    expect(process.stdout.write).toBe(stdoutWriteBefore);
  });

  it('restores the exact stdout writer and prior active filter when render setup throws', () => {
    const stdoutWriteBefore = process.stdout.write;
    const priorActive = createSentinelFilteredStdin();
    setActiveFilteredStdin(priorActive);

    expect(() =>
      renderThroughFilteredStdin(<ViewportProbe />, VIEWPORTS[1], {
        render: () => {
          throw new Error('forced render setup failure');
        },
      }),
    ).toThrow('forced render setup failure');
    expect(process.stdout.write).toBe(stdoutWriteBefore);
    expect(getActiveFilteredStdin()).toBe(priorActive);
  });
});

describe('filtered stdin render harness terminal', () => {
  it.each([
    { terminal: 'answers that it brackets a paste', dependencies: {}, keys: ['ok', '⏎'] },
    { terminal: 'gives no answer', dependencies: { terminalAnswers: false }, keys: ['ok\r'] },
  ])(
    'gives text and Enter of one read to the app as a terminal that $terminal does',
    async ({ dependencies, keys }) => {
      const seen: string[] = [];
      const harness = renderThroughFilteredStdin(
        <KeyProbe seen={seen} />,
        VIEWPORTS[1],
        dependencies,
      );
      try {
        await harness.settled();
        harness.pressBytes('ok\r');
        await harness.settled();
        expect(seen).toEqual(keys);
      } finally {
        harness.unmount();
      }
    },
  );
});

function KeyProbe({ seen }: { seen: string[] }) {
  useInput((input, key) => {
    seen.push(key.return ? '⏎' : input);
  });
  return <Text>keys</Text>;
}

function ViewportProbe() {
  const { stdout } = useStdout();
  return <Text>{`${stdout.columns}x${stdout.rows}`}</Text>;
}

function createSentinelFilteredStdin(): FilteredStdin {
  return {
    stdin: process.stdin,
    activate: () => {},
    onMouse: () => () => {},
    isPasteActive: () => false,
    holdInput: () => () => {},
    disable: () => {},
  };
}
