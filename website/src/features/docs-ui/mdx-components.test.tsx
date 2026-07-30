import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Callout, mdxComponents } from './mdx-components.js';

const INITIAL_CLIPBOARD_DESCRIPTOR = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

describe('docs MDX components', () => {
  afterEach(() => {
    if (INITIAL_CLIPBOARD_DESCRIPTOR) {
      Object.defineProperty(navigator, 'clipboard', INITIAL_CLIPBOARD_DESCRIPTOR);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    vi.restoreAllMocks();
  });

  it('renders focusable hash links, underlined links, callouts, and scrollable tables', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const H2 = mdxComponents.h2;
    const H3 = mdxComponents.h3;
    const Link = mdxComponents.a;
    const Table = mdxComponents.table;
    const { container } = render(
      <main className="docs-shell" data-theme="dark">
        <article>
          <H2 id="install">Install</H2>
          <p>
            Read the <Link href="/docs/reference/cli">CLI reference</Link>.
          </p>
          <H3 id="link">Link the binary</H3>
          <Callout title="Platform support">
            <p>macOS and Linux are supported.</p>
          </Callout>
          <Table>
            <tbody>
              <tr>
                <th scope="row">Node</th>
                <td>22.12+</td>
              </tr>
            </tbody>
          </Table>
          <Table>
            <tbody>
              <tr>
                <th scope="row">Bun</th>
                <td>Optional</td>
              </tr>
            </tbody>
          </Table>
        </article>
      </main>,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Install' })).toContainElement(
      screen.getByRole('link', { name: 'Install' }),
    );
    expect(screen.getByRole('link', { name: 'Install' })).toHaveAttribute('href', '#install');
    expect(screen.getByRole('heading', { level: 3, name: 'Link the binary' })).toContainElement(
      screen.getByRole('link', { name: 'Link the binary' }),
    );
    expect(screen.getByRole('link', { name: 'CLI reference' })).toHaveClass('docs-link');
    expect(screen.getByRole('complementary', { name: 'Platform support' })).toBeVisible();
    expect(screen.getAllByRole('group', { name: 'Scrollable data table' })).toHaveLength(2);
    for (const tableScroll of screen.getAllByRole('group', { name: 'Scrollable data table' })) {
      expect(tableScroll).toHaveAttribute('tabindex', '0');
    }
    expect(screen.getAllByRole('table')).toHaveLength(2);
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('copies the rendered semantic code text and reports clipboard failure on the action', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const Pre = mdxComponents.pre;
    render(
      <Pre icon="<svg>compiler metadata</svg>">
        <code>const mode = 'standard';</code>
      </Pre>,
    );

    const frame = screen.getByRole('figure', { name: 'Code' });
    expect(within(frame).getByText("const mode = 'standard';")).toBeVisible();
    const pre = within(frame).getByText("const mode = 'standard';").closest('pre');
    expect(pre).not.toBeNull();
    expect(pre).not.toHaveAttribute('icon');

    await user.click(within(frame).getByRole('button', { name: 'Copy code' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("const mode = 'standard';");
      expect(within(frame).getByRole('button', { name: 'Code copied' })).toBeVisible();
    });

    writeText.mockRejectedValue(new Error('Clipboard permission denied'));
    await user.click(screen.getByRole('button', { name: 'Code copied' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy failed; retry' })).toBeVisible();
    });
  });
});
