import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverFiles,
  DOCS_CONTENT_DIRECTORY,
  findFiles,
  relativeFileStem,
} from './content-files.js';
import { validateInternalLink } from './internal-links.js';
import type { IndexedDocument, LinkFailure } from './link-check-model.js';
import { documentLinks } from './mdx-ast.js';
import { readMdxDocument } from './mdx-document.js';
import { sitePages } from './pages.js';
import { validateRepositoryLink } from './repository-links.js';
import type { SourceDiagnostic } from './source-diagnostic.js';

type DocumentFailure = SourceDiagnostic & {
  readonly kind: 'document';
};

type LinkViolation = DocumentFailure | LinkFailure;

type CheckLinksOptions = {
  readonly contentDirectory?: string;
  readonly knownPaths?: ReadonlySet<string>;
  readonly repositoryRoot?: string;
};

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXTERNAL_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;

function routeForFile(options: {
  readonly contentDirectory: string;
  readonly file: string;
}): string {
  const sourcePath = relativeFileStem({
    directory: options.contentDirectory,
    file: options.file,
  });
  return `/docs/${sourcePath}`;
}

function indexDocuments(contentDirectory: string): {
  readonly documents: readonly IndexedDocument[];
  readonly violations: readonly DocumentFailure[];
} {
  const documents: IndexedDocument[] = [];
  const violations: DocumentFailure[] = [];
  const discovery = discoverFiles({ directory: contentDirectory, extension: '.mdx' });

  violations.push(
    ...discovery.issues.map((issue) => ({
      ...issue,
      kind: 'document' as const,
    })),
  );
  if (discovery.files.length === 0 && discovery.issues.length === 0) {
    violations.push({
      file: contentDirectory,
      kind: 'document',
      message: 'no documentation MDX files found',
    });
  }

  for (const file of discovery.files) {
    const result = readMdxDocument({ file });
    if (result.kind === 'invalid') {
      violations.push(
        ...result.issues.map((issue) => ({
          ...issue,
          kind: 'document' as const,
        })),
      );
      continue;
    }

    documents.push({
      bodyStartLine: result.document.bodyStartLine,
      file,
      route: routeForFile({ contentDirectory, file }),
      tree: result.document.tree,
    });
  }

  return { documents, violations };
}

function knownSitePaths(options: {
  readonly contentDirectory: string;
  readonly knownPaths?: ReadonlySet<string>;
}): ReadonlySet<string> | DocumentFailure {
  if (options.knownPaths) {
    return options.knownPaths;
  }

  try {
    return new Set(sitePages(options.contentDirectory).map((page) => page.path));
  } catch (error) {
    return {
      file: options.contentDirectory,
      kind: 'document',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function checkLinks(options: CheckLinksOptions = {}): LinkViolation[] {
  const contentDirectory = options.contentDirectory ?? DOCS_CONTENT_DIRECTORY;
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const { documents, violations } = indexDocuments(contentDirectory);
  const documentByRoute = new Map(documents.map((document) => [document.route, document]));
  const knownPaths = options.knownPaths
    ? knownSitePaths({ contentDirectory, knownPaths: options.knownPaths })
    : knownSitePaths({ contentDirectory });
  if ('kind' in knownPaths) {
    return [...violations, knownPaths];
  }

  return [
    ...violations,
    ...documents.flatMap((document) =>
      documentLinks(document.tree).flatMap((link) => {
        const repositoryViolations = validateRepositoryLink({
          document,
          href: link.href,
          line: link.line,
          repositoryRoot,
        });
        if (repositoryViolations) {
          return repositoryViolations;
        }

        const href = link.href.trim();
        if (href.startsWith('//') || EXTERNAL_PROTOCOL.test(href)) {
          return [];
        }

        return validateInternalLink({
          document,
          documentByRoute,
          href,
          knownPaths,
          line: link.line,
        });
      }),
    ),
  ];
}

export function formatBrokenLink(link: LinkViolation, workingDirectory = process.cwd()): string {
  const location = `${relative(workingDirectory, link.file)}${link.line ? `:${link.line}` : ''}`;
  return link.kind === 'link'
    ? `${location} ${link.href} -> ${link.resolvedPath}: ${link.message}`
    : `${location}: ${link.message}`;
}

function main(): void {
  const violations = checkLinks();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(formatBrokenLink(violation));
    }
    process.exitCode = 1;
    return;
  }

  const pageCount = findFiles({ directory: DOCS_CONTENT_DIRECTORY, extension: '.mdx' }).length;
  console.log(`Checked ${pageCount} documentation pages: no broken links.`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
