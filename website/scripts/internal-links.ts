import { posix } from 'node:path';
import {
  createLinkFailure,
  headingAnchors,
  type IndexedDocument,
  type LinkFailure,
} from './link-check-model.js';

const INTERNAL_MARKDOWN = /\.mdx?$/i;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function validateInternalLink(options: {
  readonly document: IndexedDocument;
  readonly documentByRoute: ReadonlyMap<string, IndexedDocument>;
  readonly href: string;
  readonly knownPaths: ReadonlySet<string>;
  readonly line: number;
}): LinkFailure[] {
  let url: URL;
  try {
    url = new URL(options.href, `https://splitbrief.invalid${options.document.route}`);
  } catch {
    return [
      createLinkFailure({
        ...options,
        message: 'link target is not a valid URL',
        resolvedPath: options.href,
      }),
    ];
  }

  const resolvedPath = posix.normalize(decoded(url.pathname));
  const fragment = decoded(url.hash.slice(1));
  if (INTERNAL_MARKDOWN.test(resolvedPath)) {
    return [
      createLinkFailure({
        ...options,
        message: 'public documentation links must use the canonical route, not a raw Markdown file',
        resolvedPath,
      }),
    ];
  }
  if (!options.knownPaths.has(resolvedPath)) {
    return [
      createLinkFailure({
        ...options,
        message: 'internal route does not exist',
        resolvedPath,
      }),
    ];
  }
  if (!fragment) {
    return [];
  }

  const target = options.documentByRoute.get(resolvedPath);
  if (!target) {
    return [
      createLinkFailure({
        ...options,
        message: 'fragment target is not a documentation page',
        resolvedPath: `${resolvedPath}#${fragment}`,
      }),
    ];
  }
  return headingAnchors(target.tree).has(fragment)
    ? []
    : [
        createLinkFailure({
          ...options,
          message: 'documentation fragment does not exist',
          resolvedPath: `${resolvedPath}#${fragment}`,
        }),
      ];
}
