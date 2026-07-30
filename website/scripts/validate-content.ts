import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { findCopyPolicyViolations } from '../src/copy-policy.js';
import { DOCS_PAGE_COUNT } from '../src/docs-page-count.js';
import { discoverFiles, DOCS_CONTENT_DIRECTORY, relativeFileStem } from './content-files.js';
import { CONTENT_PAGE_CONTRACTS, CONTENT_PAGES, type ContentMode } from './content-manifest.js';
import { validateContentMetadata } from './content-metadata.js';
import { validateDocumentSecurity } from './content-security.js';
import { documentHeadings } from './mdx-ast.js';
import { readMdxDocument } from './mdx-document.js';
import type { SourceDiagnostic } from './source-diagnostic.js';

type ContentViolation = SourceDiagnostic;

const MANIFEST_FILE = fileURLToPath(new URL('./content-manifest.ts', import.meta.url));
const REWRITE_COPY_EXCEPTION = 'guides/cost-management-and-budgets';
const NON_EMPTY_TEXT = z.string().refine((value) => value.trim().length > 0);
const FRONTMATTER_SCHEMA = z
  .object({
    description: NON_EMPTY_TEXT,
    title: NON_EMPTY_TEXT,
  })
  .strict();

function copyViolations(options: {
  readonly allowCostClaims?: boolean;
  readonly file: string;
  readonly scope: string;
  readonly value: string;
}): ContentViolation[] {
  return findCopyPolicyViolations(
    options.value,
    options.allowCostClaims ? { allowCostVocabulary: true, allowSavingsClaims: true } : undefined,
  ).map((violation) => ({
    file: options.file,
    message: `${options.scope} contains ${violation.kind} "${violation.match}"`,
  }));
}

function validatePage(options: {
  readonly contentDirectory: string;
  readonly mode: ContentMode;
  readonly path: string;
  readonly title: string;
}): ContentViolation[] {
  const file = join(options.contentDirectory, `${options.path}.mdx`);
  const result = readMdxDocument({ file });
  if (result.kind === 'invalid') {
    return [...result.issues];
  }

  const { document } = result;
  const frontmatter = FRONTMATTER_SCHEMA.safeParse(document.frontmatter);
  const violations: ContentViolation[] = [];
  if (!frontmatter.success) {
    violations.push({
      file,
      message: `frontmatter must contain exactly non-empty title and description fields: ${z.prettifyError(frontmatter.error)}`,
    });
  } else {
    if (frontmatter.data.title !== options.title) {
      violations.push({
        file,
        message: `frontmatter title must be "${options.title}"`,
      });
    }
    violations.push(
      ...copyViolations({
        file,
        scope: 'frontmatter',
        value: `${frontmatter.data.title}\n${frontmatter.data.description}`,
      }),
    );
  }

  for (const heading of documentHeadings(document.tree)) {
    if (heading.depth === 1) {
      violations.push({
        file,
        line: heading.line + document.bodyStartLine - 1,
        message: 'body contains an H1; the docs shell owns the page H1',
      });
    }
  }

  if (options.mode !== 'as-is') {
    violations.push(
      ...copyViolations({
        allowCostClaims: options.path === REWRITE_COPY_EXCEPTION,
        file,
        scope: 'body',
        value: document.body,
      }),
    );
  }

  violations.push(
    ...validateDocumentSecurity(document).map((issue) => ({
      ...issue,
      file,
    })),
  );
  return violations;
}

export function validateContent(directory = DOCS_CONTENT_DIRECTORY): ContentViolation[] {
  const expectedPaths = CONTENT_PAGES.map((page) => page.path);
  const discovery = discoverFiles({ directory, extension: '.mdx' });
  const actualPaths = discovery.files.map((file) => relativeFileStem({ directory, file }));
  const expected = new Set(expectedPaths);
  const actual = new Set(actualPaths);
  const violations: ContentViolation[] = [...discovery.issues];

  if (CONTENT_PAGES.length !== DOCS_PAGE_COUNT) {
    violations.push({
      file: MANIFEST_FILE,
      message: `manifest contains ${CONTENT_PAGES.length} pages; the client contract requires ${DOCS_PAGE_COUNT}`,
    });
  }

  for (const path of expectedPaths) {
    if (!actual.has(path)) {
      violations.push({
        file: join(directory, `${path}.mdx`),
        message: 'manifest page is missing',
      });
    }
  }
  for (const path of actualPaths) {
    if (!expected.has(path)) {
      violations.push({
        file: join(directory, `${path}.mdx`),
        message: 'page is not in the manifest',
      });
    }
  }

  for (const page of CONTENT_PAGE_CONTRACTS) {
    if (actual.has(page.path)) {
      violations.push(
        ...validatePage({
          contentDirectory: directory,
          mode: page.mode,
          path: page.path,
          title: page.title,
        }),
      );
    }
  }

  return [...violations, ...validateContentMetadata({ directory })];
}

function main(): void {
  const violations = validateContent();
  if (violations.length > 0) {
    for (const violation of violations) {
      const line = violation.line ? `:${violation.line}` : '';
      console.error(`${relative(process.cwd(), violation.file)}${line}: ${violation.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const asIsCount = CONTENT_PAGES.filter((page) => page.mode === 'as-is').length;
  const rewriteCount = CONTENT_PAGES.filter((page) => page.mode === 'rewrite').length;
  const newCount = CONTENT_PAGES.filter((page) => page.mode === 'new').length;
  console.log(
    `Validated ${CONTENT_PAGES.length} documentation pages (${asIsCount} as-is, ${rewriteCount} rewrite, ${newCount} new).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
