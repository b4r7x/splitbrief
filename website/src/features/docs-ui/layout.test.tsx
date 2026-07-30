import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsShell } from './layout.js';
import type { DocsNavGroup } from './navigation.js';
import { DocsSidebar } from './sidebar.js';

const GROUPS = [
  {
    label: 'Getting started',
    pages: [
      {
        href: '/docs/getting-started/introduction',
        role: 'neutral',
        title: 'Introduction',
      },
      {
        href: '/docs/getting-started/choosing-models',
        role: 'implementer',
        title: 'Choosing models',
      },
    ],
  },
  {
    label: 'Concepts',
    pages: [
      {
        href: '/docs/concepts/task-briefs',
        role: 'planner',
        title: 'Task Briefs',
      },
    ],
  },
] satisfies readonly DocsNavGroup[];

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

function renderShell(theme: 'dark' | 'light' = 'dark') {
  return render(
    <div data-theme={theme}>
      <DocsShell
        currentPath="/docs/concepts/task-briefs"
        description="The contract between the configured roles."
        groups={GROUPS}
        next={{ href: '/docs/concepts/workflow-modes-and-phases', title: 'Workflow modes' }}
        previous={{ href: '/docs/getting-started/choosing-models', title: 'Choosing models' }}
        title="Task Briefs"
        toc={[{ depth: 2, title: 'Identity', url: '#identity' }]}
      >
        <h2 id="identity">Identity</h2>
        <p>A brief identifies one bounded implementation task.</p>
      </DocsShell>
    </div>,
  );
}

describe('DocsShell', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the shared documentation tree with current-page and role semantics', () => {
    renderShell();

    const navigations = screen.getAllByRole('navigation', { name: 'Documentation' });
    const navigation = navigations.at(0);
    if (!navigation) {
      throw new Error('Desktop documentation navigation did not render');
    }

    expect(navigations).toHaveLength(2);
    expect(within(navigation).getAllByRole('link')).toHaveLength(3);
    expect(within(navigation).getByRole('link', { name: 'Task Briefs' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(navigation).getByRole('link', { name: 'Introduction' })).not.toHaveAttribute(
      'aria-current',
    );

    expect(within(navigation).getByText('Task Briefs').previousElementSibling).toHaveClass(
      'jack-bullet--planner',
    );
    expect(within(navigation).getByText('Choosing models').previousElementSibling).toHaveClass(
      'jack-bullet--implementer',
    );
    expect(within(navigation).getByText('Introduction').previousElementSibling).toHaveClass(
      'jack-bullet--neutral',
    );
  });

  it('uses one native index disclosure and keeps it keyboard operable', async () => {
    const user = userEvent.setup();
    renderShell();

    const disclosureLabel = screen.getByText('INDEX');
    const disclosure = disclosureLabel.closest('summary');
    const details = disclosureLabel.closest('details');

    expect(disclosure).toBeVisible();
    expect(details).not.toHaveAttribute('open');
    await user.click(disclosureLabel);
    expect(details).toHaveAttribute('open');
  });

  it('keeps the native mobile index inert until React hydrates it', () => {
    const markup = renderToString(
      <DocsSidebar currentPath="/docs/concepts/task-briefs" groups={GROUPS} />,
    );

    expect(markup).toContain('<details class="docs-index docs-index--mobile" inert="">');
  });

  it('provides landmarks, skip navigation, toc, and adjacent-page links', () => {
    renderShell();

    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#docs-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'docs-content');
    expect(screen.getByRole('heading', { level: 1, name: 'Task Briefs' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'On this page' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'On this page menu' })).toBeInTheDocument();

    const adjacent = screen.getByRole('navigation', { name: 'Adjacent documentation' });
    expect(within(adjacent).getByRole('link', { name: /Choosing models/ })).toHaveAttribute(
      'href',
      '/docs/getting-started/choosing-models',
    );
    expect(within(adjacent).getByRole('link', { name: /Workflow modes/ })).toHaveAttribute(
      'href',
      '/docs/concepts/workflow-modes-and-phases',
    );
  });

  it('encodes the three responsive layouts and minimum target sizes', () => {
    const css = ['layout.css', 'docs-header.css', 'sidebar.css', 'prev-next.css']
      .map((file) => readFileSync(resolve(process.cwd(), 'src/features/docs-ui', file), 'utf8'))
      .join('\n');

    expect(css).toContain('@media (min-width: 1200px)');
    expect(css).toContain(
      'grid-template-columns: minmax(13rem, 15rem) minmax(0, var(--text-measure)) minmax(',
    );
    expect(css).toContain('@media (max-width: 699px)');
    expect(css).toContain('@media (max-width: 479px)');
    expect(css).toContain(
      '.docs-header__actions {\n    display: grid;\n    grid-template-columns: minmax(0, 1fr) auto;',
    );
    expect(css).toContain('.docs-search__trigger {\n    inline-size: 100%;');
    expect(css).toContain('.docs-index--mobile {\n  display: none;');
    expect(css).toContain('.docs-index--desktop {\n    display: none;');
    expect(css).toContain('max-inline-size: var(--text-measure)');
    expect(css.match(/min-block-size: 2\.75rem/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it.each(['dark', 'light'] as const)(
    'passes an automated accessibility scan in %s',
    async (theme) => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
      const { container } = renderShell(theme);

      const results = await axe.run(container);
      expect(results.violations).toEqual([]);
    },
  );
});
