type DocsTreeError<Kind extends string, Data> = Error & {
  readonly data: Data;
  readonly kind: Kind;
};

function docsTreeFailure<Kind extends string, Data>({
  data,
  kind,
  message,
}: {
  readonly data: Data;
  readonly kind: Kind;
  readonly message: string;
}): DocsTreeError<Kind, Data> {
  return Object.assign(new Error(message), { data, kind });
}

export const docsTreeError = {
  duplicateUrl(href: string) {
    return docsTreeFailure({
      data: { href },
      kind: 'docs-tree-duplicate-url',
      message: `Duplicate documentation URL: ${href}`,
    });
  },
  invalidText(location: string) {
    return docsTreeFailure({
      data: { location },
      kind: 'docs-tree-invalid-text',
      message: `${location} must be a non-empty string`,
    });
  },
  missingPage(path: string) {
    return docsTreeFailure({
      data: { path },
      kind: 'docs-tree-missing-page',
      message: `Documentation page is missing from navigation: ${path}`,
    });
  },
  nonTextContent(location: string) {
    return docsTreeFailure({
      data: { location },
      kind: 'docs-tree-non-text-content',
      message: `${location} contains non-text content`,
    });
  },
  ungroupedPage() {
    return docsTreeFailure({
      data: {},
      kind: 'docs-tree-ungrouped-page',
      message: 'Documentation pages must belong to a named group',
    });
  },
} as const;
