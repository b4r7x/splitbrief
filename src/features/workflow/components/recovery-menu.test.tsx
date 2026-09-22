import { expect, it, vi } from 'vitest';
import { renderFeature, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { RecoveryMenu } from './recovery-menu.js';

function mount(onResolve: (answer: string) => void, width = 80) {
  return renderFeature(
    <RecoveryMenu
      issue={makeRecoveryIssue()}
      width={width}
      clampedBoxRows={14}
      focused
      onFocusChange={() => {}}
      onResolve={onResolve}
    />,
  );
}

it('a letter key acts as the offered row it names', async () => {
  const onResolve = vi.fn();
  const ui = mount(onResolve);
  await flushEffects();
  ui.stdin.write('s');
  await flushEffects();
  expect(onResolve).toHaveBeenCalledExactlyOnceWith('s');
  ui.unmount();
});

it('a letter that names no offered row does nothing', async () => {
  const onResolve = vi.fn();
  const ui = mount(onResolve);
  await flushEffects();
  ui.stdin.write('x');
  await flushEffects();
  expect(onResolve).not.toHaveBeenCalled();
  expect(stripAnsiStyles(ui.lastFrame())).toContain('letter key acts');
  ui.unmount();
});

it('drops a legend clause whole rather than cutting the last key in half', async () => {
  const ui = mount(vi.fn(), 60);
  await flushEffects();
  const frame = stripAnsiStyles(ui.lastFrame());
  expect(frame).toContain('tab type a reply');
  expect(frame).not.toContain('letter key acts');
  ui.unmount();
});
