import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { routerStore } from '../../../stores/navigation/router.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { Header } from './header.js';

const STARTED_AT = new Date(0).toISOString();

beforeEach(() => {
  routerStore.reset();
  terminalSizeStore.reset();
  lifecycleStore.reset();
});

afterEach(() => {
  routerStore.reset();
  terminalSizeStore.reset();
  lifecycleStore.reset();
});

async function tick(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('Header — worktree indicator', () => {
  it('renders feature name without bracket prefix when worktreeName is absent', async () => {
    routerStore.init({ screen: 'workflow', feature: 'add login form' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('add login form');
    expect(frame).not.toContain('[');
    instance.unmount();
  });

  it('renders [my-feature] prefix before feature name when worktreeName is present', async () => {
    routerStore.init({ screen: 'workflow', feature: 'implement X', worktreeName: 'my-feature' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('[my-feature]');
    expect(frame).toContain('implement X');
    instance.unmount();
  });

  it('truncates feature name when combined label exceeds featureWidth, preserving prefix', async () => {
    // Use a narrow terminal so featureWidth is small
    terminalSizeStore.__testReset({ cols: 40, rows: 24, isSmall: true });

    const longFeature = 'a'.repeat(60);
    routerStore.init({ screen: 'workflow', feature: longFeature, worktreeName: 'wt' });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = instance.lastFrame() ?? '';

    // Prefix is present
    expect(frame).toContain('[wt]');
    // Feature is truncated (full string of 60 chars not in frame)
    expect(frame).not.toContain(longFeature);
    instance.unmount();
  });

  it('renders no worktree label when detectWorktree returns null (worktreeName undefined)', async () => {
    // null from detectWorktree becomes undefined via `?? undefined` in start.ts
    routerStore.init({ screen: 'workflow', feature: 'fix bug', worktreeName: undefined });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('fix bug');
    expect(frame).not.toContain('[');
    instance.unmount();
  });
});
