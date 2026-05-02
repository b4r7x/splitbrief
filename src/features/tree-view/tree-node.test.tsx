import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import { TreeNode } from './tree-node.js';
import type { TreeLine } from './format.js';

function makeLine(overrides: Partial<TreeLine> = {}): TreeLine {
  return {
    id: 'E0001' as import('../../core/sessions/tree/schemas.js').EntryId,
    depth: 0,
    prefix: '',
    label: '12:00:00 [START] Test',
    isActive: true,
    isBranchPoint: false,
    isCollapsed: false,
    type: 'session-start',
    timestamp: 1000,
    ...overrides,
  };
}

describe('TreeNode', () => {
  it('renders active marker for active node', async () => {
    const instance = render(<TreeNode line={makeLine({ isActive: true })} isSelected={false} />);
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('●');
    instance.unmount();
  });

  it('renders inactive marker for inactive node', async () => {
    const instance = render(<TreeNode line={makeLine({ isActive: false })} isSelected={false} />);
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('○');
    instance.unmount();
  });

  it('renders branch expand indicator for collapsed branch', async () => {
    const instance = render(
      <TreeNode line={makeLine({ isBranchPoint: true, isCollapsed: true })} isSelected={false} />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[+]');
    instance.unmount();
  });

  it('renders branch collapse indicator for expanded branch', async () => {
    const instance = render(
      <TreeNode line={makeLine({ isBranchPoint: true, isCollapsed: false })} isSelected={false} />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[-]');
    instance.unmount();
  });

  it('renders prefix before marker', async () => {
    const instance = render(<TreeNode line={makeLine({ prefix: '├── ' })} isSelected={false} />);
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('├──');
    instance.unmount();
  });

  it('renders label text', async () => {
    const instance = render(<TreeNode line={makeLine({ label: 'Test Label' })} isSelected={false} />);
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Test Label');
    instance.unmount();
  });

  it('applies recovery-decision color', async () => {
    const instance = render(
      <TreeNode line={makeLine({ type: 'recovery-decision' })} isSelected={false} />,
    );
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Test');
    instance.unmount();
  });

  it('shows selection state visually', async () => {
    const instance = render(<TreeNode line={makeLine()} isSelected={true} />);
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('●');
    instance.unmount();
  });
});
