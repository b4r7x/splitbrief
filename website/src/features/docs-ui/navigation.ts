import type { Node, Root } from 'fumadocs-core/page-tree';
import { IMPLEMENTER_DOC_PATHS, PLANNER_DOC_PATHS } from '../../docs-roles.js';
import { docsTreeError } from './docs-tree-error.js';

export type DocsNavRole = 'planner' | 'implementer' | 'neutral';

export type DocsNavPage = {
  readonly href: string;
  readonly role: DocsNavRole;
  readonly title: string;
};

export type DocsNavGroup = {
  readonly label: string;
  readonly pages: readonly DocsNavPage[];
};

export type DocsNeighbour = {
  readonly href: string;
  readonly title: string;
};

export type DocsNeighbours = {
  readonly next?: DocsNeighbour;
  readonly previous?: DocsNeighbour;
};

type MutableGroup = {
  label: string;
  pages: DocsNavPage[];
};

const PLANNER_PAGES = new Set<string>(PLANNER_DOC_PATHS);
const IMPLEMENTER_PAGES = new Set<string>(IMPLEMENTER_DOC_PATHS);

function requireText(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw docsTreeError.invalidText(location);
  }

  return value;
}

function roleForPage(url: string): DocsNavRole {
  if (PLANNER_PAGES.has(url)) {
    return 'planner';
  }

  if (IMPLEMENTER_PAGES.has(url)) {
    return 'implementer';
  }

  return 'neutral';
}

function collectPages(node: Node, seenUrls: Set<string>): DocsNavPage[] {
  if (node.type === 'separator') {
    return [];
  }

  if (node.type === 'page') {
    const href = requireText(node.url, 'Page URL');
    if (seenUrls.has(href)) {
      throw docsTreeError.duplicateUrl(href);
    }
    seenUrls.add(href);

    return [
      {
        href,
        role: roleForPage(href),
        title: requireText(node.name, `Page title for ${href}`),
      },
    ];
  }

  return [
    ...(node.index ? collectPages(node.index, seenUrls) : []),
    ...node.children.flatMap((child) => collectPages(child, seenUrls)),
  ];
}

export function createDocsNavigation(tree: Root): readonly DocsNavGroup[] {
  const groups: MutableGroup[] = [];
  const seenUrls = new Set<string>();
  let currentGroup: MutableGroup | undefined;

  for (const node of tree.children) {
    if (node.type === 'separator') {
      if (currentGroup && currentGroup.pages.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = {
        label: requireText(node.name, 'Documentation group label'),
        pages: [],
      };
      continue;
    }

    if (!currentGroup) {
      if (node.type !== 'folder') {
        throw docsTreeError.ungroupedPage();
      }

      const pages = collectPages(node, seenUrls);
      if (pages.length > 0) {
        groups.push({
          label: requireText(node.name, 'Documentation group label'),
          pages,
        });
      }
      continue;
    }

    currentGroup.pages.push(...collectPages(node, seenUrls));
  }

  if (currentGroup && currentGroup.pages.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

export function findDocsNeighbours(
  groups: readonly DocsNavGroup[],
  currentPath: string,
): DocsNeighbours {
  const pages = groups.flatMap((group) => group.pages);
  const currentIndex = pages.findIndex((page) => page.href === currentPath);
  if (currentIndex === -1) {
    throw docsTreeError.missingPage(currentPath);
  }

  const previousPage = pages[currentIndex - 1];
  const nextPage = pages[currentIndex + 1];

  return {
    ...(previousPage ? { previous: { href: previousPage.href, title: previousPage.title } } : {}),
    ...(nextPage ? { next: { href: nextPage.href, title: nextPage.title } } : {}),
  };
}
