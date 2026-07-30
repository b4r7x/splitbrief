import { useHydrated } from '@tanstack/react-router';
import { AnchorProvider, TOCItem } from 'fumadocs-core/toc';
import type { TableOfContents } from 'fumadocs-core/toc';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { docsTreeError } from './docs-tree-error.js';
import './toc.css';

const TOC_TEXT_ELEMENTS = new Set(['a', 'code', 'del', 'em', 'span', 'strong', 'sub', 'sup']);

export interface DocsTocItem {
  readonly depth: 2 | 3;
  readonly title: string;
  readonly url: string;
}

export interface TocProps {
  readonly items: readonly DocsTocItem[];
}

export interface TocScopeProps extends TocProps {
  readonly children: ReactNode;
}

function requireText(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw docsTreeError.invalidText(location);
  }

  return value;
}

function textFromTocTitle(value: ReactNode, location: string): string {
  return Children.toArray(value)
    .map((child) => {
      if (typeof child === 'string') {
        return child;
      }

      if (typeof child === 'number') {
        return child.toString();
      }

      if (
        !isValidElement<{ children?: ReactNode }>(child) ||
        (child.type !== Fragment &&
          (typeof child.type !== 'string' || !TOC_TEXT_ELEMENTS.has(child.type)))
      ) {
        throw docsTreeError.nonTextContent(location);
      }

      return textFromTocTitle(child.props.children, location);
    })
    .join('');
}

export function createDocsToc(toc: TableOfContents): readonly DocsTocItem[] {
  return toc.flatMap((item) => {
    if (item.depth !== 2 && item.depth !== 3) {
      return [];
    }

    const location = `Table of contents title for ${item.url}`;
    return [
      {
        depth: item.depth,
        title: requireText(textFromTocTitle(item.title, location), location),
        url: requireText(item.url, 'Table of contents URL'),
      },
    ];
  });
}

export function TocScope({ children, items }: TocScopeProps) {
  return <AnchorProvider toc={[...items]}>{children}</AnchorProvider>;
}

export function DesktopToc({ items }: TocProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="On this page" className="docs-toc docs-toc--desktop">
      <p className="docs-toc__legend">On this page</p>
      <ol className="docs-toc__list">
        {items.map((item) => (
          <li className="docs-toc__entry" data-depth={item.depth} key={item.url}>
            <TOCItem className="docs-toc__link" href={item.url}>
              {item.title}
            </TOCItem>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function MobileToc({ items }: TocProps) {
  const hydrated = useHydrated();
  if (items.length === 0) return null;

  return (
    <details className="docs-toc docs-toc--mobile" inert={!hydrated}>
      <summary className="docs-toc__summary">On this page</summary>
      <nav aria-label="On this page menu">
        <ol className="docs-toc__list">
          {items.map((item) => (
            <li className="docs-toc__entry" data-depth={item.depth} key={item.url}>
              <TOCItem autoScroll={false} className="docs-toc__link" href={item.url}>
                {item.title}
              </TOCItem>
            </li>
          ))}
        </ol>
      </nav>
    </details>
  );
}
