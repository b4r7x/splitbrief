import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BorderedFrame } from './bordered-frame.js';
import { JackBullet } from './jack-bullet.js';
import { PanelStrip } from './panel-strip.js';

describe('design primitives', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names a panel strip as a section with a heading', () => {
    render(
      <PanelStrip legend="Signal path">
        <p>The brief connects both roles.</p>
      </PanelStrip>,
    );

    const panel = screen.getByRole('region', { name: 'Signal path' });
    expect(within(panel).getByRole('heading', { level: 2, name: 'Signal path' })).toBeVisible();
    expect(within(panel).getByText('The brief connects both roles.')).toBeVisible();
  });

  it('labels framed output and preserves usable actions', async () => {
    const onCopy = vi.fn();
    const user = userEvent.setup();

    render(
      <BorderedFrame
        label="Generated config"
        actions={
          <button type="button" onClick={onCopy}>
            Copy
          </button>
        }
      >
        <pre>version: 3</pre>
      </BorderedFrame>,
    );

    const frame = screen.getByRole('figure', { name: 'Generated config' });
    await user.click(within(frame).getByRole('button', { name: 'Copy' }));

    expect(onCopy).toHaveBeenCalledOnce();
    expect(within(frame).getByText('version: 3')).toBeVisible();
  });

  it('keeps jack shapes decorative beside their text labels', () => {
    render(
      <ul>
        <li>
          <JackBullet variant="planner" />
          <span>Planner</span>
        </li>
        <li>
          <JackBullet variant="implementer" />
          <span>Implementer</span>
        </li>
        <li>
          <JackBullet variant="neutral" />
          <span>Reference</span>
        </li>
      </ul>,
    );

    expect(screen.getByText('Planner').previousElementSibling).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(screen.getByText('Implementer').previousElementSibling).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(screen.getByText('Reference').previousElementSibling).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('passes an automated accessibility scan in both theme tiers', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const { container, rerender } = render(
      <main className="landing-shell" data-theme="dark">
        <PanelStrip legend="Planner output" tone="planner">
          <BorderedFrame label="Task Brief" actions={<button type="button">Copy</button>}>
            <p>Reviewable implementation instructions.</p>
          </BorderedFrame>
        </PanelStrip>
      </main>,
    );

    const darkResults = await axe.run(container);
    expect(darkResults.violations).toEqual([]);

    rerender(
      <main className="docs-shell" data-theme="light">
        <PanelStrip legend="Implementer output" tone="implementer">
          <BorderedFrame label="Validation result">
            <p>All requested checks passed.</p>
          </BorderedFrame>
        </PanelStrip>
      </main>,
    );

    const lightResults = await axe.run(container);
    expect(lightResults.violations).toEqual([]);
  });
});
