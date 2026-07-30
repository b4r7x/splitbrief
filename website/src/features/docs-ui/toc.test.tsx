import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { createElement, Fragment } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocsToc, DesktopToc, MobileToc, TocScope } from './toc.js';
import type { DocsTocItem } from './toc.js';

const ITEMS = [
  { depth: 2, title: 'Install the CLI', url: '#install-the-cli' },
  { depth: 3, title: 'Link the binary', url: '#link-the-binary' },
] satisfies DocsTocItem[];

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds = [0];

  disconnect(): void {}

  observe(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(): void {}
}

function HeadingDecoration() {
  return createElement('span', null, 'Install');
}

describe('createDocsToc', () => {
  it('keeps h2 and h3 entries as plain JSON-safe text', () => {
    const toc = createDocsToc([
      { depth: 1, title: 'Page title', url: '#page-title' },
      {
        depth: 2,
        title: createElement(Fragment, null, 'Install'),
        url: '#install',
      },
      {
        depth: 3,
        title: createElement(
          Fragment,
          null,
          'Canonical ',
          createElement('code', null, 'tasks.md'),
          ' entry',
        ),
        url: '#canonical-tasksmd-entry',
      },
      { depth: 4, title: 'Internal detail', url: '#internal-detail' },
    ]);

    expect(toc).toEqual([
      { depth: 2, title: 'Install', url: '#install' },
      {
        depth: 3,
        title: 'Canonical tasks.md entry',
        url: '#canonical-tasksmd-entry',
      },
    ]);
    expect(JSON.parse(JSON.stringify(toc))).toEqual(toc);
  });

  it('rejects custom components in included heading titles', () => {
    expect(() =>
      createDocsToc([
        {
          depth: 2,
          title: createElement(HeadingDecoration),
          url: '#install',
        },
      ]),
    ).toThrow('Table of contents title for #install contains non-text content');
  });
});

describe('docs table of contents', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders desktop navigation and a native mobile disclosure from one string-only model', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const user = userEvent.setup();
    const { container } = render(
      <TocScope items={ITEMS}>
        <h2 id="install-the-cli">Install the CLI</h2>
        <h3 id="link-the-binary">Link the binary</h3>
        <DesktopToc items={ITEMS} />
        <MobileToc items={ITEMS} />
      </TocScope>,
    );

    const desktop = screen.getByRole('navigation', { name: 'On this page' });
    const mobile = screen.getByRole('navigation', { name: 'On this page menu' });
    expect(
      within(desktop)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Install the CLI', 'Link the binary']);

    const disclosure = screen.getByText('On this page', { selector: 'summary' });
    expect(disclosure.closest('details')).not.toHaveAttribute('open');
    await user.click(disclosure);
    expect(disclosure.closest('details')).toHaveAttribute('open');

    expect(within(mobile).getByRole('link', { name: 'Link the binary' })).toHaveAttribute(
      'href',
      '#link-the-binary',
    );
    expect(container.querySelector('[data-depth="3"]')).not.toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('keeps the native mobile disclosure inert until React hydrates it', () => {
    const markup = renderToString(
      <TocScope items={ITEMS}>
        <MobileToc items={ITEMS} />
      </TocScope>,
    );

    expect(markup).toContain('<details class="docs-toc docs-toc--mobile" inert="">');
  });

  it('omits both table-of-contents surfaces when a page has no h2 or h3', () => {
    render(
      <TocScope items={[]}>
        <DesktopToc items={[]} />
        <MobileToc items={[]} />
      </TocScope>,
    );

    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'On this page menu' })).toBeNull();
    expect(screen.queryByText('On this page')).toBeNull();
  });
});
