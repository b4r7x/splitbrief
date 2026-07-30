import type { ReactNode } from 'react';
import { DocsHeader } from './docs-header.js';
import type { DocsNavGroup, DocsNeighbour } from './navigation.js';
import { DocsPrevNext } from './prev-next.js';
import { DocsSidebar } from './sidebar.js';
import { DesktopToc, MobileToc, TocScope, type DocsTocItem } from './toc.js';
import './layout.css';

export type DocsShellProps = {
  readonly children: ReactNode;
  readonly currentPath: string;
  readonly description?: string;
  readonly groups: readonly DocsNavGroup[];
  readonly next?: DocsNeighbour;
  readonly previous?: DocsNeighbour;
  readonly title: string;
  readonly toc: readonly DocsTocItem[];
};

export function DocsShell({
  children,
  currentPath,
  description,
  groups,
  next,
  previous,
  title,
  toc,
}: DocsShellProps) {
  return (
    <div className="docs-shell">
      <a className="docs-skip-link" href="#docs-content">
        Skip to content
      </a>
      <DocsHeader />

      <div className="docs-layout">
        <DocsSidebar currentPath={currentPath} groups={groups} />

        <main className="docs-main" id="docs-content" tabIndex={-1}>
          <TocScope items={toc}>
            <header className="docs-page-header">
              <p className="docs-page-header__signal" aria-hidden="true">
                Planner / Task Brief / Implementer
              </p>
              <h1>{title}</h1>
              {description ? <p className="docs-page-header__description">{description}</p> : null}
            </header>

            <MobileToc items={toc} />
            <article className="docs-content">{children}</article>
            <DocsPrevNext next={next} previous={previous} />
            <DesktopToc items={toc} />
          </TocScope>
        </main>
      </div>
    </div>
  );
}
