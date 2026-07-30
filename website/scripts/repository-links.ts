import { statSync } from 'node:fs';
import {
  createLinkFailure,
  headingAnchors,
  type IndexedDocument,
  type LinkFailure,
} from './link-check-model.js';
import { readMarkdownTree } from './mdx-document.js';
import { resolveRepositoryTarget } from './repository-target.js';

function lineFragmentViolation(options: {
  readonly document: IndexedDocument;
  readonly fragment: string;
  readonly href: string;
  readonly line: number;
  readonly path: string;
  readonly target: string;
}): LinkFailure[] | undefined {
  const match = /^L(\d+)(?:-L(\d+))?$/.exec(options.fragment);
  if (!match) {
    return undefined;
  }

  const source = readMarkdownTree({ file: options.target });
  if ('message' in source) {
    return [
      createLinkFailure({
        ...options,
        message: source.message,
        resolvedPath: options.path,
      }),
    ];
  }
  const lineCount = source.source.split('\n').length;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return start >= 1 && end >= start && end <= lineCount
    ? []
    : [
        createLinkFailure({
          ...options,
          message: 'GitHub line fragment is outside the target file',
          resolvedPath: `${options.path}#${options.fragment}`,
        }),
      ];
}

export function validateRepositoryLink(options: {
  readonly document: IndexedDocument;
  readonly href: string;
  readonly line: number;
  readonly repositoryRoot: string;
}): LinkFailure[] | undefined {
  const repository = resolveRepositoryTarget(options);
  if (repository.kind === 'external') {
    return undefined;
  }
  if (repository.kind === 'invalid') {
    return [
      createLinkFailure({
        ...options,
        message: repository.message,
        resolvedPath: repository.resolvedPath,
      }),
    ];
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(repository.target);
  } catch {
    return [
      createLinkFailure({
        ...options,
        message: 'in-repository GitHub target does not exist',
        resolvedPath: repository.path,
      }),
    ];
  }

  const correctKind = repository.targetKind === 'blob' ? stats.isFile() : stats.isDirectory();
  if (!correctKind) {
    return [
      createLinkFailure({
        ...options,
        message: `GitHub ${repository.targetKind} URL points to the wrong target kind`,
        resolvedPath: repository.path,
      }),
    ];
  }
  if (!repository.fragment || repository.targetKind === 'tree') {
    return [];
  }

  const lineViolations = lineFragmentViolation({ ...options, ...repository });
  if (lineViolations) {
    return lineViolations;
  }
  if (!/\.mdx?$/i.test(repository.path)) {
    return [
      createLinkFailure({
        ...options,
        message: 'GitHub fragment on a source file must be a valid line anchor',
        resolvedPath: `${repository.path}#${repository.fragment}`,
      }),
    ];
  }

  const markdown = readMarkdownTree({ file: repository.target });
  if ('message' in markdown) {
    return [
      createLinkFailure({
        ...options,
        message: markdown.message,
        resolvedPath: repository.path,
      }),
    ];
  }
  return headingAnchors(markdown.tree).has(repository.fragment)
    ? []
    : [
        createLinkFailure({
          ...options,
          message: 'GitHub Markdown fragment does not exist',
          resolvedPath: `${repository.path}#${repository.fragment}`,
        }),
      ];
}
