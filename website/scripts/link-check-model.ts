import GithubSlugger from 'github-slugger';
import type { Root } from 'mdast';
import { documentHeadings } from './mdx-ast.js';

export type LinkFailure = {
  readonly file: string;
  readonly href: string;
  readonly kind: 'link';
  readonly line: number;
  readonly message: string;
  readonly resolvedPath: string;
};

export type IndexedDocument = {
  readonly bodyStartLine: number;
  readonly file: string;
  readonly route: string;
  readonly tree: Root;
};

export function createLinkFailure(options: {
  readonly document: IndexedDocument;
  readonly href: string;
  readonly line: number;
  readonly message: string;
  readonly resolvedPath: string;
}): LinkFailure {
  return {
    file: options.document.file,
    href: options.href,
    kind: 'link',
    line: options.line + options.document.bodyStartLine - 1,
    message: options.message,
    resolvedPath: options.resolvedPath,
  };
}

export function headingAnchors(tree: Root): ReadonlySet<string> {
  const slugger = new GithubSlugger();
  return new Set(documentHeadings(tree).map((heading) => slugger.slug(heading.text)));
}
