import { Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { useRecentSessionsFocus } from './use-recent-sessions-focus.js';

const CTRL_R = '\x12';
const ARROW_UP = '\u001b[A';
const ARROW_DOWN = '\u001b[B';
const ENTER = '\r';

function Host({
  hasSessions,
  hasOverlay,
  focused,
  onEnter,
}: {
  hasSessions: boolean;
  hasOverlay: boolean;
  focused: boolean;
  onEnter: () => void;
}) {
  useRecentSessionsFocus({ hasSessions, hasOverlay, focused, onEnter });
  return <Text> </Text>;
}

describe('useRecentSessionsFocus', () => {
  let unmount: (() => void) | undefined;

  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  it('fires onEnter on Ctrl+R when there are sessions, no overlay, and the composer is not focused', async () => {
    let fired = 0;
    const ui = renderFeature(
      <Host
        hasSessions={true}
        hasOverlay={false}
        focused={false}
        onEnter={() => {
          fired += 1;
        }}
      />,
    );
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await tick(20);

    expect(fired).toBe(1);
  });

  it.each([
    ['the composer is already focused', { focused: true }],
    ['an overlay is open', { hasOverlay: true }],
    ['there are no sessions', { hasSessions: false }],
  ])('does not fire when %s', async (_name, overrides) => {
    let fired = 0;
    const ui = renderFeature(
      <Host
        hasSessions={true}
        hasOverlay={false}
        focused={false}
        onEnter={() => {
          fired += 1;
        }}
        {...overrides}
      />,
    );
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(CTRL_R);
    await tick(20);

    expect(fired).toBe(0);
  });

  it('ignores arrow keys, Enter, and typed characters even when active', async () => {
    let fired = 0;
    const ui = renderFeature(
      <Host
        hasSessions={true}
        hasOverlay={false}
        focused={false}
        onEnter={() => {
          fired += 1;
        }}
      />,
    );
    unmount = ui.unmount;
    await flushEffects();

    ui.stdin.write(ARROW_UP);
    await flushEffects();
    ui.stdin.write(ARROW_DOWN);
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    ui.stdin.write('x');
    await tick(20);

    expect(fired).toBe(0);
  });
});
