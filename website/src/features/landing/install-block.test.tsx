/// <reference types="@chialab/vitest-axe/matchers" />

import matchers from '@chialab/vitest-axe';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { run as axe } from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallBlock } from './install-block.js';

expect.extend(matchers);

const EXPECTED_COMMANDS = `git clone https://github.com/b4r7x/splitbrief.git
cd splitbrief
npm install
npm run build
npm link`;

describe('InstallBlock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders one complete source install artifact with honest requirements and references', () => {
    render(<InstallBlock />);

    const frame = screen.getByRole('figure', { name: 'from source — not yet on npm' });

    expect(frame.querySelector('code')?.textContent).toBe(EXPECTED_COMMANDS);
    expect(within(frame).getByText('Node 22+')).toBeVisible();
    expect(within(frame).getByText('macOS / Linux')).toBeVisible();
    expect(within(frame).getByRole('link', { name: '[ Documentation ]' })).toHaveAttribute(
      'href',
      '/docs/getting-started/introduction',
    );
    expect(within(frame).getByRole('link', { name: '[ GitHub ]' })).toHaveAttribute(
      'href',
      'https://github.com/b4r7x/splitbrief',
    );
    expect(within(frame).getByRole('link', { name: '[ MIT License ]' })).toHaveAttribute(
      'href',
      'https://github.com/b4r7x/splitbrief/blob/main/LICENSE',
    );
  });

  it('copies the exact five commands and announces success', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

    render(<InstallBlock />);

    await user.click(screen.getByRole('button', { name: 'Copy install commands' }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(EXPECTED_COMMANDS);
    expect(screen.getByRole('status')).toHaveTextContent('Install commands copied.');
  });

  it('keeps a manual recovery action visible when clipboard access fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new DOMException('Clipboard access denied', 'NotAllowedError'),
    );

    render(<InstallBlock />);

    await user.click(screen.getByRole('button', { name: 'Copy install commands' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'Copy failed. Select the commands and copy them manually.',
    );
  });

  it('has no automated accessibility violations', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const { container } = render(<InstallBlock />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
