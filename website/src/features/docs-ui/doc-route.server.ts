import '@tanstack/react-start/server-only';
import { notFound } from '@tanstack/react-router';
import { source } from '../../lib/source.js';
import {
  createDocsNavigation,
  findDocsNeighbours,
  type DocsNavGroup,
  type DocsNeighbour,
} from './navigation.js';

export interface DocRouteData {
  readonly currentPath: string;
  readonly description?: string;
  readonly groups: readonly DocsNavGroup[];
  readonly next?: DocsNeighbour;
  readonly path: string;
  readonly previous?: DocsNeighbour;
  readonly title: string;
}

export interface DocPath {
  readonly slugs: readonly string[];
}

export function resolveDocRoute(data: DocPath): DocRouteData {
  const page = source.getPage([...data.slugs]);
  if (!page) {
    throw notFound();
  }

  const groups = createDocsNavigation(source.getPageTree());
  const neighbours = findDocsNeighbours(groups, page.url);

  return {
    currentPath: page.url,
    groups,
    path: page.path,
    title: page.data.title,
    ...(page.data.description === undefined ? {} : { description: page.data.description }),
    ...neighbours,
  };
}
